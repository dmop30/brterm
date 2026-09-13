/**
 * 接続に要る秘密を、保存された形から**使える形**へ開く。
 *
 * ws からも予定実行からも同じ手順で開きたいので切り出してある。
 * 開けない・読めないときは推測で続行せず、**理由を明示して止める**(要件定義 1 章)。
 */
import { readFileSync } from 'node:fs';

import type { Host } from '../shared/types.js';
import { open as openSealed } from './crypto.js';
import type { DataKey } from './crypto.js';
import { AppError } from './errors.js';

export interface HostSecrets {
  password?: string;
  passphrase?: string;
  /** 秘密鍵の中身。`privateKeyPath` から読む(brterm に取り込まない。要件定義 4.10) */
  privateKey?: string;
}

/** 秘密鍵を読む。読めない理由（無い・権限が足りない）は分けて出す。 */
export function readPrivateKey(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    const reason =
      error.code === 'ENOENT'
        ? 'ファイルがありません'
        : error.code === 'EACCES'
          ? '読み取りの権限がありません'
          : error.message;
    throw new AppError('key_unreadable', `秘密鍵を読めません: ${path}（${reason}）`);
  }
}

export function secretsFor(key: DataKey, host: Host): HostSecrets {
  const secrets: HostSecrets = {};
  if (host.password) {
    secrets.password = openSealed(key, host.password);
  }
  if (host.passphrase) {
    secrets.passphrase = openSealed(key, host.passphrase);
  }
  // 鍵認証なのに鍵の場所が無ければ、繋ぎに行く前に止める
  if (host.authMethod === 'key') {
    if (!host.privateKeyPath) {
      throw new AppError(
        'key_unreadable',
        `${host.label} は鍵認証の設定ですが、秘密鍵の場所が登録されていません。`,
      );
    }
    secrets.privateKey = readPrivateKey(host.privateKeyPath);
  }
  return secrets;
}
