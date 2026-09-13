/**
 * サーバと画面で共有する型。
 * 各機能の型は実装フェーズで足す(docs/requirements.md 9 章のフェーズ 1)。
 * ここには、要件定義で語彙が確定しているものだけを置く。
 */

/** 金庫の動作モード。`local` は現行互換、`passkey` はマスターパスキーで復号する。 */
export type VaultMode = 'local' | 'passkey';

/** 暗号化の範囲。`full` では接続先・履歴・手順も暗号化する。 */
export type EncryptionScope = 'secrets' | 'full';

/** 改行コード。開いた時の形を保持する。 */
export type EolStyle = 'lf' | 'crlf';

/** 死活確認の応答 */
export interface HealthResponse {
  status: 'ok';
  version: string;
  /** 金庫が施錠されているか。施錠中は `/api/vault/*` 以外を 423 で拒否する。 */
  locked: boolean;
}
