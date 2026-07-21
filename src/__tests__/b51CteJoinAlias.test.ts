import { execute, executeBatch, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function clientFor(recordsByApp: Record<number, KintoneRecord[]>): KintoneClient {
  return {
    async getRecords(params) { return { records: recordsByApp[params.app] ?? [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields(appId) {
      const fields = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...fields].filter((field) => !field.startsWith("$"))
        .map((field) => ({ code: field, label: field, fieldType: "SINGLE_LINE_TEXT" }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const apps = {
  100: [
    record({ レコード番号: "1", 都道府県: "岐阜県" }),
    record({ レコード番号: "2", 都道府県: "岐阜県" }),
    record({ レコード番号: "3", 都道府県: "愛知県" }),
  ],
  200: [
    record({ レコード番号: "1", 郵便番号: "5008334" }),
    record({ レコード番号: "2", 郵便番号: "5020834" }),
  ],
};

test("B51: 暗黙 CTE 名の CTE 間 INNER JOIN は正確な2行を返す", async () => {
  const result = await execute(
    "WITH a AS (SELECT レコード番号 AS aid, 都道府県 FROM APP100), " +
      "b AS (SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP200) " +
      "SELECT a.aid, b.bid, b.bzip FROM a INNER JOIN b ON a.aid = b.bid ORDER BY a.aid",
    clientFor(apps)
  ) as SelectResult;

  expect(result.rows).toEqual([
    { aid: "1", bid: "1", bzip: "5008334" },
    { aid: "2", bid: "2", bzip: "5020834" },
  ]);
});

test("B51: 暗黙 CTE 名の LEFT JOIN は左3行と未一致行を保持する", async () => {
  const result = await execute(
    "WITH a AS (SELECT レコード番号 AS aid, 都道府県 FROM APP100), " +
      "b AS (SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP200) " +
      "SELECT a.aid, a.都道府県, b.bzip FROM a LEFT JOIN b ON a.aid = b.bid ORDER BY a.aid",
    clientFor(apps)
  ) as SelectResult;

  expect(result.rows).toEqual([
    { aid: "1", 都道府県: "岐阜県", bzip: "5008334" },
    { aid: "2", 都道府県: "岐阜県", bzip: "5020834" },
    { aid: "3", 都道府県: "愛知県", bzip: "" },
  ]);
});

test("B51: 列別名なしでも暗黙 CTE 名で修飾列を解決する", async () => {
  const result = await execute(
    "WITH a AS (SELECT レコード番号, 都道府県 FROM APP100), " +
      "b AS (SELECT レコード番号, 郵便番号 FROM APP200) " +
      "SELECT a.レコード番号, a.都道府県, b.レコード番号, b.郵便番号 " +
      "FROM a INNER JOIN b ON a.レコード番号 = b.レコード番号 ORDER BY a.レコード番号",
    clientFor(apps)
  ) as SelectResult;

  expect(result.columns).toEqual(["a.レコード番号", "都道府県", "b.レコード番号", "郵便番号"]);
  expect(result.rows).toEqual([
    { "a.レコード番号": "1", 都道府県: "岐阜県", "b.レコード番号": "1", 郵便番号: "5008334" },
    { "a.レコード番号": "2", 都道府県: "岐阜県", "b.レコード番号": "2", 郵便番号: "5020834" },
  ]);
});

test("B51: 明示 alias は CTE 名より優先される", async () => {
  const result = await execute(
    "WITH a AS (SELECT レコード番号 AS aid FROM APP100), " +
      "b AS (SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP200) " +
      "SELECT x.aid, y.bzip FROM a AS x INNER JOIN b AS y ON x.aid = y.bid ORDER BY x.aid",
    clientFor(apps)
  ) as SelectResult;

  expect(result.rows).toEqual([
    { aid: "1", bzip: "5008334" },
    { aid: "2", bzip: "5020834" },
  ]);
});

test("B51: 実行時 effective alias は単一 CTE の SELECT * 出力へ露出しない", async () => {
  const result = await execute(
    "WITH c AS (SELECT 都道府県, COUNT(*) AS cnt FROM APP100 GROUP BY 都道府県) " +
      "SELECT * FROM c ORDER BY 都道府県",
    clientFor(apps)
  ) as SelectResult;

  expect(result.columns).toEqual(["都道府県", "cnt"]);
  expect(result.rows).toEqual([
    { 都道府県: "岐阜県", cnt: "2" },
    { 都道府県: "愛知県", cnt: "1" },
  ]);
  expect(Object.keys(result.rows[0]).some((key) => key.startsWith("c."))).toBe(false);
});

test.each(["INNER", "LEFT"])("B51: 単一 CTE から物理アプリへの %s JOIN で CTE 側キーを修飾する", async (joinType) => {
  const result = await execute(
    "WITH a AS (SELECT レコード番号 AS aid, 都道府県 FROM APP100) " +
      `SELECT a.aid, b.郵便番号 FROM a ${joinType} JOIN APP200 AS b ON a.aid = b.レコード番号 ORDER BY a.aid`,
    clientFor(apps)
  ) as SelectResult;

  expect(result.rows).toEqual(joinType === "INNER" ? [
    { aid: "1", 郵便番号: "5008334" },
    { aid: "2", 郵便番号: "5020834" },
  ] : [
    { aid: "1", 郵便番号: "5008334" },
    { aid: "2", 郵便番号: "5020834" },
    { aid: "3", 郵便番号: "" },
  ]);
});

test("B51: alias なし一時テーブル同士の JOIN も source 名で識別する", async () => {
  const batch = await executeBatch(
    "CREATE TEMP TABLE #a AS SELECT レコード番号 AS aid FROM APP100;" +
      "CREATE TEMP TABLE #b AS SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP200;" +
      "SELECT aid, bid, bzip FROM #a INNER JOIN #b ON aid = bid ORDER BY aid",
    clientFor(apps)
  );

  expect(batch.ok).toBe(true);
  expect((batch.statements[2].result as SelectResult).rows).toEqual([
    { aid: "1", bid: "1", bzip: "5008334" },
    { aid: "2", bid: "2", bzip: "5020834" },
  ]);
});

test("B51: JOIN 参照列不存在は空文字直積にせず拒否する", async () => {
  await expect(execute(
    "WITH a AS (SELECT レコード番号 AS aid FROM APP100), " +
      "b AS (SELECT レコード番号 AS bid FROM APP200) " +
      "SELECT a.aid, b.bid FROM a INNER JOIN b ON a.missing = b.bid",
    clientFor(apps)
  )).rejects.toThrow(/JOIN key a\.missing is not available/);
});

test("B51: 0行 CTE も保存済み columns で JOIN 参照列不存在を拒否する", async () => {
  await expect(execute(
    "WITH a AS (SELECT レコード番号 AS aid FROM APP300 GROUP BY レコード番号), " +
      "b AS (SELECT レコード番号 AS bid FROM APP200) " +
      "SELECT a.aid, b.bid FROM a INNER JOIN b ON a.missing = b.bid",
    clientFor(apps)
  )).rejects.toThrow(/JOIN key a\.missing is not available/);
});

test("B51: effective alias が CTE 名と明示物理 alias で衝突したら拒否する", async () => {
  await expect(execute(
    "WITH a AS (SELECT レコード番号 AS aid FROM APP100) " +
      "SELECT a.aid FROM a INNER JOIN APP200 AS a ON a.aid = a.レコード番号",
    clientFor(apps)
  )).rejects.toThrow(/effective alias a is used by multiple tables/);
});

test("B51: WHERE・GROUP BY・ORDER BY は暗黙 CTE 名の修飾参照とメタデータを共有する", async () => {
  const result = await execute(
    "WITH a AS (SELECT レコード番号 AS aid, 都道府県 FROM APP100), " +
      "b AS (SELECT レコード番号 AS bid FROM APP200) " +
      "SELECT a.都道府県, COUNT(*) AS cnt FROM a INNER JOIN b ON a.aid = b.bid " +
      "WHERE a.都道府県 = '岐阜県' GROUP BY a.都道府県 ORDER BY a.都道府県",
    clientFor(apps)
  ) as SelectResult;

  expect(result.rows).toEqual([{ 都道府県: "岐阜県", cnt: "2" }]);
});
