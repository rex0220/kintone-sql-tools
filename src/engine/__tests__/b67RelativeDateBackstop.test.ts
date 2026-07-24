import {
  WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN,
} from "../../core/relativeDateFunction";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SqlValue, WhereExpr } from "../../types/ast";
import { evalWhere } from "../evalWhere";

function relativeDateComparison(name: string): WhereExpr {
  const right = {
    type: "KINTONE_FUNC",
    name,
  } as unknown as SqlValue;

  return {
    type: "BINARY",
    op: "=",
    left: { type: "FIELD", tableAlias: null, field: "日付" },
    right,
  };
}

test.each([
  ["YESTERDAY", "引数なし"],
  ["FROM_TODAY", "相対期間"],
  ["THIS_WEEK", "週"],
  ["LAST_MONTH", "月"],
  ["NEXT_YEAR", "年"],
])(
  "planner を bypass して evalWhere に到達した %s（%s）は規定 reason で throw する",
  (name) => {
    expect(() => evalWhere(relativeDateComparison(name), { 日付: "2026-07-24" }))
      .toThrow(new RegExp(`${name}: ${WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN}`));
  }
);

test("未知の KINTONE_FUNC 名も default-deny する", () => {
  expect(() => evalWhere(relativeDateComparison("UNKNOWN_KINTONE_FUNC"), { 日付: "" }))
    .toThrow("InternalError: unexpected KINTONE_FUNC name: UNKNOWN_KINTONE_FUNC");
});

test("Step 1 では相対日付 SQL の parser 受理を開かない", () => {
  const sql = "SELECT * FROM APP1 WHERE 日付 = YESTERDAY()";
  expect(() => new Parser(new Lexer(sql).tokenize()).parse()).toThrow();
});
