/**
 * 配色の決定。
 *
 * 3 つの状態を扱う: 利用者が `dark` / `light` を選んだとき、`system`(OS に従う)。
 * 初回起動は `system`(要件定義 7 章)。
 */
/**
 * 配色の選択。いまは画面側だけが持つ。
 * 設定として保存するようになったら `src/shared/types.ts` の `Settings.theme` に寄せる(#15)。
 */
export type ThemePreference = 'system' | 'dark' | 'light';

export type ResolvedTheme = 'dark' | 'light';

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'dark' || preference === 'light') {
    return preference;
  }
  return prefersDark ? 'dark' : 'light';
}

/**
 * 決めた配色を反映する。
 *
 * CSS 側は `[data-theme]` と `prefers-color-scheme` の両方を見るので、ここは属性を置くだけ。
 * 引数を DOM の型にせず最小の形にしてあるのは、**画面を作らずに試験できるようにする**ため。
 */
export interface ThemeTarget {
  dataset: { theme?: string };
}

export function applyTheme(target: ThemeTarget, theme: ResolvedTheme): void {
  target.dataset.theme = theme;
}

/** 次の配色(設定画面の切り替え用)。system → dark → light → system。 */
export function nextPreference(preference: ThemePreference): ThemePreference {
  if (preference === 'system') {
    return 'dark';
  }
  return preference === 'dark' ? 'light' : 'system';
}

export function preferenceLabel(preference: ThemePreference): string {
  if (preference === 'dark') {
    return '暗い配色';
  }
  return preference === 'light' ? '明るい配色' : 'OS に合わせる';
}
