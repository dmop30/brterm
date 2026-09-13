import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLayout, openInActiveGroup, splitWorkspace } from '../src/client/lib/layout.js';
import { parseLayout } from '../src/client/lib/persist.js';

function sample() {
  let layout = openInActiveGroup(createLayout(), {
    id: 'terminal-1',
    kind: 'terminal',
    title: 'web-01',
    hostId: 'h1',
    sessionId: 's1',
    connection: 'connected',
  });
  layout = splitWorkspace(layout, 'row');
  return openInActiveGroup(layout, {
    id: 'terminal-2',
    kind: 'terminal',
    title: 'db-02',
    hostId: 'h2',
    sessionId: 's2',
  });
}

test('保存した配置を読み戻せる', () => {
  const layout = sample();
  const restored = parseLayout(JSON.stringify({ version: 1, layout }));
  assert.ok(restored);
  assert.equal(restored?.groups.length, 2);
  assert.equal(restored?.groups[0]?.tabs.tabs[0]?.sessionId, 's1');
  assert.equal(restored?.groups[1]?.tabs.tabs[0]?.hostId, 'h2');
});

test('版が違うものは読まない', () => {
  assert.equal(parseLayout(JSON.stringify({ version: 99, layout: sample() })), undefined);
});

test('壊れた内容は読まない（壊れた状態で画面を組み立てない）', () => {
  assert.equal(parseLayout('これは JSON ではない'), undefined);
  assert.equal(parseLayout(null), undefined);
  assert.equal(parseLayout(JSON.stringify({ version: 1 })), undefined);
  assert.equal(parseLayout(JSON.stringify({ version: 1, layout: { groups: [] } })), undefined);
});

test('面の数と大きさの数が合わないものは読まない', () => {
  const layout = sample();
  const broken = { ...layout, sizes: [1] };
  assert.equal(parseLayout(JSON.stringify({ version: 1, layout: broken })), undefined);
});

test('向きが知らない値なら読まない', () => {
  const layout = { ...sample(), direction: 'diagonal' };
  assert.equal(parseLayout(JSON.stringify({ version: 1, layout })), undefined);
});
