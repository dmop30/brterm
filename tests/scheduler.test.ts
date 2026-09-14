import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isAppError } from '../src/server/errors.js';
import {
  isValidCron,
  maskSecrets,
  nextRunAt,
  readLog,
  runSchedule,
  Scheduler,
  type CommandOutcome,
  type Executor,
} from '../src/server/scheduler.js';
import { defaultDatabase } from '../src/server/store.js';
import type { Database, Schedule } from '../src/shared/types.js';

function logsDir(): string {
  return mkdtempSync(join(tmpdir(), 'brterm-logs-'));
}

function database(schedule: Partial<Schedule> = {}): { db: Database; schedule: Schedule } {
  const db = defaultDatabase();
  const entry: Schedule = {
    id: 's1',
    label: 'ログの後始末',
    hostId: 'h1',
    cron: '0 3 * * *',
    commands: ['find /var/log -name "*.gz" -mtime +30'],
    enabled: true,
    ...schedule,
  };
  db.schedules.push(entry);
  db.hosts.push({
    id: 'h1',
    label: 'web-01',
    hostname: '10.0.0.1',
    port: 22,
    username: 'ops',
    authMethod: 'password',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  });
  return { db, schedule: entry };
}

/** 流したコマンドを控えるだけの実行役。 */
function fakeExecutor(
  results: CommandOutcome[],
  record: { commands: string[] } = { commands: [] },
): Executor {
  return (_db, schedule) => {
    record.commands.push(...schedule.commands);
    return Promise.resolve({ results });
  };
}

test('次回実行時刻を出す', () => {
  const next = nextRunAt('0 3 * * *', new Date('2026-09-13T00:00:00Z'));
  assert.equal(next.toISOString(), '2026-09-13T03:00:00.000Z');
});

test('すでに過ぎた時刻なら、翌日の同じ時刻になる', () => {
  const next = nextRunAt('0 3 * * *', new Date('2026-09-13T04:00:00Z'));
  assert.equal(next.toISOString(), '2026-09-14T03:00:00.000Z');
});

test('曜日指定も読める', () => {
  // 月曜 9:00。2026-09-13 は日曜
  const next = nextRunAt('0 9 * * 1', new Date('2026-09-13T00:00:00Z'));
  assert.equal(next.toISOString(), '2026-09-14T09:00:00.000Z');
});

test('書き方がおかしければ、理由を添えて止める', () => {
  assert.throws(
    () => nextRunAt('おかしい'),
    (error: unknown) => isAppError(error) && error.code === 'schedule_invalid_cron',
  );
  assert.equal(isValidCron('おかしい'), false);
  assert.equal(isValidCron('0 3 * * *'), true);
});

test('ログに書く前に、パスワードらしき値を伏せる', () => {
  assert.equal(maskSecrets('mysqldump -u ops -phimitsu db'), 'mysqldump -u ops -p*** db');
  assert.equal(maskSecrets('PGPASSWORD=himitsu psql'), 'PGPASSWORD=*** psql');
  assert.equal(maskSecrets('curl --token abcdef'), 'curl --token ***');
  assert.equal(
    maskSecrets('curl -H "Authorization: Bearer abcdef"'),
    'curl -H "Authorization: Bearer ***"',
  );
  assert.equal(maskSecrets('API_KEY=xyz env'), 'API_KEY=*** env');
  // 伏せる必要のないものは変えない
  assert.equal(maskSecrets('ls -la /var/log'), 'ls -la /var/log');
  assert.equal(maskSecrets('tar -xzf a.tgz'), 'tar -xzf a.tgz');
});

test('実行するとログに残り、成功が記録される', async () => {
  const dir = logsDir();
  const { db, schedule } = database();
  const status = await runSchedule(db, schedule, {
    logsDir: dir,
    executor: fakeExecutor([
      { command: 'uptime', code: 0, stdout: 'load average: 0.1\n', stderr: '' },
    ]),
    now: new Date('2026-09-13T03:00:00Z'),
  });

  assert.equal(status, 'ok');
  assert.equal(schedule.lastStatus, 'ok');
  assert.equal(schedule.lastRunAt, '2026-09-13T03:00:00.000Z');

  const log = readLog(dir, schedule);
  assert.match(log, /\[開始\] ログの後始末（web-01）/);
  assert.match(log, /\[実行\] uptime 終了コード=0/);
  assert.match(log, /\[出力\] load average: 0\.1/);
  assert.match(log, /\[終了\] 成功/);
});

test('終了コードが 0 でなければ失敗として残す', async () => {
  const dir = logsDir();
  const { db, schedule } = database();
  const status = await runSchedule(db, schedule, {
    logsDir: dir,
    executor: fakeExecutor([
      { command: 'nginx -t', code: 1, stdout: '', stderr: 'syntax error\n' },
    ]),
  });
  assert.equal(status, 'failed');
  assert.equal(schedule.lastStatus, 'failed');
  assert.match(readLog(dir, schedule), /\[出力\] syntax error/);
  assert.match(readLog(dir, schedule), /\[終了\] 失敗/);
});

test('繋がらなくても落とさず、失敗として残す', async () => {
  const dir = logsDir();
  const { db, schedule } = database();
  const status = await runSchedule(db, schedule, {
    logsDir: dir,
    executor: () => Promise.reject(new Error('10.0.0.1 への接続に失敗しました。')),
  });
  assert.equal(status, 'failed');
  assert.match(readLog(dir, schedule), /\[失敗\] 10\.0\.0\.1 への接続に失敗しました。/);
});

test('ログに残す出力は先頭だけに切る', async () => {
  const dir = logsDir();
  const { db, schedule } = database();
  const stdout = Array.from({ length: 30 }, (_, index) => `行${index + 1}`).join('\n');
  await runSchedule(db, schedule, {
    logsDir: dir,
    executor: fakeExecutor([{ command: 'cat big.log', code: 0, stdout, stderr: '' }]),
    outputLines: 5,
  });
  const log = readLog(dir, schedule);
  assert.match(log, /\[出力\] 行5/);
  assert.equal(log.includes('行6'), false, '切っていない');
  assert.match(log, /残り 25 行は省略しました/);
});

test('コマンド中の秘密はログに出さない', async () => {
  const dir = logsDir();
  const { db, schedule } = database({ commands: ['mysqldump -u ops -phimitsu db'] });
  await runSchedule(db, schedule, {
    logsDir: dir,
    executor: fakeExecutor([
      { command: 'mysqldump -u ops -phimitsu db', code: 0, stdout: '', stderr: '' },
    ]),
  });
  const log = readLog(dir, schedule);
  assert.equal(log.includes('himitsu'), false, 'パスワードがログに出た');
  assert.match(log, /-p\*\*\*/);
});

test('施錠中は実行せず、見送ったことを残す', async () => {
  const dir = logsDir();
  const { db, schedule } = database();
  const record = { commands: [] as string[] };
  const status = await runSchedule(db, schedule, {
    logsDir: dir,
    executor: fakeExecutor([], record),
    locked: () => true,
  });
  assert.equal(status, 'skipped');
  assert.deepEqual(record.commands, [], '施錠中なのに流した');
  assert.match(readLog(dir, schedule), /\[見送り\].*金庫が施錠されている/);
});

test('時刻が来た予定だけ流す', async () => {
  const dir = logsDir();
  const { db, schedule } = database();
  const record = { commands: [] as string[] };
  const scheduler = new Scheduler(db, {
    logsDir: dir,
    executor: fakeExecutor([{ command: 'x', code: 0, stdout: '', stderr: '' }], record),
    save: () => undefined,
  });
  scheduler.plan(new Date('2026-09-13T00:00:00Z'));
  assert.equal(scheduler.nextFor(schedule.id)?.toISOString(), '2026-09-13T03:00:00.000Z');

  // まだ時刻が来ていない
  assert.deepEqual(await scheduler.tick(new Date('2026-09-13T02:59:00Z')), []);
  assert.deepEqual(record.commands, []);

  const ran = await scheduler.tick(new Date('2026-09-13T03:00:00Z'));
  assert.deepEqual(
    ran.map((item) => item.id),
    [schedule.id],
  );
  assert.equal(record.commands.length, 1);
});

test('過ぎた分の取り返し運転はしない', async () => {
  const dir = logsDir();
  const { db, schedule } = database({ cron: '*/10 * * * *' });
  const record = { commands: [] as string[] };
  const scheduler = new Scheduler(db, {
    logsDir: dir,
    executor: fakeExecutor([{ command: 'x', code: 0, stdout: '', stderr: '' }], record),
    save: () => undefined,
  });
  scheduler.plan(new Date('2026-09-13T00:00:00Z'));

  // 3 時間止まっていた（18 回分過ぎている）。流すのは 1 回だけ
  await scheduler.tick(new Date('2026-09-13T03:00:00Z'));
  assert.equal(record.commands.length, 1, '溜まった分を流してしまった');
  // 次回は「今」から数え直す
  assert.equal(scheduler.nextFor(schedule.id)?.toISOString(), '2026-09-13T03:10:00.000Z');
});

test('止めてある予定は流さない', async () => {
  const dir = logsDir();
  const { db, schedule } = database({ enabled: false });
  const record = { commands: [] as string[] };
  const scheduler = new Scheduler(db, {
    logsDir: dir,
    executor: fakeExecutor([], record),
    save: () => undefined,
  });
  scheduler.plan(new Date('2026-09-13T00:00:00Z'));
  assert.equal(scheduler.nextFor(schedule.id), undefined);
  assert.deepEqual(await scheduler.tick(new Date('2026-09-14T03:00:00Z')), []);
});

test('書き方がおかしい予定は動かさない（他の予定は動く）', async () => {
  const dir = logsDir();
  const { db } = database({ id: 's1', cron: 'おかしい' });
  db.schedules.push({
    id: 's2',
    label: '正しい方',
    hostId: 'h1',
    cron: '0 3 * * *',
    commands: ['uptime'],
    enabled: true,
  });
  const record = { commands: [] as string[] };
  const scheduler = new Scheduler(db, {
    logsDir: dir,
    executor: fakeExecutor([{ command: 'uptime', code: 0, stdout: '', stderr: '' }], record),
    save: () => undefined,
  });
  scheduler.plan(new Date('2026-09-13T00:00:00Z'));
  const ran = await scheduler.tick(new Date('2026-09-13T03:00:00Z'));
  assert.deepEqual(
    ran.map((item) => item.id),
    ['s2'],
  );
});

test('流したら保存を 1 回だけ呼ぶ', async () => {
  const dir = logsDir();
  const { db } = database();
  let saved = 0;
  const scheduler = new Scheduler(db, {
    logsDir: dir,
    executor: fakeExecutor([{ command: 'x', code: 0, stdout: '', stderr: '' }]),
    save: () => {
      saved += 1;
    },
  });
  scheduler.plan(new Date('2026-09-13T00:00:00Z'));
  await scheduler.tick(new Date('2026-09-13T02:00:00Z'));
  assert.equal(saved, 0, '流していないのに保存した');
  await scheduler.tick(new Date('2026-09-13T03:00:00Z'));
  assert.equal(saved, 1);
});
