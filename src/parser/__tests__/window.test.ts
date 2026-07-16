import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError } from "../parser";
import type { SelectStatement } from "../../types/ast";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

test("順位系ウィンドウ関数を AST に変換する", () => {
  const stmt = parseSelect(
    "SELECT ROW_NUMBER() OVER (PARTITION BY a.k, b ORDER BY a.d DESC, n ASC) AS rn FROM APP1 a"
  );
  expect(stmt.columns[0]).toEqual({
    type: "WINDOW_COL",
    func: "ROW_NUMBER",
    partitionBy: [
      { type: "FIELD", tableAlias: "a", field: "k" },
      { type: "FIELD", tableAlias: null, field: "b" },
    ],
    orderBy: [
      { key: { type: "FIELD_NAME", name: "a.d" }, direction: "DESC" },
      { key: { type: "FIELD_NAME", name: "n" }, direction: "ASC" },
    ],
    alias: "rn",
  });
});

test.each(["ROW_NUMBER", "RANK", "DENSE_RANK"])("%s は OVER () を受け付ける", (func) => {
  const stmt = parseSelect(`SELECT ${func}() OVER () AS n FROM APP1`);
  expect(stmt.columns[0]).toMatchObject({ type: "WINDOW_COL", func, partitionBy: [], orderBy: [], alias: "n" });
});

test("OVER / PARTITION は通常のフィールド名として使える", () => {
  expect(parseSelect("SELECT OVER, PARTITION FROM APP1").columns).toMatchObject([
    { type: "FIELD", field: "OVER" },
    { type: "FIELD", field: "PARTITION" },
  ]);
});

test("順位関数名は予約語だがバッククォートでフィールド参照できる", () => {
  expect(parseSelect("SELECT `ROW_NUMBER`, `RANK`, `DENSE_RANK` FROM APP1").columns)
    .toMatchObject([
      { type: "FIELD", field: "ROW_NUMBER" },
      { type: "FIELD", field: "RANK" },
      { type: "FIELD", field: "DENSE_RANK" },
    ]);
});

test.each([
  "SELECT ROW_NUMBER(x) OVER () AS rn FROM APP1",
  "SELECT ROW_NUMBER() AS rn FROM APP1",
  "SELECT ROW_NUMBER() OVER () FROM APP1",
])("不正なウィンドウ構文を拒否する: %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow(ParseError);
});

test.each([
  "SELECT k, ROW_NUMBER() OVER (ORDER BY d) AS rn FROM APP1 GROUP BY k",
  "SELECT SUM(v), ROW_NUMBER() OVER (ORDER BY d) AS rn FROM APP1",
  "SELECT FORMAT(SUM(v), '#'), ROW_NUMBER() OVER () AS rn FROM APP1",
])("GROUP BY / 集計との同一 SELECT 混在を拒否する: %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow(/GROUP BY \/ 集計関数/);
});
