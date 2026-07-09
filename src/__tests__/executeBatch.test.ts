// ============================================================
// executeBatch（バッチ実行 + 一時テーブルストア）のテスト（フェーズ1 S4）
//
// モッククライアント注入でネットワークなしに検証する。
// 依存スキップは「client 呼び出しが発生しないこと」、
// DROP のストア解放は「同名の再 CREATE が通ること」で観測する。
// ============================================================

import {
  executeBatch,
  KintoneClient,
  SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}

interface MockOptions {
  recordsByApp?: Record<number, KintoneRecord[]>;
  /** このアプリへの getRecords を失敗させる */
  failApps?: number[];
  /** getRecords を遅延させる（ミリ秒） */
  delayMs?: number;
}

function makeClient(opts: MockOptions = {}): KintoneClient & {
  getCalls: { app: number; query: string }[];
  postCalls: { app: number; records: unknown[] }[];
} {
  const getCalls: { app: number; query: string }[] = [];
  const postCalls: { app: number; records: unknown[] }[] = [];
  return {
    getCalls,
    postCalls,
    async getRecords(params) {
      getCalls.push({ app: params.app, query: params.query ?? "" });
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.failApps?.includes(params.app)) {
        throw new Error(`FetchError: mock failure for APP${params.app}`);
      }
      return { records: opts.recordsByApp?.[params.app] ?? [] };
    },
    async postRecords(params) {
      postCalls.push({ app: params.app, records: [...params.records] });
      return { ids: params.records.map((_r, i) => String(i + 1)) };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return []; },
  };
}

const APP1 = [
  makeRecord({ $id: "1", 顧客名: "A社", 売上: "100" }),
  makeRecord({ $id: "2", 顧客名: "B社", 売上: "300" }),
  makeRecord({ $id: "3", 顧客名: "C社", 売上: "500" }),
];

// ----------------------------------------------------------------
// 最小経路: CREATE → 参照
// ----------------------------------------------------------------

test("CREATE → SELECT 参照の最小経路", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100; SELECT 顧客名 FROM #t WHERE 売上 > 200",
    client
  );

  expect(r.ok).toBe(true);
  expect(r.statementCount).toBe(2);

  const create = r.statements[0];
  expect(create.status).toBe("success");
  expect(create.tempTable).toBe("#t");
  expect(create.rowCount).toBe(3);
  expect(create.result).toBeUndefined(); // 実体化結果は返さない

  const select = r.statements[1];
  expect(select.status).toBe("success");
  const rows = (select.result as SelectResult).rows;
  expect(rows.map((row) => row["顧客名"])).toEqual(["B社", "C社"]);

  // #t の参照はインメモリ FULL_SCAN であり kintone を読まない
  expect(client.getCalls.every((c) => c.app === 100)).toBe(true);
});

test("JOIN で一時テーブルを参照できる", async () => {
  const client = makeClient({
    recordsByApp: {
      100: APP1,
      200: [makeRecord({ $id: "10", 顧客名: "B社", 地域: "東京" })],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100;" +
    "SELECT a.地域, b.売上 FROM APP200 a INNER JOIN #t b ON a.顧客名 = b.顧客名",
    client
  );
  expect(r.ok).toBe(true);
  const rows = (r.statements[1].result as SelectResult).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]["a.地域"] ?? rows[0]["地域"]).toBe("東京");
});

test("WITH（CTE）から一時テーブルを参照できる", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100;" +
    "WITH c AS (SELECT 顧客名 FROM #t WHERE 売上 > 200) SELECT 顧客名 FROM c",
    client
  );
  expect(r.ok).toBe(true);
  const rows = (r.statements[1].result as SelectResult).rows;
  expect(rows.map((row) => row["顧客名"])).toEqual(["B社", "C社"]);
});

test("CREATE の AS 句が先行の一時テーブルを参照できる", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #a AS SELECT 顧客名, 売上 FROM APP100;" +
    "CREATE TEMP TABLE #b AS SELECT 顧客名 FROM #a WHERE 売上 > 200;" +
    "SELECT 顧客名 FROM #b",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements[1].rowCount).toBe(2);
  expect((r.statements[2].result as SelectResult).rowCount).toBe(2);
});

test("DROP がストアを解放し、同名の再 CREATE が通る", async () => {
  const client = makeClient({
    recordsByApp: { 100: APP1, 200: [makeRecord({ $id: "9", 顧客名: "Z社" })] },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "DROP TEMP TABLE #t;" +
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP200;" +
    "SELECT 顧客名 FROM #t",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements[1].tempTable).toBe("#t");
  expect(r.statements[2].rowCount).toBe(1);
  expect((r.statements[3].result as SelectResult).rows[0]["顧客名"]).toBe("Z社");
});

test("一時テーブルと無関係な文は既存経路で実行される（単文バッチ含む）", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch("SELECT 顧客名 FROM APP100", client);
  expect(r.ok).toBe(true);
  expect(r.statementCount).toBe(1);
  expect((r.statements[0].result as SelectResult).rowCount).toBe(3);
});

// ----------------------------------------------------------------
// サブクエリ内の一時テーブル参照（read-only 文）
// ----------------------------------------------------------------

test("IN サブクエリ内の一時テーブル参照が解決される", async () => {
  // 注: SIMPLE モードの WHERE は REST 側に押し下げられ、クエリを無視する
  // モックでは絞り込まれない。実体化の絞り込みは WHERE に頼らず、
  // 別アプリ(APP200)のデータ内容で構成する。
  const client = makeClient({
    recordsByApp: {
      100: APP1,
      200: [
        makeRecord({ $id: "10", 顧客名: "B社" }),
        makeRecord({ $id: "11", 顧客名: "C社" }),
      ],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP200;" +
    "SELECT 顧客名, 売上 FROM APP100 WHERE 顧客名 IN (SELECT 顧客名 FROM #t)",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements[0].rowCount).toBe(2);
  const rows = (r.statements[1].result as SelectResult).rows;
  expect(rows.map((row) => row["顧客名"])).toEqual(["B社", "C社"]);
});

test("EXISTS サブクエリ内の一時テーブル参照が解決される", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100 WHERE 売上 > 400;" +
    "SELECT 顧客名 FROM APP100 WHERE EXISTS (SELECT 顧客名 FROM #t)",
    client
  );
  expect(r.ok).toBe(true);
  expect((r.statements[1].result as SelectResult).rowCount).toBe(3); // 非相関 EXISTS = 全行
});

test("WHERE のスカラーサブクエリ内の一時テーブル参照が解決される", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 売上 FROM APP100;" +
    "SELECT 顧客名 FROM APP100 WHERE 売上 >= (SELECT MAX(売上) AS m FROM #t)",
    client
  );
  expect(r.ok).toBe(true);
  const rows = (r.statements[1].result as SelectResult).rows;
  expect(rows.map((row) => row["顧客名"])).toEqual(["C社"]);
});

test("SELECT 列のスカラーサブクエリ内の一時テーブル参照が解決される", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 売上 FROM APP100;" +
    "SELECT 顧客名, (SELECT MAX(売上) AS m FROM #t) AS 最大 FROM APP100 WHERE 顧客名 = 'A社'",
    client
  );
  expect(r.ok).toBe(true);
  const rows = (r.statements[1].result as SelectResult).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]["最大"]).toBe("500");
});

// ----------------------------------------------------------------
// validate-all-first
// ----------------------------------------------------------------

test("静的検証違反は1文も実行せずに throw する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  await expect(
    executeBatch("SELECT 顧客名 FROM APP100; SELECT * FROM #t", client)
  ).rejects.toThrow(/temp table #t is not defined in this batch/);
  expect(client.getCalls).toHaveLength(0);
});

test("DML 文内の一時テーブル参照（UPDATE のサブクエリ等）は拒否（実行前）", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  await expect(
    executeBatch(
      "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
      "UPDATE APP200 SET x = '1' WHERE $id IN (SELECT $id FROM #t)",
      client
    )
  ).rejects.toThrow(/temp table references in UPDATE are not supported yet/);
  expect(client.getCalls).toHaveLength(0);
});

// ----------------------------------------------------------------
// 一時テーブル経由の INSERT_SELECT（M4）
// ----------------------------------------------------------------

test("INSERT_SELECT: ソースが一時テーブルのみなら実行できる", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100;" +
    "INSERT INTO APP200 (名前, 金額) SELECT 顧客名, 売上 FROM #t",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements[1].status).toBe("success");
  expect(r.statements[1].result).toMatchObject({ type: "INSERT", insertedCount: 3 });
  // 書き込みは一時テーブルの実体化行から行われる（APP200 の読み取りは発生しない）
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].app).toBe(200);
  expect(client.getCalls.every((c) => c.app === 100)).toBe(true);
});

test("INSERT_SELECT: 実体化済み行数に confirm(dmlMaxRows 相当)が適用される", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const confirmCalls: Array<{ count: number; operation: string }> = [];
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #t",
    client,
    {
      confirm: async (count, operation) => {
        confirmCalls.push({ count, operation });
        if (count > 2) throw new Error("ArgumentError: INSERT affected rows exceed limit.");
        return true;
      },
    }
  );
  // #t は 3 行 → confirm(3, "INSERT") → ガードで拒否 → 文エラー(fail-fast)
  expect(confirmCalls).toEqual([{ count: 3, operation: "INSERT" }]);
  expect(r.ok).toBe(false);
  expect(r.statements[1].status).toBe("error");
  expect(client.postCalls).toHaveLength(0); // 書き込み前に止まる
});

test("INSERT_SELECT: APP ソース混在（JOIN）は拒否（実行前）", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  await expect(
    executeBatch(
      "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
      "INSERT INTO APP200 (名前) SELECT a.顧客名 FROM #t a INNER JOIN APP300 b ON a.顧客名 = b.顧客名",
      client
    )
  ).rejects.toThrow(/INSERT_SELECT in a batch must select from temp tables only\. \(statement 1\)/);
  expect(client.getCalls).toHaveLength(0);
});

// ----------------------------------------------------------------
// 実体化の行数上限
// ----------------------------------------------------------------

test("実体化行数の上限超過はエラー（onLimitReached: truncate でも常に error）", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT * FROM #t",
    client,
    { tempTableMaxRows: 2, onLimitReached: "truncate" }
  );
  expect(r.ok).toBe(false);
  expect(r.statements[0].status).toBe("error");
  expect(r.statements[1].status).toBe("skipped");
});

// ----------------------------------------------------------------
// fail-fast / continueOnError / 依存スキップ
// ----------------------------------------------------------------

test("fail-fast（既定）: エラー文以降はすべて skipped", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 }, failApps: [999] });
  const r = await executeBatch(
    "SELECT 顧客名 FROM APP100; SELECT * FROM APP999; SELECT 顧客名 FROM APP100",
    client
  );
  expect(r.ok).toBe(false);
  expect(r.statements.map((s) => s.status)).toEqual(["success", "error", "skipped"]);
  expect(r.statements[1].error?.code).toBe("FetchError");
  expect(r.statements[2].skippedReason).toBe("fail-fast");
});

test("continueOnError: エラー後も独立した文は実行される", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 }, failApps: [999] });
  const r = await executeBatch(
    "SELECT * FROM APP999; SELECT 顧客名 FROM APP100",
    client,
    { continueOnError: true }
  );
  expect(r.ok).toBe(false);
  expect(r.statements.map((s) => s.status)).toEqual(["error", "success"]);
});

test("continueOnError: 失敗した CREATE に依存する文は skipped（依存スキップ・推移的）", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 }, failApps: [999] });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP999;" + // 失敗
    "CREATE TEMP TABLE #u AS SELECT 顧客名 FROM #t;" +      // #t に依存 → skipped
    "SELECT 顧客名 FROM #u;" +                               // #u に依存 → skipped（推移的）
    "SELECT 顧客名 FROM APP100",                             // 独立 → success
    client,
    { continueOnError: true }
  );
  expect(r.statements.map((s) => s.status)).toEqual(["error", "skipped", "skipped", "success"]);
  expect(r.statements[1].skippedReason).toBe("dependency: #t");
  expect(r.statements[2].skippedReason).toBe("dependency: #u");
  // skipped された文が kintone を読んでいないこと（APP999 失敗 + APP100 成功のみ）
  expect(client.getCalls.map((c) => c.app)).toEqual([999, 100]);
});

test("continueOnError は DML を含むバッチで指定不可", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  await expect(
    executeBatch(
      "SELECT 顧客名 FROM APP100; DELETE FROM APP100 WHERE $id = 1",
      client,
      { continueOnError: true }
    )
  ).rejects.toThrow(/continueOnError is not allowed for batches containing DML/);
  expect(client.getCalls).toHaveLength(0);
});

// ----------------------------------------------------------------
// バッチ合計タイムアウト
// ----------------------------------------------------------------

test("timeout: 実行中の文は error(TimeoutError)、未実行の文は skipped(timeout)", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 }, delayMs: 200 });
  const r = await executeBatch(
    "SELECT 顧客名 FROM APP100; SELECT 顧客名 FROM APP100",
    client,
    { timeoutMs: 50 }
  );
  expect(r.ok).toBe(false);
  expect(r.statements[0].status).toBe("error");
  expect(r.statements[0].error?.code).toBe("TimeoutError");
  expect(r.statements[1].status).toBe("skipped");
  expect(r.statements[1].skippedReason).toBe("timeout");
});

test("timeout 未指定なら遅延があっても完走する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 }, delayMs: 20 });
  const r = await executeBatch("SELECT 顧客名 FROM APP100", client);
  expect(r.ok).toBe(true);
});

// ----------------------------------------------------------------
// エンベロープ
// ----------------------------------------------------------------

test("analysis と metrics がエンベロープに含まれる", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100; SELECT * FROM #t",
    client
  );
  expect(r.analysis.isReadOnlyBatch).toBe(true);
  expect(r.analysis.tempTables).toEqual(["#t"]);
  expect(r.metrics!.getCalls).toBeGreaterThan(0);
});
