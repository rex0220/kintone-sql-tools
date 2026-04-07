import {
  execute,
  KintoneClient,
  SelectResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
  OperationCancelledError,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type {
  KintonePostParams,
  KintonePutParams,
  KintoneDeleteParams,
} from "../converter/dmlToKintone";

// ----------------------------------------------------------------
// モッククライアント生成ヘルパー
// ----------------------------------------------------------------

function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}

interface MockClientOptions {
  records?: KintoneRecord[];          // GET で返すレコード（全アプリ共通）
  recordsByApp?: Record<number, KintoneRecord[]>; // アプリ ID ごとにレコードを分ける
  postIds?: string[];                 // POST レスポンスの id リスト
}

function makeClient(opts: MockClientOptions = {}): KintoneClient & {
  putCalls: KintonePutParams[];
  deleteCalls: KintoneDeleteParams[];
  postCalls: KintonePostParams[];
  getCalls: { app: number; query: string; fields: string[] }[];
} {
  const putCalls: KintonePutParams[]    = [];
  const deleteCalls: KintoneDeleteParams[] = [];
  const postCalls: KintonePostParams[]  = [];
  const getCalls: { app: number; query: string; fields: string[] }[] = [];

  return {
    putCalls,
    deleteCalls,
    postCalls,
    getCalls,

    async getRecords(params) {
      getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
      if (opts.recordsByApp) {
        return { records: opts.recordsByApp[params.app] ?? [] };
      }
      return { records: opts.records ?? [] };
    },
    async postRecords(params) {
      postCalls.push(params);
      return { ids: opts.postIds ?? [] };
    },
    async putRecords(params) {
      putCalls.push(params);
    },
    async deleteRecords(params) {
      deleteCalls.push(params);
    },
    async getApps() {
      return [];
    },
    async getFields(_appId) {
      return [];
    },
  };
}

// ----------------------------------------------------------------
// SELECT
// ----------------------------------------------------------------

test("SELECT * FROM APP100（SIMPLE モード）", async () => {
  const records = [
    makeRecord({ 名前: "田中", 金額: "1000" }),
    makeRecord({ 名前: "鈴木", 金額: "2000" }),
  ];
  const client = makeClient({ records });
  const result = await execute("SELECT * FROM APP100", client) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(result.rowCount).toBe(2);
  expect(result.rows[0]["名前"]).toBe("田中");
});

test("SELECT ORDER BY（並列取得時）: API クエリに元の order by を混在させない", async () => {
  const records = [
    makeRecord({ $id: "1", 担当者名: "田中" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT * FROM APP440 ORDER BY 担当者名",
    client,
    { fetchParallel: 2 }
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(client.getCalls[0].query).toBe("limit 500 offset 0");
  expect(client.getCalls[0].query).not.toContain("担当者名 asc and");
});

test("SELECT ORDER BY（並列取得時）: フィールド定義取得は1回だけ", async () => {
  const records = [makeRecord({ $id: "1", 担当者名: "田中" })];
  const client = makeClient({ records });
  let getFieldsCount = 0;
  const origGetFields = client.getFields.bind(client);
  client.getFields = async (appId: number) => {
    getFieldsCount += 1;
    return origGetFields(appId);
  };

  await execute(
    "SELECT * FROM APP9440 ORDER BY 担当者名",
    client,
    { fetchParallel: 2 }
  );

  expect(getFieldsCount).toBe(1);
});

test("SELECT WHERE = 文字列", async () => {
  const records = [makeRecord({ ステータス: "完了", 金額: "500" })];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT ステータス, 金額 FROM APP100 WHERE ステータス = '完了'",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toEqual({ ステータス: "完了", 金額: "500" });
});

test("SELECT 算術式: field * number AS alias", async () => {
  const records = [
    makeRecord({ 金額: "1000" }),
    makeRecord({ 金額: "2000" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 金額 * 1.1 AS 税込 FROM APP100",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  expect(result.rows[0]["税込"]).toBe("1100");
  expect(result.rows[1]["税込"]).toBe("2200");
});

test("SELECT 算術式: alias なしはデフォルトキー名", async () => {
  const records = [makeRecord({ $id: "5" })];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT $id * 1.1 FROM APP100",
    client
  ) as SelectResult;

  expect(result.rows[0]["$id*1.1"]).toBe("5.5");
});

test("SELECT 文字列リテラル列", async () => {
  const records = [makeRecord({ 顧客名: "A社" })];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 顧客名, 'XXX' AS a FROM APP60",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toEqual({ 顧客名: "A社", a: "XXX" });
});

test("SELECT literal without FROM returns one row", async () => {
  const client = makeClient({});
  const result = await execute(
    "SELECT 'xxx' AS a",
    client
  ) as SelectResult;
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toEqual({ a: "xxx" });
});

test("SELECT field without FROM is rejected", async () => {
  const client = makeClient({});
  await expect(
    execute("SELECT 顧客名", client)
  ).rejects.toThrow("not supported without FROM");
});

test("SELECT: 未存在フィールドコードを指定するとエラー", async () => {
  const records = [makeRecord({ 名前: "田中" })];
  const client = makeClient({ records });
  client.getFields = async (_appId) => ([
    { code: "名前", label: "名前", fieldType: "SINGLE_LINE_TEXT" },
  ]);

  await expect(
    execute("SELECT 存在しない FROM APP100", client, { cacheContext: "unknown-field-test" })
  ).rejects.toThrow("ArgumentError: unknown field code(s): 存在しない (APP100)");
});

test("SELECT COUNT(*) GROUP BY（FULL_SCAN モード）", async () => {
  const records = [
    makeRecord({ 種別: "A", 金額: "100" }),
    makeRecord({ 種別: "A", 金額: "200" }),
    makeRecord({ 種別: "B", 金額: "300" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 種別, COUNT(*) AS cnt FROM APP100 GROUP BY 種別 ORDER BY 種別 ASC",
    client
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(result.rows).toEqual([
    { 種別: "A", cnt: "2" },
    { 種別: "B", cnt: "1" },
  ]);
});

test("SELECT DISTINCT（FULL_SCAN モード）", async () => {
  const records = [
    makeRecord({ 種別: "B" }),
    makeRecord({ 種別: "A" }),
    makeRecord({ 種別: "A" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT DISTINCT 種別 FROM APP100 ORDER BY 種別 ASC",
    client
  ) as SelectResult;

  expect(result.rows.map((r) => r["種別"])).toEqual(["A", "B"]);
});

test("FULL_SCAN: JOIN + GROUP BY は必要フィールドのみ取得", async () => {
  const client = makeClient({
    recordsByApp: {
      89: [makeRecord({ 顧客名: "A", 顧客ランク: "S" })],
      88: [makeRecord({ 顧客名: "A", 合計費用: "1000" })],
    },
  });

  await execute(
    "SELECT a.顧客ランク AS 顧客ランク, FORMAT(SUM(b.合計費用),'#,##0') AS 合計 FROM APP89 AS a INNER JOIN APP88 AS b ON a.顧客名 = b.顧客名 GROUP BY a.顧客ランク",
    client
  );

  const app89Call = client.getCalls.find((c) => c.app === 89);
  const app88Call = client.getCalls.find((c) => c.app === 88);
  expect(app89Call).toBeDefined();
  expect(app88Call).toBeDefined();

  const app89Fields = new Set(app89Call?.fields ?? []);
  const app88Fields = new Set(app88Call?.fields ?? []);
  expect(app89Fields.has("顧客名")).toBe(true);
  expect(app89Fields.has("顧客ランク")).toBe(true);
  expect(app89Fields.has("$id")).toBe(true);
  expect(app89Fields.size).toBe(3);
  expect(app88Fields.has("顧客名")).toBe(true);
  expect(app88Fields.has("合計費用")).toBe(true);
  expect(app88Fields.has("$id")).toBe(true);
  expect(app88Fields.size).toBe(3);
});

test("FULL_SCAN: 単純 INNER JOIN は join 側を IN 条件で取得する", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ $id: "1", 顧客名: "A" }),
        makeRecord({ $id: "2", 顧客名: "B" }),
      ],
      101: [
        makeRecord({ $id: "10", 顧客名: "A", 金額: "1000" }),
      ],
    },
  });

  await execute(
    "SELECT a.顧客名, b.金額 FROM APP100 AS a INNER JOIN APP101 AS b ON a.顧客名 = b.顧客名",
    client
  );

  const joinCall = client.getCalls.find((c) => c.app === 101);
  expect(joinCall).toBeDefined();
  expect(joinCall?.query).toContain(" in (");
  expect(joinCall?.query).toContain("顧客名");
});

test("FULL_SCAN: JOINキーが多い場合は IN 最適化をスキップして全件取得にフォールバック", async () => {
  const sourceRows = Array.from({ length: 301 }).map((_, i) =>
    makeRecord({ $id: String(i + 1), 顧客名: `C${i + 1}` })
  );
  const client = makeClient({
    recordsByApp: {
      100: sourceRows,
      101: [makeRecord({ $id: "10", 顧客名: "C1", 金額: "1000" })],
    },
  });

  const result = await execute(
    "SELECT a.顧客名, b.金額 FROM APP100 AS a INNER JOIN APP101 AS b ON a.顧客名 = b.顧客名",
    client
  );

  const joinCall = client.getCalls.find((c) => c.app === 101);
  expect(joinCall).toBeDefined();
  expect(joinCall?.query).toContain("limit 500 offset 0");
  expect(joinCall?.query).not.toContain(" in (");
  expect(result.type).toBe("SELECT");
  if (result.type === "SELECT") {
    expect(result.warnings?.some((w) => w.includes("IN 最適化をスキップ"))).toBe(true);
  }
});

test("FULL_SCAN: サブテーブルは $id / サブテーブル本体 / _p.参照親項目のみ取得", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" }, 数量: { value: "2" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  await execute(
    "SELECT _p.案件名, 商品コード, _rid FROM APP100$明細",
    client
  );

  expect(client.getCalls.length).toBeGreaterThan(0);
  const fields = new Set(client.getCalls[0].fields);
  expect(fields.has("$id")).toBe(true);
  expect(fields.has("明細")).toBe(true);
  expect(fields.has("案件名")).toBe(true);
  expect(fields.has("商品コード")).toBe(false);
});

test("SELECT サブテーブル仮想テーブル + _p.項目", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" }, 数量: { value: "2" } } },
              { id: "r2", value: { 商品コード: { value: "A-002" }, 数量: { value: "5" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "SELECT _p.案件名, 商品コード, _rid FROM APP100$明細 ORDER BY 商品コード ASC",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  expect(result.rows[0]).toEqual({ "_p.案件名": "案件A", 商品コード: "A-001", _rid: "r1" });
  expect(result.rows[1]).toEqual({ "_p.案件名": "案件A", 商品コード: "A-002", _rid: "r2" });
});

test("SELECT _p.* 親項目一括展開", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          顧客コード: { value: "C-001" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "SELECT _p.*, 商品コード FROM APP100$明細",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["_p.案件名"]).toBe("案件A");
  expect(result.rows[0]["_p.顧客コード"]).toBe("C-001");
  expect(result.rows[0]["商品コード"]).toBe("A-001");
});

test("SELECT * は _p.* を暗黙表示しない", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          案件名: { value: "案件A" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "SELECT * FROM APP100$明細",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["_rid"]).toBe("r1");
  expect(result.rows[0]["商品コード"]).toBe("A-001");
  expect(result.rows[0]["_p.案件名"]).toBeUndefined();
});

// ----------------------------------------------------------------
// INSERT
// ----------------------------------------------------------------

test("INSERT 単一行 → POST 1回", async () => {
  const client = makeClient({ postIds: ["101"] });
  const result = await execute(
    "INSERT INTO APP100 (名前, 金額) VALUES ('田中', 1000)",
    client
  ) as InsertResult;

  expect(result.type).toBe("INSERT");
  expect(result.insertedCount).toBe(1);
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].records[0]).toEqual({
    名前: { value: "田中" },
    金額: { value: "1000" },
  });
});

test("INSERT 101行 → POST 2回（バッチ分割）", async () => {
  const rows = Array.from({ length: 101 }, (_, i) => `('名前${i}')`).join(", ");
  const client = makeClient({ postIds: [] });
  await execute(`INSERT INTO APP100 (名前) VALUES ${rows}`, client);

  expect(client.postCalls).toHaveLength(2);
  expect(client.postCalls[0].records).toHaveLength(100);
  expect(client.postCalls[1].records).toHaveLength(1);
});

test("INSERT サブテーブル行 → 親レコードに PUT", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "3" },
          明細: { value: [{ id: "r1", value: { 商品コード: { value: "A-001" } } }] },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "INSERT INTO APP100$明細 (_pid, 商品コード, 数量) VALUES (1, 'A-002', 2)",
    client
  ) as InsertResult;

  expect(result.type).toBe("INSERT");
  expect(result.insertedCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ value: Record<string, { value: string }> }>;
  expect(table).toHaveLength(2);
  expect(table[1].value["商品コード"].value).toBe("A-002");
  expect(table[1].value["数量"].value).toBe("2");
});

// ----------------------------------------------------------------
// UPDATE
// ----------------------------------------------------------------

test("UPDATE → GET して PUT", async () => {
  const records = [
    makeRecord({ $id: "1" }),
    makeRecord({ $id: "2" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "UPDATE APP100 SET ステータス = '完了' WHERE ステータス = '未完了'",
    client
  ) as UpdateResult;

  expect(result.type).toBe("UPDATE");
  expect(result.updatedCount).toBe(2);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records).toHaveLength(2);
  expect(client.putCalls[0].records[0].record).toEqual({
    ステータス: { value: "完了" },
  });
});

test("UPDATE → 確認コールバックで OK", async () => {
  const records = [makeRecord({ $id: "1" })];
  const client = makeClient({ records });
  let confirmed = false;

  await execute(
    "UPDATE APP100 SET f = 'v' WHERE f = 'old'",
    client,
    {
      confirm: async (count, op) => {
        confirmed = true;
        expect(count).toBe(1);
        expect(op).toBe("UPDATE");
        return true;
      },
    }
  );

  expect(confirmed).toBe(true);
  expect(client.putCalls).toHaveLength(1);
});

test("UPDATE → 確認コールバックでキャンセル", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "1" })] });
  await expect(
    execute("UPDATE APP100 SET f = 'v' WHERE f = 'old'", client, {
      confirm: async () => false,
    })
  ).rejects.toThrow(OperationCancelledError);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE 算術式: 現在値を取得して計算結果で PUT", async () => {
  const records = [
    makeRecord({ $id: "1", 金額: "1000" }),
    makeRecord({ $id: "2", 金額: "2000" }),
  ];
  const client = makeClient({ records });
  const result = await execute(
    "UPDATE APP100 SET 金額 = 金額 * 2 WHERE ステータス = '対象'",
    client
  ) as UpdateResult;

  expect(result.updatedCount).toBe(2);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records[0]).toEqual({ id: 1, record: { 金額: { value: "2000" } } });
  expect(client.putCalls[0].records[1]).toEqual({ id: 2, record: { 金額: { value: "4000" } } });
});

test("UPDATE 算術式: 確認コールバックが件数を受け取る", async () => {
  const records = [
    makeRecord({ $id: "10", 金額: "500" }),
    makeRecord({ $id: "11", 金額: "800" }),
    makeRecord({ $id: "12", 金額: "300" }),
  ];
  const client = makeClient({ records });
  let confirmedCount = 0;

  await execute(
    "UPDATE APP100 SET 金額 = 金額 + 100 WHERE ステータス = '対象'",
    client,
    {
      confirm: async (count, op) => {
        confirmedCount = count;
        expect(op).toBe("UPDATE");
        return true;
      },
    }
  );

  expect(confirmedCount).toBe(3);
  expect(client.putCalls[0].records[0].record["金額"].value).toBe("600");
});

test("UPDATE 算術式: 確認コールバックでキャンセル", async () => {
  const records = [makeRecord({ $id: "1", 金額: "100" })];
  const client = makeClient({ records });
  await expect(
    execute("UPDATE APP100 SET 金額 = 金額 * 10 WHERE f = 'v'", client, {
      confirm: async () => false,
    })
  ).rejects.toThrow(OperationCancelledError);
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE 算術式と通常代入の混在", async () => {
  const records = [makeRecord({ $id: "5", 金額: "1000" })];
  const client = makeClient({ records });
  await execute(
    "UPDATE APP100 SET 金額 = 金額 * 1.1, 備考 = '値上げ後' WHERE $id = 5",
    client
  );

  expect(client.putCalls[0].records[0].record).toEqual({
    金額: { value: "1100" },
    備考: { value: "値上げ後" },
  });
});

test("UPDATE サブテーブル行（_rid 条件）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "7" },
          伝票番号: { value: "S-001" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" }, 数量: { value: "1" } } },
              { id: "r2", value: { 商品コード: { value: "A-002" }, 数量: { value: "2" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "UPDATE APP100$明細 SET 数量 = 5 WHERE _rid = 'r2'",
    client
  ) as UpdateResult;

  expect(result.updatedCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string; value?: Record<string, { value: string }> }>;
  expect(table[0]).toEqual({ id: "r1" });
  expect(table[1].id).toBe("r2");
  expect(table[1].value?.["数量"].value).toBe("5");
  expect(table[1].value?.["商品コード"]).toBeUndefined();
});

test("UPDATE サブテーブルは _rid 条件必須", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "1" },
          明細: { value: [{ id: "r1", value: { 数量: { value: "1" } } }] },
        } as unknown as KintoneRecord,
      ],
    },
  });
  await expect(
    execute("UPDATE APP100$明細 SET 数量 = 9 WHERE _pid = 1", client)
  ).rejects.toThrow("_rid 条件が必須");
});

// ----------------------------------------------------------------
// DELETE
// ----------------------------------------------------------------

test("DELETE → GET して DELETE", async () => {
  const records = [makeRecord({ $id: "10" }), makeRecord({ $id: "20" })];
  const client = makeClient({ records });
  const result = await execute(
    "DELETE FROM APP100 WHERE 作成日 < '2023-01-01'",
    client
  ) as DeleteResult;

  expect(result.type).toBe("DELETE");
  expect(result.deletedCount).toBe(2);
  expect(client.deleteCalls[0].ids).toEqual([10, 20]);
});

test("DELETE → 確認コールバックでキャンセル", async () => {
  const client = makeClient({ records: [makeRecord({ $id: "1" })] });
  await expect(
    execute("DELETE FROM APP100 WHERE f = 'v'", client, {
      confirm: async () => false,
    })
  ).rejects.toThrow(OperationCancelledError);
  expect(client.deleteCalls).toHaveLength(0);
});

test("DELETE サブテーブル行（_rid 条件）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "2" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "A-001" } } },
              { id: "r2", value: { 商品コード: { value: "A-002" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "DELETE FROM APP100$明細 WHERE _rid = 'r1'",
    client
  ) as DeleteResult;

  expect(result.deletedCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string }>;
  expect(table).toHaveLength(1);
  expect(table[0].id).toBe("r2");
});

test("REORDER サブテーブル行（親単位）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "2" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "B-002" }, 数量: { value: "1" } } },
              { id: "r2", value: { 商品コード: { value: "A-001" }, 数量: { value: "2" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "REORDER APP100$明細 BY 商品コード ASC WHERE _pid = 1",
    client
  ) as any;

  expect(result.type).toBe("REORDER");
  expect(result.reorderedParentCount).toBe(1);
  expect(client.putCalls).toHaveLength(1);
  const table = client.putCalls[0].records[0].record["明細"].value as unknown as Array<{ id?: string; value?: unknown }>;
  expect(table[0].id).toBe("r2");
  expect(table[1].id).toBe("r1");
  expect(table.every((r) => r.value === undefined)).toBe(true);
});

test("REORDER は WHERE 必須", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "1" },
          明細: { value: [{ id: "r1", value: { 数量: { value: "1" } } }] },
        } as unknown as KintoneRecord,
      ],
    },
  });

  await expect(
    execute("REORDER APP100$明細 BY 数量 ASC", client)
  ).rejects.toThrow("WHERE 句が必須");
});

test("REORDER ALL サブテーブル行（全親対象）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        {
          $id: { value: "1" },
          $revision: { value: "2" },
          明細: {
            value: [
              { id: "r1", value: { 商品コード: { value: "B-002" } } },
              { id: "r2", value: { 商品コード: { value: "A-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
        {
          $id: { value: "2" },
          $revision: { value: "5" },
          明細: {
            value: [
              { id: "r3", value: { 商品コード: { value: "D-002" } } },
              { id: "r4", value: { 商品コード: { value: "C-001" } } },
            ],
          },
        } as unknown as KintoneRecord,
      ],
    },
  });

  const result = await execute(
    "REORDER ALL APP100$明細 BY 商品コード ASC",
    client
  ) as any;

  expect(result.type).toBe("REORDER");
  expect(result.reorderedParentCount).toBe(2);
  expect(client.putCalls).toHaveLength(2);
});

// ----------------------------------------------------------------
// INSERT INTO ... SELECT
// ----------------------------------------------------------------

test("INSERT INTO APP200 ... SELECT FROM APP100 — 基本", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ 名前: "田中", 金額: "1000" }),
        makeRecord({ 名前: "鈴木", 金額: "2000" }),
      ],
    },
    postIds: ["201", "202"],
  });

  const result = await execute(
    "INSERT INTO APP200 (顧客名, 単価) SELECT 名前, 金額 FROM APP100",
    client
  ) as InsertResult;

  expect(result.type).toBe("INSERT");
  expect(result.insertedCount).toBe(2);
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].app).toBe(200);
  expect(client.postCalls[0].records[0]).toEqual({
    顧客名: { value: "田中" },
    単価:   { value: "1000" },
  });
  expect(client.postCalls[0].records[1]).toEqual({
    顧客名: { value: "鈴木" },
    単価:   { value: "2000" },
  });
});

test("INSERT INTO ... SELECT — 101行 → POST 2回", async () => {
  const sourceRecords = Array.from({ length: 101 }, (_, i) =>
    makeRecord({ 名前: `名前${i}` })
  );
  const client = makeClient({
    recordsByApp: { 100: sourceRecords },
    postIds: [],
  });

  await execute(
    "INSERT INTO APP200 (顧客名) SELECT 名前 FROM APP100",
    client
  );

  expect(client.postCalls).toHaveLength(2);
  expect(client.postCalls[0].records).toHaveLength(100);
  expect(client.postCalls[1].records).toHaveLength(1);
});

test("INSERT INTO ... SELECT — 列数不一致はエラー", async () => {
  const client = makeClient({
    recordsByApp: { 100: [makeRecord({ 名前: "田中" })] },
  });

  await expect(
    execute(
      "INSERT INTO APP200 (f1, f2) SELECT 名前 FROM APP100",
      client
    )
  ).rejects.toThrow("列数");
});

test("INSERT INTO ... SELECT — 集計結果を別アプリに登録", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ 種別: "A", 金額: "100" }),
        makeRecord({ 種別: "A", 金額: "200" }),
        makeRecord({ 種別: "B", 金額: "500" }),
      ],
    },
    postIds: [],
  });

  await execute(
    "INSERT INTO APP200 (種別, 合計) SELECT 種別, SUM(金額) AS 合計 FROM APP100 GROUP BY 種別",
    client
  );

  expect(client.postCalls).toHaveLength(1);
  // SUM(金額): A=300, B=500
  const posted = client.postCalls[0].records.sort((a, b) =>
    (a["種別"].value as string).localeCompare(b["種別"].value as string)
  );
  expect(posted[0]).toEqual({ 種別: { value: "A" }, 合計: { value: "300" } });
  expect(posted[1]).toEqual({ 種別: { value: "B" }, 合計: { value: "500" } });
});

// ----------------------------------------------------------------
// UNION / UNION ALL
// ----------------------------------------------------------------

test("UNION — 重複行を除去して結合", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "鈴木" })],
      200: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "佐藤" })],
    },
  });

  const result = await execute(
    "SELECT 名前 FROM APP100 UNION SELECT 名前 FROM APP200",
    client
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  expect(result.rowCount).toBe(3);
  const names = result.rows.map((r) => r["名前"]).sort();
  expect(names).toEqual(["佐藤", "田中", "鈴木"]);
});

test("UNION ALL — 重複を保持して結合", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "鈴木" })],
      200: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "佐藤" })],
    },
  });

  const result = await execute(
    "SELECT 名前 FROM APP100 UNION ALL SELECT 名前 FROM APP200",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(4);
  const names = result.rows.map((r) => r["名前"]).sort();
  expect(names).toEqual(["佐藤", "田中", "田中", "鈴木"]);
});

test("UNION — 右辺の列名を左辺の列名に位置対応でリマップ", async () => {
  // 左辺: SELECT 名前 AS n, 金額 AS amt FROM APP100
  // 右辺: SELECT 顧客名 AS name, 価格 AS price FROM APP200
  // 結果の列名は左辺 ["n", "amt"] になり、右辺の値が position で入る
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中", 金額: "1000" })],
      200: [makeRecord({ 顧客名: "鈴木", 価格: "2000" })],
    },
  });

  const result = await execute(
    "SELECT 名前 AS n, 金額 AS amt FROM APP100 UNION SELECT 顧客名 AS name, 価格 AS price FROM APP200",
    client
  ) as SelectResult;

  expect(result.columns).toEqual(["n", "amt"]);
  expect(result.rows[0]).toEqual({ n: "田中", amt: "1000" });
  expect(result.rows[1]).toEqual({ n: "鈴木", amt: "2000" });
});

test("UNION 3ウェイチェーン — 左結合で順番通り結合", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" })],
      200: [makeRecord({ 名前: "鈴木" })],
      300: [makeRecord({ 名前: "佐藤" })],
    },
  });

  const result = await execute(
    "SELECT 名前 FROM APP100 UNION ALL SELECT 名前 FROM APP200 UNION ALL SELECT 名前 FROM APP300",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(3);
  expect(result.rows.map((r) => r["名前"])).toEqual(["田中", "鈴木", "佐藤"]);
});

test("UNION — 全行重複はすべて1件に", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 種別: "A" }), makeRecord({ 種別: "B" })],
      200: [makeRecord({ 種別: "A" }), makeRecord({ 種別: "B" })],
    },
  });

  const result = await execute(
    "SELECT 種別 FROM APP100 UNION SELECT 種別 FROM APP200",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
});

// ----------------------------------------------------------------
// WHERE 句の算術式・関数（FULL_SCAN モード）
// ----------------------------------------------------------------

test("WHERE 左辺算術式: 金額 * 1.1 > 10000", async () => {
  const records = [
    makeRecord({ 金額: "9000" }),   // 9000 * 1.1 = 9900 → NG
    makeRecord({ 金額: "10000" }),  // 10000 * 1.1 = 11000 → OK
    makeRecord({ 金額: "5000" }),   // 5000 * 1.1 = 5500 → NG
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 金額 FROM APP100 WHERE 金額 * 1.1 > 10000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["金額"]).toBe("10000");
});

test("WHERE 左辺算術式: (単価 + 送料) * 数量 < 5000", async () => {
  const records = [
    makeRecord({ 単価: "100", 送料: "50", 数量: "20" }), // 150 * 20 = 3000 → OK
    makeRecord({ 単価: "200", 送料: "50", 数量: "20" }), // 250 * 20 = 5000 → NG（< なので等値は除外）
    makeRecord({ 単価: "300", 送料: "50", 数量: "10" }), // 350 * 10 = 3500 → OK
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 単価 FROM APP100 WHERE (単価 + 送料) * 数量 < 5000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  const prices = result.rows.map((r) => r["単価"]).sort();
  expect(prices).toEqual(["100", "300"]);
});

test("WHERE 左辺関数の算術式: LENGTH(備考) * 2 > 10", async () => {
  const records = [
    makeRecord({ 備考: "AB" }),       // LENGTH=2, 2*2=4 → NG
    makeRecord({ 備考: "ABCDEF" }),   // LENGTH=6, 6*2=12 → OK
    makeRecord({ 備考: "ABCDE" }),    // LENGTH=5, 5*2=10 → NG（> なので等値は除外）
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 備考 FROM APP100 WHERE LENGTH(備考) * 2 > 10",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["備考"]).toBe("ABCDEF");
});

test("WHERE 右辺算術式: WHERE 税込 = 金額 * 1.1", async () => {
  const records = [
    makeRecord({ 税込: "1100", 金額: "1000" }), // 1000 * 1.1 = 1100 → OK
    makeRecord({ 税込: "2000", 金額: "2000" }), // 2000 * 1.1 = 2200 → NG
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT 税込, 金額 FROM APP100 WHERE 税込 = 金額 * 1.1",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["金額"]).toBe("1000");
});

test("WHERE 算術式と通常条件の AND 複合", async () => {
  const records = [
    makeRecord({ 種別: "A", 金額: "10000" }),  // 10000 * 1.1 = 11000 > 10000 → OK
    makeRecord({ 種別: "B", 金額: "10000" }),  // 種別が B → NG
    makeRecord({ 種別: "A", 金額: "5000" }),   // 5000 * 1.1 = 5500 → NG
  ];
  const client = makeClient({ records });
  const result = await execute(
    "SELECT * FROM APP100 WHERE 種別 = 'A' AND 金額 * 1.1 > 10000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["金額"]).toBe("10000");
});

// ----------------------------------------------------------------
// WITH 句（CTE）
// ----------------------------------------------------------------

test("WITH — 基本: 単純 CTE はインライン化され WHERE が REST API クエリに渡る", async () => {
  // CTE が SIMPLE モード → インライン化により最終 WHERE が REST API へ送られる
  // モックはクエリを評価しないため全件返すが、実 kintone では API 側でフィルタされる
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "B", 金額: "200" }),
      makeRecord({ 種別: "A", 金額: "300" }),
    ],
  });

  const result = await execute(
    `WITH 全件 AS (SELECT 種別, 金額 FROM APP100)
     SELECT 種別, 金額 FROM 全件 WHERE 種別 = 'A'`,
    client
  ) as SelectResult;

  expect(result.type).toBe("SELECT");
  // インライン化後は REST API が WHERE を評価する（モックは全件返す）
  expect(client.getCalls[0].query).toContain('種別 = "A"');
});

test("WITH — GROUP BY 集計 CTE を最終クエリで LIMIT", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "A", 金額: "200" }),
      makeRecord({ 種別: "B", 金額: "500" }),
      makeRecord({ 種別: "C", 金額: "50" }),
    ],
  });

  const result = await execute(
    `WITH 集計 AS (
       SELECT 種別, SUM(金額) AS 合計 FROM APP100 GROUP BY 種別
     )
     SELECT 種別, 合計 FROM 集計 ORDER BY 合計 DESC LIMIT 2`,
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
  expect(result.rows[0]["種別"]).toBe("B"); // 合計 500 が最大
  expect(result.rows[0]["合計"]).toBe("500");
});

test("WITH — CTE を JOIN で使う", async () => {
  // APP100: 顧客マスタ, APP200: 注文（集計してから JOIN）
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ 顧客ID: "1", 顧客名: "田中" }),
        makeRecord({ 顧客ID: "2", 顧客名: "鈴木" }),
      ],
      200: [
        makeRecord({ 顧客ID: "1", 金額: "1000" }),
        makeRecord({ 顧客ID: "1", 金額: "2000" }),
        makeRecord({ 顧客ID: "2", 金額: "500" }),
      ],
    },
  });

  // SELECT * で結合結果を取得。行は "c.フィールド" / "r.フィールド" キー付き
  const result = await execute(
    `WITH 受注集計 AS (
       SELECT 顧客ID, SUM(金額) AS 合計 FROM APP200 GROUP BY 顧客ID
     )
     SELECT *
     FROM APP100 AS c
     INNER JOIN 受注集計 AS r ON c.顧客ID = r.顧客ID`,
    client
  ) as SelectResult;

  // 合計で降順ソート（テスト側で整列）
  const rows = result.rows.sort((a, b) => Number(b["r.合計"]) - Number(a["r.合計"]));
  expect(result.rowCount).toBe(2);
  expect(rows[0]["c.顧客名"]).toBe("田中"); // 合計 3000
  expect(rows[0]["r.合計"]).toBe("3000");
  expect(rows[1]["c.顧客名"]).toBe("鈴木"); // 合計 500
});

test("WITH — 複数 CTE を順番に定義して最終クエリで絞り込み", async () => {
  // GROUP BY を使うことで CTE が FULL_SCAN モードになり JS 側でフィルタが機能する
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "A", 金額: "200" }),
      makeRecord({ 種別: "B", 金額: "50" }),
    ],
  });

  // 各 CTE は GROUP BY で集計（FULL_SCAN モード）→ JS 集計
  // 最終クエリは CTE 参照なので JS 側 WHERE が機能する
  const result = await execute(
    `WITH
       A類 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 WHERE 種別 = 'A' GROUP BY 種別),
       B類 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 WHERE 種別 = 'B' GROUP BY 種別)
     SELECT 種別, 合計 FROM A類 WHERE 合計 > 0`,
    client
  ) as SelectResult;

  // A類: A の SUM = 300、最終 WHERE 合計 > 0 → 1行
  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["種別"]).toBe("A");
  expect(result.rows[0]["合計"]).toBe("300");
});

test("WITH インライン化 — 単純 CTE の WHERE が REST API クエリに渡る", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "B", 金額: "200" }),
    ],
  });

  // CTE が SIMPLE モード + 最終 WHERE が単純比較 → インライン化される
  await execute(
    `WITH 全件 AS (SELECT * FROM APP100 WHERE 種別 = 'A')
     SELECT * FROM 全件 WHERE 金額 > 50`,
    client
  ) as SelectResult;

  // インライン化により CTE WHERE と最終 WHERE が AND で合成されて REST API へ
  expect(client.getCalls.length).toBeGreaterThan(0);
  const sentQuery = client.getCalls[0].query;
  expect(sentQuery).toContain('種別 = "A"');
  expect(sentQuery).toContain("金額 > 50");
  expect(sentQuery).toContain(" and ");
});

test("WITH インライン化 — CTE WHERE のみ（最終 WHERE なし）", async () => {
  const client = makeClient({
    records: [makeRecord({ 種別: "A" }), makeRecord({ 種別: "B" })],
  });

  await execute(
    `WITH 対象 AS (SELECT * FROM APP100 WHERE 種別 = 'A')
     SELECT * FROM 対象`,
    client
  ) as SelectResult;

  // CTE WHERE がそのまま REST API へ
  expect(client.getCalls[0].query).toContain('種別 = "A"');
});

test("WITH インライン化 — GROUP BY CTE は非インライン（FULL_SCAN のまま）", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 種別: "A", 金額: "100" }),
      makeRecord({ 種別: "A", 金額: "200" }),
    ],
  });

  await execute(
    `WITH 集計 AS (SELECT 種別, SUM(金額) AS 合計 FROM APP100 GROUP BY 種別)
     SELECT * FROM 集計 WHERE 合計 > 100`,
    client
  ) as SelectResult;

  // GROUP BY があるため非インライン → CTE と最終クエリで別個に評価
  expect(client.getCalls.length).toBeGreaterThan(0);
});

test("WITH インライン化 — LIMIT が最終クエリから REST API に渡る", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 金額: "300" }),
      makeRecord({ 金額: "100" }),
      makeRecord({ 金額: "200" }),
    ],
  });

  await execute(
    `WITH 全件 AS (SELECT * FROM APP100)
     SELECT * FROM 全件 ORDER BY 金額 ASC LIMIT 2`,
    client
  ) as SelectResult;

  // LIMIT が REST API クエリに含まれる（SIMPLE モードとしてインライン化）
  expect(client.getCalls[0].query).toContain("limit 2");
});

test("WITH インライン化 — エイリアス付き FROM (FROM cte AS c WHERE c.field)", async () => {
  const client = makeClient({
    records: [makeRecord({ 金額: "500" }), makeRecord({ 金額: "100" })],
  });

  await execute(
    `WITH 全件 AS (SELECT * FROM APP100 WHERE 種別 = 'A')
     SELECT * FROM 全件 AS c WHERE c.金額 > 200`,
    client
  ) as SelectResult;

  // エイリアス c が除去されて 金額 > 200 が kintone クエリに変換される
  const sentQuery = client.getCalls[0].query;
  expect(sentQuery).toContain("金額 > 200");
});

test("WITH — CTE 内で UNION ALL", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ 名前: "田中" })],
      200: [makeRecord({ 名前: "田中" }), makeRecord({ 名前: "鈴木" })],
    },
  });

  const result = await execute(
    `WITH 合算 AS (
       SELECT 名前 FROM APP100
       UNION ALL
       SELECT 名前 FROM APP200
     )
     SELECT 名前 FROM 合算`,
    client
  ) as SelectResult;

  // UNION ALL なので重複保持: 田中, 田中, 鈴木
  expect(result.rowCount).toBe(3);
});

// ----------------------------------------------------------------
// CASE WHEN — WHERE フィルタ / UPDATE SET
// ----------------------------------------------------------------

test("CASE WHEN WHERE フィルタ — 左辺 CASE: 区分で金額を切り替えて比較", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 区分: "特別", 金額: "800",  名前: "田中" }),
      makeRecord({ 区分: "通常", 金額: "1500", 名前: "鈴木" }),
      makeRecord({ 区分: "特別", 金額: "1200", 名前: "佐藤" }),
    ],
  });

  // CASE WHEN 区分 = '特別' THEN 金額 ELSE 0 END > 1000
  // → 特別かつ金額>1000 の行だけ通過: 佐藤(1200)
  const result = await execute(
    "SELECT 名前 FROM APP100 WHERE CASE WHEN 区分 = '特別' THEN 金額 ELSE 0 END > 1000",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["名前"]).toBe("佐藤");
});

test("CASE WHEN WHERE フィルタ — 右辺 CASE: ELSE を持つ分岐比較", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 区分: "A", スコア: "90" }),
      makeRecord({ 区分: "B", スコア: "60" }),
      makeRecord({ 区分: "A", スコア: "70" }),
    ],
  });

  // WHERE スコア > CASE WHEN 区分 = 'A' THEN 80 ELSE 50 END
  // 区分A→閾値80: 90 > 80 ✓, 70 > 80 ✗
  // 区分B→閾値50: 60 > 50 ✓
  const result = await execute(
    "SELECT * FROM APP100 WHERE スコア > CASE WHEN 区分 = 'A' THEN 80 ELSE 50 END",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(2);
});

test("CASE WHEN WHERE フィルタ — ELSE なし: マッチしない行は ELSE 相当が空文字", async () => {
  const client = makeClient({
    records: [
      makeRecord({ 区分: "X", 名前: "山田" }),
      makeRecord({ 区分: "A", 名前: "田中" }),
    ],
  });

  // CASE WHEN 区分 = 'A' THEN 区分 END = 'A'
  // 区分Aの行: THEN 区分 → 'A' = 'A' ✓
  // 区分Xの行: ELSE なし → '' = 'A' ✗
  const result = await execute(
    "SELECT 名前 FROM APP100 WHERE CASE WHEN 区分 = 'A' THEN 区分 END = 'A'",
    client
  ) as SelectResult;

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]["名前"]).toBe("田中");
});

test("UPDATE SET CASE WHEN — 区分に応じて金額を更新", async () => {
  const records = [
    makeRecord({ $id: "1", 区分: "特別", 金額: "1000" }),
    makeRecord({ $id: "2", 区分: "通常", 金額: "1000" }),
  ];
  const client = makeClient({ records });

  await execute(
    "UPDATE APP100 SET 金額 = CASE WHEN 区分 = '特別' THEN 500 ELSE 1200 END WHERE $id > 0",
    client
  );

  expect(client.putCalls).toHaveLength(1);
  const batch = client.putCalls[0].records;
  const rec1 = batch.find((r) => r.id === 1)!;
  const rec2 = batch.find((r) => r.id === 2)!;
  expect(rec1.record["金額"].value).toBe("500");
  expect(rec2.record["金額"].value).toBe("1200");
});

test("UPDATE SET CASE WHEN — 複数フィールドを混在更新（ARITH と CASE）", async () => {
  const records = [
    makeRecord({ $id: "1", 区分: "A", 単価: "100", 数量: "3" }),
  ];
  const client = makeClient({ records });

  // SET 合計 = 単価 * 数量, ランク = CASE WHEN 区分 = 'A' THEN '上位' ELSE '下位' END
  await execute(
    "UPDATE APP100 SET 合計 = 単価 * 数量, ランク = CASE WHEN 区分 = 'A' THEN '上位' ELSE '下位' END WHERE $id = 1",
    client
  );

  expect(client.putCalls).toHaveLength(1);
  const batch = client.putCalls[0].records;
  expect(batch[0].record["合計"].value).toBe("300");
  expect(batch[0].record["ランク"].value).toBe("上位");
});

// ----------------------------------------------------------------
// UPDATE SET スカラーサブクエリ
// ----------------------------------------------------------------

test("UPDATE SET スカラーサブクエリ — サブクエリの値で全件 PUT", async () => {
  // GET 1回目: MAX(合計費用) のサブクエリ → 5000 を返す
  // GET 2回目: UPDATE 対象の $id 取得
  const subqueryRecords = [makeRecord({ 合計費用: "5000" })];
  const updateRecords   = [makeRecord({ $id: "1" }), makeRecord({ $id: "2" })];
  let getCallCount = 0;
  const client = makeClient();
  (client as KintoneClient & { getRecords: KintoneClient["getRecords"] }).getRecords = async () => {
    getCallCount++;
    if (getCallCount === 1) return { records: subqueryRecords }; // SELECT MAX(合計費用)
    return { records: updateRecords };                            // UPDATE 対象 $id
  };

  const result = await execute(
    "UPDATE APP88 SET 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%', '100%')",
    client
  ) as UpdateResult;

  expect(result.updatedCount).toBe(2);
  expect(client.putCalls).toHaveLength(1);
  // 解決済みの値 '5000' がそのまま SET される
  expect(client.putCalls[0].records[0].record["上限費用"].value).toBe("5000");
  expect(client.putCalls[0].records[1].record["上限費用"].value).toBe("5000");
});

test("UPDATE SET スカラーサブクエリ — 0 行返す場合はエラー", async () => {
  const client = makeClient({ records: [] }); // サブクエリが 0 件
  await expect(
    execute(
      "UPDATE APP88 SET 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%')",
      client
    )
  ).rejects.toThrow("値を返しませんでした");
});

test("UPDATE SET スカラーサブクエリ — 通常 SET との混在", async () => {
  const subqueryRecords = [makeRecord({ 合計費用: "9999" })];
  const updateRecords   = [makeRecord({ $id: "10" })];
  let getCallCount = 0;
  const client = makeClient();
  (client as KintoneClient & { getRecords: KintoneClient["getRecords"] }).getRecords = async () => {
    getCallCount++;
    if (getCallCount === 1) return { records: subqueryRecords };
    return { records: updateRecords };
  };

  await execute(
    "UPDATE APP88 SET ステータス = '完了', 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%')",
    client
  ) as UpdateResult;

  const record = client.putCalls[0].records[0].record;
  expect(record["ステータス"].value).toBe("完了");
  expect(record["上限費用"].value).toBe("9999");
});

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

test("構文エラーは ParseError として伝播する", async () => {
  const client = makeClient();
  const { ParseError } = await import("../parser/parser");
  await expect(execute("SELECT FROM", client)).rejects.toThrow(ParseError);
});

test("未知の文字は LexError として伝播する", async () => {
  const client = makeClient();
  const { LexError } = await import("../lexer/lexer");
  await expect(execute("@invalid", client)).rejects.toThrow(LexError);
});

test("DELETE WHERE なしは ParseError", async () => {
  const client = makeClient();
  const { ParseError } = await import("../parser/parser");
  await expect(execute("DELETE FROM APP100", client)).rejects.toThrow(ParseError);
});
