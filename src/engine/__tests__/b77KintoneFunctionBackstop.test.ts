import { parseSqlStatement } from "../../core/sql";
import type { SelectStatement } from "../../types/ast";
import { evalWhere, resolveKintoneFunc } from "../evalWhere";

test.each([
  ["TODAY", "日付 = TODAY()"],
  ["NOW", "日時 <= NOW()"],
  ["LOGINUSER", "作成者 = LOGINUSER()"],
] as const)(
  "planner bypass で %s が WHERE evaluator に到達すると fail-closed",
  (_name, whereSql) => {
    const statement = parseSqlStatement(
      `SELECT * FROM APP100 WHERE ${whereSql}`
    ) as SelectStatement;
    if (statement.where === null) throw new Error("WHERE fixture expected");
    const where = statement.where;
    expect(() => evalWhere(where, {
      日付: "2026-07-27",
      日時: "2026-07-27T00:00:00Z",
      作成者: JSON.stringify({ code: "user" }),
    })).toThrow(
      new RegExp(`${_name}: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN`)
    );
  }
);

test("非 WHERE 用 resolveKintoneFunc は TODAY/NOW/LOGINUSER の既存契約を維持する", () => {
  expect(resolveKintoneFunc("TODAY")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(resolveKintoneFunc("NOW")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(resolveKintoneFunc("LOGINUSER")).toBe("");
});

test("planner bypass で IN (LOGINUSER()) が client evaluator に到達すると fail-closed", () => {
  const statement = parseSqlStatement(
    "SELECT * FROM APP100 WHERE 作成者 IN (LOGINUSER())"
  ) as SelectStatement;
  if (statement.where === null) throw new Error("WHERE fixture expected");
  const where = statement.where;
  expect(() => evalWhere(where, {
    作成者: JSON.stringify([{ code: "user" }]),
  })).toThrow(/LOGINUSER: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN/);
});
