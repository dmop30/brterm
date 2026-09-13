/**
 * 実行履歴の記録。
 *
 * 端末は打鍵しか流れてこないので、行の組み立ては `command-line.ts` が受け持つ。
 * ここは**残すかどうかの判断と、増えすぎない管理**だけを見る。
 *
 * 残さないもの:
 * - 空行(改行だけ叩いたとき)
 * - パスワードの入力中と判断した行(`CommandLine` が `secret` を立てる)
 * - 保持件数が 0 のとき(利用者が「残さない」を選んだ状態)
 */
import { randomUUID } from 'node:crypto';

import type { Database, HistoryEntry } from '../shared/types.js';

export interface RecordInput {
  hostId: string;
  command: string;
  exitCode?: number;
  /** 試験で時刻を固定できるようにしておく */
  at?: string;
}

/**
 * 履歴へ 1 行積む。積まなかったときは `undefined` を返す。
 *
 * 上限を超えた分は**古いものから落とす**。上限を下げたときも、その場で合わせる。
 */
export function recordCommand(db: Database, input: RecordInput): HistoryEntry | undefined {
  const command = input.command.trim();
  if (command === '') {
    return undefined;
  }
  const limit = db.settings.historyLimit;
  if (!Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }

  const entry: HistoryEntry = {
    id: randomUUID(),
    hostId: input.hostId,
    command,
    at: input.at ?? new Date().toISOString(),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  };
  db.history.push(entry);
  trimHistory(db);
  return entry;
}

/** 保持件数まで削る。新しいものを残す。 */
export function trimHistory(db: Database): void {
  const limit = Math.max(db.settings.historyLimit, 0);
  if (db.history.length > limit) {
    db.history.splice(0, db.history.length - limit);
  }
}

/** 新しい順に取り出す。`hostId` を渡せばその接続先だけ。 */
export function listHistory(
  db: Database,
  options: { hostId?: string; limit?: number } = {},
): HistoryEntry[] {
  const entries = options.hostId
    ? db.history.filter((entry) => entry.hostId === options.hostId)
    : [...db.history];
  entries.reverse();
  return options.limit === undefined ? entries : entries.slice(0, Math.max(options.limit, 0));
}
