import { execute, type KintoneClient } from "../../../execute";
import * as evalWhereModule from "../../../engine/evalWhere";
import { planKorder } from "../korderPlanner";
import { parseSqlStatement } from "../../sql";
import { resolveFieldSemantics } from "../../fieldSemantics";
import type { SelectStatement } from "../../../types/ast";

function makeClient(cursorError?: Error) {
  const calls = {
    records: jest.fn(async (_params: Parameters<KintoneClient["getRecords"]>[0]) => ({ records: [] })),
    cursorOpen: jest.fn(async (_params: Parameters<KintoneClient["openCursor"]>[0]) => {
      if (cursorError) throw cursorError;
      return {
        totalCount: 0,
        nextPage: jest.fn(async () => ({ records: [], next: false })),
        close: jest.fn(async () => undefined),
      };
    }),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: async () => ({ ids: [] }),
    putRecords: async () => undefined,
    deleteRecords: async () => undefined,
    getApps: async () => [],
    getFields: async () => [
      { code: "日付", label: "日付", fieldType: "DATE" },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ],
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    getNumberPrecision: async () => ({
      digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN",
    }),
  };
  return { client, calls };
}

function wherePrefix(query: string): string {
  return query.split(" order by ")[0];
}

test("KORDER_NATIVE と KORDER_CURSOR は同じ relative-date WHERE byte を使い client 評価しない", async () => {
  const native = makeClient();
  const cursor = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  await execute(
    "SELECT 日付 FROM APP100 WHERE 日付 >= FROM_TODAY(-7, DAYS) KORDER BY $id LIMIT 10",
    native.client
  );
  await execute(
    "SELECT 日付 FROM APP100 WHERE 日付 >= FROM_TODAY(-7, DAYS) KORDER BY $id LIMIT 501",
    cursor.client,
    { maxRecords: 1000 }
  );

  const nativeQuery = native.calls.records.mock.calls[0][0].query;
  const cursorQuery = cursor.calls.cursorOpen.mock.calls[0][0].query;
  expect(nativeQuery)
    .toBe("日付 >= FROM_TODAY(-7, DAYS) order by $id asc limit 10");
  expect(cursorQuery)
    .toBe("日付 >= FROM_TODAY(-7, DAYS) order by $id asc");
  expect(wherePrefix(nativeQuery)).toBe("日付 >= FROM_TODAY(-7, DAYS)");
  expect(wherePrefix(cursorQuery)).toBe(wherePrefix(nativeQuery));
  expect(evaluator).not.toHaveBeenCalled();
  evaluator.mockRestore();
});

test("Cursor error でも records/client fallback は0", async () => {
  const { client, calls } = makeClient(new Error("cursor failed"));
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  await expect(execute(
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() KORDER BY $id LIMIT 501",
    client,
    { maxRecords: 1000 }
  )).rejects.toThrow("cursor failed");
  expect(calls.records).not.toHaveBeenCalled();
  expect(evaluator).not.toHaveBeenCalled();
  evaluator.mockRestore();
});

test("planKorder の非exact診断は B67 reason を KORDER_WHERE_NOT_EXACT より先に保持する", () => {
  const stmt = parseSqlStatement(
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() KORDER BY $id LIMIT 10"
  ) as SelectStatement;
  expect(() => planKorder({
    stmt,
    staticMode: "FULL_SCAN",
    whereCapability: "UNSUPPORTED",
    whereReasons: [{
      code: "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED",
      functionName: "YESTERDAY",
      field: "日付",
      fieldType: "NUMBER",
      operator: "=",
    }],
    orderSemantics: new Map([["$id", resolveFieldSemantics({ fieldType: "__ID__" })]]),
    maxRecords: 1000,
    hasKlike: false,
  })).toThrow(
    /WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED, KORDER_WHERE_NOT_EXACT/
  );
});
