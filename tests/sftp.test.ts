import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AppError } from '../src/server/errors.js';
import {
  filterHidden,
  joinPath,
  kindOf,
  listDirectory,
  makeDirectory,
  modeText,
  parentPath,
  readFile,
  removePath,
  renamePath,
  sortEntries,
  statPath,
  writeFile,
  isUndecodable,
  createFile,
} from '../src/server/sftp.js';
import { connect, type Session } from '../src/server/ssh.js';
import type { SftpEntry } from '../src/shared/types.js';
import { startSshServer, stopAll } from './helpers/ssh-harness.js';

// ───────── 判断のある部分（接続せずに確かめる） ─────────

test('権限は rw-r--r-- の形に直す', () => {
  assert.equal(modeText(0o644), 'rw-r--r--');
  assert.equal(modeText(0o755), 'rwxr-xr-x');
  assert.equal(modeText(0o600), 'rw-------');
  assert.equal(modeText(0o777), 'rwxrwxrwx');
});

test('種類は権限の上位ビットで見分ける', () => {
  assert.equal(kindOf(0o040755), 'directory');
  assert.equal(kindOf(0o100644), 'file');
  assert.equal(kindOf(0o120777), 'symlink');
  assert.equal(kindOf(0o010644), 'other');
});

test('パスは .. を潰してから繋ぐ', () => {
  assert.equal(joinPath('/etc/nginx', 'nginx.conf'), '/etc/nginx/nginx.conf');
  assert.equal(joinPath('/etc/nginx', '../hosts'), '/etc/hosts');
  assert.equal(joinPath('/etc/nginx/', 'conf.d/'), '/etc/nginx/conf.d/');
  assert.equal(parentPath('/etc/nginx'), '/etc');
  assert.equal(parentPath('/'), '/');
});

test('フォルダが先、その中で名前順', () => {
  const entries = [
    { name: 'b.txt', kind: 'file' },
    { name: 'zzz', kind: 'directory' },
    { name: 'a.txt', kind: 'file' },
    { name: 'aaa', kind: 'directory' },
  ] as SftpEntry[];
  assert.deepEqual(
    sortEntries(entries).map((entry) => entry.name),
    ['aaa', 'zzz', 'a.txt', 'b.txt'],
  );
});

test('隠しファイルは既定で出さない', () => {
  const entries = [{ name: '.bashrc' }, { name: 'README.md' }] as SftpEntry[];
  assert.equal(filterHidden(entries, false).length, 1);
  assert.equal(filterHidden(entries, true).length, 2);
});

test('UTF-8 として読めない名前に印を付ける', () => {
  assert.equal(isUndecodable('nginx.conf'), false);
  assert.equal(isUndecodable('日本語.txt'), false);
  assert.equal(isUndecodable('��.txt'), true);
});

// ───────── 実際の SFTP に対して確かめる ─────────

const sessions: Session[] = [];

async function connectSession(root: string): Promise<Session> {
  const port = await startSshServer({ sftpRoot: root });
  const session = await connect({
    host: {
      id: 'h1',
      label: 'test',
      hostname: '127.0.0.1',
      port,
      username: 'ops',
      authMethod: 'password',
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    },
    profile: {
      id: 'default',
      label: '既定',
      encoding: 'utf-8',
      term: 'xterm-256color',
      env: {},
      onConnect: [],
    },
    password: 'secret',
    known: [],
    onUnknownHostKey: () => true,
  });
  sessions.push(session);
  return session;
}

function sampleTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'brterm-sftp-'));
  mkdirSync(join(root, 'etc'));
  mkdirSync(join(root, 'etc', 'nginx'));
  writeFileSync(join(root, 'etc', 'nginx', 'nginx.conf'), 'worker_processes auto;\n');
  writeFileSync(join(root, 'etc', 'hosts'), '127.0.0.1 localhost\n');
  writeFileSync(join(root, 'etc', '.hidden'), 'secret\n');
  return root;
}

after(() => {
  for (const session of sessions) {
    session.close();
  }
  sessions.length = 0;
  stopAll();
});

test('一覧が出て、フォルダが先に並ぶ', async () => {
  const session = await connectSession(sampleTree());
  const sftp = await session.openSftp();
  const listed = await listDirectory(sftp, '/etc');
  assert.deepEqual(
    listed.entries.map((entry) => entry.name),
    ['nginx', 'hosts'],
  );
  assert.equal(listed.entries[0]?.kind, 'directory');
  assert.equal(listed.entries[1]?.modeText.startsWith('rw'), true);
  assert.equal(listed.truncated, false);
});

test('隠しファイルは指示したときだけ出る', async () => {
  const session = await connectSession(sampleTree());
  const sftp = await session.openSftp();
  const hidden = await listDirectory(sftp, '/etc', { showHidden: true });
  assert.equal(
    hidden.entries.some((entry) => entry.name === '.hidden'),
    true,
  );
});

test('上限を超えたら切り詰め、件数を返す', async () => {
  const root = sampleTree();
  const many = join(root, 'many');
  mkdirSync(many);
  for (let index = 0; index < 10; index += 1) {
    writeFileSync(join(many, `file-${index}.txt`), 'x');
  }
  const session = await connectSession(root);
  const sftp = await session.openSftp();
  const listed = await listDirectory(sftp, '/many', { limit: 4 });
  assert.equal(listed.entries.length, 4);
  assert.equal(listed.truncated, true);
  assert.equal(listed.total, 10);
});

test('ファイルを取得して中身が一致する', async () => {
  const session = await connectSession(sampleTree());
  const sftp = await session.openSftp();
  const data = await readFile(sftp, '/etc/nginx/nginx.conf');
  assert.equal(data.toString('utf8'), 'worker_processes auto;\n');
});

test('ファイルを置いて、機械の上に実際に書かれる', async () => {
  const root = sampleTree();
  const session = await connectSession(root);
  const sftp = await session.openSftp();
  await writeFile(sftp, '/etc/new.conf', Buffer.from('置いた内容\n', 'utf8'));
  assert.equal(readFileSync(join(root, 'etc', 'new.conf'), 'utf8'), '置いた内容\n');
});

test('日本語の中身が往復しても壊れない', async () => {
  const root = sampleTree();
  const session = await connectSession(root);
  const sftp = await session.openSftp();
  await writeFile(sftp, '/etc/ja.txt', Buffer.from('日本語のテスト\n', 'utf8'));
  const back = await readFile(sftp, '/etc/ja.txt');
  assert.equal(back.toString('utf8'), '日本語のテスト\n');
});

test('フォルダと空ファイルを作れる', async () => {
  const root = sampleTree();
  const session = await connectSession(root);
  const sftp = await session.openSftp();
  await makeDirectory(sftp, '/etc/conf.d');
  await createFile(sftp, '/etc/conf.d/site.conf');
  const listed = await listDirectory(sftp, '/etc/conf.d');
  assert.deepEqual(
    listed.entries.map((entry) => entry.name),
    ['site.conf'],
  );
  assert.equal((await statPath(sftp, '/etc/conf.d')).kind, 'directory');
});

test('改名できる', async () => {
  const root = sampleTree();
  const session = await connectSession(root);
  const sftp = await session.openSftp();
  await renamePath(sftp, '/etc/hosts', '/etc/hosts.bak');
  const listed = await listDirectory(sftp, '/etc');
  assert.equal(
    listed.entries.some((entry) => entry.name === 'hosts.bak'),
    true,
  );
  assert.equal(
    listed.entries.some((entry) => entry.name === 'hosts'),
    false,
  );
});

test('ファイルを消せる', async () => {
  const root = sampleTree();
  const session = await connectSession(root);
  const sftp = await session.openSftp();
  await removePath(sftp, '/etc/hosts', false);
  const listed = await listDirectory(sftp, '/etc');
  assert.equal(
    listed.entries.some((entry) => entry.name === 'hosts'),
    false,
  );
});

test('中身のあるフォルダは、再帰を指示したときだけ消える', async () => {
  const root = sampleTree();
  const session = await connectSession(root);
  const sftp = await session.openSftp();

  // 指示していなければ失敗する（中身ごと消さない）
  await assert.rejects(
    removePath(sftp, '/etc/nginx', false),
    (error: unknown) => error instanceof AppError,
  );

  await removePath(sftp, '/etc/nginx', true);
  const listed = await listDirectory(sftp, '/etc');
  assert.equal(
    listed.entries.some((entry) => entry.name === 'nginx'),
    false,
  );
});

test('無いファイルは、理由が分かるエラーになる', async () => {
  const session = await connectSession(sampleTree());
  const sftp = await session.openSftp();
  await assert.rejects(
    statPath(sftp, '/etc/いない.conf'),
    (error: unknown) => error instanceof AppError && /見つかりません/.test(error.message),
  );
});

test('切れたセッションでは SFTP を開かない', async () => {
  const session = await connectSession(sampleTree());
  session.close();
  await assert.rejects(
    session.openSftp(),
    (error: unknown) => error instanceof AppError && error.code === 'ssh_no_session',
  );
});
