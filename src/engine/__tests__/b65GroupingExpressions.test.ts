import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { FieldRef, SelectStatement } from "../../types/ast";
import {
  validateGroupingPlanning,
  type GroupingFieldResolver,
} from "../../core/groupingValidation";
import {
  applyGroupingSets,
  applyOrderBy,
  buildOrderByAliasEvaluator,
  project,
  type ProcessRow,
} from "../process";
import { readGroupingMembership } from "../groupingRowMeta";
import { resolveFieldSemantics } from "../../core/fieldSemantics";

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

const resolver: GroupingFieldResolver = (ref: FieldRef) => ({
  canonicalId: `APP1:${ref.field}`,
  directKey: ref.tableAlias ? `${ref.tableAlias}.${ref.field}` : ref.field,
  unqualifiedBridgeKey: ref.field,
  physical: true,
});

function grouped(stmt: SelectStatement, rows: ProcessRow[]): ProcessRow[] {
  const spec = validateGroupingPlanning(stmt, resolver);
  if (!spec) throw new Error("test requires B65 grouping");
  return applyGroupingSets(rows, spec, stmt.columns);
}

test("B65-C04: GROUPING() は field 値でなく membership を評価する", () => {
  const stmt = parse(
    "SELECT a, GROUPING(a) AS g, COUNT(*) AS n FROM APP1 GROUP BY ROLLUP(a)"
  );
  const projected = project(grouped(stmt, [{ a: "" }]), stmt.columns).rows;
  expect(projected).toEqual([
    { a: "", g: "0", n: "1" },
    { a: "", g: "1", n: "1" },
  ]);
});

test("B65-O01/O02: direct GROUPING_KEY と alias evaluator は同じ sidecar 値で total を末尾にする", () => {
  const directStmt = parse(
    "SELECT a, GROUPING(a) AS g, SUM(x) AS total FROM APP1 " +
    "GROUP BY ROLLUP(a) ORDER BY GROUPING(a), total DESC"
  );
  expect(directStmt.orderBy[0].key.type).toBe("GROUPING_KEY");
  const rows = grouped(directStmt, [
    { a: "A", x: "2" },
    { a: "B", x: "10" },
  ]);
  const direct = applyOrderBy(
    rows,
    directStmt.orderBy,
    undefined,
    undefined,
    new Map([["total", resolveFieldSemantics({ fieldType: "NUMBER" })]]),
    buildOrderByAliasEvaluator(directStmt.columns)
  );

  const aliasStmt = parse(
    "SELECT a, GROUPING(a) AS g, SUM(x) AS total FROM APP1 " +
    "GROUP BY ROLLUP(a) ORDER BY g, total DESC"
  );
  const aliasRows = grouped(aliasStmt, [
    { a: "A", x: "2" },
    { a: "B", x: "10" },
  ]);
  const alias = applyOrderBy(
    aliasRows,
    aliasStmt.orderBy,
    undefined,
    undefined,
    new Map([["total", resolveFieldSemantics({ fieldType: "NUMBER" })]]),
    buildOrderByAliasEvaluator(aliasStmt.columns)
  );

  expect(direct.map((row) => [row.a, readGroupingMembership(row)?.size])).toEqual([
    ["B", 1],
    ["A", 1],
    ["", 0],
  ]);
  expect(project(direct, directStmt.columns).rows).toEqual(project(alias, aliasStmt.columns).rows);
});

test("B65-O03: GROUPING direct key と alias なし aggregate 合成名 ORDER を併用できる", () => {
  const stmt = parse(
    "SELECT a, GROUPING(a) AS g, SUM(x) FROM APP1 " +
    "GROUP BY ROLLUP(a) ORDER BY GROUPING(a), `SUM(x)` DESC"
  );
  const ordered = applyOrderBy(
    grouped(stmt, [{ a: "A", x: "2" }, { a: "B", x: "10" }]),
    stmt.orderBy,
    undefined,
    undefined,
    new Map([["SUM(x)", resolveFieldSemantics({ fieldType: "NUMBER" })]]),
    buildOrderByAliasEvaluator(stmt.columns)
  );
  expect(project(ordered, stmt.columns).rows).toEqual([
    { a: "B", g: "0", "SUM(x)": "10" },
    { a: "A", g: "0", "SUM(x)": "2" },
    { a: "", g: "1", "SUM(x)": "12" },
  ]);
});

test("membership の無い行で GROUPING() を評価すると internal error", () => {
  const stmt = parse("SELECT GROUPING(a) AS g FROM APP1 GROUP BY ROLLUP(a)");
  validateGroupingPlanning(stmt, resolver);
  expect(() => project([{}], stmt.columns)).toThrow(
    "internal error: GROUPING() evaluation requires B65 grouping row membership"
  );
});
