import {
  WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN,
} from "../../core/relativeDateFunction";
import type { SqlValue, WhereExpr } from "../../types/ast";
import { evalWhere, resolveKintoneFunc } from "../evalWhere";

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

test("legacy TODAY/NOW/LOGINUSER resolver の既存3ケースを変更しない", () => {
  expect(resolveKintoneFunc("TODAY")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(resolveKintoneFunc("NOW"))
    .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(resolveKintoneFunc("LOGINUSER")).toBe("");
});

test("PRIMARY_ORGANIZATION resolver は解決不能時に空文字へ fail-closed する", () => {
  expect(resolveKintoneFunc("PRIMARY_ORGANIZATION")).toBe("");
});
