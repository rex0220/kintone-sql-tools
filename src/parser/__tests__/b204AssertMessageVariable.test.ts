import { parseSqlStatementsForScript } from "../../core/sql";
import type { AssertStatement, ExitStatement } from "../../types/ast";

const header = "-- @ksql dialect: 1\n";
const parse = (sql: string) => parseSqlStatementsForScript(`${header}${sql}`).statements;
const last = <T>(sql: string) => {
  const statements = parse(sql);
  return statements[statements.length - 1] as T;
};

test("B204: ASSERT のメッセージに変数を書ける（AST は messageVar・message は無い）", () => {
  const statement = last<AssertStatement>(
    "DECLARE @m_no_stock = '';\nASSERT (SELECT COUNT(*) FROM APP1) = 0, @m_NO_STOCK;"
  );
  expect(statement.type).toBe("ASSERT");
  // 変数名は小文字・@ なしに正規化する（DECLARE / SET と同じ規則）
  expect(statement.messageVar).toEqual({ type: "VARIABLE", name: "m_no_stock" });
  expect(statement.message).toBeUndefined();
});

test("B204: ASSERT WARN と BETWEEN でも同じ", () => {
  const warn = last<AssertStatement>(
    "DECLARE @m_x = '';\nASSERT WARN (SELECT COUNT(*) FROM APP1) = 0, @m_x;"
  );
  expect(warn).toMatchObject({ warn: true, messageVar: { type: "VARIABLE", name: "m_x" } });

  const between = last<AssertStatement>(
    "DECLARE @m_x = '';\nASSERT (SELECT COUNT(*) FROM APP1) BETWEEN 1 AND 500, @m_x;"
  );
  expect(between).toMatchObject({ op: "BETWEEN", messageVar: { type: "VARIABLE", name: "m_x" } });
});

test("B204: EXIT SUCCESS IF のメッセージに変数を書ける（message は \"\"）", () => {
  const statement = last<ExitStatement>(
    "DECLARE @m_done = '';\nEXIT SUCCESS IF (SELECT COUNT(*) FROM APP1) = 0, @m_done;"
  );
  expect(statement.type).toBe("EXIT");
  expect(statement.messageVar).toEqual({ type: "VARIABLE", name: "m_done" });
  // 既存の読み手（message しか見ない）には「固定の文は無い」と見える＝既定の文に落ちる
  expect(statement.message).toBe("");
});

test("B204: リテラルの形は従来どおり（messageVar は付かない）", () => {
  const assertStatement = last<AssertStatement>("ASSERT (SELECT COUNT(*) FROM APP1) = 0, '在庫が足りません';");
  expect(assertStatement.message).toBe("在庫が足りません");
  expect(assertStatement.messageVar).toBeUndefined();

  const exitStatement = last<ExitStatement>("EXIT SUCCESS IF (SELECT COUNT(*) FROM APP1) = 0, '対象なし';");
  expect(exitStatement.message).toBe("対象なし");
  expect(exitStatement.messageVar).toBeUndefined();
});

test("B204: メッセージを省いた ASSERT も従来どおり", () => {
  const statement = last<AssertStatement>("ASSERT (SELECT COUNT(*) FROM APP1) = 0;");
  expect(statement.message).toBeUndefined();
  expect(statement.messageVar).toBeUndefined();
});

test.each([
  ["関数", "ASSERT 1 = 1, CONCAT('a','b');"],
  ["数値リテラル", "ASSERT 1 = 1, 123;"],
])("B204: メッセージはリテラルか変数だけ: %s", (_label, sql) => {
  expect(() => parse(sql)).toThrow("ASSERT のメッセージには文字列リテラルまたは変数（@名前）が必要です");
});

test.each([
  ["変数の連結", "DECLARE @m_x = '';\nASSERT 1 = 1, @m_x || '!';"],
  ["リテラルの連結", "ASSERT 1 = 1, 'a' || 'b';"],
  ["変数の算術", "DECLARE @m_x = '';\nASSERT 1 = 1, @m_x + 1;"],
])("B204: メッセージに式は書けない: %s", (_label, sql) => {
  expect(() => parse(sql))
    .toThrow("ASSERT のメッセージに式は書けません（文字列リテラルか変数 @名前 を 1 つだけ）");
});

test("B204: EXIT のメッセージが式のときの診断", () => {
  expect(() => parse("EXIT SUCCESS IF 1 = 1, 123;"))
    .toThrow("EXIT SUCCESS IF のメッセージには文字列リテラルまたは変数（@名前）が必要です");
});

test("B204: EXIT はメッセージ自体を省けない（従来どおり）", () => {
  expect(() => parse("EXIT SUCCESS IF 1 = 1;"))
    .toThrow("EXIT SUCCESS IF には末尾のメッセージ文字列が必要です");
});

test("B204: メッセージの変数も dialect 1 が要る", () => {
  expect(() => parseSqlStatementsForScript("DECLARE @m_x = '';\nASSERT 1 = 1, @m_x;"))
    .toThrow("この構文には -- @ksql dialect: 1 の宣言が必要です");
});
