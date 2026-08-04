import { Lexer } from "../../lexer/lexer";
import type { SelectStatement } from "../../types/ast";
import { Parser } from "../parser";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("B121-P01: HAVING の直接集計参照に比較型解決用の集計情報を保持する", () => {
  const stmt = parseSelect(
    "SELECT company, SUM(amount) AS total FROM APP1 GROUP BY company HAVING SUM(amount) > 9"
  );

  expect(stmt.having).toMatchObject({
    type: "BINARY",
    left: {
      type: "FIELD",
      field: "SUM(amount)",
      aggregateRef: {
        type: "AGG_REF",
        func: "SUM",
        distinct: false,
        arg: { type: "FIELD_REF", field: "amount" },
      },
    },
  });
});
