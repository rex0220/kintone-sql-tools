import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { resolveSelectMode, selectToFetchAllFields, selectToFetchAllParams } from "../selectToKintone";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("B64-X01: CASE 条件・THEN/ELSE・|| の全参照を required fields に収集する", () => {
  const stmt = parseSelect("SELECT SUM(CASE WHEN flag = wanted THEN amount ELSE fallback END), GROUP_CONCAT(name || suffix) FROM APP1");
  expect(selectToFetchAllFields(stmt, stmt.from)).toEqual(expect.arrayContaining([
    "flag", "wanted", "amount", "fallback", "name", "suffix",
  ]));
});

test("B64-X02: CASE 条件を WHERE pushdown に混ぜず元 WHERE だけを使う", () => {
  const stmt = parseSelect("SELECT SUM(CASE WHEN status = 'done' THEN amount ELSE 0 END) FROM APP1 WHERE tenant = 'A'");
  const params = selectToFetchAllParams(stmt, 1);
  expect(params.query).toContain('tenant = "A"');
  expect(params.query).not.toContain("status");
});

test("B64-X03: CASE 集計は FULL_SCAN のまま", () => {
  expect(resolveSelectMode(parseSelect("SELECT MODE(CASE WHEN p = 1 THEN n END) FROM APP1"))).toBe("FULL_SCAN");
  expect(resolveSelectMode(parseSelect("SELECT VAR_POP(CASE WHEN p = 1 THEN n END) FROM APP1"))).toBe("FULL_SCAN");
});

test("B64-X04: 異なる CASE 集計は異なる canonical 合成名になる", () => {
  const a = parseSelect("SELECT SUM(CASE WHEN p = 1 THEN 1 END), SUM(CASE WHEN p = 2 THEN 1 END) FROM APP1");
  const fields = selectToFetchAllFields(a, a.from);
  expect(fields).toContain("p");
  expect(a.columns[0]).not.toEqual(a.columns[1]);
});

