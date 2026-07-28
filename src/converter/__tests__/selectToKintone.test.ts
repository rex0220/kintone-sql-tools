import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import { resolveBatchVariableReferences } from "../../execute";
import type { SelectStatement } from "../../types/ast";
import { resolveSelectMode, selectToFetchAllFields, selectToFetchAllParams, selectToKintoneParams } from "../selectToKintone";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("selectToKintoneParams: qualified field is normalized", () => {
  const stmt = parseSelect("SELECT a.オーダー番号 FROM APP69 AS a WHERE $id = 2116");
  const params = selectToKintoneParams(stmt);
  expect(params.fields).toEqual(["オーダー番号"]);
});

test("selectToKintoneParams: qualified refs in expressions are normalized", () => {
  const stmt = parseSelect("SELECT UPPER(a.担当者), a.金額 + 1 FROM APP69 AS a");
  const params = selectToKintoneParams(stmt);
  expect(params.fields).toEqual(["担当者", "金額"]);
});

test("B90: WHERE 変数の解決後 pushdown は同値の直接リテラルと一致する", () => {
  const statements = new Parser(
    new Lexer("SET @min = 300; SELECT 顧客名 FROM APP100 WHERE 売上 > @min").tokenize()
  ).parseStatements();
  const resolved = resolveBatchVariableReferences(
    statements[1],
    new Map([["min", { type: "number" as const, value: 300, raw: "300" }]])
  ) as SelectStatement;
  const literal = parseSelect("SELECT 顧客名 FROM APP100 WHERE 売上 > 300");
  expect(selectToKintoneParams(resolved)).toEqual(selectToKintoneParams(literal));
});

test("B90: 未解決の算術変数が SELECT 消費側へ到達したら内部エラーにする", () => {
  const stmt = parseSelect("SELECT 金額 + @rate AS total FROM APP100");
  expect(() => selectToKintoneParams(stmt)).toThrow(
    "InternalError: unresolved arithmetic variable @rate reached SELECT field collection."
  );
});

test("LIKE はワイルドカードの有無にかかわらず FULL_SCAN になり kintone へ押し下げない", () => {
  const stmt = parseSelect("SELECT DISTINCT 文字列 FROM APP100 WHERE 文字列 LIKE 'すと%'");
  expect(resolveSelectMode(stmt)).toBe("FULL_SCAN");
  expect(selectToFetchAllParams(stmt, 100).query).toBe("");
  const bare = parseSelect("SELECT 文字列 FROM APP100 WHERE 文字列 LIKE '会社'");
  expect(resolveSelectMode(bare)).toBe("FULL_SCAN");
  expect(selectToFetchAllParams(bare, 100).query).toBe("");
});

test("KLIKE は JS 評価を要求せず SIMPLE の kintone query へ押し下げる", () => {
  const stmt = parseSelect("SELECT 文字列 FROM APP100 WHERE 文字列 KLIKE '会社'");
  expect(resolveSelectMode(stmt)).toBe("SIMPLE");
  expect(selectToKintoneParams(stmt).query).toBe('文字列 like "会社"');
});

test("ウィンドウ列は FULL_SCAN を強制する", () => {
  const stmt = parseSelect("SELECT k, ROW_NUMBER() OVER (PARTITION BY k ORDER BY d DESC) AS rn FROM APP100");
  expect(resolveSelectMode(stmt)).toBe("FULL_SCAN");
});

test("B65-F01: GROUPING SETS (()) だけでも FULL_SCAN", () => {
  const stmt = parseSelect("SELECT COUNT(*) FROM APP100 GROUP BY GROUPING SETS (())");
  expect(resolveSelectMode(stmt)).toBe("FULL_SCAN");
});

test("B65-F02: 全 set の field を table 別に一度収集し GROUPING arg を追加投影しない", () => {
  const stmt = parseSelect(
    "SELECT l.a, r.b, GROUPING(l.a) AS ga, GROUPING(r.b) AS gb, COUNT(*) AS n " +
    "FROM APP1 l JOIN APP2 r ON l.id=r.id " +
    "GROUP BY GROUPING SETS ((l.a),(r.b),())"
  );
  expect(selectToFetchAllFields(stmt, stmt.from)).toEqual(["a", "id"]);
  expect(selectToFetchAllFields(stmt, stmt.joins[0].table)).toEqual(["b", "id"]);
});

test("SELECT しないウィンドウキーも取得フィールドへ含める", () => {
  const stmt = parseSelect(
    "SELECT a.k, ROW_NUMBER() OVER (PARTITION BY a.k ORDER BY a.d DESC, a.n + 1) AS rn FROM APP100 a"
  );
  expect(selectToFetchAllFields(stmt, stmt.from)).toEqual(expect.arrayContaining(["k", "d", "n"]));
});
