import { Lexer } from "../../lexer/lexer";
import { Parser } from "../parser";

function parseAll(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parseStatements();
}

test("DECLARE RELATIVE_DATE は14個の日付関数を既存ノード形で受け付ける", () => {
  const calls = [
    "TODAY()", "NOW()", "YESTERDAY()", "TOMORROW()",
    "THIS_YEAR()", "LAST_YEAR()", "NEXT_YEAR()",
    "FROM_TODAY(-1, MONTHS)",
    "THIS_WEEK(MONDAY)", "LAST_WEEK()", "NEXT_WEEK(SATURDAY)",
    "THIS_MONTH(LAST)", "LAST_MONTH(1)", "NEXT_MONTH(31)",
  ];

  for (const call of calls) {
    const declaration = parseAll(`DECLARE @p RELATIVE_DATE = ${call}; SELECT * FROM APP100 WHERE 日付 = @p`)[0];
    expect(declaration).toMatchObject({
      type: "DECLARE_VARIABLE",
      name: "p",
      annotation: "RELATIVE_DATE",
      default: { type: "KINTONE_FUNC" },
    });
  }
});

test("RELATIVE_DATE は型注釈位置だけの soft keyword", () => {
  expect(parseAll("SELECT RELATIVE_DATE FROM APP100 AS RELATIVE_DATE")[0]).toMatchObject({
    type: "SELECT",
    columns: [{ type: "FIELD", field: "RELATIVE_DATE" }],
    from: { alias: "RELATIVE_DATE" },
  });
});

test("注釈なし DECLARE TODAY は従来 AST のまま", () => {
  expect(parseAll("DECLARE @p = TODAY(); SELECT * FROM APP100 WHERE 日付 = @p")[0]).toEqual({
    type: "DECLARE_VARIABLE",
    name: "p",
    default: { type: "KINTONE_FUNC", name: "TODAY" },
  });
});

test.each([
  "'2026-08-01'",
  "LOGINUSER()",
  "PRIMARY_ORGANIZATION()",
  "THIS_MONTH",
])("RELATIVE_DATE の非日付トークン %s を拒否する", (value) => {
  expect(() => parseAll(`DECLARE @p RELATIVE_DATE = ${value}; SELECT * FROM APP100 WHERE 日付 = @p`))
    .toThrow(/RELATIVE_DATE/);
});
