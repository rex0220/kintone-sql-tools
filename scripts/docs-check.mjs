#!/usr/bin/env node
/**
 * B138: 文書の構造検査。
 *
 * 2026-08-06 に課題台帳を 2 回壊し、どちらも「静かに壊れた」。
 *  - `node -e "..."` の二重引用符内でシェルがバッククォート間のテキストを食った
 *    （たまたまシェルがエラーを出したので気づけた）
 *  - Edit の置換文字列にパイプ文字を含め、表のセル数が 10 になった
 *    （この検査を書いて初めて見つけた。目視では見つかっていない）
 *
 * B135 の教訓（`mcp:smoke` はゲートに入っていなかったので 3 版にわたり失敗し続けた）を
 * 踏まえ、`npm test` から必ず走らせる。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(rootDir, "docs");
const trackerPath = join(docsDir, "ksql_issue_tracker.md");

const failures = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/**
 * リンク検査の前に、コード表現を取り除く。
 * フェンス内の正規表現（`[^\]]*](\d+)` 等）はリンクではないため、
 * 除かないと偽陽性でゲートが止まる（実測で 2 件出た）。
 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

// ------------------------------------------------------------
// 1. 相対リンクの参照先が存在するか
// ------------------------------------------------------------

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
let linkCount = 0;

for (const file of walk(docsDir)) {
  const text = stripCode(readFileSync(file, "utf8"));
  for (const match of text.matchAll(LINK)) {
    const target = match[1];
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    const clean = decodeURIComponent(target.split("#")[0]);
    if (!clean) continue;
    linkCount++;
    if (!existsSync(resolve(dirname(file), clean))) {
      failures.push(
        `${relative(rootDir, file).replace(/\\/g, "/")}: リンク切れ -> ${target}`
      );
    }
  }
}

// ------------------------------------------------------------
// 2. 課題台帳 §1 の行構造
// ------------------------------------------------------------

const BACKLOG_ROW = /^\| B\d+ \| /;
const EXPECTED_PIPES = 8;   // 7 セル ＝ 区切り 8 本

const trackerLines = readFileSync(trackerPath, "utf8").split(/\r?\n/);
let rowCount = 0;

trackerLines.forEach((line, index) => {
  if (!BACKLOG_ROW.test(line)) return;
  rowCount++;
  const where = `docs/ksql_issue_tracker.md:${index + 1}`;
  const id = line.slice(0, 12).trim();

  const pipes = (line.match(/\|/g) ?? []).length;
  if (pipes !== EXPECTED_PIPES) {
    failures.push(
      `${where}: ${id} のセル数が合いません（区切り ${pipes} 本 / 期待 ${EXPECTED_PIPES} 本）。`
      + "本文にパイプ文字を書いていないか確認してください"
    );
  }

  const backticks = (line.match(/`/g) ?? []).length;
  if (backticks % 2 !== 0) {
    failures.push(`${where}: ${id} のバッククォートが奇数（${backticks} 個）です`);
  }

  // シェルにテキストを食われたときの痕跡
  if (/＝[・、。]|（）|「」|\|\s*\|/.test(line)) {
    failures.push(`${where}: ${id} に空欄化の痕跡があります（置換で本文が消えていないか）`);
  }
});

if (rowCount === 0) {
  failures.push("docs/ksql_issue_tracker.md: §1 バックログの行が 1 件も見つかりません");
}

// ------------------------------------------------------------

if (failures.length > 0) {
  console.error(`[docs-check] ${failures.length} problem(s) found:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[docs-check] ok（リンク ${linkCount} 件 / 台帳 ${rowCount} 行）`);
