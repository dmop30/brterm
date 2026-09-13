#!/bin/bash
# Claude Code on the web のセッション開始時に開発環境を作る。
#
# 目的は「セッションが始まった時点で typecheck と lint とテストが走ること」。
# web のコンテナは使い捨てで、clone 直後は node_modules が無い。
# 置き場所: <リポジトリ>/.claude/hooks/session-start.sh (要 chmod +x)
set -euo pipefail

# 手元の Claude Code では走らせない。ローカルの環境は本人が持っているため。
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Node の版を確かめる。20.11 未満では動かさない(package.json の engines と合わせる)。
check_node() {
  local major minor
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  minor=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
  [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 11 ]; }
}

# 何度実行しても同じ結果になること(startup 以外に resume / clear でも走る)。
# package-lock.json があるなら npm ci で同じ木を作る。無いときだけ npm install。
install_deps() {
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
}

if ! check_node; then
  echo "!! Node.js 20.11+ が要る (今: $(node -v 2>/dev/null || echo 'node が無い'))。" >&2
  echo "   typecheck / lint / test はこのままでは走らない。" >&2
  exit 0
fi

# 導入に失敗してもセッションは開始させる。ただし**黙って縮退しない**。
if ! install_deps; then
  echo "!! 依存の導入に失敗した。typecheck / lint / test はこのままでは走らない。" >&2
  echo "   見るところ: 環境のネットワークポリシー(npm レジストリに到達できるか)" >&2
  echo "              ネイティブ依存の混入(brterm は build ツールを要求しない方針)" >&2
  echo "   手で直すなら: make setup" >&2
  exit 0
fi

# **「導入が成功した」と「道具が入った」は別。** 実際に呼べるかを確かめる。
# 実測(auto-distillation): 依存定義の漏れで導入コマンドが警告だけ出して成功し、
# 検査器が入らないまま緑になったことがある。
missing=""
for bin in tsc eslint prettier tsx; do
  [ -x "node_modules/.bin/$bin" ] || missing="$missing $bin"
done
if [ -n "$missing" ]; then
  echo "!! 導入は成功したのに次を呼べない:$missing" >&2
  echo "   見るところ: package.json の devDependencies と node_modules/.bin" >&2
  echo "   手で直すなら: rm -rf node_modules && make setup" >&2
  exit 0
fi

# 以降のセッションで node_modules のコマンドを素で叩けるようにする
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$PWD/node_modules/.bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

echo "node      $(node -v)"
echo "npm       $(npm -v)"
echo "tsc       $(node_modules/.bin/tsc --version | sed 's/^Version //')"
echo "eslint    $(node_modules/.bin/eslint --version)"
echo "prettier  $(node_modules/.bin/prettier --version)"
