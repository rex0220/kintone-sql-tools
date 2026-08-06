import {
  execute,
  SearchAbortedError,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

type GetParams = Parameters<KintoneClient["getRecords"]>[0];

const FIELDS: KintoneFieldInfo[] = [
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "金額", label: "金額", fieldType: "NUMBER" },
  { code: "件数", label: "件数", fieldType: "NUMBER" },
];

function record(id: number, values: Record<string, unknown> = {}): KintoneRecord {
  return Object.fromEntries(
    Object.entries({ $id: String(id), ...values })
      .map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const DEFAULT_RECORDS = [
  record(1, { 件名: "alpha", 金額: "10" }),
  record(2, { 件名: "beta", 金額: "20" }),
  record(3, { 件名: "gamma", 金額: "" }),
];

function requestedTotalCount(params: GetParams): boolean {
  return (params as GetParams & { totalCount?: boolean }).totalCount === true;
}

function makeClient(options: {
  totalCounts?: Readonly<Record<number, unknown>>;
  records?: Readonly<Record<number, KintoneRecord[]>>;
  searchAbortedApp?: number;
} = {}) {
  const getRecords = jest.fn(async (params: GetParams) => {
    if (requestedTotalCount(params)) {
      return {
        records: (options.records?.[params.app] ?? DEFAULT_RECORDS).slice(0, 1),
        totalCount: options.totalCounts?.[params.app],
        searchAborted: params.app === options.searchAbortedApp,
      } as Awaited<ReturnType<KintoneClient["getRecords"]>>;
    }
    return { records: options.records?.[params.app] ?? DEFAULT_RECORDS };
  });
  const client: KintoneClient = {
    getRecords,
    async openCursor() {
      return {
        totalCount: 0,
        async nextPage() { return { records: [], next: false }; },
        async close() { /* noop */ },
      };
    },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return FIELDS; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
  return { client, getRecords };
}

function totalCountCalls(getRecords: jest.Mock): GetParams[] {
  return getRecords.mock.calls
    .map(([params]) => params as GetParams)
    .filter(requestedTotalCount);
}

function planText(result: SelectResult): string {
  return result.rows.map((row) => row["plan"]).join("\n");
}

test("B105: UNION ALL の各 COUNT(*) 枝は単発 GET になり既定 maxRecords を消費しない", async () => {
  const { client, getRecords } = makeClient({
    totalCounts: { 100: "10228", 200: "7" },
  });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 UNION ALL SELECT COUNT(*) AS c FROM APP200",
    client,
    { maxRecords: 1, onLimitReached: "error" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ c: "10228" }, { c: "7" }]);
  expect(getRecords).toHaveBeenCalledTimes(2);
  expect(totalCountCalls(getRecords)).toHaveLength(2);
  expect(totalCountCalls(getRecords).map((params) => params.app).sort()).toEqual([100, 200]);
});

test("B105: UNION でも各 COUNT(*) 枝は単発 GET になり外側で重複排除する", async () => {
  const { client, getRecords } = makeClient({
    totalCounts: { 100: "3", 200: "3" },
  });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 UNION SELECT COUNT(*) AS c FROM APP200",
    client,
    { maxRecords: 1, onLimitReached: "error" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ c: "3" }]);
  expect(getRecords).toHaveBeenCalledTimes(2);
  expect(totalCountCalls(getRecords)).toHaveLength(2);
});

test("B105: 入れ子 UNION の終端 COUNT(*) 枝すべてに単発 GET が届く", async () => {
  const { client, getRecords } = makeClient({
    totalCounts: { 100: "1", 200: "2", 300: "3" },
  });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 " +
      "UNION ALL SELECT COUNT(*) AS c FROM APP200 " +
      "UNION ALL SELECT COUNT(*) AS c FROM APP300",
    client,
    { maxRecords: 1, onLimitReached: "error" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ c: "1" }, { c: "2" }, { c: "3" }]);
  expect(getRecords).toHaveBeenCalledTimes(3);
  expect(totalCountCalls(getRecords)).toHaveLength(3);
});

test("B105: UNION 内で適用可否を枝ごとに判定する", async () => {
  const { client, getRecords } = makeClient({
    totalCounts: { 100: "9", 200: "999" },
  });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 UNION ALL SELECT COUNT(金額) AS c FROM APP200",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ c: "9" }, { c: "2" }]);
  expect(getRecords).toHaveBeenCalledTimes(2);
  expect(totalCountCalls(getRecords)).toHaveLength(1);
  expect(totalCountCalls(getRecords)[0]?.app).toBe(100);
  const fullScanCall = getRecords.mock.calls
    .map(([params]) => params as GetParams)
    .find((params) => params.app === 200);
  expect(fullScanCall).toBeDefined();
  expect(requestedTotalCount(fullScanCall!)).toBe(false);
});

test("B105: EXPLAIN は UNION 枝ごとの COUNT_TOTAL_COUNT / FULL_SCAN を表示する", async () => {
  const { client, getRecords } = makeClient();

  const exact = planText(await execute(
    "EXPLAIN SELECT COUNT(*) AS c FROM APP100 " +
      "UNION ALL SELECT COUNT(*) AS c FROM APP200",
    client
  ) as SelectResult);
  expect(exact.match(/mode:\s+COUNT_TOTAL_COUNT/g)).toHaveLength(2);
  expect(exact.match(/REST execution: single GET/g)).toHaveLength(2);

  const mixed = planText(await execute(
    "EXPLAIN SELECT COUNT(*) AS c FROM APP100 " +
      "UNION ALL SELECT COUNT(金額) AS c FROM APP200",
    client
  ) as SelectResult);
  expect(mixed.match(/mode:\s+COUNT_TOTAL_COUNT/g)).toHaveLength(1);
  expect(mixed.match(/mode:\s+FULL_SCAN/g)).toHaveLength(1);
  expect(getRecords).not.toHaveBeenCalled();
});

test("B105: CTE 本体・サブクエリ・DML source は従来どおり COUNT_TOTAL_COUNT にしない", async () => {
  const { client, getRecords } = makeClient({ totalCounts: { 100: "999", 200: "999" } });

  const cteResult = await execute(
    "WITH x AS (SELECT COUNT(*) AS c FROM APP100) SELECT c FROM x",
    client
  ) as SelectResult;
  expect(cteResult.rows).toEqual([{ c: "3" }]);

  const subqueryResult = await execute(
    "SELECT (SELECT COUNT(*) FROM APP200) AS c FROM APP300 LIMIT 1",
    client
  ) as SelectResult;
  expect(subqueryResult.rows).toEqual([{ c: "3" }]);
  expect(totalCountCalls(getRecords)).toHaveLength(0);

  const ctePlan = planText(await execute(
    "EXPLAIN WITH x AS (SELECT COUNT(*) AS c FROM APP100) SELECT c FROM x",
    client
  ) as SelectResult);
  expect(ctePlan).not.toContain("COUNT_TOTAL_COUNT");

  const subqueryPlan = planText(await execute(
    "EXPLAIN SELECT (SELECT COUNT(*) FROM APP200) AS c FROM APP300 LIMIT 1",
    client
  ) as SelectResult);
  expect(subqueryPlan).not.toContain("COUNT_TOTAL_COUNT");

  const dmlPlan = planText(await execute(
    "EXPLAIN INSERT INTO APP300 (件数) SELECT COUNT(*) FROM APP100",
    client
  ) as SelectResult);
  expect(dmlPlan).not.toContain("COUNT_TOTAL_COUNT");
});

test("B105: UNION 枝で totalCount が無ければ全件取得へフォールバックして正しく数える", async () => {
  const { client, getRecords } = makeClient({
    totalCounts: { 100: undefined, 200: "" },
  });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 UNION ALL SELECT COUNT(*) AS c FROM APP200",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([{ c: "3" }, { c: "3" }]);
  expect(getRecords).toHaveBeenCalledTimes(4);
  expect(totalCountCalls(getRecords)).toHaveLength(2);
});

test("B105: UNION 枝の totalCount GET で searchAborted は fail-closed", async () => {
  const { client, getRecords } = makeClient({
    totalCounts: { 100: "100000", 200: "2" },
    searchAbortedApp: 100,
  });

  await expect(execute(
    "SELECT COUNT(*) AS c FROM APP100 UNION ALL SELECT COUNT(*) AS c FROM APP200",
    client
  )).rejects.toBeInstanceOf(SearchAbortedError);
  expect(totalCountCalls(getRecords)).toHaveLength(2);
});

test("B105 R2: ラベル付き UNION 枝は単発 GET になり既定 maxRecords を消費しない", async () => {
  const { client, getRecords } = makeClient({
    totalCounts: { 2: "10228", 15: "6" },
  });

  const result = await execute(
    "SELECT '交通費申請' AS アプリ, COUNT(*) AS 件数 FROM APP2 " +
      "UNION ALL SELECT 'ユーザー選択', COUNT(*) FROM APP15",
    client,
    { maxRecords: 1, onLimitReached: "error" }
  ) as SelectResult;

  expect(result.columns).toEqual(["アプリ", "件数"]);
  expect(result.rows).toEqual([
    { アプリ: "交通費申請", 件数: "10228" },
    { アプリ: "ユーザー選択", 件数: "6" },
  ]);
  expect(result.rowCount).toBe(2);
  expect(getRecords).toHaveBeenCalledTimes(2);
  expect(totalCountCalls(getRecords)).toHaveLength(2);
});

test.each([
  ["ラベルが前・別名あり", "SELECT 'front' AS label, COUNT(*) AS total FROM APP100"],
  ["ラベルが後・別名あり", "SELECT COUNT(*) AS total, 'back' AS label FROM APP100"],
  [
    "複数ラベル・別名あり",
    "SELECT 'left' AS first, COUNT(*) AS total, 'right' AS second FROM APP100",
  ],
  ["別名なし", "SELECT 'plain', COUNT(*) FROM APP100"],
])("B105 R2: %s は totalCount 経路とフォールバック経路の結果が完全一致する", async (
  _caseName,
  sql
) => {
  const optimized = makeClient({ totalCounts: { 100: "3" } });
  const fallback = makeClient({ totalCounts: { 100: undefined } });

  const optimizedResult = await execute(sql, optimized.client) as SelectResult;
  const fallbackResult = await execute(sql, fallback.client) as SelectResult;

  expect({
    columns: optimizedResult.columns,
    rows: optimizedResult.rows,
    rowCount: optimizedResult.rowCount,
  }).toEqual({
    columns: fallbackResult.columns,
    rows: fallbackResult.rows,
    rowCount: fallbackResult.rowCount,
  });
  expect(optimized.getRecords).toHaveBeenCalledTimes(1);
  expect(totalCountCalls(optimized.getRecords)).toHaveLength(1);
  expect(fallback.getRecords).toHaveBeenCalledTimes(2);
  expect(totalCountCalls(fallback.getRecords)).toHaveLength(1);
});

test("B105 R2: FIELD_COL が混ざると B148 が records API 前に拒否する", async () => {
  const { client, getRecords } = makeClient({ totalCounts: { 100: "999" } });

  await expect(execute("SELECT 件名, COUNT(*) AS c FROM APP100", client)).rejects.toThrow(
    /非グループ化依存: 件名.*B65_NON_GROUPED_DEPENDENCY/
  );

  expect(getRecords).not.toHaveBeenCalled();
  expect(totalCountCalls(getRecords)).toHaveLength(0);
});

test.each([
  ["ARITH_COL", "SELECT 1 AS k, COUNT(*) AS c FROM APP100"],
  ["STRFUNC_COL", "SELECT UPPER('a') AS k, COUNT(*) AS c FROM APP100"],
  ["SCALAR_VALUE_COL", "SELECT 'a' || 'b' AS k, COUNT(*) AS c FROM APP100"],
  ["引数なし日付関数", "SELECT CURRENT_DATE() AS k, COUNT(*) AS c FROM APP100"],
])("B105 R2: %s が混ざると EXPLAIN は FULL_SCAN のまま", async (
  _columnType,
  sql
) => {
  const { client, getRecords } = makeClient();

  const plan = planText(await execute(`EXPLAIN ${sql}`, client) as SelectResult);

  expect(plan).toContain("mode:          FULL_SCAN");
  expect(plan).not.toContain("COUNT_TOTAL_COUNT");
  expect(getRecords).not.toHaveBeenCalled();
});

test.each([
  ["CASE_COL", "SELECT CASE WHEN 金額 > 0 THEN 'a' ELSE 'b' END AS k, COUNT(*) AS c FROM APP100", "金額"],
  ["FIELD_COL", "SELECT 件名 AS k, COUNT(*) AS c FROM APP100", "件名"],
])("B105 R2: %s の bare dependency は EXPLAIN でも拒否する", async (_type, sql, dependency) => {
  const { client, getRecords } = makeClient();
  await expect(execute(`EXPLAIN ${sql}`, client)).rejects.toThrow(
    new RegExp(`非グループ化依存: ${dependency}.*B65_NON_GROUPED_DEPENDENCY`)
  );
  expect(getRecords).not.toHaveBeenCalled();
});
