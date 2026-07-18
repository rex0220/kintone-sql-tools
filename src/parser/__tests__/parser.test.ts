import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError } from "../parser";
import type { SelectStatement, InsertStatement, UpdateStatement, DeleteStatement, UnionStatement, WithStatement } from "../../types/ast";

function parse(sql: string) {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parse();
}
function parseBatch(sql: string) {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parseStatements();
}
function parseSelect(sql: string) { return parse(sql) as SelectStatement; }

test("DML VALIDATE ONLY suffix をsoft keywordとして解析する", () => {
  expect(parse("INSERT INTO APP100 (name) VALUES ('x') VALIDATE ONLY")).toMatchObject({
    type: "INSERT", validateOnly: true, validationErrorTable: null,
  });
  expect(parse("UPSERT INTO APP100 (code) SELECT code FROM APP200 ON DUPLICATE (code) VALIDATE ONLY INTO #err")).toMatchObject({
    type: "UPSERT_SELECT", validateOnly: true, validationErrorTable: "#err",
  });
  expect(parse("UPDATE APP100 SET name = 'x' WHERE $id = 1 VALIDATE ONLY")).toMatchObject({
    type: "UPDATE", validateOnly: true,
  });
});

test("DML ON ERROR SKIP suffix と REJECT LIMIT を解析する", () => {
  expect(parse("INSERT INTO APP100 (name) VALUES ('x') ON ERROR SKIP INTO #err")).toMatchObject({
    type: "INSERT", onErrorSkip: true, errorTable: "#err", rejectLimit: null,
  });
  expect(parse("UPDATE APP100 SET name = 'x' WHERE $id = 1 ON ERROR SKIP INTO #err REJECT LIMIT 0")).toMatchObject({
    type: "UPDATE", onErrorSkip: true, errorTable: "#err", rejectLimit: 0,
  });
  for (const sql of [
    "INSERT INTO APP100 (x) VALUES ('a') REJECT LIMIT 1",
    "INSERT INTO APP100 (x) VALUES ('a') ON ERROR SKIP INTO #err REJECT LIMIT -1",
    "INSERT INTO APP100 (x) VALUES ('a') ON ERROR SKIP INTO #err REJECT LIMIT 1.5",
    "INSERT INTO APP100 (x) VALUES ('a') ON ERROR SKIP INTO #err REJECT LIMIT 9007199254740992",
  ]) expect(() => parse(sql)).toThrow(ParseError);
});

test("validate / only は通常フィールド名として維持する", () => {
  expect(parse("INSERT INTO APP100 (validate, only) VALUES ('a', 'b')")).toMatchObject({
    type: "INSERT", fields: ["validate", "only"],
  });
});

test("サブテーブル VALIDATE ONLY を拒否する", () => {
  expect(() => parse("INSERT INTO APP100$rows (x) VALUES ('a') VALIDATE ONLY")).toThrow(ParseError);
  expect(() => parse("UPDATE APP100$rows SET x = 'a' WHERE _pid = 1 VALIDATE ONLY")).toThrow(ParseError);
});

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

test("GROUP_CONCAT: DISTINCT と SEPARATOR を AST に保持する", () => {
  const ast = parseSelect(
    "SELECT GROUP_CONCAT(DISTINCT 担当者 SEPARATOR ' / ') AS members FROM APP100"
  );
  expect(ast.columns[0]).toEqual({
    type: "AGGREGATE",
    func: "GROUP_CONCAT",
    distinct: true,
    arg: { type: "FIELD_REF", field: "担当者" },
    separator: " / ",
    alias: "members",
  });
});

test("GROUP_CONCAT: 文字列関数内でも SEPARATOR を AggregateRef に保持する", () => {
  const ast = parseSelect(
    "SELECT UPPER(GROUP_CONCAT(担当者 SEPARATOR ' / ')) AS members FROM APP100"
  );
  expect(ast.columns[0]).toMatchObject({
    type: "STRFUNC_COL",
    expr: {
      func: "UPPER",
      args: [{
        type: "AGG_REF",
        func: "GROUP_CONCAT",
        separator: " / ",
      }],
    },
  });
});

test.each([
  "SELECT GROUP_CONCAT(*) FROM APP100",
  "SELECT GROUP_CONCAT(DISTINCT *) FROM APP100",
  "SELECT 種別, GROUP_CONCAT(担当者) FROM APP100 GROUP BY 種別 HAVING GROUP_CONCAT(*) != ''",
])("GROUP_CONCAT はワイルドカード引数を拒否する: %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow(/GROUP_CONCAT\(\*\) は使用できません/);
});

test("SEPARATOR は GROUP_CONCAT 以外の集約では拒否し、通常のフィールド名としては使える", () => {
  expect(() => parseSelect("SELECT SUM(金額 SEPARATOR ',') FROM APP100"))
    .toThrow(/SEPARATOR は GROUP_CONCAT でのみ使用できます/);
  expect(parseSelect("SELECT SEPARATOR FROM APP100").columns[0]).toEqual({
    type: "FIELD", field: "SEPARATOR", alias: null,
  });
});

test("GROUP_CONCAT は予約語で、同名フィールドはバッククォートで参照できる", () => {
  expect(() => parseSelect("SELECT GROUP_CONCAT FROM APP100")).toThrow();
  expect(parseSelect("SELECT `GROUP_CONCAT` FROM APP100").columns[0]).toEqual({
    type: "FIELD", field: "GROUP_CONCAT", alias: null,
  });
});

test("HAVING の GROUP_CONCAT 直接参照でも SEPARATOR を受理する", () => {
  const ast = parseSelect(
    "SELECT 種別, GROUP_CONCAT(担当者 SEPARATOR '/') FROM APP100 " +
    "GROUP BY 種別 HAVING GROUP_CONCAT(担当者 SEPARATOR '/') != ''"
  );
  expect(ast.having).toMatchObject({
    type: "BINARY",
    left: { type: "FIELD", field: "GROUP_CONCAT(担当者)" },
  });
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
  expect((ast.where as any).right).toEqual({ type: "NUMBER", value: 1, raw: "1" });
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

test("WHERE IN / NOT IN は符号付き数値を数値リテラルとして受理する", () => {
  const inAst = parseSelect(
    "SELECT * FROM APP100 WHERE 金額 IN (0, 1000, -1, +1, '-1', @v)"
  );
  expect((inAst.where as any).right.values).toEqual([
    { type: "NUMBER", value: 0, raw: "0" },
    { type: "NUMBER", value: 1000, raw: "1000" },
    { type: "NUMBER", value: -1, raw: "-1" },
    { type: "NUMBER", value: 1, raw: "+1" },
    { type: "STRING", value: "-1" },
    { type: "VARIABLE", name: "v" },
  ]);

  const notInAst = parseSelect("SELECT * FROM APP100 WHERE 金額 NOT IN (-1)");
  expect(notInAst.where).toMatchObject({
    type: "BINARY",
    op: "NOT_IN",
    right: { type: "IN_LIST", values: [{ type: "NUMBER", value: -1 }] },
  });
});

test.each([
  "SELECT * FROM APP100 WHERE 金額 IN (-)",
  "SELECT * FROM APP100 WHERE 金額 IN (-'a')",
  "SELECT * FROM APP100 WHERE 金額 IN (+@v)",
])("WHERE IN の符号直後が数値でない場合は従来の ParseError にする — %s", (sql) => {
  expect(() => parseSelect(sql)).toThrow(
    /IN リストには文字列、数値、またはバッチ変数が必要です/
  );
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
    right: { type: "NUMBER", value: 1.1, raw: "1.1" },
  });
  expect(w.right).toEqual({ type: "NUMBER", value: 10000, raw: "10000" });
});

test("指数数値と2^53境界の raw lexeme をASTへ保持する", () => {
  const exponent = parseSelect("SELECT * FROM APP100 WHERE amount = 1.20e+21");
  expect((exponent.where as any).right).toEqual({
    type: "NUMBER", value: 1.2e21, raw: "1.20e+21",
  });
  const boundary = parseSelect("SELECT * FROM APP100 WHERE amount BETWEEN 9007199254740992 AND 9007199254740993");
  const group = boundary.where as any;
  expect([group.left, group.right].map((expr: any) => expr.right.raw)).toEqual([
    "9007199254740992", "9007199254740993",
  ]);
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
  expect(w.right).toEqual({ type: "NUMBER", value: 10, raw: "10" });
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
    right: { type: "NUMBER", value: 1.1, raw: "1.1" },
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
  expect(ast.orderMode).toBe("CANONICAL");
});

test("KORDER BY は native order mode としてトップレベル SELECT にだけ受理する", () => {
  const ast = parseSelect("SELECT * FROM APP100 KORDER BY 金額 DESC, $id ASC LIMIT 20");
  expect(ast.orderMode).toBe("KINTONE_NATIVE");
  expect(ast.orderBy).toHaveLength(2);
  expect(() => parse("SELECT KORDER FROM APP100")).toThrow(ParseError);
  expect(parseSelect("SELECT `KORDER` FROM APP100").columns[0]).toMatchObject({ field: "KORDER" });
});

test.each([
  "WITH x AS (SELECT * FROM APP100 KORDER BY $id LIMIT 1) SELECT * FROM x",
  "SELECT * FROM APP100 WHERE $id IN (SELECT $id FROM APP200 KORDER BY $id LIMIT 1)",
  "SELECT * FROM APP100 KORDER BY $id LIMIT 1 UNION ALL SELECT * FROM APP200",
  "INSERT INTO APP200 ($id) SELECT $id FROM APP100 KORDER BY $id LIMIT 1",
  "UPSERT INTO APP200 ($id) SELECT $id FROM APP100 KORDER BY $id LIMIT 1 ON DUPLICATE ($id)",
  "CREATE TEMP TABLE #x AS SELECT $id FROM APP100 KORDER BY $id LIMIT 1",
  "UPDATE APP100 SET value = (SELECT value FROM APP200 KORDER BY $id LIMIT 1) WHERE $id = 1",
])("nested KORDER BY を拒否する: %s", (sql) => {
  expect(() => parse(sql)).toThrow(/KORDER BY/);
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
    { type: "NUMBER", value: 1000, raw: "1000" },
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
    { field: "金額",       value: { type: "NUMBER", value: 999, raw: "999" } },
  ]);
});

test("UPDATE サブテーブル仮想テーブル", () => {
  const ast = parse(
    "UPDATE APP100$明細 SET 数量 = 5 WHERE _rid = 'r1'"
  ) as UpdateStatement;
  expect(ast.subtableCode).toBe("明細");
});

test("UPDATE FROM #temp: ソース参照と結合条件を分解する", () => {
  const ast = parseBatch(
    "UPDATE APP100 SET c = e.f, status = 'ok', total = amount * 2 FROM #e e WHERE APP100.$id = e.k AND (status = 'A' OR status = 'B')"
  )[0] as UpdateStatement;
  expect(ast.from).toMatchObject({ appId: 0, cteName: "#e", alias: "e", targetJoinField: "$id", joinKeyField: "k" });
  expect(ast.assignments[0]).toEqual({ field: "c", value: { type: "SOURCE_FIELD", alias: "e", field: "f" } });
  expect(ast.from?.targetFilter).toMatchObject({ type: "LOGICAL", op: "OR" });
});

test("UPDATE FROM APP: 左右反転した結合条件を分解する", () => {
  const ast = parse(
    "UPDATE APP100 SET c = s.f FROM APP200 s WHERE s.k = APP100.$id"
  ) as UpdateStatement;
  expect(ast.from).toEqual({ appId: 200, cteName: null, alias: "s", targetJoinField: "$id", joinKeyField: "k", targetFilter: null });
});

test("UPDATE FROM APP: 業務キー結合と左右反転を分解する", () => {
  const direct = parse(
    "UPDATE APP100 SET c = s.f FROM APP200 s WHERE APP100.顧客コード = s.code AND status = 'A'"
  ) as UpdateStatement;
  expect(direct.from).toMatchObject({ targetJoinField: "顧客コード", joinKeyField: "code" });
  expect(direct.from?.targetFilter).toMatchObject({ type: "BINARY", op: "=", left: { field: "status" } });

  const reversed = parse(
    "UPDATE APP100 SET c = s.f FROM APP200 s WHERE s.code = 顧客コード"
  ) as UpdateStatement;
  expect(reversed.from).toMatchObject({ targetJoinField: "顧客コード", joinKeyField: "code" });
});

test.each([
  "UPDATE APP100 SET c = s.f FROM APP200 s WHERE APP100.$id = s.k OR status = 'A'",
  "UPDATE APP100 SET c = s.f FROM APP200 s WHERE NOT (APP100.$id = s.k)",
  "UPDATE APP100 SET c = s.f FROM APP200 s WHERE APP100.$id = s.k AND status = s.status",
  "UPDATE APP100 SET c = s.f FROM APP200 s WHERE APP100.$id = s.k AND APP100.$id = s.k2",
  "UPDATE APP100 SET c = x.f FROM APP200 s WHERE APP100.$id = s.k",
  "UPDATE APP100 SET c = APP999.f * 2 FROM APP200 s WHERE APP100.$id = s.k",
  "UPDATE APP100 SET c = (SELECT MAX(f) FROM APP300) FROM APP200 s WHERE APP100.$id = s.k",
  "UPDATE APP100 SET c = s.f FROM APP200 s WHERE APP100.$id = s.k AND APP999.status = 'A'",
  "UPDATE APP100$rows SET c = s.f FROM APP200 s WHERE APP100.$id = s.k",
  "UPDATE APP100 SET c = APP100.f FROM APP200 APP100 WHERE APP100.code = APP100.k",
])("UPDATE FROM の非対応形を拒否する: %s", (sql) => {
  expect(() => parse(sql)).toThrow(ParseError);
});

test("FROM なし UPDATE の修飾フィールド単独 SET は従来どおり拒否する", () => {
  expect(() => parse("UPDATE APP100 SET c = s.f WHERE $id = 1")).toThrow(ParseError);
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

test("B19 の追加関数と別名を解析する", () => {
  const ast = parseSelect(
    "SELECT TRUNCATE(n, 1), TRUNC(n), LEFT(s, 2), RIGHT(s, 2), " +
    "INSTR(s, '-'), GREATEST(a, b), LEAST(a, b), LPAD(s, 3, '0'), " +
    "RPAD(s, 3), LAST_DAY(d) FROM APP100"
  );
  const funcs = ast.columns.map((column) =>
    column.type === "STRFUNC_COL" ? column.expr.func : null
  );
  expect(funcs).toEqual([
    "TRUNCATE", "TRUNCATE", "LEFT", "RIGHT", "INSTR",
    "GREATEST", "LEAST", "LPAD", "RPAD", "LAST_DAY",
  ]);
});

test("LEFT / RIGHT 関数と LEFT / RIGHT JOIN が同一クエリで共存する", () => {
  const left = parseSelect(
    "SELECT LEFT(a.name, 2) AS short FROM APP1 AS a LEFT JOIN APP2 AS b ON a.id = b.id"
  );
  expect(left.columns[0]).toMatchObject({ type: "STRFUNC_COL", expr: { func: "LEFT" } });
  expect(left.joins[0].type).toBe("LEFT");

  const right = parseSelect(
    "SELECT RIGHT(b.name, 2) AS short FROM APP1 AS a RIGHT JOIN APP2 AS b ON a.id = b.id"
  );
  expect(right.columns[0]).toMatchObject({ type: "STRFUNC_COL", expr: { func: "RIGHT" } });
  expect(right.joins[0].type).toBe("RIGHT");
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

test("B21 UPDATE SET は文字列関数を直接 AssignmentValue として受理する", () => {
  const ast = parse(
    "UPDATE APP100 SET a = UPPER(b), code = LPAD(code, 5, '0'), mapped = TRANSLATE(b, 'ab', 'AB') WHERE $id = 1"
  ) as UpdateStatement;
  expect(ast.assignments.map((assignment) => assignment.value.type)).toEqual([
    "STRING_FUNC", "STRING_FUNC", "STRING_FUNC",
  ]);
});

test("B21 FIELD_REF 単独は実態に合う ParseError のまま拒否する", () => {
  expect(() => parse("UPDATE APP100 SET a = b WHERE $id = 1")).toThrow(
    "SET の値にフィールド参照を単独で指定することはできません"
  );
});

test("B21 UPDATE FROM とサブテーブル UPDATE へ文字列関数の受理を波及させない", () => {
  expect(() => parse(
    "UPDATE APP100 SET a = UPPER(s.b) FROM APP200 s WHERE APP100.$id = s.id"
  )).toThrow("UPDATE ... FROM の SET では文字列関数を直接使用できません");
  expect(() => parse(
    "UPDATE APP100$明細 SET a = UPPER(b) WHERE _rid = '1'"
  )).toThrow("サブテーブル UPDATE SET では文字列関数を直接使用できません");
  expect(() => parse(
    "UPDATE APP100 SET a = UPPER(APP100.b) WHERE $id = 1"
  )).toThrow("UPDATE SET の文字列関数では更新先フィールドを修飾しないでください");
});

test("B21 AssignmentValue の拡張は INSERT VALUES / UPSERT VALUES に波及しない", () => {
  expect(() => parse("INSERT INTO APP100 (a) VALUES (UPPER('x'))")).toThrow(ParseError);
  expect(() => parse("UPSERT INTO APP100 (a) VALUES (UPPER('x')) ON DUPLICATE (a)")).toThrow(ParseError);
  expect(() => parse("ASSERT UPPER('x') = 'X'")).toThrow(
    "ASSERT の式では関数は使用できません"
  );
});

test("B23/B24 LENGTH_CHAR と TRANSLATE を予約語関数として解析する", () => {
  const ast = parseSelect(
    "SELECT LENGTH_CHAR(名前), TRANSLATE(名前, CONCAT('a', 'b'), 'AB') FROM APP100"
  );
  expect(ast.columns).toMatchObject([
    { type: "STRFUNC_COL", expr: { func: "LENGTH_CHAR" } },
    { type: "STRFUNC_COL", expr: { func: "TRANSLATE", args: [
      { type: "FIELD_REF", field: "名前" },
      { type: "STRING_FUNC", func: "CONCAT" },
      { type: "STRING", value: "AB" },
    ] } },
  ]);
});

test.each(["LENGTH_CHAR", "TRANSLATE"])("%s は予約語で、同名フィールドはバッククォートで参照できる", (name) => {
  expect(() => parseSelect(`SELECT ${name} FROM APP100`)).toThrow(ParseError);
  expect(parseSelect(`SELECT \`${name}\` FROM APP100`).columns[0]).toEqual({
    type: "FIELD", field: name, alias: null,
  });
});

test("B20 正規表現3関数を式引数付きで解析する", () => {
  const ast = parseSelect(
    "SELECT REGEXP_LIKE(value, pattern, flags), " +
    "REGEXP_REPLACE(value, CONCAT('[', pattern, ']'), replacement, flags), " +
    "REGEXP_SUBSTR(value, pattern) FROM APP100"
  );
  expect(ast.columns).toMatchObject([
    { type: "STRFUNC_COL", expr: { func: "REGEXP_LIKE" } },
    { type: "STRFUNC_COL", expr: { func: "REGEXP_REPLACE", args: [
      { type: "FIELD_REF", field: "value" },
      { type: "STRING_FUNC", func: "CONCAT" },
      { type: "FIELD_REF", field: "replacement" },
      { type: "FIELD_REF", field: "flags" },
    ] } },
    { type: "STRFUNC_COL", expr: { func: "REGEXP_SUBSTR" } },
  ]);
});

test.each(["REGEXP_LIKE", "REGEXP_REPLACE", "REGEXP_SUBSTR"])(
  "%s は予約語で、同名フィールドはバッククォートで参照できる",
  (name) => {
    expect(() => parseSelect(`SELECT ${name} FROM APP100`)).toThrow(ParseError);
    expect(parseSelect(`SELECT \`${name}\` FROM APP100`).columns[0]).toEqual({
      type: "FIELD", field: name, alias: null,
    });
  }
);

test("B24 バッチレシピ R8 の40字変換 SQL を構文検証できる", () => {
  expect(() => parseSelect(
    "SELECT TRANSLATE(会社名, " +
      "'啞焰鷗摑麴噓俠頰軀俱繫姸鹼嚙攢𠮟繡蔣醬蟬搔瘦驒簞塡顚禱瀆吞囊剝潑醱屛幷麵萊屢沪蠟', " +
      "'唖焔鴎掴麹嘘侠頬躯倶繋妍鹸噛攅叱繍蒋醤蝉掻痩騨箪填顛祷涜呑嚢剥溌醗屏并麺莱屡濾蝋'" +
    ") AS 会社名, 住所 FROM APP100"
  )).not.toThrow();
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
