import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_GROUPS,
  MIN_SIZE,
  activeGroup,
  closeGroup,
  closeTabIn,
  createLayout,
  focusGroupByNumber,
  gridTemplate,
  moveTabToNeighbour,
  openInActiveGroup,
  resizeAt,
  setDirection,
  splitWorkspace,
  type Layout,
} from '../src/client/lib/layout.js';
import type { Tab } from '../src/client/lib/tabs.js';

function tab(id: string): Tab {
  return { id, kind: 'terminal', title: id };
}

function sum(sizes: number[]): number {
  return Number(sizes.reduce((total, size) => total + size, 0).toFixed(6));
}

function withTwoPanes(): Layout {
  // 端末を開いてから分割し、隣にファイルを開く（端末とファイルを並べる想定）
  let layout = openInActiveGroup(createLayout(), tab('端末 1'));
  layout = splitWorkspace(layout, 'row');
  return openInActiveGroup(layout, { id: 'nginx.conf', kind: 'editor', title: 'nginx.conf' });
}

test('最初は 1 面で、分割していない状態と同じ', () => {
  const layout = createLayout();
  assert.equal(layout.groups.length, 1);
  assert.deepEqual(layout.sizes, [1]);
  assert.equal(gridTemplate(layout), '1fr');
});

test('面と面の間の境界もトラックとして数える（数えないと割合がずれる）', () => {
  const layout = withTwoPanes();
  const template = gridTemplate(layout);
  assert.equal(template.split(' ').length, 3);
  assert.match(template, /fr 1px .*fr/);
});

test('分割すると空の面が隣にでき、そこが作業中になる', () => {
  const layout = splitWorkspace(openInActiveGroup(createLayout(), tab('端末 1')), 'row');
  assert.equal(layout.groups.length, 2);
  assert.equal(activeGroup(layout).tabs.tabs.length, 0);
  assert.equal(layout.groups[0]?.tabs.tabs.length, 1);
  assert.equal(sum(layout.sizes), 1);
});

test('端末とファイルを左右に並べられる', () => {
  const layout = withTwoPanes();
  assert.equal(layout.direction, 'row');
  assert.equal(layout.groups[0]?.tabs.tabs[0]?.kind, 'terminal');
  assert.equal(layout.groups[1]?.tabs.tabs[0]?.kind, 'editor');
});

test('向きを縦に変えても面はそのまま', () => {
  const layout = setDirection(withTwoPanes(), 'column');
  assert.equal(layout.direction, 'column');
  assert.equal(layout.groups.length, 2);
});

test('面の数には上限がある', () => {
  let layout = createLayout();
  for (let index = 0; index < MAX_GROUPS + 3; index += 1) {
    layout = splitWorkspace(layout, 'row');
  }
  assert.equal(layout.groups.length, MAX_GROUPS);
  assert.equal(sum(layout.sizes), 1);
});

test('面の最後のタブを閉じるとその面が畳まれる', () => {
  const layout = withTwoPanes();
  const second = layout.groups[1] as { id: string };
  const closed = closeTabIn(layout, second.id, 'nginx.conf');
  assert.equal(closed.groups.length, 1);
  assert.equal(closed.activeGroupId, layout.groups[0]?.id);
  assert.equal(sum(closed.sizes), 1);
});

test('面が 1 つだけのときは、タブを全部閉じても面は残る', () => {
  const layout = openInActiveGroup(createLayout(), tab('端末 1'));
  const closed = closeTabIn(layout, layout.activeGroupId, '端末 1');
  assert.equal(closed.groups.length, 1);
  assert.equal(closed.groups[0]?.tabs.tabs.length, 0);
});

test('面を閉じてもタブは失われず、隣の面へ移る', () => {
  const layout = withTwoPanes();
  const second = layout.groups[1] as { id: string };
  const closed = closeGroup(layout, second.id);
  assert.equal(closed.groups.length, 1);
  assert.deepEqual(
    closed.groups[0]?.tabs.tabs.map((entry) => entry.id),
    ['端末 1', 'nginx.conf'],
  );
});

test('タブを隣の面へ移せる', () => {
  const layout = withTwoPanes();
  const first = layout.groups[0] as { id: string };
  const moved = moveTabToNeighbour(layout, first.id, '端末 1');
  // 元の面は空になったので畳まれ、両方のタブが 1 面に集まる
  assert.equal(moved.groups.length, 1);
  assert.equal(moved.groups[0]?.tabs.tabs.length, 2);
});

test('番号で面を選べる', () => {
  const layout = withTwoPanes();
  assert.equal(focusGroupByNumber(layout, 1).activeGroupId, layout.groups[0]?.id);
  assert.equal(focusGroupByNumber(layout, 2).activeGroupId, layout.groups[1]?.id);
  // 無い番号は何も変えない
  assert.equal(focusGroupByNumber(layout, 9).activeGroupId, layout.activeGroupId);
});

test('境界をドラッグしても、面は最小幅より狭くならない', () => {
  const layout = withTwoPanes();
  const shrunk = resizeAt(layout, 0, -10);
  assert.ok((shrunk.sizes[0] ?? 0) >= MIN_SIZE);
  assert.ok((shrunk.sizes[1] ?? 0) >= MIN_SIZE);
  assert.equal(sum(shrunk.sizes), 1);

  const grown = resizeAt(layout, 0, 10);
  assert.ok((grown.sizes[1] ?? 0) >= MIN_SIZE);
  assert.equal(sum(grown.sizes), 1);
});

test('無い境界を動かしても何も起きない', () => {
  const layout = withTwoPanes();
  assert.deepEqual(resizeAt(layout, 5, 0.1).sizes, layout.sizes);
});

test('元の状態を書き換えない', () => {
  const layout = withTwoPanes();
  const snapshot = JSON.stringify(layout);
  splitWorkspace(layout, 'column');
  closeGroup(layout, layout.groups[1]?.id ?? '');
  resizeAt(layout, 0, 0.1);
  assert.equal(JSON.stringify(layout), snapshot);
});
