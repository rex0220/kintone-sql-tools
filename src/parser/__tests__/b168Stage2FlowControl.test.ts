import { Lexer } from "../../lexer/lexer";
import { ParseError, Parser } from "../parser";
import type { AssertStatement, ExitStatement } from "../../types/ast";

const parse = (sql: string, dialect1 = false) =>
  new Parser(new Lexer(sql).tokenize(), { dialect1 }).parse();

test("dialect 1 accepts ASSERT message and ASSERT WARN as additive forms", () => {
  const message = parse("ASSERT 1 = 1, 'ok'", true) as AssertStatement;
  expect(message).toMatchObject({ type: "ASSERT", text: "1 = 1", message: "ok" });
  expect(message.warn).toBeUndefined();

  const warn = parse("ASSERT WARN 5 BETWEEN 1 AND 3, 'range warning'", true) as AssertStatement;
  expect(warn).toMatchObject({
    type: "ASSERT", op: "BETWEEN", warn: true, message: "range warning",
  });
});

test("dialect 1 accepts EXIT SUCCESS IF with ASSERT-compatible condition", () => {
  const exit = parse(
    "EXIT SUCCESS IF (SELECT COUNT(*) FROM APP1) = 0, 'no data'",
    true
  ) as ExitStatement;
  expect(exit).toMatchObject({ type: "EXIT", op: "=", text: "(SELECT COUNT(*) FROM APP1) = 0", message: "no data" });
});

test.each([
  "ASSERT 1 = 1, 'message'",
  "ASSERT WARN 1 = 1, 'message'",
  "EXIT SUCCESS IF 1 = 1, 'message'",
])("dialect 0 rejects Flow form with the required declaration guidance: %s", (sql) => {
  expect(() => parse(sql)).toThrow(ParseError);
  expect(() => parse(sql)).toThrow(/-- @ksql dialect: 1/);
});

test("legacy ASSERT remains accepted in dialect 0 and dialect 1", () => {
  expect(parse("ASSERT 1 = 1").type).toBe("ASSERT");
  expect(parse("ASSERT 1 = 1", true).type).toBe("ASSERT");
});
