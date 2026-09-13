import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  allowedOrigins,
  isAllowedOrigin,
  loadOrCreateToken,
  tokenFromRequest,
  tokenMatches,
} from '../src/server/token.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'brterm-token-'));
}

test('トークンが無ければ作り、2 回目は同じものを返す', () => {
  const path = join(tempDir(), 'token');
  const first = loadOrCreateToken(path);
  assert.equal(loadOrCreateToken(path), first);
  assert.equal(first.length, 64);
});

test('トークンの権限は 600', { skip: process.platform === 'win32' }, () => {
  const path = join(tempDir(), 'token');
  loadOrCreateToken(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('短すぎるトークンは作り直す', () => {
  const path = join(tempDir(), 'token');
  writeFileSync(path, 'short\n');
  const token = loadOrCreateToken(path);
  assert.notEqual(token, 'short');
  assert.equal(readFileSync(path, 'utf8').trim(), token);
});

test('トークンの照合は長さ違い・空を弾く', () => {
  assert.equal(tokenMatches('abcdef', 'abcdef'), true);
  assert.equal(tokenMatches('abcdef', 'abcdeg'), false);
  assert.equal(tokenMatches('abcdef', 'abcde'), false);
  assert.equal(tokenMatches('abcdef', undefined), false);
  assert.equal(tokenMatches('abcdef', ''), false);
});

test('トークンはヘッダと問い合わせ文字列のどちらからでも取れる', () => {
  assert.equal(tokenFromRequest({ authorization: 'Bearer abc' }, '/api/hosts'), 'abc');
  assert.equal(tokenFromRequest({ 'x-brterm-token': 'def' }, '/api/hosts'), 'def');
  assert.equal(tokenFromRequest({}, '/api/hosts?token=ghi'), 'ghi');
  assert.equal(tokenFromRequest({}, '/api/hosts'), undefined);
});

test('Origin は許した一覧だけを通す', () => {
  const origins = allowedOrigins('127.0.0.1', 7781, 5273);
  assert.equal(isAllowedOrigin('http://127.0.0.1:7781', origins), true);
  assert.equal(isAllowedOrigin('http://localhost:5273', origins), true);
  assert.equal(isAllowedOrigin('http://example.com', origins), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:9999', origins), false);
});

test('Origin が無い要求は通す(ブラウザ以外のクライアント)', () => {
  const origins = allowedOrigins('127.0.0.1', 7781);
  assert.equal(isAllowedOrigin(undefined, origins), true);
  assert.equal(isAllowedOrigin('null', origins), true);
});
