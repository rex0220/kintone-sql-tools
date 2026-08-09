import { execute, type KintoneClient } from "../../execute";
import { Lexer } from "../../lexer/lexer";
import type { WithStatement } from "../../types/ast";
import { ParseError, Parser } from "../parser";

function parse(sql: string): WithStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as WithStatement;
}

const VALID = `WITH RECURSIVE tree (parent, child, depth) AS (
  SELECT parent, child, 1 FROM APP100 WHERE parent = 'A'
  UNION ALL
  SELECT c.parent, c.child, r.depth + 1
  FROM APP100 AS c INNER JOIN tree AS r ON c.parent = r.child
)
CYCLE child SET is_cycle TO 'Y' DEFAULT 'N'
SELECT parent, child, depth, is_cycle FROM tree`;

describe("B53 Stage 1 parser / AST", () => {
  test("§2/§7.2: recursiveSpec keeps seed, recursive term, aliases, and CYCLE", () => {
    const ast = parse(VALID);
    expect(ast.recursive).toBe(true);
    expect(ast.ctes).toHaveLength(1);
    expect(ast.ctes[0]).toMatchObject({
      name: "tree",
      columnAliases: ["parent", "child", "depth"],
      recursiveSpec: {
        seed: { type: "SELECT", from: { appId: 100, cteName: null } },
        recursiveTerm: { type: "SELECT", joins: [{ type: "INNER", table: { cteName: "tree" } }] },
        unionAll: true,
        cycle: {
          column: "child",
          markColumn: "is_cycle",
          markValue: "Y",
          defaultValue: "N",
          exposePath: false,
        },
      },
    });
  });

  test("§2: WITH RECURSIVE with no self-reference remains a non-recursive WITH", () => {
    const ast = parse("WITH RECURSIVE x AS (SELECT a FROM APP1) SELECT a FROM x");
    expect(ast.recursive).toBe(true);
    expect(ast.ctes[0].recursiveSpec).toBeUndefined();
  });

  test("§7.2: ordinary WITH public AST shape remains unchanged", () => {
    expect(parse("WITH x AS (SELECT a FROM APP1) SELECT a FROM x")).toEqual({
      type: "WITH",
      ctes: [{ name: "x", query: expect.objectContaining({ type: "SELECT" }) }],
      query: expect.objectContaining({ type: "SELECT" }),
    });
  });

  test("§2: definition-order sibling visibility works around the recursive CTE", () => {
    const ast = parse(`WITH RECURSIVE src AS (SELECT parent, child FROM APP100),
      tree (parent, child) AS (
        SELECT parent, child FROM src
        UNION ALL SELECT s.parent, s.child FROM src s INNER JOIN tree r ON s.parent = r.child
      ), out AS (SELECT child FROM tree) SELECT child FROM out`);
    expect(ast.ctes.map((cte) => cte.name)).toEqual(["src", "tree", "out"]);
    expect(ast.ctes[1].recursiveSpec).toBeDefined();
  });

  test("ordinary WITH rejects a CTE column-name list", () => {
    expect(() => parse("WITH x (renamed) AS (SELECT original FROM APP1) SELECT renamed FROM x"))
      .toThrow("CTE の列名リストは WITH RECURSIVE の再帰 CTE にだけ指定できます");
  });

  test("WITH RECURSIVE rejects a column-name list on a non-recursive sibling", () => {
    expect(() => parse("WITH RECURSIVE src (renamed) AS (SELECT original FROM APP1) SELECT renamed FROM src"))
      .toThrow("CTE の列名リストは WITH RECURSIVE の再帰 CTE にだけ指定できます");
  });

  test("WITH RECURSIVE continues to accept a column-name list on the recursive CTE", () => {
    expect(parse(VALID).ctes[0].columnAliases).toEqual(["parent", "child", "depth"]);
  });
});

describe("B53 §7.3 contextual soft keywords", () => {
  test("normal SELECT keeps all four words as identifiers", () => {
    const ast = new Parser(new Lexer(
      "SELECT RECURSIVE, CYCLE, TO, DEFAULT FROM APP1"
    ).tokenize()).parse();
    expect(ast).toMatchObject({
      type: "SELECT",
      columns: [
        { type: "FIELD", field: "RECURSIVE" },
        { type: "FIELD", field: "CYCLE" },
        { type: "FIELD", field: "TO" },
        { type: "FIELD", field: "DEFAULT" },
      ],
    });
  });

  test("CTE names, aliases, columns, and backquoted keyword names remain legal", () => {
    expect(() => parse(
      "WITH RECURSIVE AS (SELECT `RECURSIVE` AS CYCLE, `TO` AS DEFAULT FROM APP1) SELECT CYCLE, DEFAULT FROM RECURSIVE"
    )).not.toThrow();
    expect(() => new Parser(new Lexer(
      "SELECT `RECURSIVE`, `CYCLE`, `TO`, `DEFAULT` FROM APP1 AS RECURSIVE"
    ).tokenize()).parse()).not.toThrow();
  });

  test("batch SET and UPDATE SET keep the hard SET token behavior", () => {
    expect(() => new Parser(new Lexer("SET @x = 1; SELECT @x AS n").tokenize()).parseStatements()).not.toThrow();
    expect(() => new Parser(new Lexer("UPDATE APP1 SET x = 'a' WHERE $id = 1").tokenize()).parse()).not.toThrow();
  });

  test.each([
    ["missing SET", VALID.replace(" SET is_cycle", " is_cycle")],
    ["missing TO", VALID.replace(" TO 'Y'", " 'Y'")],
    ["missing DEFAULT", VALID.replace(" DEFAULT 'N'", " 'N'")],
    ["quoted SET delimiter", VALID.replace(" SET is_cycle", " `SET` is_cycle")],
    ["duplicate CYCLE", `${VALID.replace("\nSELECT parent", " CYCLE child SET mark2 TO '1' DEFAULT '0'\nSELECT parent")}`],
  ])("incomplete CYCLE is fail-closed: %s", (_label, sql) => {
    expect(() => parse(sql)).toThrow(ParseError);
  });
});

describe("B53 §7.1 / §9.3 static rejection", () => {
  test.each([
    ["UNION without ALL", VALID.replace("UNION ALL", "UNION")],
    ["three UNION branches", VALID.replace("\n)\nCYCLE", " UNION ALL SELECT parent, child, 1 FROM APP2\n)\nCYCLE")],
    ["column count mismatch", VALID.replace("SELECT c.parent, c.child, r.depth + 1", "SELECT c.parent, c.child")],
    ["column alias count mismatch", VALID.replace("(parent, child, depth)", "(parent, child)")],
    ["self-reference in seed", VALID.replace("SELECT parent, child, 1 FROM APP100", "SELECT parent, child, 1 FROM tree")],
    ["self-reference twice", VALID.replace("INNER JOIN tree AS r", "INNER JOIN tree AS r INNER JOIN tree AS r2 ON r.child = r2.child")],
    ["OUTER JOIN", VALID.replace("INNER JOIN tree", "LEFT JOIN tree")],
    ["second JOIN", VALID.replace("INNER JOIN tree AS r", "INNER JOIN APP2 AS x ON c.parent = x.parent INNER JOIN tree AS r")],
    ["DISTINCT", VALID.replace("SELECT c.parent", "SELECT DISTINCT c.parent")],
    ["aggregate", VALID.replace("SELECT c.parent, c.child, r.depth + 1", "SELECT c.parent, c.child, SUM(r.depth)")],
    ["window", VALID.replace("SELECT c.parent, c.child, r.depth + 1", "SELECT c.parent, c.child, ROW_NUMBER() OVER () AS depth")],
    ["subquery", VALID.replace("ON c.parent = r.child", "ON c.parent = r.child WHERE c.parent IN (SELECT parent FROM APP2)")],
    ["GROUP BY", VALID.replace("ON c.parent = r.child", "ON c.parent = r.child GROUP BY c.parent, c.child, r.depth")],
    ["ORDER BY", VALID.replace("\n  FROM APP100 AS c", "\n  FROM APP100 AS c").replace("ON c.parent = r.child\n)", "ON c.parent = r.child ORDER BY c.parent\n)")],
    ["LIMIT", VALID.replace("ON c.parent = r.child\n)", "ON c.parent = r.child LIMIT 1\n)")],
    ["OFFSET", VALID.replace("ON c.parent = r.child\n)", "ON c.parent = r.child OFFSET 1\n)")],
    ["zero self-references with CYCLE", VALID.replace("FROM APP100 AS c INNER JOIN tree AS r ON c.parent = r.child", "FROM APP100 AS c INNER JOIN APP2 AS r ON c.parent = r.child")],
    ["CYCLE value equality", VALID.replace("DEFAULT 'N'", "DEFAULT 'Y'")],
    ["CYCLE column unresolved", VALID.replace("CYCLE child", "CYCLE missing")],
    ["mark column collision", VALID.replace("SET is_cycle", "SET depth")],
    ["multiple CYCLE columns", VALID.replace("CYCLE child", "CYCLE child, parent")],
    ["CYCLE USING", VALID.replace("DEFAULT 'N'", "DEFAULT 'N' USING path")],
    ["CYCLE NULL value", VALID.replace("TO 'Y'", "TO NULL")],
    ["CYCLE non-string value", VALID.replace("TO 'Y'", "TO 1")],
    ["nested recursive WITH", "WITH RECURSIVE a AS (WITH RECURSIVE b AS (SELECT x FROM APP1) SELECT x FROM b) SELECT x FROM a"],
    ["multiple recursive CTEs", VALID.replace("\nSELECT parent, child, depth, is_cycle FROM tree", `,
      tree2 (parent, child, depth) AS (
        SELECT parent, child, 1 FROM APP100
        UNION ALL SELECT c.parent, c.child, r.depth + 1 FROM APP100 c INNER JOIN tree2 r ON c.parent=r.child
      ) SELECT parent, child, depth FROM tree2`)],
    ["forward reference", "WITH RECURSIVE a AS (SELECT x FROM b), b AS (SELECT x FROM APP1) SELECT x FROM a"],
    ["mutual recursion", "WITH RECURSIVE a AS (SELECT x FROM APP1 UNION ALL SELECT b.x FROM b INNER JOIN a ON b.x=a.x), b AS (SELECT x FROM a) SELECT x FROM b"],
  ])("rejects %s", (_label, sql) => {
    expect(() => parse(sql)).toThrow(ParseError);
  });

  test("rejects SUM(a) - SUM(b) in the recursive term", () => {
    const sql = VALID.replace(
      "SELECT c.parent, c.child, r.depth + 1",
      "SELECT c.parent, SUM(a) - SUM(b), r.depth + 1"
    );
    expect(() => parse(sql)).toThrow("再帰項では集計、window、DISTINCT、subquery を使用できません");
  });
});

describe("B165 shape 2 diagnostic", () => {
  const message = "CTE の定義内から自分自身を参照しています。自己参照には `WITH RECURSIVE` が必要です";

  test("self-reference without RECURSIVE gets the dedicated PARSE_ERROR source diagnostic", () => {
    try {
      parse("WITH tree AS (SELECT a.x FROM APP1 a INNER JOIN tree r ON a.x=r.x) SELECT x FROM tree");
      throw new Error("expected ParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).rawMessage).toBe(message);
      expect((error as Error).name).toBe("ParseError");
    }
  });

  test("RECURSIVE remains legal as a CTE name and field/alias names remain legal", () => {
    expect(() => parse("WITH RECURSIVE AS (SELECT RECURSIVE AS 系譜 FROM APP1) SELECT 系譜 FROM RECURSIVE")).not.toThrow();
  });

  test("forward references retain the ordinary invalid-table diagnostic", () => {
    expect(() => parse("WITH a AS (SELECT x FROM b), b AS (SELECT x FROM APP1) SELECT x FROM a"))
      .toThrow(/テーブル名は APP \+ 数字/);
  });
});

test("B53 Stage 3: EXPLAIN renders the recursive plan without a records API call", async () => {
  let recordCalls = 0;
  const client = {
    async getRecords() { recordCalls++; throw new Error("records API must not be called"); },
    async openCursor() { throw new Error("cursor API must not be called"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() {
      return ["parent", "child", "depth"].map((field) => ({
        code: field, label: field,
        fieldType: field === "depth" ? "NUMBER" : "SINGLE_LINE_TEXT",
        sortKind: field === "depth" ? "number" as const : "string" as const,
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  } satisfies KintoneClient;
  const result = await execute(`EXPLAIN ${VALID}`, client);
  expect(result.type).toBe("SELECT");
  const plan = result.type === "SELECT" ? result.rows.map((row) => row.plan).join("\n") : "";
  expect(plan).toContain("recursive cte: tree");
  expect(plan).toContain("strategy: B (materialize each source once, iterate in memory)");
  expect(plan).toContain("empty-key recursive join: runtime checked");
  expect(recordCalls).toBe(0);
});
