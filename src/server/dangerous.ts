/**
 * 危険なコマンドの判定。
 *
 * **止めるのは「取り返しがつかない」ものだけ**にする。何でも確認を出すと、
 * 利用者は読まずに押すようになり、確認が意味を失う(要件定義 1 章)。
 *
 * 判定は文字列の見た目で行う。シェルの意味まで解釈はしない。
 * 見落とし(偽陰性)はあり得るが、**確認を出したものには必ず理由を添える**。
 */

export interface DangerVerdict {
  dangerous: boolean;
  /** 画面に出す理由。「なぜ危ないか」を 1 行で。 */
  reason?: string;
  /** 文言を強い表現に切り替える対象(システム領域) */
  systemPath?: string;
}

/** 書き込むと動いているものを壊しやすい場所(要件定義 4.3)。 */
const SYSTEM_PATHS = ['/etc', '/boot', '/usr', '/var/lib', '/bin', '/sbin', '/lib'];

/**
 * 余分な空白を落とし、**先頭の `sudo` / `doas` を外す**。
 * 付けただけで判定を逃れられては意味がない。
 */
function normalize(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[;&|]\s*)(sudo|doas)\s+/g, '$1');
}

function touchesSystemPath(command: string): string | undefined {
  return SYSTEM_PATHS.find(
    (path) => command.includes(`${path}/`) || new RegExp(`\\s${path}(\\s|$)`).test(command),
  );
}

interface Rule {
  test: RegExp;
  reason: string;
}

/**
 * 規則。順番に見て、最初に当たったものを理由にする。
 * **消す・潰す・止める**の 3 系統に絞ってある。
 */
const RULES: Rule[] = [
  {
    test: /(^|[;&|]\s*)rm\s+(-[a-z]*[rf][a-z]*\s+)+/,
    reason: 'ファイルやフォルダを消します。取り消せません。',
  },
  {
    test: /(^|[;&|]\s*)rm\s+.*\s-[a-z]*[rf]/,
    reason: 'ファイルやフォルダを消します。取り消せません。',
  },
  { test: /(^|[;&|]\s*)(shred|wipefs)\s/, reason: '内容を消去します。復元できません。' },
  {
    test: /(^|[;&|]\s*)mkfs(\.\w+)?\s/,
    reason: 'ファイルシステムを作り直します。中身は全部消えます。',
  },
  {
    test: /(^|[;&|]\s*)dd\s+.*of=\/dev\//,
    reason: 'デバイスに直接書き込みます。中身は全部消えます。',
  },
  {
    test: /(^|[;&|]\s*)(shutdown|reboot|halt|poweroff)(\s|$)/,
    reason: 'サーバを停止・再起動します。',
  },
  { test: /(^|[;&|]\s*)(init\s+0|init\s+6)(\s|$)/, reason: 'サーバを停止・再起動します。' },
  { test: /systemctl\s+(stop|restart|disable|mask)\s/, reason: 'サービスを止めます。' },
  {
    test: /(^|[;&|]\s*)chmod\s+(-R\s+)?(777|-R\s+\d{3})\s+\//,
    reason: '広い範囲の権限を変えます。',
  },
  { test: /(^|[;&|]\s*)chown\s+-R\s/, reason: '広い範囲の持ち主を変えます。' },
  { test: /(^|[;&|]\s*)truncate\s+-s\s*0\s/, reason: 'ファイルを空にします。' },
  { test: /(^|[;&|]\s*)(kill|pkill|killall)\s+-9\s/, reason: 'プロセスを強制終了します。' },
  { test: /:\(\)\s*\{.*\}\s*;\s*:/, reason: 'プロセスを増やし続けます（フォーク爆弾）。' },
];

/** `>` による上書き。追記(`>>`)は含めない。 */
const OVERWRITE = /[^>]>(?!>)\s*(\/[^\s;|&]+)/;

export function judgeCommand(rawCommand: string): DangerVerdict {
  const command = normalize(rawCommand);
  if (command === '') {
    return { dangerous: false };
  }

  for (const rule of RULES) {
    if (rule.test.test(command)) {
      const systemPath = touchesSystemPath(command);
      return {
        dangerous: true,
        reason: rule.reason,
        ...(systemPath ? { systemPath } : {}),
      };
    }
  }

  const overwrite = OVERWRITE.exec(command);
  if (overwrite?.[1]) {
    const target = overwrite[1];
    const systemPath = SYSTEM_PATHS.find(
      (path) => target.startsWith(`${path}/`) || target === path,
    );
    if (systemPath) {
      return {
        dangerous: true,
        reason: `${target} を上書きします。元の内容は残りません。`,
        systemPath,
      };
    }
  }

  return { dangerous: false };
}

/** 確認ダイアログに出す文言。**対象を必ず含める**(要件定義 12 章 5)。 */
export function confirmMessage(command: string, verdict: DangerVerdict, hostname: string): string {
  const head = verdict.systemPath
    ? `${hostname} の ${verdict.systemPath} 配下に対する操作です。稼働中の設定を壊す可能性があります。`
    : `${hostname} で次のコマンドを実行します。`;
  // 何を実行しようとしているかを、そのまま見せる
  return `${head}\n${command}\n${verdict.reason ?? ''}`;
}
