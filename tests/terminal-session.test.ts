import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { WebSocket } from 'ws';

import { TerminalSession, type SocketLike } from '../src/client/lib/terminal-session.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import { startSshServer, startWsHarness, stopAll, type Harness } from './helpers/ssh-harness.js';

/**
 * 画面側の WebSocket の層を、**実際のサーバに繋いで**確かめる。
 * `ws` を差し込めば、ブラウザを立ち上げずに同じ経路を通せる。
 */
const opened: TerminalSession[] = [];

function socketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

function connect(harness: Harness): TerminalSession {
  const session = new TerminalSession({
    url: `${harness.url}?token=${harness.token}`,
    socketFactory,
  });
  opened.push(session);
  return session;
}

function waitFor<T extends ServerMessage['type']>(
  session: TerminalSession,
  type: T,
  predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} が来ませんでした`)), 15000);
    const off = session.onMessage((message) => {
      if (message.type === type && predicate(message as Extract<ServerMessage, { type: T }>)) {
        clearTimeout(timer);
        off();
        resolve(message as Extract<ServerMessage, { type: T }>);
      }
    });
  });
}

after(() => {
  for (const session of opened) {
    session.detach();
  }
  opened.length = 0;
  stopAll();
});

test('開く前に送った要求も、繋がってから届く', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const session = connect(harness);
  // `open` を待たずに送る（画面は接続の完了を待たない）
  session.open(harness.hostId, 80, 24);
  const prompt = await waitFor(session, 'hostkey');
  assert.match(prompt.fingerprint, /^SHA256:/);
});

test('鍵を受け入れると端末の出力が届く', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const session = connect(harness);
  session.open(harness.hostId, 80, 24);
  await waitFor(session, 'hostkey');
  session.answerHostKey(true);
  await waitFor(session, 'opened');
  const data = await waitFor(session, 'data', (message) => message.data.includes('ようこそ'));
  assert.match(data.data, /ops@test/);
});

test('打った文字が端末に届く', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const session = connect(harness);
  session.open(harness.hostId, 80, 24);
  await waitFor(session, 'hostkey');
  session.answerHostKey(true);
  await waitFor(session, 'opened');
  session.input('uptime\r');
  const echoed = await waitFor(session, 'data', (message) => message.data.includes('uptime'));
  assert.match(echoed.data, /uptime/);
});

test('画面を閉じてもセッションは残り、繋ぎ直すと表示が戻る', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const first = connect(harness);
  first.open(harness.hostId, 80, 24);
  await waitFor(first, 'hostkey');
  first.answerHostKey(true);
  const openedMessage = await waitFor(first, 'opened');
  await waitFor(first, 'data', (message) => message.data.includes('ようこそ'));

  // detach はサーバ側のセッションを切らない
  first.detach();
  assert.equal(harness.manager.list().length, 1);

  const second = connect(harness);
  second.attach(openedMessage.sessionId, 100, 30);
  const reattached = await waitFor(second, 'opened');
  assert.equal(reattached.sessionId, openedMessage.sessionId);
  assert.match(reattached.snapshot, /ようこそ/);
});

test('close はセッションごと終わらせる', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const session = connect(harness);
  session.open(harness.hostId, 80, 24);
  await waitFor(session, 'hostkey');
  session.answerHostKey(true);
  await waitFor(session, 'opened');

  session.close();
  // 台帳から消えるまで少し待つ
  for (let attempt = 0; attempt < 50 && harness.manager.list().length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(harness.manager.list().length, 0);
});

test('接続の状態が画面へ伝わる', async () => {
  const harness = await startWsHarness({ sshPort: await startSshServer() });
  const session = connect(harness);
  assert.equal(session.linkState, 'connecting');

  const states: string[] = [];
  session.onStateChange((state) => states.push(state));
  session.open(harness.hostId, 80, 24);
  await waitFor(session, 'hostkey');
  assert.equal(session.linkState, 'open');
  assert.deepEqual(states, ['open']);
});
