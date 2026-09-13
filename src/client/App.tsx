import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { HealthResponse } from '../shared/types';
import type { HostView } from './components/HostsPanel';
import { Rail, type RailSection } from './components/Rail';
import { SidePanel } from './components/SidePanel';
import { StatusBar, type ServerState } from './components/StatusBar';
import { Workspace } from './components/Workspace';
import {
  activeGroup,
  closeGroup,
  closeTabIn,
  createLayout,
  focusGroup,
  focusGroupByNumber,
  openInActiveGroup,
  patchTab,
  resizeAt,
  splitWorkspace,
  updateGroup,
  type Layout,
  type SplitDirection,
} from './lib/layout';
import { loadLayout, saveLayout } from './lib/persist';
import { activateTab, activeTab, stepTab, type ConnectionState } from './lib/tabs';
import { applyTheme, nextPreference, resolveTheme, type ThemePreference } from './lib/theme';
import { rememberToken, storedToken, tokenFromSearch } from './lib/token';
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
  // リロードしても続きから戻れるよう、開いていたタブと面を覚えておく
  const [layout, setLayout] = useState<Layout>(() => loadLayout() ?? createLayout());
  const [theme, setTheme] = useState<ThemePreference>(storedTheme);
  const [server, setServer] = useState<ServerState>({ kind: 'loading' });
  // トークンは起動時の URL で受け取り、以降はこのタブの中で覚える
  const [token] = useState<string | undefined>(() => {
    const fromUrl = tokenFromSearch(window.location.search);
    if (fromUrl) {
      rememberToken(fromUrl);
      // URL に残すと、画面の共有や履歴から漏れる
      window.history.replaceState(null, '', window.location.pathname);
      return fromUrl;
    }
    return storedToken();
  });

  // タブの通し番号。閉じても番号を使い回さない(同じ名前のタブが並ぶと見分けられないため)。
  const terminalCount = useRef(0);

  const current = useMemo(() => activeTab(activeGroup(layout).tabs), [layout]);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

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

  /** 接続先を選んで端末を開く。接続先を渡さないときは、選ぶ前の空のタブを開く。 */
  const openTerminalIn = useCallback((host?: HostView, groupId?: string) => {
    terminalCount.current += 1;
    const index = terminalCount.current;
    const tab = {
      id: `terminal-${index}`,
      kind: 'terminal' as const,
      title: host ? host.label : `端末 ${index}`,
      detail: host ? `${host.username}@${host.hostname}:${host.port}` : '接続先を選んでください',
      connection: 'disconnected' as const,
      ...(host ? { hostId: host.id } : {}),
    };
    setLayout((previous) =>
      groupId
        ? openInActiveGroup(focusGroup(previous, groupId), tab)
        : openInActiveGroup(previous, tab),
    );
  }, []);

  /** 端末が繋がったら、そのセッション番号をタブに覚えさせる（繋ぎ直しに使う）。 */
  const noteSession = useCallback((tabId: string, sessionId: string) => {
    setLayout((previous) => patchTab(previous, tabId, { sessionId }));
  }, []);

  const noteConnection = useCallback((tabId: string, connection: ConnectionState) => {
    setLayout((previous) => patchTab(previous, tabId, { connection }));
  }, []);

  const split = useCallback((groupId: string | undefined, direction: SplitDirection) => {
    setLayout((previous) =>
      splitWorkspace(groupId ? focusGroup(previous, groupId) : previous, direction),
    );
  }, []);

  // ショートカット。**ブラウザが握っている組み合わせ(Ctrl+T / Ctrl+W / Ctrl+数字)は避け**、
  // Alt を既定にする。Ctrl+Tab は Electron 用に残す。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab') {
        event.preventDefault();
        setLayout((previous) =>
          updateGroup(previous, previous.activeGroupId, (tabs) =>
            stepTab(tabs, event.shiftKey ? -1 : 1),
          ),
        );
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 't') {
        event.preventDefault();
        openTerminalIn();
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        setLayout((previous) => {
          const group = activeGroup(previous);
          const tab = activeTab(group.tabs);
          return tab ? closeTabIn(previous, group.id, tab.id) : previous;
        });
        return;
      }
      if (key === 'q') {
        event.preventDefault();
        setLayout((previous) => closeGroup(previous, previous.activeGroupId));
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        setSideOpen((open) => !open);
        return;
      }
      if (key === '[' || key === ']') {
        event.preventDefault();
        setLayout((previous) =>
          updateGroup(previous, previous.activeGroupId, (tabs) =>
            stepTab(tabs, key === ']' ? 1 : -1),
          ),
        );
        return;
      }
      if (event.code === 'Backslash' || key === '\\') {
        event.preventDefault();
        split(undefined, event.shiftKey ? 'column' : 'row');
        return;
      }
      const number = Number.parseInt(key, 10);
      if (Number.isInteger(number) && number >= 1 && number <= 9) {
        event.preventDefault();
        setLayout((previous) => focusGroupByNumber(previous, number));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openTerminalIn, split]);

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
          {...(token ? { token } : {})}
          onCollapse={() => setSideOpen(false)}
          onOpenHost={(host) => openTerminalIn(host)}
        />
      )}
      <main className="workspace">
        <Workspace
          layout={layout}
          {...(token ? { token } : {})}
          onSession={noteSession}
          onConnectionChange={noteConnection}
          onFocusGroup={(groupId) => setLayout((previous) => focusGroup(previous, groupId))}
          onActivateTab={(groupId, tabId) =>
            setLayout((previous) =>
              updateGroup(focusGroup(previous, groupId), groupId, (tabs) =>
                activateTab(tabs, tabId),
              ),
            )
          }
          onCloseTab={(groupId, tabId) =>
            setLayout((previous) => closeTabIn(previous, groupId, tabId))
          }
          onAddTerminal={(groupId) => openTerminalIn(undefined, groupId)}
          onSplit={(groupId, direction) => split(groupId, direction)}
          onCloseGroup={(groupId) => setLayout((previous) => closeGroup(previous, groupId))}
          onResize={(index, delta) => setLayout((previous) => resizeAt(previous, index, delta))}
        />
        <StatusBar
          tab={current}
          server={server}
          theme={theme}
          paneCount={layout.groups.length}
          onToggleTheme={() => setTheme(nextPreference)}
        />
      </main>
    </div>
  );
}
