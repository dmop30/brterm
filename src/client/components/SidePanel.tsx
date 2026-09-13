import { PanelLeftClose } from 'lucide-react';

import { HostsPanel, type HostView } from './HostsPanel';
import { RAIL_SECTIONS, type RailSection } from './Rail';

interface Props {
  section: RailSection;
  token?: string;
  onCollapse: () => void;
  /** 接続先を選んで端末を開く */
  onOpenHost: (host: HostView) => void;
}

/**
 * 側パネル。中身は各 Issue で埋める。
 * ここでは**何が未実装なのかを画面に出す**(黙って空にしない)。
 */
const PLACEHOLDER: Record<RailSection, { empty: string; issue: string }> = {
  hosts: { empty: '接続先がまだありません。', issue: '' },
  files: { empty: 'ファイルツリーは未実装です。', issue: 'ツリーは #19 で入ります。' },
  procedures: { empty: '手順がまだありません。', issue: '履歴からの手順化は #14 で入ります。' },
  schedules: { empty: '予定がまだありません。', issue: '予定実行は #15 で入ります。' },
  settings: { empty: '設定項目はまだありません。', issue: '項目が確定する #15 で入ります。' },
};

export function SidePanel({ section, token, onCollapse, onOpenHost }: Props) {
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
        {section === 'hosts' ? (
          <HostsPanel token={token} onOpen={onOpenHost} />
        ) : (
          <div className="side__empty">
            <p>{placeholder.empty}</p>
            <p>{placeholder.issue}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
