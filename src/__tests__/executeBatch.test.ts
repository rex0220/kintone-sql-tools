// ============================================================
// executeBatch（バッチ実行 + 一時テーブルストア）のテスト（フェーズ1 S4）
//
// モッククライアント注入でネットワークなしに検証する。
// 依存スキップは「client 呼び出しが発生しないこと」、
// DROP のストア解放は「同名の再 CREATE が通ること」で観測する。
// ============================================================

import {
  execute,
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
  putCalls: { app: number; records: unknown[] }[];
} {
  const getCalls: { app: number; query: string }[] = [];
  const postCalls: { app: number; records: unknown[] }[] = [];
  const putCalls: { app: number; records: unknown[] }[] = [];
  return {
    getCalls,
    postCalls,
    putCalls,
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
    async putRecords(params) {
      putCalls.push({ app: params.app, records: [...params.records] });
    },
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

test("SET の数値式を ASSERT と WHERE へ型付きリテラルとして置換する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "SET @min = 2 + 3 * 4; ASSERT @min = 14; SELECT 顧客名 FROM APP100 WHERE 売上 > @min",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements.map((s) => s.type)).toEqual(["SET_VARIABLE", "ASSERT", "SELECT"]);
  expect(client.getCalls[0].query).toContain("売上 > 14");
});

test("DECLARE は既定値を使い、外部注入を大小無視で上書きする", async () => {
  const sql = "DECLARE @min = '100'; SELECT 顧客名 FROM APP100 WHERE 売上 > @min";
  const defaultClient = makeClient({ recordsByApp: { 100: APP1 } });
  await executeBatch(sql, defaultClient);
  expect(defaultClient.getCalls[0].query).toContain('売上 > "100"');

  const injectedClient = makeClient({ recordsByApp: { 100: APP1 } });
  await executeBatch(sql, injectedClient, { variables: { Min: "300" } });
  expect(injectedClient.getCalls[0].query).toContain('売上 > "300"');
});

test("DECLARE の未宣言注入・重複キー・SET への注入を実行前に拒否する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  await expect(executeBatch(
    "DECLARE @x = 'A'; SELECT * FROM APP100 WHERE 顧客名 = @x",
    client,
    { variables: { typo: "A" } }
  )).rejects.toThrow(/@typo is not declared/);
  expect(client.getCalls).toHaveLength(0);
  await expect(executeBatch(
    "DECLARE @x = 'A'; SELECT * FROM APP100 WHERE 顧客名 = @x",
    client,
    { variables: { x: "A", X: "B" } }
  )).rejects.toThrow(/specified more than once/);
  await expect(executeBatch(
    "SET @x = 'A'; SELECT * FROM APP100 WHERE 顧客名 = @x",
    client,
    { variables: { x: "B" } }
  )).rejects.toThrow(/@x is not declared/);
});

test("SET の文字列関数を UPDATE SET と WHERE に置換する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "SET @name = CONCAT('A', 'B'); SET @id = 2; UPDATE APP100 SET 顧客名 = @name WHERE $id = @id",
    client
  );
  expect(r.ok).toBe(true);
  expect(client.getCalls[0].query).toContain("$id = 2");
  expect(client.putCalls[0].records[0]).toMatchObject({ record: { 顧客名: { value: "AB" } } });
});

test("IN リストのスカラー変数を SIMPLE 経路でリテラルへ置換する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "SET @a = 'A社'; SET @b = 'B社'; SELECT 顧客名 FROM APP100 WHERE 顧客名 IN (@a, @b, 'C社')",
    client
  );
  expect(r.ok).toBe(true);
  expect(client.getCalls[0].query).toContain('顧客名 in ("A社","B社","C社")');
});

test("IN (@x) と NOT IN (@x) を FULL_SCAN 経路でスカラー1要素として評価する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const r = await executeBatch(
    "SET @x = 'B社';" +
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "SELECT 顧客名 FROM #t WHERE 顧客名 IN (@x);" +
    "SELECT 顧客名 FROM #t WHERE 顧客名 NOT IN (@x)",
    client
  );
  expect(r.ok).toBe(true);
  expect((r.statements[2].result as SelectResult).rows.map((row) => row["顧客名"]))
    .toEqual(["B社"]);
  expect((r.statements[3].result as SelectResult).rows.map((row) => row["顧客名"]))
    .toEqual(["A社", "C社"]);
});

test("SET の失敗は continueOnError=true でも後続を停止する", async () => {
  const r = await executeBatch("SET @bad = 1 / 0; SELECT * FROM APP100", makeClient(), { continueOnError: true });
  expect(r.ok).toBe(false);
  expect(r.statements[0].status).toBe("error");
  expect(r.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
});

test("単文 SET と単文の変数参照は execute で拒否する", async () => {
  await expect(execute("SET @x = 1", makeClient())).rejects.toThrow(/SET variable requires a batch/);
  await expect(execute("SELECT * FROM APP100 WHERE 売上 > @x", makeClient()))
    .rejects.toThrow(/variable @x is not defined in a batch/);
});

test("SET LOGINUSER() は実行前に拒否し、空文字変数を作らない", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  await expect(executeBatch(
    "SET @user = LOGINUSER(); SELECT * FROM APP100 WHERE 作成者 = @user",
    client
  )).rejects.toThrow(/SET の右辺で LOGINUSER\(\) は使用できません/);
  expect(client.getCalls).toHaveLength(0);
});

test("SET スカラーサブクエリを1回だけ評価し、COUNT結果を複数のASSERTで再利用する", async () => {
  const client = makeClient({ recordsByApp: { 8101: APP1 } });
  const r = await executeBatch(
    "SET @cnt = (SELECT COUNT(*) FROM APP8101 WHERE 売上 > 0);" +
    "ASSERT @cnt = 3;" +
    "ASSERT @cnt BETWEEN 1 AND 10",
    client
  );

  expect(r.ok).toBe(true);
  expect(r.statements.map((s) => s.status)).toEqual(["success", "success", "success"]);
  expect(client.getCalls.filter((call) => call.app === 8101)).toHaveLength(1);
});

test("SET スカラーサブクエリは先行変数をWHEREで参照できる", async () => {
  const client = makeClient({ recordsByApp: { 8102: APP1 } });
  const r = await executeBatch(
    "SET @cutoff = 200;" +
    "SET @cnt = (SELECT COUNT(*) FROM APP8102 WHERE 売上 > @cutoff);" +
    "ASSERT @cnt = 2",
    client
  );

  expect(r.ok).toBe(true);
  expect(client.getCalls[0].query).not.toContain("@cutoff");
});

test("SET スカラーサブクエリ内の未定義・前方変数参照は実行前に拒否する", async () => {
  const client = makeClient();
  await expect(executeBatch(
    "SET @cnt = (SELECT COUNT(*) FROM APP8103 WHERE 売上 > @cutoff);" +
    "SET @cutoff = 200; ASSERT @cnt >= 0",
    client
  )).rejects.toThrow(/variable @cutoff is not defined before statement 1/);
  expect(client.getCalls).toHaveLength(0);
});

test("SET スカラーサブクエリは先行一時テーブルを参照できる", async () => {
  const client = makeClient({ recordsByApp: { 8104: APP1 } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP8104;" +
    "SET @cnt = (SELECT COUNT(*) FROM #t);" +
    "ASSERT @cnt = 3",
    client
  );

  expect(r.ok).toBe(true);
  expect(client.getCalls.filter((call) => call.app === 8104)).toHaveLength(1);
});

test("SET スカラー違反は ArgumentError かつ continueOnError=true でも fail-fast", async () => {
  const client = makeClient({ recordsByApp: { 8105: [] } });
  const r = await executeBatch(
    "SET @x = (SELECT 売上 FROM APP8105); SELECT * FROM APP8106",
    client,
    { continueOnError: true }
  );

  expect(r.ok).toBe(false);
  expect(r.statements[0]).toMatchObject({
    status: "error",
    error: { code: "ArgumentError" },
  });
  expect(r.statements[0].error?.message).toContain("scalar subquery returned no rows");
  expect(r.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
});

test("ASSERT スカラー違反は従来どおり AssertError かつ assertion 停止", async () => {
  const client = makeClient({ recordsByApp: { 8107: [] } });
  const r = await executeBatch(
    "ASSERT (SELECT 売上 FROM APP8107) = 1; SELECT * FROM APP8108",
    client,
    { continueOnError: true }
  );

  expect(r.statements[0]).toMatchObject({
    status: "error",
    error: { code: "AssertError" },
  });
  expect(r.statements[1]).toMatchObject({ status: "skipped", skippedReason: "assertion" });
});

test("SET スカラーサブクエリの複数行・ワイルドカード複数列を実行時に拒否する", async () => {
  const multiRows = await executeBatch(
    "SET @x = (SELECT 売上 FROM APP8109); ASSERT @x > 0",
    makeClient({ recordsByApp: { 8109: APP1 } })
  );
  expect(multiRows.statements[0].error?.message).toMatch(/(?:2 or more|3) rows/);

  const multiColumns = await executeBatch(
    "SET @x = (SELECT * FROM APP8110); ASSERT @x > 0",
    makeClient({ recordsByApp: { 8110: [makeRecord({ $id: "1", a: "x", b: "y" })] } })
  );
  expect(multiColumns.statements[0].error?.message).toMatch(/3 columns/);

  const zeroColumns = await executeBatch(
    "SET @x = (SELECT * FROM APP8113); ASSERT @x > 0",
    makeClient({ recordsByApp: { 8113: [makeRecord({})] } })
  );
  expect(zeroColumns.statements[0].error?.message).toMatch(/0 columns/);
});

test("SET COUNT は対象0件でも文字列0として束縛できる", async () => {
  const r = await executeBatch(
    "SET @cnt = (SELECT COUNT(*) FROM APP8111); ASSERT @cnt = 0",
    makeClient({ recordsByApp: { 8111: [] } })
  );
  expect(r.ok).toBe(true);
});

test("単文のSETスカラーサブクエリはバッチ必須として拒否する", async () => {
  await expect(execute(
    "SET @cnt = (SELECT COUNT(*) FROM APP8112)",
    makeClient()
  )).rejects.toThrow(/SET variable requires a batch/);
});

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

test("0 件集計の CREATE TEMP TABLE は 1 行実体化される（v1.12.0）", async () => {
  const client = makeClient({ recordsByApp: { 300: [] } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT COUNT(*) AS 件数 FROM APP300;" +
    "SELECT 件数 FROM #t",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements[0].rowCount).toBe(1); // 旧: 0 行（列も導出されない）
  const rows = (r.statements[1].result as SelectResult).rows;
  expect(rows).toEqual([{ 件数: "0" }]);
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

test("集計算術式 alias: 一時テーブル後段から alias で参照できる", async () => {
  const client = makeClient({
    recordsByApp: {
      77105: [makeRecord({ 種別: "A", a: "10", b: "3" })],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #g AS " +
    "SELECT 種別, SUM(a) - SUM(b) AS diff FROM APP77105 GROUP BY 種別;" +
    "SELECT diff FROM #g",
    client
  );

  expect(r.ok).toBe(true);
  expect((r.statements[1].result as SelectResult)).toMatchObject({
    columns: ["diff"],
    rows: [{ diff: "7" }],
  });
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

test("INSERT_SELECT: 混在ソース（#t JOIN APP）を実行できる（v1.7.0 解禁）", async () => {
  // #t は APP100 の3社。APP300 には A社・C社のみ存在 → JOIN 結果は2行
  const client = makeClient({
    recordsByApp: {
      100: APP1,
      300: [
        makeRecord({ $id: "1", 顧客名: "A社", 地域: "東京" }),
        makeRecord({ $id: "2", 顧客名: "C社", 地域: "大阪" }),
      ],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "INSERT INTO APP200 (名前, 地域) SELECT a.顧客名, b.地域 FROM #t a INNER JOIN APP300 b ON a.顧客名 = b.顧客名",
    client
  );

  expect(r.ok).toBe(true);
  expect(r.statements[1]).toMatchObject({ type: "INSERT_SELECT", status: "success" });
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].app).toBe(200);
  expect(client.postCalls[0].records).toEqual([
    { 名前: { value: "A社" }, 地域: { value: "東京" } },
    { 名前: { value: "C社" }, 地域: { value: "大阪" } },
  ]);
});

test("INSERT_SELECT: サブクエリ内の一時テーブル参照（WHERE ... IN (SELECT ... FROM #t)）を実行できる", async () => {
  // #all は APP100 の3社、#hi は APP300 由来の B社・C社（SIMPLE モードの WHERE は
  // REST 押し下げでモックに効かないため、絞り込みはアプリ別データで作る。教訓①）。
  // FROM #all の FULL_SCAN でサブクエリ結果によるインメモリ絞り込みを観測する
  const client = makeClient({
    recordsByApp: {
      100: APP1,
      300: [
        makeRecord({ $id: "1", 顧客名: "B社" }),
        makeRecord({ $id: "2", 顧客名: "C社" }),
      ],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #all AS SELECT 顧客名 FROM APP100;" +
    "CREATE TEMP TABLE #hi AS SELECT 顧客名 FROM APP300;" +
    "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #all WHERE 顧客名 IN (SELECT 顧客名 FROM #hi)",
    client
  );

  expect(r.ok).toBe(true);
  expect(r.statements[2]).toMatchObject({ type: "INSERT_SELECT", status: "success" });
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].records).toEqual([
    { 名前: { value: "B社" } },
    { 名前: { value: "C社" } },
  ]);
});

test("UPSERT_SELECT: 一時テーブルソースを実行でき insert / update が振り分けられる（v1.7.0 解禁）", async () => {
  // #t は APP100 の3社。書き込み先 APP400 には B社のみ既存 → update 1 + insert 2
  const client = makeClient({
    recordsByApp: {
      100: APP1,
      400: [makeRecord({ $id: "9", 顧客名: "B社" })],
    },
  });
  const confirmCalls: Array<{ count: number; operation: string }> = [];
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "UPSERT INTO APP400 (顧客名) SELECT 顧客名 FROM #t ON DUPLICATE (顧客名)",
    client,
    {
      confirm: async (count, operation) => {
        confirmCalls.push({ count, operation });
        return true;
      },
    }
  );

  expect(r.ok).toBe(true);
  expect(confirmCalls).toEqual([{ count: 3, operation: "UPDATE" }]); // 照合後の合計
  expect(r.statements[1]).toMatchObject({ type: "UPSERT_SELECT", status: "success" });
  expect(r.statements[1].result).toMatchObject({
    type: "UPSERT",
    insertedCount: 2,
    updatedCount: 1,
  });
  expect(client.postCalls).toHaveLength(1); // A社・C社の INSERT
  expect(client.putCalls).toHaveLength(1); // B社の UPDATE
});

test("UPSERT_SELECT: 明示列の空一時テーブルは書き込みなしで成功する", async () => {
  const client = makeClient({ recordsByApp: { 100: [], 400: [] } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100;" +
    "UPSERT INTO APP400 (顧客名, 売上) SELECT 顧客名, 売上 FROM #t ON DUPLICATE (顧客名)",
    client,
    { cacheContext: "empty-temp-upsert-select" }
  );

  expect(r.ok).toBe(true);
  expect(r.statements[0]).toMatchObject({ status: "success", rowCount: 0 });
  expect(r.statements[1]).toMatchObject({ type: "UPSERT_SELECT", status: "success" });
  expect(r.statements[1].result).toMatchObject({
    type: "UPSERT",
    insertedCount: 0,
    updatedCount: 0,
  });
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("UPSERT_SELECT: 空 SELECT * の列数エラーは明示列を案内する", async () => {
  const client = makeClient({ recordsByApp: { 100: [], 400: [] } });
  const r = await executeBatch(
    "UPSERT INTO APP400 (顧客名) SELECT * FROM APP100 ON DUPLICATE (顧客名)",
    client,
    { cacheContext: "empty-upsert-wildcard-message" }
  );

  expect(r.ok).toBe(false);
  expect(r.statements[0].error?.message).toContain(
    "結果が 0 行のため列を特定できませんでした（SELECT * を空ソースに使うと列を決定できません。明示列で指定してください）"
  );
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("UPSERT_SELECT: 一時テーブルソースでも confirm 拒否で当該文ゼロ書き込み", async () => {
  const client = makeClient({
    recordsByApp: { 100: APP1, 400: [] },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "UPSERT INTO APP400 (顧客名) SELECT 顧客名 FROM #t ON DUPLICATE (顧客名)",
    client,
    {
      confirm: async (count) => {
        if (count > 2) throw new Error("ArgumentError: UPDATE affected rows exceed limit.");
        return true;
      },
    }
  );

  expect(r.ok).toBe(false);
  expect(r.statements[1].status).toBe("error");
  expect(client.postCalls).toHaveLength(0); // 書き込み前に止まる
  expect(client.putCalls).toHaveLength(0);
});

test("UPSERT_SELECT: 混在ソース（#t JOIN APP）を実行できる（v1.7.0 解禁）", async () => {
  const client = makeClient({
    recordsByApp: {
      100: APP1,
      300: [makeRecord({ $id: "1", 顧客名: "A社", 地域: "東京" })],
      400: [makeRecord({ $id: "9", 顧客名: "A社" })],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "UPSERT INTO APP400 (顧客名, 地域) SELECT a.顧客名, b.地域 FROM #t a INNER JOIN APP300 b ON a.顧客名 = b.顧客名 ON DUPLICATE (顧客名)",
    client
  );

  expect(r.ok).toBe(true);
  expect(r.statements[1]).toMatchObject({ type: "UPSERT_SELECT", status: "success" });
  expect(r.statements[1].result).toMatchObject({
    type: "UPSERT",
    insertedCount: 0,
    updatedCount: 1, // A社は APP400 に既存 → update
  });
  expect(client.putCalls).toHaveLength(1);
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

// ----------------------------------------------------------------
// 非 Error の reject（プラグインの kintone.api 形式）のエラー整形
// ----------------------------------------------------------------

test("kintone.api 形式のオブジェクト reject が code/message に整形される", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  client.getRecords = async (params) => {
    if (params.app === 9999999) {
      // kintone.api は Error ではなく素のオブジェクトで reject する
      throw { code: "GAIA_AP01", message: "指定したアプリ（id: 9999999）が見つかりません。", id: "x" };
    }
    return { records: APP1 as never };
  };
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客No FROM APP9999999; SELECT * FROM #t",
    client
  );
  expect(r.ok).toBe(false);
  expect(r.statements[0].error).toEqual({
    code: "GAIA_AP01",
    message: "指定したアプリ（id: 9999999）が見つかりません。",
  });
  expect(r.statements[0].error?.message).not.toContain("[object Object]");
  expect(r.statements[1].status).toBe("skipped");
});

test("非 Error でも message の XxxError: 接頭辞から code を抽出する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  client.getRecords = async (params) => {
    if (params.app === 300) throw "ArgumentError: string reject"; // 文字列 throw
    if (params.app === 400) throw { message: "ParseError: object without code" }; // code なしオブジェクト
    return { records: APP1 as never };
  };

  const r1 = await executeBatch("SELECT x FROM APP300; SELECT x FROM APP100", client, { continueOnError: true });
  expect(r1.statements[0].error).toEqual({ code: "ArgumentError", message: "ArgumentError: string reject" });

  const r2 = await executeBatch("SELECT x FROM APP400; SELECT x FROM APP100", client, { continueOnError: true });
  expect(r2.statements[0].error).toEqual({ code: "ParseError", message: "ParseError: object without code" });
});

// ----------------------------------------------------------------
// confirm の文コンテキスト（v1.9.0 プラグイン DML バッチ対応）
// ----------------------------------------------------------------

test("confirm に文コンテキスト（statementIndex / targetAppId 等）が渡る", async () => {
  const client = makeClient({
    recordsByApp: {
      100: APP1,
      400: [makeRecord({ $id: "9", 顧客名: "B社" })],
    },
  });
  const contexts: unknown[] = [];
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "UPSERT INTO APP400 (顧客名) SELECT 顧客名 FROM #t ON DUPLICATE (顧客名);" +
    "SELECT 顧客名 FROM #t",
    client,
    {
      confirm: async (_count, _operation, context) => {
        contexts.push(context);
        return true;
      },
    }
  );
  expect(r.ok).toBe(true);
  expect(contexts).toEqual([
    {
      statementIndex: 1,
      statementCount: 3,
      statementType: "UPSERT_SELECT",
      targetAppId: 400,
    },
  ]);
});

test("INSERT VALUES（confirm 非経由）が混在しても文コンテキストはずれない", async () => {
  // 文0: CREATE（confirm なし）
  // 文1: INSERT VALUES（confirm 非経由で書き込まれる — コア実態の回帰固定）
  // 文2: DELETE（confirm 呼び出し）→ statementIndex = 2 が正しく渡ること
  //（confirm 呼び出し回数から文番号を推測すると1回目 = 文1 と誤る）
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const contexts: unknown[] = [];
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "INSERT INTO APP200 (名前) VALUES ('X'), ('Y');" +
    "DELETE FROM APP100 WHERE 顧客名 = 'A社'",
    client,
    {
      confirm: async (_count, _operation, context) => {
        contexts.push(context);
        return true;
      },
    }
  );
  expect(r.ok).toBe(true);
  expect(contexts).toEqual([
    {
      statementIndex: 2,
      statementCount: 3,
      statementType: "DELETE",
      targetAppId: 100,
    },
  ]);
  // INSERT VALUES は confirm なしで書き込まれている（コア実態。
  // プラグインはこれを実行前静的確認で塞ぐ — 仕様 §3.3）
  expect(client.postCalls.filter((c) => c.app === 200)).toHaveLength(1);
});

test("confirm 拒否（キャンセル）は OperationCancelledError code の文エラーになり後続は fail-fast", async () => {
  const client = makeClient({
    recordsByApp: { 100: APP1, 400: [makeRecord({ $id: "9", 顧客名: "B社" })] },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "UPSERT INTO APP400 (顧客名) SELECT 顧客名 FROM #t ON DUPLICATE (顧客名);" +
    "SELECT 顧客名 FROM #t",
    client,
    { confirm: async () => false }
  );
  expect(r.ok).toBe(false);
  expect(r.statements[1].status).toBe("error");
  expect(r.statements[1].error?.code).toBe("OperationCancelledError");
  expect(r.statements[2].status).toBe("skipped");
  expect(r.statements[2].skippedReason).toBe("fail-fast");
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("単文実行（execute）では confirm の context は undefined（後方互換）", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const contexts: unknown[] = [];
  await execute("DELETE FROM APP100 WHERE 顧客名 = 'A社'", client, {
    confirm: async (_count, _operation, context) => {
      contexts.push(context);
      return true;
    },
  });
  expect(contexts).toEqual([undefined]);
});

test("SELECT-based DML のソース読み取りは onLimitReached=truncate に従う（UI/CLI 層が DML で error 固定にすべき根拠）", async () => {
  // APP100 は 3 行。maxRecords=2 + truncate だとソースが黙って 2 行に切り捨てられ、
  // 切り捨て後の件数で confirm → 部分書き込みになる。
  // プラグインは DML を含む実行で onLimitReached を "error" に固定してこれを防ぐ
  //（v1.9.0 仕様 §3.6。MCP ksql_mutate は DEFAULT_ON_LIMIT="error" 固定で従来から安全）
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const confirmCounts: number[] = [];
  const r = await executeBatch(
    "SELECT 顧客名 FROM APP100;" +
    "INSERT INTO APP200 (名前) SELECT 顧客名 FROM APP100",
    client,
    {
      maxRecords: 2,
      onLimitReached: "truncate",
      confirm: async (count) => {
        confirmCounts.push(count);
        return true;
      },
    }
  );
  expect(r.ok).toBe(true);
  expect(confirmCounts).toEqual([2]); // 3 行のソースが切り捨て後の件数で confirm される
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].records).toHaveLength(2); // 部分書き込み
});
