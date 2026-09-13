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

import type { Bookmark, Host, Profile, Settings } from '../shared/types.js';
import { addBookmark, forHost, normalizePath, removeForHost, reorder } from './bookmarks.js';
import type { ServerContext } from './context.js';
import { seal } from './crypto.js';
import { isAppError } from './errors.js';
import {
  createFile,
  joinPath,
  listDirectory,
  makeDirectory,
  readFile,
  removePath,
  renamePath,
  sftpFor,
  statPath,
  writeFile,
} from './sftp.js';
import type { SessionManager } from './ssh.js';

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

export function createApiRouter(context: ServerContext, sessions: SessionManager): Router {
  const router = express.Router();

  /** その接続先に繋がっているセッション。SFTP はこれに相乗りする。 */
  function sessionForHost(hostId: string) {
    return sessions.list().find((session) => session.hostId === hostId && !session.isClosed);
  }

  /** SFTP の操作をまとめて受ける。失敗は日本語のまま画面へ返す。 */
  async function withSftp<T>(
    res: Response,
    hostId: string | undefined,
    run: (sftp: Awaited<ReturnType<typeof sftpFor>>) => Promise<T>,
  ): Promise<T | undefined> {
    if (!hostId) {
      fail(res, 400, 'invalid_request', '接続先を指定してください。');
      return undefined;
    }
    try {
      const sftp = await sftpFor(sessionForHost(hostId));
      return await run(sftp);
    } catch (error) {
      if (isAppError(error)) {
        const status = error.code === 'ssh_no_session' ? 409 : 400;
        fail(res, status, error.code, error.message);
        return undefined;
      }
      fail(res, 500, 'unexpected', 'SFTP の操作に失敗しました。');
      return undefined;
    }
  }

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
    const [removed] = context.db.hosts.splice(index, 1);
    // 迷子のブックマークを残さない
    if (removed) {
      context.db.bookmarks = removeForHost(context.db.bookmarks, removed.id);
    }
    context.save();
    res.status(204).end();
  });

  router.get('/bookmarks', (req, res) => {
    const hostId = text(req.query.hostId);
    const bookmarks: Bookmark[] = hostId
      ? forHost(context.db.bookmarks, hostId)
      : [...context.db.bookmarks].sort((a, b) => a.order - b.order);
    res.json({ bookmarks });
  });

  router.post('/bookmarks', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const hostId = text(body.hostId);
    const path = text(body.path);
    if (!hostId || !path) {
      fail(res, 400, 'invalid_bookmark', '接続先とパスを指定してください。');
      return;
    }
    if (!context.db.hosts.some((host) => host.id === hostId)) {
      fail(res, 404, 'host_not_found', '指定された接続先が見つかりません。');
      return;
    }
    if (!normalizePath(path).startsWith('/') && !normalizePath(path).startsWith('~')) {
      fail(res, 400, 'invalid_bookmark', 'パスは / または ~ から始めてください。');
      return;
    }

    const label = text(body.label);
    const result = addBookmark(context.db.bookmarks, {
      hostId,
      path,
      ...(label ? { label } : {}),
    });
    context.db.bookmarks = result.bookmarks;
    context.save();
    res.status(201).json({ bookmark: result.bookmark });
  });

  router.patch('/bookmarks/:id', (req, res) => {
    const bookmark = context.db.bookmarks.find((entry) => entry.id === req.params.id);
    if (!bookmark) {
      fail(res, 404, 'bookmark_not_found', '指定されたブックマークが見つかりません。');
      return;
    }
    const label = text((req.body as Record<string, unknown>).label);
    if (label) {
      bookmark.label = label;
    }
    context.save();
    res.json({ bookmark });
  });

  router.post('/bookmarks/reorder', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const hostId = text(body.hostId);
    const ids = Array.isArray(body.ids)
      ? (body.ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined;
    if (!hostId || !ids) {
      fail(res, 400, 'invalid_bookmark', '接続先と並び順を指定してください。');
      return;
    }
    context.db.bookmarks = reorder(context.db.bookmarks, hostId, ids);
    context.save();
    res.json({ bookmarks: forHost(context.db.bookmarks, hostId) });
  });

  router.delete('/bookmarks/:id', (req, res) => {
    const index = context.db.bookmarks.findIndex((entry) => entry.id === req.params.id);
    if (index < 0) {
      fail(res, 404, 'bookmark_not_found', '指定されたブックマークが見つかりません。');
      return;
    }
    context.db.bookmarks.splice(index, 1);
    context.save();
    res.status(204).end();
  });

  router.get('/sftp/list', (req, res) => {
    const hostId = text(req.query.hostId);
    const path = text(req.query.path) ?? '.';
    const showHidden = req.query.showHidden === 'true';
    void withSftp(res, hostId, async (sftp) => {
      const listed = await listDirectory(sftp, path, { showHidden });
      res.json(listed);
    });
  });

  router.get('/sftp/stat', (req, res) => {
    const hostId = text(req.query.hostId);
    const path = text(req.query.path);
    if (!path) {
      fail(res, 400, 'invalid_request', 'パスを指定してください。');
      return;
    }
    void withSftp(res, hostId, async (sftp) => {
      res.json({ entry: await statPath(sftp, path) });
    });
  });

  router.get('/sftp/download', (req, res) => {
    const hostId = text(req.query.hostId);
    const path = text(req.query.path);
    if (!path) {
      fail(res, 400, 'invalid_request', 'パスを指定してください。');
      return;
    }
    void withSftp(res, hostId, async (sftp) => {
      const data = await readFile(sftp, path);
      res.setHeader('content-type', 'application/octet-stream');
      // 名前は UTF-8 のまま渡す(古い形の filename= は使わない)
      res.setHeader(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').pop() ?? 'download')}`,
      );
      res.send(data);
    });
  });

  router.post('/sftp/upload', express.raw({ type: '*/*', limit: '512mb' }), (req, res) => {
    const hostId = text(req.query.hostId);
    const directory = text(req.query.path);
    const name = text(req.query.name);
    if (!directory || !name) {
      fail(res, 400, 'invalid_request', '置き場所とファイル名を指定してください。');
      return;
    }
    void withSftp(res, hostId, async (sftp) => {
      const target = joinPath(directory, name);
      await writeFile(sftp, target, req.body as Buffer);
      res.status(201).json({ entry: await statPath(sftp, target) });
    });
  });

  router.post('/sftp/mkdir', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const path = text(body.path);
    if (!path) {
      fail(res, 400, 'invalid_request', 'パスを指定してください。');
      return;
    }
    void withSftp(res, text(body.hostId), async (sftp) => {
      await makeDirectory(sftp, path);
      res.status(201).json({ entry: await statPath(sftp, path) });
    });
  });

  router.post('/sftp/create', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const path = text(body.path);
    if (!path) {
      fail(res, 400, 'invalid_request', 'パスを指定してください。');
      return;
    }
    void withSftp(res, text(body.hostId), async (sftp) => {
      await createFile(sftp, path);
      res.status(201).json({ entry: await statPath(sftp, path) });
    });
  });

  router.post('/sftp/rename', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const from = text(body.from);
    const to = text(body.to);
    if (!from || !to) {
      fail(res, 400, 'invalid_request', '元のパスと新しいパスを指定してください。');
      return;
    }
    void withSftp(res, text(body.hostId), async (sftp) => {
      await renamePath(sftp, from, to);
      res.json({ entry: await statPath(sftp, to) });
    });
  });

  router.post('/sftp/remove', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const path = text(body.path);
    if (!path) {
      fail(res, 400, 'invalid_request', 'パスを指定してください。');
      return;
    }
    // 画面で確認を取ってから呼ばれる前提。フォルダは recursive を明示させる。
    void withSftp(res, text(body.hostId), async (sftp) => {
      await removePath(sftp, path, body.recursive === true);
      res.status(204).end();
    });
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
    }
    context.save();
    res.json({ settings });
  });

  return router;
}
