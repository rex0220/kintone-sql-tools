import { parseSqlStatementsForScript } from "../../core/sql";
import type { DeclareVariableStatement } from "../../types/ast";

const header = "-- @ksql dialect: 1\n";
const declare = (sql: string) =>
  parseSqlStatementsForScript(`${header}${sql}\nSELECT 金額 FROM APP1 WHERE $id IN @ids;`)
    .statements[0] as DeclareVariableStatement;

test("B203: DECLARE @ids = []; は空配列の宣言になる（保存時の検査は default.type で見分ける）", () => {
  const statement = declare("DECLARE @ids = [];");
  expect(statement).toMatchObject({ type: "DECLARE_VARIABLE", name: "ids" });
  expect(statement.default).toEqual({ type: "ARRAY", elements: [] });
  expect(statement.annotation).toBeUndefined();
});

test("B203: 初期値つきの配列も書ける", () => {
  const statement = declare("DECLARE @ids = ['311','301'];");
  expect(statement.default).toEqual({
    type: "ARRAY",
    elements: [{ type: "STRING", value: "311" }, { type: "STRING", value: "301" }],
  });
});

test.each([
  ["数値の要素", "DECLARE @ids = [1];"],
  ["混在", "DECLARE @ids = ['a', 2];"],
  ["閉じ括弧なし", "DECLARE @ids = ['a';"],
])("B203: 配列の要素は文字列だけ: %s", (_label, sql) => {
  expect(() => parseSqlStatementsForScript(`${header}${sql}`)).toThrow();
});

test("B203: RELATIVE_DATE の宣言に配列は書けない", () => {
  expect(() => parseSqlStatementsForScript(`${header}DECLARE @d RELATIVE_DATE = [];`))
    .toThrow("RELATIVE_DATE の既定値にはサポート対象の相対日付関数トークンが必要です");
});

test("B203: スカラーの宣言は従来どおり", () => {
  const statement = parseSqlStatementsForScript(`${header}DECLARE @cust = 'C001';`)
    .statements[0] as DeclareVariableStatement;
  expect(statement.default).toMatchObject({ type: "STRING", value: "C001" });
});
