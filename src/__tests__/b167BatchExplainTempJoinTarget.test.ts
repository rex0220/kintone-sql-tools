import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  buildBatchExplainPlans,
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

const INVENTORY_APP = 4228;
const MASTER_APP = 4229;

const INVENTORY_FIELDS: KintoneFieldInfo[] = [
  { code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "個数_在庫計算用", label: "個数_在庫計算用", fieldType: "NUMBER" },
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "数", label: "数", fieldType: "NUMBER" },
];
const MASTER_FIELDS: KintoneFieldInfo[] = [
  { code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "仕入価格", label: "仕入価格", fieldType: "NUMBER" },
  { code: "日付", label: "日付", fieldType: "DATE" },
  { code: "数", label: "数", fieldType: "NUMBER" },
  { code: "メモ", label: "メモ", fieldType: "MULTI_LINE_TEXT" },
];

function record(id: string, values: Readonly<Record<string, unknown>>): KintoneRecord {
  return Object.fromEntries([
    ["$id", { value: id }],
    ...Object.entries(values).map(([code, value]) => [code, { value }]),
  ]) as KintoneRecord;
}

function makeClient(): KintoneClient & {
  readonly apiApps: number[];
  readonly recordApps: number[];
} {
  const apiApps: number[] = [];
  const recordApps: number[] = [];
  const rows: Readonly<Record<number, KintoneRecord[]>> = {
    [INVENTORY_APP]: [
      record("1", { 製品名: "A", 個数_在庫計算用: "2", 日付: "2025-08-04", 数: "1" }),
      record("2", { 製品名: "B", 個数_在庫計算用: "3", 日付: "2025-08-05", 数: "2" }),
    ],
    [MASTER_APP]: [
      record("11", { 製品名: "A", 仕入価格: "10", 日付: "2025-08-04", 数: "1", メモ: "A" }),
      record("12", { 製品名: "B", 仕入価格: "20", 日付: "2025-08-05", 数: "2", メモ: "B" }),
    ],
  };
  const observe = (app: number): void => {
    apiApps.push(app);
    if (app <= 0) throw new Error(`B167: app must be positive, got ${app}`);
  };
  return {
    apiApps,
    recordApps,
    async getRecords(params) {
      observe(params.app);
      recordApps.push(params.app);
      return { records: [...(rows[params.app] ?? [])] };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(app) {
      observe(app);
      return app === INVENTORY_APP ? [...INVENTORY_FIELDS] : [...MASTER_FIELDS];
    },
    async getProcessStatuses(app) {
      observe(app);
      return { enable: false, states: [] };
    },
    async getNumberPrecision(app) {
      observe(app);
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const TEMP_CREATE = "CREATE TEMP TABLE #z AS "
  + "SELECT 製品名, SUM(個数_在庫計算用) AS 在庫数 FROM APP4228 GROUP BY 製品名";
const TEMP_REVERSED = "SELECT SUM(z.在庫数 * m.仕入価格) AS メイン値 "
  + "FROM APP4229 m INNER JOIN #z z ON m.製品名 = z.製品名";
const TEMP_FORWARD = "SELECT SUM(z.在庫数 * m.仕入価格) AS メイン値 "
  + "FROM #z z INNER JOIN APP4229 m ON z.製品名 = m.製品名";
const CTE_PREFIX = "WITH z AS ("
  + "SELECT 製品名, SUM(個数_在庫計算用) AS 在庫数 FROM APP4228 GROUP BY 製品名) ";
const CTE_REVERSED = CTE_PREFIX + TEMP_REVERSED.replace("#z", "z");
const CTE_FORWARD = CTE_PREFIX + TEMP_FORWARD.replace("#z", "z");

describe("B167 batch EXPLAIN temp JOIN target", () => {
  test.each([
    ["起票逐語", `${TEMP_CREATE}; ${TEMP_REVERSED}`],
    ["起票逐語＋UNION ALL", `${TEMP_CREATE}; ${TEMP_REVERSED} UNION ALL SELECT 0 AS メイン値`],
    ["FROM #temp JOIN 物理", `${TEMP_CREATE}; ${TEMP_FORWARD}`],
    ["CTE 順配置・単文", CTE_FORWARD],
    ["CTE 逆配置・単文", CTE_REVERSED],
    ["CTE 順配置・バッチ", `SELECT 1 AS probe; ${CTE_FORWARD}`],
    ["CTE 逆配置・バッチ", `SELECT 1 AS probe; ${CTE_REVERSED}`],
  ])("%s は成功し app<=0 API 呼び出し 0 回", async (_name, sql) => {
    const client = makeClient();
    const result = await buildBatchExplainPlans(sql, client);
    expect(result.statements.length).toBeGreaterThan(0);
    expect(client.apiApps.filter((app) => app <= 0)).toEqual([]);
    expect(client.recordApps).toEqual([]);
  });

  test.each([
    ["temp 順配置", `${TEMP_CREATE}; ${TEMP_FORWARD}`, 1, ["80"]],
    ["temp 逆配置", `${TEMP_CREATE}; ${TEMP_REVERSED}`, 1, ["80"]],
    ["temp 逆配置＋UNION ALL", `${TEMP_CREATE}; ${TEMP_REVERSED} UNION ALL SELECT 0 AS メイン値`, 1, ["80", "0"]],
    ["CTE 順配置・バッチ", `SELECT 1 AS probe; ${CTE_FORWARD}`, 1, ["80"]],
    ["CTE 逆配置・バッチ", `SELECT 1 AS probe; ${CTE_REVERSED}`, 1, ["80"]],
  ] as const)("実行結果不変: %s", async (_name, sql, statementIndex, expected) => {
    const client = makeClient();
    const result = await executeBatch(sql, client);
    const select = result.statements[statementIndex].result as SelectResult;
    expect(select.rows.map((row) => row.メイン値)).toEqual(expected);
    expect(client.apiApps.filter((app) => app <= 0)).toEqual([]);
  });

  test.each([
    ["CTE 順配置・単文", CTE_FORWARD],
    ["CTE 逆配置・単文", CTE_REVERSED],
  ])("実行結果不変: %s", async (_name, sql) => {
    const client = makeClient();
    const result = await execute(sql, client) as SelectResult;
    expect(result.rows.map((row) => row.メイン値)).toEqual(["80"]);
    expect(client.apiApps.filter((app) => app <= 0)).toEqual([]);
  });

  test.each([
    [
      "range",
      "WITH s AS (GENERATE_SERIES('2025-08-04','2025-08-05') AS 日付) "
        + "SELECT s.日付 FROM s INNER JOIN APP4229 m ON s.日付=m.日付",
      "join key prefilter: range",
    ],
    [
      "in",
      "WITH s AS (GENERATE_SERIES(1,2) AS 数) "
        + "SELECT s.数 FROM s INNER JOIN APP4229 m ON s.数=m.数",
      "join key prefilter: in",
    ],
    [
      "fallback",
      "WITH s AS (GENERATE_SERIES(1,2) AS 数) "
        + "SELECT s.数 FROM s INNER JOIN APP4229 m ON s.数=m.メモ",
      "join key prefilter reason: JOIN_KEY_OPERATOR_UNAVAILABLE",
    ],
  ])("B150 CTE→APP の型別 prefilter 表示不変: %s", async (_kind, sql, expected) => {
    const client = makeClient();
    const result = await buildBatchExplainPlans(sql, client);
    expect(result.statements[0].plan.join("\n")).toContain(expected);
    expect(client.recordApps).toEqual([]);
    expect(client.apiApps.filter((app) => app <= 0)).toEqual([]);
  });
});
