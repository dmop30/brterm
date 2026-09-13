import { PanelLeftClose } from 'lucide-react';

import { RAIL_SECTIONS, type RailSection } from './Rail';

interface Props {
  section: RailSection;
  onCollapse: () => void;
  /** 端末を開く(接続先セクションから) */
  onOpenTerminal: () => void;
}

/**
 * 側パネル。中身は各 Issue で埋める。
 * ここでは**何が未実装なのかを画面に出す**(黙って空にしない)。
 */
const PLACEHOLDER: Record<RailSection, { empty: string; issue: string }> = {
  hosts: { empty: '接続先がまだありません。', issue: '接続先の登録と接続は #4 / #5 で入ります。' },
  files: { empty: 'ファイルツリーは未実装です。', issue: 'ツリーは #19 で入ります。' },
  procedures: { empty: '手順がまだありません。', issue: '履歴からの手順化は #14 で入ります。' },
  schedules: { empty: '予定がまだありません。', issue: '予定実行は #15 で入ります。' },
  settings: { empty: '設定項目はまだありません。', issue: '項目が確定する #15 で入ります。' },
};

export function SidePanel({ section, onCollapse, onOpenTerminal }: Props) {
  const label = RAIL_SECTIONS.find((entry) => entry.id === section)?.label ?? '';
  const placeholder = PLACEHOLDER[section];
  return (
    <aside className="side" aria-label={label}>
      <div className="side__head">
        <span className="side__title">{label}</span>
        <button
          type="button"
          className="button button--icon"
          aria-label="側パネルを畳む"
          title="側パネルを畳む"
          onClick={onCollapse}
        >
          <PanelLeftClose size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
      <div className="side__body">
        <div className="side__empty">
          <p>{placeholder.empty}</p>
          <p>{placeholder.issue}</p>
          {section === 'hosts' && (
            <button type="button" className="button" onClick={onOpenTerminal}>
              仮の端末タブを開く
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
