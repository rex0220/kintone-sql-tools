import { execute, executeBatch, type KintoneClient, type SelectResult } from "../execute";
import type { PageFetchParams } from "../api/fetchAll";

function makeClient(): KintoneClient & { getCalls: PageFetchParams[]; writeCalls: number } {
  const getCalls: PageFetchParams[] = [];
  const client: KintoneClient & { getCalls: PageFetchParams[]; writeCalls: number } = {
    getCalls,
    writeCalls: 0,
    async getRecords(params) {
      getCalls.push(params);
      return { records: [{
        $id: { value: "1" },
        ID: { value: "A" },
        件名: { value: "至急対応" },
        備考: { value: "緊急対応" },
      }] };
    },
    async postRecords() { client.writeCalls++; return { ids: [] }; },
    async putRecords() { client.writeCalls++; },
    async deleteRecords() { client.writeCalls++; },
    async getApps() { return []; },
    async getFields() { return []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
  return client;
}

test("SIMPLE SELECT は KLIKE を kintone query に載せて実行する", async () => {
  const client = makeClient();
  const result = await execute(
    "SELECT $id, 件名 FROM APP100 WHERE 件名 KLIKE '至急' LIMIT 1",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(client.getCalls[0].query).toContain('件名 like "至急"');
});

test("EXPLAIN は KLIKE の SIMPLE kintone query を表示する", async () => {
  const client = makeClient();
  const result = await execute(
    "EXPLAIN SELECT 件名 FROM APP100 WHERE 件名 NOT KLIKE '保留'",
    client
  ) as SelectResult;
  expect(result.rows.some((row) => String(row.plan).includes('件名 not like "保留"'))).toBe(true);
  expect(client.getCalls).toHaveLength(0);
});

test("FULL_SCAN KLIKE を押し下げ、DISTINCT は JS 側で処理する", async () => {
  const client = makeClient();
  const result = await execute(
    "SELECT DISTINCT 件名 FROM APP100 WHERE 件名 KLIKE '至急'",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(client.getCalls.some((call) => call.query.includes('件名 like "至急"'))).toBe(true);
});

test("FULL_SCAN の直接 NOT KLIKE を not like として押し下げる", async () => {
  const client = makeClient();
  const result = await execute(
    "SELECT DISTINCT 件名 FROM APP100 WHERE 件名 NOT KLIKE '保留'",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(client.getCalls.some((call) => call.query.includes('件名 not like "保留"'))).toBe(true);
});

test("KLIKE で粗く絞り、LIKE を JavaScript で精製する", async () => {
  const client = makeClient();
  const result = await execute(
    "SELECT 件名 FROM APP100 WHERE 件名 KLIKE '至急' AND 備考 LIKE '%緊急%'",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(client.getCalls.some((call) => call.query.includes('件名 like "至急"'))).toBe(true);
});

test("インライン化した CTE でも同じ AST の KLIKE 計画を使う", async () => {
  const client = makeClient();
  const result = await execute(
    "WITH c AS (SELECT * FROM APP100 WHERE 件名 KLIKE '至急') "
    + "SELECT 件名 FROM c AS x WHERE x.備考 LIKE '%緊急%'",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(client.getCalls.some((call) => call.query.includes('件名 like "至急"'))).toBe(true);
});

test("EXPLAIN FULL_SCAN は共有計画の KLIKE クエリを表示する", async () => {
  const client = makeClient();
  const result = await execute(
    "EXPLAIN SELECT 件名 FROM APP100 WHERE 件名 KLIKE '至急' AND 備考 LIKE '%緊急%'",
    client
  ) as SelectResult;
  expect(result.rows.some((row) => String(row.plan).includes('件名 like "至急"'))).toBe(true);
  expect(client.getCalls).toHaveLength(0);
});

test.each(["LEFT", "RIGHT"])("%s JOIN の KLIKE は API 呼び出し前に拒否する", async (joinType) => {
  const client = makeClient();
  await expect(execute(
    `SELECT a.件名 FROM APP100 a ${joinType} JOIN APP200 b ON a.ID = b.ID WHERE a.件名 KLIKE '至急'`,
    client
  )).rejects.toThrow(/LEFT \/ RIGHT JOIN/);
  expect(client.getCalls).toHaveLength(0);
});

test.each([
  "SELECT DISTINCT 件名 FROM APP100 WHERE 件名 KLIKE '至急' OR 備考 = 'A'",
  "SELECT DISTINCT 件名 FROM APP100 WHERE NOT (件名 KLIKE '至急')",
])("OR / NOT 配下の FULL_SCAN KLIKE は API 呼び出し前に拒否する — %s", async (sql) => {
  const client = makeClient();
  await expect(execute(sql, client)).rejects.toThrow(/OR \/ NOT/);
  expect(client.getCalls).toHaveLength(0);
});

test("INNER JOIN の KLIKE を対象テーブルへ押し下げる", async () => {
  const client = makeClient();
  const result = await execute(
    "SELECT a.件名 FROM APP100 a INNER JOIN APP200 b ON a.ID = b.ID WHERE a.件名 KLIKE '至急' AND b.備考 LIKE '%緊急%'",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  const mainCall = client.getCalls.find((call) => call.app === 100);
  expect(mainCall?.query).toContain('件名 like "至急"');
});

test("KLIKE を含む DML は対象取得・書き込み前に拒否する", async () => {
  const client = makeClient();
  await expect(execute(
    "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
    client
  )).rejects.toThrow(/全 DML/);
  expect(client.getCalls).toHaveLength(0);
  expect(client.writeCalls).toBe(0);
});

test.each([
  ["DECLARE @q = 'ok'; SELECT 件名 FROM APP100 WHERE 件名 KLIKE @q", undefined, true],
  ["DECLARE @q = 'ok'; SELECT 件名 FROM APP100 WHERE 件名 KLIKE @q", { q: "A%B" }, false],
  ["SET @q = 1; SELECT 件名 FROM APP100 WHERE 件名 KLIKE @q", undefined, false],
] as const)("バッチ変数置換後にも KLIKE の文字列型と %% を検証する", async (sql, variables, succeeds) => {
  const client = makeClient();
  const result = await executeBatch(sql, client, { variables });
  const selectResult = result.statements[1];
  expect(selectResult.status).toBe(succeeds ? "success" : "error");
  if (succeeds) {
    expect(client.getCalls.some((call) => call.query.includes('件名 like "ok"'))).toBe(true);
  } else {
    expect(client.getCalls).toHaveLength(0);
    expect(selectResult.error?.code).toBe("ArgumentError");
  }
});

test("FULL_SCAN のバッチ変数 KLIKE は置換後の共有計画へ入る", async () => {
  const client = makeClient();
  const result = await executeBatch(
    "DECLARE @q = '至急'; SELECT 件名 FROM APP100 WHERE 件名 KLIKE @q AND 備考 LIKE '%緊急%'",
    client
  );
  expect(result.statements[1].status).toBe("success");
  expect(client.getCalls.some((call) => call.query.includes('件名 like "至急"'))).toBe(true);
});
