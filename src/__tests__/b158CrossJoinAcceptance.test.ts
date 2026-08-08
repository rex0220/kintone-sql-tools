import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  executeBatch,
  getSelectColumnMeta,
  type KintoneClient,
  type SelectResult,
} from "../execute";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

function client(recordsByApp: Record<number, KintoneRecord[]> = {}) {
  const calls = { records: [] as Array<{ app: number; query: string }>, fields: 0, mutations: 0 };
  const mock: KintoneClient = {
    async getRecords(params) {
      calls.records.push({ app: params.app, query: params.query });
      let rows = [...(recordsByApp[params.app] ?? [])];
      const upper = /\$id\s*<=\s*(\d+)/i.exec(params.query);
      if (upper) rows = rows.filter((row) => Number(row.$id?.value ?? 0) <= Number(upper[1]));
      const limit = Number(/\blimit\s+(\d+)/i.exec(params.query)?.[1] ?? 500);
      const offset = Number(/\boffset\s+(\d+)/i.exec(params.query)?.[1] ?? 0);
      return { records: rows.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { calls.mutations++; return { ids: [] }; },
    async putRecords() { calls.mutations++; },
    async deleteRecords() { calls.mutations++; },
    async getApps() { return []; },
    async getFields(appId) {
      calls.fields++;
      const codes = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...codes].filter((code) => !code.startsWith("$")).map((code) => ({
        code,
        label: code,
        fieldType: code === "日付" ? "DATE"
          : code === "個数_在庫計算用" ? "NUMBER"
          : "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
  return { mock, calls };
}

async function run(sql: string, mock = client().mock, captureColumnMeta = false): Promise<SelectResult> {
  return await execute(sql, mock, {
    captureColumnMeta,
    cacheContext: `b158-${Math.random()}`,
  }) as SelectResult;
}

describe("B158 CROSS JOIN acceptance", () => {
  test("§11.1 基本直積を逐語 SQL で 3×2 行生成する", async () => {
    const result = await run(`WITH
a AS (GENERATE_SERIES(1, 3) AS x),
b AS (GENERATE_SERIES(10, 20, 10) AS y)
SELECT a.x, b.y
FROM a
CROSS JOIN b
ORDER BY a.x, b.y`);
    expect(result).toMatchObject({
      rowCount: 6,
      rows: [
        { x: "1", y: "10" }, { x: "1", y: "20" },
        { x: "2", y: "10" }, { x: "2", y: "20" },
        { x: "3", y: "10" }, { x: "3", y: "20" },
      ],
    });
  });

  test("§11.2 空側と左右反転はいずれも 0 行", async () => {
    for (const from of ["a CROSS JOIN b", "b CROSS JOIN a"]) {
      const result = await run(
        `WITH a AS (GENERATE_SERIES(1,5,-1) AS x),b AS (GENERATE_SERIES(1,3) AS y) ` +
        `SELECT * FROM ${from}`
      );
      expect(result.rowCount).toBe(0);
    }
  });

  test("§11.3 10,000 は成功、10,100 と多段超過は行生成前に失敗", async () => {
    await expect(run(
      "WITH a AS (GENERATE_SERIES(1,100) AS x),b AS (GENERATE_SERIES(1,100) AS y) " +
      "SELECT a.x,b.y FROM a CROSS JOIN b"
    )).resolves.toMatchObject({ rowCount: 10_000 });
    await expect(run(
      "WITH a AS (GENERATE_SERIES(1,101) AS x),b AS (GENERATE_SERIES(1,100) AS y) " +
      "SELECT a.x,b.y FROM a CROSS JOIN b LIMIT 1"
    )).rejects.toThrow(
      "ArgumentError: CROSS JOIN の生成件数 10100 行（左 101 行 × 右 100 行）が上限 10000 行を超えています。"
    );
    await expect(run(
      "WITH a AS (GENERATE_SERIES(1,30) AS x),b AS (GENERATE_SERIES(1,30) AS y)," +
      "c AS (GENERATE_SERIES(1,12) AS z) SELECT * FROM a CROSS JOIN b CROSS JOIN c"
    )).rejects.toThrow("生成件数 10800 行（左 900 行 × 右 12 行）");
  });

  test("§8 alias-local WHERE leaf を CROSS JOIN の物理 APP にだけ送る", async () => {
    const { mock, calls } = client({
      4229: Array.from({ length: 12 }, (_, index) => record({
        $id: String(index + 1), 製品名: `P${index + 1}`,
      })),
    });
    const result = await run(`WITH s AS (GENERATE_SERIES(1,365) AS n)
SELECT s.n,m.製品名 FROM s CROSS JOIN APP4229 AS m
WHERE m.$id <= 8 ORDER BY s.n,m.$id`, mock);
    expect(result.rowCount).toBe(2920);
    expect(calls.records[0]).toEqual({
      app: 4229,
      query: "$id <= 8 order by $id asc limit 500 offset 0",
    });
  });

  test("§11.5 APP×APP は alias ごとの WHERE leaf を分離する", async () => {
    const { mock, calls } = client({
      100: Array.from({ length: 12 }, (_, i) => record({ $id: String(i + 1) })),
      200: Array.from({ length: 22 }, (_, i) => record({ $id: String(i + 1) })),
    });
    const result = await run(`SELECT a.$id AS a_id,b.$id AS b_id
FROM APP100 AS a CROSS JOIN APP200 AS b
WHERE a.$id <= 10 AND b.$id <= 20 ORDER BY a.$id,b.$id`, mock);
    expect(result.rowCount).toBe(200);
    expect(calls.records.find((call) => call.app === 100)?.query).toContain("$id <= 10");
    expect(calls.records.find((call) => call.app === 200)?.query).toContain("$id <= 20");
    expect(calls.records.find((call) => call.app === 100)?.query).not.toContain("$id <= 20");
  });

  test("temp table × CTE も同じ直積と guard を使う", async () => {
    const batch = await executeBatch(
      "CREATE TEMP TABLE #a AS WITH a AS (GENERATE_SERIES(1,2) AS x) SELECT x FROM a; " +
      "WITH b AS (GENERATE_SERIES(10,20,10) AS y) SELECT x,y FROM #a CROSS JOIN b ORDER BY x,y;",
      client().mock,
      { cacheContext: "b158-temp" }
    );
    expect((batch.statements[1].result as SelectResult).rows).toEqual([
      { x: "1", y: "10" }, { x: "1", y: "20" },
      { x: "2", y: "10" }, { x: "2", y: "20" },
    ]);
  });

  test("§11.6 サブテーブルは親取得後の展開行数で判定する", async () => {
    const detail = (id: string, value: string) => ({
      id,
      value: { 商品: { type: "SINGLE_LINE_TEXT", value } },
    });
    const parents = [{
      $id: { type: "__ID__", value: "1" },
      明細: {
        type: "SUBTABLE",
        value: Array.from({ length: 50 }, (_, i) => detail(String(i + 1), `P${i + 1}`)),
      },
    }] as unknown as KintoneRecord[];
    const base = client({ 100: parents });
    base.mock.getFields = async () => [
      { code: "明細", label: "明細", fieldType: "SUBTABLE" },
      { code: "商品", label: "商品", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "明細" },
    ];
    const result = await run(
      "WITH s AS (GENERATE_SERIES(1,3) AS n) " +
      "SELECT d.商品,s.n FROM APP100$明細 AS d CROSS JOIN s ORDER BY d.商品,s.n",
      base.mock
    );
    expect(result.rowCount).toBe(150);
  });

  test("CROSS_JOIN は truncate を無効化し maxRecords 超過を先に返す", async () => {
    const { mock } = client({
      100: [record({ $id: "1" }), record({ $id: "2" }), record({ $id: "3" })],
    });
    await expect(execute(
      "WITH s AS (GENERATE_SERIES(1,2) AS n) SELECT a.$id,s.n FROM APP100 a CROSS JOIN s",
      mock,
      { maxRecords: 2, onLimitReached: "truncate", cacheContext: "b158-complete" }
    )).rejects.toThrow(/complete input reason: CROSS_JOIN。onLimit=truncateは使用できません/);
  });

  test("DML source の guard 超過は mutation API より前に失敗する", async () => {
    const { mock, calls } = client();
    mock.getFields = async (appId) => appId === 300 ? [
      { code: "x", label: "x", fieldType: "NUMBER", writable: true },
      { code: "y", label: "y", fieldType: "NUMBER", writable: true },
    ] : [];
    const batch = await executeBatch(
      "CREATE TEMP TABLE #a AS WITH a AS (GENERATE_SERIES(1,101) AS x) SELECT x FROM a; " +
      "CREATE TEMP TABLE #b AS WITH b AS (GENERATE_SERIES(1,100) AS y) SELECT y FROM b; " +
      "INSERT INTO APP300 (x,y) SELECT a.x,b.y FROM #a a CROSS JOIN #b b;",
      mock,
      { cacheContext: "b158-dml" }
    );
    expect(batch.statements[2]).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("CROSS JOIN の生成件数 10100 行") },
    });
    expect(calls.mutations).toBe(0);
  });

  test("§10 EXPLAIN は exact/runtime を区別し records API 0 回", async () => {
    const { mock, calls } = client();
    const exact = await run(
      "EXPLAIN WITH a AS (GENERATE_SERIES(1,3) AS x),b AS (GENERATE_SERIES(1,4) AS y) " +
      "SELECT a.x,b.y FROM a CROSS JOIN b",
      mock
    );
    const exactPlan = exact.rows.map((row) => row.plan).join("\n");
    for (const text of [
      "cross join:    a × b", "left rows:     3", "right rows:    4",
      "rows:          12", "row guard:     12 / 10000",
      "guard timing:  before row materialization", "complete input reason: CROSS_JOIN",
    ]) expect(exactPlan).toContain(text);

    const runtime = await run(
      "EXPLAIN WITH d AS (GENERATE_SERIES('2026-01-01','2026-12-31') AS 日付) " +
      "SELECT d.日付,m.製品名 FROM d CROSS JOIN APP4229 AS m",
      mock
    );
    const runtimePlan = runtime.rows.map((row) => row.plan).join("\n");
    for (const text of [
      "cross join:    d × m", "left rows:     365",
      "right rows:    runtime (APP4229 fetched rows)",
      "rows:          runtime (365 × right rows)",
      "row guard:     runtime checked / 10000",
      "guard timing:  after complete source fetch, before row materialization",
    ]) expect(runtimePlan).toContain(text);
    expect(runtimePlan).not.toContain("join key prefilter:");
    expect(calls.records).toEqual([]);
  });

  test("§12 R17 製品別暦日形を掲載どおり実行する", async () => {
    const { mock } = client({
      4229: [record({ $id: "1", 製品名: "A" }), record({ $id: "2", 製品名: "B" })],
      4228: [
        record({ 日付: "2025-08-01", 製品名: "A", 個数_在庫計算用: "3" }),
        record({ 日付: "2025-08-01", 製品名: "A", 個数_在庫計算用: "-1" }),
        record({ 日付: "2025-08-03", 製品名: "A", 個数_在庫計算用: "4" }),
        record({ 日付: "2025-08-02", 製品名: "B", 個数_在庫計算用: "5" }),
      ],
    });
    const result = await run(`WITH
日付系列 AS (
  GENERATE_SERIES('2025-08-01', '2026-07-31', '1 day') AS 日付
),
製品マスタ AS (
  SELECT 製品名
  FROM APP4229
),
日次実績 AS (
  SELECT
    日付,
    製品名,
    CONCAT(日付, '|', 製品名) AS 格子キー,
    SUM(個数_在庫計算用) AS 日次増減
  FROM APP4228
  GROUP BY 日付, 製品名
),
格子 AS (
  SELECT
    d.日付,
    m.製品名,
    CONCAT(d.日付, '|', m.製品名) AS 格子キー
  FROM 日付系列 AS d
  CROSS JOIN 製品マスタ AS m
),
0埋め AS (
  SELECT
    g.日付,
    g.製品名,
    CASE
      WHEN f.日次増減 = '' THEN 0
      ELSE f.日次増減
    END AS 日次増減
  FROM 格子 AS g
  LEFT JOIN 日次実績 AS f ON g.格子キー = f.格子キー
)
SELECT
  日付,
  製品名,
  日次増減,
  SUM(日次増減) OVER (
    PARTITION BY 製品名
    ORDER BY 日付
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS 暦日在庫
FROM 0埋め
ORDER BY 製品名, 日付`, mock, true);
    expect(result.rowCount).toBe(730);
    expect(result.rows.slice(0, 4)).toEqual([
      { 日付: "2025-08-01", 製品名: "A", 日次増減: "2", 暦日在庫: "2" },
      { 日付: "2025-08-02", 製品名: "A", 日次増減: "0", 暦日在庫: "2" },
      { 日付: "2025-08-03", 製品名: "A", 日次増減: "4", 暦日在庫: "6" },
      { 日付: "2025-08-04", 製品名: "A", 日次増減: "0", 暦日在庫: "6" },
    ]);
    expect(getSelectColumnMeta(result)?.get("日付")).toMatchObject({ fieldType: "DATE" });
    expect(getSelectColumnMeta(result)?.get("暦日在庫")).toMatchObject({ sortKind: "number" });
  });
});
