/**
 * 保存する秘密情報の暗号化。AES-256-GCM。
 *
 * 鍵は `~/.brterm/master.key`(権限 600)に置くローカル鍵。
 * P2 でマスターパスキー(KEK/DEK)へ作り替えるため、**鍵の渡し方を引数に寄せてある**
 * (モジュールの中に鍵を隠し持たない)。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';

import type { SealedValue } from '../shared/types.js';
import { AppError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** 暗号鍵。`Buffer` をそのまま持ち回さないよう型で区別する。 */
export interface DataKey {
  readonly bytes: Buffer;
}

export function dataKeyFrom(bytes: Buffer): DataKey {
  if (bytes.length !== KEY_BYTES) {
    throw new AppError('key_unreadable', '暗号鍵の長さが不正です。', `expected ${KEY_BYTES} bytes`);
  }
  return { bytes };
}

/**
 * ローカル鍵を読む。無ければ作る。
 *
 * 権限は 600 にする。既にあるファイルが緩い権限なら締め直す
 * (他利用者から読めるまま使い続けない)。
 */
export function loadOrCreateLocalKey(keyPath: string): DataKey {
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    const created = randomBytes(KEY_BYTES);
    writeFileSync(keyPath, created, { mode: 0o600 });
    return dataKeyFrom(created);
  }

  let raw: Buffer;
  try {
    raw = readFileSync(keyPath);
  } catch (cause) {
    throw new AppError(
      'key_unreadable',
      'ローカル鍵を読めません。権限を確認してください。',
      `${keyPath}: ${(cause as Error).message}`,
    );
  }

  // 読めたときだけ権限を締め直す。Windows では chmod が効かないため失敗は無視する。
  if ((statSync(keyPath).mode & 0o077) !== 0) {
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      /* 権限の概念が無い環境では何もしない */
    }
  }

  return dataKeyFrom(raw);
}

/** 値を封入する。 */
export function seal(key: DataKey, plaintext: string): SealedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/**
 * 値を開く。
 *
 * 鍵違い・改竄・形式違いはすべて `decrypt_failed` にする。
 * **どこで失敗したかを画面に出さない**(総当たりの手がかりを与えないため)。
 */
export function open(key: DataKey, sealed: SealedValue): string {
  if (sealed.v !== 1) {
    throw new AppError(
      'decrypt_failed',
      '保存された値を復号できません。',
      `unknown version ${sealed.v}`,
    );
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.data, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (cause) {
    throw new AppError(
      'decrypt_failed',
      '保存された値を復号できません。鍵が変わっているか、ファイルが壊れています。',
      (cause as Error).name,
    );
  }
}

/** 鍵が同じものかを、内容を漏らさずに確かめる(移行処理の検証用)。 */
export function sameKey(a: DataKey, b: DataKey): boolean {
  return a.bytes.length === b.bytes.length && timingSafeEqual(a.bytes, b.bytes);
}
