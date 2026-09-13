/**
 * サーバと画面の両方が使う既定値。
 * 要件定義(docs/requirements.md)で値が決まっているものだけを置く。
 * 画面・サーバのどちらか片方しか使わない値はここに入れない。
 */

/** サーバの待ち受けポート */
export const SERVER_PORT = 7781;

/** 開発時の Vite のポート */
export const DEV_CLIENT_PORT = 5273;

/** 既定の待ち受けアドレス。外部公開は利用者が明示的に変えるまで行わない。 */
export const BIND_ADDRESS = '127.0.0.1';

/** データ保存先のディレクトリ名(ホームディレクトリ直下) */
export const DATA_DIR_NAME = '.brterm';

/** エディタで編集できるファイルサイズの上限(2 MB)。超える分は読み取り専用で先頭のみ。 */
export const EDITOR_MAX_BYTES = 2 * 1024 * 1024;

/** ツリーで 1 フォルダあたり表示する上限。超えた分は「先頭のみ表示」と明示する。 */
export const TREE_MAX_ENTRIES = 2000;

/** 名前での再帰検索の既定上限 */
export const SEARCH_MAX_DEPTH = 6;
export const SEARCH_MAX_RESULTS = 500;

/** ログ追尾の既定間隔(ミリ秒) */
export const LOG_FOLLOW_INTERVAL_MS = 2000;

/** csv / tsv を表として出すときの上限行数 */
export const TABLE_MAX_ROWS = 5000;
