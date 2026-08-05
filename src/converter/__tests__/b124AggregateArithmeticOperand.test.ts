import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { resolveSelectMode, selectToFetchAllFields } from "../selectToKintone";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("B124-F01: 集計算術式の GROUP BY leaf を物理取得フィールドへ含める", () => {
  const stmt = parseSelect(
    "SELECT m.kind, SUM(t.amount) * m.price AS total FROM APP1 m " +
    "LEFT JOIN APP2 t ON m.id = t.id GROUP BY m.kind, m.price"
  );
  expect(resolveSelectMode(stmt)).toBe("FULL_SCAN");
  expect(selectToFetchAllFields(stmt, stmt.from)).toEqual(expect.arrayContaining(["kind", "price", "id"]));
  expect(selectToFetchAllFields(stmt, stmt.joins[0].table)).toEqual(expect.arrayContaining(["amount", "id"]));
});
