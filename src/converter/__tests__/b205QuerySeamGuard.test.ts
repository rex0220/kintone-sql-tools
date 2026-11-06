import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

/**
 * B205 の**番人（ソース検査）**。実装レビューの BLOCKER（`whereToKintone` を直に呼ぶ経路が
 * 9 か所残っていた）が二度と戻らないようにする。
 *
 * kintone へ送る条件部は `serializeQueryForApp`（アプリ必須＝対応表を引ける）だけを通す。
 * 送らない文字列（計画の確かめ・`EXPLAIN` の表示）は `serializeWhereForDisplay` を通す。
 * どちらも通さない直呼びを**ファイル単位で**固定する（行で固定すると無関係な変更で落ちるため）。
 */
function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      collectTsFiles(join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function filesReferencing(pattern: RegExp): string[] {
  const root = resolve(__dirname, "../../..");
  const files = new Set<string>();
  for (const file of collectTsFiles(join(root, "src"))) {
    const rel = file.slice(root.length + 1).replace(/\\/g, "/");
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (pattern.test(line)) files.add(rel);
    }
  }
  return [...files].sort();
}

// 識別子として現れる所を拾う（**参照渡しも**。`testSeam.serialize ?? whereToKintone` のような
// 「呼び出しの形をしていない迂回」が実際に残っていたため）。後ろの `"` と `.` を外して、
// モジュールのパスと注釈の中のファイル名は数えない。
test("B205: whereToKintone を使うのは唯一の口と定義元だけ", () => {
  expect(filesReferencing(/\bwhereToKintone\b(?![".])/)).toEqual([
    // 条件部を作る唯一の口（送信用と表示用の両方がここから呼ぶ）
    "src/converter/queryForApp.ts",
    // 定義元（内部の再帰）
    "src/converter/whereToKintone.ts",
  ]);
});

test("B205: 表示専用の口を使うのは「送らない」経路だけ", () => {
  expect(filesReferencing(/\bserializeWhereForDisplay\b(?![".])/)).toEqual([
    "src/converter/queryForApp.ts",
    // 「関数が押し下がったか」の確かめ（文字列は捨てる）
    "src/core/optimization/relativeDatePrefilterPlan.ts",
    // 同上 ＋ EXPLAIN の表示行（RelativeDatePlanNode.restQuery）
    "src/core/optimization/relativeDatePushdownGuard.ts",
    // EXPLAIN の表示行（canonical では EXPLAIN 自体を拒む）
    "src/execute.ts",
  ]);
});
