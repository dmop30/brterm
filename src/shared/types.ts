/**
 * サーバと画面で共有する型。
 *
 * 語彙は要件定義 3 章に合わせる。勝手に増やさない。
 * 各機能固有の型は実装フェーズで足す(要件定義 9 章)。
 */

/** 金庫の動作モード。`local` は現行互換、`passkey` はマスターパスキーで復号する。 */
export type VaultMode = 'local' | 'passkey';

/** 暗号化の範囲。`full` では接続先・履歴・手順も暗号化する。 */
export type EncryptionScope = 'secrets' | 'full';

/** 改行コード。開いた時の形を保持する。 */
export type EolStyle = 'lf' | 'crlf';

/** 扱う文字コード。端末・SFTP・エディタで共通。 */
export type Encoding = 'utf-8' | 'shift_jis' | 'euc-jp';

/** 配色。`system` は OS の設定に従う。 */
export type ThemePreference = 'system' | 'dark' | 'light';

/**
 * 暗号化して保存した値。
 * 中身は AES-256-GCM。`v` は形式の版数で、鍵の導出方法が変わったら上げる。
 */
export interface SealedValue {
  v: 1;
  /** 初期化ベクトル(base64) */
  iv: string;
  /** 認証タグ(base64) */
  tag: string;
  /** 暗号文(base64) */
  data: string;
}

/** 接続先の認証方法。`sudo` を伴う権限昇格は行わない(要件定義 11 章)。 */
export type AuthMethod = 'password' | 'key';

/** 接続先(Host)。認証情報とプロファイルを持つ。 */
export interface Host {
  id: string;
  /** 画面に出す名前 */
  label: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** パスワード(暗号化済み)。`authMethod` が `password` のときに持つ。 */
  password?: SealedValue;
  /** 秘密鍵のパス。鍵そのものは brterm に取り込まない。 */
  privateKeyPath?: string;
  /** 秘密鍵のパスフレーズ(暗号化済み) */
  passphrase?: SealedValue;
  /** 使うプロファイル。未指定なら既定のプロファイル。 */
  profileId?: string;
  createdAt: string;
  updatedAt: string;
}

/** プロファイル(Profile)。文字コード・TERM・環境変数・接続時コマンドをまとめた設定。 */
export interface Profile {
  id: string;
  label: string;
  encoding: Encoding;
  term: string;
  env: Record<string, string>;
  /** 接続直後に流すコマンド。結果は履歴に残さない。 */
  onConnect: string[];
}

/**
 * 手順のステップ。
 * `kind` を持たせてあるのは、P8 で `fileEdit`(パス・差分・ハッシュ)を足すため。
 */
export interface CommandStep {
  kind: 'command';
  id: string;
  command: string;
  output?: string;
  exitCode?: number;
  at: string;
  /** 手順に残すときの注記 */
  note?: string;
}

export type ProcedureStep = CommandStep;

/** 手順(Procedure)。コマンドと実行結果を並べた再実行可能なドキュメント。 */
export interface Procedure {
  id: string;
  title: string;
  hostId?: string;
  steps: ProcedureStep[];
  createdAt: string;
  updatedAt: string;
}

/** 実行履歴。秘密情報は記録しない。 */
export interface HistoryEntry {
  id: string;
  hostId: string;
  command: string;
  exitCode?: number;
  at: string;
}

/** 予定実行(cron)。過ぎた予定の取り返し運転はしない(要件定義 11 章)。 */
export interface Schedule {
  id: string;
  label: string;
  hostId: string;
  /** cron 式(5 フィールド) */
  cron: string;
  commands: string[];
  enabled: boolean;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'failed' | 'skipped';
}

/** 既知のホスト鍵。指紋が変わったら接続しない。 */
export interface KnownHostKey {
  hostname: string;
  port: number;
  keyType: string;
  /** SHA256 の指紋(`SHA256:...`) */
  fingerprint: string;
  addedAt: string;
}

/** 設定。新機能は既定オフ(要件定義 1 章の設計上の約束)。 */
export interface Settings {
  theme: ThemePreference;
  /** 危険コマンドの実行前確認。既定は有効。 */
  confirmDangerousCommands: boolean;
  /** 履歴の保持件数 */
  historyLimit: number;
  vaultMode: VaultMode;
  encryptionScope: EncryptionScope;
  /** エディタの初回保存時に `<name>.brterm.bak` を作る。既定オフ(要件定義 4.4)。 */
  editorBackup: boolean;
}

/** `db.json` の中身。 */
export interface Database {
  schemaVersion: number;
  hosts: Host[];
  profiles: Profile[];
  procedures: Procedure[];
  schedules: Schedule[];
  history: HistoryEntry[];
  knownHostKeys: KnownHostKey[];
  settings: Settings;
}

/** 死活確認の応答 */
export interface HealthResponse {
  status: 'ok';
  version: string;
  /** 金庫が施錠されているか。施錠中は `/api/vault/*` 以外を 423 で拒否する。 */
  locked: boolean;
}
