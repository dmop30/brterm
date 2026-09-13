import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import ssh2, { type Connection, type Server as SshServerType } from 'ssh2';

import { isAppError } from '../src/server/errors.js';
import { generateKey, writeKey } from '../src/server/keys.js';
import { secretsFor } from '../src/server/secrets.js';
import { connect, SessionManager } from '../src/server/ssh.js';
import { defaultProfile } from '../src/server/store.js';
import { createContext } from '../src/server/context.js';
import type { Host } from '../src/shared/types.js';

const { Server, utils } = ssh2;
const hostKeyPair = utils.generateKeyPairSync('ed25519');

const servers: SshServerType[] = [];
const managers: SessionManager[] = [];

/** 置いた公開鍵だけを通す試験用 SSH サーバ（`authorized_keys` の代わり）。 */
async function startKeyOnlySsh(authorizedPublicKey: string): Promise<number> {
  const allowed = utils.parseKey(authorizedPublicKey);
  assert.equal(allowed instanceof Error, false, '公開鍵を読めない');
  const allowedKey = allowed as ssh2.ParsedKey;

  const server = new Server({ hostKeys: [hostKeyPair.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') {
        ctx.reject(['publickey']);
        return;
      }
      if (
        ctx.key.algo !== allowedKey.type ||
        !ctx.key.data.equals(allowedKey.getPublicSSH()) ||
        (ctx.signature && !allowedKey.verify(ctx.blob as Buffer, ctx.signature, ctx.key.algo))
      ) {
        ctx.reject();
        return;
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('pty', (ptyAccept) => ptyAccept?.());
        session.once('shell', (shellAccept) => {
          const stream = shellAccept();
          stream.write(Buffer.from('鍵で入れました\r\n$ ', 'utf8'));
        });
      });
    });
    client.on('error', () => {
      /* 試験中の切断は無視 */
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

after(() => {
  for (const manager of managers) {
    manager.closeAll();
  }
  for (const server of servers) {
    server.close();
  }
});

function hostFor(port: number, privateKeyPath: string): Host {
  return {
    id: 'h1',
    label: 'web-01',
    hostname: '127.0.0.1',
    port,
    username: 'ops',
    authMethod: 'key',
    privateKeyPath,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
}

test('作った鍵を置いた接続先へ、その鍵で繋げる', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-keyconn-'));
  const written = writeKey(dir, 'id_brterm', generateKey({ type: 'ed25519', comment: 'brterm' }));
  const port = await startKeyOnlySsh(written.publicKey);

  const context = createContext(mkdtempSync(join(tmpdir(), 'brterm-keyctx-')));
  const host = hostFor(port, written.privateKeyPath);
  const session = await connect({
    host,
    profile: defaultProfile(),
    ...secretsFor(context.key, host),
    known: [],
    onUnknownHostKey: () => Promise.resolve(true),
  });
  const manager = new SessionManager();
  managers.push(manager);
  manager.add(session);

  assert.match(session.hostKey.fingerprint, /^SHA256:/);
  assert.equal(session.isClosed, false);
});

test('別の鍵では入れない（鍵の検査が効いていることの裏取り）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-keyconn-'));
  const allowed = writeKey(dir, 'id_ok', generateKey({ type: 'ed25519' }));
  const other = writeKey(dir, 'id_ng', generateKey({ type: 'ed25519' }));
  const port = await startKeyOnlySsh(allowed.publicKey);

  const context = createContext(mkdtempSync(join(tmpdir(), 'brterm-keyctx-')));
  const host = hostFor(port, other.privateKeyPath);
  await assert.rejects(
    connect({
      host,
      profile: defaultProfile(),
      ...secretsFor(context.key, host),
      known: [],
      onUnknownHostKey: () => Promise.resolve(true),
    }),
    (error: unknown) => isAppError(error) && error.code === 'ssh_auth_failed',
  );
});

test('秘密鍵が無ければ、繋ぎに行く前に理由を出して止める', () => {
  const context = createContext(mkdtempSync(join(tmpdir(), 'brterm-keyctx-')));
  const host = hostFor(22, '/いない/id_rsa');
  assert.throws(
    () => secretsFor(context.key, host),
    (error: unknown) =>
      isAppError(error) && error.code === 'key_unreadable' && /ありません/.test(error.message),
  );
});

test('鍵認証なのに鍵の場所が無ければ止める', () => {
  const context = createContext(mkdtempSync(join(tmpdir(), 'brterm-keyctx-')));
  const host = hostFor(22, '');
  delete host.privateKeyPath;
  assert.throws(
    () => secretsFor(context.key, host),
    (error: unknown) => isAppError(error) && error.code === 'key_unreadable',
  );
});
