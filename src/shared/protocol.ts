/**
 * 画面とサーバのあいだで交わす WebSocket のメッセージ。
 *
 * 画面とサーバの両方が同じ型を見るように `shared` に置く。
 * **対話（ホスト鍵の確認）もこの経路に乗せる。** 端末の入出力と順番が混ざらないようにするため。
 */

/** 画面 → サーバ */
export type ClientMessage =
  /** 接続先を指定して新しいセッションを開く */
  | { type: 'open'; hostId: string; cols?: number; rows?: number }
  /** 既にあるセッションに繋ぎ直す(ブラウザのリロード = L1) */
  | { type: 'attach'; sessionId: string; cols?: number; rows?: number }
  /** 打った文字 */
  | { type: 'input'; data: string }
  /** 端末の大きさが変わった */
  | { type: 'resize'; cols: number; rows: number }
  /** 未確認のホスト鍵を受け入れるか */
  | { type: 'hostkey-decision'; accept: boolean }
  /** セッションを終わらせる */
  | { type: 'close' };

/** サーバ → 画面 */
export type ServerMessage =
  /** セッションが開いた。`snapshot` は再接続時の直前の表示 */
  | { type: 'opened'; sessionId: string; snapshot: string }
  /** 端末の出力 */
  | { type: 'data'; data: string }
  /** ホスト鍵の確認を求める。画面は指紋を出して利用者に尋ねる */
  | { type: 'hostkey'; hostname: string; port: number; fingerprint: string }
  /** セッションが切れた */
  | { type: 'closed' }
  /** 失敗した。`message` はそのまま画面に出せる日本語 */
  | { type: 'error'; code: string; message: string };
