import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import ssh2, { type Connection, type Server as SshServerType } from 'ssh2';

import { createContext, type ServerContext } from '../src/server/context.js';
import { seal } from '../src/server/crypto.js';
import { createApp } from '../src/server/index.js';
import { connect, SessionManager } from '../src/server/ssh.js';
import { defaultProfile } from '../src/server/store.js';
import type { Host } from '../src/shared/types.js';

const { Server, utils } = ssh2;
const hostKeyPair = utils.generateKeyPairSync('ed25519');

interface Started {
  url: string;
  context: ServerContext;
  headers: Record<string, string>;
  keysDir: string;
  sshConfigPath: string;
  manager: SessionManager;
  close(): void;
}

const started: Started[] = [];
const sshServers: SshServerType[] = [];

async function start(): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-keysapi-'));
  const context = createContext(dir);
  const manager = new SessionManager();
  const keysDir = join(dir, 'keys');
  const sshConfigPath = join(dir, 'ssh', 'config');
  const app = createApp({
    context,
    manager,
    keysDir,
    sshConfigPath,
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
    keysDir,
    sshConfigPath,
    manager,
    close: () => server.close(),
  };
  started.push(instance);
  return instance;
}

after(() => {
  for (const instance of started) {
    instance.manager.closeAll();
    instance.close();
  }
  for (const server of sshServers) {
    server.close();
  }
});

test('鍵を作ると、秘密鍵は 600 で置かれ、中身は返らない', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ name: 'id_brterm', type: 'ed25519', comment: 'ops@brterm' }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { key: Record<string, unknown> };
  assert.match(String(body.key.publicKey), /^ssh-ed25519 /);
  assert.match(String(body.key.fingerprint), /^SHA256:/);
  // **秘密鍵の中身は返さない**
  assert.equal('privateKey' in body.key, false);
  assert.equal(statSync(String(body.key.privateKeyPath)).mode & 0o777, 0o600);
});

test('同じ名前では作り直せない（上書きすると入れなくなる）', async () => {
  const instance = await start();
  const payload = JSON.stringify({ name: 'id_brterm' });
  await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: payload,
  });
  const again = await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: payload,
  });
  assert.equal(again.status, 409);
  const body = (await again.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'key_exists');
});

test('鍵長が短すぎれば断る', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ name: 'id_short', type: 'rsa', bits: 1024 }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'key_invalid_bits');
  assert.equal(existsSync(join(instance.keysDir, 'id_short')), false, '断ったのに作られた');
});

test('作った鍵は一覧に出る', async () => {
  const instance = await start();
  await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ name: 'id_one' }),
  });
  const response = await fetch(`${instance.url}/api/keys`, { headers: instance.headers });
  const body = (await response.json()) as { keys: { name: string; fingerprint: string }[] };
  assert.deepEqual(
    body.keys.map((key) => key.name),
    ['id_one'],
  );
  assert.match(body.keys[0]?.fingerprint ?? '', /^SHA256:/);
});

test('繋いでいない接続先には鍵を置かせない', async () => {
  const instance = await start();
  await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ name: 'id_one' }),
  });
  const hostResponse = await fetch(`${instance.url}/api/hosts`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ label: 'web-01', hostname: '10.0.0.1', username: 'ops' }),
  });
  const { host } = (await hostResponse.json()) as { host: { id: string } };

  const response = await fetch(`${instance.url}/api/keys/id_one/install`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ hostId: host.id }),
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'ssh_no_session');
  // 文言に接続先の名前が入っていること
  assert.match(body.error.message, /web-01/);
});

/** 受け取った exec のコマンドを控える試験用 SSH サーバ。 */
async function startExecSsh(record: { commands: string[] }, exitCode = 0): Promise<number> {
  const server = new Server({ hostKeys: [hostKeyPair.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('pty', (ptyAccept) => ptyAccept?.());
        session.on('shell', (shellAccept) => {
          const stream = shellAccept();
          stream.write(Buffer.from('$ ', 'utf8'));
        });
        session.on('exec', (execAccept, _reject, info) => {
          record.commands.push(info.command);
          const stream = execAccept();
          if (exitCode !== 0) {
            stream.stderr.write('権限がありません');
          }
          stream.exit(exitCode);
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

async function openSession(instance: Started, sshPort: number): Promise<string> {
  const host: Host = {
    id: 'h1',
    label: 'web-01',
    hostname: '127.0.0.1',
    port: sshPort,
    username: 'ops',
    authMethod: 'password',
    password: seal(instance.context.key, 'secret'),
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
  instance.context.db.hosts.push(host);
  instance.context.save();
  const session = await connect({
    host,
    profile: defaultProfile(),
    password: 'secret',
    known: [],
    onUnknownHostKey: () => Promise.resolve(true),
  });
  instance.manager.add(session);
  return host.id;
}

test('繋いでいる接続先へは鍵を置ける。同じ鍵を二重に足さない形で流す', async () => {
  const instance = await start();
  const created = await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ name: 'id_one', comment: 'ops@brterm' }),
  });
  const { key } = (await created.json()) as { key: { publicKey: string; fingerprint: string } };

  const record = { commands: [] as string[] };
  const hostId = await openSession(instance, await startExecSsh(record));

  const response = await fetch(`${instance.url}/api/keys/id_one/install`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ hostId }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { installed: boolean; fingerprint: string };
  assert.equal(body.installed, true);
  assert.equal(body.fingerprint, key.fingerprint);

  const command = record.commands[0] ?? '';
  assert.match(command, /authorized_keys/);
  assert.match(command, /grep -qxF/);
  assert.ok(command.includes(key.publicKey.trim()), '公開鍵が流れていない');
});

test('置けなかったら、そのことを返す（黙って成功にしない）', async () => {
  const instance = await start();
  await fetch(`${instance.url}/api/keys`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ name: 'id_one' }),
  });
  const record = { commands: [] as string[] };
  const hostId = await openSession(instance, await startExecSsh(record, 1));

  const response = await fetch(`${instance.url}/api/keys/id_one/install`, {
    method: 'POST',
    headers: instance.headers,
    body: JSON.stringify({ hostId }),
  });
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'key_install_failed');
  assert.match(body.error.message, /web-01/);
});

test('ssh config は無ければ空として読める', async () => {
  const instance = await start();
  const response = await fetch(`${instance.url}/api/ssh-config`, { headers: instance.headers });
  const body = (await response.json()) as { hosts: unknown[]; text: string };
  assert.deepEqual(body.hosts, []);
  assert.equal(body.text, '');
});

test('ssh config に Host を足せて、手で書いた記述は残る', async () => {
  const instance = await start();
  await fetch(`${instance.url}/api/ssh-config/hosts/web-01`, {
    method: 'PUT',
    headers: instance.headers,
    body: JSON.stringify({ hostName: '10.0.0.1', user: 'ops', port: 2222 }),
  });
  await fetch(`${instance.url}/api/ssh-config/hosts/bastion`, {
    method: 'PUT',
    headers: instance.headers,
    body: JSON.stringify({ hostName: '203.0.113.1' }),
  });
  const response = await fetch(`${instance.url}/api/ssh-config/hosts/web-01`, {
    method: 'PUT',
    headers: instance.headers,
    body: JSON.stringify({ hostName: '10.0.0.9', identityFile: '~/.brterm/keys/id_one' }),
  });
  const body = (await response.json()) as {
    hosts: { patterns: string[]; options: Record<string, string> }[];
  };
  assert.deepEqual(
    body.hosts.map((host) => host.patterns[0]),
    ['web-01', 'bastion'],
  );
  const target = body.hosts[0];
  assert.equal(target?.options.HostName, '10.0.0.9');
  assert.equal(target?.options.IdentityFile, '~/.brterm/keys/id_one');
  // 書いたものは 600 で残る
  assert.equal(statSync(instance.sshConfigPath).mode & 0o777, 0o600);
  assert.match(readFileSync(instance.sshConfigPath, 'utf8'), /Host bastion/);
});

test('Host の名前がおかしければ断る', async () => {
  const instance = await start();
  const response = await fetch(
    `${instance.url}/api/ssh-config/hosts/${encodeURIComponent('a b')}`,
    {
      method: 'PUT',
      headers: instance.headers,
      body: JSON.stringify({ hostName: '10.0.0.1' }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(existsSync(instance.sshConfigPath), false, '断ったのに書いた');
});
