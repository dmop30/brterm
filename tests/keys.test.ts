import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import ssh2 from 'ssh2';

import { isAppError } from '../src/server/errors.js';
import {
  fingerprintOfPublicKey,
  generateKey,
  installCommand,
  parseSshConfig,
  readSshConfig,
  upsertSshConfigHost,
  writeKey,
  writeSshConfig,
} from '../src/server/keys.js';

const { utils } = ssh2;

function workDir(): string {
  return mkdtempSync(join(tmpdir(), 'brterm-keys-'));
}

test('ed25519 の鍵を作れて、秘密鍵として読める', () => {
  const key = generateKey({ type: 'ed25519', comment: 'ops@brterm' });
  assert.match(key.publicKey, /^ssh-ed25519 /);
  assert.match(key.publicKey, /ops@brterm$/);
  assert.match(key.fingerprint, /^SHA256:/);
  const parsed = utils.parseKey(key.privateKey);
  assert.equal(parsed instanceof Error, false, '秘密鍵を読めない');
});

test('rsa の鍵長を指定できる。短すぎるものは断る', () => {
  const key = generateKey({ type: 'rsa', bits: 2048 });
  assert.match(key.publicKey, /^ssh-rsa /);
  assert.throws(
    () => generateKey({ type: 'rsa', bits: 1024 }),
    (error: unknown) => isAppError(error) && error.code === 'key_invalid_bits',
  );
});

test('パスフレーズを掛けた鍵は、パスフレーズ無しでは読めない', () => {
  const key = generateKey({ type: 'ed25519', passphrase: 'とても長い合言葉' });
  assert.equal(utils.parseKey(key.privateKey) instanceof Error, true, '素で読めてしまった');
  assert.equal(utils.parseKey(key.privateKey, 'とても長い合言葉') instanceof Error, false);
});

test('覚え書きに改行や引用符は使わせない（authorized_keys の行が壊れるため）', () => {
  assert.throws(
    () => generateKey({ type: 'ed25519', comment: "ops'\ninjected" }),
    (error: unknown) => isAppError(error) && error.code === 'key_invalid_comment',
  );
});

test('指紋は公開鍵から計算でき、鍵ごとに変わる', () => {
  const first = generateKey({ type: 'ed25519' });
  const second = generateKey({ type: 'ed25519' });
  assert.equal(fingerprintOfPublicKey(first.publicKey), first.fingerprint);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('秘密鍵は 600 で書く', () => {
  const dir = workDir();
  const written = writeKey(dir, 'id_test', generateKey({ type: 'ed25519' }));
  assert.equal(statSync(written.privateKeyPath).mode & 0o777, 0o600);
  assert.match(readFileSync(written.publicKeyPath, 'utf8'), /^ssh-ed25519 /);
});

test('同じ名前の鍵は上書きしない', () => {
  const dir = workDir();
  writeKey(dir, 'id_test', generateKey({ type: 'ed25519' }));
  assert.throws(
    () => writeKey(dir, 'id_test', generateKey({ type: 'ed25519' })),
    (error: unknown) => isAppError(error) && error.code === 'key_exists',
  );
});

test('鍵の名前でディレクトリを渡らせない', () => {
  const dir = workDir();
  assert.throws(
    () => writeKey(dir, '../id_test', generateKey({ type: 'ed25519' })),
    (error: unknown) => isAppError(error) && error.code === 'key_invalid_name',
  );
});

test('配置コマンドは、既にある鍵を二重に足さない形になっている', () => {
  const key = generateKey({ type: 'ed25519', comment: 'ops@brterm' });
  const command = installCommand(key.publicKey);
  assert.match(command, /mkdir -p ~\/\.ssh/);
  assert.match(command, /chmod 700 ~\/\.ssh/);
  assert.match(command, /chmod 600 ~\/\.ssh\/authorized_keys/);
  assert.match(command, /grep -qxF '.+' ~\/\.ssh\/authorized_keys \|\|/);
  assert.ok(command.includes(key.publicKey.trim()));
});

test('引用符を含む公開鍵は配置させない', () => {
  assert.throws(
    () => installCommand("ssh-ed25519 AAAA' ; rm -rf / ; '"),
    (error: unknown) => isAppError(error) && error.code === 'key_invalid',
  );
});

const CONFIG = `# 手で書いた設定
Host bastion
  HostName 203.0.113.1
  User ops

Host web-*
  User deploy

Host web-01
  HostName 10.0.0.1
  User old
`;

test('config を読める', () => {
  const hosts = parseSshConfig(CONFIG);
  assert.deepEqual(
    hosts.map((host) => host.patterns.join(' ')),
    ['bastion', 'web-*', 'web-01'],
  );
  assert.equal(hosts[0]?.options.HostName, '203.0.113.1');
  assert.equal(hosts[2]?.options.User, 'old');
});

test('= 区切りでも読める', () => {
  const hosts = parseSshConfig('Host a\n  Port=2222\n');
  assert.equal(hosts[0]?.options.Port, '2222');
});

test('既にある Host は差し替え、他の記述は残す', () => {
  const updated = upsertSshConfigHost(CONFIG, {
    host: 'web-01',
    hostName: '10.0.0.9',
    user: 'ops',
    port: 2222,
    identityFile: '~/.brterm/keys/id_test',
  });
  const hosts = parseSshConfig(updated);
  const target = hosts.find((host) => host.patterns[0] === 'web-01');
  assert.equal(target?.options.HostName, '10.0.0.9');
  assert.equal(target?.options.User, 'ops');
  assert.equal(target?.options.Port, '2222');
  assert.equal(target?.options.IdentitiesOnly, 'yes');
  // 手で書いた記述とコメントは残す
  assert.match(updated, /# 手で書いた設定/);
  assert.equal(hosts.find((host) => host.patterns[0] === 'bastion')?.options.User, 'ops');
  assert.equal(hosts.find((host) => host.patterns[0] === 'web-*')?.options.User, 'deploy');
  // Host が増えていないこと（差し替えなので）
  assert.equal(hosts.length, 3);
});

test('まとめ書きの Host（複数名）は触らない', () => {
  const updated = upsertSshConfigHost(CONFIG, { host: 'web-02', hostName: '10.0.0.2' });
  const hosts = parseSshConfig(updated);
  // web-* のブロックは残ったまま、web-02 が増える
  assert.equal(hosts.find((host) => host.patterns[0] === 'web-*')?.options.User, 'deploy');
  assert.equal(hosts.find((host) => host.patterns[0] === 'web-02')?.options.HostName, '10.0.0.2');
  assert.equal(hosts.length, 4);
});

test('差し替えても、後ろの Host は消えない', () => {
  const updated = upsertSshConfigHost(CONFIG, { host: 'bastion', hostName: '203.0.113.9' });
  const hosts = parseSshConfig(updated);
  assert.deepEqual(
    hosts.map((host) => host.patterns.join(' ')),
    ['bastion', 'web-*', 'web-01'],
  );
  assert.equal(hosts[0]?.options.HostName, '203.0.113.9');
  assert.equal(hosts[2]?.options.HostName, '10.0.0.1');
});

test('空の config でも書ける', () => {
  const written = upsertSshConfigHost('', { host: 'web-01', hostName: '10.0.0.1' });
  assert.equal(written, 'Host web-01\n  HostName 10.0.0.1\n');
});

test('Host の名前に空白は使わせない', () => {
  assert.throws(
    () => upsertSshConfigHost('', { host: 'a b' }),
    (error: unknown) => isAppError(error) && error.code === 'ssh_config_invalid_host',
  );
});

test('config は 600 で書き、無ければ空として読む', () => {
  const dir = workDir();
  const path = join(dir, 'ssh', 'config');
  assert.equal(readSshConfig(path), '');
  writeSshConfig(path, upsertSshConfigHost('', { host: 'web-01', hostName: '10.0.0.1' }));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readSshConfig(path), /Host web-01/);
});

test('手で書いた config を読み書きしても、知らない項目は消えない', () => {
  const dir = workDir();
  const path = join(dir, 'config');
  writeFileSync(path, 'Host web-01\n  ProxyJump bastion\n  HostName 10.0.0.1\n');
  writeSshConfig(path, upsertSshConfigHost(readSshConfig(path), { host: 'other', user: 'ops' }));
  const text = readSshConfig(path);
  // 触っていない Host の記述は、知らない項目も含めてそのまま
  assert.match(text, /ProxyJump bastion/);
  assert.match(text, /Host other/);
});

test('差し替えても、その Host に手で書いた知らない項目と注釈は残す', () => {
  const text =
    'Host web-01\n  # 踏み台経由\n  ProxyJump bastion\n  HostName 10.0.0.1\n  User old\n';
  const updated = upsertSshConfigHost(text, { host: 'web-01', hostName: '10.0.0.9', user: 'ops' });
  assert.match(updated, /# 踏み台経由/);
  assert.match(updated, /ProxyJump bastion/);
  const hosts = parseSshConfig(updated);
  assert.equal(hosts[0]?.options.HostName, '10.0.0.9');
  assert.equal(hosts[0]?.options.User, 'ops');
  // 古い値が二重に残っていないこと
  assert.equal(updated.includes('10.0.0.1'), false);
  assert.equal(updated.includes('User old'), false);
});

test('後ろに Host が続く形で差し替えても、行が詰まらない', () => {
  const text = 'Host a\n  HostName 1.1.1.1\n  ProxyJump bastion\n\nHost b\n  HostName 2.2.2.2\n';
  const updated = upsertSshConfigHost(text, { host: 'a', hostName: '9.9.9.9' });
  const hosts = parseSshConfig(updated);
  assert.deepEqual(
    hosts.map((host) => host.patterns[0]),
    ['a', 'b'],
  );
  assert.equal(hosts[0]?.options.HostName, '9.9.9.9');
  assert.equal(hosts[1]?.options.HostName, '2.2.2.2');
  assert.match(updated, /ProxyJump bastion/);
});
