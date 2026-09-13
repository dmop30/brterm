/**
 * 開いているタブと面の配置を、ブラウザのタブの中に覚えておく。
 *
 * サーバ側のセッションはブラウザを閉じても生きている(要件定義 3 章)。
 * 画面側が「どのセッションを開いていたか」を忘れると、**リロードのたびに
 * 端末を開き直すことになる**ので、ここで覚えて繋ぎ直す(要件定義 5 章 L1)。
 *
 * `sessionStorage` に置くのは、この画面を閉じたら忘れてよいため。
 */
import type { Layout } from './layout';
import type { Tab } from './tabs';

const STORAGE_KEY = 'brterm.layout';
/** 形が変わったら上げる。古い形は読まずに捨てる。 */
const VERSION = 1;

interface Stored {
  version: number;
  layout: Layout;
}

/** 覚えておく必要のないもの(接続状態)は落として保存する。 */
function forStorage(layout: Layout): Layout {
  return {
    ...layout,
    groups: layout.groups.map((group) => ({
      ...group,
      tabs: {
        ...group.tabs,
        tabs: group.tabs.tabs.map((tab) => {
          const { connection: _connection, ...rest } = tab;
          return rest as Tab;
        }),
      },
    })),
  };
}

export function saveLayout(layout: Layout): void {
  try {
    const body: Stored = { version: VERSION, layout: forStorage(layout) };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(body));
  } catch {
    // 保存できなくても画面は動かす
  }
}

/** 形が違うものは黙って捨てる（壊れた状態で画面を組み立てない）。 */
export function parseLayout(raw: string | null): Layout | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const stored = parsed as Partial<Stored>;
  if (stored.version !== VERSION || !stored.layout) {
    return undefined;
  }
  const layout = stored.layout;
  if (
    !Array.isArray(layout.groups) ||
    layout.groups.length === 0 ||
    !Array.isArray(layout.sizes) ||
    layout.sizes.length !== layout.groups.length ||
    (layout.direction !== 'row' && layout.direction !== 'column')
  ) {
    return undefined;
  }
  if (
    !layout.groups.every(
      (group) => typeof group?.id === 'string' && Array.isArray(group.tabs?.tabs),
    )
  ) {
    return undefined;
  }
  return layout;
}

export function loadLayout(): Layout | undefined {
  try {
    return parseLayout(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function clearLayout(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 消せなくても困らない
  }
}
