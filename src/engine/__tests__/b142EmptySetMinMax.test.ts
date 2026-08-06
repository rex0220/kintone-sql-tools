import type { KintoneRecord } from "../../converter/dmlToKintone";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { runFullScan } from "../process";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function records(rows: Array<Record<string, string>>): KintoneRecord[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { value }])));
}

function run(sql: string, rows: Array<Record<string, string>>, sort: "number" | "string" = "string") {
  return runFullScan({
    stmt: parseSelect(sql),
    tables: new Map([[null, records(rows)]]),
    aggregateSortKindResolver: () => sort,
  });
}

test("B142: 比較する値が無い MIN / MAX は空文字（入力 0 行）", () => {
  expect(run("SELECT MIN(v) AS lo, MAX(v) AS hi FROM APP1", []).rows[0])
    .toMatchObject({ lo: "", hi: "" });
});

test("B142: 値が 0 個でも 1 個でも同じ空文字になる（経路で割れない）", () => {
  // 非一致 NULL（ELSE 無しの CASE で条件に外れた行）は値として数えないので 0 個。
  const noMatch = run("SELECT MIN(CASE WHEN p = 'yes' THEN v END) AS lo FROM APP1",
    [{ p: "no", v: "A" }, { p: "no", v: "B" }]).rows[0].lo;
  // 選択された空セルは canonical empty band の値として保持されるので 1 個。
  const selectedEmpty = run("SELECT MIN(CASE WHEN p = 'yes' THEN v END) AS lo FROM APP1",
    [{ p: "yes", v: "" }, { p: "no", v: "A" }]).rows[0].lo;
  expect(noMatch).toBe("");
  expect(selectedEmpty).toBe("");
  // 修正前は前者が "0"（長さ 1 の文字列）で、後者の "" と割れていた。
  expect(noMatch).toBe(selectedEmpty);
});

test("B142: 空集合の戻り値を関数ごとに固定する", () => {
  const row = run(
    "SELECT COUNT(v) AS c, SUM(v) AS s, AVG(v) AS a,"
    + " MIN(v) AS lo, MAX(v) AS hi, MODE(v) AS md, MEDIAN(v) AS mdn,"
    + " STDDEV_POP(v) AS sd, VAR_POP(v) AS vp FROM APP1",
    [],
    "number"
  ).rows[0];
  // 合算・計数系は 0、比較・分布系は空文字。
  expect(row).toMatchObject({
    c: "0", s: "0", a: "0",
    lo: "", hi: "", md: "", mdn: "", sd: "", vp: "",
  });
});

test("B142: 型に関わらず空文字（数値列でも 0 に落ちない）", () => {
  expect(run("SELECT MIN(n) AS lo, MAX(n) AS hi FROM APP1", [], "number").rows[0])
    .toMatchObject({ lo: "", hi: "" });
});

test("B142: 値があるときの MIN / MAX は変わらない", () => {
  expect(run("SELECT MIN(v) AS lo, MAX(v) AS hi FROM APP1",
    [{ v: "B" }, { v: "A" }, { v: "C" }]).rows[0])
    .toMatchObject({ lo: "A", hi: "C" });
  // 空セルは並びの先頭に残る（canonical empty band・従来どおり）。
  expect(run("SELECT MIN(v) AS lo, MAX(v) AS hi FROM APP1",
    [{ v: "B" }, { v: "" }, { v: "A" }]).rows[0])
    .toMatchObject({ lo: "", hi: "B" });
});
