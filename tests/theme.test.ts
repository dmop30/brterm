import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyTheme,
  nextPreference,
  preferenceLabel,
  resolveTheme,
} from '../src/client/lib/theme.js';

test('明示選択は OS の設定より強い', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('system は OS の設定に従う', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('切り替えは system → 暗い → 明るい → system', () => {
  assert.equal(nextPreference('system'), 'dark');
  assert.equal(nextPreference('dark'), 'light');
  assert.equal(nextPreference('light'), 'system');
});

test('表示は日本語', () => {
  assert.equal(preferenceLabel('system'), 'OS に合わせる');
  assert.equal(preferenceLabel('dark'), '暗い配色');
  assert.equal(preferenceLabel('light'), '明るい配色');
});

test('反映すると data-theme が置かれる', () => {
  const target = { dataset: {} as { theme?: string } };
  applyTheme(target, 'dark');
  assert.equal(target.dataset.theme, 'dark');
  applyTheme(target, 'light');
  assert.equal(target.dataset.theme, 'light');
});
