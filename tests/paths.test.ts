import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { dataDir, dataPath } from '../src/server/paths.js';

test('既定の保存先はホーム直下の .brterm', () => {
  assert.equal(dataDir({}), join(homedir(), '.brterm'));
});

test('BRTERM_DATA_DIR が設定されていればそちらを使う', () => {
  assert.equal(dataDir({ BRTERM_DATA_DIR: '/tmp/brterm-test' }), '/tmp/brterm-test');
});

test('空文字の BRTERM_DATA_DIR は無視する', () => {
  assert.equal(dataDir({ BRTERM_DATA_DIR: '' }), join(homedir(), '.brterm'));
});

test('dataPath は保存先の下を指す', () => {
  assert.equal(
    dataPath('db.json', { BRTERM_DATA_DIR: '/tmp/brterm-test' }),
    '/tmp/brterm-test/db.json',
  );
});
