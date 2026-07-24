import { parseSqlStatement } from "../../core/sql";
import { Lexer } from "../../lexer/lexer";
import { KEYWORDS, TokenKind } from "../../lexer/tokens";
import type {
  BinaryExpr,
  LegacyKintoneFunction,
  LogicalExpr,
  RelativeDateFunction,
  SelectStatement,
} from "../../types/ast";
import {
  PARSER_IDENT_RELATIVE_DATE_FUNCTIONS,
  ParseError,
} from "../parser";

function parseRight(sqlValue: string): RelativeDateFunction | LegacyKintoneFunction {
  const stmt = parseSqlStatement(`SELECT * FROM APP100 WHERE 日付 = ${sqlValue}`) as SelectStatement;
  return (stmt.where as BinaryExpr).right as RelativeDateFunction | LegacyKintoneFunction;
}

const VALID_CALLS: Array<[string, RelativeDateFunction]> = [
  ["YESTERDAY()", { type: "KINTONE_FUNC", name: "YESTERDAY", args: { kind: "NONE" } }],
  ["TOMORROW()", { type: "KINTONE_FUNC", name: "TOMORROW", args: { kind: "NONE" } }],
  ["FROM_TODAY(-5, WEEKS)", {
    type: "KINTONE_FUNC",
    name: "FROM_TODAY",
    args: { kind: "FROM_TODAY", offset: -5, offsetText: "-5", unit: "WEEKS" },
  }],
  ["THIS_WEEK()", { type: "KINTONE_FUNC", name: "THIS_WEEK", args: { kind: "WEEK", weekday: null } }],
  ["LAST_WEEK(MONDAY)", { type: "KINTONE_FUNC", name: "LAST_WEEK", args: { kind: "WEEK", weekday: "MONDAY" } }],
  ["NEXT_WEEK(SATURDAY)", { type: "KINTONE_FUNC", name: "NEXT_WEEK", args: { kind: "WEEK", weekday: "SATURDAY" } }],
  ["THIS_MONTH()", { type: "KINTONE_FUNC", name: "THIS_MONTH", args: { kind: "MONTH", day: null } }],
  ["LAST_MONTH(LAST)", { type: "KINTONE_FUNC", name: "LAST_MONTH", args: { kind: "MONTH", day: "LAST" } }],
  ["NEXT_MONTH(31)", { type: "KINTONE_FUNC", name: "NEXT_MONTH", args: { kind: "MONTH", day: 31 } }],
  ["THIS_YEAR()", { type: "KINTONE_FUNC", name: "THIS_YEAR", args: { kind: "NONE" } }],
  ["LAST_YEAR()", { type: "KINTONE_FUNC", name: "LAST_YEAR", args: { kind: "NONE" } }],
  ["NEXT_YEAR()", { type: "KINTONE_FUNC", name: "NEXT_YEAR", args: { kind: "NONE" } }],
];

test.each(VALID_CALLS)("全12関数を大文字で parse する: %s", (call, expected) => {
  expect(parseRight(call)).toEqual(expected);
});

test.each(VALID_CALLS)("全12関数を小文字で parse し大文字 AST へ正規化する: %s", (call, expected) => {
  expect(parseRight(call.toLowerCase())).toEqual(expected);
});

test("FROM_TODAY の safe integer 上下限を受理する", () => {
  expect(parseRight("FROM_TODAY(9007199254740991, DAYS)")).toMatchObject({
    args: { offset: Number.MAX_SAFE_INTEGER, offsetText: "9007199254740991" },
  });
  expect(parseRight("FROM_TODAY(-9007199254740991, YEARS)")).toMatchObject({
    args: { offset: Number.MIN_SAFE_INTEGER, offsetText: "-9007199254740991" },
  });
});

test.each([
  ["FROM_TODAY(-0, DAYS)", "0"],
  ["FROM_TODAY(0000, DAYS)", "0"],
  ["FROM_TODAY(-0000, DAYS)", "0"],
  ["FROM_TODAY(00012, DAYS)", "12"],
  ["FROM_TODAY(-00012, DAYS)", "-12"],
])("offsetText は検証後の最短10進表記へ正規化する: %s", (call, offsetText) => {
  expect(parseRight(call)).toMatchObject({ args: { offsetText } });
});

test("BETWEEN の low/high だけで相対日付関数を生成し、現行の2比較 AND 展開を保つ", () => {
  const stmt = parseSqlStatement(
    "SELECT * FROM APP100 WHERE 日付 BETWEEN FROM_TODAY(-7, DAYS) AND TODAY()"
  ) as SelectStatement;
  const where = stmt.where as LogicalExpr;
  expect(where.type).toBe("LOGICAL");
  expect(where.op).toBe("AND");
  expect((where.left as BinaryExpr).op).toBe(">=");
  expect((where.left as BinaryExpr).right).toEqual({
    type: "KINTONE_FUNC",
    name: "FROM_TODAY",
    args: { kind: "FROM_TODAY", offset: -7, offsetText: "-7", unit: "DAYS" },
  });
  expect((where.right as BinaryExpr).op).toBe("<=");
  expect((where.right as BinaryExpr).right).toEqual({ type: "KINTONE_FUNC", name: "TODAY" });
});

test("既存3関数の parse AST JSON は legacy 2-property shape と byte 一致する", () => {
  const expected = [
    '{"type":"KINTONE_FUNC","name":"TODAY"}',
    '{"type":"KINTONE_FUNC","name":"NOW"}',
    '{"type":"KINTONE_FUNC","name":"LOGINUSER"}',
  ];
  expect(["TODAY()", "NOW()", "LOGINUSER()"].map((call) => JSON.stringify(parseRight(call))))
    .toEqual(expected);
});

const ARGUMENT_ERRORS = [
  "YESTERDAY(1)", "TOMORROW(DAYS)", "THIS_YEAR(2026)", "LAST_YEAR(1)", "NEXT_YEAR(LAST)",
  "FROM_TODAY()", "FROM_TODAY(1)", "FROM_TODAY(1,)", "FROM_TODAY(1, DAYS, WEEKS)",
  "FROM_TODAY(+5, DAYS)", "FROM_TODAY(1.5, DAYS)", "FROM_TODAY(1e2, DAYS)",
  "FROM_TODAY(1_000, DAYS)", "FROM_TODAY(1 + 2, DAYS)", "FROM_TODAY(@n, DAYS)",
  "FROM_TODAY(offset, DAYS)", "FROM_TODAY(9007199254740992, DAYS)",
  "FROM_TODAY(-9007199254740992, DAYS)", "FROM_TODAY(1, HOURS)",
  "FROM_TODAY(1, 'DAYS')", "FROM_TODAY(1, `DAYS`)",
  "THIS_WEEK(FUNDAY)", "THIS_WEEK('MONDAY')", "THIS_WEEK(`MONDAY`)",
  "THIS_WEEK(MONDAY, TUESDAY)", "THIS_WEEK(MONDAY,)",
  "THIS_MONTH(0)", "THIS_MONTH(32)", "THIS_MONTH(-1)", "THIS_MONTH('LAST')",
  "THIS_MONTH(`LAST`)", "THIS_MONTH(1, 2)", "THIS_MONTH(1.5)",
];

test.each(ARGUMENT_ERRORS)("不正な引数を ParseError にする: %s", (call) => {
  expect(() => parseRight(call)).toThrow(ParseError);
});

test.each([
  "SELECT * FROM APP100 WHERE 日付 IN (FROM_TODAY(1, DAYS))",
  "SELECT * FROM APP100 WHERE 日付 NOT IN (YESTERDAY())",
  "SELECT * FROM APP100 WHERE 日付 NOT BETWEEN YESTERDAY() AND TOMORROW()",
])("IN/NOT IN/NOT BETWEEN へ一般化しない: %s", (sql) => {
  expect(() => parseSqlStatement(sql)).toThrow(ParseError);
});

test.each([
  "SELECT YESTERDAY() FROM APP100",
  "UPDATE APP100 SET 日付 = YESTERDAY() WHERE $id = 1",
  "INSERT INTO APP100 (日付) VALUES (YESTERDAY())",
  "UPDATE APP100 SET 日付 = 'x' WHERE $id = 1 CHECK WHEN 日付 = YESTERDAY() THEN 'bad'",
  "SELECT CASE WHEN $id = 1 THEN YESTERDAY() ELSE 'x' END AS x FROM APP100",
  "SELECT 日付, COUNT(*) AS c FROM APP100 GROUP BY 日付 HAVING 日付 = YESTERDAY()",
  "SELECT a.$id FROM APP100 a JOIN APP200 b ON a.日付 = YESTERDAY()",
  "SELECT COUNT(*) FROM APP100 GROUP BY YESTERDAY()",
  "SELECT * FROM APP100 ORDER BY YESTERDAY()",
  "SELECT * FROM APP100 WHERE YESTERDAY() = 日付",
  "SELECT * FROM APP100 WHERE 日付 = YESTERDAY() + 1",
])("WHERE 比較右辺以外では parse 可能にしない: %s", (sql) => {
  expect(() => parseSqlStatement(sql)).toThrow();
});

const SOFT_WORDS = [
  ...PARSER_IDENT_RELATIVE_DATE_FUNCTIONS,
  "DAYS", "WEEKS", "MONTHS", "YEARS",
  "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY",
  "LAST",
];

test.each(SOFT_WORDS)("%s は TokenKind/KEYWORDS の hard keyword ではない", (word) => {
  expect(KEYWORDS.has(word)).toBe(false);
  expect(new Lexer(word).tokenize()[0].kind).toBe(TokenKind.IDENT);
});

test("関数名・引数語と同名の通常 field/alias と backtick 退避を維持する", () => {
  expect(() => parseSqlStatement(
    "SELECT `DAYS`, `MONDAY`, `LAST`, `FROM_TODAY`, DAYS AS FROM_TODAY "
    + "FROM APP100 WHERE `DAYS` = 'x' AND MONDAY = 'm' AND FROM_TODAY = 'f'"
  )).not.toThrow();
});

