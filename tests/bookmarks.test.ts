import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addBookmark,
  defaultLabel,
  forHost,
  normalizePath,
  removeBookmark,
  removeForHost,
  reorder,
} from '../src/server/bookmarks.js';
import type { Bookmark } from '../src/shared/types.js';

const now = new Date('2026-09-13T00:00:00.000Z');

function seed(): Bookmark[] {
  let bookmarks: Bookmark[] = [];
  for (const path of ['/etc/nginx', '/var/log', '~/deploy']) {
    bookmarks = addBookmark(bookmarks, { hostId: 'web-01', path }, now).bookmarks;
  }
  return addBookmark(bookmarks, { hostId: 'db-02', path: '/var/lib/postgresql' }, now).bookmarks;
}

test('パスの末尾の / は無視する（同じ場所を二重に登録しない）', () => {
  assert.equal(normalizePath('/etc/nginx/'), '/etc/nginx');
  assert.equal(normalizePath('/etc//nginx'), '/etc/nginx');
  assert.equal(normalizePath('  /etc/nginx  '), '/etc/nginx');
  // ルートは残す
  assert.equal(normalizePath('/'), '/');
});

test('既定の表示名はパスの末尾のフォルダ名', () => {
  assert.equal(defaultLabel('/etc/nginx/'), 'nginx');
  assert.equal(defaultLabel('/'), '/');
  assert.equal(defaultLabel('~'), '~');
  assert.equal(defaultLabel('~/deploy'), 'deploy');
});

test('接続先ごとに、並び順どおりに返る', () => {
  const bookmarks = seed();
  assert.deepEqual(
    forHost(bookmarks, 'web-01').map((entry) => entry.path),
    ['/etc/nginx', '/var/log', '~/deploy'],
  );
  assert.equal(forHost(bookmarks, 'db-02').length, 1);
});

test('同じ接続先の同じパスは 1 つだけ（追加し直したら表示名を更新する）', () => {
  const bookmarks = seed();
  const result = addBookmark(
    bookmarks,
    { hostId: 'web-01', path: '/etc/nginx/', label: 'nginx 設定' },
    now,
  );
  assert.equal(forHost(result.bookmarks, 'web-01').length, 3);
  assert.equal(result.bookmark.label, 'nginx 設定');
  assert.equal(result.bookmark.path, '/etc/nginx');
});

test('接続先が違えば同じパスでも別に登録できる', () => {
  const bookmarks = addBookmark(seed(), { hostId: 'db-02', path: '/etc/nginx' }, now).bookmarks;
  assert.equal(forHost(bookmarks, 'db-02').length, 2);
  assert.equal(forHost(bookmarks, 'web-01').length, 3);
});

test('接続先を消したら、その接続先のブックマークも消える', () => {
  const bookmarks = removeForHost(seed(), 'web-01');
  assert.equal(forHost(bookmarks, 'web-01').length, 0);
  assert.equal(forHost(bookmarks, 'db-02').length, 1);
});

test('1 件だけ消せる', () => {
  const bookmarks = seed();
  const target = forHost(bookmarks, 'web-01')[1] as Bookmark;
  const removed = removeBookmark(bookmarks, target.id);
  assert.equal(removed.length, bookmarks.length - 1);
  assert.equal(
    removed.some((entry) => entry.id === target.id),
    false,
  );
});

test('並べ替えると order が振り直される', () => {
  const bookmarks = seed();
  const web = forHost(bookmarks, 'web-01');
  const ids = [web[2]?.id ?? '', web[0]?.id ?? '', web[1]?.id ?? ''];
  const reordered = forHost(reorder(bookmarks, 'web-01', ids), 'web-01');
  assert.deepEqual(
    reordered.map((entry) => entry.path),
    ['~/deploy', '/etc/nginx', '/var/log'],
  );
  assert.deepEqual(
    reordered.map((entry) => entry.order),
    [0, 1, 2],
  );
});

test('並べ替えの指定に無いものは後ろに残る（消えない）', () => {
  const bookmarks = seed();
  const web = forHost(bookmarks, 'web-01');
  const reordered = forHost(reorder(bookmarks, 'web-01', [web[2]?.id ?? '']), 'web-01');
  assert.equal(reordered.length, 3);
  assert.equal(reordered[0]?.path, '~/deploy');
});

test('並べ替えは他の接続先に触らない', () => {
  const bookmarks = seed();
  const before = forHost(bookmarks, 'db-02');
  const after = forHost(reorder(bookmarks, 'web-01', []), 'db-02');
  assert.deepEqual(after, before);
});

test('元の配列を書き換えない', () => {
  const bookmarks = seed();
  const snapshot = JSON.stringify(bookmarks);
  addBookmark(bookmarks, { hostId: 'web-01', path: '/opt' }, now);
  reorder(bookmarks, 'web-01', []);
  removeForHost(bookmarks, 'web-01');
  assert.equal(JSON.stringify(bookmarks), snapshot);
});
