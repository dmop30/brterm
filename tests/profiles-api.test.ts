import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createContext, type ServerContext } from '../src/server/context.js';
import { createApp } from '../src/server/index.js';
import type { Profile } from '../src/shared/types.js';

interface Started {
  url: string;
  context: ServerContext;
  headers: Record<string, string>;
  close(): void;
}

const started: Started[] = [];

async function start(): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-profile-'));
  const context = createContext(dir);
  const app = createApp({ context, devMode: false, origins: ['http://127.0.0.1:7781'] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const { port } = server.address() as AddressInfo;
  const instance: Started = {
    url: `http://127.0.0.1:${port}`,
    context,
    headers: { authorization: `Bearer ${context.token}`, 'content-type': 'application/json' },
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

async function createProfile(instance: Started, body: Record<string, unknown>): Promise<Profile> {
  const response = await fetch(`${instance.url}/api/profiles`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify(body),
  });
  return ((await response.json()) as { profile: Profile }).profile;
}

async function createHost(instance: Started, body: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ label: 'web-01', hostname: '10.0.0.1', username: 'ops', ...body }),
  });
  return ((await response.json()) as { host: { id: string } }).host.id;
}

test('プロファイルを直せる（文字コード・TERM・環境変数・接続時コマンド）', async () => {
  const instance = await start();
  const profile = await createProfile(instance, { label: '検証用' });
  const response = await fetch(`${instance.url}/api/profiles/${profile.id}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({
      label: '本番用',
      encoding: 'shift_jis',
      term: 'xterm',
      env: { LANG: 'ja_JP.UTF-8', BAD: 1 },
      onConnect: ['cd /var/log', '  ', 'ls'],
    }),
  });
  const body = (await response.json()) as { profile: Profile };
  assert.equal(body.profile.label, '本番用');
  assert.equal(body.profile.encoding, 'shift_jis');
  assert.equal(body.profile.term, 'xterm');
  // 文字列でない環境変数は捨てる（そのまま渡すと接続時に落ちる）
  assert.deepEqual(body.profile.env, { LANG: 'ja_JP.UTF-8' });
  // 空のコマンドは捨てる
  assert.deepEqual(body.profile.onConnect, ['cd /var/log', 'ls']);
});

test('知らない文字コードは受け付けず、元のまま', async () => {
  const instance = await start();
  const profile = await createProfile(instance, { label: '検証用', encoding: 'shift_jis' });
  const response = await fetch(`${instance.url}/api/profiles/${profile.id}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ encoding: 'latin-1' }),
  });
  const body = (await response.json()) as { profile: Profile };
  assert.equal(body.profile.encoding, 'shift_jis');
});

test('接続先にプロファイルを紐付けられる。空文字で既定へ戻る', async () => {
  const instance = await start();
  const profile = await createProfile(instance, { label: '検証用' });
  const hostId = await createHost(instance);

  const bound = await fetch(`${instance.url}/api/hosts/${hostId}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ profileId: profile.id }),
  });
  const first = (await bound.json()) as { host: { profileId?: string } };
  assert.equal(first.host.profileId, profile.id);

  const cleared = await fetch(`${instance.url}/api/hosts/${hostId}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ profileId: '' }),
  });
  const second = (await cleared.json()) as { host: { profileId?: string } };
  assert.equal(second.host.profileId, undefined);
});

test('無いプロファイルは紐付けさせない', async () => {
  const instance = await start();
  const hostId = await createHost(instance);
  const response = await fetch(`${instance.url}/api/hosts/${hostId}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ profileId: 'いない' }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'profile_not_found');
});

test('登録のときも、無いプロファイルは断る', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({
      label: 'a',
      hostname: 'a',
      username: 'a',
      profileId: 'いない',
    }),
  });
  assert.equal(response.status, 400);
  // 断ったのなら、増やしてもいけない
  assert.equal(instance.context.db.hosts.length, 0);
});

test('プロファイルを消すと、使っていた接続先は既定へ戻る', async () => {
  const instance = await start();
  const profile = await createProfile(instance, { label: '消す方' });
  const hostId = await createHost(instance, { profileId: profile.id });

  const response = await fetch(`${instance.url}/api/profiles/${profile.id}`, {
    method: 'DELETE',
    headers: instance.headers,
  });
  const body = (await response.json()) as { removed: boolean; detached: number };
  assert.equal(body.removed, true);
  assert.equal(body.detached, 1);
  // 迷子の参照を残さない
  const host = instance.context.db.hosts.find((entry) => entry.id === hostId);
  assert.equal(host?.profileId, undefined);
});

test('既定のプロファイルは消せない', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/profiles/default`, {
    method: 'DELETE',
    headers: instance.headers,
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'profile_protected');
  assert.match(body.error.message, /既定/);
  assert.equal(instance.context.db.profiles.length, 1);
});

test('無いプロファイルの操作は 404', async () => {
  const instance = await start();
  const patched = await fetch(`${instance.url}/api/profiles/いない`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ label: 'x' }),
  });
  assert.equal(patched.status, 404);
  const removed = await fetch(`${instance.url}/api/profiles/いない`, {
    method: 'DELETE',
    headers: instance.headers,
  });
  assert.equal(removed.status, 404);
});

test('直したプロファイルは保存ファイルに残る', async () => {
  const instance = await start();
  const profile = await createProfile(instance, { label: '検証用' });
  await fetch(`${instance.url}/api/profiles/${profile.id}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ onConnect: ['cd /srv'] }),
  });
  const reloaded = createContext(instance.context.dir);
  const stored = reloaded.db.profiles.find((entry) => entry.id === profile.id);
  assert.deepEqual(stored?.onConnect, ['cd /srv']);
});
