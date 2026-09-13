/**
 * ディレクトリのブックマーク。
 *
 * 判断のある部分(パスの正規化・重複の扱い・並び順)をここに集めて、
 * API から切り離して試験できるようにする。
 */
import { randomUUID } from 'node:crypto';

import type { Bookmark } from '../shared/types.js';

/**
 * パスを揃える。
 * `/etc/nginx/` と `/etc/nginx` を別のブックマークにしない。
 */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') {
    return '';
  }
  const collapsed = trimmed.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/** 既定の表示名はパスの末尾のフォルダ名。`/` と `~` はそのまま出す。 */
export function defaultLabel(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/' || normalized === '~' || normalized === '') {
    return normalized || '/';
  }
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

export function forHost(bookmarks: readonly Bookmark[], hostId: string): Bookmark[] {
  return bookmarks.filter((entry) => entry.hostId === hostId).sort((a, b) => a.order - b.order);
}

/**
 * 追加する。**同じ接続先の同じパスは 1 つだけ**にする。
 * 既にあるなら、表示名だけを新しいものに更新する(追加し直した意図を汲む)。
 */
export function addBookmark(
  bookmarks: readonly Bookmark[],
  input: { hostId: string; path: string; label?: string },
  now: Date = new Date(),
): { bookmarks: Bookmark[]; bookmark: Bookmark } {
  const path = normalizePath(input.path);
  const label = input.label?.trim() || defaultLabel(path);
  const existing = bookmarks.find((entry) => entry.hostId === input.hostId && entry.path === path);

  if (existing) {
    const updated: Bookmark = { ...existing, label };
    return {
      bookmarks: bookmarks.map((entry) => (entry.id === existing.id ? updated : entry)),
      bookmark: updated,
    };
  }

  const siblings = forHost(bookmarks, input.hostId);
  const last = siblings[siblings.length - 1];
  const bookmark: Bookmark = {
    id: randomUUID(),
    hostId: input.hostId,
    path,
    label,
    order: last ? last.order + 1 : 0,
    createdAt: now.toISOString(),
  };
  return { bookmarks: [...bookmarks, bookmark], bookmark };
}

export function removeBookmark(bookmarks: readonly Bookmark[], id: string): Bookmark[] {
  return bookmarks.filter((entry) => entry.id !== id);
}

/** 接続先を消したら、その接続先のブックマークも消す(迷子の記録を残さない)。 */
export function removeForHost(bookmarks: readonly Bookmark[], hostId: string): Bookmark[] {
  return bookmarks.filter((entry) => entry.hostId !== hostId);
}

/** 並べ替え。渡された順に 0 から振り直す。知らない id は無視する。 */
export function reorder(bookmarks: readonly Bookmark[], hostId: string, ids: string[]): Bookmark[] {
  const target = forHost(bookmarks, hostId);
  const ordered = ids
    .map((id) => target.find((entry) => entry.id === id))
    .filter((entry): entry is Bookmark => entry !== undefined);
  // 指定に無いものは、元の並びのまま後ろへ
  const rest = target.filter((entry) => !ids.includes(entry.id));
  const renumbered = [...ordered, ...rest].map((entry, index) => ({ ...entry, order: index }));

  return bookmarks.map((entry) => renumbered.find((item) => item.id === entry.id) ?? entry);
}
