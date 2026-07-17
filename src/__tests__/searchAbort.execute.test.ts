import {
  execute,
  executeBatch,
  SearchAbortedError,
  type KintoneClient,
  type SelectResult,
} from "../execute";

function makeAbortedClient(): KintoneClient & {
  putCalls: number;
  deleteCalls: number;
  postCalls: number;
} {
  const client: KintoneClient & {
    putCalls: number;
    deleteCalls: number;
    postCalls: number;
  } = {
    putCalls: 0,
    deleteCalls: 0,
    postCalls: 0,
    async getRecords() {
      return {
        records: [{
          $id: { value: "1" },
          f: { value: "x" },
          金額: { value: "100" },
          件名: { value: "至急" },
        }],
        searchAborted: true,
      };
    },
    async postRecords() { client.postCalls++; return { ids: ["1"] }; },
    async putRecords() { client.putCalls++; },
    async deleteRecords() { client.deleteCalls++; },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "f", label: "f", fieldType: "SINGLE_LINE_TEXT" },
        { code: "金額", label: "金額", fieldType: "NUMBER" },
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
  return client;
}

function expectSearchAbortWarning(result: SelectResult): void {
  expect(result.warnings).toEqual([
    expect.stringContaining("10 万件で打ち切られ"),
  ]);
}

test("SIMPLE 単発 GET の検索打ち切りを SELECT 警告にする", async () => {
  const result = await execute(
    "SELECT 件名 FROM APP100 WHERE 件名 KLIKE '至急' LIMIT 1",
    makeAbortedClient()
  ) as SelectResult;
  expectSearchAbortWarning(result);
});

test.each([
  "SELECT 件名 FROM APP100 WHERE 件名 KLIKE '至急' UNION ALL SELECT 件名 FROM APP101 WHERE 件名 KLIKE '至急'",
  "WITH c AS (SELECT * FROM APP100 WHERE 件名 KLIKE '至急') SELECT 件名 FROM c",
  "SELECT $id FROM APP100 WHERE $id IN (SELECT $id FROM APP101 WHERE 件名 KLIKE '至急')",
])("合成 SELECT の子クエリで検出した打ち切りを最終結果へ集約する", async (sql) => {
  const result = await execute(sql, makeAbortedClient()) as SelectResult;
  expectSearchAbortWarning(result);
});

test.each([
  "UPDATE APP100 SET f = 'y' WHERE f = 'x'",
  "UPDATE APP100 SET 金額 = 金額 + 1 WHERE f = 'x'",
  "DELETE FROM APP100 WHERE f = 'x'",
])("DML は検索打ち切り時に書き込み前で fail-closed にする", async (sql) => {
  const client = makeAbortedClient();
  const confirm = jest.fn(async () => true);
  await expect(execute(sql, client, { confirm })).rejects.toBeInstanceOf(SearchAbortedError);
  expect(confirm).not.toHaveBeenCalled();
  expect(client.putCalls).toBe(0);
  expect(client.deleteCalls).toBe(0);
});

test("CREATE TEMP TABLE AS SELECT は打ち切り結果を実体化しない", async () => {
  const result = await executeBatch(
    "CREATE TEMP TABLE #x AS SELECT 件名 FROM APP100 WHERE 件名 KLIKE '至急'; SELECT * FROM #x",
    makeAbortedClient()
  );
  expect(result.ok).toBe(false);
  expect(result.statements[0].status).toBe("error");
  expect(result.statements[0].error?.code).toBe("SearchAbortedError");
  expect(result.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
});

test("バッチ内の SELECT にも実行文単位で警告を付与する", async () => {
  const result = await executeBatch(
    "SELECT 件名 FROM APP100 WHERE 件名 KLIKE '至急' LIMIT 1",
    makeAbortedClient()
  );
  expect(result.ok).toBe(true);
  expectSearchAbortWarning(result.statements[0].result as SelectResult);
});

test.each([
  "INSERT INTO APP200 (f) SELECT f FROM APP100",
  "UPSERT INTO APP200 (f) SELECT f FROM APP100 ON DUPLICATE (f)",
])("SELECT 結果を書き込む DML も打ち切り時は停止する", async (sql) => {
  const client = makeAbortedClient();
  await expect(execute(sql, client)).rejects.toBeInstanceOf(SearchAbortedError);
  expect(client.postCalls).toBe(0);
  expect(client.putCalls).toBe(0);
});
