import {
  execute,
  executeBatch,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import * as evalWhereModule from "../engine/evalWhere";

function makeClient() {
  const cursorGet = jest.fn(async () => ({ records: [], next: false }));
  const cursorDelete = jest.fn(async () => undefined);
  const source = {
    $id: { value: "1" },
    日付: { value: "2026-07-25" },
  } as KintoneRecord;
  const calls = {
    records: jest.fn(async (params: Parameters<KintoneClient["getRecords"]>[0]) => ({
      records: [Object.fromEntries(
        (params.fields ?? []).flatMap((code) =>
          source[code] === undefined ? [] : [[code, source[code]]]
        )
      ) as KintoneRecord],
    })),
    cursorOpen: jest.fn(async (_params: Parameters<KintoneClient["openCursor"]>[0]) => ({
      totalCount: 0,
      nextPage: cursorGet,
      close: cursorDelete,
    })),
    cursorGet,
    cursorDelete,
    post: jest.fn(async (_params: Parameters<KintoneClient["postRecords"]>[0]) => ({ ids: [] })),
    put: jest.fn(async (_params: Parameters<KintoneClient["putRecords"]>[0]) => undefined),
    delete: jest.fn(async (_params: Parameters<KintoneClient["deleteRecords"]>[0]) => undefined),
    confirm: jest.fn(async () => true),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    getApps: async () => [],
    getFields: async () => [
      { code: "日付", label: "日付", fieldType: "DATE" },
      { code: "日時", label: "日時", fieldType: "DATETIME" },
      { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
      { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
      { code: "状態", label: "状態", fieldType: "SINGLE_LINE_TEXT" },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
      { code: "金額", label: "金額", fieldType: "NUMBER" },
      { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
      { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "テーブル" },
    ],
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
  };
  return { client, calls };
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]) {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.cursorGet).not.toHaveBeenCalled();
  expect(calls.cursorDelete).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
}

test.each([
  ["unsupported field type", "SELECT 件名 FROM APP100 WHERE 件名 = YESTERDAY()"],
  [
    "nonexact KORDER",
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() AND LENGTH(件名) > 1 "
    + "KORDER BY $id LIMIT 10",
  ],
  ["existing VALIDATE", "VALIDATE APP100 WHERE 日付 = YESTERDAY()"],
  ["subtable UPDATE", "UPDATE APP100$テーブル SET 子 = 'x' WHERE 日付 = YESTERDAY()"],
  ["subtable DELETE", "DELETE FROM APP100$テーブル WHERE 日付 = YESTERDAY()"],
  [
    "UPDATE FROM",
    "UPDATE APP100 SET 状態 = s.状態 FROM APP200 AS s "
    + "WHERE APP100.$id = s.$id AND 日付 = YESTERDAY()",
  ],
  [
    "APPLY parent selection",
    "UPDATE APP100 SET 状態='x' WHERE 日付=YESTERDAY() "
    + "APPLY テーブル (PATCH SET 子='x' ALL ROWS)",
  ],
  [
    "APPLY child selector",
    "UPDATE APP100 SET 状態='x' WHERE $id=1 "
    + "APPLY テーブル (PATCH SET 子='x' WHERE 子=YESTERDAY())",
  ],
  ["REORDER", "REORDER APP100$テーブル BY 子 WHERE 日付 = YESTERDAY()"],
])("%s は metadata 以外の API と confirm の前に拒否する", async (_label, sql) => {
  const { client, calls } = makeClient();
  await expect(execute(sql, client, { confirm: calls.confirm }))
    .rejects.toThrow(/YESTERDAY: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
  expectNoExecutionApi(calls);
});

test("JOIN exact leaf は第5-L fetchでrowsを返しclient evaluator 0", async () => {
  const { client, calls } = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  const result = await execute(
    "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
      + "WHERE a.日付 = YESTERDAY()",
    client,
    { confirm: calls.confirm }
  ) as SelectResult;

  expect(result.rows).toEqual([{ 日付: "2026-07-25" }]);
  expect(evaluator).not.toHaveBeenCalled();
  expect(calls.records).toHaveBeenCalledTimes(2);
  expect(calls.records.mock.calls.find(([params]) => params.app === 100)?.[0].query)
    .toContain("日付 = YESTERDAY()");
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
});

test("CREATE TEMP TABLE UNION materialization は batch 内でも records/Cursor/mutation/confirm 0", async () => {
  const { client, calls } = makeClient();
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() "
    + "UNION ALL SELECT 日付 FROM APP200; "
    + "SELECT * FROM #t",
    client,
    { confirm: calls.confirm }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[0].error?.message)
    .toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  expectNoExecutionApi(calls);
});

test("temp 派生列 WHERE は取得後評価へ入る前に statement node 単位で拒否する", async () => {
  const { client, calls } = makeClient();
  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT '2026-07-24' AS 日付; "
    + "SELECT 日付 FROM #t WHERE 日付 = YESTERDAY()",
    client,
    { confirm: calls.confirm }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[0].status).toBe("success");
  expect(result.statements[1].error?.message)
    .toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  expectNoExecutionApi(calls);
});

test.each([
  "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()",
  "SELECT 日付 FROM APP100 WHERE 日付 >= FROM_TODAY(-7, DAYS) KORDER BY $id LIMIT 10",
])("SIMPLE SELECT は関数を REST query に保持し client evaluatorへ到達しない: %s", async (sql) => {
  const { client, calls } = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  await expect(execute(sql, client)).resolves.toMatchObject({ type: "SELECT" });
  expect(evaluator).not.toHaveBeenCalled();
  evaluator.mockRestore();
  expect(calls.records).toHaveBeenCalled();
  const query = calls.records.mock.calls.map(([params]) => params.query).join("\n");
  expect(query).toMatch(/YESTERDAY\(\)|FROM_TODAY\(-7, DAYS\)/);
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
});

test("materialized SIMPLE CTE は requested fieldsだけで実行し client評価なしの正しい結果を返す", async () => {
  const { client, calls } = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  const result = await execute(
    "WITH c AS (SELECT 日付 AS d FROM APP100 WHERE 日付 = YESTERDAY()) SELECT d FROM c",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ d: "2026-07-25" }]);
  expect(evaluator).not.toHaveBeenCalled();
  expect(calls.records).toHaveBeenCalledTimes(1);
  expect(calls.records.mock.calls[0][0]).toMatchObject({
    fields: ["日付", "$id"],
    query: "日付 = YESTERDAY() order by $id asc limit 500 offset 0",
  });
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
});

test.each([
  ["UPDATE", "UPDATE APP100 SET 状態 = '完了' WHERE 日付 = YESTERDAY()"],
  ["DELETE", "DELETE FROM APP100 WHERE 日付 = YESTERDAY()"],
  [
    "UPDATE VALIDATE ONLY",
    "UPDATE APP100 SET 状態 = '完了' WHERE 日付 = YESTERDAY() VALIDATE ONLY",
  ],
])("許可 %s は対象 query に関数を保持する", async (_label, sql) => {
  const { client, calls } = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  await expect(execute(sql, client)).resolves.toBeDefined();
  expect(evaluator).not.toHaveBeenCalled();
  evaluator.mockRestore();
  expect(calls.records).toHaveBeenCalled();
  expect(calls.records.mock.calls.map(([params]) => params.query).join("\n"))
    .toContain("YESTERDAY()");
});

test("UNION は SIMPLE / FULL_SCAN_EXACT の各 SELECT node を事前計画してから取得する", async () => {
  const positive = makeClient();
  await expect(execute(
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() "
    + "UNION ALL SELECT 日付 FROM APP200 WHERE 日付 = TOMORROW()",
    positive.client
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(positive.calls.records).toHaveBeenCalledTimes(2);
  expect(positive.calls.records.mock.calls[0][0].query).toContain("YESTERDAY()");
  expect(positive.calls.records.mock.calls[1][0].query).toContain("TOMORROW()");

  const mixed = makeClient();
  await expect(execute(
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() "
    + "UNION ALL SELECT COUNT(*) FROM APP200 WHERE 日付 = TOMORROW()",
    mixed.client
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(mixed.calls.records).toHaveBeenCalledTimes(3);
  const mixedParams = mixed.calls.records.mock.calls.map(([params]) => params);
  expect(mixedParams.filter((params) => params.query.includes("YESTERDAY()"))).toHaveLength(1);
  const tomorrowParams = mixedParams.filter((params) => params.query.includes("TOMORROW()"));
  expect(tomorrowParams).toHaveLength(2);
  expect(tomorrowParams.filter((params) => params.totalCount === true)).toHaveLength(1);
  expect(tomorrowParams.filter((params) => params.totalCount !== true)).toHaveLength(1);
});

test("WITH inline は body/main の各 WHERE を1つの物理 REST queryへ統合する", async () => {
  const { client, calls } = makeClient();
  await expect(execute(
    "WITH c AS (SELECT * FROM APP100 WHERE 日付 >= FROM_TODAY(-7, DAYS)) "
    + "SELECT 日付 FROM c WHERE 日付 <= TOMORROW()",
    client
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(calls.records).toHaveBeenCalledTimes(1);
  expect(calls.records.mock.calls[0][0].query).toContain("FROM_TODAY(-7, DAYS)");
  expect(calls.records.mock.calls[0][0].query).toContain("TOMORROW()");
});

test.each([
  "EXPLAIN SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY()",
  "EXPLAIN UPDATE APP100 SET 状態='x' WHERE 日付 = YESTERDAY()",
])("EXPLAIN は execution と同じ plan gate を使い records/Cursor/mutation/confirm 0: %s", async (sql) => {
  const { client, calls } = makeClient();
  await expect(execute(sql, client)).resolves.toMatchObject({ type: "SELECT" });
  expectNoExecutionApi(calls);
});

test("planner guard と runtime backstop は独立し、guard bypass AST は同じ reasonで閉じる", () => {
  jest.isolateModules(() => {
    const { evalWhere } = require("../engine/evalWhere") as typeof import("../engine/evalWhere");
    expect(() => evalWhere({
      type: "BINARY",
      op: "=",
      left: { type: "FIELD", tableAlias: null, field: "日付" },
      right: { type: "KINTONE_FUNC", name: "YESTERDAY", args: { kind: "NONE" } },
    }, { 日付: "2026-07-24" }))
      .toThrow("YESTERDAY: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  });
});
