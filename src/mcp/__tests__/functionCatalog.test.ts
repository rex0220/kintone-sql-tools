import { parseSqlStatement } from "../../core/sql";
import { TokenKind } from "../../lexer/tokens";
import {
  PARSER_FUNCTION_SPELLINGS,
  PARSER_AGGREGATE_FUNCTIONS,
  PARSER_SCALAR_FUNCTION_TOKEN_MAP,
} from "../../parser/parser";
import { KSQL_FUNCTION_CATALOG } from "../docsResources";
import { KSQL_FUNCTION_SQL_FIXTURES } from "./fixtures/ksqlFunctionCatalogFixtures";

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe("B55 complete function catalog", () => {
  const aliases = KSQL_FUNCTION_CATALOG.aliases.map((entry) => entry.split("→") as [string, string]);
  const catalogSpellings = new Set([
    ...KSQL_FUNCTION_CATALOG.scalar,
    ...aliases.map(([alias]) => alias),
    ...KSQL_FUNCTION_CATALOG.aggregate,
    ...KSQL_FUNCTION_CATALOG.window,
    ...KSQL_FUNCTION_CATALOG.contextual,
    "IF",
  ]);
  const parserSpellings = new Set(PARSER_FUNCTION_SPELLINGS);
  const fixtureSpellings = new Set(Object.keys(KSQL_FUNCTION_SQL_FIXTURES));

  test("catalog and parser accepted spellings match in both directions", () => {
    expect(sorted([...catalogSpellings].filter((name) => !parserSpellings.has(name)))).toEqual([]);
    expect(sorted([...parserSpellings].filter((name) => !catalogSpellings.has(name)))).toEqual([]);
  });

  test("aggregate catalog matches the frozen parser aggregate acceptance set", () => {
    expect(sorted(KSQL_FUNCTION_CATALOG.aggregate)).toEqual(sorted(PARSER_AGGREGATE_FUNCTIONS));
    expect(KSQL_FUNCTION_CATALOG.aggregate).toHaveLength(12);
  });

  test("fixture keys match parser spellings in both directions and every SQL parses", () => {
    expect(sorted([...fixtureSpellings].filter((name) => !parserSpellings.has(name)))).toEqual([]);
    expect(sorted([...parserSpellings].filter((name) => !fixtureSpellings.has(name)))).toEqual([]);
    for (const [spelling, sql] of Object.entries(KSQL_FUNCTION_SQL_FIXTURES)) {
      expect(() => parseSqlStatement(sql)).not.toThrow();
      expect(sql).toContain(spelling);
    }
  });

  test("each documented alias maps to its documented canonical AST name", () => {
    for (const [alias, canonical] of aliases) {
      expect(PARSER_SCALAR_FUNCTION_TOKEN_MAP[alias as TokenKind]).toBe(canonical);
    }
  });

  test.each([
    ["concat operator", "SELECT 姓 || 名 AS 氏名 FROM APP1"],
    ["LIKE", "SELECT * FROM APP1 WHERE 名前 LIKE 'A%'"],
    ["KLIKE", "SELECT * FROM APP1 WHERE 名前 KLIKE 'A'"],
    ["IN", "SELECT * FROM APP1 WHERE 数値 IN (1, 2)"],
    ["BETWEEN", "SELECT * FROM APP1 WHERE 数値 BETWEEN 1 AND 2"],
    ["IS NULL", "SELECT * FROM APP1 WHERE 名前 IS NULL"],
    ["CASE WHEN", "SELECT CASE WHEN 数値 = 1 THEN 'a' ELSE 'b' END AS x FROM APP1"],
  ])("parses catalog syntax %s", (_label, sql) => {
    expect(() => parseSqlStatement(sql)).not.toThrow();
  });
});
