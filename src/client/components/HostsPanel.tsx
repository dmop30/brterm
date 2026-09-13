import { useEffect, useState } from 'react';

import { authHeaders } from '../lib/token';

/** 画面に出す接続先。パスワードはサーバから返らない。 */
export interface HostView {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  hasPassword: boolean;
}

interface Props {
  token?: string;
  onOpen: (host: HostView) => void;
}

interface Draft {
  label: string;
  hostname: string;
  port: string;
  username: string;
  password: string;
}

const EMPTY: Draft = { label: '', hostname: '', port: '22', username: '', password: '' };

/**
 * 接続先の一覧と登録。
 *
 * 登録の最小形だけを置く（鍵認証・プロファイルの指定は #15）。
 * 失敗したときは**サーバが返した日本語の理由をそのまま出す**。
 */
export function HostsPanel({ token, onOpen }: Props) {
  const [hosts, setHosts] = useState<HostView[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  /** 取り直しの合図。追加・削除のあとに増やす。 */
  const [reload, setReload] = useState(0);

  // 取得は副作用の中で完結させる。`reload` を増やすと取り直す。
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/hosts', {
          headers: authHeaders(token),
          signal: controller.signal,
        });
        const body = (await response.json()) as {
          hosts?: HostView[];
          error?: { message?: string };
        };
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          throw new Error(body.error?.message ?? `サーバが ${response.status} を返しました`);
        }
        setHosts(body.hosts ?? []);
        setError(undefined);
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => controller.abort();
  }, [token, reload]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const response = await fetch('/api/hosts', {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({
          label: draft.label,
          hostname: draft.hostname,
          port: Number(draft.port),
          username: draft.username,
          password: draft.password,
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? '接続先を登録できませんでした。');
      }
      setDraft(EMPTY);
      setAdding(false);
      setReload((count) => count + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (host: HostView) => {
    // 破壊的な操作なので、対象をそのまま文言に出す
    if (
      !window.confirm(
        `${host.label}（${host.username}@${host.hostname}:${host.port}）を削除します。`,
      )
    ) {
      return;
    }
    await fetch(`/api/hosts/${host.id}`, { method: 'DELETE', headers: authHeaders(token) });
    setReload((count) => count + 1);
  };

  return (
    <div className="hosts">
      {error && (
        <p className="hosts__error" role="alert">
          {error}
        </p>
      )}

      {hosts.length === 0 && !adding && <p className="side__empty">接続先がまだありません。</p>}

      <ul className="hosts__list">
        {hosts.map((host) => (
          <li key={host.id} className="hosts__item">
            <button type="button" className="hosts__open" onClick={() => onOpen(host)}>
              <span className="hosts__label">{host.label}</span>
              <span className="hosts__detail mono">
                {host.username}@{host.hostname}:{host.port}
              </span>
            </button>
            <button
              type="button"
              className="button button--icon"
              aria-label={`${host.label} を削除`}
              title="削除"
              onClick={() => void remove(host)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {adding ? (
        <form className="hosts__form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="host-label">名前</label>
          <input
            id="host-label"
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            required
          />
          <label htmlFor="host-hostname">ホスト名</label>
          <input
            id="host-hostname"
            value={draft.hostname}
            onChange={(event) => setDraft({ ...draft, hostname: event.target.value })}
            required
          />
          <label htmlFor="host-port">ポート</label>
          <input
            id="host-port"
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            onChange={(event) => setDraft({ ...draft, port: event.target.value })}
          />
          <label htmlFor="host-username">利用者名</label>
          <input
            id="host-username"
            value={draft.username}
            onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            required
          />
          <label htmlFor="host-password">パスワード</label>
          <input
            id="host-password"
            type="password"
            value={draft.password}
            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
          />
          <div className="hosts__actions">
            <button type="button" className="button" onClick={() => setAdding(false)}>
              やめる
            </button>
            <button type="submit" className="button button--primary">
              登録する
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="button" onClick={() => setAdding(true)}>
          接続先を追加
        </button>
      )}
    </div>
  );
}
