import { analyzeBatch, parseSqlStatements } from "../../core";
import { isDmlType } from "../../core/dmlGuard";
import { statementHasApplyBlocks } from "../../core/applyGuard";
import { createKsqlMcpTools } from "../../mcp/tools";
import {
  STATEMENT_SYNTAX_CATALOG,
  type StatementSyntaxEntry,
} from "../../mcp/statementSyntaxCatalog";
import type { Statement } from "../../types/ast";
import {
  guardRunBatchSql,
  guardRunQuerySql,
} from "../statementGuard";

type StatementType = Statement["type"];
type ParityException = "IMPORT" | "APPLY" | "DML_VALIDATE_ONLY";
type LibrarySurface = "runQuery" | "runBatch";

type CorpusCase<Type extends StatementType = StatementType> = {
  readonly sql: string;
  readonly targetIndex: number;
  readonly targetType: Type;
  readonly importSource?: {
    readonly name: string;
    readonly text: string;
  };
};

type StatementCorpus = {
  readonly [Type in StatementType]: CorpusCase<Type>;
};

/**
 * This mapped Record is the compile-time completeness gate. Adding a new
 * Statement["type"] makes this file fail to compile until the corpus is extended.
 */
const STATEMENT_CORPUS = {
  SELECT: {
    sql: "SELECT 1 AS one",
    targetIndex: 0,
    targetType: "SELECT",
  },
  UNION: {
    sql: "SELECT 1 AS n UNION ALL SELECT 2 AS n",
    targetIndex: 0,
    targetType: "UNION",
  },
  WITH: {
    sql: "WITH source AS (SELECT 1 AS n) SELECT n FROM source",
    targetIndex: 0,
    targetType: "WITH",
  },
  INSERT: {
    sql: "INSERT INTO APP1 (code) VALUES ('A') VALIDATE ONLY",
    targetIndex: 0,
    targetType: "INSERT",
  },
  INSERT_SELECT: {
    sql: "INSERT INTO APP1 (code) SELECT code FROM APP2 VALIDATE ONLY",
    targetIndex: 0,
    targetType: "INSERT_SELECT",
  },
  UPSERT: {
    sql: "UPSERT INTO APP1 (key) VALUES ('A') ON DUPLICATE (key) VALIDATE ONLY",
    targetIndex: 0,
    targetType: "UPSERT",
  },
  UPSERT_SELECT: {
    sql: "UPSERT INTO APP1 (key) SELECT key FROM APP2 ON DUPLICATE (key) VALIDATE ONLY",
    targetIndex: 0,
    targetType: "UPSERT_SELECT",
  },
  UPDATE: {
    sql: "UPDATE APP1 SET code = 'A' WHERE $id = 1 VALIDATE ONLY",
    targetIndex: 0,
    targetType: "UPDATE",
  },
  DELETE: {
    sql: "DELETE FROM APP1 WHERE $id = 1",
    targetIndex: 0,
    targetType: "DELETE",
  },
  REORDER: {
    sql: "REORDER APP1$details BY item ASC WHERE _pid = 1",
    targetIndex: 0,
    targetType: "REORDER",
  },
  VALIDATE: {
    sql: "VALIDATE APP1",
    targetIndex: 0,
    targetType: "VALIDATE",
  },
  SHOW_APPS: {
    sql: "SHOW APPS",
    targetIndex: 0,
    targetType: "SHOW_APPS",
  },
  DESCRIBE: {
    sql: "DESCRIBE APP1",
    targetIndex: 0,
    targetType: "DESCRIBE",
  },
  EXPLAIN: {
    sql: "EXPLAIN SELECT 1 AS one",
    targetIndex: 0,
    targetType: "EXPLAIN",
  },
  CREATE_TEMP_TABLE: {
    sql: "CREATE TEMP TABLE #source AS SELECT 1 AS n; SELECT n FROM #source",
    targetIndex: 0,
    targetType: "CREATE_TEMP_TABLE",
  },
  DROP_TEMP_TABLE: {
    sql: "CREATE TEMP TABLE #source AS SELECT 1 AS n; DROP TEMP TABLE #source; SELECT 1 AS one",
    targetIndex: 1,
    targetType: "DROP_TEMP_TABLE",
  },
  SET_VARIABLE: {
    sql: "SET @value = 1; SELECT @value AS value",
    targetIndex: 0,
    targetType: "SET_VARIABLE",
  },
  DECLARE_VARIABLE: {
    sql: "DECLARE @value = 1; SELECT @value AS value",
    targetIndex: 0,
    targetType: "DECLARE_VARIABLE",
  },
  ASSERT: {
    sql: "ASSERT 1 = 1",
    targetIndex: 0,
    targetType: "ASSERT",
  },
  IMPORT: {
    sql: "IMPORT INTO APP1 (code) FROM CSV source VALIDATE ONLY",
    targetIndex: 0,
    targetType: "IMPORT",
    importSource: { name: "source", text: "code\nA\n" },
  },
} satisfies StatementCorpus;

/**
 * This is the stronger surface-routing contract layered on top of syntax
 * parity. Row-returning single statements must remain accepted by runQuery;
 * batch-scoped/non-row-returning read statements must remain accepted by
 * runBatch. null means that this corpus case is intentionally accepted by
 * neither read-only library surface.
 *
 * The Record makes adding a Statement["type"] a compile error until its
 * designated library surface (or deliberate lack of one) is decided.
 */
const EXPECTED_LIBRARY_SURFACE = {
  SELECT: "runQuery",
  UNION: "runQuery",
  WITH: "runQuery",
  INSERT: null,
  INSERT_SELECT: null,
  UPSERT: null,
  UPSERT_SELECT: null,
  UPDATE: null,
  DELETE: null,
  REORDER: null,
  VALIDATE: "runQuery",
  SHOW_APPS: "runQuery",
  DESCRIBE: "runQuery",
  EXPLAIN: "runBatch",
  CREATE_TEMP_TABLE: "runBatch",
  DROP_TEMP_TABLE: "runBatch",
  SET_VARIABLE: "runBatch",
  DECLARE_VARIABLE: "runBatch",
  ASSERT: "runBatch",
  IMPORT: null,
} satisfies Record<StatementType, LibrarySurface | null>;

const APPLY_CASE: CorpusCase<"UPDATE"> = {
  sql: "UPDATE APP1 SET code = 'A' WHERE $id = 1 "
    + "APPLY details (REMOVE ALL ROWS) VALIDATE ONLY",
  targetIndex: 0,
  targetType: "UPDATE",
};

const EXCEPTION_REASONS = {
  // IMPORT requires an inline source on MCP and is intentionally disabled by
  // default in the library; it is a write-oriented ingestion workflow.
  IMPORT: "inline source ingestion is outside the default library boundary",
  // APPLY reaches the read-only classifier through VALIDATE ONLY, but it
  // describes mutations around a write workflow and has a separate surface gate.
  APPLY: "APPLY is mutation planning around a write workflow",
  // DML VALIDATE ONLY validates a prospective write and returns the separate
  // DmlValidationResult shape, not the row-query contract exposed by the library.
  DML_VALIDATE_ONLY: "prospective write validation has a non-query result shape",
} satisfies Record<ParityException, string>;

function parseCase(entry: CorpusCase): Statement[] {
  return parseSqlStatements(
    entry.sql,
    entry.importSource === undefined ? undefined : { import: true }
  );
}

function parityException(statement: Statement): ParityException | null {
  if (statement.type === "IMPORT") return "IMPORT";
  if (statementHasApplyBlocks(statement)) return "APPLY";
  if (
    isDmlType(statement.type)
    && "validateOnly" in statement
    && statement.validateOnly === true
  ) {
    return "DML_VALIDATE_ONLY";
  }
  return null;
}

function libraryAccepts(sql: string): boolean {
  try {
    guardRunQuerySql(sql);
    return true;
  } catch {
    try {
      guardRunBatchSql(sql);
      return true;
    } catch {
      return false;
    }
  }
}

function librarySurfaceAccepts(surface: LibrarySurface, sql: string): boolean {
  try {
    if (surface === "runQuery") {
      guardRunQuerySql(sql);
    } else {
      guardRunBatchSql(sql);
    }
    return true;
  } catch {
    return false;
  }
}

describe("B68 Step 4 MCP READ / engine-library syntax parity", () => {
  test("Record<Statement['type'], ...> corpus parses to the keyed AST type", () => {
    for (const [type, entry] of Object.entries(STATEMENT_CORPUS) as [
      StatementType,
      CorpusCase,
    ][]) {
      const statements = parseCase(entry);
      expect(statements[entry.targetIndex]?.type).toBe(type);
      expect(entry.targetType).toBe(type);
    }
  });

  test("catalog-derived AST types match the exhaustive corpus except the tracked UPSERT_SELECT example gap", () => {
    const corpusTypes = new Set(Object.keys(STATEMENT_CORPUS) as StatementType[]);
    const catalogTypes = new Set(
      (Object.values(STATEMENT_SYNTAX_CATALOG) as StatementSyntaxEntry[])
        .flatMap((entry) => entry.expectedTypes)
        .flat()
    );
    const missingFromCatalog = [...corpusTypes]
      .filter((type) => !catalogTypes.has(type))
      .sort();
    const unknownToCorpus = [...catalogTypes]
      .filter((type) => !corpusTypes.has(type as StatementType))
      .sort();

    // B68 Step 4 deliberately does not add the missing UPSERT_SELECT catalog
    // example. Keeping the exact singleton here makes any other drift fail.
    expect(missingFromCatalog).toEqual(["UPSERT_SELECT"]);
    expect(unknownToCorpus).toEqual([]);
  });

  test("every statement type remains accepted by its designated runQuery/runBatch surface", () => {
    for (const [type, expectedSurface] of Object.entries(
      EXPECTED_LIBRARY_SURFACE
    ) as [StatementType, LibrarySurface | null][]) {
      const entry = STATEMENT_CORPUS[type];
      const statements = parseCase(entry);
      expect(statements[entry.targetIndex]?.type).toBe(type);

      if (expectedSurface === null) {
        expect(librarySurfaceAccepts("runQuery", entry.sql)).toBe(false);
        expect(librarySurfaceAccepts("runBatch", entry.sql)).toBe(false);
        continue;
      }

      expect({
        type,
        expectedSurface,
        accepted: librarySurfaceAccepts(expectedSurface, entry.sql),
      }).toEqual({
        type,
        expectedSurface,
        accepted: true,
      });
    }
  });

  test("every MCP read-only acceptance is accepted by runQuery/runBatch or one of exactly three write-oriented exceptions", async () => {
    const tools = createKsqlMcpTools({ profile: "test" });
    const cases: readonly CorpusCase[] = [
      ...Object.values(STATEMENT_CORPUS),
      APPLY_CASE,
    ];
    const observedExceptions = new Set<ParityException>();

    for (const entry of cases) {
      const statements = parseCase(entry);
      const target = statements[entry.targetIndex];
      expect(target.type).toBe(entry.targetType);

      const validation = await tools.validate({
        sql: entry.sql,
        ...(entry.importSource === undefined
          ? {}
          : { importSources: [entry.importSource] }),
      });
      const mcpAcceptsAsReadOnly = validation.canRunWithQueryTool;
      const acceptedByLibrary = libraryAccepts(entry.sql);
      const exception = parityException(target);

      if (mcpAcceptsAsReadOnly && !acceptedByLibrary) {
        expect(exception).not.toBeNull();
        observedExceptions.add(exception!);
      } else {
        expect(acceptedByLibrary).toBe(mcpAcceptsAsReadOnly);
        expect(exception).toBeNull();
      }
    }

    expect([...observedExceptions].sort()).toEqual(
      Object.keys(EXCEPTION_REASONS).sort()
    );
  });

  test("SEARCH_ABORTED remains an execution-result policy, not a syntax-parity exception", () => {
    // A SELECT is accepted syntactically on both surfaces. Whether an eventual
    // records response carries searchAborted is a separate execution axis:
    // engine-library boundaryErrors/searchAbort/batch tests keep it a hard
    // SEARCH_ABORTED error while the interactive surfaces retain their policy.
    expect(libraryAccepts("SELECT code FROM APP1")).toBe(true);
    expect(Object.keys(EXCEPTION_REASONS)).toEqual([
      "IMPORT",
      "APPLY",
      "DML_VALIDATE_ONLY",
    ]);
  });
});
