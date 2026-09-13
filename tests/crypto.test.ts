import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { dataKeyFrom, loadOrCreateLocalKey, open, sameKey, seal } from '../src/server/crypto.js';
import { AppError } from '../src/server/errors.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'brterm-crypto-'));
}

test('鍵が無ければ作り、2 回目は同じ鍵を返す', () => {
  const path = join(tempDir(), 'nested', 'master.key');
  const first = loadOrCreateLocalKey(path);
  const second = loadOrCreateLocalKey(path);
  assert.equal(first.bytes.length, 32);
  assert.ok(sameKey(first, second));
});

test('作った鍵の権限は 600', { skip: process.platform === 'win32' }, () => {
  const path = join(tempDir(), 'master.key');
  loadOrCreateLocalKey(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('緩い権限の鍵は読むときに締め直す', { skip: process.platform === 'win32' }, () => {
  const path = join(tempDir(), 'master.key');
  writeFileSync(path, randomBytes(32), { mode: 0o644 });
  loadOrCreateLocalKey(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('封入した値は同じ鍵で開ける', () => {
  const key = loadOrCreateLocalKey(join(tempDir(), 'master.key'));
  const sealed = seal(key, 'パスワード: 秘密123');
  assert.notEqual(sealed.data, 'パスワード: 秘密123');
  assert.equal(open(key, sealed), 'パスワード: 秘密123');
});

test('鍵が違えば開けない(例外で落ちず AppError になる)', () => {
  const key = loadOrCreateLocalKey(join(tempDir(), 'a.key'));
  const other = loadOrCreateLocalKey(join(tempDir(), 'b.key'));
  const sealed = seal(key, 'secret');
  assert.throws(
    () => open(other, sealed),
    (error: unknown) => error instanceof AppError && error.code === 'decrypt_failed',
  );
});

test('暗号文を 1 文字変えたら開けない(GCM の認証タグ)', () => {
  const key = loadOrCreateLocalKey(join(tempDir(), 'master.key'));
  const sealed = seal(key, 'secret');
  const broken = { ...sealed, data: Buffer.from('tampered').toString('base64') };
  assert.throws(
    () => open(key, broken),
    (error: unknown) => error instanceof AppError && error.code === 'decrypt_failed',
  );
});

test('同じ値を 2 回封入しても暗号文は一致しない(IV が毎回変わる)', () => {
  const key = loadOrCreateLocalKey(join(tempDir(), 'master.key'));
  assert.notEqual(seal(key, 'same').data, seal(key, 'same').data);
});

test('長さの違う鍵は受け付けない', () => {
  assert.throws(
    () => dataKeyFrom(randomBytes(16)),
    (error: unknown) => error instanceof AppError && error.code === 'key_unreadable',
  );
});

test('鍵ファイルに平文が残らない(鍵はランダムな 32 バイト)', () => {
  const path = join(tempDir(), 'master.key');
  loadOrCreateLocalKey(path);
  assert.equal(readFileSync(path).length, 32);
});
