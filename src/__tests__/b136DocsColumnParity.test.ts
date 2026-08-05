import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESCRIBE_COLUMNS, SHOW_APPS_COLUMNS } from "../execute";

/**
 * B136: 言語リファレンスの列表と実装の定数が食い違わないことを固定する。
 *
 * この文書は MCP リソース `ksql://language-reference` の原本で、**エージェントが読む説明そのもの**。
 * 2026-08-06 に `SHOW APPS` / `DESCRIBE` の例と列表が実装と食い違っており、
 * **文書どおりに書くとエラーになる**状態が放置されていた（`WHERE type = 'NUMBER'` →
 * `unknown field code(s): type`）。依頼元の実測では「エージェントは文章より例を写す」ため、
 * 壊れた例は壊れたまま複製される。
 *
 * 例文そのものを実行して検証するのは重いので、**列名の表と定数の一致だけ**を機械で守る。
 * 表が正しい限り、その表から引いて書かれた例文も正しくなる。
 */

// B103: 作業ツリーの行末に依存させない。
const source = readFileSync(resolve("docs/ksql_language_reference.md"), "utf8")
  .replace(/\r\n/g, "\n");

/** `### <heading>` 直後の最初の markdown 表から、1 列目（カラム名）を取り出す。 */
function readColumnTable(headingPrefix: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`### ${headingPrefix}`));
  if (start < 0) throw new Error(`見出しが見つかりません: ### ${headingPrefix}`);

  const headerIndex = lines.findIndex(
    (line, index) => index > start && line.startsWith("| カラム |")
  );
  if (headerIndex < 0) throw new Error(`カラム表が見つかりません: ### ${headingPrefix}`);

  const columns: string[] = [];
  // ヘッダ行と区切り行の次から、表が途切れるまで
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const first = line.split("|")[1]?.trim() ?? "";
    columns.push(first.replace(/`/g, ""));
  }
  if (columns.length === 0) throw new Error(`カラム表が空です: ### ${headingPrefix}`);
  return columns;
}

test("B136: SHOW APPS の列表が実装の定数と一致する", () => {
  expect(readColumnTable("SHOW APPS")).toEqual([...SHOW_APPS_COLUMNS]);
});

test("B136: DESCRIBE の列表が実装の定数と一致する", () => {
  expect(readColumnTable("DESCRIBE")).toEqual([...DESCRIBE_COLUMNS]);
});

test("B136: 文書に旧列名（英語表記）が残っていない", () => {
  // 2026-08-06 まで文書は fieldCode / label / type / name と書いていた。
  // 実装は日本語列名なので、これらを SQL 例に書くと実行時エラーになる。
  const stale = ["fieldCode", "SELECT * FROM アプリ WHERE name ", "WHERE type ="];
  for (const token of stale) {
    expect(source).not.toContain(token);
  }
});
