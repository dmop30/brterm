import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AppError } from '../src/server/errors.js';
import {
  DB_FILE,
  SCHEMA_VERSION,
  defaultDatabase,
  loadDatabase,
  saveDatabase,
} from '../src/server/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'brterm-store-'));
}

test('保存ファイルが無ければ既定値を返す', () => {
  const db = loadDatabase(tempDir());
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(db.hosts, []);
  assert.equal(db.profiles.length, 1);
  assert.equal(db.settings.vaultMode, 'local');
  // 新機能は既定オフ
  assert.equal(db.settings.editorBackup, false);
  assert.equal(db.settings.confirmDangerousCommands, true);
});

test('保存して読み直すと内容が一致する', () => {
  const dir = tempDir();
  const db = defaultDatabase();
  db.hosts.push({
    id: 'h1',
    label: 'web-01',
    hostname: 'web-01.example.jp',
    port: 22,
    username: 'ops',
    authMethod: 'password',
    password: { v: 1, iv: 'aXY=', tag: 'dGFn', data: 'ZGF0YQ==' },
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  });
  saveDatabase(db, dir);
  assert.deepEqual(loadDatabase(dir), db);
});

test('保存ファイルの権限は 600', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  saveDatabase(defaultDatabase(), dir);
  assert.equal(statSync(join(dir, DB_FILE)).mode & 0o777, 0o600);
});

test('一時ファイルを残さない', () => {
  const dir = tempDir();
  saveDatabase(defaultDatabase(), dir);
  saveDatabase(defaultDatabase(), dir);
  assert.deepEqual(readdirSync(dir), [DB_FILE]);
});

test('壊れた JSON は既定値で上書きせず、状態を明示して止まる', () => {
  const dir = tempDir();
  writeFileSync(join(dir, DB_FILE), '{ これは JSON ではない');
  assert.throws(
    () => loadDatabase(dir),
    (error: unknown) => error instanceof AppError && error.code === 'store_broken',
  );
  // 壊れたファイルを消していないこと(利用者が手で直せる)
  assert.ok(existsSync(join(dir, DB_FILE)));
});

test('版数が無いファイルは壊れている扱い', () => {
  const dir = tempDir();
  writeFileSync(join(dir, DB_FILE), JSON.stringify({ hosts: [] }));
  assert.throws(
    () => loadDatabase(dir),
    (error: unknown) => error instanceof AppError && error.code === 'store_broken',
  );
});

test('未来の版数は読まない', () => {
  const dir = tempDir();
  writeFileSync(join(dir, DB_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
  assert.throws(
    () => loadDatabase(dir),
    (error: unknown) => error instanceof AppError && error.code === 'store_version_unsupported',
  );
});

test('項目が欠けた古いファイルは構造だけを既定で埋める', () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, DB_FILE),
    JSON.stringify({ schemaVersion: 1, hosts: [], settings: { theme: 'dark' } }),
  );
  const db = loadDatabase(dir);
  assert.equal(db.settings.theme, 'dark');
  assert.equal(db.settings.historyLimit, 2000);
  assert.deepEqual(db.procedures, []);
  assert.equal(db.profiles.length, 1);
});

test('配列を書いたファイルは受け付けない', () => {
  const dir = tempDir();
  writeFileSync(join(dir, DB_FILE), '[]');
  assert.throws(
    () => loadDatabase(dir),
    (error: unknown) => error instanceof AppError && error.code === 'store_broken',
  );
});
