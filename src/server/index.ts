#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { BIND_ADDRESS, DEV_CLIENT_PORT, SERVER_PORT } from '../shared/defaults.js';
import type { HealthResponse } from '../shared/types.js';
import { createApiRouter } from './api.js';
import { createContext, type ServerContext } from './context.js';
import { dataDir } from './paths.js';
import { SessionManager } from './ssh.js';
import { allowedOrigins, isAllowedOrigin, tokenFromRequest, tokenMatches } from './token.js';
import { attachWebSocketServer } from './ws.js';

const VERSION = '0.1.0';

export interface AppOptions {
  context: ServerContext;
  /** 端末セッションの台帳。鍵の配置で、開いているセッションを使う */
  manager?: SessionManager;
  /** 鍵の置き場と `~/.ssh/config` の場所。検証で差し替えるため */
  keysDir?: string;
  sshConfigPath?: string;
  /** 開発時(`npm run dev`)はトークン認証を省略する(要件定義 2 章)。 */
  devMode?: boolean;
  /** 許す Origin。省略時は待ち受け先から作る。 */
  origins?: string[];
}

/** ビルド済みの画面(dist/client)の場所。開発時は Vite が配信するため無くてよい。 */
function clientDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'client');
}

export function createApp(options: AppOptions): express.Express {
  const { context, devMode = false } = options;
  const origins = options.origins ?? allowedOrigins(BIND_ADDRESS, SERVER_PORT, DEV_CLIENT_PORT);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  // 死活確認だけは認証を通さない。画面がトークンを受け取る前に状態を出すため。
  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', version: VERSION, locked: false };
    res.json(body);
  });

  app.use('/api', (req, res, next) => {
    // ブラウザの別サイトから叩かれないようにする
    if (!isAllowedOrigin(req.headers.origin, origins)) {
      res.status(403).json({
        error: { code: 'origin_rejected', message: 'この要求元からは操作できません。' },
      });
      return;
    }
    if (devMode) {
      next();
      return;
    }
    if (!tokenMatches(context.token, tokenFromRequest(req.headers, req.originalUrl))) {
      res.status(401).json({
        error: {
          code: 'token_required',
          message:
            'アクセストークンが必要です。brterm を起動した端末に出ている URL から開いてください。',
        },
      });
      return;
    }
    next();
  });

  app.use(
    '/api',
    createApiRouter(context, {
      ...(options.manager ? { manager: options.manager } : {}),
      ...(options.keysDir ? { keysDir: options.keysDir } : {}),
      ...(options.sshConfigPath ? { sshConfigPath: options.sshConfigPath } : {}),
    }),
  );

  const dir = clientDir();
  if (existsSync(join(dir, 'index.html'))) {
    app.use(express.static(dir));
    app.get('*', (_req, res) => res.sendFile(join(dir, 'index.html')));
  }

  return app;
}

/** このファイルが直接実行されたときだけ待ち受ける(テストから import できるようにするため)。 */
function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const devMode = process.argv.includes('--dev');
  const port = Number(process.env.BRTERM_PORT ?? SERVER_PORT);
  const host = process.env.BRTERM_HOST ?? BIND_ADDRESS;
  const context = createContext();
  // API(鍵の配置)と WebSocket で**同じ台帳**を見る
  const manager = new SessionManager();
  const app = createApp({
    context,
    manager,
    devMode,
    origins: allowedOrigins(host, port, devMode ? DEV_CLIENT_PORT : undefined),
  });

  const httpServer = createServer(app);
  // 端末の入出力は WebSocket で中継する。セッションはこのプロセスが持つ。
  attachWebSocketServer(httpServer, {
    context,
    manager,
    devMode,
    origins: allowedOrigins(host, port, devMode ? DEV_CLIENT_PORT : undefined),
  });

  httpServer.listen(port, host, () => {
    // 秘密情報は出さない。ただし**トークンは起動した本人にだけ**必要なので、
    // 自分の端末に出す URL には含める(これが無いと画面を開けない)。
    console.error(`brterm ${VERSION} listening on http://${host}:${port}`);
    console.error(`data dir: ${dataDir()}`);
    if (devMode) {
      console.error('開発モード: トークン認証を省略しています。');
    } else {
      console.error(`画面を開く: http://${host}:${port}/?token=${context.token}`);
    }
  });
}
