/**
 * サーバ側のエラー。
 *
 * なぜ独自の型を作るか: 「復号できない」「壊れている」「権限が無い」を
 * 呼び出し側が区別して、**推測で続行せずに状態を明示して止める**ため(要件定義 1 章)。
 * `message` は画面にそのまま出せる日本語にする。原因の詳細は `detail` に入れ、
 * **秘密情報は入れない**。
 */
export type AppErrorCode =
  /** 保存ファイルが壊れている */
  | 'store_broken'
  /** 保存ファイルの版数が新しすぎる(将来の brterm が書いたもの) */
  | 'store_version_unsupported'
  /** 復号に失敗した(鍵違い・改竄) */
  | 'decrypt_failed'
  /** ローカル鍵が読めない */
  | 'key_unreadable'
  /** 金庫が施錠されている */
  | 'vault_locked'
  /** SSH の認証に失敗した */
  | 'ssh_auth_failed'
  /** SSH で接続先に届かない */
  | 'ssh_unreachable'
  /** ホスト鍵が既知のものと違う。**推測で続行しない** */
  | 'ssh_host_key_changed'
  /** ホスト鍵が未知で、利用者が受け入れなかった */
  | 'ssh_host_key_rejected'
  /** セッションが無い・既に閉じている */
  | 'ssh_no_session';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly detail?: string;

  constructor(code: AppErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/** `unknown` な例外を AppError に寄せる。判別できないものはそのまま投げ直す。 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
