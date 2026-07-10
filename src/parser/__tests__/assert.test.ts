// ============================================================
// ASSERT 文のパーステスト（バッチ強化 第1弾 A1）
// ============================================================

import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError } from "../parser";
import type { AssertStatement, ArithExpr, ScalarSubquery } from "../../types/ast";

function parse(sql: string) {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parse();
}
function parseAssert(sql: string): AssertStatement {
  return parse(sql) as AssertStatement;
}
function parseBatch(sql: string) {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parseStatements();
}

// ----------------------------------------------------------------
// 比較演算子
// ----------------------------------------------------------------

test.each([
  ["=", "ASSERT 1 = 1"],
  ["!=", "ASSERT 1 != 2"],
  ["<>", "ASSERT 1 <> 2"],
  ["<", "ASSERT 1 < 2"],
  ["<=", "ASSERT 1 <= 1"],
  [">", "ASSERT 2 > 1"],
  [">=", "ASSERT 1 >= 1"],
])("比較演算子 %s", (op, sql) => {
  const ast = parseAssert(sql);
  expect(ast.type).toBe("ASSERT");
  expect(ast.op).toBe(op);
  expect(ast.right).not.toBeNull();
  expect(ast.low).toBeNull();
  expect(ast.high).toBeNull();
});

test("数値リテラルの比較", () => {
  const ast = parseAssert("ASSERT 1 = 1");
  expect(ast.left).toEqual({ type: "NUMBER", value: 1 });
  expect(ast.right).toEqual({ type: "NUMBER", value: 1 });
});

test("文字列リテラルの比較", () => {
  const ast = parseAssert("ASSERT 'a' <> 'b'");
  expect(ast.left).toEqual({ type: "STRING", value: "a" });
  expect(ast.right).toEqual({ type: "STRING", value: "b" });
});

test("単項マイナス", () => {
  const ast = parseAssert("ASSERT -5 < 0");
  expect(ast.left).toEqual({ type: "NUMBER", value: -5 });
});

// ----------------------------------------------------------------
// BETWEEN
// ----------------------------------------------------------------

test("BETWEEN low AND high", () => {
  const ast = parseAssert("ASSERT 5 BETWEEN 1 AND 10");
  expect(ast.op).toBe("BETWEEN");
  expect(ast.right).toBeNull();
  expect(ast.low).toEqual({ type: "NUMBER", value: 1 });
  expect(ast.high).toEqual({ type: "NUMBER", value: 10 });
});

test("BETWEEN の AND 欠落はエラー", () => {
  expect(() => parse("ASSERT 5 BETWEEN 1 10")).toThrow(ParseError);
});

// ----------------------------------------------------------------
// 算術式
// ----------------------------------------------------------------

test("算術式（優先順位: * が先）", () => {
  const ast = parseAssert("ASSERT 2 + 3 * 4 = 14");
  const left = ast.left as ArithExpr;
  expect(left.type).toBe("ARITH");
  expect(left.op).toBe("+");
  expect(left.left).toEqual({ type: "NUMBER", value: 2 });
  expect(left.right).toEqual({
    type: "ARITH",
    left: { type: "NUMBER", value: 3 },
    op: "*",
    right: { type: "NUMBER", value: 4 },
  });
});

test("括弧付き算術式", () => {
  const ast = parseAssert("ASSERT (2 + 3) * 4 = 20");
  const left = ast.left as ArithExpr;
  expect(left.op).toBe("*");
});

// ----------------------------------------------------------------
// スカラーサブクエリ
// ----------------------------------------------------------------

test("スカラーサブクエリ（APP 参照）", () => {
  const ast = parseAssert("ASSERT (SELECT COUNT(*) FROM APP100) = 0");
  const left = ast.left as ScalarSubquery;
  expect(left.type).toBe("SCALAR_SUBQUERY");
  expect(left.query.from.appId).toBe(100);
});

test("スカラーサブクエリ + BETWEEN（一時テーブル参照はバッチ内で可）", () => {
  const stmts = parseBatch(
    "CREATE TEMP TABLE #targets AS SELECT $id FROM APP100 WHERE 売上 > 1000000;" +
    "ASSERT (SELECT COUNT(*) FROM #targets) BETWEEN 1 AND 500;"
  );
  expect(stmts).toHaveLength(2);
  const assert = stmts[1] as AssertStatement;
  expect(assert.type).toBe("ASSERT");
  expect(assert.op).toBe("BETWEEN");
  const left = assert.left as ScalarSubquery;
  expect(left.type).toBe("SCALAR_SUBQUERY");
  expect(left.query.from.cteName).toBe("#targets");
});

test("右辺のスカラーサブクエリ", () => {
  const ast = parseAssert("ASSERT 0 = (SELECT COUNT(*) FROM APP100)");
  expect((ast.right as ScalarSubquery).type).toBe("SCALAR_SUBQUERY");
});

test("単文 API では一時テーブル参照の ASSERT は拒否（既存規約）", () => {
  expect(() => parse("ASSERT (SELECT COUNT(*) FROM #t) = 0"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("サブクエリ直後の算術演算子はエラー", () => {
  expect(() => parse("ASSERT (SELECT COUNT(*) FROM APP100) * 2 = 10"))
    .toThrow(/算術演算子は使用できません/);
});

// ----------------------------------------------------------------
// 複数列サブクエリの静的拒否 / SELECT * は実行時判定
// ----------------------------------------------------------------

test("複数列サブクエリは静的に拒否", () => {
  expect(() => parse("ASSERT (SELECT 金額, 数量 FROM APP100) = 1"))
    .toThrow(/scalar subquery in ASSERT must return exactly 1 column/);
});

test("SELECT * サブクエリは静的拒否しない（実行時検証に委ねる）", () => {
  const ast = parseAssert("ASSERT (SELECT * FROM APP100) = 1");
  expect((ast.left as ScalarSubquery).type).toBe("SCALAR_SUBQUERY");
});

// ----------------------------------------------------------------
// 拒否ケース
// ----------------------------------------------------------------

test("裸の値のみはエラー（ASSERT 1）", () => {
  expect(() => parse("ASSERT 1")).toThrow(/比較演算子/);
});

test("AND 複合条件はエラー", () => {
  expect(() => parse("ASSERT 1 = 1 AND 2 = 2"))
    .toThrow(/複合条件に対応していません/);
});

test("OR 複合条件はエラー", () => {
  expect(() => parse("ASSERT 1 = 1 OR 2 = 2"))
    .toThrow(/複合条件に対応していません/);
});

test("BETWEEN 後の AND 連結もエラー", () => {
  expect(() => parse("ASSERT 5 BETWEEN 1 AND 10 AND 1 = 1"))
    .toThrow(/複合条件に対応していません/);
});

test("フィールド参照（裸の識別子）はエラー", () => {
  expect(() => parse("ASSERT 金額 > 1"))
    .toThrow(/リテラル・算術式・スカラーサブクエリ/);
});

test("括弧内のフィールド参照もエラー", () => {
  expect(() => parse("ASSERT (金額) > 1"))
    .toThrow(/フィールド参照は使用できません/);
});

test("算術式内のフィールド参照もエラー", () => {
  expect(() => parse("ASSERT (金額 * 1.1) > 1"))
    .toThrow(/フィールド参照は使用できません/);
});

test("関数呼び出しはエラー", () => {
  expect(() => parse("ASSERT ROUND(1.5) = 2"))
    .toThrow(/関数は使用できません/);
});

// ----------------------------------------------------------------
// text（エラーメッセージ用の条件テキスト再構成）
// ----------------------------------------------------------------

test("text: BETWEEN + サブクエリ", () => {
  const stmts = parseBatch(
    "CREATE TEMP TABLE #targets AS SELECT $id FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM #targets) BETWEEN 1 AND 500;"
  );
  const assert = stmts[1] as AssertStatement;
  expect(assert.text).toBe("(SELECT COUNT(*) FROM #targets) BETWEEN 1 AND 500");
});

test("text: 比較演算子と文字列リテラル", () => {
  const ast = parseAssert("assert 'a' <> 'b'");
  expect(ast.text).toBe("'a' <> 'b'");
});

test("text: 算術式", () => {
  const ast = parseAssert("ASSERT 2 + 3 * 4 = 14");
  expect(ast.text).toBe("2 + 3 * 4 = 14");
});

// ----------------------------------------------------------------
// バッチ内での位置づけ
// ----------------------------------------------------------------

test("DML バッチ内の ASSERT（DML 直前のゲート配置）", () => {
  const stmts = parseBatch(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100 WHERE 売上 > 100;" +
    "ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500;" +
    "UPDATE APP100 SET 状態 = '対象' WHERE $id IN (SELECT $id FROM #t);"
  );
  expect(stmts.map((s) => s.type)).toEqual(["CREATE_TEMP_TABLE", "ASSERT", "UPDATE"]);
});
