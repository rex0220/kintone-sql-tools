import {
  execute,
  executeBatch,
  SearchAbortedError,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

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
    async openCursor() { throw new Error("unexpected cursor call"); },
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
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
  return client;
}

function expectSearchAbortWarning(result: SelectResult): void {
  expect(result.warnings).toEqual([
    expect.stringContaining("10 万件で打ち切られ"),
  ]);
}

function joinRecord(values: Readonly<Record<string, string>>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const joinRowsByApp: Readonly<Record<number, readonly KintoneRecord[]>> = {
  79100: [joinRecord({ $id: "1", key: "A", leftValue: "left" })],
  79101: [joinRecord({ $id: "2", key: "A", amount: "300" })],
  79102: [joinRecord({ $id: "3", key: "A", detail: "matched" })],
};

const joinFieldsByApp: Readonly<Record<number, readonly string[]>> = {
  79100: ["key", "leftValue"],
  79101: ["key", "amount"],
  79102: ["key", "detail"],
};

function makeJoinClient(abortedApps: readonly number[] = []): KintoneClient {
  const aborted = new Set(abortedApps);
  return {
    async getRecords(params) {
      const source = aborted.has(params.app) ? [] : (joinRowsByApp[params.app] ?? []);
      return {
        records: source.map((row) => Object.fromEntries(
          params.fields.flatMap((field) => row[field] === undefined ? [] : [[field, row[field]]])
        ) as KintoneRecord),
        ...(aborted.has(params.app) ? { searchAborted: true } : {}),
      };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      return (joinFieldsByApp[appId] ?? []).map((code) => ({
        code,
        label: code,
        fieldType: code === "amount" ? "NUMBER" : "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
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

test.each([
  ["LEFT", 79100],
  ["LEFT", 79101],
  ["RIGHT", 79100],
  ["RIGHT", 79101],
] as const)("%s JOIN は APP%s 側だけの打ち切りでも fail-closed にする", async (joinType, abortedApp) => {
  const sql =
    `SELECT a.$id, b.amount FROM APP79100 a ${joinType} JOIN APP79101 b `
    + "ON a.key = b.key";
  await expect(execute(sql, makeJoinClient([abortedApp])))
    .rejects.toBeInstanceOf(SearchAbortedError);
});

test("INNER JOIN は打ち切り時も従来どおり警告と部分結果を返す", async () => {
  const result = await execute(
    "SELECT a.$id, b.amount FROM APP79100 a INNER JOIN APP79101 b ON a.key = b.key",
    makeJoinClient([79101])
  ) as SelectResult;
  expect(result.rows).toEqual([]);
  expectSearchAbortWarning(result);
});

test.each(["LEFT", "RIGHT"] as const)(
  "%s JOIN は打ち切りがなければ従来どおり結果を返す",
  async (joinType) => {
    const result = await execute(
      `SELECT a.$id, b.amount FROM APP79100 a ${joinType} JOIN APP79101 b ON a.key = b.key`,
      makeJoinClient()
    ) as SelectResult;
    expect(result.rows).toEqual([{ $id: "1", amount: "300" }]);
    expect(result.warnings).toEqual([]);
  }
);

test.each([
  [
    "CTE 本体",
    "WITH c AS (SELECT a.$id AS id, b.amount FROM APP79100 a LEFT JOIN APP79101 b ON a.key = b.key) "
      + "SELECT id, amount FROM c",
    79101,
  ],
  [
    "UNION 枝",
    "SELECT $id AS id FROM APP79100 UNION ALL "
      + "SELECT a.$id AS id FROM APP79100 a RIGHT JOIN APP79101 b ON a.key = b.key",
    79101,
  ],
  [
    "入れ子 SELECT",
    "SELECT $id FROM APP79100 WHERE EXISTS ("
      + "SELECT b.$id FROM APP79101 b LEFT JOIN APP79102 c ON b.key = c.key)",
    79102,
  ],
] as const)("%s 内の外部結合も打ち切り時に fail-closed にする", async (_label, sql, abortedApp) => {
  await expect(execute(sql, makeJoinClient([abortedApp])))
    .rejects.toBeInstanceOf(SearchAbortedError);
});

test("一時テーブル source を含む外部結合もバッチ経路で fail-closed にする", async () => {
  const result = await executeBatch(
    "CREATE TEMP TABLE #left_source AS SELECT $id AS id, key FROM APP79100;"
      + "SELECT l.id, b.amount FROM #left_source l "
      + "LEFT JOIN APP79101 b ON l.key = b.key",
    makeJoinClient([79101])
  );
  expect(result.ok).toBe(false);
  expect(result.statements[0].status).toBe("success");
  expect(result.statements[1]).toMatchObject({
    status: "error",
    error: { code: "SearchAbortedError" },
  });
});
