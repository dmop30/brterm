.PHONY: help setup check typecheck lint fmt fmt-check test dev build start clean

NPM := npm

help:  ## このヘルプを表示する
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup:  ## 依存を入れる(SessionStart hook が自動で走らせる)
	@if [ -f package-lock.json ]; then $(NPM) ci --no-audit --no-fund; else $(NPM) install --no-audit --no-fund; fi
	@echo "完了: make check"

check:  ## typecheck + lint + 整形確認 + テストをまとめて実行する
	$(NPM) run check

typecheck:  ## 型を検査する(PR 前に必ず通す)
	$(NPM) run typecheck

lint:  ## eslint で検査する
	$(NPM) run lint

fmt:  ## prettier で整形する
	$(NPM) run fmt

fmt-check:  ## 整形済みかだけ確かめる
	$(NPM) run fmt:check

test:  ## テストを実行する(node --test)
	$(NPM) test

dev:  ## 開発サーバを起動する(サーバ :7781 + Vite :5273)
	$(NPM) run dev

build:  ## dist/server と dist/client を作る
	$(NPM) run build

start:  ## ビルド済みを起動する
	$(NPM) start

clean:  ## 生成物を消す
	rm -rf dist node_modules/.cache
