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
