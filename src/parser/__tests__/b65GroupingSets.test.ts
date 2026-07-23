import { Lexer } from "../../lexer/lexer";
import type { SelectStatement } from "../../types/ast";
import { Parser, ParseError } from "../parser";

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

describe("B65 Phase1 Step 1 parser", () => {
  test("B65-P01: ROLLUP は単一・複数列を prefix set へ展開する", () => {
    expect(parse("SELECT a, SUM(x) FROM APP1 GROUP BY ROLLUP(a)")).toMatchSnapshot("single");
    expect(parse("SELECT a, b, SUM(x) FROM APP1 GROUP BY ROLLUP(a,b)")).toMatchSnapshot("multiple");
  });

  test("B65-P02: GROUPING SETS は空set・複数item・省略形・順序・重複を保持する", () => {
    const stmt = parse(
      "SELECT a, b, SUM(x) FROM APP1 GROUP BY GROUPING SETS ((), (a,b), a, (a,b))"
    );
    expect(stmt.grouping).toEqual({
      type: "GROUPING_SETS",
      source: "GROUPING_SETS",
      allItems: [
        { type: "FIELD", tableAlias: null, field: "a" },
        { type: "FIELD", tableAlias: null, field: "b" },
      ],
      sets: [
        { items: [] },
        { items: [
          { type: "FIELD", tableAlias: null, field: "a" },
          { type: "FIELD", tableAlias: null, field: "b" },
        ] },
        { items: [{ type: "FIELD", tableAlias: null, field: "a" }] },
        { items: [
          { type: "FIELD", tableAlias: null, field: "a" },
          { type: "FIELD", tableAlias: null, field: "b" },
        ] },
      ],
    });
  });

  test("B65-P03: GROUPING は SELECT・CASE 条件・direct ORDER BY の dedicated node", () => {
    expect(parse(
      "SELECT GROUPING(a) AS g, CASE WHEN GROUPING(a)=1 THEN 'total' ELSE a END AS a, SUM(x) AS total " +
      "FROM APP1 GROUP BY ROLLUP(a) ORDER BY GROUPING(a), total DESC"
    )).toMatchSnapshot();
  });

  test("B65-CU01: field-only CUBE は位置順の全部分集合へ展開する", () => {
    expect(parse("SELECT a, SUM(x) FROM APP1 GROUP BY CUBE(a)").grouping).toMatchObject({
      source: "CUBE",
      sets: [
        { items: [{ field: "a" }] },
        { items: [] },
      ],
    });
    expect(parse("SELECT a, b, SUM(x) FROM APP1 GROUP BY CUBE(a,b)").grouping).toMatchObject({
      source: "CUBE",
      sets: [
        { items: [{ field: "a" }, { field: "b" }] },
        { items: [{ field: "a" }] },
        { items: [{ field: "b" }] },
        { items: [] },
      ],
    });
    expect(parse("SELECT COUNT(*) FROM APP1 GROUP BY CUBE(a,b,c)").grouping?.sets)
      .toHaveLength(8);
  });

  test("B65-H01: HAVING GROUPING は dedicated field-value node として受理する", () => {
    const stmt = parse(
      "SELECT a, SUM(x) AS total FROM APP1 GROUP BY ROLLUP(a) HAVING GROUPING(a)=1"
    );
    expect(stmt.having).toMatchObject({
      type: "BINARY",
      left: {
        type: "GROUPING_FIELD",
        ref: { type: "GROUPING_REF", field: { type: "FIELD", field: "a" } },
      },
      op: "=",
      right: { type: "NUMBER", value: 1 },
    });
  });

  test.each([
    ["ROLLUP expression", "SELECT a FROM APP1 GROUP BY ROLLUP(a||b)"],
    ["nested", "SELECT a FROM APP1 GROUP BY GROUPING SETS (ROLLUP(a))"],
    ["mixed-leading", "SELECT a FROM APP1 GROUP BY a, ROLLUP(b)"],
    ["mixed-trailing", "SELECT a FROM APP1 GROUP BY ROLLUP(a), b"],
    ["empty GROUPING SETS", "SELECT a FROM APP1 GROUP BY GROUPING SETS ()"],
    ["zero GROUPING args", "SELECT GROUPING() FROM APP1 GROUP BY ROLLUP(a)"],
    ["multiple GROUPING args", "SELECT GROUPING(a,b) FROM APP1 GROUP BY ROLLUP(a,b)"],
    ["GROUPING expression", "SELECT GROUPING(a||b) FROM APP1 GROUP BY ROLLUP(a,b)"],
    ["GROUPING_ID", "SELECT GROUPING_ID(a) FROM APP1 GROUP BY ROLLUP(a)"],
    ["WHERE GROUPING", "SELECT a FROM APP1 WHERE GROUPING(a)=0 GROUP BY ROLLUP(a)"],
    ["window ORDER GROUPING", "SELECT ROW_NUMBER() OVER (ORDER BY GROUPING(a)) AS n FROM APP1"],
    ["window PARTITION GROUPING", "SELECT ROW_NUMBER() OVER (PARTITION BY GROUPING(a)) AS n FROM APP1"],
    ["window with B65", "SELECT ROW_NUMBER() OVER (ORDER BY a) AS n FROM APP1 GROUP BY ROLLUP(a)"],
    ["aggregate argument", "SELECT SUM(GROUPING(a)) FROM APP1 GROUP BY ROLLUP(a)"],
    [
      "HAVING aggregate argument",
      "SELECT a, SUM(x) FROM APP1 GROUP BY ROLLUP(a) HAVING SUM(GROUPING(a))>0",
    ],
    [
      "HAVING GROUPING arithmetic",
      "SELECT a, SUM(x) FROM APP1 GROUP BY ROLLUP(a) HAVING GROUPING(a)+1>0",
    ],
    ["JOIN ON GROUPING", "SELECT a FROM APP1 JOIN APP2 b ON GROUPING(a)=0"],
    ["DML expression", "UPDATE APP1 SET x=GROUPING(a) WHERE $id=1"],
    ["KORDER", "SELECT a FROM APP1 GROUP BY ROLLUP(a) KORDER BY a LIMIT 1"],
    ["GROUP BY DISTINCT", "SELECT a FROM APP1 GROUP BY DISTINCT ROLLUP(a)"],
  ])("B65-P04: %s を明示拒否する", (_name, sql) => {
    expect(() => parse(sql)).toThrow(ParseError);
  });

  test.each([
    ["empty", "SELECT COUNT(*) FROM APP1 GROUP BY CUBE()"],
    ["expression", "SELECT COUNT(*) FROM APP1 GROUP BY CUBE(UPPER(x))"],
    ["sublist", "SELECT COUNT(*) FROM APP1 GROUP BY CUBE((a,b))"],
    ["nested", "SELECT COUNT(*) FROM APP1 GROUP BY GROUPING SETS (CUBE(a,b))"],
    ["mixed-leading", "SELECT COUNT(*) FROM APP1 GROUP BY a, CUBE(b)"],
    ["mixed-trailing", "SELECT COUNT(*) FROM APP1 GROUP BY CUBE(a), b"],
  ])("B65-CU06: CUBE %s は field-only direct 境界で拒否する", (_name, sql) => {
    expect(() => parse(sql)).toThrow(ParseError);
  });

  test("B65-P05: 通常 GROUP BY AST は grouping property を持たない", () => {
    const stmt = parse("SELECT a, b, SUM(x) AS total FROM APP1 GROUP BY a,b ORDER BY total");
    expect(Object.prototype.hasOwnProperty.call(stmt, "grouping")).toBe(false);
    expect(stmt.groupBy).toEqual([
      { type: "FIELD_NAME", name: "a" },
      { type: "FIELD_NAME", name: "b" },
    ]);
  });

  test("B65-P06: soft keyword は field・alias・通常 GROUP BY 名を壊さない", () => {
    expect(parse(
      "SELECT ROLLUP, GROUPING, SETS, CUBE, x AS GROUPING FROM APP1 GROUP BY ROLLUP ORDER BY GROUPING"
    )).toMatchObject({
      columns: [
        { type: "FIELD", field: "ROLLUP" },
        { type: "FIELD", field: "GROUPING" },
        { type: "FIELD", field: "SETS" },
        { type: "FIELD", field: "CUBE" },
        { type: "FIELD", field: "x", alias: "grouping" },
      ],
      groupBy: [{ type: "FIELD_NAME", name: "ROLLUP" }],
      orderBy: [{ key: { type: "FIELD_NAME", name: "GROUPING" } }],
    });
    expect(parse("SELECT SETS, CUBE FROM APP1 GROUP BY SETS, CUBE")).toMatchObject({
      groupBy: [
        { type: "FIELD_NAME", name: "SETS" },
        { type: "FIELD_NAME", name: "CUBE" },
      ],
    });
  });
});
