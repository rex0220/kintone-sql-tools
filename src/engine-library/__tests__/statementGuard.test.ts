import { execute } from "../../execute";
import { KlikeValidationError } from "../../core/klikeValidation";
import { KsqlEngineError } from "../errors";
import { runQuery } from "../query";
import type { ReadonlyKintoneClient } from "../publicTypes";
import {
  assertRunQueryStatement,
  guardExplainQuerySql,
  guardRunQuerySql,
  normalizeParseBoundaryError,
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

function makeTrackedClient(): {
  readonly client: ReadonlyKintoneClient;
  readonly apiMethods: readonly jest.Mock[];
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
  const getProcessStatuses = jest.fn(async () => ({ enable: false, states: [] }));
  return {
    client: {
      getRecords,
      openCursor,
      getApps,
      getFields,
      getNumberPrecision,
      getProcessStatuses,
    },
    apiMethods: [
      getRecords,
      openCursor,
      getApps,
      getFields,
      getNumberPrecision,
      getProcessStatuses,
    ],
  };
}

beforeEach(() => {
  mockedExecute.mockReset();
});

test.each([
  "SELECT 1 AS one",
  "SHOW APPS",
  "DESCRIBE APP1",
  "VALIDATE APP1",
  "SELECT 1 AS one UNION ALL SELECT 2 AS one",
  "WITH a AS (SELECT 1 AS one), b AS (SELECT one FROM a) SELECT one FROM b",
])("runQuery recursively accepts read statement: %s", (sql) => {
  expect(() => guardRunQuerySql(sql)).not.toThrow();
});

test.each([
  { type: "FUTURE_READISH_VARIANT" },
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
  "UPDATE APP1 SET a = 1 WHERE $id = 1 APPLY rows (REMOVE ALL ROWS) VALIDATE ONLY",
  "IMPORT INTO APP1 (a) FROM CSV source",
  "INSERT INTO APP1 (a) VALUES (1) VALIDATE ONLY",
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
    "UPDATE APP1 SET a = 1 WHERE $id = 1 APPLY rows (REMOVE ALL ROWS) VALIDATE ONLY",
    "IMPORT INTO APP1 (a) FROM CSV source",
    "INSERT INTO APP1 (a) VALUES (1) VALIDATE ONLY",
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

test("parse boundary allowlists KlikeValidationError by class and preserves cause identity", () => {
  const cause = new KlikeValidationError("known validation reason");
  const mapped = normalizeParseBoundaryError(cause);

  expect(mapped).toBeInstanceOf(KsqlEngineError);
  expect(mapped).toMatchObject({
    name: "KsqlEngineError",
    code: "PARSE_ERROR",
    message: cause.message,
  });
  expect(mapped.cause).toBe(cause);
});

test.each([
  ["unknown Error", new Error("secret sentinel")],
  [
    "name-only ArgumentError impostor",
    Object.assign(new Error("impostor sentinel"), { name: "ArgumentError" }),
  ],
] as const)("%s remains hidden at the parse boundary", (_label, cause) => {
  const mapped = normalizeParseBoundaryError(cause);
  expect(mapped).toMatchObject({
    name: "KsqlEngineError",
    code: "PARSE_ERROR",
    message: "SQL statement could not be parsed",
  });
  expect(mapped.cause).toBe(cause);
});

const KLIKE_BOUNDARY_CASES = [
  [
    "FULL_SCAN pushdown",
    "SELECT DISTINCT 件名 FROM APP100 WHERE 件名 KLIKE '至急' OR 種別 = 'A'",
    "FULL_SCAN の KLIKE / NOT KLIKE は、物理テーブルに対する AND リーフとして必ず押し下げられる必要があります。OR / NOT 配下、CTE・一時テーブル、LEFT / RIGHT JOIN では使用できません",
  ],
  [
    "subtable UPDATE",
    "UPDATE APP100$明細 SET 商品名 = 'x' WHERE 商品名 KLIKE '至急'",
    "KLIKE / NOT KLIKE はサブテーブル UPDATE の WHERE では使用できません",
  ],
  [
    "parent UPDATE outside allowed WHERE",
    "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急' CHECK WHEN 備考 KLIKE '危険' THEN 'bad' VALIDATE ONLY",
    "KLIKE / NOT KLIKE は通常親 UPDATE の WHERE、または APPLY 複数親 UPDATE の安全な親 WHERE だけで使用できます",
  ],
  [
    "subtable DELETE",
    "DELETE FROM APP100$明細 WHERE 商品名 NOT KLIKE '至急'",
    "KLIKE / NOT KLIKE はサブテーブル DELETE の WHERE では使用できません",
  ],
  [
    "parent DELETE outside allowed WHERE",
    "DELETE FROM APP100 WHERE $id IN (SELECT $id FROM APP200 WHERE 件名 KLIKE '至急')",
    "KLIKE / NOT KLIKE は通常親 DELETE の WHERE だけで使用できます",
  ],
  [
    "INSERT / INSERT SELECT",
    "INSERT INTO APP100 (件名) SELECT 件名 FROM APP200 WHERE 件名 KLIKE '至急'",
    "KLIKE / NOT KLIKE は INSERT / INSERT SELECT では使用できません",
  ],
  [
    "UPSERT / UPSERT SELECT",
    "UPSERT INTO APP100 (件名) SELECT 件名 FROM APP200 WHERE 件名 KLIKE '至急' ON DUPLICATE (件名)",
    "KLIKE / NOT KLIKE は UPSERT / UPSERT SELECT では使用できません",
  ],
  [
    "subtable REORDER",
    "REORDER APP100$明細 BY 商品名 WHERE _rid = '1' AND 商品名 KLIKE '至急'",
    "KLIKE / NOT KLIKE はサブテーブル REORDER の WHERE では使用できません",
  ],
  [
    "VALIDATE WHERE / CHECK",
    "VALIDATE APP100 WHERE 件名 KLIKE '至急'",
    "KLIKE / NOT KLIKE は VALIDATE の WHERE / CHECK で使用できません",
  ],
  [
    "percent in KLIKE search term",
    "SELECT * FROM APP100 WHERE 件名 KLIKE 'A%B'",
    "KLIKE / NOT KLIKE の検索語に % は使用できません。SQL ワイルドカード検索には LIKE を使用してください",
  ],
  [
    "SELECT outside WHERE",
    "SELECT CASE WHEN 件名 KLIKE '至急' THEN 'Y' ELSE 'N' END AS flag FROM APP100",
    "KLIKE / NOT KLIKE は SELECT の WHERE 句でのみ使用できます",
  ],
] as const;

test.each(KLIKE_BOUNDARY_CASES)(
  "runQuery preserves the KLIKE reason and boundary contract: %s",
  async (_label, sql, reason) => {
    const { client, apiMethods } = makeTrackedClient();
    let error: unknown;
    try {
      await runQuery(sql, { client });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(KsqlEngineError);
    expect(error).toMatchObject({
      name: "KsqlEngineError",
      code: "PARSE_ERROR",
      message: `ArgumentError: ${reason}`,
    });
    const cause = (error as KsqlEngineError).cause;
    expect(cause).toBeInstanceOf(KlikeValidationError);
    expect((cause as KlikeValidationError).name).toBe("ArgumentError");
    expect((error as KsqlEngineError).message).toBe((cause as KlikeValidationError).message);
    expect(mockedExecute).not.toHaveBeenCalled();
    for (const apiMethod of apiMethods) expect(apiMethod).not.toHaveBeenCalled();
  }
);
