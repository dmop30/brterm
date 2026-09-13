/**
 * 端末の入出力を中継する WebSocket。
 *
 * セッションはサーバ側で生きているので(要件定義 3 章)、この層は
 * **繋ぎ直しても同じセッションに戻せる**ことを受け持つ。
 * 秘密の復号はここで行い、`ssh.ts` には復号済みのものだけを渡す。
 */
import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { Host, Profile } from '../shared/types.js';
import { CommandLine } from './command-line.js';
import type { ServerContext } from './context.js';
import { open as openSealed } from './crypto.js';
import { confirmMessage, judgeCommand } from './dangerous.js';
import { recordCommand } from './history.js';
import { AppError, isAppError } from './errors.js';
import { rememberHostKey } from './hostkey.js';
import { defaultProfile } from './store.js';
import { connect, SessionManager, type HostKeyPrompt, type Session } from './ssh.js';
import { isAllowedOrigin, tokenFromRequest, tokenMatches } from './token.js';

export interface WebSocketOptions {
  context: ServerContext;
  manager: SessionManager;
  devMode?: boolean;
  origins: string[];
  /** 試験で待たずに済ませるため差し替えられるようにしておく */
  path?: string;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function profileFor(context: ServerContext, host: Host): Profile {
  return (
    context.db.profiles.find((profile) => profile.id === host.profileId) ??
    context.db.profiles.find((profile) => profile.id === 'default') ??
    defaultProfile()
  );
}

/** 保存された秘密を開く。開けないときは、状態を明示して止める(推測で続行しない)。 */
function secretsFor(
  context: ServerContext,
  host: Host,
): { password?: string; passphrase?: string } {
  const secrets: { password?: string; passphrase?: string } = {};
  if (host.password) {
    secrets.password = openSealed(context.key, host.password);
  }
  if (host.passphrase) {
    secrets.passphrase = openSealed(context.key, host.passphrase);
  }
  return secrets;
}

/** 危険コマンドの確認待ち。返事が来るまで改行を握っておく。 */
interface PendingConfirm {
  command: string;
  /** 改行より後に届いていた打鍵。受け入れたらこの順で流し直す。 */
  rest: string;
}

/** 1 本の接続が持つ状態。 */
interface Connection {
  socket: WebSocket;
  session?: Session;
  detach?: () => void;
  /** ホスト鍵の確認待ち。画面の返事でこれを解く。 */
  pendingHostKey?: (accept: boolean) => void;
  /** いま打っている行。履歴と危険コマンドの判定に使う。 */
  line: CommandLine;
  pendingConfirm?: PendingConfirm;
}

export function attachWebSocketServer(
  server: HttpServer,
  options: WebSocketOptions,
): WebSocketServer {
  const { context, manager, devMode = false, origins, path = '/ws' } = options;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '';
    if (!url.startsWith(path)) {
      return;
    }
    // HTTP と同じ規則で守る(要件定義 7 章)
    if (!isAllowedOrigin(request.headers.origin, origins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!devMode && !tokenMatches(context.token, tokenFromRequest(request.headers, url))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket: WebSocket) => {
    const connection: Connection = { socket, line: new CommandLine() };

    const bind = (session: Session, snapshot: string) => {
      connection.session = session;
      connection.detach?.();
      const offData = session.onData((data) => {
        // パスワードを求められている最中かどうかは、出力を見ないと分からない
        connection.line.noteOutput(data);
        send(socket, { type: 'data', data });
      });
      const offClose = session.onClose(() => send(socket, { type: 'closed' }));
      connection.detach = () => {
        offData();
        offClose();
      };
      send(socket, { type: 'opened', sessionId: session.id, snapshot });
    };

    const fail = (error: unknown) => {
      if (isAppError(error)) {
        send(socket, { type: 'error', code: error.code, message: error.message });
        return;
      }
      send(socket, {
        type: 'error',
        code: 'unexpected',
        message: '接続中に問題が起きました。詳細はサーバのログを見てください。',
      });
    };

    const openSession = async (message: Extract<ClientMessage, { type: 'open' }>) => {
      const host = context.db.hosts.find((entry) => entry.id === message.hostId);
      if (!host) {
        fail(new AppError('ssh_no_session', '指定された接続先が見つかりません。'));
        return;
      }

      const profile = profileFor(context, host);
      const session = await connect({
        host,
        profile,
        ...secretsFor(context, host),
        known: context.db.knownHostKeys,
        cols: message.cols ?? 80,
        rows: message.rows ?? 24,
        // 未確認の鍵は画面に尋ねる。返事が来るまで待つ。
        onUnknownHostKey: (prompt: HostKeyPrompt) =>
          new Promise<boolean>((resolve) => {
            connection.pendingHostKey = resolve;
            send(socket, { type: 'hostkey', ...prompt });
          }),
      });

      // 受け入れた鍵は覚える。次からは尋ねない。
      if (session.hostKey.verdict === 'unknown') {
        context.db.knownHostKeys = rememberHostKey(context.db.knownHostKeys, {
          hostname: host.hostname,
          port: host.port,
          keyType: 'ssh',
          fingerprint: session.hostKey.fingerprint,
        });
        context.save();
      }

      manager.add(session);
      bind(session, session.snapshot());
    };

    /** 確定した行を実行する。改行はここでだけ送る。 */
    const runLine = (command: string) => {
      connection.line.reset();
      const session = connection.session;
      session?.write('\r');
      // 繋ぎ直した後でも残せるよう、接続先はセッションから取る
      if (session && recordCommand(context.db, { hostId: session.hostId, command })) {
        context.save();
      }
    };

    /**
     * 打鍵を 1 文字ずつ見る。
     *
     * 危険コマンドのときは**改行だけ握って**画面に尋ねる。改行より後に届いた打鍵も
     * 一緒に預かる(先に流すと順番が入れ替わる)。
     */
    const feedInput = (data: string) => {
      const characters = [...data];
      let buffered = '';

      const flush = () => {
        if (buffered !== '') {
          connection.session?.write(buffered);
          buffered = '';
        }
      };

      for (let index = 0; index < characters.length; index += 1) {
        const char = characters[index] as string;

        // 確認待ちの最中に届いた打鍵は、返事が決まるまで預かる
        if (connection.pendingConfirm) {
          connection.pendingConfirm.rest += char;
          continue;
        }

        const result = connection.line.feedChar(char);
        if (result.line === undefined) {
          buffered += char;
          continue;
        }

        const command = result.line;
        if (result.secret || command === '') {
          // パスワードは履歴にも判定にも回さない
          buffered += char;
          continue;
        }

        const verdict = context.db.settings.confirmDangerousCommands
          ? judgeCommand(command)
          : { dangerous: false as const };

        if (verdict.dangerous) {
          flush();
          // 改行を送っていないので、シェル側の行は残っている。こちらの控えも戻す
          connection.line.restore(command);
          connection.pendingConfirm = { command, rest: characters.slice(index + 1).join('') };
          send(socket, {
            type: 'confirm',
            command,
            message: confirmMessage(command, verdict, connection.session?.hostname ?? '接続先'),
            reason: verdict.reason ?? '',
          });
          return;
        }

        flush();
        runLine(command);
      }

      flush();
    };

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send(socket, { type: 'error', code: 'bad_message', message: '要求の形式が不正です。' });
        return;
      }

      switch (message.type) {
        case 'open':
          void openSession(message).catch(fail);
          return;
        case 'attach': {
          const session = manager.find(message.sessionId);
          if (!session || session.isClosed) {
            send(socket, {
              type: 'error',
              code: 'ssh_no_session',
              message: 'そのセッションはもうありません。開き直してください。',
            });
            return;
          }
          if (message.cols && message.rows) {
            session.resize(message.cols, message.rows);
          }
          // 繋ぎ直したときは、直前までの表示を戻す
          bind(session, session.snapshot());
          return;
        }
        case 'input':
          try {
            feedInput(message.data);
          } catch (error) {
            fail(error);
          }
          return;
        case 'resize':
          connection.session?.resize(message.cols, message.rows);
          return;
        case 'hostkey-decision': {
          const resolve = connection.pendingHostKey;
          connection.pendingHostKey = undefined as never;
          resolve?.(message.accept);
          return;
        }
        case 'confirm-decision': {
          const pending = connection.pendingConfirm;
          connection.pendingConfirm = undefined as never;
          if (!pending) {
            return;
          }
          if (!message.accept) {
            // 実行しない。打った行はシェル側に残したままにする(直して使えるように)
            return;
          }
          try {
            runLine(pending.command);
            feedInput(pending.rest);
          } catch (error) {
            fail(error);
          }
          return;
        }
        case 'close':
          if (connection.session) {
            manager.close(connection.session.id);
          }
          return;
        default:
          send(socket, { type: 'error', code: 'bad_message', message: '知らない要求です。' });
      }
    });

    socket.on('close', () => {
      // **セッションは切らない。** ブラウザを閉じても続きから戻れるようにする(要件定義 5 章 L1)。
      connection.detach?.();
      connection.pendingHostKey?.(false);
    });
  });

  return wss;
}
