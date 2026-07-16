import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function makeClient(records: KintoneRecord[], fields: KintoneFieldInfo[] = []): KintoneClient & {
  getCalls: Array<{ query: string; fields: string[] }>;
} {
  const getCalls: Array<{ query: string; fields: string[] }> = [];
  return {
    getCalls,
    async getRecords(params) {
      getCalls.push({ query: params.query ?? "", fields: [...(params.fields ?? [])] });
      return { records };
    },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return fields; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

const sales = [
  record({ 顧客ID: "A", 受注日: "2026-01-01", 金額: "100" }),
  record({ 顧客ID: "A", 受注日: "2026-02-01", 金額: "200" }),
  record({ 顧客ID: "B", 受注日: "2026-01-15", 金額: "300" }),
  record({ 顧客ID: "B", 受注日: "2026-01-10", 金額: "250" }),
];

test("CTE 1文形で各グループの最新行を全列付きで取得し、外側 WHERE を押し込まない", async () => {
  const client = makeClient(sales, [
    { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
    { code: "受注日", label: "受注日", fieldType: "DATE", sortKind: "string" },
    { code: "金額", label: "金額", fieldType: "NUMBER", sortKind: "number" },
  ]);
  const result = await execute(
    "WITH ranked AS (" +
      "SELECT 顧客ID, 受注日, 金額, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300" +
    ") SELECT 顧客ID, 受注日, 金額 FROM ranked WHERE rn = 1",
    client,
    { cacheContext: "window-cte-latest" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 顧客ID: "A", 受注日: "2026-02-01", 金額: "200" },
    { 顧客ID: "B", 受注日: "2026-01-15", 金額: "300" },
  ]);
  expect(client.getCalls.every((call) => !call.query.includes("rn"))).toBe(true);
});

test("SELECT しないウィンドウ ORDER BY キーを API 取得フィールドへ含める", async () => {
  const client = makeClient(sales);
  await execute(
    "SELECT 顧客ID, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300",
    client,
    { cacheContext: "window-required-fields" }
  );
  expect(client.getCalls[0].fields).toEqual(expect.arrayContaining(["顧客ID", "受注日"]));
});

test("トップレベル ORDER BY なしでも物理 NUMBER メタで数値順位になる", async () => {
  const client = makeClient(
    [record({ 顧客No: "99" }), record({ 顧客No: "214" }), record({ 顧客No: "100" })],
    [{ code: "顧客No", label: "顧客No", fieldType: "NUMBER", sortKind: "number" }]
  );
  const result = await execute(
    "SELECT 顧客No, ROW_NUMBER() OVER (ORDER BY 顧客No DESC) AS rn FROM APP300",
    client,
    { cacheContext: "window-number-meta" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { 顧客No: "99", rn: "3" }, { 顧客No: "214", rn: "1" }, { 顧客No: "100", rn: "2" },
  ]);
});

test("トップレベル ORDER BY なしでも選択肢定義順で順位付けする", async () => {
  const client = makeClient(
    [record({ 優先度: "中" }), record({ 優先度: "高" }), record({ 優先度: "低" })],
    [{
      code: "優先度", label: "優先度", fieldType: "DROP_DOWN", sortKind: "string",
      optionOrder: { 高: 0, 中: 1, 低: 2 },
    }]
  );
  const result = await execute(
    "SELECT 優先度, ROW_NUMBER() OVER (ORDER BY 優先度) AS rn FROM APP300",
    client,
    { cacheContext: "window-option-meta" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { 優先度: "中", rn: "2" }, { 優先度: "高", rn: "1" }, { 優先度: "低", rn: "3" },
  ]);
});

test("ウィンドウ評価後に DISTINCT とトップレベル ORDER BY を適用する", async () => {
  const client = makeClient(
    [record({ n: "1" }), record({ n: "1" }), record({ n: "2" })],
    [{ code: "n", label: "n", fieldType: "NUMBER", sortKind: "number" }]
  );
  const result = await execute(
    "SELECT DISTINCT RANK() OVER (ORDER BY n) AS r FROM APP300 ORDER BY r DESC",
    client,
    { cacheContext: "window-distinct-order" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ r: "3" }, { r: "1" }]);
});

test("EXPLAIN はウィンドウ CTE を FULL_SCAN としインライン化しない", async () => {
  const result = await execute(
    "EXPLAIN WITH ranked AS (" +
      "SELECT k, ROW_NUMBER() OVER (ORDER BY d DESC) AS rn FROM APP300" +
    ") SELECT k FROM ranked WHERE rn = 1",
    makeClient([]),
    { cacheContext: "window-explain" }
  ) as SelectResult;
  const plan = result.rows.map((row) => row.plan);
  expect(plan.some((line) => line.includes("[cte: ranked]"))).toBe(true);
  expect(plan.some((line) => line.includes("mode") && line.includes("FULL_SCAN"))).toBe(true);
  expect(plan.some((line) => line.includes("ウィンドウ関数あり"))).toBe(true);
  expect(plan.some((line) => line.includes("effective: inlined CTE"))).toBe(false);
});

test("一時テーブルへ実体化したウィンドウ列は数値メタを保持する", async () => {
  const client = makeClient(sales);
  const result = await executeBatch(
    "CREATE TEMP TABLE #ranked AS " +
      "SELECT 顧客ID, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日) AS rn FROM APP300;" +
    "SELECT MAX(rn) AS max_rn FROM #ranked",
    client,
    { cacheContext: "window-temp-meta" }
  );
  expect(result.ok).toBe(true);
  expect(result.statements[1].result).toMatchObject({ rows: [{ max_rn: "2" }] });
});

test("FROM なし OVER () は単一行へ 1 を付ける", async () => {
  const result = await execute(
    "SELECT ROW_NUMBER() OVER () AS rn",
    makeClient([]),
    { cacheContext: "window-no-from" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ rn: "1" }]);
});
