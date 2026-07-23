import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { FieldRef, SelectStatement } from "../../types/ast";
import { analyzeBatch, BatchAnalysisError } from "../batch";
import {
  validateGroupingPlanning,
  validateGroupingStatic,
  type GroupingFieldResolver,
} from "../groupingValidation";
import { parseSqlStatements } from "../sql";

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function analyze(sql: string) {
  return analyzeBatch(parseSqlStatements(sql));
}

const resolve: GroupingFieldResolver = (field: FieldRef) => ({
  canonicalId: `APP1:${field.field}`,
  directKey: field.tableAlias ? `${field.tableAlias}.${field.field}` : field.field,
  unqualifiedBridgeKey: field.field,
  physical: true,
});

function withKorderGrouping(): SelectStatement {
  const stmt = parseSelect(
    "SELECT 会社名, SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名) ORDER BY 会社名"
  );
  stmt.orderMode = "KINTONE_NATIVE";
  return stmt;
}

function withWindowGrouping(): SelectStatement {
  const stmt = parseSelect(
    "SELECT 会社名, SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名)"
  );
  const window = parseSelect(
    "SELECT ROW_NUMBER() OVER (ORDER BY 会社名) AS rn FROM APP1"
  ).columns[0];
  stmt.columns.push(window);
  return stmt;
}

const staticRejections = [
  [
    "B65-SV02",
    withKorderGrouping,
    "ArgumentError: B65 KORDER BY is not supported in Phase1.",
  ],
  [
    "B65-SV03",
    withWindowGrouping,
    "ArgumentError: B65 window functions are not supported in Phase1.",
  ],
  [
    "B65-SV04",
    () => parseSelect("SELECT *, SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名)"),
    "ArgumentError: B65 wildcard projection is not supported in Phase1.",
  ],
  [
    "B65-SV05",
    () => parseSelect("SELECT GROUPING(会社名) FROM APP1 GROUP BY 会社名"),
    "ArgumentError: B65 GROUPING() requires GROUP BY ROLLUP or GROUPING SETS.",
  ],
] as const;

test.each(staticRejections)(
  "%s: analyzeBatch は metadata 不要の B65 拒否を文 index 付きで返す",
  (_id, makeStmt, message) => {
    try {
      analyzeBatch([parseSelect("SELECT * FROM APP2"), makeStmt()]);
      throw new Error("expected analyzeBatch to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(BatchAnalysisError);
      expect((error as BatchAnalysisError).statementIndex).toBe(1);
      expect((error as Error).message).toBe(message);
    }
  }
);

test.each(staticRejections)(
  "%s: static と metadata-backed planning は同じ純 AST エラーを返す",
  (_id, makeStmt, message) => {
    const stmt = makeStmt();
    expect(() => validateGroupingStatic(stmt)).toThrow(message);
    expect(() => validateGroupingPlanning(stmt, resolve)).toThrow(message);
  }
);

test("B65-SV06: forbidden context の GROUPING() も static/planning 共通で拒否する", () => {
  const stmt = parseSelect(
    "SELECT GROUPING(会社名), SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名)"
  );
  // The public parser already rejects WHERE GROUPING(). Inject the dedicated
  // AST node to keep the shared validator's forbidden-context contract covered.
  stmt.where = {
    type: "GROUPING_REF",
    field: { type: "FIELD", tableAlias: null, field: "会社名" },
  } as unknown as SelectStatement["where"];
  const message =
    "ArgumentError: B65 GROUPING() is not allowed in WHERE, JOIN, window, aggregate arguments, or DML expressions.";

  expect(() => analyzeBatch([stmt])).toThrow(message);
  expect(() => validateGroupingStatic(stmt)).toThrow(message);
  expect(() => validateGroupingPlanning(stmt, resolve)).toThrow(message);
});

test.each([
  [
    "top-level",
    "SELECT DISTINCT 会社名 FROM APP1 GROUP BY ROLLUP(会社名)",
  ],
  [
    "DML SELECT source",
    "INSERT INTO APP2 (会社名) SELECT DISTINCT 会社名 FROM APP1 GROUP BY ROLLUP(会社名)",
  ],
  [
    "UNION branch",
    "SELECT 会社名 FROM APP2 UNION ALL " +
      "SELECT DISTINCT 会社名 FROM APP1 GROUP BY ROLLUP(会社名)",
  ],
  [
    "WITH CTE",
    "WITH x AS (SELECT DISTINCT 会社名 FROM APP1 GROUP BY ROLLUP(会社名)) " +
      "SELECT 会社名 FROM x",
  ],
  [
    "scalar subquery",
    "SELECT (SELECT DISTINCT 会社名 FROM APP1 GROUP BY ROLLUP(会社名)) AS x FROM APP2",
  ],
  [
    "CREATE TEMP query",
    "CREATE TEMP TABLE #x AS " +
      "SELECT DISTINCT 会社名 FROM APP1 GROUP BY ROLLUP(会社名); SELECT * FROM #x",
  ],
])("B65-SD01: analyzeBatch walker は %s の B65 DISTINCT を受理する", (_name, sql) => {
  expect(() => analyze(sql)).not.toThrow();
});

test("B65-SD02: DISTINCT + ROLLUP は analyzeBatch/static/planning で一貫して受理する", () => {
  const stmt = parseSelect(
    "SELECT DISTINCT 会社名, SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名)"
  );
  expect(() => analyzeBatch([stmt])).not.toThrow();
  expect(() => validateGroupingStatic(stmt)).not.toThrow();
  expect(() => validateGroupingPlanning(stmt, resolve)).not.toThrow();
});

test("B65-SV08: 看板 ROLLUP/GROUPING/CASE/ORDER BY は static で受理する", () => {
  expect(() => analyze(
    "SELECT CASE WHEN GROUPING(会社名)=1 THEN '合計' ELSE 会社名 END AS 会社名, " +
      "GROUPING(会社名) AS grouping_company, SUM(売上) AS 売上合計 " +
      "FROM APP1 GROUP BY ROLLUP(会社名) " +
      "ORDER BY GROUPING(会社名), 売上合計 DESC"
  )).not.toThrow();
});

test("B65-SV09: metadata 依存の membership 拒否は static では前倒ししない", () => {
  const stmt = parseSelect(
    "SELECT GROUPING(部署), SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名)"
  );

  // canonicalId membership needs resolved app/field identity. Static validation
  // must accept it and metadata-backed planning remains fail-closed.
  expect(() => analyzeBatch([stmt])).not.toThrow();
  expect(() => validateGroupingStatic(stmt)).not.toThrow();
  expect(() => validateGroupingPlanning(stmt, resolve)).toThrow(
    "reason=B65_GROUPING_ARG_NOT_ITEM"
  );
});

test("B65-H08: HAVING GROUPING は analyzeBatch/static/planning で一貫して受理する", () => {
  const stmt = parseSelect(
    "SELECT 会社名, SUM(売上) FROM APP1 GROUP BY ROLLUP(会社名) " +
    "HAVING GROUPING(会社名)=1"
  );

  expect(() => analyzeBatch([stmt])).not.toThrow();
  expect(() => validateGroupingStatic(stmt)).not.toThrow();
  expect(() => validateGroupingPlanning(stmt, resolve)).not.toThrow();
});

test("B65-H11: 通常 GROUP BY の HAVING GROUPING は static/planning とも B65 必須で拒否する", () => {
  const stmt = parseSelect(
    "SELECT 会社名, SUM(売上) FROM APP1 GROUP BY 会社名 HAVING GROUPING(会社名)=0"
  );
  const message = "ArgumentError: B65 GROUPING() requires GROUP BY ROLLUP or GROUPING SETS.";

  expect(() => analyzeBatch([stmt])).toThrow(message);
  expect(() => validateGroupingStatic(stmt)).toThrow(message);
  expect(() => validateGroupingPlanning(stmt, resolve)).toThrow(message);
});
