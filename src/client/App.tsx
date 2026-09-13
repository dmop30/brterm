import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { HealthResponse } from '../shared/types';
import { Pane } from './components/Pane';
import { Rail, type RailSection } from './components/Rail';
import { SidePanel } from './components/SidePanel';
import { StatusBar, type ServerState } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import {
  activeTab,
  closeTab,
  emptyTabs,
  openTab,
  stepTab,
  activateTab,
  type TabsState,
} from './lib/tabs';
import { applyTheme, nextPreference, resolveTheme, type ThemePreference } from './lib/theme';
import './styles/global.css';

/** 配色の選択は端末ごとの好みなので、ブラウザ側に覚えさせる。 */
const THEME_STORAGE_KEY = 'brterm.theme';

function storedTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === 'dark' || value === 'light' || value === 'system') {
      return value;
    }
  } catch {
    // 取得できない環境(プライベートウィンドウなど)では既定に落とす
  }
  return 'system';
}

export function App() {
  const [section, setSection] = useState<RailSection>('hosts');
  // 狭い画面では最初から畳んでおく。端末に使える幅を確保するため。
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 720);
  const [tabs, setTabs] = useState<TabsState>(emptyTabs);
  const [theme, setTheme] = useState<ThemePreference>(storedTheme);
  const [server, setServer] = useState<ServerState>({ kind: 'loading' });
  // タブの通し番号。閉じても番号を使い回さない(同じ名前のタブが並ぶと見分けられないため)。
  const terminalCount = useRef(0);

  const current = useMemo(() => activeTab(tabs), [tabs]);

  // 配色: 明示選択は属性で、`system` は OS の変更にも追従する
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyTheme(document.documentElement, resolveTheme(theme, media.matches));
    apply();
    media.addEventListener('change', apply);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // 保存できなくても画面は動かす
    }
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  // サーバの状態。失敗したら理由を画面に出す(黙って空にしない)
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`サーバが ${response.status} を返しました`);
        }
        return (await response.json()) as HealthResponse;
      })
      .then((health) => setServer({ kind: 'ok', version: health.version, locked: health.locked }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setServer({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, []);

  const openTerminal = useCallback(() => {
    terminalCount.current += 1;
    const index = terminalCount.current;
    setTabs((previous) =>
      openTab(previous, {
        id: `terminal-${index}`,
        kind: 'terminal',
        title: `端末 ${index}`,
        detail: '接続先は #4 / #5 で選べるようになります',
        connection: 'disconnected',
      }),
    );
  }, []);

  // ショートカット(要件定義 7 章: 主要操作にキーボードショートカット)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        setTabs((previous) => stepTab(previous, event.shiftKey ? -1 : 1));
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 't') {
        event.preventDefault();
        openTerminal();
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        setTabs((previous) =>
          previous.activeId ? closeTab(previous, previous.activeId) : previous,
        );
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        setSideOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openTerminal]);

  return (
    <div className={sideOpen ? 'shell' : 'shell shell--side-collapsed'}>
      <Rail
        current={section}
        onSelect={(next) => {
          // 同じセクションをもう一度押したら畳む(VS Code と同じ手触り)
          setSideOpen((open) => (next === section ? !open : true));
          setSection(next);
        }}
      />
      {sideOpen && (
        <SidePanel
          section={section}
          onCollapse={() => setSideOpen(false)}
          onOpenTerminal={openTerminal}
        />
      )}
      <main className="workspace">
        <TabBar
          state={tabs}
          onActivate={(id) => setTabs((previous) => activateTab(previous, id))}
          onClose={(id) => setTabs((previous) => closeTab(previous, id))}
          onAdd={openTerminal}
        />
        <Pane tab={current} />
        <StatusBar
          tab={current}
          server={server}
          theme={theme}
          onToggleTheme={() => setTheme(nextPreference)}
        />
      </main>
    </div>
  );
}
