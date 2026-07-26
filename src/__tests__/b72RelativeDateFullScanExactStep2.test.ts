import {
  execute,
  executeBatch,
  SearchAbortedError,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import * as evalWhereModule from "../engine/evalWhere";

type GetParams = Parameters<KintoneClient["getRecords"]>[0];

const SOURCE_FIELDS: KintoneFieldInfo[] = [
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
  { code: "金額", label: "金額", fieldType: "NUMBER" },
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
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

const MATCHED_RECORDS = [
  record({ $id: "1", 日付: "2026-07-01", 区分: "A", 金額: "10", 件名: "one" }),
  record({ $id: "2", 日付: "2026-07-02", 区分: "A", 金額: "20", 件名: "two" }),
  record({ $id: "3", 日付: "2026-07-03", 区分: "B", 金額: "5", 件名: "three" }),
];

function makeClient(options: {
  records?: KintoneRecord[];
  searchAborted?: boolean;
} = {}) {
  const source = options.records ?? MATCHED_RECORDS;
  const calls = {
    records: jest.fn(async (params: GetParams) => {
      const requested = params.fields ?? [];
      return {
        records: source.map((row) =>
          Object.fromEntries(
            requested.flatMap((code) =>
              row[code] === undefined ? [] : [[code, row[code]]]
            )
          ) as KintoneRecord
        ),
        searchAborted: options.searchAborted,
      };
    }),
    cursorOpen: jest.fn(async () => ({
      totalCount: 0,
      nextPage: jest.fn(async () => ({ records: [], next: false })),
      close: jest.fn(async () => undefined),
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
    async getFields(appId) {
      return appId === 100 ? SOURCE_FIELDS : [
        { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT", writable: true },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, calls };
}

function firstRequest(calls: ReturnType<typeof makeClient>["calls"]): GetParams {
  const request = calls.records.mock.calls[0]?.[0];
  if (!request) throw new Error("records request expected");
  return request;
}

function expectNoExecutionApi(calls: ReturnType<typeof makeClient>["calls"]): void {
  expect(calls.records).not.toHaveBeenCalled();
  expect(calls.cursorOpen).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
  expect(calls.put).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  expect(calls.confirm).not.toHaveBeenCalled();
}

describe("B72 Step 2 FULL_SCAN_EXACT runtime", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {
      name: "plain GROUP BY",
      sql: "SELECT 区分, COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH() GROUP BY 区分",
      expected: [{ 区分: "A", c: "2" }, { 区分: "B", c: "1" }],
      fields: ["区分", "日付", "$id"],
    },
    {
      name: "DISTINCT",
      sql: "SELECT DISTINCT 区分 FROM APP100 WHERE 日付 = THIS_MONTH()",
      expected: [{ 区分: "A" }, { 区分: "B" }],
      fields: ["区分", "日付", "$id"],
    },
    {
      name: "aggregate",
      sql: "SELECT SUM(金額) AS total FROM APP100 WHERE 日付 = THIS_MONTH()",
      expected: [{ total: "35" }],
      fields: ["金額", "日付", "$id"],
    },
    {
      name: "window",
      sql: "SELECT 日付, ROW_NUMBER() OVER (ORDER BY 日付) AS rn "
        + "FROM APP100 WHERE 日付 = THIS_MONTH()",
      expected: [
        { 日付: "2026-07-01", rn: "1" },
        { 日付: "2026-07-02", rn: "2" },
        { 日付: "2026-07-03", rn: "3" },
      ],
      fields: ["日付", "$id"],
    },
    {
      name: "fully exact OR",
      sql: "SELECT 区分, COUNT(*) AS c FROM APP100 "
        + "WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH() GROUP BY 区分",
      expected: [{ 区分: "A", c: "2" }, { 区分: "B", c: "1" }],
      fields: ["区分", "日付", "$id"],
    },
  ])("$name は whole WHERE を一度だけ送り client relative 評価0", async ({
    sql,
    expected,
    fields,
  }) => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await execute(sql, client) as SelectResult;

    expect(result.rows).toEqual(expected);
    expect(evaluator).not.toHaveBeenCalled();
    const request = firstRequest(calls);
    expect(request.fields).toEqual(fields);
    expect(request.query).toContain("日付 = THIS_MONTH()");
    expect((request.query.match(/THIS_MONTH\(\)/g) ?? [])).toHaveLength(1);
  });

  test("canonical ORDER BY は SIMPLE path の server WHERE と local sortだけを使う", async () => {
    const { client, calls } = makeClient();
    const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
    const result = await execute(
      "SELECT 日付 FROM APP100 WHERE 日付 = THIS_MONTH() ORDER BY 日付 DESC",
      client
    ) as SelectResult;

    expect(result.rows).toEqual([
      { 日付: "2026-07-03" },
      { 日付: "2026-07-02" },
      { 日付: "2026-07-01" },
    ]);
    expect(evaluator).not.toHaveBeenCalled();
    expect(firstRequest(calls).query).toContain("日付 = THIS_MONTH()");
  });

  test("B71 ALIAS_SAFE は依存列を維持し B72 predicate を同じ request に載せる", async () => {
    const { client, calls } = makeClient();
    const result = await execute(
      "SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, COUNT(*) AS c "
      + "FROM APP100 WHERE 日付 = THIS_MONTH() GROUP BY 年月",
      client
    ) as SelectResult;

    expect(result.rows).toEqual([{ 年月: "2026-07", c: "3" }]);
    expect(firstRequest(calls)).toMatchObject({
      fields: ["日付", "$id"],
    });
    expect(firstRequest(calls).query).toContain("日付 = THIS_MONTH()");
  });

  test("B71 PHYSICAL shadow は実列を強制 fetchし B72は取得列を減らさない", async () => {
    const { client, calls } = makeClient();
    const result = await execute(
      "SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() GROUP BY 区分",
      client
    ) as SelectResult;

    expect(result.rowCount).toBe(2);
    expect(firstRequest(calls).fields).toEqual(["金額", "日付", "区分", "$id"]);
    expect(firstRequest(calls).query).toContain("日付 = THIS_MONTH()");
  });

  test("maxRecords + truncate でも B72 complete-input は部分集計を返さない", async () => {
    const { client } = makeClient();
    await expect(execute(
      "SELECT COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH()",
      client,
      { maxRecords: 1, onLimitReached: "truncate" }
    )).rejects.toThrow(/RELATIVE_DATE_FULL_SCAN_EXACT/);
  });

  test("searchAborted は B72 local-processing で warning結果にせず fail-closed", async () => {
    const { client, calls } = makeClient({ searchAborted: true });
    await expect(execute(
      "SELECT COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH()",
      client
    )).rejects.toBeInstanceOf(SearchAbortedError);
    expect(calls.records).toHaveBeenCalledTimes(1);
    expect(calls.post).not.toHaveBeenCalled();
    expect(calls.put).not.toHaveBeenCalled();
    expect(calls.delete).not.toHaveBeenCalled();
  });
});

describe("B72 Step 2 must-stay-rejected", () => {
  test.each([
    [
      "KORDER FULL_SCAN",
      "SELECT COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH() KORDER BY $id LIMIT 10",
    ],
    [
      "JOIN",
      "SELECT a.区分, COUNT(*) AS c FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
      + "WHERE a.日付 = THIS_MONTH() GROUP BY a.区分",
    ],
    ["VALIDATE", "VALIDATE APP100 WHERE 日付 = THIS_MONTH()"],
    [
      "subtable",
      "SELECT 子, COUNT(*) AS c FROM APP100$テーブル "
      + "WHERE 日付 = THIS_MONTH() GROUP BY 子",
    ],
    [
      "INSERT SELECT source",
      "INSERT INTO APP200 (区分) SELECT 区分 FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() GROUP BY 区分",
    ],
    [
      "UPSERT SELECT source",
      "UPSERT INTO APP200 (区分) SELECT 区分 FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() GROUP BY 区分 ON DUPLICATE (区分)",
    ],
    [
      "non-exact OR",
      "SELECT 区分, COUNT(*) AS c FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() OR LENGTH(件名) > 1 GROUP BY 区分",
    ],
  ])("%s は records/cursor/mutation/confirm 0", async (_name, sql) => {
    const { client, calls } = makeClient();
    await expect(execute(sql, client, { confirm: calls.confirm }))
      .rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
    expectNoExecutionApi(calls);
  });

  test("materialized CTE は records/cursor/mutation/confirm 0", async () => {
    const { client, calls } = makeClient();
    await expect(execute(
      "WITH c AS (SELECT 区分, COUNT(*) AS c FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() GROUP BY 区分) SELECT * FROM c",
      client,
      { confirm: calls.confirm }
    )).rejects.toThrow(/WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
    expectNoExecutionApi(calls);
  });

  test("CREATE TEMP TABLE source は batchでも records/cursor/mutation/confirm 0", async () => {
    const { client, calls } = makeClient();
    const result = await executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 区分, COUNT(*) AS c FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() GROUP BY 区分; SELECT * FROM #t",
      client,
      { confirm: calls.confirm }
    );
    expect(result.ok).toBe(false);
    expect(result.statements[0].error?.message)
      .toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
    expectNoExecutionApi(calls);
  });
});
