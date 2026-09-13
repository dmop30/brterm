import { Clock, FolderTree, ListOrdered, Plug, Settings } from 'lucide-react';

/** 左レールのセクション。語彙は要件定義 3 章・4.1 に合わせる。 */
export type RailSection = 'hosts' | 'files' | 'procedures' | 'schedules' | 'settings';

export const RAIL_SECTIONS: { id: RailSection; label: string }[] = [
  { id: 'hosts', label: '接続先' },
  { id: 'files', label: 'ファイル' },
  { id: 'procedures', label: '手順' },
  { id: 'schedules', label: '予定' },
  { id: 'settings', label: '設定' },
];

const ICONS = {
  hosts: Plug,
  files: FolderTree,
  procedures: ListOrdered,
  schedules: Clock,
  settings: Settings,
} as const;

interface Props {
  current: RailSection;
  onSelect: (section: RailSection) => void;
}

export function Rail({ current, onSelect }: Props) {
  return (
    <nav className="rail" aria-label="セクション">
      {RAIL_SECTIONS.map(({ id, label }, index) => {
        const Icon = ICONS[id];
        // 設定だけ下端に置く。運用中に押す頻度が違うため。
        const isLast = index === RAIL_SECTIONS.length - 1;
        return (
          <div key={id} style={{ display: 'contents' }}>
            {isLast && <div className="rail__spacer" />}
            <button
              type="button"
              className="rail__button"
              aria-current={current === id}
              aria-label={label}
              title={label}
              onClick={() => onSelect(id)}
            >
              <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </nav>
  );
}
