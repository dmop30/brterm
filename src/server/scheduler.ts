/**
 * 予定実行(cron)。
 *
 * 決めごと:
 * 1. **過ぎた予定の取り返し運転はしない**(要件定義 11 章)。止まっていた間の分は流さない。
 *    次回時刻は「今」から計算し直す
 * 2. **ホスト鍵が未確認なら実行しない。** 人が見ていないところで未知の鍵を受け入れない
 * 3. **ログに機密を書かない**(要件定義 8 章)。コマンド中のパスワードらしき値は伏せ、
 *    出力は先頭だけに切る
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CronExpressionParser } from 'cron-parser';

import type { Database, Schedule } from '../shared/types.js';
import type { DataKey } from './crypto.js';
import { AppError } from './errors.js';
import { secretsFor } from './secrets.js';
import { connect } from './ssh.js';
import { profileFor } from './store.js';

/** 次に実行する時刻。式がおかしければ理由を添えて止める。 */
export function nextRunAt(cron: string, from: Date = new Date()): Date {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from }).next().toDate();
  } catch (cause) {
    throw new AppError(
      'schedule_invalid_cron',
      `予定の書き方が正しくありません: ${cron}`,
      (cause as Error).message,
    );
  }
}

/** 式として読めるか。画面の入力確認に使う。 */
export function isValidCron(cron: string): boolean {
  try {
    nextRunAt(cron, new Date());
    return true;
  } catch {
    return false;
  }
}

/** ログに出してはいけない値を伏せる。判断は**多めに伏せる**側へ倒す。 */
export function maskSecrets(text: string): string {
  return (
    text
      // VAR=値 の形(PASSWORD / TOKEN / SECRET / KEY を含む名前)
      .replace(
        /\b([A-Za-z_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|APIKEY|API_KEY)[A-Za-z_]*)=([^\s"']+)/gi,
        '$1=***',
      )
      // --password=値 / --token 値
      .replace(/(--(?:password|token|secret|api-key)[= ])([^\s"']+)/gi, '$1***')
      // mysql の -p値(-p 単体は伏せる必要がない)
      .replace(/(\s-p)(?!\s)([^\s"']+)/g, '$1***')
      // Authorization ヘッダ
      .replace(/(Bearer\s+)([^\s"']+)/gi, '$1***')
  );
}

/** 実行した 1 コマンドの結果。 */
export interface CommandOutcome {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 接続してコマンドを流す役。試験では差し替える。 */
export type Executor = (db: Database, schedule: Schedule) => Promise<{ results: CommandOutcome[] }>;

/**
 * 実際に SSH で流す役。
 *
 * **未確認のホスト鍵は受け入れない。** 人が見ていないところで鍵を受け入れると、
 * 中間者と区別が付かなくなる(要件定義 1 章)。端末で一度繋いで確認してもらう。
 */
export function createSshExecutor(key: DataKey): Executor {
  return async (db, schedule) => {
    const host = db.hosts.find((entry) => entry.id === schedule.hostId);
    if (!host) {
      throw new AppError('ssh_no_session', `接続先が見つかりません（${schedule.hostId}）。`);
    }
    const session = await connect({
      host,
      profile: profileFor(db, host),
      ...secretsFor(key, host),
      known: db.knownHostKeys,
      onUnknownHostKey: () => Promise.resolve(false),
    });
    try {
      const results: CommandOutcome[] = [];
      for (const command of schedule.commands) {
        const result = await session.exec(command);
        results.push({ command, code: result.code, stdout: result.stdout, stderr: result.stderr });
      }
      return { results };
    } finally {
      // 予定実行は繋ぎっぱなしにしない
      session.close();
    }
  };
}

export interface RunOptions {
  logsDir: string;
  executor: Executor;
  now?: Date;
  /** 金庫が施錠されているか。施錠中は実行せず、記録だけ残す(要件定義 6 章) */
  locked?: () => boolean;
  /** ログに残す出力の行数。既定 20 行 */
  outputLines?: number;
}

function logPath(dir: string, schedule: Schedule): string {
  return join(dir, `${schedule.id}.log`);
}

function write(dir: string, schedule: Schedule, lines: string[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(logPath(dir, schedule), `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** ログを読む。無ければ空(まだ動いていないだけで、異常ではない)。 */
export function readLog(dir: string, schedule: Schedule): string {
  const path = logPath(dir, schedule);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * 予定を 1 回実行してログに残す。
 * 例外は投げず、**結果を `lastStatus` に書いて返す**(1 件の失敗で予定全体を止めないため)。
 */
export async function runSchedule(
  db: Database,
  schedule: Schedule,
  options: RunOptions,
): Promise<Schedule['lastStatus']> {
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const host = db.hosts.find((entry) => entry.id === schedule.hostId);
  const hostLabel = host?.label ?? schedule.hostId;

  schedule.lastRunAt = stamp;

  if (options.locked?.() === true) {
    // 施錠中は秘密を開けない。黙って飛ばさず、飛ばしたことを残す
    schedule.lastStatus = 'skipped';
    write(options.logsDir, schedule, [
      `${stamp} [見送り] ${schedule.label}（${hostLabel}）金庫が施錠されているため実行しません`,
    ]);
    return 'skipped';
  }

  const lines = [`${stamp} [開始] ${schedule.label}（${hostLabel}）`];
  let status: Schedule['lastStatus'] = 'ok';

  try {
    const { results } = await options.executor(db, schedule);
    for (const result of results) {
      lines.push(
        `${stamp} [実行] ${maskSecrets(result.command)} 終了コード=${result.code ?? '不明'}`,
      );
      const output = [result.stdout, result.stderr].join('').trimEnd();
      if (output !== '') {
        const limit = options.outputLines ?? 20;
        const rows = maskSecrets(output).split('\n');
        for (const row of rows.slice(0, limit)) {
          lines.push(`${stamp} [出力] ${row}`);
        }
        if (rows.length > limit) {
          lines.push(`${stamp} [出力] …残り ${rows.length - limit} 行は省略しました`);
        }
      }
      if (result.code !== 0) {
        status = 'failed';
      }
    }
  } catch (error) {
    status = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`${stamp} [失敗] ${maskSecrets(message)}`);
  }

  lines.push(`${stamp} [終了] ${status === 'ok' ? '成功' : '失敗'}`);
  write(options.logsDir, schedule, lines);
  schedule.lastStatus = status;
  return status;
}

export interface SchedulerOptions extends Omit<RunOptions, 'now'> {
  /** 見に行く間隔。既定 30 秒 */
  intervalMs?: number;
  /** 変更を保存する */
  save: () => void;
}

/**
 * 予定の見張り役。
 *
 * 次回時刻は**起動した時点から**計算する。止まっていた間に過ぎた分は流さない。
 */
export class Scheduler {
  private readonly db: Database;
  private readonly options: SchedulerOptions;
  private readonly nextAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(db: Database, options: SchedulerOptions) {
    this.db = db;
    this.options = options;
  }

  /** いまの予定から次回時刻を組み直す。予定を足した・直したときにも呼ぶ。 */
  plan(now: Date = new Date()): void {
    this.nextAt.clear();
    for (const schedule of this.db.schedules) {
      if (!schedule.enabled) {
        continue;
      }
      try {
        this.nextAt.set(schedule.id, nextRunAt(schedule.cron, now).getTime());
      } catch {
        // 式がおかしい予定は動かさない。画面側で直してもらう
      }
    }
  }

  /** 次回時刻。画面に出す用。 */
  nextFor(scheduleId: string): Date | undefined {
    const at = this.nextAt.get(scheduleId);
    return at === undefined ? undefined : new Date(at);
  }

  start(now: Date = new Date()): void {
    this.plan(now);
    const interval = this.options.intervalMs ?? 30000;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    // 見張りのせいでプロセスが終われなくなると、CLI が止まらない
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined as never;
    }
  }

  /** 時刻が来た予定を実行する。重なって走らないよう、1 本ずつ流す。 */
  async tick(now: Date = new Date()): Promise<Schedule[]> {
    if (this.running) {
      return [];
    }
    this.running = true;
    const ran: Schedule[] = [];
    try {
      for (const schedule of this.db.schedules) {
        const at = this.nextAt.get(schedule.id);
        if (!schedule.enabled || at === undefined || at > now.getTime()) {
          continue;
        }
        await runSchedule(this.db, schedule, { ...this.options, now });
        ran.push(schedule);
        // 次回は**今から**。溜まっていた分は流さない
        this.nextAt.set(schedule.id, nextRunAt(schedule.cron, now).getTime());
      }
      if (ran.length > 0) {
        this.options.save();
      }
    } finally {
      this.running = false;
    }
    return ran;
  }
}
