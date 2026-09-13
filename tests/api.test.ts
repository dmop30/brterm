import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createContext } from '../src/server/context.js';
import { createApp } from '../src/server/index.js';
import { DB_FILE, loadDatabase } from '../src/server/store.js';

interface Started {
  url: string;
  token: string;
  dir: string;
  close(): void;
}

const started: Started[] = [];

async function start(options: { devMode?: boolean } = {}): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-api-'));
  const context = createContext(dir);
  const app = createApp({
    context,
    devMode: options.devMode ?? false,
    origins: ['http://127.0.0.1:7781'],
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const { port } = server.address() as AddressInfo;
  const instance: Started = {
    url: `http://127.0.0.1:${port}`,
    token: context.token,
    dir,
    close: () => server.close(),
  };
  started.push(instance);
  return instance;
}

after(() => {
  for (const instance of started) {
    instance.close();
  }
});

function auth(instance: Started): Record<string, string> {
  return { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' };
}

test('トークンが無ければ 401', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/hosts`);
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'token_required');
  // 文言は日本語で、直し方が分かること
  assert.match(body.error.message, /トークン/);
});

test('間違ったトークンでも 401', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/hosts`, {
    headers: { authorization: 'Bearer ' + 'f'.repeat(64) },
  });
  assert.equal(response.status, 401);
});

test('正しいトークンなら通る', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/hosts`, { headers: auth(instance) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hosts: [] });
});

test('別 Origin からの要求は 403', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/hosts`, {
    headers: { ...auth(instance), origin: 'http://example.com' },
  });
  assert.equal(response.status, 403);
});

test('死活確認は認証を通さない', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/health`);
  assert.equal(response.status, 200);
});

test('開発モードではトークンを省略できる', async () => {
  const instance = await start({ devMode: true });
  const response = await fetch(`${instance.url}/api/hosts`);
  assert.equal(response.status, 200);
});

test('接続先を作ると保存され、パスワードは返らない', async () => {
  const instance = await start();
  const created = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({
      label: 'web-01',
      hostname: 'web-01.example.jp',
      username: 'ops',
      password: '秘密のパスワード',
    }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { host: Record<string, unknown> };
  assert.equal(body.host.hasPassword, true);
  assert.equal(body.host.password, undefined);
  assert.equal(body.host.port, 22);

  const listed = await fetch(`${instance.url}/api/hosts`, { headers: auth(instance) });
  const list = (await listed.json()) as { hosts: Record<string, unknown>[] };
  assert.equal(list.hosts.length, 1);
  assert.equal(list.hosts[0]?.password, undefined);
});

test('保存ファイルに平文のパスワードが残らない', async () => {
  const instance = await start();
  await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({
      label: 'db-02',
      hostname: 'db-02.example.jp',
      username: 'ops',
      password: 'PLAINTEXT-SECRET',
    }),
  });
  const saved = readFileSync(join(instance.dir, DB_FILE), 'utf8');
  assert.equal(saved.includes('PLAINTEXT-SECRET'), false);
  assert.equal(saved.includes('"iv"'), true);
});

test('必須項目が無ければ 400 で理由が分かる', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ hostname: 'x.example.jp' }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'invalid_host');
  assert.match(body.error.message, /入力/);
});

test('ポート番号の範囲を確かめる', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ label: 'a', hostname: 'a', username: 'a', port: 70000 }),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'invalid_port');
});

test('接続先を更新・削除できる', async () => {
  const instance = await start();
  const created = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ label: 'web-01', hostname: 'web-01.example.jp', username: 'ops' }),
  });
  const { host } = (await created.json()) as { host: { id: string } };

  const patched = await fetch(`${instance.url}/api/hosts/${host.id}`, {
    method: 'PATCH',
    headers: auth(instance),
    body: JSON.stringify({ label: 'web-01 (東京)', port: 2222 }),
  });
  assert.equal(patched.status, 200);
  const updated = (await patched.json()) as { host: { label: string; port: number } };
  assert.equal(updated.host.label, 'web-01 (東京)');
  assert.equal(updated.host.port, 2222);

  const deleted = await fetch(`${instance.url}/api/hosts/${host.id}`, {
    method: 'DELETE',
    headers: auth(instance),
  });
  assert.equal(deleted.status, 204);

  const missing = await fetch(`${instance.url}/api/hosts/${host.id}`, { headers: auth(instance) });
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { error: { code: string } }).error.code,
    'host_not_found',
  );
});

test('空文字のパスワードは「消す」', async () => {
  const instance = await start();
  const created = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ label: 'a', hostname: 'a', username: 'a', password: 'p' }),
  });
  const { host } = (await created.json()) as { host: { id: string } };
  const patched = await fetch(`${instance.url}/api/hosts/${host.id}`, {
    method: 'PATCH',
    headers: auth(instance),
    body: JSON.stringify({ password: '' }),
  });
  const body = (await patched.json()) as { host: { hasPassword: boolean } };
  assert.equal(body.host.hasPassword, false);
});

test('設定を読んで変えられる', async () => {
  const instance = await start();
  const before = await fetch(`${instance.url}/api/settings`, { headers: auth(instance) });
  const body = (await before.json()) as { settings: { theme: string; historyLimit: number } };
  assert.equal(body.settings.theme, 'system');

  const patched = await fetch(`${instance.url}/api/settings`, {
    method: 'PATCH',
    headers: auth(instance),
    body: JSON.stringify({ theme: 'dark', historyLimit: 999999 }),
  });
  const updated = (await patched.json()) as { settings: { theme: string; historyLimit: number } };
  assert.equal(updated.settings.theme, 'dark');
  // 青天井にしない
  assert.equal(updated.settings.historyLimit, 100000);
});

async function createHost(instance: Started, label: string): Promise<string> {
  const response = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ label, hostname: `${label}.example.jp`, username: 'ops' }),
  });
  return ((await response.json()) as { host: { id: string } }).host.id;
}

test('ブックマークを追加すると保存され、読み込み直しても残る', async () => {
  const instance = await start();
  const hostId = await createHost(instance, 'web-01');
  const created = await fetch(`${instance.url}/api/bookmarks`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ hostId, path: '/etc/nginx/' }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { bookmark: { path: string; label: string } };
  assert.equal(body.bookmark.path, '/etc/nginx');
  assert.equal(body.bookmark.label, 'nginx');

  // 保存ファイルから読み直す（再起動と同じこと）
  const reloaded = loadDatabase(instance.dir);
  assert.equal(reloaded.bookmarks.length, 1);
  assert.equal(reloaded.bookmarks[0]?.path, '/etc/nginx');
});

test('同じ接続先の同じパスを 2 回追加しても増えない', async () => {
  const instance = await start();
  const hostId = await createHost(instance, 'web-01');
  for (const label of ['nginx', 'nginx 設定']) {
    await fetch(`${instance.url}/api/bookmarks`, {
      method: 'POST',
      headers: auth(instance),
      body: JSON.stringify({ hostId, path: '/etc/nginx', label }),
    });
  }
  const listed = await fetch(`${instance.url}/api/bookmarks?hostId=${hostId}`, {
    headers: auth(instance),
  });
  const body = (await listed.json()) as { bookmarks: { label: string }[] };
  assert.equal(body.bookmarks.length, 1);
  assert.equal(body.bookmarks[0]?.label, 'nginx 設定');
});

test('無い接続先にはブックマークを作れない', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/bookmarks`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ hostId: 'いない', path: '/etc' }),
  });
  assert.equal(response.status, 404);
});

test('相対パスは受け付けない', async () => {
  const instance = await start();
  const hostId = await createHost(instance, 'web-01');
  const response = await fetch(`${instance.url}/api/bookmarks`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ hostId, path: 'etc/nginx' }),
  });
  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    'invalid_bookmark',
  );
});

test('表示名を変えられる。ブックマークを消せる', async () => {
  const instance = await start();
  const hostId = await createHost(instance, 'web-01');
  const created = await fetch(`${instance.url}/api/bookmarks`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ hostId, path: '/var/log' }),
  });
  const { bookmark } = (await created.json()) as { bookmark: { id: string } };

  const patched = await fetch(`${instance.url}/api/bookmarks/${bookmark.id}`, {
    method: 'PATCH',
    headers: auth(instance),
    body: JSON.stringify({ label: 'ログ' }),
  });
  assert.equal(((await patched.json()) as { bookmark: { label: string } }).bookmark.label, 'ログ');

  const deleted = await fetch(`${instance.url}/api/bookmarks/${bookmark.id}`, {
    method: 'DELETE',
    headers: auth(instance),
  });
  assert.equal(deleted.status, 204);

  const missing = await fetch(`${instance.url}/api/bookmarks/${bookmark.id}`, {
    method: 'DELETE',
    headers: auth(instance),
  });
  assert.equal(missing.status, 404);
});

test('並べ替えた順が保存される', async () => {
  const instance = await start();
  const hostId = await createHost(instance, 'web-01');
  const ids: string[] = [];
  for (const path of ['/etc/nginx', '/var/log', '~/deploy']) {
    const response = await fetch(`${instance.url}/api/bookmarks`, {
      method: 'POST',
      headers: auth(instance),
      body: JSON.stringify({ hostId, path }),
    });
    ids.push(((await response.json()) as { bookmark: { id: string } }).bookmark.id);
  }
  const reversed = [...ids].reverse();
  const response = await fetch(`${instance.url}/api/bookmarks/reorder`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ hostId, ids: reversed }),
  });
  const body = (await response.json()) as { bookmarks: { id: string }[] };
  assert.deepEqual(
    body.bookmarks.map((entry) => entry.id),
    reversed,
  );
  assert.deepEqual(
    loadDatabase(instance.dir)
      .bookmarks.sort((a, b) => a.order - b.order)
      .map((entry) => entry.id),
    reversed,
  );
});

test('接続先を消すと、その接続先のブックマークも消える', async () => {
  const instance = await start();
  const hostId = await createHost(instance, 'web-01');
  const otherId = await createHost(instance, 'db-02');
  for (const id of [hostId, otherId]) {
    await fetch(`${instance.url}/api/bookmarks`, {
      method: 'POST',
      headers: auth(instance),
      body: JSON.stringify({ hostId: id, path: '/etc/nginx' }),
    });
  }
  await fetch(`${instance.url}/api/hosts/${hostId}`, { method: 'DELETE', headers: auth(instance) });

  const listed = await fetch(`${instance.url}/api/bookmarks`, { headers: auth(instance) });
  const body = (await listed.json()) as { bookmarks: { hostId: string }[] };
  assert.equal(body.bookmarks.length, 1);
  assert.equal(body.bookmarks[0]?.hostId, otherId);
});

test('ブックマークもトークン無しでは触れない', async () => {
  const instance = await start();
  assert.equal((await fetch(`${instance.url}/api/bookmarks`)).status, 401);
});

test('プロファイルの既定は UTF-8', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/profiles`, {
    method: 'POST',
    headers: auth(instance),
    body: JSON.stringify({ label: '検証用' }),
  });
  const body = (await response.json()) as { profile: { encoding: string; term: string } };
  assert.equal(body.profile.encoding, 'utf-8');
  assert.equal(body.profile.term, 'xterm-256color');
});
