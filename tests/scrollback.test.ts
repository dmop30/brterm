import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Scrollback } from '../src/server/scrollback.js';

test('書いたものがそのまま戻る', () => {
  const scrollback = new Scrollback(100);
  scrollback.append('あ');
  scrollback.append('い');
  assert.equal(scrollback.snapshot(), 'あい');
});

test('上限を超えたら古い方から捨てる', () => {
  const scrollback = new Scrollback(10);
  scrollback.append('0123456789');
  scrollback.append('abcde');
  assert.ok(scrollback.size <= 10);
  assert.equal(scrollback.snapshot().endsWith('abcde'), true);
  assert.equal(scrollback.snapshot().includes('0123456789'), false);
});

test('1 つの塊が上限より大きいときは末尾を残す', () => {
  const scrollback = new Scrollback(5);
  scrollback.append('0123456789');
  assert.equal(scrollback.snapshot(), '56789');
});

test('空文字は何もしない', () => {
  const scrollback = new Scrollback(10);
  scrollback.append('');
  assert.equal(scrollback.size, 0);
});

test('消せる', () => {
  const scrollback = new Scrollback(10);
  scrollback.append('abc');
  scrollback.clear();
  assert.equal(scrollback.snapshot(), '');
});
