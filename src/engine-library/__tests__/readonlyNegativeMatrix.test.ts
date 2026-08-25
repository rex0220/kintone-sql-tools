import { execute } from "../../execute";
import { createReadonlyKintoneClient, explainQuery, runQuery } from "../index";
import { projectReadonlyClient } from "../readonlyClient";
import { assertRunQueryStatement } from "../statementGuard";
import type { ReadonlyKintoneClient } from "../publicTypes";

jest.mock("../../execute", () => {
  const actual = jest.requireActual("../../execute");
  return { ...actual, execute: jest.fn() };
});

const mockedExecute = execute as jest.MockedFunction<typeof execute>;
const writeMethods = ["postRecords", "putRecords", "deleteRecords"] as const;

function clientWithWrites() {
  const mutations = Object.fromEntries(
    writeMethods.map((name) => [name, jest.fn(async () => undefined)])
  ) as Record<(typeof writeMethods)[number], jest.Mock>;
  const client: ReadonlyKintoneClient & typeof mutations = {
    getRecords: async () => ({
      records: [{
        $id: { value: "1" },
        a: { value: "1" },
        key: { value: "K1" },
      }],
    }),
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => [
      { code: "a", label: "a", fieldType: "NUMBER" },
      { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
    ],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    ...mutations,
  };
  return { client, mutations };
}

beforeEach(() => mockedExecute.mockReset());

test.each([
  ["INSERT", "INSERT INTO APP1 (a) VALUES (1)"],
  ["UPDATE", "UPDATE APP1 SET a = 1 WHERE $id = 1"],
  ["UPSERT", "UPSERT INTO APP1 (key) VALUES ('x') ON DUPLICATE (key)"],
  ["DELETE", "DELETE FROM APP1 WHERE $id = 1"],
  ["REORDER", "REORDER APP1$rows BY code ASC WHERE _pid = 1"],
  ["APPLY", "UPDATE APP1 SET a = 1 WHERE $id = 1 APPLY rows (REMOVE ALL ROWS)"],
  [
    "APPLY VALIDATE ONLY",
    "UPDATE APP1 SET a = 1 WHERE $id = 1 APPLY rows (REMOVE ALL ROWS) VALIDATE ONLY",
  ],
  ["IMPORT", "IMPORT INTO APP1 (a) FROM CSV source"],
  ["VALIDATE ONLY", "INSERT INTO APP1 (a) VALUES (1) VALIDATE ONLY"],
  ["CREATE TEMP", "CREATE TEMP TABLE #t AS SELECT 1"],
  ["DROP TEMP", "DROP TEMP TABLE #t"],
  ["SET", "SET @value = 1"],
  ["DECLARE", "DECLARE @value = 1"],
  ["ASSERT", "ASSERT 1 = 1"],
] as const)("%s is rejected before engine execution and mutation", async (_id, sql) => {
  const { client, mutations } = clientWithWrites();
  await expect(runQuery(sql, { client })).rejects.toMatchObject({
    code: "READ_ONLY_VIOLATION",
  });
  expect(mockedExecute).not.toHaveBeenCalled();
  for (const method of writeMethods) expect(mutations[method]).not.toHaveBeenCalled();
});

test.each([
  "EXPLAIN UPDATE APP1 SET a = 1 WHERE $id = 1",
  "EXPLAIN IMPORT INTO APP1 (a) FROM CSV source",
  // B173: native UPSERT の可視化は engine-library の対象外。B89 §6b の
  // 「EXPLAIN <DML> は両経路で拒否」をここでも固定する。
  "EXPLAIN UPSERT INTO APP1 (a) VALUES ('x') ON DUPLICATE (a)",
  "EXPLAIN UPSERT INTO APP1 (a) SELECT a FROM APP2 ON DUPLICATE (a)",
] as const)("EXPLAIN non-read is rejected before engine execution: %s", async (sql) => {
  const { client, mutations } = clientWithWrites();
  await expect(explainQuery(sql, { client })).rejects.toMatchObject({
    code: "READ_ONLY_VIOLATION",
  });
  expect(mockedExecute).not.toHaveBeenCalled();
  for (const method of writeMethods) expect(mutations[method]).not.toHaveBeenCalled();
});

test("multiple statements are rejected and future statement types default-deny", async () => {
  const { client } = clientWithWrites();
  await expect(runQuery("SELECT 1; SELECT 2", { client })).rejects.toMatchObject({
    code: "PARSE_ERROR",
  });
  expect(() => assertRunQueryStatement({ type: "FUTURE_READISH_TYPE" })).toThrow(
    expect.objectContaining({ code: "READ_ONLY_VIOLATION" })
  );
  expect(mockedExecute).not.toHaveBeenCalled();
});

test("browser original client and BYO projection expose no write methods", () => {
  const root = globalThis as unknown as {
    kintone?: {
      api: jest.Mock & {
        url: (path: string) => string;
        urlForGet: (path: string) => string;
      };
      getRequestToken: () => string;
    };
  };
  const original = root.kintone;
  const api = jest.fn(async () => ({})) as NonNullable<typeof root.kintone>["api"];
  api.url = (path) => path;
  api.urlForGet = (path) => path;
  root.kintone = { api, getRequestToken: () => "token" };
  try {
    const browser = createReadonlyKintoneClient();
    const { client } = clientWithWrites();
    const projected = projectReadonlyClient(client);
    for (const value of [browser, projected]) {
      for (const method of writeMethods) {
        expect(method in value).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(value, method)).toBe(false);
        expect(Object.getPrototypeOf(value)?.[method]).toBeUndefined();
      }
    }
  } finally {
    if (original) root.kintone = original;
    else delete root.kintone;
  }
});

test.each([
  ["postRecords", "INSERT INTO APP1 (a) VALUES (1)"],
  ["putRecords", "UPDATE APP1 SET a = 1 WHERE $id = 1"],
  ["deleteRecords", "DELETE FROM APP1 WHERE $id = 1"],
] as const)("guard bypass blocks %s cleanly with zero mutation", async (_method, sql) => {
  jest.unmock("../../execute");
  const actualExecute =
    jest.requireActual("../../execute").execute as typeof import("../../execute").execute;
  const { client, mutations } = clientWithWrites();

  await expect(actualExecute(
    sql,
    projectReadonlyClient(client),
    { cacheContext: `b66-step8-${_method}` }
  )).rejects.toMatchObject({
    name: "KsqlEngineError",
    code: "READ_ONLY_VIOLATION",
  });
  for (const method of writeMethods) expect(mutations[method]).not.toHaveBeenCalled();
});
