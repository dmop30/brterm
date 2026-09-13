import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fingerprintOf, rememberHostKey, verifyHostKey } from '../src/server/hostkey.js';
import type { KnownHostKey } from '../src/shared/types.js';

test('指紋は OpenSSH と同じ形（SHA256:…、末尾の = は落とす）', () => {
  // 空の入力に対する SHA-256 は既知の値
  const fingerprint = fingerprintOf(Buffer.alloc(0));
  assert.equal(fingerprint, 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
});

const known: KnownHostKey[] = [
  {
    hostname: 'web-01.example.jp',
    port: 22,
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:aaa',
    addedAt: '2026-09-01T00:00:00.000Z',
  },
];

test('記録が無ければ unknown', () => {
  assert.equal(verifyHostKey(known, 'db-02.example.jp', 22, 'SHA256:aaa'), 'unknown');
});

test('記録と同じなら match', () => {
  assert.equal(verifyHostKey(known, 'web-01.example.jp', 22, 'SHA256:aaa'), 'match');
});

test('記録と違えば changed（ポート違いは別の接続先として扱う）', () => {
  assert.equal(verifyHostKey(known, 'web-01.example.jp', 22, 'SHA256:bbb'), 'changed');
  assert.equal(verifyHostKey(known, 'web-01.example.jp', 2222, 'SHA256:aaa'), 'unknown');
});

test('覚え直すと古い記録を置き換える', () => {
  const updated = rememberHostKey(known, {
    hostname: 'web-01.example.jp',
    port: 22,
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:bbb',
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.fingerprint, 'SHA256:bbb');
  assert.equal(verifyHostKey(updated, 'web-01.example.jp', 22, 'SHA256:bbb'), 'match');
});
