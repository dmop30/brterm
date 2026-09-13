/**
 * SSH の接続とシェル。
 *
 * セッションは**サーバ側で生きる**(要件定義 3 章)。ブラウザを閉じても切らない。
 * 鍵や金庫のことはここでは扱わない。復号済みの秘密を受け取るだけにして、
 * P2(マスターパスキー)で鍵の出どころが変わっても影響しないようにする。
 */
import { randomUUID } from 'node:crypto';

import iconv, { type DecoderStream } from 'iconv-lite';
import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type HostVerifier,
  type SFTPWrapper,
} from 'ssh2';

import type { Encoding, Host, KnownHostKey, Profile } from '../shared/types.js';
import { AppError } from './errors.js';
import { fingerprintOf, verifyHostKey, type HostKeyVerdict } from './hostkey.js';
import { Scrollback } from './scrollback.js';

/** 要件定義の文字コード名を iconv-lite の名前に直す。 */
export function iconvName(encoding: Encoding): string {
  if (encoding === 'shift_jis') {
    return 'Shift_JIS';
  }
  return encoding === 'euc-jp' ? 'EUC-JP' : 'utf8';
}

/** 未知のホスト鍵を見せて可否を尋ねるときの情報。 */
export interface HostKeyPrompt {
  hostname: string;
  port: number;
  fingerprint: string;
}

export interface ConnectOptions {
  host: Host;
  profile: Profile;
  /** 復号済みのパスワード。`authMethod` が `password` のときに使う。 */
  password?: string;
  /** 復号済みのパスフレーズ */
  passphrase?: string;
  /** 秘密鍵の中身。読み出しは呼び出し側で行う。 */
  privateKey?: string | Buffer;
  known: readonly KnownHostKey[];
  /**
   * 未知のホスト鍵をどうするか。
   * **既定は拒否**。利用者に尋ねるのは呼び出し側の仕事(要件定義 1 章「安全側に倒す」)。
   */
  onUnknownHostKey?: (prompt: HostKeyPrompt) => Promise<boolean> | boolean;
  /** 端末の大きさ */
  cols?: number;
  rows?: number;
  scrollbackLimit?: number;
  /** keepalive の間隔(ミリ秒)。無通信でも接続を保つ。 */
  keepaliveInterval?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

type DataListener = (text: string) => void;
type CloseListener = () => void;

export class Session {
  readonly id = randomUUID();
  readonly hostId: string;
  readonly hostname: string;
  private readonly client: Client;
  private readonly stream: ClientChannel;
  private readonly scrollback: Scrollback;
  /**
   * 文字コードの変換器。**塊ごとに decode しない**。
   * 多バイト文字が塊の境目で切れると化けるため、状態を持つ変換器を使う。
   */
  private readonly decoder: DecoderStream;
  private readonly encoding: Encoding;
  private readonly dataListeners = new Set<DataListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private closed = false;
  /** 受け入れたホスト鍵。呼び出し側が `db` に覚えさせる。 */
  readonly hostKey: { fingerprint: string; verdict: HostKeyVerdict };

  constructor(
    host: Host,
    client: Client,
    stream: ClientChannel,
    hostKey: { fingerprint: string; verdict: HostKeyVerdict },
    encoding: Encoding = 'utf-8',
    scrollbackLimit?: number,
  ) {
    this.hostId = host.id;
    this.hostname = host.hostname;
    this.client = client;
    this.stream = stream;
    this.hostKey = hostKey;
    this.encoding = encoding;
    this.decoder = iconv.getDecoder(iconvName(encoding));
    this.scrollback = new Scrollback(scrollbackLimit);

    stream.on('data', (chunk: Buffer) => {
      const text = this.decoder.write(chunk);
      this.scrollback.append(text);
      for (const listener of this.dataListeners) {
        listener(text);
      }
    });
    stream.stderr.on('data', (chunk: Buffer) => {
      const text = this.decoder.write(chunk);
      this.scrollback.append(text);
      for (const listener of this.dataListeners) {
        listener(text);
      }
    });
    stream.on('close', () => this.markClosed());
    client.on('close', () => this.markClosed());
  }

  private markClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** 画面から来た文字を、接続先の文字コードに直して送る。 */
  write(text: string): void {
    if (this.closed) {
      throw new AppError('ssh_no_session', 'セッションは既に切断されています。');
    }
    this.stream.write(iconv.encode(text, iconvName(this.encoding)));
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) {
      this.stream.setWindow(rows, cols, 0, 0);
    }
  }

  /** 再接続したときに戻す表示(要件定義 5 章の L1)。 */
  snapshot(): string {
    return this.scrollback.snapshot();
  }

  /**
   * この接続に**相乗り**して SFTP を開く(要件定義 2 章)。
   * 別に接続を張らないのは、認証をもう一度通さずに済ませるため。
   */
  openSftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new AppError('ssh_no_session', 'セッションは既に切断されています。'));
        return;
      }
      this.client.sftp((error, sftp) => {
        if (error) {
          reject(new AppError('ssh_no_session', 'SFTP を開けませんでした。', error.message));
          return;
        }
        resolve(sftp);
      });
    });
  }

  close(): void {
    this.markClosed();
    this.stream.end();
    this.client.end();
  }
}

/** ssh2 の誤りを、利用者に見せられる日本語へ分ける。 */
export function classifyConnectError(error: NodeJS.ErrnoException, host: Host): AppError {
  const level = (error as NodeJS.ErrnoException & { level?: string }).level;
  if (level === 'client-authentication') {
    return new AppError(
      'ssh_auth_failed',
      `${host.hostname} の認証に失敗しました。利用者名・パスワード・鍵を確認してください。`,
    );
  }
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
    return new AppError('ssh_unreachable', `${host.hostname} が見つかりません。`, error.code);
  }
  if (
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'EHOSTUNREACH'
  ) {
    return new AppError(
      'ssh_unreachable',
      `${host.hostname}:${host.port} に接続できません。`,
      error.code,
    );
  }
  return new AppError(
    'ssh_unreachable',
    `${host.hostname} への接続に失敗しました。`,
    error.message,
  );
}

function connectConfig(options: ConnectOptions, hostVerifier: HostVerifier): ConnectConfig {
  const { host, password, passphrase, privateKey, keepaliveInterval = 15000 } = options;
  const config: ConnectConfig = {
    host: host.hostname,
    port: host.port,
    username: host.username,
    // 無通信でも接続を保つ(要件定義 2 章の keepalive)
    keepaliveInterval,
    keepaliveCountMax: 3,
    readyTimeout: 20000,
    hostVerifier,
  };
  if (host.authMethod === 'password' && password !== undefined) {
    config.password = password;
  }
  if (privateKey !== undefined) {
    config.privateKey = privateKey;
    if (passphrase !== undefined) {
      config.passphrase = passphrase;
    }
  }
  return config;
}

/**
 * 接続してシェルを開く。
 *
 * ホスト鍵が既知のものと違うときは、**接続せずに止める**。
 */
export function connect(options: ConnectOptions): Promise<Session> {
  const { host, profile, known, cols = 80, rows = 24 } = options;

  return new Promise<Session>((resolve, reject) => {
    const client = new Client();
    let hostKey: { fingerprint: string; verdict: HostKeyVerdict } | undefined;
    let settled = false;

    const fail = (error: AppError) => {
      if (settled) {
        return;
      }
      settled = true;
      client.end();
      reject(error);
    };

    const hostVerifier: HostVerifier = (key, callback) => {
      const fingerprint = fingerprintOf(Buffer.isBuffer(key) ? key : Buffer.from(key));
      const verdict = verifyHostKey(known, host.hostname, host.port, fingerprint);
      hostKey = { fingerprint, verdict };

      if (verdict === 'match') {
        callback(true);
        return;
      }
      if (verdict === 'changed') {
        fail(
          new AppError(
            'ssh_host_key_changed',
            `${host.hostname} のホスト鍵が、以前に記録したものと違います。接続を中止しました。` +
              '経路上で別のサーバに繋がっている可能性があります。',
            fingerprint,
          ),
        );
        callback(false);
        return;
      }

      const ask = options.onUnknownHostKey;
      if (!ask) {
        fail(
          new AppError(
            'ssh_host_key_rejected',
            `${host.hostname} のホスト鍵は未確認です。指紋 ${fingerprint} を確認してください。`,
          ),
        );
        callback(false);
        return;
      }
      Promise.resolve(ask({ hostname: host.hostname, port: host.port, fingerprint }))
        .then((accepted) => {
          if (!accepted) {
            fail(
              new AppError(
                'ssh_host_key_rejected',
                `${host.hostname} のホスト鍵を受け入れなかったため、接続しませんでした。`,
              ),
            );
          }
          callback(accepted);
        })
        .catch(() => callback(false));
    };

    client.on('ready', () => {
      client.shell({ term: profile.term, cols, rows }, { env: profile.env }, (error, stream) => {
        if (error) {
          fail(
            new AppError(
              'ssh_no_session',
              `${host.hostname} でシェルを開けませんでした。`,
              error.message,
            ),
          );
          return;
        }
        if (settled) {
          stream.end();
          client.end();
          return;
        }
        settled = true;
        resolve(
          new Session(
            host,
            client,
            stream,
            hostKey ?? { fingerprint: '', verdict: 'unknown' },
            profile.encoding,
            options.scrollbackLimit,
          ),
        );
      });
    });

    client.on('error', (error: NodeJS.ErrnoException) => fail(classifyConnectError(error, host)));

    client.connect(connectConfig(options, hostVerifier));
  });
}

/**
 * シェルとは別にコマンドを実行する。
 * SFTP の中身検索(#22)や tmux の有無の判定(#18)で使う。
 */
export function execCommand(session: SessionHandle, command: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    session.client.exec(command, (error, stream) => {
      if (error) {
        reject(new AppError('ssh_no_session', 'コマンドを実行できませんでした。', error.message));
        return;
      }
      let stdout = '';
      let stderr = '';
      let code: number | null = null;
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('exit', (exitCode: number | null) => {
        code = exitCode;
      });
      stream.on('close', () => resolve({ stdout, stderr, code }));
    });
  });
}

/** `execCommand` が要るのは ssh2 の Client だけ。 */
export interface SessionHandle {
  client: Client;
}

/** セッションの台帳。 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  add(session: Session): Session {
    this.sessions.set(session.id, session);
    session.onClose(() => this.sessions.delete(session.id));
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new AppError('ssh_no_session', '指定されたセッションはありません。');
    }
    return session;
  }

  find(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  close(id: string): void {
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}
