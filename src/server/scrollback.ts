/**
 * 端末の表示を覚えておく入れ物。
 *
 * ブラウザを閉じてもセッションは生きているので(要件定義 3 章)、再接続したときに
 * **直前までの表示を戻す**ために要る。無制限に持つと長時間のセッションで
 * メモリを食い潰すため、上限を超えた分は古い方から捨てる。
 */
export class Scrollback {
  private readonly limit: number;
  private chunks: string[] = [];
  private length = 0;

  constructor(limitBytes = 256 * 1024) {
    this.limit = limitBytes;
  }

  append(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.length -= dropped?.length ?? 0;
    }
    // 1 つの塊だけで上限を超える場合は、その塊の末尾だけ残す
    const only = this.chunks[0];
    if (this.chunks.length === 1 && only !== undefined && only.length > this.limit) {
      this.chunks = [only.slice(only.length - this.limit)];
      this.length = this.limit;
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }

  get size(): number {
    return this.length;
  }

  clear(): void {
    this.chunks = [];
    this.length = 0;
  }
}
