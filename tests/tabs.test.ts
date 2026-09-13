import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  needsCloseConfirm,
  openTab,
  setDirty,
  stepTab,
  type Tab,
  type TabsState,
} from '../src/client/lib/tabs.js';

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return { id, kind: 'terminal', title: id, ...overrides };
}

function withTabs(...ids: string[]): TabsState {
  return ids.reduce((state, id) => openTab(state, tab(id)), emptyTabs);
}

test('開いたタブが作業中になる', () => {
  const state = openTab(emptyTabs, tab('a'));
  assert.equal(state.activeId, 'a');
  assert.equal(activeTab(state)?.id, 'a');
});

test('同じ id のタブは重ねて開かず、そのタブへ移る', () => {
  const state = openTab(withTabs('a', 'b'), tab('a'));
  assert.deepEqual(
    state.tabs.map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.equal(state.activeId, 'a');
});

test('作業中のタブを閉じたら右隣へ移る', () => {
  const state = closeTab(activateTab(withTabs('a', 'b', 'c'), 'b'), 'b');
  assert.equal(state.activeId, 'c');
});

test('右端のタブを閉じたら左隣へ移る', () => {
  const state = closeTab(withTabs('a', 'b', 'c'), 'c');
  assert.equal(state.activeId, 'b');
});

test('作業中でないタブを閉じても作業位置は動かない', () => {
  const state = closeTab(activateTab(withTabs('a', 'b', 'c'), 'c'), 'a');
  assert.equal(state.activeId, 'c');
});

test('最後のタブを閉じたら作業中のタブは無くなる', () => {
  const state = closeTab(withTabs('a'), 'a');
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeId, undefined);
});

test('無いタブを閉じても何も起きない', () => {
  const before = withTabs('a', 'b');
  assert.deepEqual(closeTab(before, 'z'), before);
});

test('Ctrl+Tab は端で折り返す', () => {
  const state = withTabs('a', 'b', 'c');
  assert.equal(stepTab(state, 1).activeId, 'a');
  assert.equal(stepTab(activateTab(state, 'a'), -1).activeId, 'c');
  assert.equal(stepTab(activateTab(state, 'a'), 1).activeId, 'b');
});

test('タブが無いときの巡回は何も変えない', () => {
  assert.deepEqual(stepTab(emptyTabs, 1), emptyTabs);
});

test('未保存の印を立てると、閉じるときに確認が要る', () => {
  const state = setDirty(withTabs('a', 'b'), 'b', true);
  assert.equal(needsCloseConfirm(state, 'b'), true);
  assert.equal(needsCloseConfirm(state, 'a'), false);
  assert.equal(needsCloseConfirm(setDirty(state, 'b', false), 'b'), false);
});

test('元の状態を書き換えない(描画の取りこぼしを防ぐため)', () => {
  const before = withTabs('a', 'b');
  const snapshot = JSON.stringify(before);
  closeTab(before, 'a');
  stepTab(before, 1);
  setDirty(before, 'a', true);
  assert.equal(JSON.stringify(before), snapshot);
});
