import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createContext, type ServerContext } from '../src/server/context.js';
import { recordCommand } from '../src/server/history.js';
import { createApp } from '../src/server/index.js';
import type { Procedure } from '../src/shared/types.js';

interface Started {
  url: string;
  context: ServerContext;
  headers: Record<string, string>;
  close(): void;
}

const started: Started[] = [];

async function start(): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-proc-'));
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

/** 履歴を仕込む。端末を通さずに API だけ確かめるため。 */
function seedHistory(instance: Started, commands: string[]): void {
  for (const command of commands) {
    recordCommand(instance.context.db, { hostId: 'h1', command });
  }
  instance.context.save();
}

test('履歴は新しい順に返る', async () => {
  const instance = await start();
  seedHistory(instance, ['first', 'second']);
  const response = await fetch(`${instance.url}/api/history`, { headers: instance.headers });
  const body = (await response.json()) as { history: { command: string }[] };
  assert.deepEqual(
    body.history.map((entry) => entry.command),
    ['second', 'first'],
  );
});

test('件数と接続先で絞れる', async () => {
  const instance = await start();
  seedHistory(instance, ['a', 'b', 'c']);
  recordCommand(instance.context.db, { hostId: 'h2', command: 'other' });
  const limited = await fetch(`${instance.url}/api/history?limit=1`, { headers: instance.headers });
  const first = (await limited.json()) as { history: { command: string }[] };
  assert.deepEqual(
    first.history.map((entry) => entry.command),
    ['other'],
  );

  const byHost = await fetch(`${instance.url}/api/history?hostId=h2`, {
    headers: instance.headers,
  });
  const second = (await byHost.json()) as { history: { command: string }[] };
  assert.deepEqual(
    second.history.map((entry) => entry.command),
    ['other'],
  );
});

test('接続先を指定した削除は、その分だけ消す', async () => {
  const instance = await start();
  seedHistory(instance, ['a', 'b']);
  recordCommand(instance.context.db, { hostId: 'h2', command: 'other' });
  const response = await fetch(`${instance.url}/api/history?hostId=h1`, {
    method: 'DELETE',
    headers: instance.headers,
  });
  const body = (await response.json()) as { removed: number };
  assert.equal(body.removed, 2);
  assert.deepEqual(
    instance.context.db.history.map((entry) => entry.command),
    ['other'],
  );
});

test('保持件数を下げると、その場で溢れた分が消える', async () => {
  const instance = await start();
  seedHistory(instance, ['a', 'b', 'c']);
  await fetch(`${instance.url}/api/settings`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ historyLimit: 1 }),
  });
  assert.deepEqual(
    instance.context.db.history.map((entry) => entry.command),
    ['c'],
  );
});

test('履歴を選んで手順にできる', async () => {
  const instance = await start();
  seedHistory(instance, ['nginx -t', 'systemctl reload nginx', 'df -h']);
  const ids = instance.context.db.history.slice(0, 2).map((entry) => entry.id);

  const created = await fetch(`${instance.url}/api/procedures`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ title: 'nginx の設定を入れ替える', historyIds: ids }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { procedure: Procedure };
  assert.deepEqual(
    body.procedure.steps.map((step) => step.command),
    ['nginx -t', 'systemctl reload nginx'],
  );
});

test('題名が無ければ作らせない', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/procedures`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ title: '  ' }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'invalid_procedure');
  assert.match(body.error.message, /題名/);
});

async function createProcedure(instance: Started, title = '手順'): Promise<Procedure> {
  const response = await fetch(`${instance.url}/api/procedures`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ title, steps: [{ command: 'uptime' }] }),
  });
  return ((await response.json()) as { procedure: Procedure }).procedure;
}

test('ステップを後から足せる', async () => {
  const instance = await start();
  const procedure = await createProcedure(instance);
  const response = await fetch(`${instance.url}/api/procedures/${procedure.id}/steps`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ steps: [{ command: 'df -h', note: '空きを見る' }] }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { procedure: Procedure };
  assert.deepEqual(
    body.procedure.steps.map((step) => step.command),
    ['uptime', 'df -h'],
  );
  assert.equal(body.procedure.steps[1]?.note, '空きを見る');
});

test('中身が無いステップは足させない', async () => {
  const instance = await start();
  const procedure = await createProcedure(instance);
  const response = await fetch(`${instance.url}/api/procedures/${procedure.id}/steps`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ steps: [{ command: '   ' }] }),
  });
  assert.equal(response.status, 400);
});

test('題名を直せる', async () => {
  const instance = await start();
  const procedure = await createProcedure(instance);
  const response = await fetch(`${instance.url}/api/procedures/${procedure.id}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ title: '直した題名' }),
  });
  const body = (await response.json()) as { procedure: Procedure };
  assert.equal(body.procedure.title, '直した題名');
  // ステップを渡していないので、そのまま残る
  assert.equal(body.procedure.steps.length, 1);
});

test('消せる。消えたものは 404', async () => {
  const instance = await start();
  const procedure = await createProcedure(instance);
  const removed = await fetch(`${instance.url}/api/procedures/${procedure.id}`, {
    method: 'DELETE',
    headers: instance.headers,
  });
  assert.equal(removed.status, 200);
  const again = await fetch(`${instance.url}/api/procedures/${procedure.id}`, {
    headers: instance.headers,
  });
  assert.equal(again.status, 404);
  const body = (await again.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'procedure_not_found');
});

test('Markdown で書き出せる', async () => {
  const instance = await start();
  const procedure = await createProcedure(instance, 'サーバの様子を見る');
  const response = await fetch(`${instance.url}/api/procedures/${procedure.id}/markdown`, {
    headers: instance.headers,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
  const markdown = await response.text();
  assert.match(markdown, /^# サーバの様子を見る$/m);
  assert.match(markdown, /```sh\nuptime\n```/);
});

test('接続先を持つ手順は、その名前を書き出しに入れる', async () => {
  const instance = await start();
  const hostResponse = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ label: 'web-01', hostname: '10.0.0.1', username: 'ops' }),
  });
  const { host } = (await hostResponse.json()) as { host: { id: string } };
  const created = await fetch(`${instance.url}/api/procedures`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ title: '再起動', hostId: host.id, steps: [{ command: 'uptime' }] }),
  });
  const { procedure } = (await created.json()) as { procedure: Procedure };
  const markdown = await (
    await fetch(`${instance.url}/api/procedures/${procedure.id}/markdown`, {
      headers: instance.headers,
    })
  ).text();
  assert.match(markdown, /- 接続先: web-01/);
});
