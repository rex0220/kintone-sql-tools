import {
  execute,
  executeBatch,
  SearchAbortedError,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { createNodeKintoneClient } from "../cli/nodeKintoneClient";

type GetParams = Parameters<KintoneClient["getRecords"]>[0];

const FIELDS: KintoneFieldInfo[] = [
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "金額", label: "金額", fieldType: "NUMBER" },
  {
    code: "選択",
    label: "選択",
    fieldType: "DROP_DOWN",
    optionOrder: { A: 0, B: 1 },
  },
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
  {
    code: "子",
    label: "子",
    fieldType: "SINGLE_LINE_TEXT",
    inSubtable: true,
    subtableCode: "テーブル",
  },
];

function record(id: number, values: Record<string, unknown> = {}): KintoneRecord {
  return Object.fromEntries(
    Object.entries({ $id: String(id), ...values })
      .map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const SOURCE = [
  record(1, {
    件名: "alpha",
    金額: "10",
    選択: "A",
    日付: "2026-07-01",
    テーブル: [
      { id: "r1", value: { 子: { value: "x" } } },
      { id: "r2", value: { 子: { value: "y" } } },
    ],
  }),
  record(2, {
    件名: "beta",
    金額: "20",
    選択: "B",
    日付: "2026-07-02",
    テーブル: [],
  }),
  record(3, {
    件名: "alphabet",
    金額: "",
    選択: "A",
    日付: "2026-07-03",
    テーブル: [{ id: "r3", value: { 子: { value: "z" } } }],
  }),
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

function makeClient(options: {
  totalCount?: unknown;
  searchAborted?: boolean;
} = {}) {
  const getRecords = jest.fn(async (params: GetParams) => {
    const totalCountRequested =
      (params as GetParams & { totalCount?: boolean }).totalCount === true;
    if (totalCountRequested) {
      return {
        records: SOURCE.slice(0, 1),
        totalCount: options.totalCount,
        searchAborted: options.searchAborted,
      } as Awaited<ReturnType<KintoneClient["getRecords"]>>;
    }
    return { records: SOURCE };
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

function countValue(result: SelectResult, alias = "c"): string {
  return result.rows[0]?.[alias] ?? "";
}

function requestedTotalCount(params: GetParams): boolean {
  return (params as GetParams & { totalCount?: boolean }).totalCount === true;
}

test("B94: exact COUNT(*) は totalCount を使う単発 GET で maxRecords を消費しない", async () => {
  const { client, getRecords } = makeClient({ totalCount: "123456" });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 WHERE 金額 > 0",
    client,
    { maxRecords: 1, onLimitReached: "error" }
  ) as SelectResult;

  expect(countValue(result)).toBe("123456");
  expect(getRecords).toHaveBeenCalledTimes(1);
  expect(getRecords.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
    app: 100,
    query: "金額 > 0 limit 1",
    totalCount: true,
  }));
});

test.each([
  ["missing", undefined],
  ["empty", ""],
  ["negative", "-1"],
  ["decimal", "1.5"],
  ["non-numeric", "three"],
  ["number instead of string", 3],
])("B94: BYO totalCount %s は 0 扱いせず従来の全件取得へフォールバックする", async (
  _label,
  totalCount
) => {
  const { client, getRecords } = makeClient({ totalCount });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100",
    client
  ) as SelectResult;

  expect(countValue(result)).toBe("3");
  expect(getRecords).toHaveBeenCalledTimes(2);
  expect(requestedTotalCount(getRecords.mock.calls[0]![0])).toBe(true);
  expect(requestedTotalCount(getRecords.mock.calls[1]![0])).toBe(false);
});

test("B94: totalCount の 0 は正しい件数として受け入れる", async () => {
  const { client, getRecords } = makeClient({ totalCount: "0" });

  const result = await execute(
    "SELECT COUNT(*) FROM APP100",
    client
  ) as SelectResult;

  expect(countValue(result, "COUNT(*)")).toBe("0");
  expect(getRecords).toHaveBeenCalledTimes(1);
});

test("B94: totalCount GET の searchAborted は fail-closed", async () => {
  const { client, getRecords } = makeClient({
    totalCount: "100000",
    searchAborted: true,
  });

  await expect(
    execute("SELECT COUNT(*) AS c FROM APP100 WHERE 件名 KLIKE 'a'", client)
  ).rejects.toBeInstanceOf(SearchAbortedError);
  expect(getRecords).toHaveBeenCalledTimes(1);
});

test.each([
  {
    name: "SUPERSET_PREFILTER",
    sql: "SELECT COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH() AND LENGTH(件名) > 4",
    count: "2",
  },
  {
    name: "LOCAL_ONLY",
    sql: "SELECT COUNT(*) AS c FROM APP100 WHERE 件名 LIKE 'alpha'",
    count: "2",
  },
  {
    name: "DROP_DOWN equality residual",
    sql: "SELECT COUNT(*) AS c FROM APP100 WHERE 選択 = 'A'",
    count: "2",
  },
])("B94: $name は totalCount を使わず従来経路で正しく数える", async ({
  sql,
  count,
}) => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await execute(sql, client) as SelectResult;

  expect(countValue(result)).toBe(count);
  expect(getRecords).toHaveBeenCalled();
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test.each([
  ["COUNT(列)", "SELECT COUNT(金額) AS c FROM APP100", "2"],
  ["DISTINCT", "SELECT DISTINCT COUNT(*) AS c FROM APP100", "3"],
  ["LIMIT", "SELECT COUNT(*) AS c FROM APP100 LIMIT 1", "3"],
  [
    "他の集計関数との併用",
    "SELECT COUNT(*) AS c, SUM(金額) AS total FROM APP100",
    "3",
  ],
  [
    "他の列との併用",
    "SELECT 件名, COUNT(*) AS c FROM APP100",
    "3",
  ],
])("B94: 対象外の %s は従来経路で正しい件数を返す", async (
  _name,
  sql,
  count
) => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await execute(sql, client) as SelectResult;

  expect(countValue(result)).toBe(count);
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test("B94: COUNT(*) と window の併用は既存 parser 契約どおり API 前に拒否する", async () => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  await expect(execute(
    "SELECT COUNT(*) AS c, ROW_NUMBER() OVER (ORDER BY 金額) AS rn FROM APP100",
    client
  )).rejects.toThrow(/ウィンドウ関数は GROUP BY \/ 集計関数と同じ SELECT では使用できません/);
  expect(getRecords).not.toHaveBeenCalled();
});

test("B94: GROUP BY / HAVING は totalCount を使わずグループ別に正しく数える", async () => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await execute(
    "SELECT 選択, COUNT(*) AS c FROM APP100 GROUP BY 選択 HAVING COUNT(*) > 0 ORDER BY 選択",
    client
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 選択: "A", c: "2" },
    { 選択: "B", c: "1" },
  ]);
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test("B94: JOIN は totalCount を使わず結合後の件数を正しく数える", async () => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 AS a INNER JOIN APP200 AS b ON a.選択 = b.選択",
    client
  ) as SelectResult;

  expect(countValue(result)).toBe("5");
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test("B94: サブテーブル仮想表は totalCount を使わず子行を正しく数える", async () => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100$テーブル",
    client
  ) as SelectResult;

  expect(countValue(result)).toBe("3");
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test("B94: OFFSET ありは集計後の従来窓を維持する", async () => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await execute(
    "SELECT COUNT(*) AS c FROM APP100 LIMIT 10 OFFSET 1",
    client
  ) as SelectResult;

  expect(result).toMatchObject({ rowCount: 0, rows: [] });
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test("B94: CTE 由来の COUNT(*) は totalCount を使わず実体化結果を数える", async () => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await execute(
    "WITH x AS (SELECT * FROM APP100) SELECT COUNT(*) AS c FROM x",
    client
  ) as SelectResult;

  expect(countValue(result)).toBe("3");
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test("B94: 一時テーブルの COUNT(*) は totalCount を使わず実体化結果を数える", async () => {
  const { client, getRecords } = makeClient({ totalCount: "999" });

  const result = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 件名 FROM APP100; SELECT COUNT(*) AS c FROM #t",
    client
  );

  expect((result.statements[1]?.result as SelectResult).rows).toEqual([{ c: "3" }]);
  expect(getRecords.mock.calls.every(([params]) => !requestedTotalCount(params))).toBe(true);
});

test("B94: EXPLAIN は totalCount の単発 GET・上限非適用・fallback・fail-closed を表示する", async () => {
  const { client, getRecords } = makeClient();

  const result = await execute(
    "EXPLAIN SELECT COUNT(*) AS c FROM APP100 WHERE 金額 > 0",
    client
  ) as SelectResult;
  const plan = result.rows.map((row) => row["plan"]).join("\n");

  expect(plan).toContain("mode:          COUNT_TOTAL_COUNT");
  expect(plan).toContain("GET records.json (totalCount=true)");
  expect(plan).toContain("REST execution: single GET");
  expect(plan).toContain("maxRecords/onLimitReached not applied");
  expect(plan).toContain("full record scan when totalCount is missing or invalid");
  expect(plan).toContain("fail-closed (SearchAbortedError)");
  expect(getRecords).not.toHaveBeenCalled();
});

test("B94: Node client は totalCount=true を GET query に送りレスポンス値を保持する", async () => {
  globalThis.fetch = jest.fn(async () => new Response(
    JSON.stringify({ records: [], totalCount: "42" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  ));
  const client = createNodeKintoneClient("https://example.cybozu.com", {
    auth: { type: "token", resolveToken: () => "token" },
  });

  await expect(client.getRecords({
    app: 100,
    query: "金額 > 0 limit 1",
    fields: ["$id"],
    totalCount: true,
  })).resolves.toEqual({ records: [], totalCount: "42" });

  expect(String((globalThis.fetch as jest.Mock).mock.calls[0]?.[0]))
    .toContain("totalCount=true");
});
