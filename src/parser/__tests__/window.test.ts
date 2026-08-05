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

test("B125: 集計ウィンドウと既定・明示フレームを AST に変換する", () => {
  const stmt = parseSelect(
    "SELECT SUM(x) OVER (PARTITION BY k ORDER BY d) AS range_default, " +
      "COUNT(*) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS rows_explicit, " +
      "MAX(name) OVER (PARTITION BY k) AS whole_partition FROM APP1"
  );
  expect(stmt.columns).toMatchObject([
    {
      type: "WINDOW_COL", windowKind: "AGGREGATE", aggFunc: "SUM",
      arg: { type: "FIELD_REF", field: "x" },
      frame: { unit: "RANGE", source: "DEFAULT" },
      partitionBy: [{ type: "FIELD", tableAlias: null, field: "k" }],
      orderBy: [{ key: { type: "FIELD_NAME", name: "d" }, direction: "ASC" }],
      alias: "range_default",
    },
    {
      type: "WINDOW_COL", windowKind: "AGGREGATE", aggFunc: "COUNT",
      arg: { type: "WILDCARD" }, frame: { unit: "ROWS", source: "EXPLICIT" },
      alias: "rows_explicit",
    },
    {
      type: "WINDOW_COL", windowKind: "AGGREGATE", aggFunc: "MAX",
      frame: null, orderBy: [], alias: "whole_partition",
    },
  ]);
});

test.each(["SUM", "COUNT", "AVG", "MIN", "MAX"])(
  "B125: %s の OVER を受け付ける",
  (func) => {
    const arg = func === "COUNT" ? "*" : "x";
    expect(parseSelect(`SELECT ${func}(${arg}) OVER () AS value FROM APP1`).columns[0])
      .toMatchObject({ type: "WINDOW_COL", windowKind: "AGGREGATE", aggFunc: func, frame: null });
  }
);

test.each([
  ["SELECT MEDIAN(x) OVER () AS v FROM APP1", /MEDIAN のウィンドウ集計は未対応です/],
  ["SELECT SUM(DISTINCT x) OVER () AS v FROM APP1", /引数の DISTINCT/],
  ["SELECT SUM(x) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS v FROM APP1", /ORDER BY/],
  ["SELECT SUM(x) OVER (ORDER BY d ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS v FROM APP1", /BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW だけ/],
  ["SELECT SUM(x) OVER (ORDER BY d) * 2 AS v FROM APP1", /同じ SELECT の式では使えません/],
  ["SELECT ROUND(SUM(x) OVER (ORDER BY d), 0) AS v FROM APP1", /同じ SELECT の式では使えません/],
  ["SELECT k FROM APP1 GROUP BY k HAVING SUM(x) OVER () > 0", /SELECT 列にのみ/],
  ["SELECT k FROM APP1 ORDER BY SUM(x) OVER ()", /SELECT 列にのみ/],
  ["SELECT SUM(x) OVER () FROM APP1", /AS alias/],
])("B125: 非対応の集計ウィンドウ構文を指定メッセージで拒否する: %s", (sql, message) => {
  expect(() => parseSelect(sql)).toThrow(message);
});

describe("B129: ウィンドウ結果を式に使ったときの診断", () => {
  // 依頼元（ksql-analytics）の指摘: 文章だけの制約は破られ、例のある制約は初回から守られる。
  // したがって一般形・例・位置の 3 点がすべて出ることを固定する。
  const forms = [
    ["関数で包む", "SELECT ROUND(SUM(x) OVER (ORDER BY d), 0) AS v FROM APP1"],
    ["算術に混ぜる", "SELECT SUM(x) OVER (ORDER BY d) * 2 AS v FROM APP1"],
  ] as const;

  test.each(forms)("%s: 一般形・○×の例・位置をすべて出す", (_label, sql) => {
    let message = "";
    try {
      parseSelect(sql);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("ウィンドウ関数の結果は同じ SELECT の式では使えません。");
    expect(message).toContain("× SELECT ROUND(SUM(x) OVER (), 1) AS a FROM t");
    expect(message).toContain("○ WITH w AS (SELECT SUM(x) OVER () AS 総計 FROM t) SELECT ROUND(総計, 1) AS a FROM w");
    expect(message).toContain("次の段（CTE または一時テーブル）に書いてください");
    // 位置・トークンは末尾に付く。SQL 行に食い込まないよう、最終行は文で終える。
    expect(message).toMatch(/書いてください（位置 \d+、トークン: 「[^」]+」）$/);
  });

  test("提示している ○ の形は実際にパースできる", () => {
    // 例が腐っていないことを固定する（過去に、実行していないサンプルを 3 回書いた）。
    const sql = "WITH w AS (SELECT SUM(x) OVER () AS 総計 FROM APP1) SELECT ROUND(総計, 1) AS a FROM w";
    expect(() => new Parser(new Lexer(sql).tokenize()).parse()).not.toThrow();
  });
});

test("B125: SELECT DISTINCT と集計ウィンドウの併用を維持する", () => {
  expect(parseSelect("SELECT DISTINCT SUM(x) OVER (ORDER BY d) AS total FROM APP1").distinct).toBe(true);
});
