import { ArrowUp, FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { SftpEntry, SftpListResponse } from '../../shared/types';
import { authHeaders } from '../lib/token';
import type { HostView } from './HostsPanel';

interface Props {
  token?: string;
  /** 端末で繋いでいる接続先。SFTP はこの接続に相乗りする。 */
  host?: HostView;
  /** ここで端末を開く（フォルダのパスを渡す） */
  onOpenTerminalAt?: (path: string) => void;
}

function parentOf(path: string): string {
  const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return parent === '' ? '/' : parent;
}

function sizeText(entry: SftpEntry): string {
  if (entry.kind === 'directory') {
    return '';
  }
  if (entry.size < 1024) {
    return `${entry.size} B`;
  }
  return entry.size < 1024 * 1024
    ? `${(entry.size / 1024).toFixed(1)} KB`
    : `${(entry.size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * ファイルの一覧と基本の操作。
 *
 * 木構造・お気に入り・仮想スクロールは #19 で入れる。ここは SFTP が通ることを
 * 画面から確かめられる最小形にとどめる。
 */
export function FilesPanel({ token, host, onOpenTerminalAt }: Props) {
  const [path, setPath] = useState('.');
  const [listed, setListed] = useState<SftpListResponse>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!host) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const query = new URLSearchParams({ hostId: host.id, path });
        const response = await fetch(`/api/sftp/list?${query.toString()}`, {
          headers: authHeaders(token),
          signal: controller.signal,
        });
        const body = (await response.json()) as SftpListResponse & {
          error?: { message?: string };
        };
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          throw new Error(body.error?.message ?? `サーバが ${response.status} を返しました`);
        }
        setListed(body);
        setError(undefined);
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }
        setListed(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => controller.abort();
  }, [host, path, token, reload]);

  if (!host) {
    return (
      <div className="side__empty">
        <p>接続先に繋いでから開きます。</p>
        <p>「接続先」で端末を開くと、その接続に相乗りしてファイルを見られます。</p>
      </div>
    );
  }

  async function send(url: string, body: unknown): Promise<void> {
    if (!host) {
      return;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: JSON.stringify({ hostId: host.id, ...(body as object) }),
    });
    if (!response.ok) {
      const failure = (await response.json()) as { error?: { message?: string } };
      setError(failure.error?.message ?? '操作できませんでした。');
      return;
    }
    setReload((count) => count + 1);
  }

  const current = listed?.path ?? path;

  return (
    <div className="files">
      <div className="files__bar">
        <button
          type="button"
          className="button button--icon"
          aria-label="親フォルダへ"
          title="親フォルダへ"
          onClick={() => setPath(parentOf(current))}
        >
          <ArrowUp size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button button--icon"
          aria-label="再読み込み"
          title="再読み込み"
          onClick={() => setReload((count) => count + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button button--icon"
          aria-label="新しいフォルダ"
          title="新しいフォルダ"
          onClick={() => {
            const name = window.prompt('新しいフォルダの名前');
            if (name) {
              void send('/api/sftp/mkdir', { path: `${current}/${name}` });
            }
          }}
        >
          <FolderPlus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button button--icon"
          aria-label="新しいファイル"
          title="新しいファイル"
          onClick={() => {
            const name = window.prompt('新しいファイルの名前');
            if (name) {
              void send('/api/sftp/create', { path: `${current}/${name}` });
            }
          }}
        >
          <FilePlus size={14} aria-hidden="true" />
        </button>
        <button type="button" className="button" onClick={() => upload.current?.click()}>
          置く
        </button>
        <input
          ref={upload}
          type="file"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file || !host) {
              return;
            }
            const query = new URLSearchParams({ hostId: host.id, path: current, name: file.name });
            const response = await fetch(`/api/sftp/upload?${query.toString()}`, {
              method: 'POST',
              headers: { ...authHeaders(token), 'content-type': 'application/octet-stream' },
              body: await file.arrayBuffer(),
            });
            if (!response.ok) {
              const failure = (await response.json()) as { error?: { message?: string } };
              setError(failure.error?.message ?? '置けませんでした。');
            }
            event.target.value = '';
            setReload((count) => count + 1);
          }}
        />
      </div>

      <div className="files__path mono" title={current}>
        {current}
      </div>

      {error && (
        <p className="files__error" role="alert">
          {error}
        </p>
      )}

      {listed?.truncated && (
        <p className="files__note">
          先頭 {listed.entries.length} 件のみ表示（全 {listed.total} 件）
        </p>
      )}

      <ul className="files__list">
        {listed?.entries.map((entry) => (
          <li key={entry.path} className="files__item">
            <button
              type="button"
              className="files__open"
              disabled={entry.undecodable}
              title={entry.undecodable ? '名前を読めないため操作できません' : entry.path}
              onClick={() => {
                if (entry.kind === 'directory') {
                  setPath(entry.path);
                  return;
                }
                const query = new URLSearchParams({ hostId: host.id, path: entry.path });
                window.open(`/api/sftp/download?${query.toString()}`, '_blank');
              }}
            >
              <span className="files__name">
                {entry.kind === 'directory' ? '▣' : '▤'} {entry.name}
                {entry.undecodable && ' （名前を読めません）'}
              </span>
              <span className="files__meta mono">
                {entry.modeText} {sizeText(entry)}
              </span>
            </button>
            {entry.kind === 'directory' && onOpenTerminalAt && (
              <button
                type="button"
                className="button button--icon"
                aria-label={`${entry.name} で端末を開く`}
                title="ここで端末を開く"
                onClick={() => onOpenTerminalAt(entry.path)}
              >
                &gt;_
              </button>
            )}
            <button
              type="button"
              className="button button--icon"
              aria-label={`${entry.name} を改名`}
              title="改名"
              disabled={entry.undecodable}
              onClick={() => {
                const name = window.prompt('新しい名前', entry.name);
                if (name && name !== entry.name) {
                  void send('/api/sftp/rename', { from: entry.path, to: `${current}/${name}` });
                }
              }}
            >
              ✎
            </button>
            <button
              type="button"
              className="button button--icon"
              aria-label={`${entry.name} を削除`}
              title="削除"
              disabled={entry.undecodable}
              onClick={() => {
                // 破壊的な操作: **対象のホスト名とパスを文言に出す**（要件定義 4.3）
                const target = `${host.hostname}:${entry.path}`;
                const message =
                  entry.kind === 'directory'
                    ? `${target} を中身ごと削除します。取り消せません。`
                    : `${target} を削除します。取り消せません。`;
                if (window.confirm(message)) {
                  void send('/api/sftp/remove', {
                    path: entry.path,
                    recursive: entry.kind === 'directory',
                  });
                }
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
