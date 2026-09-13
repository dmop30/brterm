import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authHeaders, tokenFromSearch, websocketUrl } from '../src/client/lib/token.js';

test('URL の ?token= から取り出す', () => {
  assert.equal(tokenFromSearch('?token=abc123'), 'abc123');
  assert.equal(tokenFromSearch('?foo=1&token=abc123&bar=2'), 'abc123');
  assert.equal(tokenFromSearch('?foo=1'), undefined);
  assert.equal(tokenFromSearch(''), undefined);
  assert.equal(tokenFromSearch('?token='), undefined);
});

test('API 呼び出しの見出しを組み立てる', () => {
  assert.deepEqual(authHeaders('abc'), { authorization: 'Bearer abc' });
  assert.deepEqual(authHeaders('abc', true), {
    authorization: 'Bearer abc',
    'content-type': 'application/json',
  });
  // トークンが無いときは付けない（開発モードでは不要）
  assert.deepEqual(authHeaders(undefined), {});
});

test('WebSocket の宛先は、画面と同じ方式に合わせる', () => {
  assert.equal(
    websocketUrl({ protocol: 'http:', host: '127.0.0.1:7781' }, 'abc'),
    'ws://127.0.0.1:7781/ws?token=abc',
  );
  // https の画面から ws で繋ぐと弾かれるので wss にする
  assert.equal(
    websocketUrl({ protocol: 'https:', host: 'example.jp' }, 'abc'),
    'wss://example.jp/ws?token=abc',
  );
  assert.equal(websocketUrl({ protocol: 'http:', host: 'x:1' }, undefined), 'ws://x:1/ws');
});

test('トークンは URL に入れられる形にする', () => {
  assert.match(websocketUrl({ protocol: 'http:', host: 'x:1' }, 'a b&c'), /token=a%20b%26c/);
});
