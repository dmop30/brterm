/**
 * SSH 鍵の生成・配置と `~/.ssh/config` の扱い。
 *
 * 方針:
 * 1. **ネイティブ依存を増やさない。** 生成は ssh2 の `utils`(純 JS)で行う
 * 2. **上書きしない。** 同じ名前の鍵があれば止める。秘密鍵は消えたら戻せない
 * 3. **`~/.ssh/config` を書き潰さない。** 既存の記述・コメント・並びはそのまま残し、
 *    指定された Host の項目だけを差し替える
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import ssh2 from 'ssh2';

import { AppError } from './errors.js';
import { fingerprintOf } from './hostkey.js';

const { utils } = ssh2;

export type KeyType = 'ed25519' | 'rsa';

export interface GenerateOptions {
  type: KeyType;
  /** rsa のときの鍵長。既定 3072。ed25519 では見ない */
  bits?: number;
  /** 公開鍵の末尾に付ける覚え書き */
  comment?: string;
  /** 秘密鍵のパスフレーズ。空なら掛けない */
  passphrase?: string;
}

export interface GeneratedKey {
  type: KeyType;
  privateKey: string;
  publicKey: string;
  /** OpenSSH と同じ `SHA256:...` */
  fingerprint: string;
}

/** 覚え書きに使えない文字。改行が入ると `authorized_keys` の行が壊れる。 */
const COMMENT_NG = /[\r\n'"\\]/;

export function generateKey(options: GenerateOptions): GeneratedKey {
  const comment = options.comment?.trim() ?? '';
  if (COMMENT_NG.test(comment)) {
    throw new AppError('key_invalid_comment', '覚え書きに改行や引用符は使えません。');
  }
  if (options.type === 'rsa') {
    const bits = options.bits ?? 3072;
    // 2048 未満は今どき短すぎる。上限は生成に時間が掛かりすぎないところで切る
    if (!Number.isInteger(bits) || bits < 2048 || bits > 8192) {
      throw new AppError('key_invalid_bits', '鍵長は 2048〜8192 の整数で指定してください。');
    }
  }

  const passphrase = options.passphrase ?? '';
  const pair = utils.generateKeyPairSync(options.type, {
    ...(options.type === 'rsa' ? { bits: options.bits ?? 3072 } : {}),
    ...(comment === '' ? {} : { comment }),
    // パスフレーズを掛けるときは暗号方式も要る
    ...(passphrase === '' ? {} : { passphrase, cipher: 'aes256-cbc' }),
  } as never);

  return {
    type: options.type,
    privateKey: pair.private,
    publicKey: pair.public,
    fingerprint: fingerprintOfPublicKey(pair.public),
  };
}

/** 公開鍵(`ssh-ed25519 AAAA... 覚え書き`)の指紋。 */
export function fingerprintOfPublicKey(publicKey: string): string {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) {
    throw new AppError('key_invalid', '公開鍵として読めません。', parsed.message);
  }
  return fingerprintOf(parsed.getPublicSSH());
}

export interface WrittenKey extends GeneratedKey {
  privateKeyPath: string;
  publicKeyPath: string;
}

/**
 * 鍵をファイルに書く。秘密鍵は 600、公開鍵は 644。
 * **既にあれば書かない。** 上書きすると、その鍵で入っているサーバに入れなくなる。
 */
export function writeKey(dir: string, name: string, key: GeneratedKey): WrittenKey {
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new AppError('key_invalid_name', '鍵の名前に / や先頭の . は使えません。');
  }
  const privateKeyPath = join(dir, name);
  const publicKeyPath = `${privateKeyPath}.pub`;
  if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
    throw new AppError('key_exists', `同じ名前の鍵があります: ${privateKeyPath}`);
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, key.privateKey, { mode: 0o600 });
  writeFileSync(
    publicKeyPath,
    key.publicKey.endsWith('\n') ? key.publicKey : `${key.publicKey}\n`,
    {
      mode: 0o644,
    },
  );
  // 既にあるディレクトリの権限は mkdir では直らないので、鍵側で確実にしておく
  chmodSync(privateKeyPath, 0o600);

  return { ...key, privateKeyPath, publicKeyPath };
}

/** 鍵置き場にある鍵の一覧(公開鍵があるものだけ)。 */
export interface KeyFile {
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
  publicKey: string;
  fingerprint: string;
}

export function readKeyFile(publicKeyPath: string): KeyFile {
  const publicKey = readFileSync(publicKeyPath, 'utf8').trim();
  return {
    name: basename(publicKeyPath).replace(/\.pub$/, ''),
    privateKeyPath: publicKeyPath.replace(/\.pub$/, ''),
    publicKeyPath,
    publicKey,
    fingerprint: fingerprintOfPublicKey(publicKey),
  };
}

/**
 * `authorized_keys` へ足すコマンドを組み立てる。
 *
 * **brterm が組み立てるコマンドなので、危険コマンド確認の対象外**(要件定義 4.6 と同じ扱い)。
 * 既に同じ鍵があれば足さない(`grep -qxF`)。権限も毎回揃える。
 */
export function installCommand(publicKey: string): string {
  const line = publicKey.trim();
  if (line === '' || COMMENT_NG.test(line.replace(/^[^']*/, '')) || line.includes("'")) {
    throw new AppError('key_invalid', '公開鍵に使えない文字が入っています。');
  }
  return [
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    `grep -qxF '${line}' ~/.ssh/authorized_keys || printf '%s\\n' '${line}' >> ~/.ssh/authorized_keys`,
  ].join(' && ');
}

// ---- ~/.ssh/config -------------------------------------------------------

export interface SshConfigHost {
  /** `Host` に並ぶ名前(複数書ける) */
  patterns: string[];
  /** `HostName` などの項目。キーは書かれたまま */
  options: Record<string, string>;
}

/** 行を `キー 値` に割る。`=` 区切りも許す(OpenSSH がどちらも受けるため)。 */
function splitOption(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) {
    return undefined;
  }
  const match = /^(\S+)\s*[=\s]\s*(.*)$/.exec(trimmed);
  if (!match?.[1]) {
    return undefined;
  }
  return [match[1], (match[2] ?? '').trim()];
}

/** `~/.ssh/config` を読む。**書き戻しには使わない**(元の文章をそのまま扱うため)。 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost | undefined;

  for (const line of text.split('\n')) {
    const option = splitOption(line);
    if (!option) {
      continue;
    }
    const [key, value] = option;
    if (key.toLowerCase() === 'host') {
      current = { patterns: value.split(/\s+/).filter((item) => item !== ''), options: {} };
      hosts.push(current);
      continue;
    }
    if (current) {
      current.options[key] = value;
    }
  }
  return hosts;
}

export interface SshConfigEntry {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

function entryLines(entry: SshConfigEntry, indent = '  '): string[] {
  const lines = [`Host ${entry.host}`];
  if (entry.hostName) {
    lines.push(`${indent}HostName ${entry.hostName}`);
  }
  if (entry.user) {
    lines.push(`${indent}User ${entry.user}`);
  }
  if (entry.port !== undefined) {
    lines.push(`${indent}Port ${entry.port}`);
  }
  if (entry.identityFile) {
    lines.push(`${indent}IdentityFile ${entry.identityFile}`);
    // brterm が入れた鍵だけを使わせる。別の鍵で弾かれるのを避ける
    lines.push(`${indent}IdentitiesOnly yes`);
  }
  return lines;
}

/** brterm が面倒を見る項目。これ以外は手で書かれたものとして残す。 */
const MANAGED_KEYS = ['hostname', 'user', 'port', 'identityfile', 'identitiesonly'];

/**
 * Host の記述を差し替える。無ければ末尾に足す。
 *
 * **他の Host の記述とコメントには触らない。** さらに、差し替える Host の中でも
 * brterm が知らない項目(`ProxyJump` など)と注釈はそのまま残す。
 * 手で書いた設定を消さないため。
 */
export function upsertSshConfigHost(text: string, entry: SshConfigEntry): string {
  const host = entry.host.trim();
  if (host === '' || /\s/.test(host)) {
    throw new AppError('ssh_config_invalid_host', 'Host の名前に空白は使えません。');
  }

  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const option = splitOption(lines[index] ?? '');
    if (!option || option[0].toLowerCase() !== 'host') {
      continue;
    }
    const patterns = option[1].split(/\s+/);
    if (start >= 0) {
      // 対象ブロックの次の Host が、置き換える範囲の終わり
      end = index;
      break;
    }
    // 名前が 1 つだけ書かれているブロックを対象にする。
    // 複数まとめて書いてあるブロックは、他の接続先にも影響するので触らない
    if (patterns.length === 1 && patterns[0] === host) {
      start = index;
    }
  }

  const block = entryLines(entry);
  if (start < 0) {
    const head = text.trimEnd();
    return head === '' ? `${block.join('\n')}\n` : `${head}\n\n${block.join('\n')}\n`;
  }

  // 知らない項目は残す。末尾の空行は付け直すので、ここでは落とす
  const kept = lines.slice(start + 1, end).filter((line) => {
    if (line.trim() === '') {
      return false;
    }
    const option = splitOption(line);
    return option === undefined || !MANAGED_KEYS.includes(option[0].toLowerCase());
  });

  const tail = lines.slice(end);
  const replaced = [
    ...lines.slice(0, start),
    ...block,
    ...kept,
    ...(tail.length > 0 ? [''] : []),
    ...tail,
  ];
  return replaced.join('\n');
}

/** `~/.ssh/config` を読む。無ければ空文字(これは異常ではない)。 */
export function readSshConfig(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** `~/.ssh/config` を書く。権限は 600。ディレクトリが無ければ 700 で作る。 */
export function writeSshConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
