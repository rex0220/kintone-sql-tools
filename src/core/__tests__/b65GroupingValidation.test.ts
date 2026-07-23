import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { FieldRef, SelectStatement } from "../../types/ast";
import {
  validateGroupingPlanning,
  type GroupingFieldResolver,
} from "../groupingValidation";
import { normalizeGroupingSpec } from "../grouping";

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function resolver(fields: readonly string[]): GroupingFieldResolver {
  return (ref: FieldRef) => {
    const key = ref.tableAlias ? `${ref.tableAlias}.${ref.field}` : ref.field;
    if (!fields.includes(ref.field) && !fields.includes(key)) {
      throw new Error(`ArgumentError: unknown ${key}`);
    }
    return {
      canonicalId: `APP1:${ref.field}`,
      directKey: key,
      unqualifiedBridgeKey: ref.field,
      physical: true,
    };
  };
}

describe("B65 Phase1 Step 1 planning validator", () => {
  test("normalizer は NONE/PLAIN/GROUPING_SETS を排他的に返す", () => {
    expect(normalizeGroupingSpec(parse("SELECT a FROM APP1"))).toEqual({ type: "NONE" });
    expect(normalizeGroupingSpec(parse("SELECT a FROM APP1 GROUP BY a"))).toMatchObject({ type: "PLAIN" });
    expect(normalizeGroupingSpec(parse("SELECT a FROM APP1 GROUP BY ROLLUP(a)"))).toMatchObject({
      type: "GROUPING_SETS",
      source: "ROLLUP",
    });
    const invalid = parse("SELECT a FROM APP1 GROUP BY a");
    invalid.grouping = parse("SELECT a FROM APP1 GROUP BY ROLLUP(a)").grouping;
    expect(() => normalizeGroupingSpec(invalid)).toThrow("both groupBy and grouping");
  });

  test("Step 4 用 planning guard hook は展開後set数とcanonical item数を返す", () => {
    const stmt = parse("SELECT a, SUM(x) FROM APP1 GROUP BY ROLLUP(a,a)");
    const hook = jest.fn();
    validateGroupingPlanning(stmt, resolver(["a", "x"]), hook);
    expect(hook).toHaveBeenCalledWith({
      expandedSetCount: 3,
      canonicalItemCount: 1,
    });
  });

  test.each([
    ["GROUPING arg outside allItems", "SELECT GROUPING(b), SUM(x) FROM APP1 GROUP BY ROLLUP(a)", /NOT_ITEM/],
    ["wildcard", "SELECT *, SUM(x) FROM APP1 GROUP BY ROLLUP(a)", /wildcard/],
    ["non-grouped dependency", "SELECT b, SUM(x) FROM APP1 GROUP BY ROLLUP(a)", /NON_GROUPED/],
    ["aggregate alias collision", "SELECT a, SUM(x) AS a FROM APP1 GROUP BY ROLLUP(a)", /ALIAS_COLLISION/],
    ["aggregate string alias collision", "SELECT a, CONCAT(SUM(x),'x') AS a FROM APP1 GROUP BY ROLLUP(a)", /ALIAS_COLLISION/],
    ["aggregate scalar alias collision", "SELECT a, CONCAT(SUM(x),'x')||'y' AS a FROM APP1 GROUP BY ROLLUP(a)", /ALIAS_COLLISION/],
    ["GROUPING without B65", "SELECT GROUPING(a) FROM APP1 GROUP BY a", /requires GROUP BY/],
  ])("B65 Step1 planning rejection: %s", (_name, sql, message) => {
    expect(() => validateGroupingPlanning(parse(sql), resolver(["a", "b", "x"]))).toThrow(message);
  });

  test("B65-SD03: planning は SELECT DISTINCT + ROLLUP を受理する", () => {
    expect(() => validateGroupingPlanning(
      parse("SELECT DISTINCT a, SUM(x) FROM APP1 GROUP BY ROLLUP(a)"),
      resolver(["a", "x"])
    )).not.toThrow();
  });

  test("narrow alias rule は看板 CASE alias を受理する", () => {
    const stmt = parse(
      "SELECT CASE WHEN GROUPING(a)=1 THEN 'total' ELSE a END AS a, SUM(x) AS total " +
      "FROM APP1 GROUP BY ROLLUP(a)"
    );
    expect(() => validateGroupingPlanning(stmt, resolver(["a", "x"]))).not.toThrow();
  });

  test("materialized grouping item は拒否する", () => {
    const stmt = parse("SELECT c.a FROM APP1 c GROUP BY ROLLUP(c.a)");
    expect(() => validateGroupingPlanning(stmt, () => ({
      canonicalId: "cte:a",
      directKey: "c.a",
      unqualifiedBridgeKey: "a",
      physical: false,
    }))).toThrow(/physical APP field/);
  });

  test("qualified grouping item と同じ qualified SELECT dependency を受理する", () => {
    const stmt = parse("SELECT t.a, SUM(t.x) FROM APP1 t GROUP BY ROLLUP(t.a)");
    expect(() => validateGroupingPlanning(stmt, resolver(["t.a", "t.x"]))).not.toThrow();
  });

  test("GROUPING を含まない既存 HAVING と aggregate alias ORDER BY は受理する", () => {
    const stmt = parse(
      "SELECT a, SUM(x) AS total FROM APP1 GROUP BY ROLLUP(a) HAVING SUM(x)>0 ORDER BY total DESC"
    );
    expect(() => validateGroupingPlanning(stmt, resolver(["a", "x"]))).not.toThrow();
  });

  test("B65-H07: HAVING GROUPING argument は allItems membership を planning で検証する", () => {
    const stmt = parse(
      "SELECT a, SUM(x) FROM APP1 GROUP BY ROLLUP(a) HAVING GROUPING(b)=1"
    );
    expect(() => validateGroupingPlanning(stmt, resolver(["a", "b", "x"]))).toThrow(
      /B65_GROUPING_ARG_NOT_ITEM/
    );
  });

  test("B65-E30: JOIN の修飾 canonical identity を分離して受理する", () => {
    const stmt = parse(
      "SELECT l.code, r.code, GROUPING(l.code), SUM(l.x) FROM APP1 l " +
      "JOIN APP2 r ON l.id=r.id GROUP BY ROLLUP(l.code,r.code)"
    );
    const qualifiedResolver: GroupingFieldResolver = (ref) => ({
      canonicalId: `${ref.tableAlias ?? "unqualified"}:${ref.field}`,
      directKey: ref.tableAlias ? `${ref.tableAlias}.${ref.field}` : ref.field,
      unqualifiedBridgeKey: null,
      physical: true,
    });
    expect(() => validateGroupingPlanning(stmt, qualifiedResolver)).not.toThrow();
  });

  test("B65-E31: GROUPING(a) AS a は narrow aggregate alias collision の対象外", () => {
    const stmt = parse(
      "SELECT GROUPING(a) AS a, SUM(x) AS total FROM APP1 GROUP BY ROLLUP(a) ORDER BY a"
    );
    expect(() => validateGroupingPlanning(stmt, resolver(["a", "x"]))).not.toThrow();
  });
});
