/**
 * 画面アクセス用トークンの持ち回り。
 *
 * サーバが起動時に出す URL（`?token=...`）で最初に受け取り、以降はタブの中で覚える。
 * `localStorage` ではなく `sessionStorage` に置くのは、**閉じたら消えるほう**が
 * 共用端末での事故が少ないため。
 */
const STORAGE_KEY = 'brterm.token';

/** URL の問い合わせ文字列からトークンを取り出す。 */
export function tokenFromSearch(search: string): string | undefined {
  const value = new URLSearchParams(search).get('token');
  return value && value.length > 0 ? value : undefined;
}

export function rememberToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // 保存できない環境でも、この画面を開いている間は動かす
  }
}

export function storedToken(): string | undefined {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** API 呼び出しに付ける見出し。 */
export function authHeaders(token: string | undefined, json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (json) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

/**
 * WebSocket の宛先。
 * `https` のときは `wss` にする（混在すると繋がらない）。
 */
export function websocketUrl(
  location: { protocol: string; host: string },
  token: string | undefined,
  path = '/ws',
): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${scheme}//${location.host}${path}${query}`;
}
