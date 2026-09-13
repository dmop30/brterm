import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

import type { ServerMessage } from '../../shared/protocol';
import type { ConnectionState } from '../lib/tabs';
import { TerminalSession } from '../lib/terminal-session';
import { websocketUrl } from '../lib/token';
import { HostKeyDialog } from './HostKeyDialog';

interface Props {
  /** 繋ぎ先の接続先 */
  hostId: string;
  /** 既にあるセッション（繋ぎ直すとき） */
  sessionId?: string;
  token?: string;
  onSession: (sessionId: string) => void;
  onConnectionChange: (state: ConnectionState) => void;
}

interface Prompt {
  hostname: string;
  port: number;
  fingerprint: string;
}

/** xterm.js の見た目を、画面設計 v1 の配色に合わせる。 */
function themeFromCss(root: HTMLElement): Record<string, string> {
  const style = getComputedStyle(root);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: value('--bg', '#151a21'),
    foreground: value('--fg', '#e3e8ee'),
    cursor: value('--accent', '#4fa3c7'),
    selectionBackground: value('--accent-soft', '#22303c'),
  };
}

export function TerminalTab({ hostId, sessionId, token, onSession, onConnectionChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<TerminalSession | null>(null);
  const [prompt, setPrompt] = useState<Prompt>();
  const [error, setError] = useState<string>();

  /**
   * 呼び出し先と繋ぎ直しの番号は**控えで持つ**。
   *
   * 親から渡る関数は描画のたびに別物になるため、依存に入れると
   * 「効果が再実行 → WebSocket を張り直す → 状態が変わって再描画」を無限に繰り返す。
   * 実際にこれで、繋がる前に切断され続ける不具合を出した。
   */
  const callbacks = useRef({ onSession, onConnectionChange });
  const initialSessionId = useRef(sessionId);

  // 控えの更新は描画中ではなく、描画のあとに行う
  useEffect(() => {
    callbacks.current = { onSession, onConnectionChange };
  });

  const answer = useCallback((accept: boolean) => {
    setPrompt(undefined);
    session.current?.answerHostKey(accept);
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }

    const terminal = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      cursorBlink: true,
      theme: themeFromCss(document.documentElement),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);

    /**
     * 画面側のショートカットを端末に食わせない。
     *
     * xterm は押された鍵をほぼ全部シェルへ送るので、端末にフォーカスがあると
     * Alt+T や Alt+\ が効かなくなる（実際にこれで分割できなかった）。
     * false を返すと xterm は処理せず、画面側の受け口に届く。
     */
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        return false;
      }
      return !(event.ctrlKey && event.key === 'Tab');
    });

    terminal.open(element);
    fit.fit();

    const link = new TerminalSession({ url: websocketUrl(window.location, token) });
    session.current = link;
    callbacks.current.onConnectionChange('reconnecting');

    const offMessage = link.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'opened':
          callbacks.current.onSession(message.sessionId);
          callbacks.current.onConnectionChange('connected');
          if (message.snapshot) {
            terminal.write(message.snapshot);
          }
          terminal.focus();
          return;
        case 'data':
          terminal.write(message.data);
          return;
        case 'hostkey':
          setPrompt({
            hostname: message.hostname,
            port: message.port,
            fingerprint: message.fingerprint,
          });
          return;
        case 'closed':
          callbacks.current.onConnectionChange('disconnected');
          terminal.writeln('\r\n-- 切断されました --');
          return;
        case 'error':
          // 覚えていたセッションが既に無いなら、**黙って諦めずに開き直す**
          if (message.code === 'ssh_no_session' && initialSessionId.current) {
            initialSessionId.current = undefined;
            callbacks.current.onConnectionChange('reconnecting');
            link.open(hostId, terminal.cols, terminal.rows);
            return;
          }
          callbacks.current.onConnectionChange('disconnected');
          setError(message.message);
          return;
      }
    });

    const offState = link.onStateChange((state) => {
      if (state === 'closed' || state === 'error') {
        callbacks.current.onConnectionChange('disconnected');
      }
    });

    // 画面の大きさに追従させる（サーバ側の端末にも伝える）。
    // **桁・行が変わったときだけ**送る。毎回送ると、わずかな揺れで往復が止まらない。
    let lastSize = { cols: terminal.cols, rows: terminal.rows };
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (terminal.cols !== lastSize.cols || terminal.rows !== lastSize.rows) {
        lastSize = { cols: terminal.cols, rows: terminal.rows };
        link.resize(terminal.cols, terminal.rows);
      }
    });
    observer.observe(element);

    terminal.onData((data) => link.input(data));

    const existing = initialSessionId.current;
    if (existing) {
      link.attach(existing, terminal.cols, terminal.rows);
    } else {
      link.open(hostId, terminal.cols, terminal.rows);
    }

    return () => {
      observer.disconnect();
      offMessage();
      offState();
      // **セッションは切らない。** タブを閉じても繋ぎ直せるようにする
      link.detach();
      terminal.dispose();
      session.current = null;
    };
    // 張り直すのは、**繋ぎ先かトークンが変わったときだけ**
  }, [hostId, token]);

  return (
    <div className="terminal">
      <div className="terminal__screen" ref={host} />
      {error && (
        <p className="terminal__error" role="alert">
          {error}
        </p>
      )}
      {prompt && <HostKeyDialog {...prompt} onAnswer={answer} />}
    </div>
  );
}
