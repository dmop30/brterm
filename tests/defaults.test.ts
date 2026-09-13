import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BIND_ADDRESS,
  DEV_CLIENT_PORT,
  EDITOR_MAX_BYTES,
  SERVER_PORT,
  TREE_MAX_ENTRIES,
} from '../src/shared/defaults.js';

// 要件定義で値が決まっているものは、黙って変わらないように固定する。
test('ポートは要件定義どおり', () => {
  assert.equal(SERVER_PORT, 7781);
  assert.equal(DEV_CLIENT_PORT, 5273);
});

test('既定の待ち受けは localhost だけ', () => {
  assert.equal(BIND_ADDRESS, '127.0.0.1');
});

test('エディタとツリーの上限', () => {
  assert.equal(EDITOR_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(TREE_MAX_ENTRIES, 2000);
});
