import { readFileSync } from "fs";
import { resolve } from "path";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";
import type { SelectStatement } from "../types/ast";
import { runFullScan } from "../engine/process";

/**
 * B141 の再発防止。
 *
 * 言語リファレンスの「集計する値が無いときの戻り値」を書いた表と、エンジンの実際の
 * 戻り値が一致することを固定する。
 *
 * v3.54.1 でマーカー 1 つ分の表だけを照合したところ、**同じ節にあるもう 1 つの表**
 * （§8「0 件時の挙動」）を素通りさせ、5 回目を出した。そこで
 * **「値が無いとき」列を持つ表をすべて自動で見つけて照合する**形にしてある。
 * 表を新しく足しても、その列名を使う限り自動で検査対象になる。
 */

const DOC = resolve(__dirname, "../../docs/ksql_language_reference.md");

/** 空集合の戻り値を書いた表だと判定する列見出し。 */
const VALUE_COLUMN = /値が無いとき|0 件時の値/;

type DocRow = { funcs: string[]; expected: string; table: string };

function cellsOf(line: string): string[] {
  return line.replace(/^>\s*/, "").split("|").map((c) => c.trim());
}

/** バッククォートで囲まれた各断片の先頭識別子を関数名として拾う。 */
function functionsIn(cell: string): string[] {
  const names: string[] = [];
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const head = /^([A-Z_]+)/.exec(m[1]);
    if (head) names.push(head[1]);
  }
  return names;
}

/** 「空文字」と書いてあれば空、そうでなければ最初のバッククォート断片を値とみなす。 */
function expectedIn(cell: string): string {
  if (/空文字/.test(cell)) return "";
  const first = /`([^`]*)`/.exec(cell);
  return (first ? first[1] : cell).replace(/["'*]/g, "").trim();
}

function parseEmptySetTables(): DocRow[] {
  const lines = readFileSync(DOC, "utf8").split(/\r?\n/);
  const rows: DocRow[] = [];
  let valueIndex = -1;
  let tableLabel = "";
  for (const line of lines) {
    const cells = cellsOf(line);
    if (cells.length < 3 || !line.includes("|")) {
      valueIndex = -1;
      continue;
    }
    if (valueIndex < 0) {
      const found = cells.findIndex((c) => VALUE_COLUMN.test(c));
      if (found >= 0) {
        valueIndex = found;
        tableLabel = cells.filter(Boolean).join(" | ");
      }
      continue;
    }
    if (cells.every((c) => c === "" || /^-+$/.test(c))) continue;
    const funcs = functionsIn(cells[1]);
    if (funcs.length === 0 || cells[valueIndex] === undefined) continue;
    rows.push({ funcs, expected: expectedIn(cells[valueIndex]), table: tableLabel });
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

const SUPPORTED = [
  "COUNT", "SUM", "AVG", "MIN", "MAX", "MODE", "MEDIAN", "GROUP_CONCAT",
  "VAR_POP", "VAR_SAMP", "STDDEV_POP", "STDDEV_SAMP",
];

test("B141: 空集合の戻り値が、言語リファレンスの表すべてと一致する", () => {
  const rows = parseEmptySetTables();
  // 表の「個数」は固定しない。同じ値を書く場所は減らす方針なので、数を書くと
  // 減らしたときにこのテストが落ちる（v3.54.1 の照合が構造ではなく現状を写して
  // いたのと同じ失敗になる）。パーサが動いていることだけを確かめる。
  expect(rows.length).toBeGreaterThan(0);
  for (const { funcs, expected, table } of rows) {
    for (const func of funcs) {
      if (!SUPPORTED.includes(func)) continue;
      expect(`${table} / ${func}=${runEmpty(func)}`).toBe(`${table} / ${func}=${expected}`);
    }
  }
});

test("B141: 集計関数がすべて表に載っている（新しい関数を足したら落ちる）", () => {
  const documented = new Set(parseEmptySetTables().flatMap((r) => r.funcs));
  expect(SUPPORTED.filter((f) => !documented.has(f))).toEqual([]);
});
