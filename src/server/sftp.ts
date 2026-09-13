/**
 * SFTP。接続中の SSH セッションに**相乗り**する(要件定義 2 章)。
 *
 * 判断のある部分(権限の表し方・種類の見分け・パスの組み立て・上限)をここに置き、
 * API からは呼ぶだけにする。
 */
import { posix } from 'node:path';

import type { FileEntry, SFTPWrapper } from 'ssh2';

import { TREE_MAX_ENTRIES } from '../shared/defaults.js';
import type { SftpEntry, SftpListResponse } from '../shared/types.js';
import { AppError } from './errors.js';
import type { Session } from './ssh.js';

/** `rw-r--r--` の形に直す。画面とダイアログに出す。 */
export function modeText(mode: number): string {
  const bits = ['r', 'w', 'x'];
  let text = '';
  for (let group = 2; group >= 0; group -= 1) {
    for (let bit = 2; bit >= 0; bit -= 1) {
      text += (mode >> (group * 3 + bit)) & 1 ? bits[2 - bit] : '-';
    }
  }
  return text;
}

/**
 * 種類は**権限の上位ビット**から見分ける。
 * `attrs` に判定用の関数が付いてくるとは限らないため(型にも無い)。
 */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

export function kindOf(mode: number): SftpEntry['kind'] {
  const type = mode & S_IFMT;
  if (type === S_IFDIR) {
    return 'directory';
  }
  if (type === S_IFLNK) {
    return 'symlink';
  }
  return type === S_IFREG ? 'file' : 'other';
}

/**
 * パスを組み立てる。
 * 画面から来た値をそのまま繋がない: `..` を潰し、区切りを揃える。
 */
export function joinPath(base: string, name: string): string {
  return posix.normalize(posix.join(base, name));
}

/** 親フォルダ。ルートの親はルート。 */
export function parentPath(path: string): string {
  const parent = posix.dirname(posix.normalize(path));
  return parent === '.' ? '/' : parent;
}

/**
 * UTF-8 として読めない名前かどうか。
 *
 * ssh2 は SFTP の名前を UTF-8 として読むため、Shift_JIS などの名前は
 * 置換文字になって**元に戻せない**。そのまま操作させると別のものを消しかねないので、
 * 印を付けて画面で止める。
 */
export function isUndecodable(name: string): boolean {
  return name.includes('�');
}

function toEntry(directory: string, item: FileEntry): SftpEntry {
  const stats = item.attrs;
  const name = item.filename;
  const entry: SftpEntry = {
    name,
    path: joinPath(directory, name),
    kind: kindOf(stats.mode),
    size: stats.size,
    mode: stats.mode & 0o7777,
    modeText: modeText(stats.mode),
    mtime: new Date(stats.mtime * 1000).toISOString(),
  };
  if (isUndecodable(name)) {
    entry.undecodable = true;
  }
  return entry;
}

/** 並び順: フォルダが先、その中で名前順(要件定義 4.2)。 */
export function sortEntries(entries: SftpEntry[]): SftpEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'directory' ? 0 : 1;
    const bDir = b.kind === 'directory' ? 0 : 1;
    return aDir !== bDir ? aDir - bDir : a.name.localeCompare(b.name, 'ja');
  });
}

export function filterHidden(entries: SftpEntry[], showHidden: boolean): SftpEntry[] {
  return showHidden ? entries : entries.filter((entry) => !entry.name.startsWith('.'));
}

function sftpError(action: string, path: string, cause: Error & { code?: number }): AppError {
  // ssh2 の SFTP の番号: 2 = そんなファイルは無い, 3 = 権限がない
  if (cause.code === 3) {
    return new AppError('store_broken', `${path} を${action}する権限がありません。`);
  }
  if (cause.code === 2) {
    return new AppError('store_broken', `${path} が見つかりません。`);
  }
  return new AppError('store_broken', `${path} を${action}できませんでした。`, cause.message);
}

export async function listDirectory(
  sftp: SFTPWrapper,
  path: string,
  options: { showHidden?: boolean; limit?: number } = {},
): Promise<SftpListResponse> {
  const limit = options.limit ?? TREE_MAX_ENTRIES;
  const items = await new Promise<FileEntry[]>((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error) {
        reject(sftpError('一覧', path, error));
        return;
      }
      resolve(list);
    });
  });

  const all = sortEntries(
    filterHidden(
      items.map((item) => toEntry(path, item)),
      options.showHidden ?? false,
    ),
  );
  // 上限を超えたら切り詰める。**黙って捨てない**で件数を返す(要件定義 4.2)。
  return {
    path,
    entries: all.slice(0, limit),
    truncated: all.length > limit,
    total: all.length,
  };
}

export function statPath(sftp: SFTPWrapper, path: string): Promise<SftpEntry> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (error, stats) => {
      if (error) {
        reject(sftpError('確認', path, error));
        return;
      }
      resolve({
        name: posix.basename(path),
        path,
        kind: kindOf(stats.mode),
        size: stats.size,
        mode: stats.mode & 0o7777,
        modeText: modeText(stats.mode),
        mtime: new Date(stats.mtime * 1000).toISOString(),
      });
    });
  });
}

export function makeDirectory(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (error) => (error ? reject(sftpError('作成', path, error)) : resolve()));
  });
}

export function createFile(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 既にあるものを潰さない(`wx` = 無いときだけ作る)
    sftp.open(path, 'wx', (error, handle) => {
      if (error) {
        reject(sftpError('作成', path, error));
        return;
      }
      sftp.close(handle, (closeError) =>
        closeError ? reject(sftpError('作成', path, closeError)) : resolve(),
      );
    });
  });
}

export function renamePath(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => (error ? reject(sftpError('改名', from, error)) : resolve()));
  });
}

/** フォルダを中身ごと消す。**呼ぶ前に確認を取ること**(要件定義 4.3)。 */
export async function removePath(
  sftp: SFTPWrapper,
  path: string,
  recursive: boolean,
): Promise<void> {
  const entry = await statPath(sftp, path);
  if (entry.kind !== 'directory') {
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (error) => (error ? reject(sftpError('削除', path, error)) : resolve()));
    });
    return;
  }

  if (recursive) {
    const listed = await listDirectory(sftp, path, {
      showHidden: true,
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const child of listed.entries) {
      await removePath(sftp, child.path, true);
    }
  }
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(path, (error) => (error ? reject(sftpError('削除', path, error)) : resolve()));
  });
}

export function readFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (error: Error & { code?: number }) =>
      reject(sftpError('取得', path, error)),
    );
    stream.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

export function writeFile(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.on('error', (error: Error & { code?: number }) =>
      reject(sftpError('書き込み', path, error)),
    );
    stream.on('close', () => resolve());
    stream.end(data);
  });
}

/**
 * 接続中のセッションから SFTP を開く。
 * **繋がっていなければ勝手に接続しない**(鍵の確認を飛ばさないため)。
 */
export async function sftpFor(session: Session | undefined): Promise<SFTPWrapper> {
  if (!session || session.isClosed) {
    throw new AppError(
      'ssh_no_session',
      'この接続先に繋がっていません。先に端末を開いて接続してください。',
    );
  }
  return session.openSftp();
}
