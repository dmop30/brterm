import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContext } from '../src/server/context.js';
import { createApp } from '../src/server/index.js';
import type { HealthResponse } from '../src/shared/types.js';

test('/api/health が ok を返す', async () => {
  const context = createContext(mkdtempSync(join(tmpdir(), 'brterm-health-')));
  const server = createApp({ context }).listen(0, '127.0.0.1');
  try {
    await new Promise((done) => server.once('listening', done));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as HealthResponse;
    assert.equal(body.status, 'ok');
    assert.equal(body.locked, false);
  } finally {
    server.close();
  }
});
