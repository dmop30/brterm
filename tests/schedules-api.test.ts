import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import ssh2, { type Connection, type Server as SshServerType } from 'ssh2';

import { createContext, type ServerContext } from '../src/server/context.js';
import { seal } from '../src/server/crypto.js';
import { isAppError } from '../src/server/errors.js';
import { createApp } from '../src/server/index.js';
import { createSshExecutor, type Executor } from '../src/server/scheduler.js';
import type { Host, Schedule } from '../src/shared/types.js';

const { Server, utils } = ssh2;
const hostKeyPair = utils.generateKeyPairSync('ed25519');

interface Started {
  url: string;
  context: ServerContext;
  headers: Record<string, string>;
  logsDir: string;
  record: { commands: string[] };
  close(): void;
}

const started: Started[] = [];
const sshServers: SshServerType[] = [];

async function start(executor?: Executor): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-sched-'));
  const context = createContext(dir);
  const logsDir = join(dir, 'logs');
  const record = { commands: [] as string[] };
  const app = createApp({
    context,
    logsDir,
    executor:
      executor ??
      ((_db, schedule) => {
        record.commands.push(...schedule.commands);
        return Promise.resolve({
          results: schedule.commands.map((command) => ({
            command,
            code: 0,
            stdout: 'ok\n',
            stderr: '',
          })),
        });
      }),
    devMode: false,
    origins: ['http://127.0.0.1:7781'],
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const { port } = server.address() as AddressInfo;
  const instance: Started = {
    url: `http://127.0.0.1:${port}`,
    context,
    headers: { authorization: `Bearer ${context.token}`, 'content-type': 'application/json' },
    logsDir,
    record,
    close: () => server.close(),
  };
  started.push(instance);
  return instance;
}

after(() => {
  for (const instance of started) {
    instance.close();
  }
  for (const server of sshServers) {
    server.close();
  }
});

function addHost(instance: Started, port = 22): Host {
  const host: Host = {
    id: 'h1',
    label: 'web-01',
    hostname: '127.0.0.1',
    port,
    username: 'ops',
    authMethod: 'password',
    password: seal(instance.context.key, 'secret'),
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
  instance.context.db.hosts.push(host);
  instance.context.save();
  return host;
}

async function createSchedule(
  instance: Started,
  body: Record<string, unknown> = {},
): Promise<Schedule & { nextRunAt?: string }> {
  const response = await fetch(`${instance.url}/api/schedules`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({
      label: 'ログの後始末',
      hostId: 'h1',
      cron: '0 3 * * *',
      commands: ['find /var/log -name "*.gz" -mtime +30'],
      ...body,
    }),
  });
  return ((await response.json()) as { schedule: Schedule & { nextRunAt?: string } }).schedule;
}

test('予定を作ると、止まった状態で始まる（作った瞬間に流れない）', async () => {
  const instance = await start();
  addHost(instance);
  const schedule = await createSchedule(instance);
  assert.equal(schedule.enabled, false);
  // 止まっているあいだは次回時刻を出さない
  assert.equal(schedule.nextRunAt, undefined);
});

test('動かす指定にすると、次回実行時刻が出る', async () => {
  const instance = await start();
  addHost(instance);
  const created = await createSchedule(instance, { enabled: true });
  assert.ok(created.nextRunAt, '次回時刻が出ていない');
  assert.match(created.nextRunAt ?? '', /T03:00:00/);
});

test('予定の書き方がおかしければ断る', async () => {
  const instance = await start();
  addHost(instance);
  const response = await fetch(`${instance.url}/api/schedules`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({
      label: 'x',
      hostId: 'h1',
      cron: 'おかしい',
      commands: ['uptime'],
    }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'schedule_invalid_cron');
  assert.equal(instance.context.db.schedules.length, 0, '断ったのに作られた');
});

test('無い接続先には予定を作らせない', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/schedules`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ label: 'x', hostId: 'いない', cron: '0 3 * * *', commands: ['uptime'] }),
  });
  assert.equal(response.status, 404);
});

test('コマンドが空の予定は作らせない', async () => {
  const instance = await start();
  addHost(instance);
  const response = await fetch(`${instance.url}/api/schedules`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ label: 'x', hostId: 'h1', cron: '0 3 * * *', commands: ['  '] }),
  });
  assert.equal(response.status, 400);
});

test('予定を直せる。おかしい書き方には変えさせない', async () => {
  const instance = await start();
  addHost(instance);
  const schedule = await createSchedule(instance);

  const patched = await fetch(`${instance.url}/api/schedules/${schedule.id}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ cron: '30 4 * * *', enabled: true }),
  });
  const body = (await patched.json()) as { schedule: Schedule & { nextRunAt?: string } };
  assert.equal(body.schedule.cron, '30 4 * * *');
  assert.match(body.schedule.nextRunAt ?? '', /T04:30:00/);

  const rejected = await fetch(`${instance.url}/api/schedules/${schedule.id}`, {
    method: 'PATCH',
    headers: instance.headers,
    body: JSON.stringify({ cron: 'だめ' }),
  });
  assert.equal(rejected.status, 400);
  // 断ったのなら、元の指定のまま
  assert.equal(instance.context.db.schedules[0]?.cron, '30 4 * * *');
});

test('予定を消せる', async () => {
  const instance = await start();
  addHost(instance);
  const schedule = await createSchedule(instance);
  const removed = await fetch(`${instance.url}/api/schedules/${schedule.id}`, {
    method: 'DELETE',
    headers: instance.headers,
  });
  assert.equal(removed.status, 200);
  assert.equal(instance.context.db.schedules.length, 0);
});

test('今すぐ流せて、結果がログに残る', async () => {
  const instance = await start();
  addHost(instance);
  const schedule = await createSchedule(instance, { commands: ['uptime'] });

  const response = await fetch(`${instance.url}/api/schedules/${schedule.id}/run`, {
    method: 'POST',
    headers: instance.headers,
  });
  const body = (await response.json()) as { status: string; schedule: Schedule };
  assert.equal(body.status, 'ok');
  assert.equal(body.schedule.lastStatus, 'ok');
  assert.ok(body.schedule.lastRunAt);
  assert.deepEqual(instance.record.commands, ['uptime']);

  const log = await (
    await fetch(`${instance.url}/api/schedules/${schedule.id}/log`, { headers: instance.headers })
  ).text();
  assert.match(log, /\[実行\] uptime 終了コード=0/);
  assert.match(log, /\[終了\] 成功/);
});

test('実行の記録は保存ファイルに残る', async () => {
  const instance = await start();
  addHost(instance);
  const schedule = await createSchedule(instance);
  await fetch(`${instance.url}/api/schedules/${schedule.id}/run`, {
    method: 'POST',
    headers: instance.headers,
  });
  const reloaded = createContext(instance.context.dir);
  assert.equal(reloaded.db.schedules[0]?.lastStatus, 'ok');
});

/** 予定実行のための試験用 SSH サーバ（exec だけ受ける）。 */
async function startExecSsh(record: { commands: string[] }): Promise<number> {
  const server = new Server({ hostKeys: [hostKeyPair.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('pty', (ptyAccept) => ptyAccept?.());
        session.on('shell', (shellAccept) => shellAccept().write(Buffer.from('$ ', 'utf8')));
        session.on('exec', (execAccept, _reject, info) => {
          record.commands.push(info.command);
          const stream = execAccept();
          stream.write(Buffer.from('実行しました\n', 'utf8'));
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on('error', () => {
      /* 試験中の切断は無視 */
    });
  });
  sshServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

test('本物の SSH でも流せる（既知のホスト鍵のとき）', async () => {
  const instance = await start();
  const record = { commands: [] as string[] };
  const port = await startExecSsh(record);
  const host = addHost(instance, port);

  // 端末で一度確認した鍵として登録しておく
  const executor = createSshExecutor(instance.context.key);
  const session = await import('../src/server/ssh.js').then((module) =>
    module.connect({
      host,
      profile: instance.context.db.profiles[0]!,
      password: 'secret',
      known: [],
      onUnknownHostKey: () => Promise.resolve(true),
    }),
  );
  instance.context.db.knownHostKeys.push({
    hostname: host.hostname,
    port: host.port,
    keyType: 'ssh',
    fingerprint: session.hostKey.fingerprint,
    addedAt: '2026-09-13T00:00:00.000Z',
  });
  session.close();

  const schedule: Schedule = {
    id: 's1',
    label: 'ログの後始末',
    hostId: host.id,
    cron: '0 3 * * *',
    commands: ['uptime', 'df -h'],
    enabled: true,
  };
  const { results } = await executor(instance.context.db, schedule);
  assert.deepEqual(record.commands, ['uptime', 'df -h']);
  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0],
  );
  assert.match(results[0]?.stdout ?? '', /実行しました/);
});

test('ホスト鍵が未確認の接続先では流さない（黙って受け入れない）', async () => {
  const instance = await start();
  const record = { commands: [] as string[] };
  const port = await startExecSsh(record);
  const host = addHost(instance, port);
  const executor = createSshExecutor(instance.context.key);

  await assert.rejects(
    executor(instance.context.db, {
      id: 's1',
      label: 'x',
      hostId: host.id,
      cron: '0 3 * * *',
      commands: ['uptime'],
      enabled: true,
    }),
    (error: unknown) => isAppError(error) && error.code === 'ssh_host_key_rejected',
  );
  assert.deepEqual(record.commands, [], '未確認の鍵なのに流した');
});
