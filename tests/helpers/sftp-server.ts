/**
 * 試験用の SFTP サーバ。
 *
 * ssh2 のサーバ実装に SFTP をぶら下げ、**実際のディレクトリ**を読み書きさせる。
 * 偽物を返すだけの作りにすると、権限や改名の挙動が確かめられないため。
 */
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { join, normalize, posix } from 'node:path';

import ssh2, { type SFTPWrapper } from 'ssh2';

const STATUS = ssh2.utils.sftp.STATUS_CODE;
const OPEN_MODE = ssh2.utils.sftp.OPEN_MODE;

interface DirHandle {
  kind: 'dir';
  path: string;
  sent: boolean;
}

interface FileHandle {
  kind: 'file';
  fd: number;
  path: string;
}

/** 受け付けたハンドル。番号で引けるようにしておく。 */
type Handle = DirHandle | FileHandle;

function attrsOf(stats: { mode: number; size: number; atimeMs: number; mtimeMs: number }) {
  return {
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

/**
 * 送られてきたパスを、試験用のディレクトリの下へ閉じ込める。
 * `..` で外へ出られると、試験が機械のファイルを壊しかねない。
 */
function resolveWithin(root: string, requested: string): string {
  const normalized = normalize(join(root, posix.normalize(requested)));
  if (!normalized.startsWith(root)) {
    return root;
  }
  return normalized;
}

/** ssh2 の SFTP セッションに、実ディレクトリを読み書きする応答を付ける。 */
export function serveSftp(sftp: SFTPWrapper, root: string): void {
  const handles = new Map<number, Handle>();
  let nextHandle = 0;

  const makeHandle = (handle: Handle): Buffer => {
    const id = nextHandle++;
    handles.set(id, handle);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id, 0);
    return buffer;
  };
  const readHandle = (buffer: Buffer): Handle | undefined => handles.get(buffer.readUInt32BE(0));

  const fail = (reqid: number, error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      sftp.status(reqid, STATUS.NO_SUCH_FILE);
      return;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      sftp.status(reqid, STATUS.PERMISSION_DENIED);
      return;
    }
    sftp.status(reqid, STATUS.FAILURE);
  };

  sftp.on('REALPATH', (reqid, path) => {
    const cleaned = posix.normalize(path === '.' ? '/' : path);
    sftp.name(reqid, [{ filename: cleaned, longname: cleaned, attrs: {} as never }]);
  });

  sftp.on('OPENDIR', (reqid, path) => {
    void stat(resolveWithin(root, path))
      .then((stats) => {
        if (!stats.isDirectory()) {
          sftp.status(reqid, STATUS.FAILURE);
          return;
        }
        sftp.handle(reqid, makeHandle({ kind: 'dir', path, sent: false }));
      })
      .catch((error: unknown) => fail(reqid, error));
  });

  sftp.on('READDIR', (reqid, handleBuffer) => {
    const handle = readHandle(handleBuffer);
    if (!handle || handle.kind !== 'dir') {
      sftp.status(reqid, STATUS.FAILURE);
      return;
    }
    if (handle.sent) {
      sftp.status(reqid, STATUS.EOF);
      return;
    }
    handle.sent = true;
    void readdir(resolveWithin(root, handle.path))
      .then(async (names) => {
        const entries = [];
        for (const name of names) {
          const stats = await stat(join(resolveWithin(root, handle.path), name));
          entries.push({ filename: name, longname: name, attrs: attrsOf(stats) as never });
        }
        sftp.name(reqid, entries);
      })
      .catch((error: unknown) => fail(reqid, error));
  });

  const sendStat = (reqid: number, path: string) => {
    void stat(resolveWithin(root, path))
      .then((stats) => sftp.attrs(reqid, attrsOf(stats) as never))
      .catch((error: unknown) => fail(reqid, error));
  };
  sftp.on('STAT', (reqid, path) => sendStat(reqid, path));
  sftp.on('LSTAT', (reqid, path) => sendStat(reqid, path));

  sftp.on('FSTAT', (reqid, handleBuffer) => {
    const handle = readHandle(handleBuffer);
    if (!handle) {
      sftp.status(reqid, STATUS.FAILURE);
      return;
    }
    sendStat(reqid, handle.path);
  });

  sftp.on('OPEN', (reqid, filename, flags) => {
    const path = resolveWithin(root, filename);
    try {
      let mode = 'r';
      if (flags & OPEN_MODE.WRITE) {
        mode = flags & OPEN_MODE.EXCL ? 'wx' : 'w';
      }
      const fd = openSync(path, mode);
      sftp.handle(reqid, makeHandle({ kind: 'file', fd, path: filename }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        sftp.status(reqid, STATUS.FAILURE);
        return;
      }
      fail(reqid, error);
    }
  });

  sftp.on('READ', (reqid, handleBuffer, offset, length) => {
    const handle = readHandle(handleBuffer);
    if (!handle || handle.kind !== 'file') {
      sftp.status(reqid, STATUS.FAILURE);
      return;
    }
    const buffer = Buffer.alloc(length);
    const read = readSync(handle.fd, buffer, 0, length, offset);
    if (read === 0) {
      sftp.status(reqid, STATUS.EOF);
      return;
    }
    sftp.data(reqid, buffer.subarray(0, read));
  });

  sftp.on('WRITE', (reqid, handleBuffer, offset, data) => {
    const handle = readHandle(handleBuffer);
    if (!handle || handle.kind !== 'file') {
      sftp.status(reqid, STATUS.FAILURE);
      return;
    }
    writeSync(handle.fd, data, 0, data.length, offset);
    sftp.status(reqid, STATUS.OK);
  });

  sftp.on('CLOSE', (reqid, handleBuffer) => {
    const handle = readHandle(handleBuffer);
    if (handle?.kind === 'file') {
      closeSync(handle.fd);
    }
    handles.delete(handleBuffer.readUInt32BE(0));
    sftp.status(reqid, STATUS.OK);
  });

  sftp.on('MKDIR', (reqid, path) => {
    void mkdir(resolveWithin(root, path))
      .then(() => sftp.status(reqid, STATUS.OK))
      .catch((error: unknown) => fail(reqid, error));
  });

  // fs.rm はフォルダに recursive を要求するので、フォルダは rmdir を使う
  sftp.on('RMDIR', (reqid, path) => {
    void rmdir(resolveWithin(root, path))
      .then(() => sftp.status(reqid, STATUS.OK))
      .catch((error: unknown) => fail(reqid, error));
  });

  sftp.on('REMOVE', (reqid, path) => {
    void unlink(resolveWithin(root, path))
      .then(() => sftp.status(reqid, STATUS.OK))
      .catch((error: unknown) => fail(reqid, error));
  });

  sftp.on('RENAME', (reqid, from, to) => {
    void rename(resolveWithin(root, from), resolveWithin(root, to))
      .then(() => sftp.status(reqid, STATUS.OK))
      .catch((error: unknown) => fail(reqid, error));
  });

  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS.OK));
}
