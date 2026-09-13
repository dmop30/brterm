/**
 * 試験用の一式: SSH サーバ + brterm の WebSocket。
 *
 * ssh2 にサーバ実装が入っているので、**実際に接続して**確かめる。
 * 2 つの試験ファイルから使うため、ここに切り出してある。
 */
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ssh2, { type Connection, type Server as SshServerType } from 'ssh2';

import { serveSftp } from './sftp-server.js';

import { createContext } from '../../src/server/context.js';
import { seal } from '../../src/server/crypto.js';
import { SessionManager } from '../../src/server/ssh.js';
import { attachWebSocketServer } from '../../src/server/ws.js';
import type { Encoding, Host } from '../../src/shared/types.js';

const { Server, utils } = ssh2;
const keyPair = utils.generateKeyPairSync('ed25519');

const sshServers: SshServerType[] = [];
const httpServers: HttpServer[] = [];
const managers: SessionManager[] = [];

/**
 * 打った文字をそのまま返し、最初に挨拶を出す SSH サーバ。
 * `sftpRoot` を渡すと、そのディレクトリを SFTP で読み書きさせる。
 */
export async function startSshServer(
  options: { greeting?: Buffer; sftpRoot?: string } = {},
): Promise<number> {
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
          stream.write(options.greeting ?? Buffer.from('ようこそ\r\nops@test:~$ ', 'utf8'));
          stream.on('data', (chunk: Buffer) => stream.write(chunk));
        });
        if (options.sftpRoot) {
          session.on('sftp', (sftpAccept) => serveSftp(sftpAccept(), options.sftpRoot as string));
        }
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

export interface Harness {
  url: string;
  token: string;
  hostId: string;
  manager: SessionManager;
}

export async function startWsHarness(options: {
  sshPort: number;
  devMode?: boolean;
  encoding?: Encoding;
  origins?: string[];
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'brterm-ws-'));
  const context = createContext(dir);
  const host: Host = {
    id: 'h1',
    label: 'test',
    hostname: '127.0.0.1',
    port: options.sshPort,
    username: 'ops',
    authMethod: 'password',
    password: seal(context.key, 'secret'),
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
  if (options.encoding && options.encoding !== 'utf-8') {
    context.db.profiles.push({
      id: 'other-encoding',
      label: '検証用',
      encoding: options.encoding,
      term: 'xterm-256color',
      env: {},
      onConnect: [],
    });
    host.profileId = 'other-encoding';
  }
  context.db.hosts.push(host);
  context.save();

  const manager = new SessionManager();
  managers.push(manager);
  const server = createServer();
  httpServers.push(server);
  attachWebSocketServer(server, {
    context,
    manager,
    origins: options.origins ?? ['http://127.0.0.1:7781'],
    ...(options.devMode === undefined ? {} : { devMode: options.devMode }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/ws`, token: context.token, hostId: host.id, manager };
}

/**
 * 後始末。**SSH の接続を閉じないと試験ファイルが終わらない**
 * (開いたままの控えが残るため)。
 */
export function stopAll(): void {
  for (const manager of managers) {
    manager.closeAll();
  }
  for (const server of httpServers) {
    server.close();
  }
  for (const server of sshServers) {
    server.close();
  }
  managers.length = 0;
  httpServers.length = 0;
  sshServers.length = 0;
}
