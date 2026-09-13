/**
 * REST API。
 *
 * 約束事:
 * - 応答の誤りは `{ error: { code, message } }`。`message` は画面に出せる日本語
 * - **取得系はパスワードを返さない。** 設定済みかどうかだけを返す
 * - 破壊的な操作(削除)は、対象が存在しないときも理由を明示する
 */
import { randomUUID } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';

import type { Host, Procedure, ProcedureStep, Profile, Settings } from '../shared/types.js';
import type { ServerContext } from './context.js';
import { seal } from './crypto.js';
import { listHistory, trimHistory } from './history.js';
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

export function createApiRouter(context: ServerContext): Router {
  const router = express.Router();

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

  return router;
}
