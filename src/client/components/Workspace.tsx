import { useCallback, useRef } from 'react';

import {
  activeGroup,
  gridTemplate,
  type Layout,
  type PaneGroup,
  type SplitDirection,
} from '../lib/layout';
import { activeTab, type ConnectionState } from '../lib/tabs';
import { Pane } from './Pane';
import { TabBar } from './TabBar';

interface Props {
  layout: Layout;
  token?: string;
  onSession: (tabId: string, sessionId: string) => void;
  onConnectionChange: (tabId: string, state: ConnectionState) => void;
  onFocusGroup: (groupId: string) => void;
  onActivateTab: (groupId: string, tabId: string) => void;
  onCloseTab: (groupId: string, tabId: string) => void;
  onAddTerminal: (groupId: string) => void;
  onSplit: (groupId: string, direction: SplitDirection) => void;
  onCloseGroup: (groupId: string) => void;
  onResize: (index: number, delta: number) => void;
}

/**
 * 面を並べる。向きはワークスペース全体で 1 つ（入れ子の分割はしない）。
 *
 * 境界のドラッグは割合で扱う。画素で持つと、窓の大きさを変えたときに
 * 面の比率が崩れるため。
 */
export function Workspace({
  layout,
  token,
  onSession,
  onConnectionChange,
  onFocusGroup,
  onActivateTab,
  onCloseTab,
  onAddTerminal,
  onSplit,
  onCloseGroup,
  onResize,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const focused = activeGroup(layout);

  const startDrag = useCallback(
    (index: number, event: React.PointerEvent<HTMLDivElement>) => {
      const element = container.current;
      if (!element) {
        return;
      }
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const total = layout.direction === 'row' ? box.width : box.height;
      let last = layout.direction === 'row' ? event.clientX : event.clientY;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent) => {
        const current = layout.direction === 'row' ? moveEvent.clientX : moveEvent.clientY;
        const delta = (current - last) / total;
        last = current;
        onResize(index, delta);
      };
      const stop = () => {
        target.releasePointerCapture(event.pointerId);
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', stop);
        target.removeEventListener('pointercancel', stop);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', stop);
      target.addEventListener('pointercancel', stop);
    },
    [layout.direction, onResize],
  );

  const style =
    layout.direction === 'row'
      ? { gridTemplateColumns: gridTemplate(layout) }
      : { gridTemplateRows: gridTemplate(layout) };

  return (
    <div
      ref={container}
      className={`panes panes--${layout.direction}`}
      style={style}
      data-pane-count={layout.groups.length}
    >
      {layout.groups.map((group: PaneGroup, index) => (
        <div key={group.id} style={{ display: 'contents' }}>
          {index > 0 && (
            <div
              className="splitter"
              role="separator"
              aria-orientation={layout.direction === 'row' ? 'vertical' : 'horizontal'}
              aria-label="面の境界"
              tabIndex={0}
              onPointerDown={(event) => startDrag(index - 1, event)}
              onKeyDown={(event) => {
                // キーボードでも動かせるようにする(要件定義 7 章 操作性)
                const step = 0.02;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  onResize(index - 1, -step);
                }
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  onResize(index - 1, step);
                }
              }}
            />
          )}
          <section
            className={`pane-group${group.id === focused.id && layout.groups.length > 1 ? ' pane-group--active' : ''}`}
            aria-label={`面 ${index + 1}`}
            onFocus={() => onFocusGroup(group.id)}
            onPointerDown={() => onFocusGroup(group.id)}
          >
            <TabBar
              state={group.tabs}
              onActivate={(tabId) => onActivateTab(group.id, tabId)}
              onClose={(tabId) => onCloseTab(group.id, tabId)}
              onAdd={() => onAddTerminal(group.id)}
              onSplitRow={() => onSplit(group.id, 'row')}
              onSplitColumn={() => onSplit(group.id, 'column')}
              {...(layout.groups.length > 1 ? { onCloseGroup: () => onCloseGroup(group.id) } : {})}
            />
            <Pane
              tab={activeTab(group.tabs)}
              {...(token ? { token } : {})}
              onAddTerminal={() => onAddTerminal(group.id)}
              onSession={onSession}
              onConnectionChange={onConnectionChange}
            />
          </section>
        </div>
      ))}
    </div>
  );
}
