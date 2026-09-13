/**
 * ワークスペースの分割。
 *
 * 端末とファイルを縦または横に並べて同時に見るための状態。
 * 入れ子の分割はしない（向きはワークスペース全体で 1 つ）。
 * 運用の画面で迷子にならないことを優先し、**構造を単純に保つ**。
 *
 * 描かずに試験できるよう、ここは純粋な関数だけにする。
 */
import { closeTab, emptyTabs, openTab, type Tab, type TabsState } from './tabs';

export type SplitDirection = 'row' | 'column';

/** 分割で増える領域。面ごとにタブ列を持つ。 */
export interface PaneGroup {
  id: string;
  tabs: TabsState;
}

export interface Layout {
  direction: SplitDirection;
  groups: PaneGroup[];
  activeGroupId: string;
  /** 面の大きさの割合。`groups` と同じ長さで、合計は 1。 */
  sizes: number[];
}

/** 面の数の上限。これ以上は 1 面が狭すぎて使えない。 */
export const MAX_GROUPS = 4;

/** 面の最小の割合。ドラッグでこれ以下には潰さない。 */
export const MIN_SIZE = 0.12;

let counter = 0;
function nextGroupId(): string {
  counter += 1;
  return `pane-${counter}`;
}

export function createLayout(direction: SplitDirection = 'row'): Layout {
  const id = nextGroupId();
  return { direction, groups: [{ id, tabs: emptyTabs }], activeGroupId: id, sizes: [1] };
}

export function activeGroup(layout: Layout): PaneGroup {
  return (
    layout.groups.find((group) => group.id === layout.activeGroupId) ??
    (layout.groups[0] as PaneGroup)
  );
}

export function groupIndex(layout: Layout, groupId: string): number {
  return layout.groups.findIndex((group) => group.id === groupId);
}

/** 面ごとの大きさを均し直す（合計を 1 に保つ）。 */
function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) {
    return sizes.map(() => 1 / sizes.length);
  }
  return sizes.map((size) => size / total);
}

export function updateGroup(
  layout: Layout,
  groupId: string,
  update: (tabs: TabsState) => TabsState,
): Layout {
  return {
    ...layout,
    groups: layout.groups.map((group) =>
      group.id === groupId ? { ...group, tabs: update(group.tabs) } : group,
    ),
  };
}

/** どの面にあるタブでも、id で探して差し替える。 */
export function patchTab(layout: Layout, tabId: string, patch: Partial<Tab>): Layout {
  return {
    ...layout,
    groups: layout.groups.map((group) => ({
      ...group,
      tabs: {
        ...group.tabs,
        tabs: group.tabs.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
      },
    })),
  };
}

export function updateActiveGroup(layout: Layout, update: (tabs: TabsState) => TabsState): Layout {
  return updateGroup(layout, layout.activeGroupId, update);
}

/** 作業中の面にタブを開く。 */
export function openInActiveGroup(layout: Layout, tab: Tab): Layout {
  return updateActiveGroup(layout, (tabs) => openTab(tabs, tab));
}

/**
 * 分割する。
 *
 * 作業中の面の**隣に空の面**を作って、そこへ移る。
 * 「分割＝いまのタブを複製」にしないのは、端末のセッションを複製できないため。
 */
export function splitWorkspace(layout: Layout, direction: SplitDirection): Layout {
  if (layout.groups.length >= MAX_GROUPS) {
    return layout;
  }
  const index = groupIndex(layout, layout.activeGroupId);
  const at = index < 0 ? layout.groups.length - 1 : index;
  const id = nextGroupId();

  const groups = [...layout.groups];
  groups.splice(at + 1, 0, { id, tabs: emptyTabs });

  // 増えた分だけ既存を縮め、新しい面に等分の取り分を渡す
  const share = 1 / groups.length;
  const sizes = [...layout.sizes];
  sizes.splice(at + 1, 0, share);

  return {
    direction,
    groups,
    activeGroupId: id,
    sizes: normalize(
      sizes.map((size, position) => (position === at + 1 ? share : size * (1 - share))),
    ),
  };
}

/** 面を閉じる。**タブは隣の面へ移す**（閉じた拍子に作業が消えないように）。 */
export function closeGroup(layout: Layout, groupId: string): Layout {
  if (layout.groups.length <= 1) {
    return layout;
  }
  const index = groupIndex(layout, groupId);
  if (index < 0) {
    return layout;
  }
  const closing = layout.groups[index] as PaneGroup;
  const neighbourIndex = index === 0 ? 1 : index - 1;
  const neighbour = layout.groups[neighbourIndex] as PaneGroup;

  const merged: PaneGroup = {
    ...neighbour,
    tabs: closing.tabs.tabs.reduce((tabs, tab) => openTab(tabs, tab), neighbour.tabs),
  };

  const groups = layout.groups
    .map((group, position) => (position === neighbourIndex ? merged : group))
    .filter((_, position) => position !== index);
  const sizes = normalize(layout.sizes.filter((_, position) => position !== index));

  return { ...layout, groups, sizes, activeGroupId: merged.id };
}

/**
 * タブを閉じる。
 * 面が空になったら、その面も畳む(面が 1 つだけのときは残す)。
 */
export function closeTabIn(layout: Layout, groupId: string, tabId: string): Layout {
  const next = updateGroup(layout, groupId, (tabs) => closeTab(tabs, tabId));
  const group = next.groups.find((entry) => entry.id === groupId);
  if (!group || group.tabs.tabs.length > 0 || next.groups.length <= 1) {
    return next;
  }
  const index = groupIndex(next, groupId);
  const groups = next.groups.filter((entry) => entry.id !== groupId);
  const sizes = normalize(next.sizes.filter((_, position) => position !== index));
  const focused = groups[Math.max(0, index - 1)] as PaneGroup;
  return { ...next, groups, sizes, activeGroupId: focused.id };
}

export function focusGroup(layout: Layout, groupId: string): Layout {
  return layout.groups.some((group) => group.id === groupId)
    ? { ...layout, activeGroupId: groupId }
    : layout;
}

/** 番号（1 始まり）で面を選ぶ。 */
export function focusGroupByNumber(layout: Layout, number: number): Layout {
  const group = layout.groups[number - 1];
  return group ? focusGroup(layout, group.id) : layout;
}

/** タブを隣の面へ移す。移した先を作業中にする。 */
export function moveTabToNeighbour(layout: Layout, groupId: string, tabId: string): Layout {
  if (layout.groups.length <= 1) {
    return layout;
  }
  const index = groupIndex(layout, groupId);
  const source = layout.groups[index];
  const tab = source?.tabs.tabs.find((entry) => entry.id === tabId);
  if (!source || !tab) {
    return layout;
  }
  const targetIndex = index === layout.groups.length - 1 ? index - 1 : index + 1;
  const target = layout.groups[targetIndex] as PaneGroup;

  const moved: Layout = {
    ...layout,
    groups: layout.groups.map((group) => {
      if (group.id === source.id) {
        return { ...group, tabs: closeTab(group.tabs, tabId) };
      }
      if (group.id === target.id) {
        return { ...group, tabs: openTab(group.tabs, tab) };
      }
      return group;
    }),
    activeGroupId: target.id,
  };

  // 移した結果、元の面が空になったら畳む
  const emptied = moved.groups.find((group) => group.id === source.id);
  if (emptied && emptied.tabs.tabs.length === 0) {
    const groups = moved.groups.filter((group) => group.id !== source.id);
    const sizes = normalize(moved.sizes.filter((_, position) => position !== index));
    return { ...moved, groups, sizes };
  }
  return moved;
}

/**
 * 境界をドラッグしたときの大きさ。
 * `index` は境界の左（上）の面。どちらも `MIN_SIZE` を下回らせない。
 */
export function resizeAt(layout: Layout, index: number, delta: number): Layout {
  const before = layout.sizes[index];
  const after = layout.sizes[index + 1];
  if (before === undefined || after === undefined) {
    return layout;
  }
  const room = before + after;
  const nextBefore = Math.min(Math.max(before + delta, MIN_SIZE), room - MIN_SIZE);
  const sizes = [...layout.sizes];
  sizes[index] = nextBefore;
  sizes[index + 1] = room - nextBefore;
  return { ...layout, sizes };
}

/** 並びの向きを変える（面はそのまま）。 */
export function setDirection(layout: Layout, direction: SplitDirection): Layout {
  return { ...layout, direction };
}

/**
 * CSS の `grid-template-*` に渡す値。
 *
 * **面と面の間の境界も 1 本のトラックとして数える。** 面の分しか書かないと、
 * 境界が自動生成のトラックに入り、面の割合がずれる(実際にこれで隙間が出た)。
 */
export const SPLITTER_TRACK = '1px';

export function gridTemplate(layout: Layout): string {
  return layout.sizes.map((size) => `${size}fr`).join(` ${SPLITTER_TRACK} `);
}
