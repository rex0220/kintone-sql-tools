import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError, WINDOW_RESULT_IN_EXPRESSION_MESSAGE } from "../parser";
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
])("B184-A: GROUP BY / 集計との同一 SELECT 混在を受け付ける: %s", (sql) => {
  expect(() => parseSelect(sql)).not.toThrow();
});

test("B184-A: ウィンドウ内の集計式と GROUPING() を専用 AST に保持する", () => {
  const stmt = parseSelect(
    "SELECT k, SUM(v) AS total, RANK() OVER (PARTITION BY GROUPING(k) ORDER BY SUM(v) DESC) AS r, " +
      "SUM(SUM(v)) OVER () AS grand FROM APP1 GROUP BY ROLLUP(k)"
  );
  expect(stmt.columns[2]).toMatchObject({
    type: "WINDOW_COL",
    partitionBy: [{ type: "GROUPING_REF", field: { field: "k" } }],
    orderBy: [{
      key: { type: "FIELD_NAME", name: "SUM(v)", aggregateRef: { type: "AGG_REF", func: "SUM" } },
      direction: "DESC",
    }],
  });
  expect(stmt.columns[3]).toMatchObject({
    type: "WINDOW_COL",
    windowKind: "AGGREGATE",
    arg: { type: "FIELD", field: "SUM(v)", aggregateRef: { type: "AGG_REF", func: "SUM" } },
  });
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
  ["SELECT k FROM APP1 GROUP BY k HAVING SUM(x) OVER () > 0", /同じ SELECT の式では使えません/],
  ["SELECT k FROM APP1 ORDER BY SUM(x) OVER ()", /同じ SELECT の式では使えません/],
  ["SELECT SUM(x) OVER () FROM APP1", /AS alias/],
])("B125: 非対応の集計ウィンドウ構文を指定メッセージで拒否する: %s", (sql, message) => {
  expect(() => parseSelect(sql)).toThrow(message);
});

describe("B184-B: SELECT 列内のウィンドウ結果を式に使う", () => {
  const forms = [
    ["関数で包む", "SELECT ROUND(SUM(x) OVER (ORDER BY d), 0) AS v FROM APP1"],
    ["算術に混ぜる", "SELECT SUM(x) OVER (ORDER BY d) * 2 AS v FROM APP1"],
  ] as const;

  test.each(forms)("%sを受理し hiddenWindows へ切り出す", (_label, sql) => {
    const stmt = parseSelect(sql);
    expect(stmt.hiddenWindows).toHaveLength(1);
    expect(stmt.columns[0]).toMatchObject({ alias: "v" });
  });

  test("同じウィンドウ式を構文的同一として1つに畳む", () => {
    const stmt = parseSelect(
      "SELECT CASE WHEN LAG(x) OVER (ORDER BY d) = '' THEN LAG(x) OVER (ORDER BY d) ELSE 'x' END AS v FROM APP1"
    );
    expect(stmt.hiddenWindows).toHaveLength(1);
    expect(stmt.hiddenWindows?.[0].alias).toBe("__ksql_window_0");
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

describe("B128: LAG / LEAD value windows", () => {
  test("LAG / LEAD と comma-aware な CASE 引数を AST に変換する", () => {
    const stmt = parseSelect(
      "SELECT LAG(x) OVER (PARTITION BY k ORDER BY d) AS prev, " +
      "LEAD(CASE WHEN flag = 'Y' THEN COALESCE(a, b) ELSE c END, 2) " +
      "OVER (ORDER BY d DESC) AS next FROM APP1"
    );
    expect(stmt.columns).toMatchObject([
      {
        type: "WINDOW_COL", windowKind: "VALUE", valueFunc: "LAG", offset: 1,
        arg: { type: "FIELD", tableAlias: null, field: "x" },
        partitionBy: [{ type: "FIELD", tableAlias: null, field: "k" }],
        orderBy: [{ key: { type: "FIELD_NAME", name: "d" }, direction: "ASC" }],
        alias: "prev",
      },
      {
        type: "WINDOW_COL", windowKind: "VALUE", valueFunc: "LEAD", offset: 2,
        arg: { type: "CASE_WHEN" },
        orderBy: [{ key: { type: "FIELD_NAME", name: "d" }, direction: "DESC" }],
        alias: "next",
      },
    ]);
  });

  test.each([
    "SELECT LAG(x, -1) OVER (ORDER BY d) AS v FROM APP1",
    "SELECT LAG(x, 1.5) OVER (ORDER BY d) AS v FROM APP1",
    "SELECT LAG(x, @offset) OVER (ORDER BY d) AS v FROM APP1",
    "SELECT LAG(x, 1 + 1) OVER (ORDER BY d) AS v FROM APP1",
    "SELECT LAG(x, 1, 'N/A') OVER (ORDER BY d) AS v FROM APP1",
  ])("非対応 offset/default を拒否する: %s", (sql) => {
    expect(() => parseSelect(sql)).toThrow(ParseError);
  });

  test.each([
    "SELECT ROUND(LAG(x) OVER (ORDER BY d), 1) AS v FROM APP1",
    "SELECT LAG(x) OVER (ORDER BY d) * 2 AS v FROM APP1",
    "SELECT CASE WHEN LAG(x) OVER (ORDER BY d) = 1 THEN 'Y' ELSE 'N' END AS v FROM APP1",
  ])("式内 VALUE window を受理する: %s", (sql) => {
    expect(parseSelect(sql).hiddenWindows).toHaveLength(1);
  });

  test("LAG / LEAD は soft keyword として同名フィールド参照を維持する", () => {
    expect(parseSelect("SELECT LAG, LEAD FROM APP1").columns).toMatchObject([
      { type: "FIELD", field: "LAG" },
      { type: "FIELD", field: "LEAD" },
    ]);
  });

  test("順位・集計・VALUE window を別 ORDER BY で混在できる", () => {
    expect(() => parseSelect(
      "SELECT ROW_NUMBER() OVER (ORDER BY a) AS rn, " +
      "SUM(x) OVER (ORDER BY b) AS total, LAG(x) OVER (ORDER BY c) AS prev FROM APP1"
    )).not.toThrow();
  });

  test("B184-A: VALUE window と GROUP BY / 集計関数の同一 SELECT 併用を構文上受け付ける", () => {
    expect(() => parseSelect(
      "SELECT k, LAG(x) OVER (ORDER BY d) AS prev FROM APP1 GROUP BY k"
    )).not.toThrow();
    expect(() => parseSelect(
      "SELECT SUM(x), LAG(x) OVER (ORDER BY d) AS prev FROM APP1"
    )).not.toThrow();
  });
});
