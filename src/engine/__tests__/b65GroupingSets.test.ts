import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import {
  resolveGroupingSpec,
  type ResolvedGroupingSpec,
} from "../../core/grouping";
import {
  validateGroupingPlanning,
  type GroupingFieldResolver,
} from "../../core/groupingValidation";
import {
  applyDistinct,
  applyGroupingSets,
  applyHaving,
  applyLimit,
  applyOrderBy,
  applyWindow,
  buildDistinctTuple,
  project,
  type ProcessRow,
} from "../process";
import { readGroupingMembership } from "../groupingRowMeta";

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function resolved(
  stmt: SelectStatement,
  options: { qualified?: boolean; ambiguousBridge?: boolean } = {}
): ResolvedGroupingSpec {
  const resolver: GroupingFieldResolver = (field) => {
    const directKey = options.qualified ? `t.${field.field}` : field.field;
    return {
      canonicalId: `APP1:${field.field}`,
      directKey,
      unqualifiedBridgeKey: options.ambiguousBridge ? null : field.field,
      physical: true,
    };
  };
  const spec = resolveGroupingSpec(stmt, resolver);
  if (!spec) throw new Error("test requires a B65 grouping spec");
  return spec;
}

function membership(row: ProcessRow): string[] {
  return [...(readGroupingMembership(row) ?? [])];
}

describe("B65 Phase1 Step 2 grouping-set engine", () => {
  test("B65-C01: subtotal/total は先頭行の実値を残さず direct key と bridge を空文字へ上書きする", () => {
    const stmt = parse(
      "SELECT t.地域, t.会社名, SUM(t.売上) AS total FROM APP1 AS t GROUP BY ROLLUP(t.地域,t.会社名)"
    );
    const rows = applyGroupingSets([
      { "t.地域": "東", 地域: "東", "t.会社名": "A", 会社名: "A", "t.売上": "10" },
      { "t.地域": "東", 地域: "東", "t.会社名": "B", 会社名: "B", "t.売上": "20" },
    ], resolved(stmt, { qualified: true }), stmt.columns);

    const subtotal = rows.find((row) => membership(row).length === 1)!;
    const total = rows.find((row) => membership(row).length === 0)!;
    expect(subtotal).toMatchObject({ "t.地域": "東", 地域: "東", "t.会社名": "", 会社名: "" });
    expect(total).toMatchObject({ "t.地域": "", 地域: "", "t.会社名": "", 会社名: "" });
  });

  test("B65-C02: set に含む field は bucket の direct 値で direct key/bridge を確定上書きする", () => {
    const stmt = parse(
      "SELECT t.地域, COUNT(*) AS n FROM APP1 AS t GROUP BY GROUPING SETS ((t.地域))"
    );
    const rows = applyGroupingSets([
      { "t.地域": "東", 地域: "stale-east" },
      { "t.地域": "西", 地域: "stale-west" },
    ], resolved(stmt, { qualified: true }), stmt.columns);

    expect(rows.map((row) => [row["t.地域"], row.地域, row.n])).toEqual([
      ["東", "東", "1"],
      ["西", "西", "1"],
    ]);
  });

  test("B65-C02/E30: 曖昧 JOIN identity には unqualified bridge を作らない", () => {
    const stmt = parse(
      "SELECT t.a, COUNT(*) AS n FROM APP1 AS t GROUP BY GROUPING SETS ((t.a),())"
    );
    const rows = applyGroupingSets(
      [{ "t.a": "A", a: "user-visible-other-source" }],
      resolved(stmt, { qualified: true, ambiguousBridge: true }),
      stmt.columns
    );
    expect(rows[0]).toMatchObject({ "t.a": "A", a: "user-visible-other-source" });
    expect(rows[1]).toMatchObject({ "t.a": "", a: "user-visible-other-source" });
  });

  test("B65-C03: 実データ空セル detail と total は同じ値でも membership で区別できる", () => {
    const stmt = parse("SELECT a, COUNT(*) AS n FROM APP1 GROUP BY ROLLUP(a)");
    const rows = applyGroupingSets([{ a: "" }], resolved(stmt), stmt.columns);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.a)).toEqual(["", ""]);
    expect(rows.map(membership)).toEqual([["APP1:a"], []]);
  });

  test("B65-C05: ROLLUP(a,b) は各 set を明示順に縦結合し集計を独立評価する", () => {
    const stmt = parse("SELECT a, b, SUM(x) AS total FROM APP1 GROUP BY ROLLUP(a,b)");
    const rows = applyGroupingSets([
      { a: "A", b: "x", x: "1" },
      { a: "A", b: "y", x: "2" },
      { a: "B", b: "x", x: "4" },
    ], resolved(stmt), stmt.columns);

    expect(rows.map((row) => [row.a, row.b, row.total, membership(row).length])).toEqual([
      ["A", "x", "1", 2],
      ["A", "y", "2", 2],
      ["B", "x", "4", 2],
      ["A", "", "3", 1],
      ["B", "", "4", 1],
      ["", "", "7", 0],
    ]);
  });

  test("B65-C06: ROLLUP(a,a) の重複 set は重複中間行を保持する", () => {
    const stmt = parse("SELECT a, COUNT(*) AS n FROM APP1 GROUP BY ROLLUP(a,a)");
    const rows = applyGroupingSets([{ a: "A" }, { a: "B" }], resolved(stmt), stmt.columns);
    expect(rows.map((row) => [row.a, row.n, membership(row).length])).toEqual([
      ["A", "1", 1],
      ["B", "1", 1],
      ["A", "1", 1],
      ["B", "1", 1],
      ["", "2", 0],
    ]);
  });

  test("B65-C07: 0件入力は非空 set 0行、空 set 1行で grouping-only でも生成する", () => {
    const stmt = parse(
      "SELECT COUNT(*) AS n FROM APP1 GROUP BY GROUPING SETS ((a),())"
    );
    const rows = applyGroupingSets([], resolved(stmt), stmt.columns);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ a: "", n: "0" });
    expect(membership(rows[0])).toEqual([]);

    const groupingOnly = parse(
      "SELECT 'total' AS label FROM APP1 GROUP BY GROUPING SETS (())"
    );
    expect(applyGroupingSets([], resolved(groupingOnly), groupingOnly.columns)).toHaveLength(1);
  });

  test("B65-C08/C10: symbol sidecar は user field と衝突せず各段で保持され project で除去される", () => {
    const stmt = parse(
      "SELECT a, __grouping, COUNT(*) AS n FROM APP1 GROUP BY GROUPING SETS ((a))"
    );
    let rows = applyGroupingSets(
      [{ a: "A", __grouping: "user-value" }],
      resolved(stmt),
      stmt.columns
    );
    expect(rows[0].__grouping).toBe("user-value");
    expect(Object.keys(rows[0])).not.toContain("__ksqlGroupingMeta");
    expect(Object.getOwnPropertySymbols(rows[0])).toHaveLength(1);

    rows = applyHaving(rows, null);
    rows = applyWindow(rows, stmt.columns);
    rows = applyDistinct(rows, stmt.columns);
    rows = applyOrderBy(rows, []);
    rows = applyLimit(rows, 1, 0);
    expect(membership(rows[0])).toEqual(["APP1:a"]);

    const projected = project(rows, stmt.columns).rows[0];
    expect(projected).toEqual({ a: "A", __grouping: "user-value", n: "1" });
    expect(readGroupingMembership(projected)).toBeUndefined();
    expect(Object.getOwnPropertySymbols(projected)).toHaveLength(0);
  });

  test("B65-C09: NUL を含む異なる tuple は同じ bucket に衝突しない", () => {
    const stmt = parse("SELECT a, b, COUNT(*) AS n FROM APP1 GROUP BY GROUPING SETS ((a,b))");
    const rows = applyGroupingSets([
      { a: "x\u0000y", b: "z" },
      { a: "x", b: "y\u0000z" },
    ], resolved(stmt), stmt.columns);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.a, row.b, row.n])).toEqual([
      ["x\u0000y", "z", "1"],
      ["x", "y\u0000z", "1"],
    ]);
  });

  test("B65-SD10: generated-row guard は DISTINCT の dedupe 見込みでも免除しない", () => {
    const stmt = parse("SELECT DISTINCT a FROM APP1 GROUP BY ROLLUP(a)");
    expect(() => applyGroupingSets(
      [{ a: "A" }, { a: "B" }],
      resolved(stmt),
      stmt.columns,
      undefined,
      { maxGeneratedRows: 2 }
    )).toThrow(/GROUPING_OUTPUT_LIMIT_EXCEEDED/);
  });

  test("B65-SD09: project と DISTINCT tuple は全明示列型を同じ evaluator で評価する", () => {
    const stmt = parse(
      "SELECT a AS field_value, 'x' AS literal_value, SUM(x) AS aggregate_value, " +
      "SUM(x)+1 AS aggregate_arith_value, a||'!' AS scalar_value, UPPER(a) AS string_value, " +
      "CASE WHEN a='A' THEN 'case-a' ELSE 'case-other' END AS case_value, " +
      "GROUPING(a) AS grouping_value, (SELECT 'sub') AS subquery_value " +
      "FROM APP1 GROUP BY ROLLUP(a)"
    );
    const planned = validateGroupingPlanning(stmt, (field) => ({
      canonicalId: `APP1:${field.field}`,
      directKey: field.field,
      unqualifiedBridgeKey: field.field,
      physical: true,
    }));
    if (!planned) throw new Error("test requires a B65 grouping spec");
    const rows = applyGroupingSets(
      [{ a: "A", x: "2" }],
      planned,
      stmt.columns
    );
    const scalarCache = new Map([[8, "sub"]]);

    for (const row of rows) {
      const tuple = buildDistinctTuple(stmt.columns, row, { scalarCache });
      const projected = project(rows.length > 0 ? [row] : [], stmt.columns, scalarCache).rows[0];
      expect(tuple).toEqual(stmt.columns.map((column) => {
        if (!("alias" in column) || column.alias === null) {
          throw new Error("test requires unique aliases");
        }
        return projected[column.alias];
      }));
    }
  });
});
