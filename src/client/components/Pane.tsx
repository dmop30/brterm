import type { Tab } from '../lib/tabs';

interface Props {
  tab?: Tab;
  onAddTerminal?: () => void;
}

/** 既定のキー。ブラウザが握っている組み合わせ（Ctrl+T / Ctrl+W など）は避ける。 */
const SHORTCUTS: [string, string][] = [
  ['Alt+T', '端末を開く'],
  ['Alt+W', '作業中のタブを閉じる'],
  ['Alt+[ / Alt+]', '前 / 次のタブへ'],
  ['Alt+\\', '横に分割（左右）'],
  ['Alt+Shift+\\', '縦に分割（上下）'],
  ['Alt+1 … Alt+4', 'その番号の面へ移る'],
  ['Alt+Q', 'この面を閉じる（タブは隣の面へ）'],
  ['Alt+B', '側パネルを畳む / 出す'],
  ['Ctrl+S', '保存（エディタ。#20 で有効になります）'],
];

/**
 * タブの中身。端末(#12)とエディタ(#20)で置き換える。
 * いまは**この画面で何ができるか**とショートカットを出しておく。
 */
export function Pane({ tab, onAddTerminal }: Props) {
  if (!tab) {
    return (
      <div className="pane pane--empty">
        <h2>タブを開いていません</h2>
        <p>左のレールからセクションを選ぶか、この面で端末を開きます。</p>
        {onAddTerminal && (
          <button type="button" className="button" onClick={onAddTerminal}>
            この面で端末を開く
          </button>
        )}
        <table className="keys">
          <tbody>
            {SHORTCUTS.map(([key, description]) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td>{description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="pane">
      <h2>{tab.title}</h2>
      <dl>
        <dt>種類</dt>
        <dd>{tab.kind === 'terminal' ? '端末' : tab.kind === 'editor' ? 'エディタ' : '設定'}</dd>
        <dt>詳細</dt>
        <dd className="mono">{tab.detail ?? '—'}</dd>
        {tab.connection && (
          <>
            <dt>接続</dt>
            <dd>
              {tab.connection === 'connected'
                ? '接続中'
                : tab.connection === 'reconnecting'
                  ? '再接続待ち'
                  : '切断'}
            </dd>
          </>
        )}
      </dl>
      <p style={{ marginTop: 'var(--space-3)', color: 'var(--dim)' }}>
        {tab.kind === 'terminal'
          ? '端末の描画は #12（xterm.js）で入ります。この枠はその置き場所です。'
          : 'エディタは #20（CodeMirror 6）で入ります。'}
      </p>
    </div>
  );
}
