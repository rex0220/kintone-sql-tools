import { Lexer } from "../../lexer/lexer";
import { Parser } from "../parser";

test("parseStatementsWithRanges returns source offsets without changing parseStatements", () => {
  const source = "; SELECT ';' AS a;\r\n-- between\r\nSELECT 2 AS b";
  const parsed = new Parser(new Lexer(source).tokenize()).parseStatementsWithRanges();
  expect(parsed.statements.map((statement) => statement.type)).toEqual(["SELECT", "SELECT"]);
  expect(parsed.statementRanges.map((range) => source.slice(range.start, range.end))).toEqual([
    "SELECT ';' AS a",
    "SELECT 2 AS b",
  ]);
});

test("dialect1 is an additive parser capability", () => {
  const sql = "SELECT 1";
  expect(new Parser(new Lexer(sql).tokenize(), { dialect1: true }).parseStatements()).toHaveLength(1);
  expect(new Parser(new Lexer(sql).tokenize()).parseStatements()).toHaveLength(1);
});
