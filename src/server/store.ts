/**
 * `~/.brterm/db.json` の読み書き。
 *
 * 方針は 3 つ。
 * 1. **壊れたファイルで黙って続行しない。** 既定値で上書きすると利用者の設定が消える。
 * 2. **書き込みは原子的に。** 一時ファイルへ書いて `rename` で差し替える(要件定義 4.4 の保存と同じ考え)。
 * 3. **版数を持つ。** P1 で版数 2 へ移行する前提で、読むときに版数を確かめる。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { Database, Profile, Settings } from '../shared/types.js';
import { AppError } from './errors.js';
import { dataDir } from './paths.js';

/** 現在のスキーマ版数。P1 で 2 へ上げる。 */
export const SCHEMA_VERSION = 1;

export const DB_FILE = 'db.json';

/** 既定のプロファイル。接続先がプロファイルを指定しないときに使う。 */
export function defaultProfile(): Profile {
  return {
    id: 'default',
    label: '既定',
    encoding: 'utf-8',
    term: 'xterm-256color',
    env: {},
    onConnect: [],
  };
}

export function defaultSettings(): Settings {
  return {
    theme: 'system',
    confirmDangerousCommands: true,
    historyLimit: 2000,
    vaultMode: 'local',
    encryptionScope: 'full',
    // 新機能は既定オフ(要件定義 1 章)
    editorBackup: false,
  };
}

export function defaultDatabase(): Database {
  return {
    schemaVersion: SCHEMA_VERSION,
    hosts: [],
    profiles: [defaultProfile()],
    procedures: [],
    schedules: [],
    history: [],
    knownHostKeys: [],
    settings: defaultSettings(),
  };
}

function dbPath(dir: string): string {
  return join(dir, DB_FILE);
}

/**
 * 読む。ファイルが無い初回は既定値を返す(これは「壊れている」ではない)。
 *
 * 壊れている・版数が新しすぎる場合は `AppError` を投げる。呼び出し側が
 * 状態を画面に出して止めるため、ここで勝手に直さない。
 */
export function loadDatabase(dir: string = dataDir()): Database {
  const path = dbPath(dir);
  if (!existsSync(path)) {
    return defaultDatabase();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new AppError(
      'store_broken',
      `保存ファイルを読めません: ${path}`,
      `JSON として解釈できない: ${(cause as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('store_broken', `保存ファイルの形式が不正です: ${path}`);
  }

  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new AppError('store_broken', `保存ファイルに版数がありません: ${path}`);
  }
  if (version > SCHEMA_VERSION) {
    throw new AppError(
      'store_version_unsupported',
      `保存ファイルの版数 ${version} は、この brterm では読めません。新しい版の brterm を使ってください。`,
    );
  }

  // 欠けている配列・設定は既定で埋める。ここで埋めるのは**構造**だけで、
  // 値の書き換えはしない(利用者が消した設定を復活させない)。
  const base = defaultDatabase();
  const db = parsed as Partial<Database>;
  return {
    schemaVersion: version,
    hosts: db.hosts ?? base.hosts,
    profiles: db.profiles ?? base.profiles,
    procedures: db.procedures ?? base.procedures,
    schedules: db.schedules ?? base.schedules,
    history: db.history ?? base.history,
    knownHostKeys: db.knownHostKeys ?? base.knownHostKeys,
    settings: { ...base.settings, ...(db.settings ?? {}) },
  };
}

/**
 * 書く。一時ファイル → `rename` で差し替える。
 *
 * 途中で落ちても、既にある `db.json` は壊れない。
 * 接続先のパスワード(暗号化済み)を含むので、権限は 600 にする。
 */
export function saveDatabase(db: Database, dir: string = dataDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = dbPath(dir);
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (cause) {
    // 一時ファイルを残さない。消せなくても元の db.json は無傷。
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        /* 消せないときは諦める */
      }
    }
    throw new AppError(
      'store_broken',
      `保存ファイルを書き込めません: ${path}`,
      (cause as Error).message,
    );
  }
}
