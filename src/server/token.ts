/**
 * 画面アクセス用トークン。
 *
 * 既定の待ち受けは 127.0.0.1 だが、それだけでは同じ機械の別の利用者や
 * 別のアプリから叩ける。トークンで「この brterm を起動した人」に絞る(要件定義 7 章)。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';

/** トークンを読む。無ければ作る。権限は 600。 */
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
    // 短すぎるものは作り直す(手で書き換えられた場合など)
  }
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    /* 権限の概念が無い環境では何もしない */
  }
  return token;
}

/** 長さで早く漏れないよう、比較は時間を一定にする。 */
export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * 要求からトークンを取り出す。
 *
 * 画面の初回読み込みは `?token=` で渡し、以後は画面が `Authorization` を付ける。
 * WebSocket も同じ規則で扱えるよう、ヘッダと問い合わせ文字列の両方を見る。
 */
export function tokenFromRequest(
  headers: Record<string, unknown>,
  url: string,
): string | undefined {
  const authorization = headers['authorization'];
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  const header = headers['x-brterm-token'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  const query = url.includes('?')
    ? new URLSearchParams(url.slice(url.indexOf('?') + 1))
    : undefined;
  return query?.get('token') ?? undefined;
}

/**
 * Origin を確かめる。
 *
 * ブラウザの別サイトから API を叩かれないようにする。Origin が無い要求
 * (curl や WebSocket 以外のクライアント)は、トークンだけで判断する。
 */
export function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (origin === undefined || origin === '' || origin === 'null') {
    return true;
  }
  return allowed.includes(origin);
}

/** 待ち受け先から、許す Origin の一覧を作る。 */
export function allowedOrigins(host: string, port: number, devClientPort?: number): string[] {
  const hosts = host === '127.0.0.1' || host === 'localhost' ? ['127.0.0.1', 'localhost'] : [host];
  const ports = devClientPort === undefined ? [port] : [port, devClientPort];
  const origins: string[] = [];
  for (const name of hosts) {
    for (const value of ports) {
      origins.push(`http://${name}:${value}`);
    }
  }
  return origins;
}
