import assert from 'node:assert/strict';
import { test } from 'node:test';

import { confirmMessage, judgeCommand } from '../src/server/dangerous.js';

/** 止めるべきもの。**理由が付いていること**も確かめる。 */
const DANGEROUS: [string, RegExp][] = [
  ['rm -rf /var/log/old', /消します/],
  ['rm -fr ./build', /消します/],
  ['sudo rm -r /etc/nginx/conf.d', /消します/],
  ['mkfs.ext4 /dev/sdb1', /ファイルシステム/],
  ['dd if=/dev/zero of=/dev/sda bs=1M', /デバイス/],
  ['shutdown -h now', /停止・再起動/],
  ['reboot', /停止・再起動/],
  ['systemctl stop nginx', /サービス/],
  ['chown -R www-data:www-data /var/www', /持ち主/],
  ['truncate -s 0 /var/log/syslog', /空に/],
  ['killall -9 node', /強制終了/],
  ['echo x > /etc/hosts', /上書き/],
  ['cat template.conf > /etc/nginx/nginx.conf', /上書き/],
];

for (const [command, reason] of DANGEROUS) {
  test(`危険と判定する: ${command}`, () => {
    const verdict = judgeCommand(command);
    assert.equal(verdict.dangerous, true, `${command} を見逃した`);
    assert.match(verdict.reason ?? '', reason);
  });
}

/** 止めてはいけないもの。**確認が多すぎると読まれなくなる**。 */
const SAFE = [
  'ls -la /etc/nginx',
  'cat /etc/hosts',
  'grep -rn worker_processes /etc/nginx',
  'tail -f /var/log/nginx/error.log',
  'systemctl status nginx',
  'systemctl reload nginx',
  'nginx -t',
  'echo "追記" >> /var/log/memo.log',
  'cp /etc/nginx/nginx.conf ~/backup/',
  'df -h',
  'rmdir empty-dir',
  'formatting.sh',
  '',
];

for (const command of SAFE) {
  test(`危険と判定しない: ${command || '(空)'}`, () => {
    assert.equal(judgeCommand(command).dangerous, false, `${command} を止めてしまった`);
  });
}

test('システム領域に触るものには印が付く', () => {
  assert.equal(judgeCommand('rm -rf /etc/nginx/conf.d').systemPath, '/etc');
  assert.equal(judgeCommand('rm -rf /home/ops/tmp').systemPath, undefined);
});

test('追記は上書きと区別する', () => {
  assert.equal(judgeCommand('echo x >> /etc/hosts').dangerous, false);
  assert.equal(judgeCommand('echo x > /etc/hosts').dangerous, true);
});

test('システム領域の外への上書きは止めない', () => {
  assert.equal(judgeCommand('echo x > /home/ops/memo.txt').dangerous, false);
});

test('確認の文言には、ホスト名と対象と理由が入る', () => {
  const command = 'rm -rf /etc/nginx/conf.d';
  const message = confirmMessage(command, judgeCommand(command), 'web-01.example.jp');
  assert.match(message, /web-01\.example\.jp/);
  assert.match(message, /\/etc/);
  assert.match(message, /消します/);
});

test('システム領域でなければ、ホスト名とコマンドの文言になる', () => {
  const command = 'reboot';
  const message = confirmMessage(command, judgeCommand(command), 'db-02');
  assert.match(message, /db-02/);
  assert.match(message, /停止・再起動/);
});
