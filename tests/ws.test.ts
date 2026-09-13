import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import iconv from 'iconv-lite';
import ssh2, { type Connection, type Server as SshServerType } from 'ssh2';
import { WebSocket } from 'ws';

import { createContext } from '../src/server/context.js';
import { seal } from '../src/server/crypto.js';
import { SessionManager } from '../src/server/ssh.js';
import { attachWebSocketServer } from '../src/server/ws.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { Host } from '../src/shared/types.js';

const { Server, utils } = ssh2;
const keyPair = utils.generateKeyPairSync('ed25519');

const sshServers: SshServerType[] = [];
const httpServers: HttpServer[] = [];
const sockets: WebSocket[] = [];
const managers: SessionManager[] = [];

/** 試験用の SSH サーバ。打った文字をそのまま返し、最初に挨拶を出す。 */
async function startSsh(options: { greeting?: Buffer } = {}): Promise<number> {
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
          stream.write(options.greeting ?? Buffer.from('ようこそ\r\n$ ', 'utf8'));
          stream.on('data', (chunk: Buffer) => stream.write(chunk));
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

interface Harness {
  url: string;
  token: string;
  hostId: string;
  manager: SessionManager;
  /** 履歴や設定を直接確かめるため */
  context: ReturnType<typeof createContext>;
}

async function startHarness(options: {
  sshPort: number;
  devMode?: boolean;
  /** 接続先に紐付けるプロファイルの文字コード */
  encoding?: 'utf-8' | 'shift_jis' | 'euc-jp';
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
      id: 'sjis',
      label: '検証用',
      encoding: options.encoding,
      term: 'xterm-256color',
      env: {},
      onConnect: [],
    });
    host.profileId = 'sjis';
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
    origins: ['http://127.0.0.1:7781'],
    ...(options.devMode === undefined ? {} : { devMode: options.devMode }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    token: context.token,
    hostId: host.id,
    manager,
    context,
  };
}

function connectSocket(harness: Harness, withToken = true): WebSocket {
  const socket = new WebSocket(withToken ? `${harness.url}?token=${harness.token}` : harness.url);
  sockets.push(socket);
  return socket;
}

function say(socket: WebSocket, message: ClientMessage): void {
  socket.send(JSON.stringify(message));
}

/** 条件に合うメッセージが来るまで待つ。 */
function waitFor<T extends ServerMessage['type']>(
  socket: WebSocket,
  type: T,
  predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} が来ませんでした`)), 15000);
    const listener = (raw: unknown) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.type === type && predicate(message as Extract<ServerMessage, { type: T }>)) {
        clearTimeout(timer);
        socket.off('message', listener);
        resolve(message as Extract<ServerMessage, { type: T }>);
      }
    };
    socket.on('message', listener);
  });
}

/** 鍵を受け入れてセッションを開くところまで。 */
async function openSession(harness: Harness, socket: WebSocket): Promise<string> {
  await once(socket, 'open');
  say(socket, { type: 'open', hostId: harness.hostId, cols: 80, rows: 24 });
  const prompt = await waitFor(socket, 'hostkey');
  assert.match(prompt.fingerprint, /^SHA256:/);
  say(socket, { type: 'hostkey-decision', accept: true });
  const opened = await waitFor(socket, 'opened');
  return opened.sessionId;
}

after(() => {
  // **SSH の接続を閉じないと、試験ファイルが終わらない**（開いたままの控えが残る）
  for (const manager of managers) {
    manager.closeAll();
  }
  for (const socket of sockets) {
    socket.close();
  }
  for (const server of httpServers) {
    server.close();
  }
  for (const server of sshServers) {
    server.close();
  }
});

/**
 * 張れたか弾かれたかを、**待ちっぱなしにならない形**で確かめる。
 * 失敗だけを待つと、通ってしまったときに時間切れになって理由が分からない。
 */
async function outcome(socket: WebSocket): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    socket.once('open', () => resolve({ ok: true }));
    socket.once('error', (error: Error) => resolve({ ok: false, reason: error.message }));
  });
}

test('トークンが無ければ WebSocket を張れない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const result = await outcome(connectSocket(harness, false));
  assert.equal(result.ok, false, 'トークン無しで張れてしまった');
  assert.match(result.reason ?? '', /401/);
});

test('別 Origin からは張れない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = new WebSocket(`${harness.url}?token=${harness.token}`, {
    origin: 'http://example.com',
  });
  sockets.push(socket);
  const result = await outcome(socket);
  assert.equal(result.ok, false, '別 Origin から張れてしまった');
  assert.match(result.reason ?? '', /403/);
});

test('未確認のホスト鍵は画面に尋ねてから繋ぐ', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  const sessionId = await openSession(harness, socket);
  assert.ok(sessionId.length > 0);
  assert.equal(harness.manager.list().length, 1);
});

test('受け入れなければ繋がらない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await once(socket, 'open');
  say(socket, { type: 'open', hostId: harness.hostId });
  await waitFor(socket, 'hostkey');
  say(socket, { type: 'hostkey-decision', accept: false });
  const error = await waitFor(socket, 'error');
  assert.equal(error.code, 'ssh_host_key_rejected');
});

test('一度受け入れた鍵は次から尋ねない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const first = connectSocket(harness);
  await openSession(harness, first);

  const second = connectSocket(harness);
  await once(second, 'open');
  say(second, { type: 'open', hostId: harness.hostId });
  const opened = await Promise.race([
    waitFor(second, 'opened').then(() => 'opened' as const),
    waitFor(second, 'hostkey').then(() => 'hostkey' as const),
  ]);
  assert.equal(opened, 'opened');
});

test('端末の出力が画面へ流れ、打った文字が届く', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await openSession(harness, socket);

  await waitFor(socket, 'data', (message) => message.data.includes('ようこそ'));
  say(socket, { type: 'input', data: 'ls -la\r' });
  const echoed = await waitFor(socket, 'data', (message) => message.data.includes('ls -la'));
  assert.match(echoed.data, /ls -la/);
});

test('繋ぎ直すと同じセッションに戻り、直前の表示が返る', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const first = connectSocket(harness);
  const sessionId = await openSession(harness, first);
  await waitFor(first, 'data', (message) => message.data.includes('ようこそ'));
  first.close();

  const second = connectSocket(harness);
  await once(second, 'open');
  say(second, { type: 'attach', sessionId, cols: 100, rows: 30 });
  const opened = await waitFor(second, 'opened');
  assert.equal(opened.sessionId, sessionId);
  assert.match(opened.snapshot, /ようこそ/);
});

test('無いセッションに繋ぎ直そうとしたら、理由が分かる', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await once(socket, 'open');
  say(socket, { type: 'attach', sessionId: 'いない' });
  const error = await waitFor(socket, 'error');
  assert.equal(error.code, 'ssh_no_session');
});

test('Shift_JIS の接続先でも日本語が化けない', async () => {
  const greeting = iconv.encode('日本語のテスト\r\n$ ', 'Shift_JIS');
  const sshPort = await startSsh({ greeting });
  const harness = await startHarness({ sshPort, encoding: 'shift_jis' });

  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const data = await waitFor(socket, 'data', (message) => message.data.includes('日本語'));
  assert.match(data.data, /日本語のテスト/);
});

test('文字コードが合っていないと読めない（変換が効いていることの裏取り）', async () => {
  const greeting = iconv.encode('日本語のテスト\r\n$ ', 'Shift_JIS');
  const sshPort = await startSsh({ greeting });
  // 既定は UTF-8。Shift_JIS の並びはそのままでは読めない
  const harness = await startHarness({ sshPort });

  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const data = await waitFor(socket, 'data', (message) => message.data.includes('$'));
  assert.equal(data.data.includes('日本語のテスト'), false);
});

test('形式が違う要求は、理由を返して落ちない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await once(socket, 'open');
  socket.send('これは JSON ではない');
  const error = await waitFor(socket, 'error');
  assert.equal(error.code, 'bad_message');
});

/** 受け取った出力をためる。改行を握れているかの確認に使う。 */
function collect(socket: WebSocket): { text: () => string } {
  let buffer = '';
  socket.on('message', (raw: unknown) => {
    const message = JSON.parse(String(raw)) as ServerMessage;
    if (message.type === 'data') {
      buffer += message.data;
    }
  });
  return { text: () => buffer };
}

/** 相手の応答を待つ猶予。握った改行が漏れていないかは「来ないこと」で確かめる。 */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 300));
}

test('危険なコマンドは改行を握って確認を出す', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const output = collect(socket);

  const waiting = waitFor(socket, 'confirm');
  say(socket, { type: 'input', data: 'rm -rf /etc/nginx\r' });
  const confirm = await waiting;

  assert.equal(confirm.command, 'rm -rf /etc/nginx');
  // 対象（ホスト名とパス）と理由が文言に入っていること（要件定義 12 章 5）
  assert.match(confirm.message, /127\.0\.0\.1/);
  assert.match(confirm.message, /\/etc/);
  assert.match(confirm.reason, /消します/);

  await settle();
  // 改行は送っていないので、折り返しにも現れない
  assert.equal(output.text().includes('rm -rf /etc/nginx\r'), false, '改行が漏れた');
  assert.equal(harness.context.db.history.length, 0, '実行前に履歴へ入った');
});

test('受け入れたら実行し、履歴に残す', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const output = collect(socket);

  const waiting = waitFor(socket, 'confirm');
  say(socket, { type: 'input', data: 'rm -rf /etc/nginx\r' });
  await waiting;
  say(socket, { type: 'confirm-decision', accept: true });
  await settle();

  assert.ok(output.text().includes('rm -rf /etc/nginx\r'), '改行が送られていない');
  assert.deepEqual(
    harness.context.db.history.map((entry) => entry.command),
    ['rm -rf /etc/nginx'],
  );
});

test('断ったら実行せず、履歴にも残さない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const output = collect(socket);

  const waiting = waitFor(socket, 'confirm');
  say(socket, { type: 'input', data: 'rm -rf /etc/nginx\r' });
  await waiting;
  say(socket, { type: 'confirm-decision', accept: false });
  await settle();

  assert.equal(output.text().includes('rm -rf /etc/nginx\r'), false, '実行してしまった');
  assert.equal(harness.context.db.history.length, 0);
});

test('確認待ちのあいだに打った分は、受け入れた後に同じ順で流す', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const output = collect(socket);

  const waiting = waitFor(socket, 'confirm');
  // 改行より後ろ（uptime）も一緒に届くが、先に流してはいけない
  say(socket, { type: 'input', data: 'rm -rf /etc/nginx\ruptime\r' });
  await waiting;
  await settle();
  assert.equal(output.text().includes('uptime'), false, '確認前に後続を流した');

  say(socket, { type: 'confirm-decision', accept: true });
  await settle();
  assert.deepEqual(
    harness.context.db.history.map((entry) => entry.command),
    ['rm -rf /etc/nginx', 'uptime'],
  );
});

test('普通のコマンドは止めずに実行し、履歴に残す', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  const socket = connectSocket(harness);
  await openSession(harness, socket);

  say(socket, { type: 'input', data: 'systemctl status nginx\r' });
  await settle();
  assert.deepEqual(
    harness.context.db.history.map((entry) => entry.command),
    ['systemctl status nginx'],
  );
});

test('確認を切っていれば止めない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  harness.context.db.settings.confirmDangerousCommands = false;
  const socket = connectSocket(harness);
  await openSession(harness, socket);

  say(socket, { type: 'input', data: 'reboot\r' });
  await settle();
  assert.deepEqual(
    harness.context.db.history.map((entry) => entry.command),
    ['reboot'],
  );
});

test('保持件数が 0 なら履歴を残さない', async () => {
  const harness = await startHarness({ sshPort: await startSsh() });
  harness.context.db.settings.historyLimit = 0;
  const socket = connectSocket(harness);
  await openSession(harness, socket);

  say(socket, { type: 'input', data: 'uptime\r' });
  await settle();
  assert.equal(harness.context.db.history.length, 0);
});

test('パスワードを尋ねられている最中の入力は履歴に残さない', async () => {
  const harness = await startHarness({
    sshPort: await startSsh({ greeting: Buffer.from('[sudo] password for ops: ', 'utf8') }),
  });
  const socket = connectSocket(harness);
  await openSession(harness, socket);
  // 合図（プロンプト）が届いてから打つ
  await waitFor(socket, 'data', (message) => message.data.includes('password'));

  say(socket, { type: 'input', data: 'himitsu\r' });
  await settle();
  assert.equal(harness.context.db.history.length, 0, 'パスワードが履歴に入った');
});

/** 受け取った環境変数と打鍵を控える試験用 SSH サーバ。プロファイルの効きを見る。 */
interface Recorded {
  port: number;
  env: Record<string, string>;
  input: () => string;
}

async function startRecordingSsh(): Promise<Recorded> {
  const env: Record<string, string> = {};
  let input = '';
  const server = new Server({ hostKeys: [keyPair.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        ctx.accept();
        return;
      }
      ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('env', (envAccept, _reject, info) => {
          // ssh2 の env 要求は `val`（`value` ではない）
          env[info.key] = info.val;
          envAccept?.();
        });
        session.once('pty', (ptyAccept) => ptyAccept?.());
        session.once('shell', (shellAccept) => {
          const stream = shellAccept();
          stream.write(Buffer.from('$ ', 'utf8'));
          stream.on('data', (chunk: Buffer) => {
            input += chunk.toString('utf8');
            stream.write(chunk);
          });
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
  return {
    port: (server.address() as AddressInfo).port,
    env,
    input: () => input,
  };
}

test('プロファイルの環境変数が接続先へ渡る', async () => {
  const ssh = await startRecordingSsh();
  const harness = await startHarness({ sshPort: ssh.port });
  harness.context.db.profiles.push({
    id: 'p1',
    label: '検証用',
    encoding: 'utf-8',
    term: 'xterm',
    env: { LANG: 'ja_JP.UTF-8' },
    onConnect: [],
  });
  const host = harness.context.db.hosts[0];
  assert.ok(host);
  host.profileId = 'p1';

  const socket = connectSocket(harness);
  await openSession(harness, socket);
  await settle();
  assert.equal(ssh.env.LANG, 'ja_JP.UTF-8');
});

test('接続時コマンドは接続直後に流し、履歴には残さない', async () => {
  const ssh = await startRecordingSsh();
  const harness = await startHarness({ sshPort: ssh.port });
  harness.context.db.profiles.push({
    id: 'p2',
    label: '検証用',
    encoding: 'utf-8',
    term: 'xterm-256color',
    env: {},
    onConnect: ['export LANG=ja_JP.UTF-8', 'cd /var/log'],
  });
  const host = harness.context.db.hosts[0];
  assert.ok(host);
  host.profileId = 'p2';

  const socket = connectSocket(harness);
  await openSession(harness, socket);
  await settle();

  assert.ok(ssh.input().includes('export LANG=ja_JP.UTF-8\r'), '接続時コマンドが流れていない');
  assert.ok(ssh.input().includes('cd /var/log\r'), '2 つ目が流れていない');
  // 利用者が打ったものではないので残さない
  assert.equal(harness.context.db.history.length, 0);
});
