import { useEffect, useRef } from 'react';

interface Props {
  hostname: string;
  port: number;
  fingerprint: string;
  onAnswer: (accept: boolean) => void;
}

/**
 * 初回接続時のホスト鍵の確認。
 *
 * **既定のフォーカスは「接続しない」**（Enter 連打で受け入れてしまわないように）。
 * 文言にはホスト名と指紋を必ず出す。
 */
export function HostKeyDialog({ hostname, port, fingerprint, onAnswer }: Props) {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancel.current?.focus();
  }, []);

  return (
    <div className="scrim">
      <div className="dialog" role="alertdialog" aria-labelledby="hostkey-title" aria-modal="true">
        <h4 id="hostkey-title">この接続先のホスト鍵は未確認です</h4>
        <p>初めて接続する相手です。指紋が想定どおりか確かめてください。</p>
        <div className="dialog__target">
          {hostname}:{port}
          <br />
          <b>{fingerprint}</b>
        </div>
        <p className="dialog__note">
          受け入れると、この指紋を覚えます。次回から指紋が変わっていた場合は接続しません。
        </p>
        <div className="dialog__actions">
          <button type="button" className="button" ref={cancel} onClick={() => onAnswer(false)}>
            接続しない
          </button>
          <button type="button" className="button button--primary" onClick={() => onAnswer(true)}>
            受け入れて接続する
          </button>
        </div>
      </div>
    </div>
  );
}
