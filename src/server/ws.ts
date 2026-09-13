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
import type { ServerContext } from './context.js';
import { open as openSealed } from './crypto.js';
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

/** 1 本の接続が持つ状態。 */
interface Connection {
  socket: WebSocket;
  session?: Session;
  detach?: () => void;
  /** ホスト鍵の確認待ち。画面の返事でこれを解く。 */
  pendingHostKey?: (accept: boolean) => void;
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
    const connection: Connection = { socket };

    const bind = (session: Session, snapshot: string) => {
      connection.session = session;
      connection.detach?.();
      const offData = session.onData((data) => send(socket, { type: 'data', data }));
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
            connection.session?.write(message.data);
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
