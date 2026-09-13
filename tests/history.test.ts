import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listHistory, recordCommand, trimHistory } from '../src/server/history.js';
import { defaultDatabase } from '../src/server/store.js';
import type { Database } from '../src/shared/types.js';

function db(limit = 10): Database {
  const base = defaultDatabase();
  base.settings.historyLimit = limit;
  return base;
}

test('コマンドを 1 件残す', () => {
  const database = db();
  const entry = recordCommand(database, { hostId: 'h1', command: 'uptime' });
  assert.equal(entry?.command, 'uptime');
  assert.equal(database.history.length, 1);
  assert.equal(database.history[0]?.hostId, 'h1');
});

test('前後の空白は落として残す', () => {
  const database = db();
  recordCommand(database, { hostId: 'h1', command: '  ls -la  ' });
  assert.equal(database.history[0]?.command, 'ls -la');
});

test('空行は残さない', () => {
  const database = db();
  assert.equal(recordCommand(database, { hostId: 'h1', command: '   ' }), undefined);
  assert.equal(database.history.length, 0);
});

test('保持件数が 0 なら残さない', () => {
  const database = db(0);
  assert.equal(recordCommand(database, { hostId: 'h1', command: 'uptime' }), undefined);
  assert.equal(database.history.length, 0);
});

test('上限を超えたら古いものから落とす', () => {
  const database = db(3);
  for (const command of ['a', 'b', 'c', 'd']) {
    recordCommand(database, { hostId: 'h1', command });
  }
  assert.deepEqual(
    database.history.map((entry) => entry.command),
    ['b', 'c', 'd'],
  );
});

test('上限を下げたら、その場で溢れた分を落とす', () => {
  const database = db(5);
  for (const command of ['a', 'b', 'c', 'd', 'e']) {
    recordCommand(database, { hostId: 'h1', command });
  }
  database.settings.historyLimit = 2;
  trimHistory(database);
  assert.deepEqual(
    database.history.map((entry) => entry.command),
    ['d', 'e'],
  );
});

test('新しい順に取り出す', () => {
  const database = db();
  recordCommand(database, { hostId: 'h1', command: 'first' });
  recordCommand(database, { hostId: 'h1', command: 'second' });
  assert.deepEqual(
    listHistory(database).map((entry) => entry.command),
    ['second', 'first'],
  );
});

test('接続先で絞れる', () => {
  const database = db();
  recordCommand(database, { hostId: 'h1', command: 'one' });
  recordCommand(database, { hostId: 'h2', command: 'two' });
  assert.deepEqual(
    listHistory(database, { hostId: 'h2' }).map((entry) => entry.command),
    ['two'],
  );
});

test('件数を指定して取り出せる', () => {
  const database = db();
  for (const command of ['a', 'b', 'c']) {
    recordCommand(database, { hostId: 'h1', command });
  }
  assert.deepEqual(
    listHistory(database, { limit: 2 }).map((entry) => entry.command),
    ['c', 'b'],
  );
});

test('終了コードは分かるときだけ残す', () => {
  const database = db();
  const withCode = recordCommand(database, { hostId: 'h1', command: 'nginx -t', exitCode: 0 });
  const without = recordCommand(database, { hostId: 'h1', command: 'uptime' });
  assert.equal(withCode?.exitCode, 0);
  assert.equal('exitCode' in (without ?? {}), false);
});
