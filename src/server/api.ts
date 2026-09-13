/**
 * REST API。
 *
 * 約束事:
 * - 応答の誤りは `{ error: { code, message } }`。`message` は画面に出せる日本語
 * - **取得系はパスワードを返さない。** 設定済みかどうかだけを返す
 * - 破壊的な操作(削除)は、対象が存在しないときも理由を明示する
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import express, { type Request, type Response, type Router } from 'express';

import type { Host, Procedure, ProcedureStep, Profile, Settings } from '../shared/types.js';
import type { ServerContext } from './context.js';
import { seal } from './crypto.js';
import { isAppError } from './errors.js';
import { listHistory, trimHistory } from './history.js';
import {
  generateKey,
  installCommand,
  parseSshConfig,
  readKeyFile,
  readSshConfig,
  upsertSshConfigHost,
  writeKey,
  writeSshConfig,
  type KeyType,
} from './keys.js';
import { keysDir as defaultKeysDir, sshConfigPath as defaultSshConfigPath } from './paths.js';
import type { SessionManager } from './ssh.js';
import { makeProcedure, makeStep, stepsFromHistory, toMarkdown } from './procedures.js';

/** 画面に返す接続先。パスワードは含めない。 */
export interface HostView extends Omit<Host, 'password' | 'passphrase'> {
  hasPassword: boolean;
  hasPassphrase: boolean;
}

export function toHostView(host: Host): HostView {
  const { password, passphrase, ...rest } = host;
  return { ...rest, hasPassword: password !== undefined, hasPassphrase: passphrase !== undefined };
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function port(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    return undefined;
  }
  return value;
}

export interface ApiOptions {
  /** 鍵の配置に使う。開いているセッションを通して `authorized_keys` を書く */
  manager?: SessionManager;
  /** 鍵の置き場。検証で差し替えるため */
  keysDir?: string;
  /** `~/.ssh/config` の場所。検証で差し替えるため */
  sshConfigPath?: string;
}

export function createApiRouter(context: ServerContext, options: ApiOptions = {}): Router {
  const router = express.Router();
  const keysDir = options.keysDir ?? defaultKeysDir();
  const sshConfigPath = options.sshConfigPath ?? defaultSshConfigPath();

  router.get('/hosts', (_req, res) => {
    res.json({ hosts: context.db.hosts.map(toHostView) });
  });

  router.post('/hosts', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const label = text(body.label);
    const hostname = text(body.hostname);
    const username = text(body.username);
    const portNumber = port(body.port ?? 22);
    const authMethod = body.authMethod === 'key' ? 'key' : 'password';

    if (!label || !hostname || !username) {
      fail(res, 400, 'invalid_host', '名前・ホスト名・利用者名は必ず入力してください。');
      return;
    }
    if (portNumber === undefined) {
      fail(res, 400, 'invalid_port', 'ポート番号は 1〜65535 の整数で指定してください。');
      return;
    }

    const now = new Date().toISOString();
    const host: Host = {
      id: randomUUID(),
      label,
      hostname,
      port: portNumber,
      username,
      authMethod,
      createdAt: now,
      updatedAt: now,
    };

    const password = text(body.password);
    if (password) {
      host.password = seal(context.key, password);
    }
    const privateKeyPath = text(body.privateKeyPath);
    if (privateKeyPath) {
      host.privateKeyPath = privateKeyPath;
    }
    const passphrase = text(body.passphrase);
    if (passphrase) {
      host.passphrase = seal(context.key, passphrase);
    }
    const profileId = text(body.profileId);
    if (profileId) {
      if (!context.db.profiles.some((profile) => profile.id === profileId)) {
        fail(res, 400, 'profile_not_found', '指定されたプロファイルがありません。');
        return;
      }
      host.profileId = profileId;
    }

    context.db.hosts.push(host);
    context.save();
    res.status(201).json({ host: toHostView(host) });
  });

  router.get('/hosts/:id', (req, res) => {
    const host = context.db.hosts.find((entry) => entry.id === req.params.id);
    if (!host) {
      fail(res, 404, 'host_not_found', '指定された接続先が見つかりません。');
      return;
    }
    res.json({ host: toHostView(host) });
  });

  router.patch('/hosts/:id', (req, res) => {
    const host = context.db.hosts.find((entry) => entry.id === req.params.id);
    if (!host) {
      fail(res, 404, 'host_not_found', '指定された接続先が見つかりません。');
      return;
    }
    const body = req.body as Record<string, unknown>;

    const label = text(body.label);
    if (label) {
      host.label = label;
    }
    const hostname = text(body.hostname);
    if (hostname) {
      host.hostname = hostname;
    }
    const username = text(body.username);
    if (username) {
      host.username = username;
    }
    if (body.port !== undefined) {
      const portNumber = port(body.port);
      if (portNumber === undefined) {
        fail(res, 400, 'invalid_port', 'ポート番号は 1〜65535 の整数で指定してください。');
        return;
      }
      host.port = portNumber;
    }
    if (body.authMethod === 'key' || body.authMethod === 'password') {
      host.authMethod = body.authMethod;
    }
    // 空文字を渡したら「消す」。未指定(undefined)は「変えない」。
    if (typeof body.password === 'string') {
      const password = text(body.password);
      if (password) {
        host.password = seal(context.key, password);
      } else {
        delete host.password;
      }
    }
    if (typeof body.passphrase === 'string') {
      const passphrase = text(body.passphrase);
      if (passphrase) {
        host.passphrase = seal(context.key, passphrase);
      } else {
        delete host.passphrase;
      }
    }
    if (typeof body.privateKeyPath === 'string') {
      const privateKeyPath = text(body.privateKeyPath);
      if (privateKeyPath) {
        host.privateKeyPath = privateKeyPath;
      } else {
        delete host.privateKeyPath;
      }
    }
    // 空文字を渡したら既定のプロファイルへ戻す
    if (typeof body.profileId === 'string') {
      const profileId = text(body.profileId);
      if (profileId) {
        if (!context.db.profiles.some((profile) => profile.id === profileId)) {
          fail(res, 400, 'profile_not_found', '指定されたプロファイルがありません。');
          return;
        }
        host.profileId = profileId;
      } else {
        delete host.profileId;
      }
    }

    host.updatedAt = new Date().toISOString();
    context.save();
    res.json({ host: toHostView(host) });
  });

  router.delete('/hosts/:id', (req, res) => {
    const index = context.db.hosts.findIndex((entry) => entry.id === req.params.id);
    if (index < 0) {
      fail(res, 404, 'host_not_found', '指定された接続先が見つかりません。');
      return;
    }
    context.db.hosts.splice(index, 1);
    context.save();
    res.status(204).end();
  });

  router.get('/profiles', (_req, res) => {
    res.json({ profiles: context.db.profiles });
  });

  router.post('/profiles', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const label = text(body.label);
    if (!label) {
      fail(res, 400, 'invalid_profile', 'プロファイルの名前を入力してください。');
      return;
    }
    const encoding = body.encoding;
    const profile: Profile = {
      id: randomUUID(),
      label,
      encoding:
        encoding === 'shift_jis' || encoding === 'euc-jp' || encoding === 'utf-8'
          ? encoding
          : 'utf-8',
      term: text(body.term) ?? 'xterm-256color',
      env:
        typeof body.env === 'object' && body.env !== null
          ? (body.env as Record<string, string>)
          : {},
      onConnect: Array.isArray(body.onConnect) ? (body.onConnect as string[]) : [],
    };
    context.db.profiles.push(profile);
    context.save();
    res.status(201).json({ profile });
  });

  router.patch('/profiles/:id', (req, res) => {
    const profile = context.db.profiles.find((entry) => entry.id === req.params.id);
    if (!profile) {
      fail(res, 404, 'profile_not_found', '指定されたプロファイルがありません。');
      return;
    }
    const body = req.body as Record<string, unknown>;
    const label = text(body.label);
    if (label) {
      profile.label = label;
    }
    if (body.encoding === 'utf-8' || body.encoding === 'shift_jis' || body.encoding === 'euc-jp') {
      profile.encoding = body.encoding;
    }
    const term = text(body.term);
    if (term) {
      profile.term = term;
    }
    // env と onConnect は**渡されたときだけ**丸ごと入れ替える(空で消せるように)
    if (typeof body.env === 'object' && body.env !== null && !Array.isArray(body.env)) {
      profile.env = Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([name, value]) => [name, value as string]),
      );
    }
    if (Array.isArray(body.onConnect)) {
      profile.onConnect = body.onConnect
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    }
    context.save();
    res.json({ profile });
  });

  router.delete('/profiles/:id', (req, res) => {
    // 既定は消させない。消えると、紐付いていない接続先の拠り所が無くなる
    if (req.params.id === 'default') {
      fail(res, 400, 'profile_protected', '既定のプロファイルは消せません。');
      return;
    }
    const index = context.db.profiles.findIndex((entry) => entry.id === req.params.id);
    if (index < 0) {
      fail(res, 404, 'profile_not_found', '指定されたプロファイルがありません。');
      return;
    }
    context.db.profiles.splice(index, 1);
    // 迷子の参照を残さない。使っていた接続先は既定へ戻す
    let detached = 0;
    for (const host of context.db.hosts) {
      if (host.profileId === req.params.id) {
        delete host.profileId;
        host.updatedAt = new Date().toISOString();
        detached += 1;
      }
    }
    context.save();
    res.json({ removed: true, detached });
  });

  router.get('/settings', (_req, res) => {
    res.json({ settings: context.db.settings });
  });

  router.patch('/settings', (req, res) => {
    const body = req.body as Partial<Settings>;
    const settings = context.db.settings;
    if (body.theme === 'system' || body.theme === 'dark' || body.theme === 'light') {
      settings.theme = body.theme;
    }
    if (typeof body.confirmDangerousCommands === 'boolean') {
      settings.confirmDangerousCommands = body.confirmDangerousCommands;
    }
    if (typeof body.editorBackup === 'boolean') {
      settings.editorBackup = body.editorBackup;
    }
    if (typeof body.historyLimit === 'number' && Number.isInteger(body.historyLimit)) {
      // 0 は「残さない」。上限は青天井にしない(ファイルが太る)。
      settings.historyLimit = Math.min(Math.max(body.historyLimit, 0), 100000);
      // 上限を下げたら、その場で溢れた分を落とす(次の実行まで残さない)
      trimHistory(context.db);
    }
    context.save();
    res.json({ settings });
  });

  // ---- 履歴 ----------------------------------------------------------------

  router.get('/history', (req, res) => {
    const hostId = text(req.query.hostId);
    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    res.json({
      history: listHistory(context.db, {
        ...(hostId ? { hostId } : {}),
        ...(limit === undefined ? {} : { limit }),
      }),
    });
  });

  /** 履歴の削除。接続先を指定すればその分だけ消す。 */
  router.delete('/history', (req, res) => {
    const hostId = text(req.query.hostId);
    const before = context.db.history.length;
    context.db.history = hostId
      ? context.db.history.filter((entry) => entry.hostId !== hostId)
      : [];
    context.save();
    res.json({ removed: before - context.db.history.length });
  });

  // ---- 手順 ----------------------------------------------------------------

  function findProcedure(id: string): Procedure | undefined {
    return context.db.procedures.find((procedure) => procedure.id === id);
  }

  /** 本文から手順のステップを組み立てる。履歴 id を渡す形も受ける。 */
  function stepsFrom(body: Record<string, unknown>): ProcedureStep[] {
    if (Array.isArray(body.historyIds)) {
      const ids = new Set(body.historyIds.map(String));
      // 履歴に並んでいる順で残す(選んだ順ではなく、実行した順)
      return stepsFromHistory(context.db.history.filter((entry) => ids.has(entry.id)));
    }
    if (!Array.isArray(body.steps)) {
      return [];
    }
    return body.steps
      .map((item) => item as Record<string, unknown>)
      .map((item) => ({
        command: text(item.command) ?? '',
        ...(typeof item.output === 'string' ? { output: item.output } : {}),
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
        ...(text(item.note) ? { note: text(item.note) as string } : {}),
      }))
      .filter((item) => item.command !== '')
      .map(makeStep);
  }

  router.get('/procedures', (_req, res) => {
    res.json({ procedures: context.db.procedures });
  });

  router.post('/procedures', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const title = text(body.title);
    if (!title) {
      fail(res, 400, 'invalid_procedure', '手順の題名を入力してください。');
      return;
    }
    const hostId = text(body.hostId);
    const procedure = makeProcedure({
      title,
      ...(hostId ? { hostId } : {}),
      steps: stepsFrom(body),
    });
    context.db.procedures.push(procedure);
    context.save();
    res.status(201).json({ procedure });
  });

  router.get('/procedures/:id', (req, res) => {
    const procedure = findProcedure(req.params.id);
    if (!procedure) {
      fail(res, 404, 'procedure_not_found', 'その手順は見つかりません。');
      return;
    }
    res.json({ procedure });
  });

  router.patch('/procedures/:id', (req, res) => {
    const procedure = findProcedure(req.params.id);
    if (!procedure) {
      fail(res, 404, 'procedure_not_found', 'その手順は見つかりません。');
      return;
    }
    const body = req.body as Record<string, unknown>;
    const title = text(body.title);
    if (title) {
      procedure.title = title;
    }
    // ステップは**渡されたときだけ**入れ替える(空配列で消せるようにする)
    if (Array.isArray(body.steps) || Array.isArray(body.historyIds)) {
      procedure.steps = stepsFrom(body);
    }
    procedure.updatedAt = new Date().toISOString();
    context.save();
    res.json({ procedure });
  });

  /** ステップを末尾に足す。端末や履歴から 1 件ずつ積むときに使う。 */
  router.post('/procedures/:id/steps', (req, res) => {
    const procedure = findProcedure(req.params.id);
    if (!procedure) {
      fail(res, 404, 'procedure_not_found', 'その手順は見つかりません。');
      return;
    }
    const steps = stepsFrom(req.body as Record<string, unknown>);
    if (steps.length === 0) {
      fail(res, 400, 'invalid_step', '足すコマンドがありません。');
      return;
    }
    procedure.steps.push(...steps);
    procedure.updatedAt = new Date().toISOString();
    context.save();
    res.status(201).json({ procedure });
  });

  router.delete('/procedures/:id', (req, res) => {
    const index = context.db.procedures.findIndex((procedure) => procedure.id === req.params.id);
    if (index < 0) {
      fail(res, 404, 'procedure_not_found', 'その手順は見つかりません。');
      return;
    }
    context.db.procedures.splice(index, 1);
    context.save();
    res.json({ removed: true });
  });

  /** Markdown 書き出し。そのまま Wiki へ貼れる形で返す。 */
  router.get('/procedures/:id/markdown', (req, res) => {
    const procedure = findProcedure(req.params.id);
    if (!procedure) {
      fail(res, 404, 'procedure_not_found', 'その手順は見つかりません。');
      return;
    }
    const host = context.db.hosts.find((entry) => entry.id === procedure.hostId);
    res
      .type('text/markdown; charset=utf-8')
      .send(toMarkdown(procedure, host ? { hostLabel: host.label } : {}));
  });

  // ---- SSH 鍵 --------------------------------------------------------------

  /** 鍵置き場にある鍵。**秘密鍵の中身は返さない**（場所だけ）。 */
  router.get('/keys', (_req, res) => {
    if (!existsSync(keysDir)) {
      res.json({ keys: [], dir: keysDir });
      return;
    }
    const keys = readdirSync(keysDir)
      .filter((name) => name.endsWith('.pub'))
      .map((name) => readKeyFile(join(keysDir, name)));
    res.json({ keys, dir: keysDir });
  });

  router.post('/keys', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = text(body.name);
    if (!name) {
      fail(res, 400, 'invalid_key_name', '鍵の名前を入力してください。');
      return;
    }
    const type: KeyType = body.type === 'rsa' ? 'rsa' : 'ed25519';
    try {
      const generated = generateKey({
        type,
        ...(typeof body.bits === 'number' ? { bits: body.bits } : {}),
        ...(text(body.comment) ? { comment: text(body.comment) as string } : {}),
        ...(text(body.passphrase) ? { passphrase: text(body.passphrase) as string } : {}),
      });
      const written = writeKey(keysDir, name, generated);
      // 秘密鍵の中身は返さない。場所と公開鍵と指紋だけ渡す
      res.status(201).json({
        key: {
          name,
          type: written.type,
          privateKeyPath: written.privateKeyPath,
          publicKeyPath: written.publicKeyPath,
          publicKey: written.publicKey,
          fingerprint: written.fingerprint,
        },
      });
    } catch (error) {
      if (isAppError(error)) {
        fail(res, error.code === 'key_exists' ? 409 : 400, error.code, error.message);
        return;
      }
      throw error;
    }
  });

  /**
   * 公開鍵を接続先の `authorized_keys` へ置く。
   *
   * **開いているセッションを通して行う。** ここで新しく繋ぐと、ホスト鍵の確認を
   * 画面に出せない（未確認の鍵を黙って受け入れることになる）ため、安全側に倒している。
   */
  router.post('/keys/:name/install', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const hostId = text(body.hostId);
    if (!hostId) {
      fail(res, 400, 'invalid_host', '置き先の接続先を指定してください。');
      return;
    }
    const host = context.db.hosts.find((entry) => entry.id === hostId);
    if (!host) {
      fail(res, 404, 'host_not_found', '指定された接続先が見つかりません。');
      return;
    }
    const publicKeyPath = join(keysDir, `${req.params.name}.pub`);
    if (!existsSync(publicKeyPath)) {
      fail(res, 404, 'key_not_found', 'その鍵はありません。');
      return;
    }
    const session = options.manager?.list().find((item) => item.hostId === hostId);
    if (!session || session.isClosed) {
      fail(
        res,
        409,
        'ssh_no_session',
        `${host.label} に繋がっていません。先に端末でこの接続先へ繋いでください。`,
      );
      return;
    }

    try {
      const key = readKeyFile(publicKeyPath);
      const result = await session.exec(installCommand(key.publicKey));
      if (result.code !== 0) {
        fail(
          res,
          502,
          'key_install_failed',
          `${host.label} に鍵を置けませんでした。${result.stderr.trim()}`,
        );
        return;
      }
      res.json({ installed: true, fingerprint: key.fingerprint });
    } catch (error) {
      if (isAppError(error)) {
        fail(res, 400, error.code, error.message);
        return;
      }
      throw error;
    }
  });

  // ---- ~/.ssh/config -------------------------------------------------------

  router.get('/ssh-config', (_req, res) => {
    const text_ = readSshConfig(sshConfigPath);
    res.json({ path: sshConfigPath, hosts: parseSshConfig(text_), text: text_ });
  });

  /** Host の記述を差し替える。手で書いた記述は残す。 */
  router.put('/ssh-config/hosts/:host', (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const updated = upsertSshConfigHost(readSshConfig(sshConfigPath), {
        host: req.params.host,
        ...(text(body.hostName) ? { hostName: text(body.hostName) as string } : {}),
        ...(text(body.user) ? { user: text(body.user) as string } : {}),
        ...(port(body.port) === undefined ? {} : { port: port(body.port) as number }),
        ...(text(body.identityFile) ? { identityFile: text(body.identityFile) as string } : {}),
      });
      writeSshConfig(sshConfigPath, updated);
      res.json({ path: sshConfigPath, hosts: parseSshConfig(updated) });
    } catch (error) {
      if (isAppError(error)) {
        fail(res, 400, error.code, error.message);
        return;
      }
      throw error;
    }
  });

  return router;
}
