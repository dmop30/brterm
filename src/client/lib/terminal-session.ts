/**
 * 端末 1 つ分の WebSocket。
 *
 * 画面（xterm.js）と `src/server/ws.ts` のあいだを繋ぐ。
 * `socketFactory` を差し替えられるようにしてあるのは、**画面を描かずに試験する**ため。
 */
import type { ClientMessage, ServerMessage } from '../../shared/protocol';

/** 画面側で使う最小限の WebSocket。ブラウザの WebSocket がそのまま当てはまる。 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: never) => void,
  ): void;
}

export type SessionListener = (message: ServerMessage) => void;

export interface TerminalSessionOptions {
  url: string;
  socketFactory?: (url: string) => SocketLike;
}

/** 接続の状態。画面はこれをタブとステータスバーに出す。 */
export type LinkState = 'connecting' | 'open' | 'closed' | 'error';

export class TerminalSession {
  private readonly socket: SocketLike;
  private readonly listeners = new Set<SessionListener>();
  private readonly stateListeners = new Set<(state: LinkState) => void>();
  /** 開く前に送ろうとしたものを溜めておく（接続が開くまで送れないため） */
  private readonly queue: ClientMessage[] = [];
  private state: LinkState = 'connecting';
  private opened = false;

  constructor(options: TerminalSessionOptions) {
    const factory =
      options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this.socket = factory(options.url);

    this.socket.addEventListener('open', (() => {
      this.opened = true;
      this.setState('open');
      for (const message of this.queue.splice(0)) {
        this.socket.send(JSON.stringify(message));
      }
    }) as (event: never) => void);

    this.socket.addEventListener('message', ((event: { data: unknown }) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const listener of this.listeners) {
        listener(message);
      }
    }) as unknown as (event: never) => void);

    this.socket.addEventListener('close', (() => this.setState('closed')) as (
      event: never,
    ) => void);
    this.socket.addEventListener('error', (() => this.setState('error')) as (event: never) => void);
  }

  private setState(state: LinkState): void {
    this.state = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  get linkState(): LinkState {
    return this.state;
  }

  onMessage(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(listener: (state: LinkState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  send(message: ClientMessage): void {
    if (!this.opened) {
      this.queue.push(message);
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  open(hostId: string, cols: number, rows: number): void {
    this.send({ type: 'open', hostId, cols, rows });
  }

  attach(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'attach', sessionId, cols, rows });
  }

  input(data: string): void {
    this.send({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows });
  }

  answerHostKey(accept: boolean): void {
    this.send({ type: 'hostkey-decision', accept });
  }

  /** 画面を閉じるだけ。**サーバ側のセッションは切らない**（繋ぎ直せるようにする）。 */
  detach(): void {
    this.socket.close();
  }

  /** セッションごと終わらせる。 */
  close(): void {
    this.send({ type: 'close' });
    this.socket.close();
  }
}
