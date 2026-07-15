import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { resolveSelectMode, selectToFetchAllParams, selectToKintoneParams } from "../selectToKintone";

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
