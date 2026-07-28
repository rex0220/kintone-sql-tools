import {
  execute,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import * as evalWhereModule from "../engine/evalWhere";

const FIELD_DEFINITIONS = [
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "日時", label: "日時", fieldType: "DATETIME" },
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "金額", label: "金額", fieldType: "NUMBER" },
  { code: "作成者", label: "作成者", fieldType: "CREATOR" },
  { code: "状態", label: "状態", fieldType: "SINGLE_LINE_TEXT" },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
  {
    code: "子",
    label: "子",
    fieldType: "SINGLE_LINE_TEXT",
    inSubtable: true,
    subtableCode: "テーブル",
  },
];

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const SOURCE_RECORDS = [
  record({
    $id: "1",
    日付: "2026-07-27",
    日時: "2026-07-25T00:00:00Z",
    件名: "A",
    金額: "10",
  }),
  record({
    $id: "2",
    日付: "2026-07-27",
    日時: "2026-07-26T00:00:00Z",
    件名: "AB",
    金額: "20",
  }),
  record({
    $id: "3",
    日付: "2026-07-27",
    日時: "2026-07-27T00:00:00Z",
    件名: "ABC",
    金額: "30",
  }),
];

function makeClient() {
  const cursorGet = jest.fn(async () => ({ records: [], next: false }));
  const cursorClose = jest.fn(async () => undefined);
  const calls = {
    records: jest.fn(async (
      params: Parameters<KintoneClient["getRecords"]>[0]
    ) => ({
      // B71: mock は要求された fields だけを返す。
      records: SOURCE_RECORDS.map((source) => Object.fromEntries(
        (params.fields ?? []).flatMap((code) =>
          source[code] === undefined ? [] : [[code, source[code]]]
        )
      ) as KintoneRecord),
    })),
    cursorOpen: jest.fn(async () => ({
      totalCount: 0,
      nextPage: cursorGet,
      close: cursorClose,
    })),
    post: jest.fn(async () => ({ ids: [] })),
    put: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    confirm: jest.fn(async () => true),
  };
  const client: KintoneClient = {
    getRecords: calls.records,
    openCursor: calls.cursorOpen,
    postRecords: calls.post,
    putRecords: calls.put,
    deleteRecords: calls.delete,
    async getApps() { return []; },
    async getFields() { return FIELD_DEFINITIONS; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, calls };
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]): void {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
}

test.each([
  ["TODAY", "日付 = TODAY()", "日付 = TODAY()"],
  ["NOW", "日時 <= NOW()", "日時 <= NOW()"],
] as const)(
  "%s の whole-WHERE exact は query byte を保ち client evaluator 0",
  async (_name, where, expectedQuery) => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    await expect(execute(
      `SELECT $id FROM APP100 WHERE ${where}`,
      client
    )).resolves.toMatchObject({ type: "SELECT", rowCount: 3 });
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.records.mock.calls[0][0].query)
      .toBe(`${expectedQuery} order by $id asc limit 500 offset 0`);
    expect(evaluator).not.toHaveBeenCalled();
    evaluator.mockRestore();
  }
);

test.each([
  ["UPDATE", "UPDATE APP100 SET 状態 = '完了' WHERE 日付 = TODAY()", "put"],
  ["DELETE", "DELETE FROM APP100 WHERE 日付 = TODAY()", "delete"],
] as const)(
  "%s whole exact は mutation 選択 query に TODAY byte を保持する",
  async (_label, sql, mutation) => {
    const { client, calls } = makeClient();
    await expect(execute(sql, client, { confirm: calls.confirm })).resolves.toBeDefined();
    expect(calls.records.mock.calls[0][0].query).toContain("日付 = TODAY()");
    expect(calls.confirm).toHaveBeenCalledTimes(1);
    expect(calls[mutation]).toHaveBeenCalledTimes(1);
  }
);

test.each([
  ["TODAY", "日付 = TODAY()", "日付 = TODAY()"],
  ["NOW", "日時 <= NOW()", "日時 <= NOW()"],
] as const)(
  "%s の Phase2 A は server prefilter と非関数 residual に分離する",
  async (_name, functionLeaf, expectedPrefilter) => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await execute(
      "SELECT $id, 件名 FROM APP100 "
        + `WHERE ${functionLeaf} AND LENGTH(件名) > 1`,
      client
    ) as SelectResult;

    expect(result.rows).toEqual([
      { $id: "2", 件名: "AB" },
      { $id: "3", 件名: "ABC" },
    ]);
    expect(calls.records.mock.calls[0][0]).toMatchObject({
      fields: _name === "TODAY"
        ? ["$id", "件名", "日付"]
        : ["$id", "件名", "日時"],
      query: `${expectedPrefilter} order by $id asc limit 500 offset 0`,
    });
    expect(evaluator).toHaveBeenCalled();
    for (const [residual] of evaluator.mock.calls) {
      expect(JSON.stringify(residual)).not.toMatch(/TODAY|NOW|LOGINUSER/);
    }
    evaluator.mockRestore();
  }
);

test.each([
  [
    "non-exact OR",
    "SELECT 日付 FROM APP100 WHERE 日付 = TODAY() OR LENGTH(件名) > 1",
  ],
  [
    "non-exact NOT",
    "SELECT 日付 FROM APP100 "
      + "WHERE NOT (日付 = TODAY() AND LENGTH(件名) > 1)",
  ],
  [
    "non-exact KORDER",
    "SELECT 日付 FROM APP100 WHERE 日付 = TODAY() AND LENGTH(件名) > 1 "
      + "KORDER BY $id LIMIT 10",
  ],
  ["VALIDATE", "VALIDATE APP100 WHERE 日付 = TODAY()"],
  ["subtable UPDATE", "UPDATE APP100$テーブル SET 子 = 'x' WHERE 日付 = TODAY()"],
  ["REORDER", "REORDER APP100$テーブル BY 子 WHERE 日付 = TODAY()"],
] as const)(
  "%s は legacy function reason で API/confirm 前に拒否する",
  async (_label, sql) => {
    const { client, calls } = makeClient();
    await expect(execute(sql, client, { confirm: calls.confirm })).rejects.toThrow(
      /TODAY: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN.*WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED/
    );
    expectNoExecutionApi(calls);
  }
);

test("JOIN TODAY exact leaf は第5-L fetchでrowsを返しclient evaluator 0", async () => {
  const { client, calls } = makeClient();
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  const result = await execute(
    "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
      + "WHERE a.日付 = TODAY()",
    client,
    { confirm: calls.confirm }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 日付: "2026-07-27" },
    { 日付: "2026-07-27" },
    { 日付: "2026-07-27" },
  ]);
  expect(evaluator).not.toHaveBeenCalled();
  expect(calls.records).toHaveBeenCalledTimes(2);
  expect(calls.records.mock.calls.find(([params]) => params.app === 100)?.[0].query)
    .toContain("日付 = TODAY()");
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
});

test.each([
  ["DATE × NOW", "SELECT 日付 FROM APP100 WHERE 日付 = NOW()"],
  ["record id × TODAY", "SELECT $id FROM APP100 WHERE $id >= TODAY()"],
  ["text × TODAY", "SELECT 件名 FROM APP100 WHERE 件名 = TODAY()"],
  ["CREATOR = LOGINUSER", "SELECT 作成者 FROM APP100 WHERE 作成者 = LOGINUSER()"],
] as const)(
  "%s は Step1 specific reason と exact-pushdown reason を保って API 0",
  async (_label, sql) => {
    const { client, calls } = makeClient();
    await expect(execute(sql, client)).rejects.toThrow(
      /WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN.*WHERE_KINTONE_FUNCTION_(FIELD_TYPE|OPERATOR)_UNSUPPORTED/
    );
    expectNoExecutionApi(calls);
  }
);

test("EXPLAIN は legacy prefilter payload を表示し records/cursor API を呼ばない", async () => {
  const { client, calls } = makeClient();
  const result = await execute(
    "EXPLAIN SELECT $id FROM APP100 "
      + "WHERE 日付 = TODAY() AND LENGTH(件名) > 1",
    client
  ) as SelectResult;
  const text = result.rows.map((row) => row.plan).join("\n");
  expect(text).toContain("kintone function: TODAY");
  expect(text).toContain("kintone function evaluation: kintone server exact prefilter");
  expect(text).toContain("where capability: SUPERSET_PREFILTER");
  expect(text).toContain("server prefilter: 日付 = TODAY()");
  expect(text).toContain("client residual: LENGTH(件名) > 1");
  expect(text).toContain("kintone function client evaluations: 0");
  expect(text).toContain("kintone query: 日付 = TODAY()");
  expectNoExecutionApi(calls);
});

test("EXPLAIN whole exact は legacy function の server-only payload を表示する", async () => {
  const { client, calls } = makeClient();
  const result = await execute(
    "EXPLAIN SELECT 日付 FROM APP100 WHERE 日付 = TODAY()",
    client
  ) as SelectResult;
  const text = result.rows.map((row) => row.plan).join("\n");
  expect(text).toContain("kintone function: TODAY");
  expect(text).toContain("kintone function evaluation: kintone server");
  expect(text).toContain("where capability: EXACT_PUSHDOWN");
  expect(text).toContain("client residual: (none)");
  expect(text).toContain("kintone function client evaluations: 0");
  expect(text).toContain("kintone query: 日付 = TODAY()");
  expectNoExecutionApi(calls);
});

test("EXPLAIN rejection は specific/context と exact reason を表示し空 query を出さない", async () => {
  const { client, calls } = makeClient();
  const result = await execute(
    "EXPLAIN SELECT 日付 FROM APP100 "
      + "WHERE NOT (日付 = TODAY() AND LENGTH(件名) > 1)",
    client
  ) as SelectResult;
  const text = result.rows.map((row) => row.plan).join("\n");
  expect(text).toContain("kintone function: TODAY");
  expect(text).toContain("WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED");
  expect(text).toContain("WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN");
  expect(text).not.toContain("kintone query:");
  expectNoExecutionApi(calls);
});

test.each([
  ["truncate", "truncate"],
  ["error", "error"],
] as const)(
  "TODAY と同値 date literal は onLimit=%s で対称",
  async (_label, onLimitReached) => {
    const options = { maxRecords: 2, onLimitReached };
    const functionRun = execute(
      "SELECT SUM(金額) AS total FROM APP100 WHERE 日付 >= TODAY()",
      makeClient().client,
      options
    );
    const literalRun = execute(
      "SELECT SUM(金額) AS total FROM APP100 WHERE 日付 >= '2026-07-27'",
      makeClient().client,
      options
    );
    await expect(functionRun).rejects.toThrow(/上限（2 件）/);
    await expect(literalRun).rejects.toThrow(/上限（2 件）/);
  }
);
