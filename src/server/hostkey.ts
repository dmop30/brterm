/**
 * ホスト鍵の指紋の扱い。
 *
 * **指紋が変わったら接続しない。** 中間者攻撃と区別が付かないため、
 * 「たぶん再構築しただけ」という推測で続行しない(要件定義 1 章)。
 */
import { createHash } from 'node:crypto';

import type { KnownHostKey } from '../shared/types.js';

/** OpenSSH と同じ `SHA256:...`(base64、末尾の = は落とす)。 */
export function fingerprintOf(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export type HostKeyVerdict = 'match' | 'unknown' | 'changed';

export function verifyHostKey(
  known: readonly KnownHostKey[],
  hostname: string,
  port: number,
  fingerprint: string,
): HostKeyVerdict {
  const entry = known.find((item) => item.hostname === hostname && item.port === port);
  if (!entry) {
    return 'unknown';
  }
  return entry.fingerprint === fingerprint ? 'match' : 'changed';
}

/** 受け入れた鍵を覚える。同じ接続先の古い記録は置き換える。 */
export function rememberHostKey(
  known: KnownHostKey[],
  entry: Omit<KnownHostKey, 'addedAt'>,
  now: Date = new Date(),
): KnownHostKey[] {
  const rest = known.filter(
    (item) => !(item.hostname === entry.hostname && item.port === entry.port),
  );
  return [...rest, { ...entry, addedAt: now.toISOString() }];
}
