import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { selectToKintoneParams } from "../selectToKintone";

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
