import type { Tab } from '../lib/tabs';
import { preferenceLabel, type ThemePreference } from '../lib/theme';

/** サーバとの接続状況。画面の下端に文言で出す(色だけに頼らない)。 */
export type ServerState =
  | { kind: 'loading' }
  | { kind: 'ok'; version: string; locked: boolean }
  | { kind: 'error'; message: string };

interface Props {
  tab?: Tab;
  server: ServerState;
  theme: ThemePreference;
  onToggleTheme: () => void;
}

export function StatusBar({ tab, server, theme, onToggleTheme }: Props) {
  return (
    <div className="status" role="status">
      <div className="status__item status__item--path">{tab?.detail ?? 'タブを開いていません'}</div>
      {tab?.readOnly && <div className="status__item status__item--accent">読み取り専用</div>}
      {tab?.dirty && <div className="status__item status__item--warn">● 未保存</div>}
      <button
        type="button"
        className="status__item"
        onClick={onToggleTheme}
        title="配色を切り替える"
      >
        {preferenceLabel(theme)}
      </button>
      {server.kind === 'loading' && <div className="status__item status__right">サーバ確認中</div>}
      {server.kind === 'ok' && (
        <div className="status__item status__right">
          brterm {server.version} · {server.locked ? '施錠中' : '解錠済み'}
        </div>
      )}
      {server.kind === 'error' && (
        <div className="status__item status__right status__item--danger">
          サーバに繋がりません: {server.message}
        </div>
      )}
    </div>
  );
}
