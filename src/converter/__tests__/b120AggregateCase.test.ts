import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { resolveSelectMode, selectToFetchAllFields } from "../selectToKintone";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("B120-X01: CASE 内集計を FULL_SCAN と判定し、引数の物理フィールドだけを取得する", () => {
  const stmt = parseSelect(
    "SELECT company, CASE WHEN SUM(b) = 0 THEN '' ELSE ROUND(SUM(a) * 100.0 / SUM(b), 1) END AS rate " +
    "FROM APP1 GROUP BY company"
  );

  expect(resolveSelectMode(stmt)).toBe("FULL_SCAN");
  expect(selectToFetchAllFields(stmt, stmt.from)).toEqual(
    expect.arrayContaining(["company", "a", "b"])
  );
  expect(selectToFetchAllFields(stmt, stmt.from)).not.toContain("SUM(b)");
});
