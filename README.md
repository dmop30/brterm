# brterm

ブラウザで動く **SSH / SFTP ターミナル**。Windows・macOS・Linux で同じように動きます。

サーバの保守・運用では、ターミナル・SFTP クライアント・エディタ・Wiki を行き来することになります。
brterm はその往復を 1 画面に畳み込みます。

> **状態: 開発初期(骨組みのみ)。**
> 現時点で動くのは、サーバの起動・死活確認(`/api/health`)・画面の表示だけです。
> SSH 端末・SFTP・エディタなどの機能は未実装です。仕様と実装順は
> [`docs/requirements.md`](docs/requirements.md) にあります。

## 必要なもの

- Node.js 20.11 以上
- ビルドツールは不要です(ネイティブアドオンを要求する依存は入れない方針)

## 使い方

```bash
npm install        # 依存を入れる（make setup でも同じ）
npm run dev        # 開発: サーバ :7781 + Vite :5273 → http://127.0.0.1:5273
npm run build      # dist/server と dist/client を作る
npm start          # ビルド済みを起動 → http://127.0.0.1:7781
```

`make help` で入口の一覧が出ます。人・CI・Claude Code の hook は同じ入口を使います。

| コマンド                                 | 内容                                                |
| ---------------------------------------- | --------------------------------------------------- |
| `make setup`                             | 依存を入れる(`package-lock.json` があれば `npm ci`) |
| `make check`                             | typecheck + lint + 整形確認 + テスト                |
| `make typecheck`                         | 型検査(**PR 前に必ず通す**)                         |
| `make lint` / `make fmt`                 | eslint で検査 / prettier で整形                     |
| `make test`                              | `node --test`(tsx 経由で TypeScript をそのまま実行) |
| `make dev` / `make build` / `make start` | 開発起動 / ビルド / ビルド済み起動                  |

## 設定

| 環境変数            | 既定            | 内容                                                         |
| ------------------- | --------------- | ------------------------------------------------------------ |
| `BRTERM_HOST`       | `127.0.0.1`     | 待ち受けアドレス。**外部公開は明示的に変えるまで行いません** |
| `BRTERM_PORT`       | `7781`          | 待ち受けポート                                               |
| `BRTERM_DATA_DIR`   | `~/.brterm`     | データ保存先                                                 |
| `BRTERM_SSH_CONFIG` | `~/.ssh/config` | 読み書きする SSH の設定ファイル                              |

データ保存先の中身(予定を含む)は [`docs/requirements.md`](docs/requirements.md) 8 章にあります。

| 保存先                 | 内容                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `~/.brterm/db.json`    | 接続先・プロファイル・手順・予定・履歴・設定・既知のホスト鍵       |
| `~/.brterm/master.key` | ローカル鍵(600)。接続先の秘密はこれで暗号化する                    |
| `~/.brterm/token`      | 画面アクセス用トークン(600)                                        |
| `~/.brterm/keys/`      | brterm で作った SSH 鍵。秘密鍵は 600                               |
| `~/.brterm/logs/`      | 予定実行のログ。**機密は書きません**(パスワードらしき値は伏せます) |

予定実行(cron)は、**過ぎた分の取り返し運転をしません**。止まっていた間の予定は流れません。
また、**ホスト鍵が未確認の接続先では実行しません** — 先に端末で一度繋いで、鍵を確認してください。

## 開発環境

|        |                                                  |
| ------ | ------------------------------------------------ |
| 言語   | TypeScript 5 / Node.js 20.11+                    |
| サーバ | Express 4 / ws / ssh2 / iconv-lite / cron-parser |
| 画面   | React 18 / Vite 5 / @xterm/xterm / lucide-react  |
| 検査   | tsc / eslint 10 / prettier / `node --test`       |

### ディレクトリ

```
src/
  shared/   サーバ・画面で共有する型と既定値
  server/   Express + ws + ssh2（NodeNext。相対 import は .js 付き）
  client/   React + xterm.js（Bundler。相対 import は拡張子なし）
tests/      node --test（tsx 経由）
docs/       requirements.md = 単一の仕様書
```

`tsconfig` は 3 つ(`tsconfig.json` = 画面、`src/server/tsconfig.json` = サーバ、
`tests/tsconfig.json` = テスト)に分かれています。編集する場所に対応するものを見てください。

### VS Code

`.vscode/` に設定を入れてあります。推奨拡張(ESLint / Prettier / EditorConfig)を入れると、
保存時に整形と eslint の自動修正が走ります。

デバッグ構成(F5):

| 構成                           | 内容                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| サーバを起動してデバッグ (tsx) | `src/server/index.ts` をそのまま起動してブレークポイントを張れる |
| テストをデバッグ (node --test) | 開いているテストファイルだけを実行                               |
| テスト全件をデバッグ           | `tests/**/*.test.ts` を実行                                      |
| 画面を Chrome で開く           | `npm run dev` 済みの `http://127.0.0.1:5273` に接続              |

タスク(Ctrl+Shift+B / Ctrl+Shift+P → Run Task): `check` / `dev` / `typecheck`。

### Claude Code on the web

`.claude/hooks/session-start.sh` がセッション開始時に `npm ci` を実行し、
`tsc` / `eslint` / `prettier` / `tsx` が実際に呼べるところまで確かめます。
手元の Claude Code では走りません(`CLAUDE_CODE_REMOTE` で判定)。
導入に失敗してもセッションは開始しますが、**原因と直し方を必ず出します**。

手で確かめるには次を実行します。

```bash
CLAUDE_CODE_REMOTE=true CLAUDE_PROJECT_DIR="$PWD" CLAUDE_ENV_FILE=/tmp/env \
  ./.claude/hooks/session-start.sh
```

## 安全性について

- 既定は `127.0.0.1` 待ち受け。トークン認証と Origin 検証は実装予定(要件定義 7 章)
- 秘密情報はログに出しません
- 破壊的な操作は、対象のパスまたはホスト名を出したうえで確認します

## ライセンス

MIT
