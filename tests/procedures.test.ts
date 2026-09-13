import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeProcedure, makeStep, stepsFromHistory, toMarkdown } from '../src/server/procedures.js';
import type { HistoryEntry } from '../src/shared/types.js';

const AT = '2026-09-13T01:02:03.000Z';

test('履歴から手順のステップを起こす（実行時刻を引き継ぐ）', () => {
  const entries: HistoryEntry[] = [
    { id: '1', hostId: 'h1', command: 'nginx -t', at: AT, exitCode: 0 },
    { id: '2', hostId: 'h1', command: 'systemctl reload nginx', at: AT },
  ];
  const steps = stepsFromHistory(entries);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.kind, 'command');
  assert.equal(steps[0]?.at, AT);
  assert.equal(steps[0]?.exitCode, 0);
  assert.equal('exitCode' in (steps[1] ?? {}), false);
});

test('題名とコマンドが Markdown に出る', () => {
  const procedure = makeProcedure({
    title: 'nginx の設定を入れ替える',
    at: AT,
    steps: [makeStep({ command: 'nginx -t', at: AT, exitCode: 0 })],
  });
  const markdown = toMarkdown(procedure, { hostLabel: 'web-01' });
  assert.match(markdown, /^# nginx の設定を入れ替える$/m);
  assert.match(markdown, /- 接続先: web-01/);
  assert.match(markdown, /^## 1\. nginx -t$/m);
  assert.match(markdown, /```sh\nnginx -t\n```/);
  assert.match(markdown, /終了コード: 0/);
});

test('接続先が分からなければ書かない', () => {
  const procedure = makeProcedure({ title: '手順', at: AT, steps: [] });
  assert.equal(toMarkdown(procedure).includes('接続先'), false);
});

test('実行結果と注記も出る', () => {
  const procedure = makeProcedure({
    title: '確認',
    at: AT,
    steps: [
      makeStep({
        command: 'df -h',
        output: '/dev/sda1  20G  8.0G  11G  43% /',
        note: '空きが 20% を切っていたら片付ける',
        at: AT,
      }),
    ],
  });
  const markdown = toMarkdown(procedure);
  assert.match(markdown, /実行結果:/);
  assert.match(markdown, /43% \//);
  assert.match(markdown, /空きが 20% を切っていたら片付ける/);
});

test('出力に ``` が入っていても囲みが壊れない', () => {
  const output = 'コードの例:\n```\nserver { }\n```\n';
  const procedure = makeProcedure({
    title: 'コード片を含む',
    at: AT,
    steps: [makeStep({ command: 'cat README.md', output, at: AT })],
  });
  const markdown = toMarkdown(procedure);
  // 中身の ``` より長い囲みで包む
  assert.match(markdown, /````\nコードの例:/);
  assert.match(markdown, /```\n````/);
  // 囲みの数が合っていること（奇数なら開いたままになる）
  const fences = markdown.match(/^`{3,}/gm) ?? [];
  assert.equal(fences.length % 2, 0, `囲みが閉じていない: ${fences.join(',')}`);
});

test('ステップが無ければ、無いと書く', () => {
  const markdown = toMarkdown(makeProcedure({ title: '空の手順', at: AT }));
  assert.match(markdown, /手順はまだありません。/);
});

test('題名の前後の空白は落とす', () => {
  assert.equal(makeProcedure({ title: '  片付け  ', at: AT }).title, '片付け');
});
