import type { Statement } from "../../types/ast";
import {
  explainQuery,
  KsqlEngineError,
  runBatch,
  type ReadonlyKintoneClient,
} from "../index";
import { guardRunBatchSql } from "../statementGuard";

type StatementType = Statement["type"];

function trackedClient(): {
  client: ReadonlyKintoneClient;
  apiCalls: readonly jest.Mock[];
  getRecords: jest.Mock;
} {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const openCursor = jest.fn(async () => ({
    totalCount: 0,
    nextPage: async () => ({ records: [], next: false }),
    close: async () => undefined,
  }));
  const getApps = jest.fn(async () => []);
  const getFields = jest.fn(async () => []);
  const getNumberPrecision = jest.fn(async () => ({
    digits: 30,
    decimalPlaces: 10,
    roundingMode: "HALF_EVEN" as const,
  }));
  const getProcessStatuses = jest.fn(async () => ({
    enable: false,
    states: [],
  }));
  return {
    client: {
      getRecords,
      openCursor,
      getApps,
      getFields,
      getNumberPrecision,
      getProcessStatuses,
    },
    apiCalls: [
      getRecords,
      openCursor,
      getApps,
      getFields,
      getNumberPrecision,
      getProcessStatuses,
    ],
    getRecords,
  };
}

test("Pro batch is explained statement-by-statement without reading records", async () => {
  const tracked = trackedClient();
  const result = await explainQuery(
    "CREATE TEMP TABLE #g AS SELECT 1 AS n; " +
      "SET @total = (SELECT COUNT(*) FROM #g); " +
      "SELECT n, @total AS total FROM #g",
    { client: tracked.client }
  );

  expect(result.lines.filter((line) => /^\[\d+\] /.test(line))).toEqual([
    "[1] CREATE_TEMP_TABLE",
    "[2] SET_VARIABLE",
    "[3] SELECT",
  ]);
  expect(result.text).toBe(result.lines.join("\n"));
  expect(tracked.getRecords).not.toHaveBeenCalled();
});

test.each([
  ["direct arithmetic", "(顧客No * 100) / @total AS 構成比"],
  ["ROUND", "ROUND(顧客No * 100 / @total, 1) AS 構成比"],
] as const)(
  "B92: explainQuery accepts Pro batch %s with the existing expression-free temp plan",
  async (_label, expression) => {
    const tracked = trackedClient();
    const result = await explainQuery(
      "CREATE TEMP TABLE #g AS SELECT 案件No, 顧客No FROM APP4147; " +
        "SET @total = (SELECT SUM(顧客No) FROM #g); " +
        `SELECT 案件No, ${expression} FROM #g`,
      { client: tracked.client }
    );

    expect(result.lines.slice(-7)).toEqual([
      "  mode:          FULL_SCAN（一時テーブル参照）",
      "  temp:          #g（インメモリ走査。実体化前のため行数不明）",
      "  source:        temp table #g (schema from statement 1)",
      "  rows:          runtime (not materialized by EXPLAIN)",
      "  plan status:   static schema / runtime rows",
      "  records API:   none",
      "  note:          一時テーブルへの WHERE プッシュダウンは行われない",
    ]);
    expect(tracked.getRecords).not.toHaveBeenCalled();
  }
);

test.each([
  ["direct arithmetic", "SELECT 100 / @phase AS x"],
  ["ROUND", "SELECT ROUND(100 / @phase, 1) AS x"],
] as const)(
  "B92: runBatch keeps B90 non-numeric runtime fail-closed for %s",
  async (_label, selectSql) => {
    const tracked = trackedClient();
    await expect(runBatch(
      `DECLARE @phase = '受注'; ${selectSql}`,
      { client: tracked.client }
    )).rejects.toMatchObject({
      code: "EXECUTION_ERROR",
      message: "ArgumentError: variable @phase is not numeric and cannot be used in arithmetic.",
      statementIndex: 1,
      statementType: "SELECT",
    });
    for (const api of tracked.apiCalls) expect(api).not.toHaveBeenCalled();
  }
);

test("legacy single-query explain output remains byte-for-byte identical", async () => {
  const tracked = trackedClient();
  const plain = await explainQuery("SELECT 1 AS one", { client: tracked.client });
  const explicit = await explainQuery("EXPLAIN SELECT 1 AS one", {
    client: tracked.client,
  });

  expect(plain.lines).toEqual(explicit.lines);
  expect(plain.text).toBe(explicit.text);
  expect(plain.lines.some((line) => /^\[\d+\] /.test(line))).toBe(false);
});

test.each([
  ["VALIDATE", "VALIDATE APP1"],
  ["SHOW_APPS", "SHOW APPS"],
  ["DESCRIBE", "DESCRIBE APP1"],
  ["ASSERT", "ASSERT 1 = 1"],
] as const)(
  "newly accepted single %s uses batch planning without a statement prefix",
  async (_type, sql) => {
    const tracked = trackedClient();
    const result = await explainQuery(sql, { client: tracked.client });
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.some((line) => /^\[\d+\] /.test(line))).toBe(false);
    expect(tracked.getRecords).not.toHaveBeenCalled();
  }
);

test.each([
  ["SET_VARIABLE", "SET @value = 1"],
  ["DECLARE_VARIABLE", "DECLARE @value = 1"],
  ["CREATE_TEMP_TABLE", "CREATE TEMP TABLE #t AS SELECT 1 AS n"],
  ["DROP_TEMP_TABLE", "DROP TEMP TABLE #t"],
] as const)(
  "single %s is rejected by explainQuery and runBatch with the same analysis error",
  async (_type, sql) => {
    const tracked = trackedClient();
    const failures: KsqlEngineError[] = [];
    for (const invoke of [
      () => explainQuery(sql, { client: tracked.client }),
      () => runBatch(sql, { client: tracked.client }),
    ]) {
      try {
        await invoke();
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(KsqlEngineError);
        failures.push(error as KsqlEngineError);
      }
    }
    expect(failures[0]).toMatchObject({
      code: failures[1].code,
      message: failures[1].message,
      statementIndex: 0,
      statementType: _type,
    });
    for (const api of tracked.apiCalls) expect(api).not.toHaveBeenCalled();
  }
);

type ParityCase = {
  sql: string;
  accepted: boolean;
};

const EXPLAIN_PARITY = {
  SELECT: { sql: "SELECT 1 AS one", accepted: true },
  UNION: {
    sql: "SELECT 1 AS n UNION ALL SELECT 2 AS n",
    accepted: true,
  },
  WITH: {
    sql: "WITH source AS (SELECT 1 AS n) SELECT n FROM source",
    accepted: true,
  },
  INSERT: {
    sql: "INSERT INTO APP1 (code) VALUES ('A') VALIDATE ONLY",
    accepted: false,
  },
  INSERT_SELECT: {
    sql: "INSERT INTO APP1 (code) SELECT code FROM APP2 VALIDATE ONLY",
    accepted: false,
  },
  UPSERT: {
    sql: "UPSERT INTO APP1 (key) VALUES ('A') ON DUPLICATE (key) VALIDATE ONLY",
    accepted: false,
  },
  UPSERT_SELECT: {
    sql: "UPSERT INTO APP1 (key) SELECT key FROM APP2 ON DUPLICATE (key) VALIDATE ONLY",
    accepted: false,
  },
  UPDATE: {
    sql: "UPDATE APP1 SET code = 'A' WHERE $id = 1 VALIDATE ONLY",
    accepted: false,
  },
  DELETE: {
    sql: "DELETE FROM APP1 WHERE $id = 1",
    accepted: false,
  },
  REORDER: {
    sql: "REORDER APP1$details BY item ASC WHERE _pid = 1",
    accepted: false,
  },
  VALIDATE: { sql: "VALIDATE APP1", accepted: true },
  SHOW_APPS: { sql: "SHOW APPS", accepted: true },
  DESCRIBE: { sql: "DESCRIBE APP1", accepted: true },
  EXPLAIN: { sql: "EXPLAIN SELECT 1 AS one", accepted: true },
  CREATE_TEMP_TABLE: {
    sql: "CREATE TEMP TABLE #source AS SELECT 1 AS n; SELECT n FROM #source",
    accepted: true,
  },
  DROP_TEMP_TABLE: {
    sql: "CREATE TEMP TABLE #source AS SELECT 1 AS n; DROP TEMP TABLE #source",
    accepted: true,
  },
  SET_VARIABLE: {
    sql: "SET @value = 1; SELECT @value AS value",
    accepted: true,
  },
  DECLARE_VARIABLE: {
    sql: "DECLARE @value = 1; SELECT @value AS value",
    accepted: true,
  },
  ASSERT: { sql: "ASSERT 1 = 1", accepted: true },
  EXIT: { sql: "EXIT SUCCESS IF 1 = 1, 'done'", accepted: false },
  IMPORT: {
    sql: "IMPORT INTO APP1 (code) FROM CSV source VALIDATE ONLY",
    accepted: false,
  },
} satisfies Record<StatementType, ParityCase>;

test("explainQuery and runBatch have exhaustive Statement type acceptance parity", async () => {
  for (const [type, entry] of Object.entries(EXPLAIN_PARITY) as [
    StatementType,
    ParityCase,
  ][]) {
    const tracked = trackedClient();
    const outcomes: boolean[] = [];
    for (const invoke of [
      () => explainQuery(entry.sql, { client: tracked.client }),
      () => runBatch(entry.sql, { client: tracked.client }),
    ]) {
      try {
        await invoke();
        outcomes.push(true);
      } catch {
        outcomes.push(false);
      }
    }
    expect({ type, outcomes }).toEqual({
      type,
      outcomes: [entry.accepted, entry.accepted],
    });
  }
});

test.each(["explainQuery", "runBatch"] as const)(
  "%s exposes the second statement for a static batch-analysis failure",
  async (surface) => {
    const tracked = trackedClient();
    const sql = "SELECT 1 AS one; SELECT @missing AS missing";
    const rejection = surface === "explainQuery"
      ? explainQuery(sql, { client: tracked.client })
      : runBatch(sql, { client: tracked.client });

    await expect(rejection).rejects.toMatchObject({
      code: "EXECUTION_ERROR",
      statementIndex: 1,
      statementType: "SELECT",
    });
    for (const api of tracked.apiCalls) expect(api).not.toHaveBeenCalled();
  }
);

test.each([
  "IMPORT INTO APP1 (code) FROM CSV source VALIDATE ONLY; SELECT 1 AS one",
  "UPDATE APP1 SET code = 'A' WHERE $id = 1 APPLY details (REMOVE ALL ROWS) VALIDATE ONLY; SELECT 1 AS one",
  "DELETE FROM APP1 WHERE $id = 1; SELECT 1 AS one",
] as const)(
  "write-oriented batch is rejected before every API call: %s",
  async (sql) => {
    const tracked = trackedClient();
    await expect(explainQuery(sql, { client: tracked.client })).rejects.toMatchObject({
      code: "READ_ONLY_VIOLATION",
    });
    for (const api of tracked.apiCalls) expect(api).not.toHaveBeenCalled();
  }
);

test.each(["explainQuery", "runBatch"] as const)(
  "%s continues to accept EXPLAIN SELECT",
  async (surface) => {
    const tracked = trackedClient();
    const sql = "EXPLAIN SELECT 1 AS one";
    const result = surface === "explainQuery"
      ? await explainQuery(sql, { client: tracked.client })
      : await runBatch(sql, { client: tracked.client });

    expect(result.type).toBe(surface === "explainQuery" ? "explain" : "batch");
    expect(tracked.getRecords).not.toHaveBeenCalled();
  }
);

test.each([
  ["UPDATE", "EXPLAIN UPDATE APP1 SET code = 'A' WHERE $id = 1"],
  ["DELETE", "EXPLAIN DELETE FROM APP1 WHERE $id = 1"],
  ["INSERT", "EXPLAIN INSERT INTO APP1 (code) VALUES ('A')"],
  ["UPSERT", "EXPLAIN UPSERT INTO APP1 (key) VALUES ('A') ON DUPLICATE (key)"],
  [
    "APPLY",
    "EXPLAIN UPDATE APP1 SET code = 'A' WHERE $id = 1 APPLY details (REMOVE ALL ROWS) VALIDATE ONLY",
  ],
] as const)(
  "EXPLAIN %s is rejected by explainQuery and runBatch before every API call",
  async (_type, sql) => {
    const tracked = trackedClient();
    for (const invoke of [
      () => explainQuery(sql, { client: tracked.client }),
      () => runBatch(sql, { client: tracked.client }),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: "READ_ONLY_VIOLATION",
      });
    }
    for (const api of tracked.apiCalls) expect(api).not.toHaveBeenCalled();
  }
);

test("the shared batch guard unwraps EXPLAIN before checking APPLY", () => {
  expect(() =>
    guardRunBatchSql(
      "EXPLAIN UPDATE APP1 SET code = 'A' WHERE $id = 1 " +
        "APPLY details (REMOVE ALL ROWS) VALIDATE ONLY"
    )
  ).toThrow(expect.objectContaining({
    code: "READ_ONLY_VIOLATION",
    message: "APPLY statements are not allowed in engine library batches",
  }));
});
