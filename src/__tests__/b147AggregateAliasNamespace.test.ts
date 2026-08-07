import type { KintoneRecord } from "../converter/dmlToKintone";
import { execute, type KintoneClient, type SelectResult } from "../execute";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

const records = [
  record({ $id: "1", 製品名: "食パン", 個数: "646", 日付: "2025-08-01", 入出庫区分: "入庫" }),
  record({ $id: "2", 製品名: "食パン", 個数: "646", 日付: "2025-08-15", 入出庫区分: "出庫" }),
  record({ $id: "3", 製品名: "牛乳", 個数: "706", 日付: "2025-09-01", 入出庫区分: "入庫" }),
  record({ $id: "4", 製品名: "りんご", 個数: "27", 日付: "2025-10-01", 入出庫区分: "入庫" }),
  record({ $id: "5", 製品名: "りんご", 個数: "27", 日付: "2025-10-02", 入出庫区分: "出庫" }),
];

function client(): KintoneClient {
  return {
    async getRecords(params) {
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: records.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected mutation"); },
    async putRecords() { throw new Error("unexpected mutation"); },
    async deleteRecords() { throw new Error("unexpected mutation"); },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "製品名", label: "製品名", fieldType: "SINGLE_LINE_TEXT" },
        { code: "個数", label: "個数", fieldType: "NUMBER" },
        { code: "日付", label: "日付", fieldType: "DATE" },
        { code: "入出庫区分", label: "入出庫区分", fieldType: "SINGLE_LINE_TEXT" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

async function select(sql: string, cacheContext: string): Promise<SelectResult> {
  return await execute(sql, client(), { cacheContext }) as SelectResult;
}

describe("B147 SELECT materialized alias namespace", () => {
  test.each([
    [
      "日付関数",
      "SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) AS 日付 FROM APP147 GROUP BY 年月 ORDER BY 年月",
      [
        { 年月: "2025-08", 日付: "1292" },
        { 年月: "2025-09", 日付: "706" },
        { 年月: "2025-10", 日付: "54" },
      ],
      ["年月", "日付"],
    ],
    [
      "算術式",
      "SELECT 個数*2 AS 倍, SUM(個数) AS 個数 FROM APP147 GROUP BY 製品名, 個数 ORDER BY 倍 DESC",
      [
        { 倍: "1412", 個数: "706" },
        { 倍: "1292", 個数: "1292" },
        { 倍: "54", 個数: "54" },
      ],
      ["倍", "個数"],
    ],
    [
      "文字列連結",
      "SELECT 製品名||'-x' AS 加工名, SUM(個数) AS 製品名 FROM APP147 GROUP BY 製品名 ORDER BY 加工名",
      [
        { 加工名: "りんご-x", 製品名: "54" },
        { 加工名: "牛乳-x", 製品名: "706" },
        { 加工名: "食パン-x", 製品名: "1292" },
      ],
      ["加工名", "製品名"],
    ],
    [
      "CASE",
      "SELECT CASE WHEN 個数>40 THEN '大' ELSE '小' END AS 区分, SUM(個数) AS 個数 " +
        "FROM APP147 GROUP BY 製品名, 個数 ORDER BY 個数 DESC",
      [
        { 区分: "大", 個数: "1292" },
        { 区分: "大", 個数: "706" },
        { 区分: "小", 個数: "54" },
      ],
      ["区分", "個数"],
    ],
  ])("%s は2件以上のグループでも source 値を参照する", async (_name, sql, rows, columns) => {
    const result = await select(sql, `b147-${_name}`);
    expect(result).toMatchObject({ rows, columns, rowCount: rows.length });
    expect(result.warnings ?? []).toEqual([]);
  });

  test("SELECT 列順を逆にしても source 値を参照する", async () => {
    const result = await select(
      "SELECT SUM(個数) AS 個数, 個数*2 AS 倍 FROM APP147 GROUP BY 製品名, 個数 ORDER BY 倍 DESC",
      "b147-column-order"
    );
    expect(result).toMatchObject({
      columns: ["個数", "倍"],
      rows: [
        { 個数: "706", 倍: "1412" },
        { 個数: "1292", 倍: "1292" },
        { 個数: "54", 倍: "54" },
      ],
      rowCount: 3,
    });
  });

  test("同名 alias と衝突する複数の SELECT 式が同じ source 値を参照する", async () => {
    const result = await select(
      "SELECT 個数*2 AS 倍, CASE WHEN 個数>100 THEN '大' ELSE '小' END AS 区分, " +
        "SUM(個数) AS 個数 FROM APP147 GROUP BY 製品名, 個数 ORDER BY 個数 DESC",
      "b147-multiple-source-expressions"
    );
    expect(result).toMatchObject({
      columns: ["倍", "区分", "個数"],
      rows: [
        { 倍: "1292", 区分: "大", 個数: "1292" },
        { 倍: "1412", 区分: "大", 個数: "706" },
        { 倍: "54", 区分: "小", 個数: "54" },
      ],
      rowCount: 3,
    });
  });

  test("HAVING と通常 ORDER BY は衝突する集計 alias を引き続き参照する", async () => {
    const result = await select(
      "SELECT 製品名 AS 商品, SUM(個数) AS 個数 FROM APP147 GROUP BY 製品名 " +
        "HAVING 個数>=700 ORDER BY 個数 DESC",
      "b147-having-order-alias"
    );
    expect(result).toMatchObject({
      columns: ["商品", "個数"],
      rows: [{ 商品: "食パン", 個数: "1292" }, { 商品: "牛乳", 個数: "706" }],
      rowCount: 2,
    });
  });

  test("自然な同名 aggregate alias はエラーや warning にしない", async () => {
    const result = await select(
      "SELECT 製品名, SUM(個数) AS 個数 FROM APP147 GROUP BY 製品名 ORDER BY 製品名",
      "b147-natural-alias"
    );
    expect(result.rowCount).toBe(3);
    expect(result.columns).toEqual(["製品名", "個数"]);
    expect(result.warnings ?? []).toEqual([]);
  });

  test("ウィンドウ alias は素の SELECT の入力フィールドを上書きしない", async () => {
    const result = await select(
      "SELECT 個数*2 AS 倍, ROW_NUMBER() OVER (ORDER BY $id) AS 個数 " +
        "FROM APP147 WHERE 製品名='りんご' ORDER BY $id",
      "b147-window-alias"
    );
    expect(result).toMatchObject({
      columns: ["倍", "個数"],
      rows: [{ 倍: "54", 個数: "1" }, { 倍: "54", 個数: "2" }],
      rowCount: 2,
    });
  });

  test("DISTINCT の tuple と公開結果へ内部 slot を露出しない", async () => {
    const result = await select(
      "SELECT DISTINCT 個数*2 AS 倍, SUM(個数) AS 個数 " +
        "FROM APP147 WHERE 製品名='食パン' GROUP BY 製品名, 個数",
      "b147-distinct-no-leak"
    );
    expect(result).toMatchObject({
      columns: ["倍", "個数"],
      rows: [{ 倍: "1292", 個数: "1292" }],
      rowCount: 1,
    });
    expect(Object.keys(result.rows[0])).toEqual(["倍", "個数"]);
  });

  test("CTE の公開出力は下流 query block の通常入力になる", async () => {
    const result = await select(
      "WITH m AS (SELECT 製品名, SUM(個数) AS 個数 FROM APP147 " +
        "WHERE 製品名='食パン' GROUP BY 製品名) SELECT 個数*2 AS 倍 FROM m",
      "b147-cte-boundary"
    );
    expect(result).toMatchObject({ columns: ["倍"], rows: [{ 倍: "2584" }], rowCount: 1 });
  });
});
