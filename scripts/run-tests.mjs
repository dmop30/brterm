// tests 配下の *.test.ts を集めて `node --test` に渡す。
//
// なぜスクリプトにしたか: `node --test "tests/**/*.test.ts"` の形はグロブ展開が
// Node 22 では効くが **20.11 では効かない**(CI の最低支持版で「Could not find」で落ちた)。
// sh のグロブは再帰しないため、npm script に直書きしても解決しない。
// ここで自分で集めることで、対応環境(Node 20.11+)と OS の差を踏まない。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = 'tests';

function collect(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collect(path));
    } else if (entry.name.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found.sort();
}

const files = collect(TEST_DIR);

// 対象0件で成功を返すと「検査していないのに緑」になる。件数も出す。
if (files.length === 0) {
  console.error(`テストファイルが見つからない: ${TEST_DIR}/**/*.test.ts`);
  process.exit(1);
}
console.error(`テスト対象 ${files.length} ファイル`);

// 1 件あたりの上限を置く。既定は無制限で、繋ぎっぱなしの試験が CI を止めてしまう。
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-timeout', '30000', ...files],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
