// package.json の version に追従してプラグイン zip をアップロードする。
// zip 名の固定書き（過去 v1.3.0 のまま放置され古い zip を上げる事故の元）を排除する。
// usage: npm run upload
"use strict";
const { spawnSync } = require("child_process");
const { existsSync } = require("fs");
const { version } = require("../package.json");

const zip = `dist/ksql-plugin-v${version}.zip`;
if (!existsSync(zip)) {
  console.error(`[kSQL] ${zip} がありません。先に npm run build:plugin を実行してください。`);
  process.exit(1);
}
// npm の .cmd シムを Windows で起動するため shell: true が必要
//（Node は CVE-2024-27980 対策で shell なしの .cmd 起動を拒否する）
const result = spawnSync("rex0220-plugin-uploader", ["-f", zip, "--watch"], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
