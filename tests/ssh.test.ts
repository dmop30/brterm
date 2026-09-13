import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

import ssh2, { type Connection, type Server as ServerType } from 'ssh2';

// ssh2 は CommonJS なので、名前付き import では Server を取り出せないものがある。
const { Server, utils } = ssh2;

import { AppError } from '../src/server/errors.js';
import { connect, SessionManager, type Session } from '../src/server/ssh.js';
import type { Host, KnownHostKey, Profile } from '../src/shared/types.js';

/**
 * 試験用の SSH サーバ。ssh2 にサーバ実装が入っているので、
 * **実際に接続して**確かめる（接続しない試験では認証や鍵の扱いを検証できない）。
 */
const keyPair = utils.generateKeyPairSync('ed25519');
const servers: ServerType[] = [];
const sessions: Session[] = [];

async function startServer(): Promise<number> {
  const server = new Server({ hostKeys: [keyPair.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'ops' && ctx.password === 'secret') {
        ctx.accept();
        return;
      }
      if (ctx.method === 'none') {
        ctx.reject(['password']);
        return;
      }
      ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('pty', (ptyAccept) => ptyAccept?.());
        session.once('shell', (shellAccept) => {
          const stream = shellAccept();
          stream.write('ようこそ\r\nops@test:~$ ');
          // 打った文字をそのまま返す（端末の折り返しの代わり）
          stream.on('data', (chunk: Buffer) => stream.write(chunk));
        });
        session.once('exec', (execAccept, _reject, info) => {
          const stream = execAccept();
          stream.write(`ran:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on('error', () => {
      /* 試験の途中で切れても落とさない */
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

after(() => {
  for (const session of sessions) {
    session.close();
  }
  for (const server of servers) {
    server.close();
  }
});

function host(port: number, overrides: Partial<Host> = {}): Host {
  return {
    id: 'h1',
    label: 'test',
    hostname: '127.0.0.1',
    port,
    username: 'ops',
    authMethod: 'password',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

const profile: Profile = {
  id: 'default',
  label: '既定',
  encoding: 'utf-8',
  term: 'xterm-256color',
  env: {},
  onConnect: [],
};

function track(session: Session): Session {
  sessions.push(session);
  return session;
}

/** 最初の 1 回だけ鍵を受け入れて、指紋を取る。 */
async function connectAccepting(port: number, known: KnownHostKey[] = []): Promise<Session> {
  return track(
    await connect({
      host: host(port),
      profile,
      password: 'secret',
      known,
      onUnknownHostKey: () => true,
    }),
  );
}

test('未知のホスト鍵は、尋ねる相手がいなければ接続しない', async () => {
  const port = await startServer();
  await assert.rejects(
    connect({ host: host(port), profile, password: 'secret', known: [] }),
    (error: unknown) => error instanceof AppError && error.code === 'ssh_host_key_rejected',
  );
});

test('鍵を受け入れれば接続でき、シェルの出力が届く', async () => {
  const port = await startServer();
  const session = await connectAccepting(port);
  const text = await new Promise<string>((resolve) => {
    let buffer = '';
    session.onData((chunk) => {
      buffer += chunk;
      if (buffer.includes('$ ')) {
        resolve(buffer);
      }
    });
  });
  assert.match(text, /ようこそ/);
  assert.equal(session.hostKey.verdict, 'unknown');
  assert.match(session.hostKey.fingerprint, /^SHA256:/);
});

test('打った文字が端末に届く', async () => {
  const port = await startServer();
  const session = await connectAccepting(port);
  const echoed = new Promise<string>((resolve) => {
    let buffer = '';
    session.onData((chunk) => {
      buffer += chunk;
      if (buffer.includes('ls -la')) {
        resolve(buffer);
      }
    });
  });
  session.write('ls -la');
  assert.match(await echoed, /ls -la/);
});

test('再接続のために直前の表示を戻せる', async () => {
  const port = await startServer();
  const session = await connectAccepting(port);
  await new Promise<void>((resolve) => {
    session.onData((chunk) => {
      if (chunk.includes('$ ')) {
        resolve();
      }
    });
  });
  assert.match(session.snapshot(), /ようこそ/);
});

test('記録した指紋と一致すれば、もう尋ねない', async () => {
  const port = await startServer();
  const first = await connectAccepting(port);
  const known: KnownHostKey[] = [
    {
      hostname: '127.0.0.1',
      port,
      keyType: 'ssh-ed25519',
      fingerprint: first.hostKey.fingerprint,
      addedAt: '2026-09-13T00:00:00.000Z',
    },
  ];
  let asked = false;
  const second = track(
    await connect({
      host: host(port),
      profile,
      password: 'secret',
      known,
      onUnknownHostKey: () => {
        asked = true;
        return true;
      },
    }),
  );
  assert.equal(asked, false);
  assert.equal(second.hostKey.verdict, 'match');
});

test('指紋が変わっていたら接続しない（推測で続行しない）', async () => {
  const port = await startServer();
  const known: KnownHostKey[] = [
    {
      hostname: '127.0.0.1',
      port,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:ちがう指紋',
      addedAt: '2026-09-13T00:00:00.000Z',
    },
  ];
  await assert.rejects(
    connect({ host: host(port), profile, password: 'secret', known, onUnknownHostKey: () => true }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'ssh_host_key_changed' &&
      error.message.includes('127.0.0.1'),
  );
});

test('利用者が鍵を受け入れなければ接続しない', async () => {
  const port = await startServer();
  await assert.rejects(
    connect({
      host: host(port),
      profile,
      password: 'secret',
      known: [],
      onUnknownHostKey: () => false,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'ssh_host_key_rejected',
  );
});

test('パスワードが違えば、認証の失敗として分かる', async () => {
  const port = await startServer();
  await assert.rejects(
    connect({
      host: host(port),
      profile,
      password: 'wrong',
      known: [],
      onUnknownHostKey: () => true,
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'ssh_auth_failed' && /認証/.test(error.message),
  );
});

test('繋がらない相手は、到達不能として分かる', async () => {
  // 待ち受けていないポート
  await assert.rejects(
    connect({
      host: host(1, { hostname: '127.0.0.1' }),
      profile,
      password: 'secret',
      known: [],
      onUnknownHostKey: () => true,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'ssh_unreachable',
  );
});

test('閉じたセッションには書き込めない', async () => {
  const port = await startServer();
  const session = await connectAccepting(port);
  session.close();
  assert.throws(
    () => session.write('ls'),
    (error: unknown) => error instanceof AppError && error.code === 'ssh_no_session',
  );
});

test('台帳は閉じたセッションを持ち続けない', async () => {
  const port = await startServer();
  const manager = new SessionManager();
  const session = manager.add(await connectAccepting(port));
  assert.equal(manager.list().length, 1);
  assert.equal(manager.get(session.id).id, session.id);

  manager.close(session.id);
  assert.equal(manager.list().length, 0);
  assert.throws(
    () => manager.get(session.id),
    (error: unknown) => error instanceof AppError && error.code === 'ssh_no_session',
  );
});
