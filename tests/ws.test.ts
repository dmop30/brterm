import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, test } from 'node:test';

import iconv from 'iconv-lite';
import { WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import { startSshServer, startWsHarness, stopAll, type Harness } from './helpers/ssh-harness.js';

const sockets: WebSocket[] = [];

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
  for (const socket of sockets) {
    socket.close();
  }
  sockets.length = 0;
  stopAll();
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
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const result = await outcome(connectSocket(harness, false));
  assert.equal(result.ok, false, 'トークン無しで張れてしまった');
  assert.match(result.reason ?? '', /401/);
});

test('別 Origin からは張れない', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const socket = new WebSocket(`${harness.url}?token=${harness.token}`, {
    origin: 'http://example.com',
  });
  sockets.push(socket);
  const result = await outcome(socket);
  assert.equal(result.ok, false, '別 Origin から張れてしまった');
  assert.match(result.reason ?? '', /403/);
});

test('未確認のホスト鍵は画面に尋ねてから繋ぐ', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const socket = connectSocket(harness);
  const sessionId = await openSession(harness, socket);
  assert.ok(sessionId.length > 0);
  assert.equal(harness.manager.list().length, 1);
});

test('受け入れなければ繋がらない', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const socket = connectSocket(harness);
  await once(socket, 'open');
  say(socket, { type: 'open', hostId: harness.hostId });
  await waitFor(socket, 'hostkey');
  say(socket, { type: 'hostkey-decision', accept: false });
  const error = await waitFor(socket, 'error');
  assert.equal(error.code, 'ssh_host_key_rejected');
});

test('一度受け入れた鍵は次から尋ねない', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
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
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const socket = connectSocket(harness);
  await openSession(harness, socket);

  await waitFor(socket, 'data', (message) => message.data.includes('ようこそ'));
  say(socket, { type: 'input', data: 'ls -la\r' });
  const echoed = await waitFor(socket, 'data', (message) => message.data.includes('ls -la'));
  assert.match(echoed.data, /ls -la/);
});

test('繋ぎ直すと同じセッションに戻り、直前の表示が返る', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
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
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const socket = connectSocket(harness);
  await once(socket, 'open');
  say(socket, { type: 'attach', sessionId: 'いない' });
  const error = await waitFor(socket, 'error');
  assert.equal(error.code, 'ssh_no_session');
});

test('Shift_JIS の接続先でも日本語が化けない', async () => {
  const greeting = iconv.encode('日本語のテスト\r\n$ ', 'Shift_JIS');
  const sshPort = await startSshServer({ greeting });
  const harness = await startWsHarness({ sshPort, encoding: 'shift_jis' });

  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const data = await waitFor(socket, 'data', (message) => message.data.includes('日本語'));
  assert.match(data.data, /日本語のテスト/);
});

test('文字コードが合っていないと読めない（変換が効いていることの裏取り）', async () => {
  const greeting = iconv.encode('日本語のテスト\r\n$ ', 'Shift_JIS');
  const sshPort = await startSshServer({ greeting });
  // 既定は UTF-8。Shift_JIS の並びはそのままでは読めない
  const harness = await startWsHarness({ sshPort });

  const socket = connectSocket(harness);
  await openSession(harness, socket);
  const data = await waitFor(socket, 'data', (message) => message.data.includes('$'));
  assert.equal(data.data.includes('日本語のテスト'), false);
});

test('形式が違う要求は、理由を返して落ちない', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const socket = connectSocket(harness);
  await once(socket, 'open');
  socket.send('これは JSON ではない');
  const error = await waitFor(socket, 'error');
  assert.equal(error.code, 'bad_message');
});
