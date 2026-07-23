import { execute } from "../../execute";
import { runQuery } from "../query";
import type { ReadonlyKintoneClient } from "../publicTypes";
import {
  assertRunQueryStatement,
  guardExplainQuerySql,
  guardRunQuerySql,
} from "../statementGuard";

jest.mock("../../execute", () => {
  const actual = jest.requireActual("../../execute");
  return { ...actual, execute: jest.fn() };
});

const mockedExecute = execute as jest.MockedFunction<typeof execute>;

function makeClient(): ReadonlyKintoneClient {
  return {
    getRecords: async () => ({ records: [] }),
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
}

beforeEach(() => {
  mockedExecute.mockReset();
});

test.each([
  "SELECT 1 AS one",
  "SHOW APPS",
  "DESCRIBE APP1",
  "SELECT 1 AS one UNION ALL SELECT 2 AS one",
  "WITH a AS (SELECT 1 AS one), b AS (SELECT one FROM a) SELECT one FROM b",
])("runQuery recursively accepts read statement: %s", (sql) => {
  expect(() => guardRunQuerySql(sql)).not.toThrow();
});

test("WITH rejects a DML CTE body and a DML main query recursively", () => {
  const select = { type: "SELECT" };
  expect(() => assertRunQueryStatement({
    type: "WITH",
    ctes: [{ name: "unsafe", query: { type: "UPDATE" } }],
    query: select,
  })).toThrow(expect.objectContaining({ code: "READ_ONLY_VIOLATION" }));

  expect(() => assertRunQueryStatement({
    type: "WITH",
    ctes: [{ name: "safe", query: select }],
    query: { type: "DELETE" },
  })).toThrow(expect.objectContaining({ code: "READ_ONLY_VIOLATION" }));
});

test("UNION rejects either DML branch recursively", () => {
  expect(() => assertRunQueryStatement({
    type: "UNION",
    all: false,
    left: { type: "INSERT" },
    right: { type: "SELECT" },
  })).toThrow(expect.objectContaining({ code: "READ_ONLY_VIOLATION" }));

  expect(() => assertRunQueryStatement({
    type: "UNION",
    all: false,
    left: { type: "SELECT" },
    right: { type: "UPSERT" },
  })).toThrow(expect.objectContaining({ code: "READ_ONLY_VIOLATION" }));
});

test.each([
  { type: "FUTURE_READISH_VARIANT" },
  { type: "UNION", left: { type: "SELECT" }, right: { future: true } },
  { type: "WITH", ctes: [{ name: "x", future: true }], query: { type: "SELECT" } },
])("unknown or unclassifiable future AST is default-denied", (fixture) => {
  expect(() => assertRunQueryStatement(fixture)).toThrow(
    expect.objectContaining({ code: "READ_ONLY_VIOLATION" })
  );
});

test.each([
  "",
  "   ",
  "SELECT 1; SELECT 2",
  "SELECT 1 AS one unexpected token",
])("empty, multiple, or trailing-token SQL is PARSE_ERROR: %p", (sql) => {
  expect(() => guardRunQuerySql(sql)).toThrow(
    expect.objectContaining({ code: "PARSE_ERROR" })
  );
});

test.each([
  "INSERT INTO APP1 (a) VALUES (1)",
  "INSERT INTO APP1 (a) SELECT a FROM APP2",
  "UPDATE APP1 SET a = 1 WHERE $id = 1",
  "UPSERT INTO APP1 (key) VALUES ('x') ON DUPLICATE (key)",
  "DELETE FROM APP1 WHERE $id = 1",
  "REORDER APP1$rows BY code ASC WHERE _pid = 1",
  "UPDATE APP1 SET a = 1 WHERE $id = 1 APPLY rows (REMOVE ALL ROWS)",
  "IMPORT INTO APP1 (a) FROM CSV source",
  "INSERT INTO APP1 (a) VALUES (1) VALIDATE ONLY",
  "VALIDATE APP1",
  "CREATE TEMP TABLE #t AS SELECT 1",
  "DROP TEMP TABLE #t",
  "SET @value = 1",
  "DECLARE @value = 1",
  "ASSERT 1 = 1",
])("non-read statement is READ_ONLY_VIOLATION before execution: %s", (sql) => {
  expect(() => guardRunQuerySql(sql)).toThrow(
    expect.objectContaining({ code: "READ_ONLY_VIOLATION" })
  );
});

test("all parseable non-read categories stop before execute()", async () => {
  const sqlStatements = [
    "INSERT INTO APP1 (a) VALUES (1)",
    "UPDATE APP1 SET a = 1 WHERE $id = 1",
    "UPSERT INTO APP1 (key) VALUES ('x') ON DUPLICATE (key)",
    "DELETE FROM APP1 WHERE $id = 1",
    "REORDER APP1$rows BY code ASC WHERE _pid = 1",
    "UPDATE APP1 SET a = 1 WHERE $id = 1 APPLY rows (REMOVE ALL ROWS)",
    "IMPORT INTO APP1 (a) FROM CSV source",
    "INSERT INTO APP1 (a) VALUES (1) VALIDATE ONLY",
    "VALIDATE APP1",
    "CREATE TEMP TABLE #t AS SELECT 1",
    "DROP TEMP TABLE #t",
    "SET @value = 1",
    "DECLARE @value = 1",
    "ASSERT 1 = 1",
  ];

  for (const sql of sqlStatements) {
    await expect(runQuery(sql, { client: makeClient() })).rejects.toMatchObject({
      code: "READ_ONLY_VIOLATION",
    });
  }
  expect(mockedExecute).not.toHaveBeenCalled();
});

test.each([
  "EXPLAIN UPDATE APP1 SET a = 1 WHERE $id = 1",
  "EXPLAIN IMPORT INTO APP1 (a) FROM CSV source",
  "DELETE FROM APP1 WHERE $id = 1",
])("explainQuery rejects a non-read inner statement: %s", (sql) => {
  expect(() => guardExplainQuerySql(sql)).toThrow(
    expect.objectContaining({ code: "READ_ONLY_VIOLATION" })
  );
});

test("explainQuery recursively restricts WITH and UNION internals", () => {
  expect(guardExplainQuerySql(
    "EXPLAIN WITH x AS (SELECT 1 AS one) SELECT one FROM x UNION SELECT 2 AS one"
  )).toContain("EXPLAIN");
});
