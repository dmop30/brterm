#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { BIND_ADDRESS, SERVER_PORT } from '../shared/defaults.js';
import type { HealthResponse } from '../shared/types.js';
import { dataDir } from './paths.js';

const VERSION = '0.1.0';

/** ビルド済みの画面(dist/client)の場所。開発時は Vite が配信するため無くてよい。 */
function clientDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'client');
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', version: VERSION, locked: false };
    res.json(body);
  });

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
  const port = Number(process.env.BRTERM_PORT ?? SERVER_PORT);
  const host = process.env.BRTERM_HOST ?? BIND_ADDRESS;
  const server = createServer(createApp());
  server.listen(port, host, () => {
    // 秘密情報は出さない。出すのは待ち受け先と保存先だけ。
    console.error(`brterm ${VERSION} listening on http://${host}:${port}`);
    console.error(`data dir: ${dataDir()}`);
  });
}
