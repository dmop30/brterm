/**
 * 手順(Procedure)の組み立てと Markdown 書き出し。
 *
 * 手順は「後から人が読んで、同じことをやり直せる」ためのものなので、
 * 書き出しは**そのまま貼れる Markdown** にする。出力に ``` が含まれていても
 * 崩れないよう、囲みの長さは中身に合わせて伸ばす。
 *
 * ステップの種類は今は `command` だけ。`fileEdit` はフェーズ 8 で足す(要件定義 4.7)。
 */
import { randomUUID } from 'node:crypto';

import type { CommandStep, HistoryEntry, Procedure, ProcedureStep } from '../shared/types.js';

export interface StepInput {
  command: string;
  output?: string;
  exitCode?: number;
  note?: string;
  at?: string;
}

export function makeStep(input: StepInput): CommandStep {
  return {
    kind: 'command',
    id: randomUUID(),
    command: input.command.trim(),
    at: input.at ?? new Date().toISOString(),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}

/** 履歴からステップを起こす。実行時刻は履歴のものを引き継ぐ。 */
export function stepsFromHistory(entries: HistoryEntry[]): CommandStep[] {
  return entries.map((entry) =>
    makeStep({
      command: entry.command,
      at: entry.at,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    }),
  );
}

export function makeProcedure(input: {
  title: string;
  hostId?: string;
  steps?: ProcedureStep[];
  at?: string;
}): Procedure {
  const now = input.at ?? new Date().toISOString();
  return {
    id: randomUUID(),
    title: input.title.trim(),
    ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
    steps: input.steps ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * コードブロックの囲み。
 * 中身に含まれる ``` の最長連続より 1 つ長くする(短いと途中で閉じてしまう)。
 */
function fence(body: string): string {
  const longest = [...body.matchAll(/`+/g)].reduce((max, hit) => Math.max(max, hit[0].length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function block(body: string, language = ''): string {
  const mark = fence(body);
  // 末尾に改行が無いと閉じの ``` が行頭に来ない
  const text = body.endsWith('\n') ? body.slice(0, -1) : body;
  return `${mark}${language}\n${text}\n${mark}`;
}

export interface MarkdownOptions {
  /** 接続先の表示名。分かるときだけ添える */
  hostLabel?: string;
}

/** 手順を Markdown にする。 */
export function toMarkdown(procedure: Procedure, options: MarkdownOptions = {}): string {
  const lines: string[] = [`# ${procedure.title}`, ''];

  if (options.hostLabel) {
    lines.push(`- 接続先: ${options.hostLabel}`);
  }
  lines.push(`- 作成: ${procedure.createdAt}`, `- 更新: ${procedure.updatedAt}`, '');

  if (procedure.steps.length === 0) {
    lines.push('手順はまだありません。', '');
    return lines.join('\n');
  }

  procedure.steps.forEach((step, index) => {
    lines.push(`## ${index + 1}. ${step.command}`, '');
    lines.push(block(step.command, 'sh'), '');
    if (step.note) {
      lines.push(step.note, '');
    }
    if (step.output !== undefined && step.output !== '') {
      lines.push('実行結果:', '', block(step.output), '');
    }
    if (step.exitCode !== undefined) {
      lines.push(`終了コード: ${step.exitCode}`, '');
    }
  });

  return lines.join('\n');
}
