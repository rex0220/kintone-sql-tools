import { execute, executeBatch, SearchAbortedError, type KintoneClient, type SelectResult } from "../execute";
import type { PageFetchParams } from "../api/fetchAll";
import type { KintoneDeleteParams, KintonePutParams } from "../converter/dmlToKintone";

function makeClient(options: { searchAborted?: boolean } = {}): KintoneClient & {
  getCalls: PageFetchParams[];
  putCalls: KintonePutParams[];
  deleteCalls: KintoneDeleteParams[];
  writeCalls: number;
} {
  const getCalls: PageFetchParams[] = [];
  const putCalls: KintonePutParams[] = [];
  const deleteCalls: KintoneDeleteParams[] = [];
  const client: KintoneClient & {
    getCalls: PageFetchParams[];
    putCalls: KintonePutParams[];
    deleteCalls: KintoneDeleteParams[];
    writeCalls: number;
  } = {
    getCalls,
    putCalls,
    deleteCalls,
    writeCalls: 0,
    async getRecords(params) {
      getCalls.push(params);
      return { records: [{
        $id: { value: "1" },
        ID: { value: "A" },
        件名: { value: "至急対応" },
        備考: { value: "緊急対応" },
      }], searchAborted: options.searchAborted };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { client.writeCalls++; return { ids: [] }; },
    async putRecords(params) { client.writeCalls++; putCalls.push(params); },
    async deleteRecords(params) { client.writeCalls++; deleteCalls.push(params); },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "ID", label: "ID", fieldType: "SINGLE_LINE_TEXT" },
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
        { code: "備考", label: "備考", fieldType: "SINGLE_LINE_TEXT" },
        { code: "種別", label: "種別", fieldType: "SINGLE_LINE_TEXT" },
        { code: "状態", label: "状態", fieldType: "SINGLE_LINE_TEXT" },
        { code: "金額", label: "金額", fieldType: "NUMBER" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
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
  expect(client.getCalls).toHaveLength(0); // metadata API は getRecords には数えない
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

test("B5: 親 UPDATE KLIKE は native query の返却 ID だけ PUT する", async () => {
  const client = makeClient();
  const result = await execute(
    "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
    client
  );
  expect(result).toMatchObject({ type: "UPDATE", updatedCount: 1 });
  expect(client.getCalls[0].query).toContain('件名 like "至急"');
  expect(client.putCalls).toEqual([expect.objectContaining({
    records: [expect.objectContaining({ id: 1 })],
  })]);
});

test("B5: 親 DELETE NOT KLIKE は native query の返却 ID だけ DELETE する", async () => {
  const client = makeClient();
  const result = await execute(
    "DELETE FROM APP100 WHERE 件名 NOT KLIKE '保留'",
    client
  );
  expect(result).toMatchObject({ type: "DELETE", deletedCount: 1 });
  expect(client.getCalls[0].query).toContain('件名 not like "保留"');
  expect(client.deleteCalls).toEqual([{ app: 100, ids: [1] }]);
});

test.each([
  "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
  "DELETE FROM APP100 WHERE 件名 NOT KLIKE '保留'",
])("B5: 通常親 DML KLIKE は検索打ち切り時に confirm / mutation 0 で fail-closed — %s", async (sql) => {
  const client = makeClient({ searchAborted: true });
  const confirm = jest.fn(async () => true);
  await expect(execute(sql, client, { confirm })).rejects.toBeInstanceOf(SearchAbortedError);
  expect(confirm).not.toHaveBeenCalled();
  expect(client.writeCalls).toBe(0);
});

test("B5: 通常親 DML KLIKE は maxRecords 超過時に mutation 0 で拒否する", async () => {
  const client = makeClient();
  const confirm = jest.fn(async () => true);
  await expect(execute(
    "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
    client,
    { maxRecords: 0, confirm }
  )).rejects.toThrow(/取得件数が上限/);
  expect(confirm).not.toHaveBeenCalled();
  expect(client.writeCalls).toBe(0);
});

test.each([
  "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急' AND 備考 LIKE '%緊急%'",
  "UPDATE APP100 SET 状態 = '完了' WHERE LENGTH(件名) > 1 AND 件名 KLIKE '至急'",
  "UPDATE APP100 SET 状態 = '完了' WHERE 金額 + 1 > 2 AND 件名 KLIKE '至急'",
  "UPDATE APP100 SET 状態 = '完了' WHERE CASE WHEN 種別 = 'A' THEN 1 ELSE 0 END = 1 AND 件名 KLIKE '至急'",
  "DELETE FROM APP100 WHERE EXISTS (SELECT $id FROM APP200 WHERE $id = 1) AND 件名 KLIKE '至急'",
])("B5: exact pushdown 不能な混在 WHERE は records / mutation 前に拒否する — %s", async (sql) => {
  const client = makeClient();
  await expect(execute(sql, client)).rejects.toThrow(/DmlConvertError|cannot be represented by kintone REST/);
  expect(client.getCalls).toHaveLength(0);
  expect(client.writeCalls).toBe(0);
});

test("B5: native like 非対応型と未解決・非文字列変数を実行前に拒否する", async () => {
  const unsupported = makeClient();
  unsupported.getFields = async () => [
    { code: "状態", label: "状態", fieldType: "SINGLE_LINE_TEXT" },
    { code: "選択", label: "選択", fieldType: "CHECK_BOX" },
  ];
  await expect(execute(
    "UPDATE APP100 SET 状態 = '完了' WHERE 選択 KLIKE 'A'",
    unsupported
  )).rejects.toThrow(/cannot be represented by kintone REST/);
  expect(unsupported.getCalls).toHaveLength(0);
  expect(unsupported.writeCalls).toBe(0);

  const unresolved = makeClient();
  await expect(executeBatch(
    "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE @missing",
    unresolved
  )).rejects.toThrow(/variable @missing is not defined/);
  expect(unresolved.getCalls).toHaveLength(0);
  expect(unresolved.writeCalls).toBe(0);

  const nonString = makeClient();
  const result = await executeBatch(
    "SET @q = 1; UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE @q",
    nonString
  );
  expect(result.ok).toBe(false);
  expect(nonString.getCalls).toHaveLength(0);
  expect(nonString.writeCalls).toBe(0);
});

test.each([
  "UPDATE APP100$明細 SET 商品名 = 'x' WHERE 商品名 KLIKE '至急'",
  "DELETE FROM APP100$明細 WHERE 商品名 NOT KLIKE '保留'",
  "REORDER APP100$明細 BY 商品名 WHERE 商品名 KLIKE '至急'",
])("B5: サブテーブル DML / REORDER は evalWhere 前に明確に拒否する — %s", async (sql) => {
  const client = makeClient();
  await expect(execute(sql, client)).rejects.toThrow(/サブテーブル|REORDER/);
  expect(client.getCalls).toHaveLength(0);
  expect(client.writeCalls).toBe(0);
});

test.each([
  "EXPLAIN UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急' OR 種別 = 'A'",
  "EXPLAIN DELETE FROM APP100 WHERE NOT (件名 KLIKE '保留')",
])("B5: 通常親 DML EXPLAIN は native exact selection と fail-closed を API 0 で表示する — %s", async (sql) => {
  const client = makeClient();
  const result = await execute(sql, client) as SelectResult;
  const plan = result.rows.map((row) => String(row.plan)).join("\n");
  expect(plan).toMatch(/like/);
  expect(plan).toContain("selection: exact native pushdown; JS residual none");
  expect(plan).toContain("search abort: DML fail-closed (SearchAbortedError; mutation 0)");
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
