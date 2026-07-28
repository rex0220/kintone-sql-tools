import { completeInputReasons } from "../dmlGuard";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { Statement } from "../../types/ast";

function parse(sql: string): Statement {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

test("B65-F03: ROLLUP/GROUPING SETS だけに GROUPING_SETS complete-input reason を付ける", () => {
  expect(completeInputReasons(parse(
    "SELECT a, COUNT(*) FROM APP1 GROUP BY ROLLUP(a)"
  ))).toEqual(new Set(["GROUPING_SETS", "AGGREGATE"]));
  expect(completeInputReasons(parse(
    "SELECT a, COUNT(*) FROM APP1 GROUP BY GROUPING SETS ((a),())"
  ))).toEqual(new Set(["GROUPING_SETS", "AGGREGATE"]));
  expect(completeInputReasons(parse(
    "SELECT a, COUNT(*) FROM APP1 GROUP BY a"
  ))).toEqual(new Set(["GROUP_BY", "AGGREGATE"]));
});

test("B65-F06: UNION/WITH/subquery の既存再帰でも GROUPING_SETS reason を拾う", () => {
  const statements = [
    "SELECT a FROM APP1 UNION ALL SELECT a FROM APP1 GROUP BY ROLLUP(a)",
    "WITH c AS (SELECT a, COUNT(*) AS n FROM APP1 GROUP BY ROLLUP(a)) SELECT a FROM c",
    "SELECT a, (SELECT COUNT(*) FROM APP2 GROUP BY GROUPING SETS (())) AS n FROM APP1",
  ];
  for (const sql of statements) {
    expect(completeInputReasons(parse(sql))).toContain("GROUPING_SETS");
  }
});
