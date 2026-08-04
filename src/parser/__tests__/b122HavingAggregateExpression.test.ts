import { Lexer } from "../../lexer/lexer";
import type { SelectStatement } from "../../types/ast";
import { Parser } from "../parser";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("B122-P01: HAVING の直接集計算術式を集計オペランドの木として保持する", () => {
  const stmt = parseSelect(
    "SELECT company, SUM(amount) AS total FROM APP1 GROUP BY company HAVING SUM(amount) - 0 > 9"
  );

  expect(stmt.having).toMatchObject({
    type: "BINARY",
    left: {
      type: "AGG_FIELD",
      expr: {
        type: "AGG_ARITH",
        op: "-",
        left: { type: "AGG_REF", func: "SUM" },
        right: { type: "NUMBER", value: 0 },
      },
    },
  });
});
