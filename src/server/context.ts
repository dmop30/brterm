/**
 * サーバが持つ状態をひとまとめにする。
 *
 * 直接 `store` / `crypto` を呼ばずにここを通すのは、P2(マスターパスキー)で
 * 鍵の出どころが変わったときに、API 側を書き換えずに済ませるため。
 */
import type { Database } from '../shared/types.js';
import { loadOrCreateLocalKey, type DataKey } from './crypto.js';
import { dataDir, keyPath, tokenPath } from './paths.js';
import { loadDatabase, saveDatabase } from './store.js';
import { loadOrCreateToken } from './token.js';

export interface ServerContext {
  readonly dir: string;
  readonly key: DataKey;
  readonly token: string;
  db: Database;
  /** 変更を保存する。呼び出し側が変更を積んでから 1 回呼ぶ。 */
  save(): void;
}

export function createContext(dir: string = dataDir()): ServerContext {
  const context: ServerContext = {
    dir,
    key: loadOrCreateLocalKey(keyPath({ ...process.env, BRTERM_DATA_DIR: dir })),
    token: loadOrCreateToken(tokenPath({ ...process.env, BRTERM_DATA_DIR: dir })),
    db: loadDatabase(dir),
    save() {
      saveDatabase(context.db, dir);
    },
  };
  return context;
}
