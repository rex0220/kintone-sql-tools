import { Lexer } from "../../lexer/lexer";
import { KEYWORDS, TokenKind } from "../../lexer/tokens";
import type { SelectStatement } from "../../types/ast";
import { Parser, ParseError } from "../parser";

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

describe("B158 CROSS JOIN parser", () => {
  test.each(["CROSS JOIN", "cross join", "CrOsS JoIn"])("%s を受理する", (syntax) => {
    expect(parse(`SELECT a.x,b.y FROM APP1 a ${syntax} APP2 b`).joins[0]).toEqual({
      type: "CROSS",
      table: { appId: 2, alias: "b", cteName: null },
      on: null,
    });
  });

  test.each([
    ["LEFT CROSS JOIN", "CROSS JOIN に LEFT / RIGHT は指定できません。"],
    ["RIGHT CROSS JOIN", "CROSS JOIN に LEFT / RIGHT は指定できません。"],
    ["INNER CROSS JOIN", "CROSS JOIN に INNER は指定できません。"],
  ])("%s を専用 ParseError にする", (syntax, message) => {
    expect(() => parse(`SELECT * FROM APP1 a ${syntax} APP2 b`)).toThrow(message);
  });

  test("CROSS JOIN の ON を専用 ParseError にする", () => {
    expect(() => parse("SELECT * FROM APP1 a CROSS JOIN APP2 b ON a.x=b.x"))
      .toThrow("CROSS JOIN に ON 句は指定できません。");
  });

  test.each([
    "SELECT * FROM APP1 a INNER JOIN APP2 b ON 1=1",
    "SELECT * FROM APP1 a, APP2 b",
    "SELECT * FROM GENERATE_SERIES(1,5) AS n",
  ])("非対応構文を開放しない: %s", (sql) => {
    expect(() => parse(sql)).toThrow(ParseError);
  });

  test("CROSS は hard keyword、バッククォート付きは識別子", () => {
    expect(KEYWORDS.get("CROSS")).toBe(TokenKind.CROSS);
    expect(parse("SELECT `CROSS` FROM APP1").columns[0]).toEqual({
      type: "FIELD", field: "CROSS", alias: null,
    });
  });

  test("通常 JOIN AST は不変", () => {
    for (const [syntax, type] of [
      ["JOIN", "INNER"], ["INNER JOIN", "INNER"], ["LEFT JOIN", "LEFT"], ["RIGHT JOIN", "RIGHT"],
    ] as const) {
      expect(parse(`SELECT * FROM APP1 a ${syntax} APP2 b ON a.x=b.x`).joins[0]).toMatchObject({
        type,
        on: { left: { tableAlias: "a", field: "x" }, right: { tableAlias: "b", field: "x" } },
      });
    }
  });
});
