import { readFileSync } from "fs";
import { resolve } from "path";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";
import type { SelectStatement } from "../types/ast";
import { runFullScan } from "../engine/process";

/**
 * B141 の再発防止（4 回目で機械化）。
 *
 * 言語リファレンスの「集計する値が 1 つも無いときの戻り値」の表と、エンジンの実際の
 * 戻り値が一致することを固定する。B142 で MIN / MAX を 0 から空文字へ変えたとき、
 * 同じ文書の別の表が 0 のまま残り、文書内で矛盾していた。
 *
 * B136 の列名パリティ（b136DocsColumnParity.test.ts）と同じ形。文書が機械照合できる
 * 形で書かれていれば、挙動を変えたときに文書側が落ちる。
 */

const DOC = resolve(__dirname, "../../docs/ksql_language_reference.md");

/** 表の 1 行から関数名と期待値を取り出す。 */
type DocRow = { funcs: string[]; expected: string };

function parseEmptySetTable(): DocRow[] {
  const text = readFileSync(DOC, "utf8");
  const marker = "**集計する値が 1 つも無いときの戻り値。**";
  const start = text.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  // 表は marker と同じブロッククォートの中にある。`>` で始まらない行が来たら終わり
  // （ブロッククォート内の空行も `>` 単独なので、空行では切らない）。
  const block: string[] = [];
  for (const line of text.slice(start).split(/\r?\n/)) {
    if (block.length > 0 && !line.startsWith(">")) break;
    block.push(line);
  }
  const rows: DocRow[] = [];
  for (const line of block) {
    const cells = line.replace(/^>\s*/, "").split("|").map((c) => c.trim());
    // | 関数 | 値が無いとき | 標準 SQL | の 3 列（前後の空セルを含めて 5 要素）
    if (cells.length !== 5 || cells[1] === "関数" || /^-+$/.test(cells[1])) continue;
    const funcs = [...cells[1].matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
    if (funcs.length === 0) continue;
    const value = cells[2];
    const expected = /空文字/.test(value) ? "" : value.replace(/[`*]/g, "");
    rows.push({ funcs, expected });
  }
  return rows;
}

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function runEmpty(func: string): string {
  const arg = func === "COUNT" ? "*" : "v";
  const stmt = parseSelect(`SELECT ${func}(${arg}) AS r FROM APP100`);
  const tables = new Map<string | null, KintoneRecord[]>([[null, []]]);
  return runFullScan({ stmt, tables, aggregateSortKindResolver: () => "string" }).rows[0]["r"];
}

test("B141: 空集合の戻り値が、言語リファレンスの表と一致する", () => {
  const rows = parseEmptySetTable();
  expect(rows.length).toBeGreaterThanOrEqual(3);
  for (const { funcs, expected } of rows) {
    for (const func of funcs) {
      expect(`${func}=${runEmpty(func)}`).toBe(`${func}=${expected}`);
    }
  }
});

test("B141: 集計関数がすべて表に載っている（新しい関数を足したら落ちる）", () => {
  const documented = new Set(parseEmptySetTable().flatMap((r) => r.funcs));
  const supported = [
    "COUNT", "SUM", "AVG", "MIN", "MAX", "MODE", "MEDIAN", "GROUP_CONCAT",
    "VAR_POP", "VAR_SAMP", "STDDEV_POP", "STDDEV_SAMP",
  ];
  expect([...supported].filter((f) => !documented.has(f))).toEqual([]);
});
