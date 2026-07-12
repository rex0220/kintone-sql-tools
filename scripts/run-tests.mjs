import { spawnSync } from "node:child_process";
import { join } from "node:path";

const jestBin = join(process.cwd(), "node_modules", "jest", "bin", "jest.js");
const forwarded = process.argv.slice(2);

function run(args) {
  const result = spawnSync(process.execPath, [jestBin, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// 個別パスや --runInBand などが指定された場合は、従来どおり
// その引数を Jest へ直接渡す。引数なしの通常ゲートだけを分離する。
if (forwarded.length > 0) {
  process.exit(run(forwarded));
}

const parallelStatus = run([
  "--maxWorkers=2",
  "--testPathIgnorePatterns=console\\.e2e\\.test\\.ts|dml_guard\\.e2e\\.test\\.ts",
]);
if (parallelStatus !== 0) process.exit(parallelStatus);

process.exit(run([
  "--runInBand",
  "src/cli/__tests__/console.e2e.test.ts",
  "src/cli/__tests__/dml_guard.e2e.test.ts",
]));
