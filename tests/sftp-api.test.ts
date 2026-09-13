import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createContext } from '../src/server/context.js';
import { seal } from '../src/server/crypto.js';
import { createApp } from '../src/server/index.js';
import { connect, SessionManager, type Session } from '../src/server/ssh.js';
import type { Host, SftpListResponse } from '../src/shared/types.js';
import { startSshServer, stopAll } from './helpers/ssh-harness.js';

/** API 越しに SFTP を触る。接続中のセッションに相乗りする形を、そのまま確かめる。 */
interface Harness {
  url: string;
  token: string;
  hostId: string;
  root: string;
  close(): void;
}

const started: Harness[] = [];
const sessions: Session[] = [];

function sampleTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'brterm-sftp-api-'));
  mkdirSync(join(root, 'etc'));
  writeFileSync(join(root, 'etc', 'hosts'), '127.0.0.1 localhost\n');
  return root;
}

async function start(options: { connected: boolean }): Promise<Harness> {
  const root = sampleTree();
  const sshPort = await startSshServer({ sftpRoot: root });
  const dir = mkdtempSync(join(tmpdir(), 'brterm-api-sftp-'));
  const context = createContext(dir);
  const host: Host = {
    id: 'h1',
    label: 'test',
    hostname: '127.0.0.1',
    port: sshPort,
    username: 'ops',
    authMethod: 'password',
    password: seal(context.key, 'secret'),
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
  context.db.hosts.push(host);
  context.save();

  const sessions_ = new SessionManager();
  if (options.connected) {
    const session = await connect({
      host,
      profile: context.db.profiles[0]!,
      password: 'secret',
      known: [],
      onUnknownHostKey: () => true,
    });
    sessions.push(session);
    sessions_.add(session);
  }

  const app = createApp({ context, sessions: sessions_, origins: ['http://127.0.0.1:7781'] });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const harness: Harness = {
    url: `http://127.0.0.1:${port}`,
    token: context.token,
    hostId: host.id,
    root,
    close: () => server.close(),
  };
  started.push(harness);
  return harness;
}

function auth(harness: Harness, json = false): Record<string, string> {
  return json
    ? { authorization: `Bearer ${harness.token}`, 'content-type': 'application/json' }
    : { authorization: `Bearer ${harness.token}` };
}

after(() => {
  for (const session of sessions) {
    session.close();
  }
  sessions.length = 0;
  for (const harness of started) {
    harness.close();
  }
  started.length = 0;
  stopAll();
});

test('繋がっていなければ、理由を出して断る（勝手に接続しない）', async () => {
  const harness = await start({ connected: false });
  const response = await fetch(`${harness.url}/api/sftp/list?hostId=${harness.hostId}&path=/etc`, {
    headers: auth(harness),
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'ssh_no_session');
  assert.match(body.error.message, /端末を開いて接続/);
});

test('一覧が API 越しに取れる', async () => {
  const harness = await start({ connected: true });
  const response = await fetch(`${harness.url}/api/sftp/list?hostId=${harness.hostId}&path=/etc`, {
    headers: auth(harness),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as SftpListResponse;
  assert.deepEqual(
    body.entries.map((entry) => entry.name),
    ['hosts'],
  );
});

test('置く・取るが往復する', async () => {
  const harness = await start({ connected: true });
  const uploaded = await fetch(
    `${harness.url}/api/sftp/upload?hostId=${harness.hostId}&path=/etc&name=memo.txt`,
    {
      method: 'POST',
      headers: { ...auth(harness), 'content-type': 'application/octet-stream' },
      body: Buffer.from('日本語のメモ\n', 'utf8'),
    },
  );
  assert.equal(uploaded.status, 201);
  assert.equal(readFileSync(join(harness.root, 'etc', 'memo.txt'), 'utf8'), '日本語のメモ\n');

  const downloaded = await fetch(
    `${harness.url}/api/sftp/download?hostId=${harness.hostId}&path=/etc/memo.txt`,
    { headers: auth(harness) },
  );
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), '日本語のメモ\n');
});

test('作成・改名・削除が API 越しに効く', async () => {
  const harness = await start({ connected: true });
  const post = (path: string, body: unknown) =>
    fetch(`${harness.url}/api/sftp/${path}`, {
      method: 'POST',
      headers: auth(harness, true),
      body: JSON.stringify({ hostId: harness.hostId, ...(body as object) }),
    });

  assert.equal((await post('mkdir', { path: '/etc/conf.d' })).status, 201);
  assert.equal((await post('create', { path: '/etc/conf.d/site.conf' })).status, 201);
  assert.equal(
    (await post('rename', { from: '/etc/conf.d/site.conf', to: '/etc/conf.d/web.conf' })).status,
    200,
  );
  assert.equal((await post('remove', { path: '/etc/conf.d', recursive: true })).status, 204);

  const listed = (await (
    await fetch(`${harness.url}/api/sftp/list?hostId=${harness.hostId}&path=/etc`, {
      headers: auth(harness),
    })
  ).json()) as SftpListResponse;
  assert.equal(
    listed.entries.some((entry) => entry.name === 'conf.d'),
    false,
  );
});

test('SFTP もトークン無しでは触れない', async () => {
  const harness = await start({ connected: true });
  const response = await fetch(`${harness.url}/api/sftp/list?hostId=${harness.hostId}&path=/etc`);
  assert.equal(response.status, 401);
});
