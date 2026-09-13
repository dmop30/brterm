/**
 * 打鍵から「いま打っている 1 行」を組み立てる。
 *
 * 端末に流れるのは鍵の並びだけなので、履歴や危険コマンドの確認をするには
 * **こちら側で行を組み立てる**しかない。シェルの補完や履歴呼び出しまでは追えないので、
 * 追えない場面は追えないと分かる形にしてある(`reset` で捨てる)。
 */

/** 打鍵の結果。行が確定したときだけ `line` が入る。 */
export interface FeedResult {
  /** 確定した行(前後の空白は落とす) */
  line?: string;
  /** パスワードの入力中だった。**履歴に残してはいけない**。 */
  secret?: boolean;
}

const BACKSPACE = ['\u007f', '\b'];
const CLEAR_LINE = '\u0015'; // Ctrl+U
const INTERRUPT = '\u0003'; // Ctrl+C
const ESCAPE = '\u001b';

/** 直前の出力がパスワードを求めていたか。 */
export function looksLikePasswordPrompt(output: string): boolean {
  const tail = output.slice(-200).split('\n').pop() ?? '';
  return /(password|passphrase|パスワード|パスフレーズ)[^\n]{0,20}[:：]\s*$/i.test(tail);
}

export class CommandLine {
  private buffer = '';
  private inEscape = false;
  private lastOutput = '';

  /** サーバからの出力。パスワードを求められているかの判断に使う。 */
  noteOutput(text: string): void {
    this.lastOutput = (this.lastOutput + text).slice(-400);
  }

  get pending(): string {
    return this.buffer;
  }

  get atPasswordPrompt(): boolean {
    return looksLikePasswordPrompt(this.lastOutput);
  }

  reset(): void {
    this.buffer = '';
  }

  /**
   * 控えを差し戻す。
   *
   * 危険コマンドの確認で改行を**送らずに保留**したとき、シェル側の行はそのまま残る。
   * こちらだけ空にすると以後の追跡がずれるため、保留した行を戻す。
   */
  restore(line: string): void {
    this.buffer = line;
  }

  /**
   * 1 文字食べる。改行が来たら行を確定して返す。
   * 矢印キーなどの制御列は**読み飛ばす**(行の組み立てには使えないため)。
   */
  feedChar(char: string): FeedResult {
    if (this.inEscape) {
      // 制御列は英字で終わる
      if (/[a-zA-Z~]/.test(char)) {
        this.inEscape = false;
      }
      return {};
    }
    if (char === ESCAPE) {
      this.inEscape = true;
      return {};
    }
    if (char === '\r' || char === '\n') {
      const line = this.buffer.trim();
      const secret = this.atPasswordPrompt;
      this.buffer = '';
      return secret ? { line, secret: true } : { line };
    }
    if (BACKSPACE.includes(char)) {
      this.buffer = this.buffer.slice(0, -1);
      return {};
    }
    if (char === CLEAR_LINE || char === INTERRUPT) {
      this.buffer = '';
      return {};
    }
    if (char === '\t') {
      // 補完でシェル側が行を書き換えるため、こちらの控えは当てにならない
      this.buffer = '';
      return {};
    }
    // 制御文字は捨てる
    if (char >= ' ') {
      this.buffer += char;
    }
    return {};
  }
}
