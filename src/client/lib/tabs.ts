/**
 * ワークスペースのタブの状態。
 *
 * なぜ純粋な関数に切り出すか: 画面を描かずに試験できるようにするため。
 * DOM を使う試験には追加の依存が要る(要件定義 7 章「依存を増やさない」)ので、
 * 判断のある部分だけをここに寄せている。
 */

/** タブの種類。端末とファイル(エディタ)は同じ列に並ぶ(要件定義 4.1)。 */
export type TabKind = 'terminal' | 'editor' | 'settings';

/** 接続の状態。色だけでなく文言でも出す。 */
export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export interface Tab {
  id: string;
  kind: TabKind;
  /** タブに出す短い名前(ファイル名・接続先名) */
  title: string;
  /** ステータスバーに出す詳細(パス・ホスト名) */
  detail?: string;
  /** 未保存の印。タブに ● を出す。 */
  dirty?: boolean;
  /** 端末タブだけが持つ */
  connection?: ConnectionState;
  /** 端末タブの繋ぎ先 */
  hostId?: string;
  /** サーバ側のセッション。繋ぎ直しに使う。 */
  sessionId?: string;
  /** 書き込み権限が無いファイル */
  readOnly?: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeId?: string;
}

export const emptyTabs: TabsState = { tabs: [] };

export function activeTab(state: TabsState): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeId);
}

/** 同じ id のタブが既にあるときは開き直さず、そのタブへ移る。 */
export function openTab(state: TabsState, tab: Tab): TabsState {
  if (state.tabs.some((existing) => existing.id === tab.id)) {
    return { ...state, activeId: tab.id };
  }
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * タブを閉じる。
 * 閉じたのが作業中のタブなら、**右隣へ移る**。右が無ければ左へ。
 * (閉じるたびに先頭へ飛ぶと作業位置を失うため)
 */
export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    return state;
  }
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) {
    return { ...state, activeId: state.activeId };
  }
  const next = tabs[index] ?? tabs[index - 1];
  return next ? { tabs, activeId: next.id } : { tabs, activeId: undefined };
}

export function activateTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

/** Ctrl+Tab / Ctrl+Shift+Tab の巡回。端では折り返す。 */
export function stepTab(state: TabsState, delta: 1 | -1): TabsState {
  if (state.tabs.length === 0) {
    return state;
  }
  const current = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const from = current < 0 ? 0 : current;
  const length = state.tabs.length;
  const next = state.tabs[(from + delta + length) % length];
  return next ? { ...state, activeId: next.id } : state;
}

/** 未保存の印を立てる・降ろす。 */
export function setDirty(state: TabsState, id: string, dirty: boolean): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, dirty } : tab)),
  };
}

/** 閉じるときに確認が要るタブ(未保存のもの)。 */
export function needsCloseConfirm(state: TabsState, id: string): boolean {
  return state.tabs.find((tab) => tab.id === id)?.dirty === true;
}
