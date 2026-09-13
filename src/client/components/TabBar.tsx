import { Plus, X } from 'lucide-react';

import type { Tab, TabsState } from '../lib/tabs';

interface Props {
  state: TabsState;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
}

function stateLabel(tab: Tab): string | undefined {
  if (tab.connection === 'connected') {
    return '接続中';
  }
  if (tab.connection === 'reconnecting') {
    return '再接続待ち';
  }
  return tab.connection === 'disconnected' ? '切断' : undefined;
}

/**
 * タブ列。端末タブとエディタタブを同じ列に並べる(要件定義 4.1)。
 *
 * 閉じるボタンをタブの中に置くため、タブ自体は button にしない
 * (button の入れ子は無効で、キーボード操作も壊れる)。
 */
export function TabBar({ state, onActivate, onClose, onAdd }: Props) {
  return (
    <div className="tabbar" role="tablist" aria-label="ワークスペース">
      {state.tabs.map((tab) => {
        const label = stateLabel(tab);
        const selected = tab.id === state.activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            className="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate(tab.id);
              }
            }}
          >
            {tab.connection && (
              <span
                className={`tab__state tab__state--${tab.connection}`}
                title={label}
                aria-label={label}
              />
            )}
            <span>{tab.title}</span>
            {tab.dirty && <span className="tab__dirty" title="未保存" aria-label="未保存" />}
            <button
              type="button"
              className="tab__close"
              aria-label={`${tab.title} を閉じる`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tabbar__add"
        aria-label="端末を開く"
        title="端末を開く"
        onClick={onAdd}
      >
        <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}
