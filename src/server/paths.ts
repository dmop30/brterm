import { homedir } from 'node:os';
import { join } from 'node:path';

import { DATA_DIR_NAME } from '../shared/defaults.js';

/**
 * データ保存先を返す。既定は `~/.brterm`。
 * `BRTERM_DATA_DIR` が設定されていればそれを使う(検証と複数プロファイル用)。
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BRTERM_DATA_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), DATA_DIR_NAME);
}

/** データ保存先の中のファイルパスを組み立てる。 */
export function dataPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), name);
}

/** ローカル鍵の場所(`local` モードのみ。要件定義 8 章)。 */
export function keyPath(env: NodeJS.ProcessEnv = process.env): string {
  return dataPath('master.key', env);
}

/** 画面アクセス用トークンの場所。 */
export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return dataPath('token', env);
}

/** brterm が作った SSH 鍵の置き場。既定は `~/.brterm/keys`。 */
export function keysDir(env: NodeJS.ProcessEnv = process.env): string {
  return dataPath('keys', env);
}

/**
 * `~/.ssh/config` の場所。
 * `BRTERM_SSH_CONFIG` で差し替えられるようにしてあるのは、検証で本物を触らないため。
 */
export function sshConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BRTERM_SSH_CONFIG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), '.ssh', 'config');
}

/** 予定実行のログ置き場。機密は書かない。 */
export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return dataPath('logs', env);
}

/** 再開用のセッションメタ置き場(P4 で使う)。 */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return dataPath('sessions', env);
}
