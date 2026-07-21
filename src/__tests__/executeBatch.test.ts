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
  DmlValidationResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { buildBatchEnvelope } from "../output/batchEnvelope";

function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}

function makeTypedRecord(fields: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  ) as KintoneRecord;
}

interface MockOptions {
  recordsByApp?: Record<number, KintoneRecord[]>;
  fieldTypes?: Record<string, string>;
  /** このアプリへの getRecords を失敗させる */
  failApps?: number[];
  /** getRecords を遅延させる（ミリ秒） */
  delayMs?: number;
}

function makeClient(opts: MockOptions = {}): KintoneClient & {
  getCalls: { app: number; query: string; fields: string[] }[];
  postCalls: { app: number; records: unknown[] }[];
  putCalls: { app: number; records: unknown[] }[];
} {
  const getCalls: { app: number; query: string; fields: string[] }[] = [];
  const postCalls: { app: number; records: unknown[] }[] = [];
  const putCalls: { app: number; records: unknown[] }[] = [];
  return {
    getCalls,
    postCalls,
    putCalls,
    async getRecords(params) {
      getCalls.push({ app: params.app, query: params.query ?? "", fields: [...(params.fields ?? [])] });
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.failApps?.includes(params.app)) {
        throw new Error(`FetchError: mock failure for APP${params.app}`);
      }
      return { records: opts.recordsByApp?.[params.app] ?? [] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      postCalls.push({ app: params.app, records: [...params.records] });
      return { ids: params.records.map((_r, i) => String(i + 1)) };
    },
    async putRecords(params) {
      putCalls.push({ app: params.app, records: [...params.records] });
    },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields(appId) {
      const codes = new Set((opts.recordsByApp?.[appId] ?? []).flatMap((record) => Object.keys(record)));
      const types = opts.fieldTypes ?? {};
      Object.keys(types).forEach((code) => codes.add(code));
      return [...codes].filter((code) => !code.startsWith("$"))
        .map((code) => ({
          code,
          label: code,
          fieldType: types[code] ?? (code === "売上" || code === "金額" ? "NUMBER" : "SINGLE_LINE_TEXT"),
        }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

const APP1 = [
  makeRecord({ $id: "1", 顧客名: "A社", 売上: "100" }),
  makeRecord({ $id: "2", 顧客名: "B社", 売上: "300" }),
  makeRecord({ $id: "3", 顧客名: "C社", 売上: "500" }),
];

const DML_VALIDATION_META_COLUMNS = [
  "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
  "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
];

test("B10-B: SELECT 変数列を既存 literal/number 列へ解決し CONCAT を維持する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const batch = await executeBatch(
    "SET @s='X'; SET @n=10; SELECT @s AS s, @n AS n, @s || 'Y' AS concat FROM APP100",
    client,
    { cacheContext: "batch-variable-columns" }
  );
  expect(batch.ok).toBe(true);
  const result = batch.statements[2].result as SelectResult;
  expect(result.columns).toEqual(["s", "n", "concat"]);
  expect(result.rows).toEqual(APP1.map(() => ({ s: "X", n: "10", concat: "XY" })));
  expect(client.getCalls[0].query).not.toContain("X");
});

test("B44 Phase 4: APPLY の未完了planは文単位fail-fastとなり後続文を書かない", async () => {
  const record = makeTypedRecord({
    $id: "8",
    $revision: "3",
    親: "before",
    テーブル: Array.from({ length: 101 }, (_, index) => ({
      id: String(101 + index),
      value: { 子: { value: "old" } },
    })),
  });
  const client = makeClient({ recordsByApp: { 4221: [record] } });
  client.getFields = async () => [
    { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
    { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
    { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
  ];
  const result = await executeBatch(
    "UPDATE APP4221 SET 親='first' WHERE $id=8 APPLY テーブル (PATCH SET 子='x' ALL ROWS); " +
    "UPDATE APP4221 SET 親='second' WHERE $id=8",
    client,
    { cacheContext: "apply-batch-fail-fast", allowApplyMutation: true, dmlMaxRows: 1, dmlMaxSubtableRows: 100 }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[0]).toMatchObject({ status: "error" });
  expect(result.statements[0].error?.message).toContain("dmlMaxSubtableRows (100)");
  expect(result.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
  expect(client.putCalls).toHaveLength(0);
});

test("B3: 非空配列を literal IN に展開し、空配列を親 aware に簡約する", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const expanded = await executeBatch(
    "SET @l=['A社','B社']; SELECT 顧客名 FROM APP100 WHERE 顧客名 IN @l",
    client,
    { cacheContext: "batch-array-in" }
  );
  expect(expanded.ok).toBe(true);
  expect(client.getCalls[0].query).toContain('顧客名 in ("A社","B社")');

  const emptyClient = makeClient({ recordsByApp: { 100: APP1 } });
  const empty = await executeBatch(
    "SET @e=[]; SELECT 顧客名 FROM APP100 WHERE (売上 > 0 OR 顧客名 IN @e) AND 顧客名 IN @e",
    emptyClient,
    { cacheContext: "batch-array-empty" }
  );
  expect(empty.ok).toBe(true);
  expect((empty.statements[1].result as SelectResult)).toMatchObject({ rows: [], columns: ["顧客名"] });
  expect(emptyClient.getCalls).toHaveLength(0);

  const trueClient = makeClient({ recordsByApp: { 100: APP1 } });
  const trueResult = await executeBatch(
    "SET @e=[]; SELECT 顧客名 FROM APP100 WHERE NOT (顧客名 IN @e)",
    trueClient,
    { cacheContext: "batch-array-true" }
  );
  expect(trueResult.ok).toBe(true);
  expect(trueClient.getCalls[0].query).not.toMatch(/顧客名|\bin\s*\(\s*\)/i);
});

test("B3: 更新系は空配列簡約の root TRUE を拒否し root FALSE を no-op にする", async () => {
  const trueClient = makeClient({ recordsByApp: { 100: APP1 }, fieldTypes: { 顧客名: "SINGLE_LINE_TEXT" } });
  const rejected = await executeBatch(
    "SET @e=[]; UPDATE APP100 SET 顧客名='X' WHERE 顧客名 NOT IN @e",
    trueClient,
    { cacheContext: "batch-array-dml-true" }
  );
  expect(rejected.ok).toBe(false);
  expect(rejected.statements[1].error?.message).toMatch(/always true/);
  expect(trueClient.getCalls).toHaveLength(0);
  expect(trueClient.putCalls).toHaveLength(0);

  const falseClient = makeClient({ recordsByApp: { 100: APP1 }, fieldTypes: { 顧客名: "SINGLE_LINE_TEXT" } });
  const noOp = await executeBatch(
    "SET @e=[]; UPDATE APP100 SET 顧客名='X' WHERE 顧客名 IN @e",
    falseClient,
    { cacheContext: "batch-array-dml-false" }
  );
  expect(noOp.ok).toBe(true);
  expect(noOp.statements[1].result).toMatchObject({ type: "UPDATE", updatedCount: 0 });
  expect(falseClient.getCalls).toHaveLength(0);
  expect(falseClient.putCalls).toHaveLength(0);
});

test("B10-B: FROM なし・UNION・GROUP・DISTINCT と INSERT SELECT へ定数列を伝播する", async () => {
  const noFrom = await executeBatch("SET @n=7; SELECT @n AS n", makeClient(), { cacheContext: "var-col-no-from" });
  expect((noFrom.statements[1].result as SelectResult).rows).toEqual([{ n: "7" }]);

  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const union = await executeBatch(
    "SET @s='X'; SELECT @s AS c FROM APP100 UNION SELECT @s AS d FROM APP100",
    client,
    { cacheContext: "var-col-union" }
  );
  expect((union.statements[1].result as SelectResult)).toMatchObject({ columns: ["c"], rows: [{ c: "X" }] });

  const grouped = await executeBatch(
    "SET @s='X'; SELECT @s AS label, COUNT(*) AS count FROM APP100 GROUP BY 顧客名",
    makeClient({ recordsByApp: { 100: APP1 } }),
    { cacheContext: "var-col-group" }
  );
  expect((grouped.statements[1].result as SelectResult).rows).toHaveLength(3);
  expect((grouped.statements[1].result as SelectResult).rows.every((row) => row.label === "X")).toBe(true);

  const distinct = await executeBatch(
    "SET @s='X'; SELECT DISTINCT @s AS c FROM APP100",
    makeClient({ recordsByApp: { 100: APP1 } }),
    { cacheContext: "var-col-distinct" }
  );
  expect((distinct.statements[1].result as SelectResult).rows).toEqual([{ c: "X" }]);

  const insertClient = makeClient({ recordsByApp: { 100: APP1 }, fieldTypes: { label: "SINGLE_LINE_TEXT" } });
  const inserted = await executeBatch(
    "SET @s='X'; INSERT INTO APP200 (label) SELECT @s AS label FROM APP100",
    insertClient,
    { cacheContext: "var-col-insert-select" }
  );
  expect(inserted.ok).toBe(true);
  expect(insertClient.postCalls.flatMap((call) => call.records)).toHaveLength(3);
});

test("B3: root FALSE の非 GROUP 集計は API なしで既存の空集合 1 行を返す", async () => {
  const client = makeClient({ recordsByApp: { 100: APP1 } });
  const batch = await executeBatch(
    "SET @e=[]; SELECT COUNT(*) AS count FROM APP100 WHERE 顧客名 IN @e",
    client,
    { cacheContext: "batch-array-empty-aggregate" }
  );
  expect(batch.ok).toBe(true);
  expect((batch.statements[1].result as SelectResult).rows).toEqual([{ count: "0" }]);
  expect(client.getCalls).toHaveLength(0);
});

test("B23/B24 は temp・CTE を通り、LENGTH_CHAR=numeric／TRANSLATE=string の意味型を保つ", async () => {
  const client = makeClient({ recordsByApp: { 100: [
    makeRecord({ s: "aa", text: "2" }),
    makeRecord({ s: "aaaaaaaaaa", text: "10" }),
  ] } });
  const batch = await executeBatch(
    "CREATE TEMP TABLE #mapped AS " +
      "SELECT LENGTH_CHAR(s) AS n, TRANSLATE(text, CONCAT('a', 'b'), 'AB') AS text_value FROM APP100;" +
    "WITH c AS (SELECT n, text_value FROM #mapped) " +
      "SELECT n, text_value FROM c ORDER BY n ASC, text_value ASC",
    client,
    { cacheContext: "b23-b24-temp-cte-meta" }
  );

  expect(batch.ok).toBe(true);
  expect((batch.statements[1].result as SelectResult).rows).toEqual([
    { n: "2", text_value: "2" },
    { n: "10", text_value: "10" },
  ]);
});

test("B20 は temp・CTE を通り、REGEXP_LIKE も string 意味型を保つ", async () => {
  const client = makeClient({ recordsByApp: { 100: [
    makeRecord({ value: "aa", pattern: "^a+$" }),
    makeRecord({ value: "b", pattern: "^a+$" }),
  ] } });
  const batch = await executeBatch(
    "CREATE TEMP TABLE #matched AS " +
      "SELECT REGEXP_LIKE(value, pattern) AS matched, REGEXP_SUBSTR(value, 'a+') AS part FROM APP100;" +
    "WITH c AS (SELECT matched, part FROM #matched) " +
      "SELECT matched, part FROM c WHERE matched != '00' ORDER BY matched ASC, part ASC",
    client,
    { cacheContext: "b20-temp-cte-meta" }
  );

  expect(batch.ok).toBe(true);
  expect((batch.statements[1].result as SelectResult).rows).toEqual([
    { matched: "0", part: "" },
    { matched: "1", part: "aa" },
  ]);
});

test("B24 from/to 式の長さ検証は行評価時に行う", async () => {
  const client = makeClient({ recordsByApp: { 100: [makeRecord({ value: "x" })] } });
  await expect(execute(
    "SELECT TRANSLATE(value, CONCAT('a', 'b'), 'A') AS mapped FROM APP100",
    client,
    { cacheContext: "b24-runtime-expression-length" }
  )).rejects.toThrow(
    "ArgumentError: TRANSLATE の from と to は同じ文字数である必要があります（from=2, to=1）"
  );
});

test("VALIDATE ONLY INTO #err は空schemaを保持し後続SELECTから参照できる", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code) VALUES ('') VALIDATE ONLY INTO #err;" +
    "SELECT * FROM #err;" +
    "SELECT MIN($err_message) AS message, MIN(code) AS payload FROM #err",
    client,
    { cacheContext: "validate-batch" }
  );
  expect(batch.ok).toBe(true);
  expect(batch.statements[0].result).toMatchObject({ type: "VALIDATION", invalidRows: 1, errTable: "#err" });
  expect(batch.statements[1].result).toMatchObject({ type: "SELECT", rowCount: 1 });
  const aggregate = batch.statements[2].result as SelectResult;
  expect(aggregate.rows[0].message).not.toBe("NaN");
  expect(aggregate.rows[0].payload).toBe("");
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("エラー0件のVALIDATE ONLY INTOも列schemaを保持する", async () => {
  const client = makeClient();
  client.getFields = async () => [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true }];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code) VALUES ('A') VALIDATE ONLY INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "validate-empty-err" }
  );
  const selected = batch.statements[1].result;
  expect(selected).toMatchObject({ type: "SELECT", rowCount: 0 });
  if (selected?.type !== "SELECT") throw new Error("unexpected result");
  expect(selected.columns).toEqual(["code", ...DML_VALIDATION_META_COLUMNS]);
});

test("#err ペイロード型は元SELECTではなくDML対象フィールドから宣言する", async () => {
  const client = makeClient({ recordsByApp: {
    100: [makeRecord({ sourceNumber: "9" }), makeRecord({ sourceNumber: "10" })],
  } });
  client.getFields = async (appId) => appId === 100
    ? [{ code: "sourceNumber", label: "sourceNumber", fieldType: "NUMBER" }]
    : [
      { code: "amount", label: "amount", fieldType: "SINGLE_LINE_TEXT" },
      { code: "required", label: "required", fieldType: "SINGLE_LINE_TEXT", required: true },
    ];
  const batch = await executeBatch(
    "INSERT INTO APP200 (amount, required) SELECT sourceNumber, '' FROM APP100 VALIDATE ONLY INTO #err;" +
    "SELECT MAX(amount) AS maxAmount FROM #err",
    client,
    { cacheContext: "validate-target-column-meta" }
  );

  expect(batch.statements[0].result).toMatchObject({ type: "VALIDATION", invalidRows: 2 });
  // 対象 amount は文字列なので辞書順。元SELECTの NUMBER を誤継承すると 10 になる。
  expect((batch.statements[1].result as SelectResult).rows[0].maxamount).toBe("9");
});

test("B26/B14: #err NUMBER 宣言列の正当な非数値も固定バンドで点検できる", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "amount", label: "amount", fieldType: "NUMBER" },
  ];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code, amount) VALUES ('', 2), ('', 10), ('', 'x') VALIDATE ONLY INTO #err;" +
    "SELECT amount FROM #err ORDER BY amount ASC;" +
    "SELECT MIN(amount) AS min_amount, MAX(amount) AS max_amount FROM #err;" +
    "SELECT amount FROM #err WHERE amount > 5 ORDER BY amount ASC",
    client,
    { cacheContext: "v3-number-band-err-table" }
  );

  expect(batch.ok).toBe(true);
  expect(batch.statements[0].result).toMatchObject({
    type: "VALIDATION",
    invalidRows: 3,
    errTable: "#err",
  });
  expect((batch.statements[1].result as SelectResult).rows.map((row) => row.amount)).toEqual([
    "2", "10", "x", "x",
  ]);
  expect((batch.statements[2].result as SelectResult).rows[0]).toEqual({
    min_amount: "2",
    max_amount: "x",
  });
  expect((batch.statements[3].result as SelectResult).rows.map((row) => row.amount)).toEqual([
    "10", "x", "x",
  ]);
});

test("UPDATE の #err.$id は RECORD_NUMBER 相当の数値型で宣言する", async () => {
  const client = makeClient({ recordsByApp: {
    100: [makeRecord({ $id: "9", amount: "1" }), makeRecord({ $id: "10", amount: "2" })],
  } });
  client.getFields = async () => [{ code: "amount", label: "amount", fieldType: "NUMBER" }];
  const batch = await executeBatch(
    "UPDATE APP100 SET amount = 'bad' WHERE $id >= 1 VALIDATE ONLY INTO #err;" +
    "SELECT MAX($id) AS maxId FROM #err",
    client,
    { cacheContext: "validate-update-id-column-meta" }
  );

  expect(batch.statements[0].result).toMatchObject({ type: "VALIDATION", invalidRows: 2 });
  expect((batch.statements[1].result as SelectResult).rows[0].maxid).toBe("10");
});

test("ON ERROR SKIP は不正行を隔離し合格 prepared plan だけを書き込む", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const confirmed: number[] = [];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code) VALUES ('A'), (''), ('B') ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "on-error-insert", confirm: async (count) => { confirmed.push(count); return true; } }
  );
  expect(batch.ok).toBe(true);
  expect(batch.statements[0].result).toMatchObject({
    type: "INSERT", insertedCount: 2, affectedRows: 2, skippedRows: 1,
    rejectLimit: null, errTable: "#err",
  });
  expect(confirmed).toEqual([2]);
  expect(client.postCalls).toHaveLength(1);
  expect(client.postCalls[0].records).toEqual([
    { code: { value: "A" } }, { code: { value: "B" } },
  ]);
  expect(batch.statements[1].result).toMatchObject({ type: "SELECT", rowCount: 1 });
});

test("NOW()のミリ秒付きDATETIMEはVALIDATE ONLYとON ERROR SKIPの両方で合格する", async () => {
  const client = makeClient({ recordsByApp: {
    100: [makeRecord({ $id: "1", 日時: "2026-07-16T11:20:00Z" })],
  } });
  client.getFields = async () => [
    { code: "日時", label: "日時", fieldType: "DATETIME" },
  ];

  const validation = await executeBatch(
    "SET @now = NOW(); UPDATE APP100 SET 日時 = @now WHERE $id = 1 VALIDATE ONLY",
    client,
    { cacheContext: "datetime-milliseconds-validate" }
  );
  expect(validation.statements[1].result).toMatchObject({
    type: "VALIDATION", validRows: 1, invalidRows: 0, errorCount: 0,
  });
  expect(client.putCalls).toHaveLength(0);

  const isolation = await executeBatch(
    "INSERT INTO APP100 (日時) VALUES ('2026-07-16T11:21:25.174Z') " +
    "ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "datetime-milliseconds-isolation" }
  );
  expect(isolation.statements[0].result).toMatchObject({
    type: "INSERT", insertedCount: 1, skippedRows: 0,
  });
  expect(isolation.statements[1].result).toMatchObject({ type: "SELECT", rowCount: 0 });
  expect(client.postCalls[0].records).toEqual([
    { 日時: { value: "2026-07-16T11:21:25.174Z" } },
  ]);
});

test("REJECT LIMIT 超過は error と診断結果を両立し書き込みゼロで fail-fast", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code) VALUES (''), ('OK') ON ERROR SKIP INTO #err REJECT LIMIT 0; SELECT * FROM #err",
    client,
    { cacheContext: "on-error-reject" }
  );
  expect(batch.ok).toBe(false);
  expect(batch.statements[0]).toMatchObject({
    status: "error",
    error: { code: "RejectLimitExceededError" },
    result: { type: "VALIDATION", invalidRows: 1, errorCount: 1, errTable: "#err" },
  });
  expect(batch.statements[1]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
  expect(client.postCalls).toHaveLength(0);
  const envelope = buildBatchEnvelope(batch);
  expect(envelope.statements[0]).toMatchObject({ status: "error", resultIndex: 0 });
  expect(envelope.results[0]).toMatchObject({ type: "VALIDATION", rowCount: 1, invalidRows: 1 });
  expect(() => buildBatchEnvelope(batch, { maxTotalRecords: 0 })).toThrow(/maxTotalRecords/);
});

test("ON ERROR SKIP の #err 上限超過は prepared plan を書き込まない", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code) VALUES (''), ('OK') ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "on-error-temp-limit", tempTableMaxRows: 0 }
  );
  expect(batch.statements[0]).toMatchObject({ status: "error" });
  expect(batch.statements[0].error?.message).toMatch(/temp table #err exceeds max rows/);
  expect(client.postCalls).toHaveLength(0);
});

test("ON ERROR SKIP UPSERT は targetIndex を再取得せず照合後snapshotを取得して合格行だけ更新する", async () => {
  const client = makeClient({ recordsByApp: {
    100: [makeRecord({ $id: "7", code: "A", name: "old" })],
  } });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const batch = await executeBatch(
    "UPSERT INTO APP100 (code, name) VALUES ('A', 'new'), ('B', '') " +
    "ON DUPLICATE (code) ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "on-error-upsert" }
  );
  expect(batch.ok).toBe(true);
  expect(batch.statements[0].result).toMatchObject({
    type: "UPSERT", insertedCount: 0, updatedCount: 1, affectedRows: 1, skippedRows: 1,
  });
  expect(client.getCalls.filter((call) => call.app === 100)).toEqual([
    expect.objectContaining({ fields: ["$id", "code"] }),
    expect.objectContaining({ query: "$id in (7) limit 500", fields: ["$id", "code", "name"] }),
  ]);
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records).toEqual([
    { id: 7, record: { code: { value: "A" }, name: { value: "new" } } },
  ]);
});

test("VALIDATE ONLY と ON ERROR SKIP は同一入力でエラー内容・順序が一致する", async () => {
  const client = makeClient();
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "amount", label: "amount", fieldType: "NUMBER", minValue: "1" },
  ];
  const values = "('', 0), ('OK', 2)";
  const validation = await executeBatch(
    `INSERT INTO APP100 (code, amount) VALUES ${values} VALIDATE ONLY INTO #err; SELECT * FROM #err`,
    client,
    { cacheContext: "isolation-consistency" }
  );
  const isolation = await executeBatch(
    `INSERT INTO APP100 (code, amount) VALUES ${values} ON ERROR SKIP INTO #err; SELECT * FROM #err`,
    client,
    { cacheContext: "isolation-consistency" }
  );
  const validationResult = validation.statements[0].result;
  const isolatedErrors = isolation.statements[1].result;
  if (validationResult?.type !== "VALIDATION" || isolatedErrors?.type !== "SELECT") {
    throw new Error("unexpected result types");
  }
  expect(isolatedErrors.columns).toEqual(validationResult.columns);
  expect(isolatedErrors.rows).toEqual(validationResult.errors);
  expect(isolation.statements[0].result).toMatchObject({ skippedRows: validationResult.invalidRows });
});

test("#err append上限超過は既存行を壊さない", async () => {
  const client = makeClient();
  client.getFields = async () => [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true }];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code) VALUES ('') VALIDATE ONLY INTO #err; " +
    "INSERT INTO APP100 (code) VALUES ('') VALIDATE ONLY INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "validate-atomic-err", tempTableMaxRows: 1, continueOnError: true }
  );
  expect(batch.statements[1].status).toBe("error");
  expect(batch.statements[2].result).toMatchObject({ type: "SELECT", rowCount: 1 });
});

test("UPDATE FROM VALIDATE ONLY は候補を検証してPUTしない", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ k: "1", amount: "99" })],
    100: [makeRecord({ $id: "1", amount: "1" })],
  } });
  client.getFields = async (appId) => appId === 100
    ? [{ code: "amount", label: "amount", fieldType: "NUMBER", maxValue: "10" }]
    : [
      { code: "k", label: "k", fieldType: "NUMBER" },
      { code: "amount", label: "amount", fieldType: "NUMBER" },
    ];
  const batch = await executeBatch(
    "CREATE TEMP TABLE #src AS SELECT k, amount FROM APP200; " +
    "UPDATE APP100 SET amount = s.amount FROM #src s WHERE APP100.$id = s.k VALIDATE ONLY",
    client,
    { cacheContext: "validate-update-from" }
  );
  expect(batch.statements[1].result).toMatchObject({ type: "VALIDATION", invalidRows: 1, errorCount: 1 });
  expect(client.putCalls).toHaveLength(0);
});

test("B43 Phase 6: post-image違反親だけを隔離しVALIDATE ONLYと同じerrors順で正常親だけPUTする", async () => {
  const records = [
    makeRecord({ $id: "1", dest: "before", requiredTop: "ok" }),
    makeRecord({ $id: "2", dest: "before", requiredTop: "" }),
    makeRecord({ $id: "3", dest: "before", requiredTop: "ok" }),
  ];
  const fields = async () => [
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
    { code: "requiredTop", label: "requiredTop", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const validationClient = makeClient({ recordsByApp: { 100: records } });
  validationClient.getFields = fields;
  const validation = await executeBatch(
    "UPDATE APP100 SET dest = 'after' WHERE $id >= 1 VALIDATE ONLY INTO #err; SELECT * FROM #err",
    validationClient,
    { cacheContext: "b43-phase6-validate-isolation" }
  );
  const validationResult = validation.statements[0].result as DmlValidationResult;

  const isolationClient = makeClient({ recordsByApp: { 100: records } });
  isolationClient.getFields = fields;
  const confirmed: number[] = [];
  const isolation = await executeBatch(
    "UPDATE APP100 SET dest = 'after' WHERE $id >= 1 ON ERROR SKIP INTO #err; SELECT * FROM #err",
    isolationClient,
    {
      cacheContext: "b43-phase6-on-error-isolation",
      confirm: async (count) => { confirmed.push(count); return true; },
    }
  );

  expect(validationResult).toMatchObject({ validatedRows: 3, validRows: 2, invalidRows: 1, errorCount: 1 });
  expect(isolation.statements[0].result).toMatchObject({
    type: "UPDATE", updatedCount: 2, affectedRows: 2, skippedRows: 1,
  });
  expect((isolation.statements[1].result as SelectResult).rows).toEqual(validationResult.errors);
  expect(confirmed).toEqual([2]);
  expect(isolationClient.putCalls).toHaveLength(1);
  expect(isolationClient.putCalls[0].records).toEqual([
    { id: 1, record: { dest: { value: "after" } } },
    { id: 3, record: { dest: { value: "after" } } },
  ]);
});

test("B43 Phase 6: 201候補の全PUT chunkからpost-image違反親を除外し100件以下に保つ", async () => {
  const invalidIds = new Set([1, 101, 201]);
  const records = Array.from({ length: 201 }, (_, index) => makeRecord({
    $id: String(index + 1),
    dest: "before",
    requiredTop: invalidIds.has(index + 1) ? "" : "ok",
  }));
  const client = makeClient({ recordsByApp: { 100: records } });
  client.getFields = async () => [
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
    { code: "requiredTop", label: "requiredTop", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];

  const batch = await executeBatch(
    "UPDATE APP100 SET dest = 'after' WHERE $id >= 1 ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "b43-phase6-put-chunks" }
  );

  expect(batch.statements[0].result).toMatchObject({
    type: "UPDATE", updatedCount: 198, affectedRows: 198, skippedRows: 3,
  });
  expect(client.putCalls.map((call) => call.records.length)).toEqual([100, 98]);
  const writtenIds = client.putCalls.flatMap((call) => call.records).map((record: any) => record.id);
  expect(writtenIds).toHaveLength(198);
  expect(writtenIds.some((id) => invalidIds.has(id))).toBe(false);
});

test("B43 Phase 6: post-image invalidRowsのREJECT LIMIT超過はconfirm・PUTより前に停止する", async () => {
  const client = makeClient({ recordsByApp: { 100: [
    makeRecord({ $id: "1", dest: "before", requiredTop: "" }),
    makeRecord({ $id: "2", dest: "before", requiredTop: "ok" }),
  ] } });
  client.getFields = async () => [
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
    { code: "requiredTop", label: "requiredTop", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  const confirmed: number[] = [];

  const batch = await executeBatch(
    "UPDATE APP100 SET dest = 'after' WHERE $id >= 1 ON ERROR SKIP INTO #err REJECT LIMIT 0; SELECT * FROM #err",
    client,
    {
      cacheContext: "b43-phase6-reject-post-image",
      confirm: async (count) => { confirmed.push(count); return true; },
    }
  );

  expect(batch.ok).toBe(false);
  expect(batch.statements[0]).toMatchObject({
    status: "error",
    error: { code: "RejectLimitExceededError" },
    result: { type: "VALIDATION", invalidRows: 1, errorCount: 1 },
  });
  expect(confirmed).toEqual([]);
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("B43 Phase 6: 同一UPSERT親のpreError・CHECK・post-image複数違反を1 invalidRowに数える", async () => {
  const target = makeTypedRecord({
    $id: "7", code: "", amount: "1", requiredTop: "",
    Lines: [{ id: "line-1", value: { child: { value: "x" } } }],
  });
  const client = makeClient({ recordsByApp: { 100: [target] } });
  client.getFields = async () => [
    { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
    { code: "amount", label: "amount", fieldType: "NUMBER", maxValue: "10" },
    { code: "requiredTop", label: "requiredTop", fieldType: "SINGLE_LINE_TEXT", required: true },
    { code: "Lines", label: "Lines", fieldType: "SUBTABLE" },
    { code: "child", label: "child", fieldType: "SINGLE_LINE_TEXT", minLength: "2", inSubtable: true, subtableCode: "Lines" },
  ];

  const batch = await executeBatch(
    "UPSERT INTO APP100 (code, amount) VALUES ('', 11) ON DUPLICATE (code) " +
      "CHECK WHEN amount > 0 THEN 'positive' ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "b43-phase6-distinct-invalid" }
  );
  const errors = (batch.statements[1].result as SelectResult).rows;

  expect(batch.statements[0].result).toMatchObject({
    type: "UPSERT", affectedRows: 0, skippedRows: 1,
  });
  expect(errors.map((row) => row.$err_code)).toEqual([
    "ERR_KEY_EMPTY", "ERR_RANGE_MAX", "ERR_REQUIRED", "ERR_LENGTH_MIN", "ERR_CHECK",
  ]);
  expect(new Set(errors.map((row) => row.$err_row))).toEqual(new Set(["1"]));
  expect(errors).toHaveLength(5);
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("B43 Phase 6: #err runtime schema mismatchは既存appendを置換せずON ERROR SKIP writerを呼ばない", async () => {
  const client = makeClient();
  client.getFields = async (appId) => appId === 100
    ? [{ code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT", required: true }]
    : [{ code: "code", label: "code", fieldType: "NUMBER" }];
  const batch = await executeBatch(
    "INSERT INTO APP100 (code) VALUES ('') VALIDATE ONLY INTO #err; " +
      "INSERT INTO APP200 (code) VALUES ('bad') ON ERROR SKIP INTO #err",
    client,
    { cacheContext: "b43-phase6-schema-atomic" }
  );

  expect(batch.ok).toBe(false);
  expect(batch.statements[0]).toMatchObject({
    status: "success", result: { type: "VALIDATION", errorCount: 1 },
  });
  expect(batch.statements[1].error?.message).toContain("validation error table #err has a different schema");
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test("B43 Phase 6: API-time PUT errorは候補隔離へ変換せず最初のchunkでfail-fastする", async () => {
  const records = Array.from({ length: 201 }, (_, index) => makeRecord({
    $id: String(index + 1), dest: "before", requiredTop: "ok",
  }));
  const client = makeClient({ recordsByApp: { 100: records } });
  client.getFields = async () => [
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
    { code: "requiredTop", label: "requiredTop", fieldType: "SINGLE_LINE_TEXT", required: true },
  ];
  client.putRecords = async (params) => {
    client.putCalls.push({ app: params.app, records: [...params.records] });
    throw new Error("GAIA_CO02: mock revision conflict");
  };

  const batch = await executeBatch(
    "UPDATE APP100 SET dest = 'after' WHERE $id >= 1 ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "b43-phase6-api-fail-fast" }
  );

  expect(batch.ok).toBe(false);
  expect(batch.statements[0]).toMatchObject({ status: "error" });
  expect(batch.statements[0].error?.message).toContain("GAIA_CO02");
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records).toHaveLength(100);
  expect(client.postCalls).toHaveLength(0);
});

test("B43 Phase 4: UPDATE FROM $id join は共有target GETで非SETトップレベル・子違反を検出する", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ k: "7", src: "after" })],
    100: [makeTypedRecord({
      $id: "7", dest: "before", requiredTop: "",
      Lines: [{ id: "line-1", value: { child: { value: "x" } } }],
    })],
  } });
  client.getFields = async (appId) => appId === 100
    ? [
      { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
      { code: "requiredTop", label: "requiredTop", fieldType: "SINGLE_LINE_TEXT", required: true },
      { code: "Lines", label: "Lines", fieldType: "SUBTABLE" },
      { code: "child", label: "child", fieldType: "SINGLE_LINE_TEXT", minLength: "2", inSubtable: true, subtableCode: "Lines" },
    ]
    : [
      { code: "k", label: "k", fieldType: "NUMBER" },
      { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" },
    ];

  const batch = await executeBatch(
    "CREATE TEMP TABLE #src AS SELECT k, src FROM APP200; " +
    "UPDATE APP100 SET dest = s.src FROM #src s WHERE APP100.$id = s.k VALIDATE ONLY",
    client,
    { cacheContext: "b43-phase4-id-complete-snapshot" }
  );

  expect(batch.ok).toBe(true);
  expect(batch.statements[1].result).toMatchObject({
    type: "VALIDATION", validatedRows: 1, validRows: 0, invalidRows: 1, errorCount: 2,
  });
  const validation = batch.statements[1].result as DmlValidationResult;
  expect(validation.errors.map((row) => [row.$err_field, row.$err_subrow, row.$err_subrow_id])).toEqual([
    ["requiredTop", "", ""],
    ["child", "1", "line-1"],
  ]);
  const targetGets = client.getCalls.filter((call) => call.app === 100);
  expect(targetGets).toHaveLength(1);
  expect(targetGets[0].fields).toEqual(["$id", "dest", "requiredTop", "Lines"]);
  expect(targetGets[0].fields).not.toContain("child");
  expect(client.putCalls).toHaveLength(0);
});

test("B21 ON ERROR SKIP は文字列関数の評価結果が不正な行だけを隔離する", async () => {
  const client = makeClient({ recordsByApp: { 100: [
    makeRecord({ $id: "1", source: "A" }),
    makeRecord({ $id: "2", source: "LONG" }),
  ] } });
  client.getFields = async () => [
    { code: "source", label: "source", fieldType: "SINGLE_LINE_TEXT" },
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT", maxLength: "3" },
  ];
  const batch = await executeBatch(
    "UPDATE APP100 SET dest = CONCAT(source, 'x') WHERE $id >= 1 " +
    "ON ERROR SKIP INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "b21-on-error-string-func" }
  );
  expect(batch.ok).toBe(true);
  expect(batch.statements[0].result).toMatchObject({
    type: "UPDATE", updatedCount: 1, skippedRows: 1,
  });
  expect(client.putCalls[0].records).toEqual([
    { id: 1, record: { dest: { value: "Ax" } } },
  ]);
  expect((batch.statements[1].result as SelectResult).rows[0].$err_code).toBe("ERR_LENGTH_MAX");
});

test("B22 LEFT の64コードユニット結果は同じ maxLength の UPDATE FROM VALIDATE ONLY を通る", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ k: "1", source: "😀".repeat(40) })],
    100: [makeRecord({ $id: "1", dest: "before" })],
  } });
  client.getFields = async (appId) => appId === 100
    ? [{ code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT", maxLength: "64" }]
    : [
      { code: "k", label: "k", fieldType: "NUMBER" },
      { code: "source", label: "source", fieldType: "SINGLE_LINE_TEXT" },
    ];
  const batch = await executeBatch(
    "CREATE TEMP TABLE #trimmed AS SELECT k, LEFT(source, 64) AS safe_value FROM APP200; " +
    "UPDATE APP100 SET dest = t.safe_value FROM #trimmed t WHERE APP100.$id = t.k VALIDATE ONLY",
    client,
    { cacheContext: "b22-left-validate-only" }
  );
  expect(batch.ok).toBe(true);
  expect(batch.statements[1].result).toMatchObject({
    type: "VALIDATION", validatedRows: 1, validRows: 1, invalidRows: 0, errorCount: 0,
  });
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM #temp はバッチストアを参照して更新する", async () => {
  const client = makeClient({
    recordsByApp: {
      200: [makeRecord({ k: "1", src: "A" }), makeRecord({ k: "2", src: "B" })],
      100: [makeRecord({ $id: "1" }), makeRecord({ $id: "2" })],
    },
  });
  client.getFields = async (appId) => appId === 200
    ? [{ code: "k", label: "k", fieldType: "NUMBER" }, { code: "src", label: "src", fieldType: "SINGLE_LINE_TEXT" }]
    : [{ code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" }];
  const result = await executeBatch(
    "CREATE TEMP TABLE #e AS SELECT k, src FROM APP200; " +
    "UPDATE APP100 SET dest = e.src FROM #e e WHERE APP100.$id = e.k",
    client,
    { cacheContext: "batch-update-from-temp" }
  );
  expect(result.ok).toBe(true);
  expect(result.analysis.statements[1].tempTablesReferenced).toEqual(["#e"]);
  expect(result.analysis.statements[1].dependsOn).toEqual([0]);
  expect(client.putCalls).toHaveLength(1);
  expect(client.putCalls[0].records).toEqual([
    { id: 1, record: { dest: { value: "A" } } },
    { id: 2, record: { dest: { value: "B" } } },
  ]);
});

test("UPDATE FROM #temp: B12の業務キー書き戻し例を実行する", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ 顧客コード: "C001", エラー内容: "invalid" })],
    100: [makeRecord({ $id: "7", 顧客コード: "C001" })],
  } });
  client.getFields = async (appId) => appId === 200
    ? [
      { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" },
      { code: "エラー内容", label: "エラー内容", fieldType: "SINGLE_LINE_TEXT" },
    ]
    : [
      { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" },
      { code: "処理ステータス", label: "処理ステータス", fieldType: "SINGLE_LINE_TEXT" },
      { code: "エラー内容", label: "エラー内容", fieldType: "SINGLE_LINE_TEXT" },
    ];
  const result = await executeBatch(
    "CREATE TEMP TABLE #err_summary AS SELECT 顧客コード, エラー内容 FROM APP200; " +
    "UPDATE APP100 SET 処理ステータス = 'エラー', エラー内容 = e.エラー内容 " +
    "FROM #err_summary e WHERE APP100.顧客コード = e.顧客コード",
    client,
    { cacheContext: "batch-update-from-business-key" }
  );
  expect(result.ok).toBe(true);
  expect(client.putCalls[0].records).toEqual([
    { id: 7, record: { 処理ステータス: { value: "エラー" }, エラー内容: { value: "invalid" } } },
  ]);
});

test("UPDATE FROM #temp VALIDATE ONLY INTO は業務キーmatchedだけを#errorへ書く", async () => {
  const client = makeClient({ recordsByApp: {
    200: [makeRecord({ 顧客コード: "C001", amount: "11" })],
    100: [makeRecord({ $id: "7", 顧客コード: "C001" })],
  } });
  client.getFields = async (appId) => appId === 200
    ? [
      { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" },
      { code: "amount", label: "amount", fieldType: "NUMBER" },
    ]
    : [
      { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" },
      { code: "amount", label: "amount", fieldType: "NUMBER", maxValue: "10" },
    ];
  const result = await executeBatch(
    "CREATE TEMP TABLE #src AS SELECT 顧客コード, amount FROM APP200; " +
    "UPDATE APP100 SET amount = s.amount FROM #src s WHERE 顧客コード = s.顧客コード " +
    "VALIDATE ONLY INTO #err; SELECT * FROM #err",
    client,
    { cacheContext: "batch-validate-update-from-business" }
  );
  expect(result.ok).toBe(true);
  expect(result.statements[1].result).toMatchObject({ type: "VALIDATION", validatedRows: 1, invalidRows: 1 });
  expect(result.statements[2].result).toMatchObject({ type: "SELECT", rowCount: 1 });
  expect(client.putCalls).toHaveLength(0);
});

test("UPDATE FROM #temp は0行でも列欠落を PUT 前に拒否する", async () => {
  const client = makeClient({ recordsByApp: { 200: [] } });
  client.getFields = async () => [
    { code: "k", label: "k", fieldType: "NUMBER" },
    { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const result = await executeBatch(
    "CREATE TEMP TABLE #e AS SELECT k FROM APP200; " +
    "UPDATE APP100 SET dest = e.src FROM #e e WHERE APP100.$id = e.k",
    client,
    { cacheContext: "batch-update-from-missing-column" }
  );
  expect(result.ok).toBe(false);
  expect(result.statements[1]).toMatchObject({ status: "error" });
  expect(result.statements[1].error?.message).toMatch(/source column src does not exist/);
  expect(client.putCalls).toHaveLength(0);
});

test("FROM なし SELECT/UNION を一時テーブルに実体化できる", async () => {
  const result = await executeBatch(
    "CREATE TEMP TABLE #ids AS SELECT '4' AS id UNION ALL SELECT '7' AS id; "
      + "SELECT COUNT(*) AS n FROM #ids",
    makeClient()
  );
  expect(result.ok).toBe(true);
  expect(result.statements[0]).toMatchObject({ status: "success", rowCount: 2 });
  const selected = result.statements[1].result as SelectResult;
  expect(selected.rows).toEqual([{ n: "2" }]);
});

test("単一の FROM なし SELECT 実体化と実 CTE 参照は両立する", async () => {
  const result = await executeBatch(
    "CREATE TEMP TABLE #x AS SELECT 'A' AS v; "
      + "WITH c AS (SELECT * FROM #x) SELECT v FROM c",
    makeClient()
  );
  expect(result.ok).toBe(true);
  expect(result.statements[0]).toMatchObject({ status: "success", rowCount: 1 });
  const selected = result.statements[1].result as SelectResult;
  expect(selected.rows).toEqual([{ v: "A" }]);
});

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

test("SET数値変数は2^53境界のraw lexemeを比較完了まで保持する", async () => {
  const result = await executeBatch(
    "SET @high = 9007199254740993; ASSERT @high > 9007199254740992; ASSERT @high = 9.007199254740993e15",
    makeClient()
  );
  expect(result.ok).toBe(true);
  expect(result.statements.map((statement) => statement.status)).toEqual(["success", "success", "success"]);
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

test("関数引数と || の @var を既存バッチ変数解決で置換する", async () => {
  const client = makeClient({ recordsByApp: { 100: [makeRecord({ x: "X" })] } });
  const r = await executeBatch(
    "SET @v = 'ab'; SELECT CONCAT('x=', @v)||'!' AS joined, CONCAT(UPPER(@v), x) AS nested FROM APP100",
    client
  );
  expect(r.ok).toBe(true);
  expect((r.statements[1].result as SelectResult).rows).toEqual([
    { joined: "x=ab!", nested: "ABX" },
  ]);
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

test("変数置換後の USER_SELECT IN は code 単位で型付き評価する", async () => {
  const client = makeClient({ recordsByApp: { 100: [
    makeTypedRecord({ $id: "1", 主担当: [{ code: "rex0220", name: "開発太郎" }] }),
  ] } });
  client.getFields = async () => [
    { code: "主担当", label: "主担当", fieldType: "USER_SELECT" },
  ];

  const result = await executeBatch(
    "SET @user = 'rex0220'; SELECT $id FROM APP100 WHERE 主担当 IN (@user) AND $id LIKE '%'",
    client,
    { cacheContext: "typed-in-variable" }
  );

  expect(result.ok).toBe(true);
  expect((result.statements[1].result as SelectResult).rows).toEqual([{ $id: "1" }]);
});

test.each([
  ["SET @choice = 'A'", undefined],
  ["DECLARE @choice = 'B'", { Choice: "A" }],
] as const)("変数解決後の選択系 IN を実在文字列として押し下げる: %s", async (declaration, variables) => {
  const client = makeClient({ recordsByApp: { 98201: [
    makeTypedRecord({ $id: "1", 選択: ["A"], 件名: "one" }),
  ] } });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "CHECK_BOX", optionOrder: { A: 0, B: 1 } },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  const result = await executeBatch(
    `${declaration}; SELECT $id FROM APP98201 WHERE 選択 IN (@choice) AND 件名 LIKE '%'`,
    client,
    { variables, cacheContext: `selection-variable-${declaration.slice(0, 3)}` }
  );

  expect(result.ok).toBe(true);
  expect(client.getCalls[0].query).toContain('選択 in ("A")');
});

test("数値変数へ置換された選択系 IN は候補にせず押し下げない", async () => {
  const client = makeClient({ recordsByApp: { 98202: [
    makeTypedRecord({ $id: "1", 選択: "1", 件名: "one" }),
  ] } });
  client.getFields = async () => [
    { code: "選択", label: "選択", fieldType: "DROP_DOWN", optionOrder: { "1": 0 } },
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  ];

  await executeBatch(
    "SET @choice = 1; SELECT $id FROM APP98202 WHERE 選択 IN (@choice) AND 件名 LIKE '%'",
    client,
    { cacheContext: "selection-variable-number" }
  );

  expect(client.getCalls[0].query).not.toContain("選択 in");
});

test.each(["X", ""])(
  "DECLARE 外部注入の非実在・空文字 %j は選択系 IN を押し下げない",
  async (choice) => {
    const client = makeClient({ recordsByApp: { 98203: [] } });
    client.getFields = async () => [
      { code: "選択", label: "選択", fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    ];

    await executeBatch(
      "DECLARE @choice = 'A'; SELECT $id FROM APP98203 WHERE 選択 IN (@choice) AND 件名 LIKE '%'",
      client,
      { variables: { choice }, cacheContext: `selection-variable-invalid-${choice}` }
    );

    expect(client.getCalls[0].query).not.toContain("選択 in");
  }
);

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

test("空の一時テーブルの SELECT * は実体化時の列を返す", async () => {
  const client = makeClient({ recordsByApp: { 300: [] } });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP300; SELECT * FROM #t",
    client
  );

  expect(r.ok).toBe(true);
  expect(r.statements[0]).toMatchObject({ status: "success", rowCount: 0 });
  expect(r.statements[1].result).toMatchObject({
    type: "SELECT",
    rows: [],
    columns: ["顧客名", "売上"],
    rowCount: 0,
  });
});

test("空の一時テーブルの混在 SELECT *, extra は明示列だけ返す", async () => {
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT a, b FROM APP300; SELECT *, extra FROM #t",
    makeClient({ recordsByApp: { 300: [] } })
  );

  expect(r.ok).toBe(true);
  expect((r.statements[1].result as SelectResult).columns).toEqual(["extra"]);
});

test("空の一時テーブルの SELECT * は INSERT/UPSERT を no-op で完了する", async () => {
  const client = makeClient({
    recordsByApp: { 100: [], 400: [] },
    fieldTypes: { 顧客名: "SINGLE_LINE_TEXT", 売上: "NUMBER" },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100;" +
    "INSERT INTO APP200 (顧客名, 売上) SELECT * FROM #t;" +
    "UPSERT INTO APP400 (顧客名, 売上) SELECT * FROM #t ON DUPLICATE (顧客名)",
    client
  );

  expect(r.ok).toBe(true);
  expect(r.statements[1].result).toMatchObject({ type: "INSERT", insertedCount: 0 });
  expect(r.statements[2].result).toMatchObject({
    type: "UPSERT",
    insertedCount: 0,
    updatedCount: 0,
  });
  expect(client.postCalls).toHaveLength(0);
  expect(client.putCalls).toHaveLength(0);
});

test.each([
  { operator: "UNION ALL", expected: ["X", "X", "Y"] },
  { operator: "UNION", expected: ["X", "Y"] },
])("$operator: temp/CTE 経路の空 SELECT * 左辺が列名と右辺値を保持する", async ({ operator, expected }) => {
  const client = makeClient({
    recordsByApp: {
      100: [],
      200: [makeRecord({ b: "X" }), makeRecord({ b: "X" }), makeRecord({ b: "Y" })],
    },
  });
  const r = await executeBatch(
    `CREATE TEMP TABLE #empty AS SELECT a FROM APP100; ` +
    `SELECT * FROM #empty ${operator} SELECT b FROM APP200`,
    client
  );

  expect(r.ok).toBe(true);
  const selected = r.statements[1].result as SelectResult;
  expect(selected.columns).toEqual(["a"]);
  expect(selected.rows.map((row) => row.a)).toEqual(expected);
});

test("空 SELECT * でも JOIN 時は保存スキーマを使わない", async () => {
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT a FROM APP100;" +
    "SELECT * FROM #t t INNER JOIN APP200 u ON t.a = u.a",
    makeClient({ recordsByApp: { 100: [], 200: [] } })
  );

  expect(r.ok).toBe(true);
  expect((r.statements[1].result as SelectResult)).toMatchObject({ rows: [], columns: [] });
});

test("1 行以上の一時テーブル SELECT * は列順と値が従来どおり", async () => {
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100; SELECT * FROM #t",
    makeClient({ recordsByApp: { 100: [makeRecord({ 顧客名: "A社", 売上: "100" })] } })
  );

  expect((r.statements[1].result as SelectResult)).toMatchObject({
    columns: ["顧客名", "売上"],
    rows: [{ 顧客名: "A社", 売上: "100" }],
  });
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

test("MIN / MAX: 一時テーブルと CTE に文字列型メタが伝播する", async () => {
  const client = makeClient({
    recordsByApp: { 100: [makeRecord({ name: "B" }), makeRecord({ name: "A" })] },
  });
  client.getFields = async () => [
    { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
  ];
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT name FROM APP100;" +
    "SELECT MIN(name) AS tempMin FROM #t;" +
    "WITH c AS (SELECT name FROM APP100) SELECT MIN(name) AS cteMin FROM c",
    client,
    { cacheContext: "aggregate-sort-materialized" }
  );

  expect((r.statements[1].result as SelectResult).rows[0].tempmin).toBe("A");
  expect((r.statements[2].result as SelectResult).rows[0].ctemin).toBe("A");
});

test("GROUP_CONCAT: 一時テーブル・CTE・$err_message で型メタなしに連結する", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ key: "1", message: "必須です" }),
        makeRecord({ key: "1", message: "長すぎます" }),
        makeRecord({ key: "2", message: "形式エラー" }),
      ],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #err AS SELECT key, message AS $err_message FROM APP100;" +
    "SELECT key, GROUP_CONCAT($err_message SEPARATOR ' / ') AS errors FROM #err GROUP BY key;" +
    "WITH c AS (SELECT $err_message FROM #err) " +
    "SELECT GROUP_CONCAT($err_message SEPARATOR '|') AS all_errors FROM c",
    client
  );

  expect(r.ok).toBe(true);
  expect((r.statements[1].result as SelectResult).rows).toEqual([
    { key: "1", errors: "必須です / 長すぎます" },
    { key: "2", errors: "形式エラー" },
  ]);
  expect((r.statements[2].result as SelectResult).rows[0].all_errors)
    .toBe("必須です|長すぎます|形式エラー");
});

test("GROUP_CONCAT: 実体化した集約列へ string 型メタを付け、後段 MIN を辞書順にする", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ category: "1", name: "Z" }),
        makeRecord({ category: "1", name: "B" }),
        makeRecord({ category: "2", name: "A" }),
        makeRecord({ category: "2", name: "C" }),
      ],
    },
  });
  const r = await executeBatch(
    "CREATE TEMP TABLE #joined AS " +
    "SELECT category, GROUP_CONCAT(name) AS names FROM APP100 GROUP BY category;" +
    "SELECT MIN(names) AS first_names FROM #joined",
    client
  );

  expect(r.ok).toBe(true);
  expect((r.statements[1].result as SelectResult).rows[0].first_names).toBe("A,C");
});

test("MIN / MAX: CTE/temp 混在 JOIN の非修飾同名列は衝突として型不明にする", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ key: "1", value: "B" })],
      200: [makeRecord({ key: "1", value: "A" })],
    },
  });
  let fieldCalls = 0;
  client.getFields = async () => {
    fieldCalls += 1;
    return [
      { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
      { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
    ];
  };
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT key, value FROM APP100;" +
    "SELECT MIN(value) AS collision FROM APP200 a JOIN #t b ON a.key = b.key",
    client,
    { cacheContext: "aggregate-sort-mixed-materialized" }
  );

  expect(r.statements[0].error).toBeUndefined();
  expect(r.statements[1].error).toBeUndefined();
  expect((r.statements[1].result as SelectResult).rows[0].collision).toBe("B");
  expect(fieldCalls).toBe(2);
});

test("MIN / MAX: 数値型・チェーン・temp alias 修飾参照を維持する", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [
        makeRecord({ key: "1", amount: "9", name: "B", date: "2026-07-16" }),
        makeRecord({ key: "2", amount: "10", name: "A", date: "2026-01-02" }),
      ],
      200: [makeRecord({ key: "1" }), makeRecord({ key: "2" })],
    },
  });
  client.getFields = async (appId) => appId === 100
    ? [
      { code: "key", label: "key", fieldType: "NUMBER" },
      { code: "amount", label: "amount", fieldType: "NUMBER" },
      { code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" },
      { code: "date", label: "date", fieldType: "DATE" },
    ]
    : [{ code: "key", label: "key", fieldType: "NUMBER" }];
  const r = await executeBatch(
    "CREATE TEMP TABLE #t1 AS SELECT key, amount, name, date FROM APP100;" +
    "CREATE TEMP TABLE #t2 AS SELECT key, amount, name, date FROM #t1;" +
    "SELECT MAX(amount) AS numericMax, MIN(name) AS textMin, MIN(date) AS oldest FROM #t2;" +
    "SELECT MIN(t.name) AS qualifiedMin FROM APP200 a JOIN #t2 AS t ON a.key = t.key",
    client,
    { cacheContext: "aggregate-sort-chain" }
  );

  expect((r.statements[2].result as SelectResult).rows[0]).toMatchObject({
    numericmax: "10", textmin: "A", oldest: "2026-01-02",
  });
  expect((r.statements[3].result as SelectResult).rows[0].qualifiedmin).toBe("A");
});

test("MIN / MAX: UNION は左右の型一致時だけメタを伝播する", async () => {
  const client = makeClient({
    recordsByApp: {
      100: [makeRecord({ value: "B" })],
      200: [makeRecord({ value: "A" })],
      300: [makeRecord({ value: "10" })],
    },
  });
  client.getFields = async (appId) => [{
    code: "value", label: "value", fieldType: appId === 300 ? "NUMBER" : "SINGLE_LINE_TEXT",
  }];
  const r = await executeBatch(
    "CREATE TEMP TABLE #same AS SELECT value FROM APP100 UNION ALL SELECT value FROM APP200;" +
    "SELECT MIN(value) AS sameMin FROM #same;" +
    "CREATE TEMP TABLE #mixed AS SELECT value FROM APP100 UNION ALL SELECT value FROM APP300;" +
    "SELECT MIN(value) AS mixedMin FROM #mixed",
    client,
    { cacheContext: "aggregate-sort-union" }
  );

  expect((r.statements[1].result as SelectResult).rows[0].samemin).toBe("A");
  expect((r.statements[3].result as SelectResult).rows[0].mixedmin).toBe("10");
});

test("MIN / MAX: SELECT * 実体化でも型を付けフォーム定義は1回だけ取得する", async () => {
  const client = makeClient({ recordsByApp: { 100: [makeRecord({ name: "B" }), makeRecord({ name: "A" })] } });
  let fieldCalls = 0;
  client.getFields = async () => {
    fieldCalls += 1;
    return [{ code: "name", label: "name", fieldType: "SINGLE_LINE_TEXT" }];
  };
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT * FROM APP100; SELECT MIN(name) AS result FROM #t",
    client,
    { cacheContext: "aggregate-sort-wildcard" }
  );

  expect((r.statements[1].result as SelectResult).rows[0].result).toBe("A");
  expect(fieldCalls).toBe(1);
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
  const client = makeClient({ recordsByApp: { 100: APP1 }, fieldTypes: { 名前: "SINGLE_LINE_TEXT", 金額: "NUMBER" } });
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
  const client = makeClient({ recordsByApp: { 100: APP1 }, fieldTypes: { 名前: "SINGLE_LINE_TEXT" } });
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
    fieldTypes: { 名前: "SINGLE_LINE_TEXT", 地域: "SINGLE_LINE_TEXT" },
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
    fieldTypes: { 名前: "SINGLE_LINE_TEXT" },
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
  const client = makeClient({
    recordsByApp: { 100: [], 400: [] },
    fieldTypes: { 顧客名: "SINGLE_LINE_TEXT", 売上: "NUMBER" },
  });
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
  const client = makeClient({ recordsByApp: { 100: [], 400: [] }, fieldTypes: { 顧客名: "SINGLE_LINE_TEXT" } });
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
    fieldTypes: { 顧客名: "SINGLE_LINE_TEXT" },
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
    fieldTypes: { 地域: "SINGLE_LINE_TEXT" },
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

test("KORDER_CURSORのbatch timeoutはactive cursorのclose完了を待って返る", async () => {
  const client = makeClient();
  let pages = 0;
  let closes = 0;
  client.openCursor = async () => ({
    totalCount: 600,
    async nextPage() {
      pages += 1;
      if (pages === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      const count = pages === 1 ? 500 : 1;
      return {
        records: Array.from({ length: count }, (_v, i) => makeRecord({ $id: String((pages - 1) * 500 + i + 1) })),
        next: true,
      };
    },
    async close() { closes += 1; },
  });
  const result = await executeBatch(
    "SELECT $id FROM APP100 KORDER BY $id LIMIT 501",
    client,
    { timeoutMs: 5 }
  );
  expect(result.statements[0].error?.code).toBe("TimeoutError");
  expect(closes).toBe(1);
});

test("複文KORDER_CURSORは前文close完了後に次文cursorを作る", async () => {
  const client = makeClient();
  const events: string[] = [];
  let cursorNo = 0;
  client.openCursor = async () => {
    const current = ++cursorNo;
    events.push(`create${current}`);
    return {
      totalCount: 501,
      async nextPage() {
        events.push(`get${current}`);
        return {
          records: Array.from({ length: 501 }, (_v, i) => makeRecord({ $id: String(i + 1) })),
          next: true,
        };
      },
      async close() {
        await Promise.resolve();
        events.push(`close${current}`);
      },
    };
  };
  const result = await executeBatch(
    "SELECT $id FROM APP100 KORDER BY $id LIMIT 501; SELECT $id FROM APP100 KORDER BY $id LIMIT 501",
    client,
    { maxRecords: 501 }
  );
  expect(result.ok).toBe(true);
  expect(events).toEqual(["create1", "get1", "close1", "create2", "get2", "close2"]);
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
  const client = makeClient({ recordsByApp: { 100: APP1 }, fieldTypes: { 名前: "SINGLE_LINE_TEXT" } });
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
  const client = makeClient({ recordsByApp: { 100: APP1 }, fieldTypes: { 名前: "SINGLE_LINE_TEXT" } });
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
