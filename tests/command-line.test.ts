import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CommandLine, looksLikePasswordPrompt } from '../src/server/command-line.js';

function feed(line: CommandLine, text: string): string[] {
  const lines: string[] = [];
  for (const char of text) {
    const result = line.feedChar(char);
    if (result.line !== undefined && !result.secret) {
      lines.push(result.line);
    }
  }
  return lines;
}

test('打った文字から 1 行を組み立てる', () => {
  const line = new CommandLine();
  assert.deepEqual(feed(line, 'uptime\r'), ['uptime']);
  assert.equal(line.pending, '');
});

test('続けて打てば何行でも取れる', () => {
  const line = new CommandLine();
  assert.deepEqual(feed(line, 'ls\rpwd\r'), ['ls', 'pwd']);
});

test('後退で消せる', () => {
  const line = new CommandLine();
  assert.deepEqual(feed(line, 'lss\u007f\r'), ['ls']);
});

test('Ctrl+U で行を捨てる', () => {
  const line = new CommandLine();
  assert.deepEqual(feed(line, 'rm -rf /\u0015ls\r'), ['ls']);
});

test('Ctrl+C で行を捨てる', () => {
  const line = new CommandLine();
  assert.deepEqual(feed(line, 'dangerous\u0003\r'), ['']);
});

test('矢印キーなどの制御列は行に混ざらない', () => {
  const line = new CommandLine();
  // ESC [ A = 上矢印
  assert.deepEqual(feed(line, 'ls\u001b[A\r'), ['ls']);
});

test('補完を押したら、こちらの控えは捨てる（当てにならないため）', () => {
  const line = new CommandLine();
  feed(line, 'ngi\t');
  assert.equal(line.pending, '');
});

test('前後の空白は落とす', () => {
  const line = new CommandLine();
  assert.deepEqual(feed(line, '  ls -la  \r'), ['ls -la']);
});

test('パスワードの入力中は秘密として印を付ける', () => {
  const line = new CommandLine();
  line.noteOutput('[sudo] password for ops: ');
  const results: boolean[] = [];
  for (const char of 'himitsu\r') {
    const result = line.feedChar(char);
    if (result.line !== undefined) {
      results.push(result.secret === true);
    }
  }
  assert.deepEqual(results, [true]);
});

test('パスワードの合図を見分ける', () => {
  assert.equal(looksLikePasswordPrompt('[sudo] password for ops: '), true);
  assert.equal(looksLikePasswordPrompt("ops@web-01's password: "), true);
  assert.equal(looksLikePasswordPrompt('Enter passphrase for key: '), true);
  assert.equal(looksLikePasswordPrompt('パスワード: '), true);
  assert.equal(looksLikePasswordPrompt('ops@web-01:~$ '), false);
  assert.equal(looksLikePasswordPrompt('password の変更方法は man を見てください\n$ '), false);
});

test('普通のプロンプトなら秘密にしない', () => {
  const line = new CommandLine();
  line.noteOutput('ops@web-01:~$ ');
  const result = [...'ls\r'].map((char) => line.feedChar(char)).find((item) => item.line);
  assert.equal(result?.secret, undefined);
});
