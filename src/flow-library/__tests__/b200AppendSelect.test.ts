import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  validateScript,
  type FlowDmlConfirm,
  type FlowDmlConfirmContext,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

/** APP100 = 集計（親＋サブテーブル 明細）、APP200 = 受注（ソース）。 */
const AGG = 100;
const SRC = 200;

const aggFields = [
  { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT", writable: true, isUnique: true },
  { code: "合計", label: "合計", fieldType: "NUMBER", writable: true },
  { code: "メモ", label: "メモ", fieldType: "SINGLE_LINE_TEXT", writable: true, isUnique: false },
  { code: "明細", label: "明細", fieldType: "SUBTABLE", writable: false },
  { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "明細" },
  { code: "件数", label: "件数", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "明細" },
  { code: "金額", label: "金額", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "明細" },
];

const srcFields = [
  { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "金額", label: "金額", fieldType: "NUMBER", writable: true },
];

function aggParent(id: number): Rec {
  return {
    $id: { value: String(id) },
    $revision: { value: "4" },
    顧客コード: { value: "C001" },
    合計: { value: "0" },
    メモ: { value: "" },
    明細: { value: [
      { id: `${id}01`, value: { 担当者: { value: "old1" }, 件数: { value: "9" }, 金額: { value: "90" } } },
      { id: `${id}02`, value: { 担当者: { value: "old2" }, 件数: { value: "8" }, 金額: { value: "80" } } },
    ] },
  };
}

function srcRow(id: number, tantou: string, kingaku: number): Rec {
  return {
    $id: { value: String(id) },
    $revision: { value: "1" },
    顧客コード: { value: "C001" },
    担当者: { value: tantou },
    金額: { value: String(kingaku) },
  };
}

function mockClient(options: { parentIds?: readonly number[]; sourceRows?: readonly Rec[] } = {}) {
  const parentIds = options.parentIds ?? [1];
  const sourceRows = options.sourceRows
    ?? [srcRow(11, "yamada", 10), srcRow(12, "yamada", 5), srcRow(13, "sato", 20)];
  const putRecords = jest.fn(async (_params: unknown) => undefined);
  const postRecords = jest.fn(async ({ records }: { records: unknown[] }) => ({
    ids: records.map((_, index) => String(900 + index)),
  }));
  const deleteRecords = jest.fn(async (_params: unknown) => undefined);
  const reads: number[] = [];
  const rowsOf = (app: number): Rec[] => (app === AGG ? parentIds.map(aggParent) : [...sourceRows]);
  const value = {
    async getRecords(params: { app: number; query: string; totalCount?: boolean }) {
      reads.push(params.app);
      const records = rowsOf(params.app);
      return params.totalCount ? { records, totalCount: String(records.length) } : { records };
    },
    async openCursor(params: { app: number }) {
      reads.push(params.app);
      const records = rowsOf(params.app);
      return { totalCount: records.length, async nextPage() { return { records, next: false }; }, async close() {} };
    },
    postRecords,
    putRecords,
    deleteRecords,
    async getApps() { return []; },
    async getFields(appId: number) { return appId === AGG ? aggFields : srcFields; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
  const writes = () => putRecords.mock.calls.length + postRecords.mock.calls.length + deleteRecords.mock.calls.length;
  return { value, putRecords, postRecords, deleteRecords, writes, reads };
}

const header = "-- @ksql dialect: 1\n";

/**
 * ORDER BY は**別名**で書く（`ORDER BY SUM(金額) DESC` は素の `INSERT ... SELECT` でも
 * `ORDER BY key has no canonical comparison contract` で止まる既存の制限で、本件とは無関係）。
 */
const appendSelectSql = `${header}UPDATE APP${AGG} SET 合計 = 2 WHERE 顧客コード = 'C001'
 APPLY 明細 (
   REMOVE ALL ROWS;
   APPEND (担当者, 件数, 金額)
   SELECT 担当者, COUNT(*) AS 件数合計, SUM(金額) AS 金額合計 FROM APP${SRC}
    WHERE 顧客コード = 'C001' GROUP BY 担当者 ORDER BY 金額合計 DESC
 );`;

function putSubtable(call: { records: { id: string; record: Rec }[] }): Array<[unknown, unknown, unknown]> {
  const rows = (call.records[0].record["明細"]?.value ?? []) as Array<{ value: Rec }>;
  return rows.map((row) => [row.value["担当者"]?.value, row.value["件数"]?.value, row.value["金額"]?.value]);
}

test("AC1/AC2/AC7 親 1 件なら SELECT の結果でテーブルを全置換し、ORDER BY の順で並ぶ。確認は 1 回で appendRows が SELECT の行数", async () => {
  const mock = mockClient();
  const parsed = parseScript(appendSelectSql);
  expect(parsed.diagnostics).toEqual([]);
  const calls: Array<[number, string, FlowDmlConfirmContext]> = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true,
    confirm: (count, operation, info) => { calls.push([count, operation, info]); return true; },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "success", result: { type: "UPDATE", updatedCount: 1 },
  });
  await disposeExecutionContext(context);

  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(1);
  expect(calls[0][2].applyDetail).toMatchObject({
    parentRows: 1,
    addedSubtableRows: 2,
    deletedRows: 2,
    tables: [{ table: "明細", patchRows: 0, appendRows: 2, removeRows: 2 }],
  });
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
  // ORDER BY SUM(金額) DESC → sato(20) → yamada(15)
  expect(putSubtable(mock.putRecords.mock.calls[0][0] as never)).toEqual([
    ["sato", "1", "20"],
    ["yamada", "2", "15"],
  ]);
});

test("AC3 confirm が偽なら書込 0 回・OperationCancelledError", async () => {
  const mock = mockClient();
  const parsed = parseScript(appendSelectSql);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm: () => false,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "OperationCancelledError" },
  });
  await disposeExecutionContext(context);
  expect(mock.writes()).toBe(0);
});

test("AC4 SELECT が 0 行ならテーブルが空になる（親は書かれる）", async () => {
  const mock = mockClient({ sourceRows: [] });
  const parsed = parseScript(appendSelectSql);
  const calls: Array<[number, string, FlowDmlConfirmContext]> = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true,
    confirm: (count, operation, info) => { calls.push([count, operation, info]); return true; },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "success", result: { type: "UPDATE", updatedCount: 1 },
  });
  await disposeExecutionContext(context);
  expect(calls[0][2].applyDetail).toMatchObject({
    tables: [{ table: "明細", appendRows: 0, removeRows: 2 }],
  });
  expect(putSubtable(mock.putRecords.mock.calls[0][0] as never)).toEqual([]);
});

test("AC5 親が 2 件以上なら最初の書込より前に ApplyAppendSelectMultipleParentsError（ソースの SELECT も実行しない）", async () => {
  const mock = mockClient({ parentIds: [1, 2] });
  const parsed = parseScript(appendSelectSql);
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm,
  });
  const result = await executeStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  expect(result.status).toBe("error");
  expect(result.error?.code).toBe("ApplyAppendSelectMultipleParentsError");
  expect(result.error?.message).toContain("one parent record");
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
  expect(mock.reads).not.toContain(SRC);
});

test("AC6 dmlMaxSubtableRows は既存行 + SELECT の行数で数え、最初の書込より前に止まる", async () => {
  const mock = mockClient();
  const parsed = parseScript(appendSelectSql);
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, dmlMaxSubtableRows: 3, confirm,
  });
  const result = await executeStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  expect(result.status).toBe("error");
  expect(result.error?.message).toContain("APPLY changed subtable rows (4) exceed dmlMaxSubtableRows (3)");
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
});

test("AC8 既存の APPEND ... VALUES は変わらない", async () => {
  const mock = mockClient();
  const parsed = parseScript(`${header}UPDATE APP${AGG} SET 合計 = 1 WHERE 顧客コード = 'C001'`
    + " APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者, 件数, 金額) VALUES ('yamada', 1, 100));");
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm: () => true,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
  await disposeExecutionContext(context);
  expect(putSubtable(mock.putRecords.mock.calls[0][0] as never)).toEqual([["yamada", "1", "100"]]);
  expect(mock.reads).not.toContain(SRC);
});

test("$id = n の単一親でも書ける", async () => {
  const mock = mockClient();
  const parsed = parseScript(appendSelectSql.replace("WHERE 顧客コード = 'C001'\n", "WHERE $id = 1\n"));
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm: () => true,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
  await disposeExecutionContext(context);
  expect(putSubtable(mock.putRecords.mock.calls[0][0] as never)).toEqual([
    ["sato", "1", "20"],
    ["yamada", "2", "15"],
  ]);
});

test("SELECT の列数が APPEND のフィールド数と合わなければ書込 0 回のエラー", async () => {
  const mock = mockClient();
  const parsed = parseScript(`${header}UPDATE APP${AGG} SET 合計 = 1 WHERE 顧客コード = 'C001'`
    + ` APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者, 件数, 金額) SELECT 担当者 FROM APP${SRC});`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm: () => true,
  });
  const result = await executeStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  expect(result.status).toBe("error");
  expect(result.error?.message).toContain("APPEND の");
  expect(mock.writes()).toBe(0);
});

test.each([
  ["REMOVE ALL ROWS が無い", `APPLY 明細 (APPEND (担当者, 件数, 金額) SELECT 担当者, COUNT(*) AS 件数合計, SUM(金額) AS 金額合計 FROM APP${SRC} GROUP BY 担当者)`,
    /requires REMOVE ALL ROWS/],
  ["PATCH と同居", `APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者, 件数, 金額) SELECT 担当者, COUNT(*) AS 件数合計, SUM(金額) AS 金額合計 FROM APP${SRC} GROUP BY 担当者; PATCH SET 件数 = 1 WHERE _idx = 0)`,
    /allows only REMOVE ALL ROWS beside it/],
  ["APPEND ... VALUES と同居", `APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者) VALUES ('a'); APPEND (担当者, 件数, 金額) SELECT 担当者, COUNT(*) AS 件数合計, SUM(金額) AS 金額合計 FROM APP${SRC} GROUP BY 担当者)`,
    /allows only REMOVE ALL ROWS beside it/],
])("形の固定: %s は createExecutionContext が ArgumentError", (_label, applyBlock, expected) => {
  const mock = mockClient();
  const parsed = parseScript(`${header}UPDATE APP${AGG} SET 合計 = 1 WHERE 顧客コード = 'C001' ${applyBlock};`);
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm: () => true,
  })).toThrow(expected);
});

test("INSERT の APPLY では APPEND ... SELECT を parse で断る", () => {
  const parsed = parseScript(`${header}INSERT INTO APP${AGG} (顧客コード) VALUES ('C001')`
    + ` APPLY 明細 (APPEND (担当者, 件数, 金額) SELECT 担当者, COUNT(*) AS 件数合計, SUM(金額) AS 金額合計 FROM APP${SRC} GROUP BY 担当者);`);
  expect(parsed.diagnostics.some((item) =>
    item.severity === "error" && item.message.includes("UPDATE ... APPLY だけで使えます"))).toBe(true);
});

test("UPSERT の分岐 APPLY でも APPEND ... SELECT を parse で断る", () => {
  const parsed = parseScript(`${header}UPSERT INTO APP${AGG} (顧客コード) VALUES ('C001') ON DUPLICATE (顧客コード)`
    + ` ON INSERT APPLY 明細 (APPEND (担当者, 件数, 金額) SELECT 担当者, COUNT(*) AS 件数合計, SUM(金額) AS 金額合計 FROM APP${SRC} GROUP BY 担当者);`);
  expect(parsed.diagnostics.some((item) =>
    item.severity === "error" && item.message.includes("UPDATE ... APPLY だけで使えます"))).toBe(true);
});

test("一時テーブルをソースにする形は、文法を足したあとも createExecutionContext が断る", () => {
  const mock = mockClient();
  const parsed = parseScript(`${header}CREATE TEMP TABLE #d AS`
    + ` SELECT 担当者, COUNT(*) AS 件数, SUM(金額) AS 金額 FROM APP${SRC} GROUP BY 担当者;\n`
    + `UPDATE APP${AGG} SET 合計 = 1 WHERE 顧客コード = 'C001'`
    + " APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者, 件数, 金額) SELECT 担当者, 件数, 金額 FROM #d);");
  expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm: () => true,
  })).toThrow(/temp table references in UPDATE are not supported yet/);
});

describe("KSQL1307: 親の WHERE が 1 件に決まると読めないときの warning", () => {
  const schema = (appId: number) => (appId === AGG ? aggFields : srcFields);

  test("重複禁止のキーの等値なら warning は出ない", async () => {
    const diagnostics = await validateScript(appendSelectSql, { schema });
    expect(diagnostics.filter((item) => item.code === "KSQL1307")).toEqual([]);
  });

  test("$id = n なら warning は出ない", async () => {
    const diagnostics = await validateScript(
      appendSelectSql.replace("WHERE 顧客コード = 'C001'\n", "WHERE $id = 1\n"),
      { schema }
    );
    expect(diagnostics.filter((item) => item.code === "KSQL1307")).toEqual([]);
  });

  test("重複禁止でない項目の等値なら warning", async () => {
    const diagnostics = await validateScript(
      appendSelectSql.replace("WHERE 顧客コード = 'C001'\n", "WHERE メモ = 'C001'\n"),
      { schema }
    );
    const found = diagnostics.filter((item) => item.code === "KSQL1307");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain("重複禁止ではありません");
  });

  test("等値でない WHERE なら schema 無しでも warning", async () => {
    const diagnostics = await validateScript(
      appendSelectSql.replace("WHERE 顧客コード = 'C001'\n", "WHERE 合計 > 0\n")
    );
    expect(diagnostics.filter((item) => item.code === "KSQL1307")).toHaveLength(1);
  });

  test("APPEND ... VALUES には出ない", async () => {
    const diagnostics = await validateScript(
      `${header}UPDATE APP${AGG} SET 合計 = 1 WHERE メモ = 'x'`
      + " APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者) VALUES ('a'));",
      { schema }
    );
    expect(diagnostics.filter((item) => item.code === "KSQL1307")).toEqual([]);
  });
});

test("VALIDATE ONLY は SELECT を解決して検証するだけ（書込 0 回・確認も呼ばれない）", async () => {
  const mock = mockClient();
  const parsed = parseScript(appendSelectSql.replace(/\n \);$/, "\n ) VALIDATE ONLY;"));
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, confirm,
  });
  const result = await executeStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  expect(result.status).toBe("success");
  expect(result.result).toMatchObject({ type: "VALIDATION", operation: "UPDATE", validatedRows: 1 });
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
  expect(mock.reads).toContain(SRC);   // ソースは読む（検証のため）
});

test("EXPLAIN はソースの SELECT を [source SELECT] の節で出す（行数の見積もりはしない）", async () => {
  const mock = mockClient();
  const result = await explainScript(appendSelectSql, { client: mock.value });
  const plan = result.statements[0].plan.join("\n");
  expect(plan).toContain("statement:              UPDATE APPLY");
  expect(plan).toContain("append source:          SELECT × 1");
  expect(plan).toContain("[source SELECT: 明細]");
  expect(plan).toContain(`APP${SRC}`);
});
