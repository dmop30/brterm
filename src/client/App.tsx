import { useEffect, useState } from 'react';

import type { HealthResponse } from '../shared/types';

type Status =
  { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error'; message: string };

/**
 * 骨組みの画面。サーバに繋がっているかだけを出す。
 * 端末・ファイル・エディタは docs/requirements.md のフェーズ順に足す。
 */
export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`サーバが ${res.status} を返した`);
        }
        return (await res.json()) as HealthResponse;
      })
      .then((health) => setStatus({ kind: 'ok', health }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="app">
      <h1 className="app__title">brterm</h1>
      <p className="app__lead">ブラウザで動く SSH / SFTP ターミナル</p>
      <section className="app__card" aria-live="polite">
        {status.kind === 'loading' && <p>サーバの状態を確認しています…</p>}
        {status.kind === 'ok' && (
          <dl className="app__facts">
            <dt>サーバ</dt>
            <dd>接続できた</dd>
            <dt>版</dt>
            <dd>{status.health.version}</dd>
            <dt>金庫</dt>
            <dd>{status.health.locked ? '施錠中' : '解錠済み'}</dd>
          </dl>
        )}
        {status.kind === 'error' && (
          <p className="app__error">
            サーバに繋がらない: {status.message}
            <br />
            <code>npm run dev</code> でサーバを起動してください。
          </p>
        )}
      </section>
    </main>
  );
}
