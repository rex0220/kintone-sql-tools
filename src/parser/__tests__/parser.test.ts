import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError } from "../parser";
import type { SelectStatement, InsertStatement, UpdateStatement, DeleteStatement, UnionStatement, WithStatement } from "../../types/ast";

function parse(sql: string) {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parse();
}
function parseSelect(sql: string) { return parse(sql) as SelectStatement; }

// ----------------------------------------------------------------
// SELECT 基本
// ----------------------------------------------------------------

test("SELECT * FROM APP100", () => {
  const ast = parseSelect("SELECT * FROM APP100");
  expect(ast.type).toBe("SELECT");
  expect(ast.from.appId).toBe(100);
  expect(ast.columns).toEqual([{ type: "WILDCARD" }]);
  expect(ast.distinct).toBe(false);
});

test("SELECT フィールド指定 + AS", () => {
  const ast = parseSelect("SELECT 担当者 AS 担, 金額 FROM APP100");
  expect(ast.columns).toEqual([
    { type: "FIELD", field: "担当者", alias: "担" },
    { type: "FIELD", field: "金額",   alias: null },
  ]);
});

test("SELECT DISTINCT", () => {
  const ast = parseSelect("SELECT DISTINCT 種別 FROM APP100");
  expect(ast.distinct).toBe(true);
});

test("SELECT サブテーブル仮想テーブル", () => {
  const ast = parseSelect("SELECT * FROM APP100$明細");
  expect(ast.from).toEqual({ appId: 100, alias: null, cteName: null, subtableCode: "明細" });
});

test("SELECT _p.項目 / _p.*", () => {
  const ast = parseSelect("SELECT _p.案件名, _p.*, 商品コード FROM APP100$明細");
  expect(ast.columns[0]).toEqual({ type: "FIELD", field: "_p.案件名", alias: null });
  expect(ast.columns[1]).toEqual({ type: "PARENT_WILDCARD" });
  expect(ast.columns[2]).toEqual({ type: "FIELD", field: "商品コード", alias: null });
});

// ----------------------------------------------------------------
// 集計関数
// ----------------------------------------------------------------

test("COUNT(*)", () => {
  const ast = parseSelect("SELECT COUNT(*) FROM APP100");
  expect(ast.columns[0]).toEqual({
    type: "AGGREGATE", func: "COUNT", distinct: false,
    arg: { type: "WILDCARD" }, alias: null,
  });
});

test("COUNT(DISTINCT フィールド) AS alias", () => {
  const ast = parseSelect("SELECT COUNT(DISTINCT 種別) AS cnt FROM APP100");
  expect(ast.columns[0]).toEqual({
    type: "AGGREGATE", func: "COUNT", distinct: true,
    arg: { type: "FIELD_REF", field: "種別" }, alias: "cnt",
  });
});

test("SUM / AVG / MAX / MIN", () => {
  const ast = parseSelect("SELECT SUM(金額), AVG(金額), MAX(金額), MIN(金額) FROM APP100");
  const funcs = ast.columns.map((c) => (c as any).func);
  expect(funcs).toEqual(["SUM", "AVG", "MAX", "MIN"]);
});

test("FORMAT(SUM(...))", () => {
  const ast = parseSelect("SELECT FORMAT(SUM(金額), '#,##0') AS 合計 FROM APP100 GROUP BY 種別");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") {
    expect(col.expr.func).toBe("FORMAT");
    expect(col.expr.args[0]).toMatchObject({
      type: "AGG_REF",
      func: "SUM",
      arg: { type: "FIELD_REF", field: "金額" },
    });
    expect(col.alias).toBe("合計");
  }
});

test("FORMAT(100+SUM(...))", () => {
  const ast = parseSelect("SELECT FORMAT(100 + SUM(金額), '#,##0') AS 合計 FROM APP100 GROUP BY 種別");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") {
    expect(col.expr.func).toBe("FORMAT");
    expect(col.expr.args[0]).toMatchObject({
      type: "AGG_ARITH",
      op: "+",
      left: { type: "NUMBER", value: 100 },
      right: { type: "AGG_REF", func: "SUM" },
    });
  }
});

test("集計算術式: 末尾が集計関数でも AS alias を式全体に保持する", () => {
  const ast = parseSelect(
    "SELECT SUM(a) - SUM(b) AS diff, SUM(a) / COUNT(*) AS ratio FROM APP100"
  );

  expect(ast.columns[0]).toMatchObject({ type: "ARITH_AGG_COL", alias: "diff" });
  expect(ast.columns[1]).toMatchObject({ type: "ARITH_AGG_COL", alias: "ratio" });
});

test("集計算術式: DISTINCT・括弧・単項マイナス配下を alias 非消費で読む", () => {
  const ast = parseSelect(
    "SELECT SUM(DISTINCT a) - SUM(b) AS distinct_diff, " +
    "SUM(c) + (SUM(a) - SUM(b)) AS nested, " +
    "SUM(c) + -SUM(a) AS negated FROM APP100"
  );

  expect(ast.columns.map((col) => col.type === "ARITH_AGG_COL" ? col.alias : null)).toEqual([
    "distinct_diff",
    "nested",
    "negated",
  ]);
  expect(ast.columns[0]).toMatchObject({
    type: "ARITH_AGG_COL",
    expr: {
      type: "AGG_ARITH",
      left: { type: "AGG_REF", func: "SUM", distinct: true },
      right: { type: "AGG_REF", func: "SUM", distinct: false },
    },
  });
});

test.each([
  "SELECT SUM(a) AS x - SUM(b) FROM APP100",
  "SELECT SUM(c) + (SUM(a) AS x - SUM(b)) AS d FROM APP100",
  "SELECT FORMAT(SUM(a) AS x, '#') AS y FROM APP100",
])("集計算術式: オペランド途中の alias を拒否する — %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow(ParseError);
});

// ----------------------------------------------------------------
// WHERE 句
// ----------------------------------------------------------------

test("WHERE = 文字列", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE ステータス = '完了'");
  expect(ast.where).toEqual({
    type: "BINARY", op: "=",
    left:  { type: "FIELD", tableAlias: null, field: "ステータス" },
    right: { type: "STRING", value: "完了" },
  });
});

test("WHERE = 数値", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE $id = 1");
  expect((ast.where as any).right).toEqual({ type: "NUMBER", value: 1 });
});

test("WHERE LIKE", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE 件名 LIKE '%報告%'");
  expect((ast.where as any).op).toBe("LIKE");
});

test("WHERE KLIKE / NOT KLIKE は専用演算子として文字列・変数を受理する", () => {
  const klike = parseSelect("SELECT * FROM APP100 WHERE 件名 KLIKE 'foo_bar'");
  expect(klike.where).toMatchObject({
    type: "BINARY", op: "KLIKE", right: { type: "STRING", value: "foo_bar" },
  });
  const notKlike = parseSelect("SELECT * FROM APP100 WHERE 件名 NOT KLIKE @keyword");
  expect(notKlike.where).toMatchObject({
    type: "BINARY", op: "NOT_KLIKE", right: { type: "VARIABLE", name: "keyword" },
  });
});

test.each([
  "SELECT * FROM APP100 WHERE 件名 KLIKE 1",
  "SELECT * FROM APP100 WHERE 件名 KLIKE TODAY()",
  "SELECT * FROM APP100 WHERE 件名 NOT KLIKE UPPER(件名)",
])("KLIKE の非文字列右辺を構文段階で拒否する — %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow(/文字列リテラルまたはバッチ変数/);
});

test("KLIKE は予約語になり、同名フィールドはバッククォートで参照できる", () => {
  expect(() => parseSelect("SELECT KLIKE FROM APP100")).toThrow(ParseError);
  expect(parseSelect("SELECT `KLIKE` FROM APP100").columns[0]).toMatchObject({
    type: "FIELD", field: "KLIKE",
  });
});

test("WHERE IN", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE 種別 IN ('A', 'B')");
  const w = ast.where as any;
  expect(w.op).toBe("IN");
  expect(w.right.values).toEqual([
    { type: "STRING", value: "A" },
    { type: "STRING", value: "B" },
  ]);
});

test("WHERE IN / NOT IN は変数を単一要素・リテラル混在で受理する", () => {
  const inAst = parseSelect("SELECT * FROM APP100 WHERE 種別 IN (@Rank, 'B')");
  expect((inAst.where as any).right.values).toEqual([
    { type: "VARIABLE", name: "rank" },
    { type: "STRING", value: "B" },
  ]);

  const notInAst = parseSelect("SELECT * FROM APP100 WHERE 種別 NOT IN (@only)");
  expect(notInAst.where).toMatchObject({
    type: "BINARY",
    op: "NOT_IN",
    right: { type: "IN_LIST", values: [{ type: "VARIABLE", name: "only" }] },
  });
});

test("WHERE IS NULL / IS NOT NULL", () => {
  const ast1 = parseSelect("SELECT * FROM APP100 WHERE 担当者 IS NULL");
  expect(ast1.where).toEqual({ type: "NULL_CHECK", field: { type: "FIELD", tableAlias: null, field: "担当者" }, not: false });

  const ast2 = parseSelect("SELECT * FROM APP100 WHERE 担当者 IS NOT NULL");
  expect((ast2.where as any).not).toBe(true);
});

test("WHERE AND / OR / NOT", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 WHERE ステータス = '完了' AND NOT 担当者 IS NULL"
  );
  expect(ast.where?.type).toBe("LOGICAL");
  const logical = ast.where as any;
  expect(logical.op).toBe("AND");
  expect(logical.right.type).toBe("NOT");
});

test("WHERE TODAY() / NOW() / LOGINUSER()", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE 作成日 = TODAY()");
  expect((ast.where as any).right).toEqual({ type: "KINTONE_FUNC", name: "TODAY" });
});

test("WHERE 括弧グループ", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 WHERE (ステータス = '完了' OR ステータス = '承認') AND 金額 > 1000"
  );
  expect(ast.where?.type).toBe("LOGICAL");
  expect((ast.where as any).left.type).toBe("GROUP");
});

// ----------------------------------------------------------------
// WHERE 句の算術式・関数
// ----------------------------------------------------------------

test("WHERE 左辺算術式: 金額 * 1.1 > 10000", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE 金額 * 1.1 > 10000");
  const w = ast.where as any;
  expect(w.type).toBe("BINARY");
  expect(w.op).toBe(">");
  expect(w.left.type).toBe("ARITH_FIELD");
  expect(w.left.expr).toEqual({
    type: "ARITH",
    left: { type: "FIELD_REF", field: "金額" },
    op: "*",
    right: { type: "NUMBER", value: 1.1 },
  });
  expect(w.right).toEqual({ type: "NUMBER", value: 10000 });
});

test("WHERE 左辺算術式: (単価 + 送料) * 数量 <= 50000", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE (単価 + 送料) * 数量 <= 50000");
  const w = ast.where as any;
  expect(w.left.type).toBe("ARITH_FIELD");
  expect(w.left.expr.type).toBe("ARITH");
  expect(w.left.expr.op).toBe("*");
  expect(w.op).toBe("<=");
});

test("WHERE 左辺算術式: LENGTH(備考) > 10", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE LENGTH(備考) > 10");
  const w = ast.where as any;
  expect(w.left.type).toBe("FUNC_FIELD"); // 算術演算子なし → FUNC_FIELD のまま
  expect(w.left.expr.func).toBe("LENGTH");
  expect(w.right).toEqual({ type: "NUMBER", value: 10 });
});

test("WHERE 左辺算術式: LENGTH(備考) * 2 > 10", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE LENGTH(備考) * 2 > 10");
  const w = ast.where as any;
  expect(w.left.type).toBe("ARITH_FIELD"); // 関数 + 算術 → ARITH_FIELD
  expect(w.left.expr.type).toBe("ARITH");
  expect(w.left.expr.op).toBe("*");
});

test("WHERE 右辺算術式: WHERE 税込 = 金額 * 1.1", () => {
  const ast = parseSelect("SELECT * FROM APP100 WHERE 税込 = 金額 * 1.1");
  const w = ast.where as any;
  expect(w.left.type).toBe("FIELD");
  expect(w.right.type).toBe("ARITH_VALUE");
  expect(w.right.expr).toEqual({
    type: "ARITH",
    left: { type: "FIELD_REF", field: "金額" },
    op: "*",
    right: { type: "NUMBER", value: 1.1 },
  });
});

test("WHERE 修飾識別子の算術式: a.金額 * 1.1 > 10000", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 AS a INNER JOIN APP200 AS b ON a.ID = b.ID WHERE a.金額 * 1.1 > 10000"
  );
  const w = ast.where as any;
  expect(w.left.type).toBe("ARITH_FIELD");
  expect(w.left.expr.left).toEqual({ type: "FIELD_REF", field: "a.金額" });
});

// ----------------------------------------------------------------
// JOIN
// ----------------------------------------------------------------

test("INNER JOIN", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 AS a INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID"
  );
  expect(ast.from).toEqual({ appId: 100, alias: "a", cteName: null });
  expect(ast.joins).toHaveLength(1);
  expect(ast.joins[0]).toEqual({
    type: "INNER",
    table: { appId: 200, alias: "b", cteName: null },
    on: {
      left:  { tableAlias: "a", field: "顧客ID" },
      right: { tableAlias: "b", field: "顧客ID" },
    },
  });
});

test("INNER JOIN (implicit alias without AS)", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 a INNER JOIN APP200 b ON a.顧客ID = b.顧客ID"
  );
  expect(ast.from).toEqual({ appId: 100, alias: "a", cteName: null });
  expect(ast.joins[0].table).toEqual({ appId: 200, alias: "b", cteName: null });
});

test("SELECT string literal column with alias", () => {
  const ast = parseSelect("SELECT 顧客名, 'XXX' AS a FROM APP60");
  expect(ast.columns[1]).toEqual({ type: "LITERAL_COL", value: "XXX", alias: "a" });
});

test("SELECT literal without FROM", () => {
  const ast = parseSelect("SELECT 'xxx' AS a");
  expect(ast.from).toEqual({ appId: 0, alias: null, cteName: "__NO_FROM__" });
  expect(ast.columns[0]).toEqual({ type: "LITERAL_COL", value: "xxx", alias: "a" });
});

test("LEFT JOIN", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 AS a LEFT JOIN APP200 AS b ON a.ID = b.ID"
  );
  expect(ast.joins[0].type).toBe("LEFT");
});

// ----------------------------------------------------------------
// GROUP BY / HAVING / ORDER BY / LIMIT
// ----------------------------------------------------------------

test("GROUP BY / HAVING", () => {
  const ast = parseSelect(
    "SELECT 種別, COUNT(*) FROM APP100 GROUP BY 種別 HAVING COUNT(*) > 5"
  );
  expect(ast.groupBy).toEqual([{ type: "FIELD_NAME", name: "種別" }]);
  expect(ast.having).not.toBeNull();
});

test("ORDER BY 複数 / LIMIT", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 ORDER BY 作成日 DESC, 金額 ASC LIMIT 20"
  );
  expect(ast.orderBy).toEqual([
    { key: { type: "FIELD_NAME", name: "作成日" }, direction: "DESC" },
    { key: { type: "FIELD_NAME", name: "金額"   }, direction: "ASC"  },
  ]);
  expect(ast.limit).toBe(20);
});

// ----------------------------------------------------------------
// INSERT
// ----------------------------------------------------------------

test("INSERT 単一行", () => {
  const ast = parse(
    "INSERT INTO APP100 (名前, 金額) VALUES ('田中', 1000)"
  ) as InsertStatement;
  expect(ast.type).toBe("INSERT");
  expect(ast.appId).toBe(100);
  expect(ast.fields).toEqual(["名前", "金額"]);
  expect(ast.values).toEqual([[
    { type: "STRING", value: "田中" },
    { type: "NUMBER", value: 1000 },
  ]]);
});

test("INSERT 複数行", () => {
  const ast = parse(
    "INSERT INTO APP100 (名前) VALUES ('田中'), ('鈴木')"
  ) as InsertStatement;
  expect(ast.values).toHaveLength(2);
});

test("INSERT サブテーブル仮想テーブル", () => {
  const ast = parse(
    "INSERT INTO APP100$明細 (_pid, 商品コード) VALUES (1, 'A-001')"
  ) as InsertStatement;
  expect(ast.subtableCode).toBe("明細");
});

// ----------------------------------------------------------------
// UPDATE
// ----------------------------------------------------------------

test("UPDATE", () => {
  const ast = parse(
    "UPDATE APP100 SET ステータス = '完了', 金額 = 999 WHERE $id = 1"
  ) as UpdateStatement;
  expect(ast.type).toBe("UPDATE");
  expect(ast.appId).toBe(100);
  expect(ast.assignments).toEqual([
    { field: "ステータス", value: { type: "STRING", value: "完了" } },
    { field: "金額",       value: { type: "NUMBER", value: 999 } },
  ]);
});

test("UPDATE サブテーブル仮想テーブル", () => {
  const ast = parse(
    "UPDATE APP100$明細 SET 数量 = 5 WHERE _rid = 'r1'"
  ) as UpdateStatement;
  expect(ast.subtableCode).toBe("明細");
});

// ----------------------------------------------------------------
// DELETE
// ----------------------------------------------------------------

test("DELETE", () => {
  const ast = parse(
    "DELETE FROM APP100 WHERE 作成日 < '2023-01-01'"
  ) as DeleteStatement;
  expect(ast.type).toBe("DELETE");
  expect(ast.appId).toBe(100);
});

test("DELETE サブテーブル仮想テーブル", () => {
  const ast = parse(
    "DELETE FROM APP100$明細 WHERE _rid = 'r1'"
  ) as DeleteStatement;
  expect(ast.subtableCode).toBe("明細");
});

test("REORDER サブテーブル仮想テーブル", () => {
  const ast = parse(
    "REORDER APP100$明細 BY 商品コード ASC, 数量 DESC WHERE _pid = 1"
  ) as any;
  expect(ast.type).toBe("REORDER");
  expect(ast.appId).toBe(100);
  expect(ast.subtableCode).toBe("明細");
  expect(ast.all).toBe(false);
  expect(ast.where).not.toBeNull();
  expect(ast.by).toHaveLength(2);
});

test("REORDER ALL サブテーブル仮想テーブル", () => {
  const ast = parse(
    "REORDER ALL APP100$明細 BY 商品コード ASC"
  ) as any;
  expect(ast.type).toBe("REORDER");
  expect(ast.all).toBe(true);
  expect(ast.where).toBeNull();
});

test("REORDER ALL で WHERE 指定はエラー", () => {
  expect(() =>
    parse("REORDER ALL APP100$明細 BY 商品コード ASC WHERE _pid = 1")
  ).toThrow(ParseError);
});

// ----------------------------------------------------------------
// エラーケース
// ----------------------------------------------------------------

test("DELETE WHERE なし → エラー", () => {
  expect(() => parse("DELETE FROM APP100")).toThrow(ParseError);
});

test("UPDATE WHERE なし → エラー", () => {
  expect(() => parse("UPDATE APP100 SET f = 'v'")).toThrow(ParseError);
});

test("テーブル名が APP+数字でない → エラー", () => {
  expect(() => parse("SELECT * FROM CUSTOMERS")).toThrow(ParseError);
});

test("FROM なし SELECT はパース可能", () => {
  const ast = parseSelect("SELECT 'x' AS a");
  expect(ast.from).toEqual({ appId: 0, alias: null, cteName: "__NO_FROM__" });
});

test("IN リストのカラム数不一致 → エラー", () => {
  expect(() =>
    parse("INSERT INTO APP100 (f1, f2) VALUES ('a')")
  ).toThrow(ParseError);
});

// ----------------------------------------------------------------
// 文字列関数
// ----------------------------------------------------------------

test("SELECT UPPER(名前) AS n FROM APP100", () => {
  const ast = parseSelect("SELECT UPPER(名前) AS n FROM APP100");
  expect(ast.columns).toHaveLength(1);
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") {
    expect(col.expr.func).toBe("UPPER");
    expect(col.expr.args).toHaveLength(1);
    expect(col.expr.args[0]).toEqual({ type: "FIELD_REF", field: "名前" });
    expect(col.alias).toBe("n");
  }
});

test("SELECT LOWER(名前), TRIM(備考) FROM APP100", () => {
  const ast = parseSelect("SELECT LOWER(名前), TRIM(備考) FROM APP100");
  expect(ast.columns[0].type).toBe("STRFUNC_COL");
  expect(ast.columns[1].type).toBe("STRFUNC_COL");
  if (ast.columns[0].type === "STRFUNC_COL") expect(ast.columns[0].expr.func).toBe("LOWER");
  if (ast.columns[1].type === "STRFUNC_COL") expect(ast.columns[1].expr.func).toBe("TRIM");
});

test("SELECT SUBSTRING(名前, 1, 3) FROM APP100 — 1-indexed", () => {
  const ast = parseSelect("SELECT SUBSTRING(名前, 1, 3) AS 略称 FROM APP100");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") {
    expect(col.expr.func).toBe("SUBSTRING");
    expect(col.expr.args).toHaveLength(3);
    expect(col.alias).toBe("略称");
  }
});

test("SELECT SUBSTR(...) — SUBSTRING の別名", () => {
  const ast = parseSelect("SELECT SUBSTR(名前, 2) FROM APP100");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") expect(col.expr.func).toBe("SUBSTRING");
});

test("SELECT CONCAT(姓, ' ', 名) FROM APP100 — 文字列リテラル引数", () => {
  const ast = parseSelect("SELECT CONCAT(姓, ' ', 名) AS 氏名 FROM APP100");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") {
    expect(col.expr.func).toBe("CONCAT");
    expect(col.expr.args).toHaveLength(3);
    expect(col.expr.args[1]).toEqual({ type: "STRING", value: " " });
  }
});

test("SELECT REPLACE(ステータス, '完了', '済') FROM APP100", () => {
  const ast = parseSelect("SELECT REPLACE(ステータス, '完了', '済') FROM APP100");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") expect(col.expr.func).toBe("REPLACE");
});

test("SELECT UPPER(TRIM(名前)) FROM APP100 — ネスト", () => {
  const ast = parseSelect("SELECT UPPER(TRIM(名前)) AS 大文字 FROM APP100");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") {
    expect(col.expr.func).toBe("UPPER");
    expect(col.expr.args[0]).toMatchObject({ type: "STRING_FUNC", func: "TRIM" });
  }
});

test("SELECT LENGTH(名前) FROM APP100", () => {
  const ast = parseSelect("SELECT LENGTH(名前) FROM APP100");
  const col = ast.columns[0];
  expect(col.type).toBe("STRFUNC_COL");
  if (col.type === "STRFUNC_COL") expect(col.expr.func).toBe("LENGTH");
});

test("select LOWER(顧客名) from app89 — ユーザー実例", () => {
  const ast = parseSelect("select LOWER(顧客名) from app89");
  expect(ast.from.appId).toBe(89);
  expect(ast.columns[0].type).toBe("STRFUNC_COL");
  if (ast.columns[0].type === "STRFUNC_COL") {
    expect(ast.columns[0].expr.func).toBe("LOWER");
    expect(ast.columns[0].expr.args[0]).toEqual({ type: "FIELD_REF", field: "顧客名" });
  }
});

// ----------------------------------------------------------------
// UNION / UNION ALL
// ----------------------------------------------------------------

test("UNION — 2つの SELECT", () => {
  const ast = parse(
    "SELECT 名前 FROM APP100 UNION SELECT 名前 FROM APP200"
  ) as UnionStatement;
  expect(ast.type).toBe("UNION");
  expect(ast.all).toBe(false);
  expect(ast.left).toMatchObject({ type: "SELECT", from: { appId: 100 } });
  expect(ast.right).toMatchObject({ type: "SELECT", from: { appId: 200 } });
});

test("UNION ALL — 重複保持", () => {
  const ast = parse(
    "SELECT 名前 FROM APP100 UNION ALL SELECT 名前 FROM APP200"
  ) as UnionStatement;
  expect(ast.type).toBe("UNION");
  expect(ast.all).toBe(true);
});

// ----------------------------------------------------------------
// WITH 句（CTE）
// ----------------------------------------------------------------

test("WITH 句 — 単一 CTE", () => {
  const ast = parse(
    "WITH 月別 AS (SELECT 月, SUM(金額) AS 合計 FROM APP100 GROUP BY 月) SELECT * FROM 月別"
  ) as WithStatement;
  expect(ast.type).toBe("WITH");
  expect(ast.ctes).toHaveLength(1);
  expect(ast.ctes[0].name).toBe("月別");
  expect(ast.ctes[0].query).toMatchObject({ type: "SELECT", from: { appId: 100 } });
  expect(ast.query).toMatchObject({ type: "SELECT", from: { cteName: "月別" } });
});

test("WITH 句 — 複数 CTE", () => {
  const ast = parse(
    "WITH a AS (SELECT 名前 FROM APP100), b AS (SELECT 名前 FROM APP200) SELECT * FROM a"
  ) as WithStatement;
  expect(ast.ctes).toHaveLength(2);
  expect(ast.ctes[0].name).toBe("a");
  expect(ast.ctes[1].name).toBe("b");
});

test("WITH 句 — CTE を JOIN で使う", () => {
  const ast = parse(
    "WITH 受注 AS (SELECT 顧客ID, SUM(金額) AS 合計 FROM APP100 GROUP BY 顧客ID) " +
    "SELECT * FROM APP200 AS c INNER JOIN 受注 AS r ON c.顧客ID = r.顧客ID"
  ) as WithStatement;
  expect(ast.ctes[0].name).toBe("受注");
  expect(ast.query).toMatchObject({ type: "SELECT", from: { appId: 200 } });
  const q = ast.query as SelectStatement;
  expect(q.joins[0].table).toMatchObject({ cteName: "受注" });
});

test("WITH 句 — CTE 内で UNION", () => {
  const ast = parse(
    "WITH combined AS (SELECT 名前 FROM APP100 UNION ALL SELECT 名前 FROM APP200) " +
    "SELECT * FROM combined"
  ) as WithStatement;
  expect(ast.ctes[0].query).toMatchObject({ type: "UNION", all: true });
});

// ----------------------------------------------------------------
// CASE WHEN — WHERE 句・UPDATE SET
// ----------------------------------------------------------------

test("WHERE 左辺 CASE WHEN: CASE WHEN 区分 = '特別' THEN 金額 * 0.9 ELSE 金額 END > 1000", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 WHERE CASE WHEN 区分 = '特別' THEN 金額 ELSE 単価 END > 1000"
  );
  const w = ast.where!;
  expect(w.type).toBe("BINARY");
  if (w.type === "BINARY") {
    expect(w.left.type).toBe("CASE_FIELD");
    if (w.left.type === "CASE_FIELD") {
      expect(w.left.expr.type).toBe("CASE_WHEN");
      expect(w.left.expr.branches).toHaveLength(1);
      expect(w.left.expr.branches[0].condition).toMatchObject({ type: "BINARY", op: "=" });
      expect(w.left.expr.elseResult).toMatchObject({ type: "FIELD_REF", field: "単価" });
    }
    expect(w.op).toBe(">");
    expect(w.right).toMatchObject({ type: "NUMBER", value: 1000 });
  }
});

test("WHERE 右辺 CASE WHEN: WHERE 金額 = CASE WHEN 区分 = 'A' THEN 100 ELSE 200 END", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 WHERE 金額 = CASE WHEN 区分 = 'A' THEN 100 ELSE 200 END"
  );
  const w = ast.where!;
  expect(w.type).toBe("BINARY");
  if (w.type === "BINARY") {
    expect(w.right.type).toBe("CASE_VALUE");
    if (w.right.type === "CASE_VALUE") {
      expect(w.right.expr.type).toBe("CASE_WHEN");
      expect(w.right.expr.branches[0].result).toMatchObject({ type: "NUMBER", value: 100 });
      expect(w.right.expr.elseResult).toMatchObject({ type: "NUMBER", value: 200 });
    }
  }
});

test("UPDATE SET CASE WHEN: SET 金額 = CASE WHEN 区分 = '特別' THEN 500 ELSE 1000 END", () => {
  const ast = parse(
    "UPDATE APP100 SET 金額 = CASE WHEN 区分 = '特別' THEN 500 ELSE 1000 END WHERE $id = 1"
  ) as UpdateStatement;
  expect(ast.type).toBe("UPDATE");
  expect(ast.assignments).toHaveLength(1);
  const v = ast.assignments[0].value;
  expect(v.type).toBe("CASE_VALUE");
  if (v.type === "CASE_VALUE") {
    expect(v.expr.type).toBe("CASE_WHEN");
    expect(v.expr.branches[0].result).toMatchObject({ type: "NUMBER", value: 500 });
    expect(v.expr.elseResult).toMatchObject({ type: "NUMBER", value: 1000 });
  }
});

test("CASE WHEN ELSE なし — elseResult は null", () => {
  const ast = parseSelect(
    "SELECT * FROM APP100 WHERE CASE WHEN 区分 = 'A' THEN 1 END = 1"
  );
  const w = ast.where!;
  if (w.type === "BINARY" && w.left.type === "CASE_FIELD") {
    expect(w.left.expr.elseResult).toBeNull();
  } else {
    fail("expected BINARY with CASE_FIELD left");
  }
});

test("UPDATE CASE WHEN — ユーザー実例: $id 比較 + 小文字キーワード", () => {
  const ast = parse(
    `update APP89\nset 顧客ランク = case when $id < 10 then 'X' else 'V' end\nWHERE $id = 10`
  ) as UpdateStatement;
  expect(ast.type).toBe("UPDATE");
  expect(ast.appId).toBe(89);
  const v = ast.assignments[0].value;
  expect(v.type).toBe("CASE_VALUE");
  if (v.type === "CASE_VALUE") {
    expect(v.expr.branches[0].result).toMatchObject({ type: "STRING", value: "X" });
    expect(v.expr.elseResult).toMatchObject({ type: "STRING", value: "V" });
  }
});

test("UNION チェーン — 3つの SELECT", () => {
  const ast = parse(
    "SELECT 名前 FROM APP100 UNION SELECT 名前 FROM APP200 UNION SELECT 名前 FROM APP300"
  ) as UnionStatement;
  // 右結合ではなく左結合: ((A UNION B) UNION C)
  expect(ast.type).toBe("UNION");
  expect(ast.right).toMatchObject({ type: "SELECT", from: { appId: 300 } });
  expect(ast.left).toMatchObject({ type: "UNION" });
  if (ast.left.type === "UNION") {
    expect(ast.left.left).toMatchObject({ type: "SELECT", from: { appId: 100 } });
    expect(ast.left.right).toMatchObject({ type: "SELECT", from: { appId: 200 } });
  }
});
