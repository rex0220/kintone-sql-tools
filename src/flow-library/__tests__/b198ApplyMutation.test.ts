import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowDmlConfirm,
  type FlowDmlConfirmContext,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

/** APP100 = APPLY の親（サブテーブル 明細 ＋ 多値 タグ）。 */
const parentFields = [
  { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT", writable: true, isUnique: true },
  { code: "件数", label: "件数", fieldType: "NUMBER", writable: true },
  { code: "タグ", label: "タグ", fieldType: "CHECK_BOX", writable: true },
  { code: "明細", label: "明細", fieldType: "SUBTABLE", writable: false },
  { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "明細" },
  { code: "金額", label: "金額", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "明細" },
];

function parent(id: number): Rec {
  return {
    $id: { value: String(id) },
    $revision: { value: "2" },
    顧客コード: { value: "C001" },
    件数: { value: "0" },
    タグ: { value: ["A"] },
    明細: { value: [
      { id: `${id}01`, value: { 担当者: { value: "old1" }, 金額: { value: "10" } } },
      { id: `${id}02`, value: { 担当者: { value: "old2" }, 金額: { value: "20" } } },
    ] },
  };
}

function mockClient(parentIds: readonly number[] = [1]) {
  const putRecords = jest.fn(async (_params: unknown) => undefined);
  const postRecords = jest.fn(async ({ records }: { records: unknown[] }) => ({
    ids: records.map((_, index) => String(900 + index)),
  }));
  const deleteRecords = jest.fn(async (_params: unknown) => undefined);
  const records = () => parentIds.map(parent);
  const value = {
    async getRecords(params: { app: number; query: string; totalCount?: boolean }) {
      const rows = records();
      return params.totalCount ? { records: rows, totalCount: String(rows.length) } : { records: rows };
    },
    async openCursor() {
      const rows = records();
      return { totalCount: rows.length, async nextPage() { return { records: rows, next: false }; }, async close() {} };
    },
    postRecords,
    putRecords,
    deleteRecords,
    async getApps() { return []; },
    async getFields() { return parentFields; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
  const writes = () => putRecords.mock.calls.length + postRecords.mock.calls.length + deleteRecords.mock.calls.length;
  return { value, putRecords, postRecords, deleteRecords, writes };
}

const header = "-- @ksql dialect: 1\n";
const applySql = header
  + "UPDATE APP100 SET 件数 = 1 WHERE 顧客コード = 'C001'"
  + " APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者, 金額) VALUES ('yamada', 100));";

function subtableRows(putCall: { records: { id: string; record: Rec }[] }): unknown[] {
  return (putCall.records[0].record["明細"]?.value ?? []) as unknown[];
}

test("AC1/AC2 allowApplyMutation + confirm で APPLY が書ける。確認は文に 1 回・count は親レコード数・applyDetail が計画と一致", async () => {
  const mock = mockClient();
  const parsed = parseScript(applySql);
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
  const [count, operation, info] = calls[0];
  expect([count, operation]).toEqual([1, "UPDATE"]);
  expect(info).toMatchObject({ statementIndex: 0, statementCount: 1, statementType: "UPDATE", targetAppId: 100 });
  expect(info.applyDetail).toMatchObject({
    kind: "APPLY_PATCH",
    parentRows: 1,
    changedSubtableRows: 3,       // 既存 2 行を消して 1 行を追加
    addedSubtableRows: 1,
    deletedRows: 2,
    deletedParentRows: 1,
    revisionRequired: true,
    irreversible: true,
    retryOnRevisionConflict: false,
    tables: [{ table: "明細", patchRows: 0, appendRows: 1, removeRows: 2 }],
  });
  // 内部の詳細は公開しない。
  expect(info).not.toHaveProperty("applyDiagnostic");
  expect(info.applyDetail).not.toHaveProperty("multiValues");
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
  expect(subtableRows(mock.putRecords.mock.calls[0][0] as never)).toHaveLength(1);
});

test("AC3 confirm が偽なら書込 0 回・OperationCancelledError", async () => {
  const mock = mockClient();
  const parsed = parseScript(applySql);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true,
    confirm: () => false,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "OperationCancelledError" },
  });
  await disposeExecutionContext(context);
  expect(mock.writes()).toBe(0);
});

test("AC4 dmlMaxSubtableRows 超過は最初の書込より前にエラー（既存行 + 追加行で数える）", async () => {
  const mock = mockClient();
  const parsed = parseScript(applySql);
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, dmlMaxSubtableRows: 2, confirm,
  });
  const result = await executeStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  expect(result.status).toBe("error");
  expect(result.error?.message).toContain("exceed dmlMaxSubtableRows (2)");
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
});

test("AC5 allowApplyMutation を渡さなければ今までどおり UnsupportedError・確認も呼ばれない", async () => {
  const mock = mockClient();
  const parsed = parseScript(applySql);
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, confirm,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "UnsupportedError" },
  });
  await disposeExecutionContext(context);
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
});

test("AC6 複数親でも確認は 1 回・applyDetail は全親の合計・nonTransactional が立つ", async () => {
  const mock = mockClient([1, 2]);
  const parsed = parseScript(applySql);
  const infos: FlowDmlConfirmContext[] = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true,
    confirm: (_count, _operation, info) => { infos.push(info); return true; },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "success", result: { type: "UPDATE", updatedCount: 2 },
  });
  await disposeExecutionContext(context);
  expect(infos).toHaveLength(1);
  expect(infos[0].applyDetail).toMatchObject({
    parentRows: 2,
    changedSubtableRows: 6,   // 2 親 ×（既存 2 + 追加 1）
    addedSubtableRows: 2,
    deletedRows: 4,
    deletedParentRows: 2,
    nonTransactional: true,
    partialSuccessPossible: true,
  });
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
});

test("AC7 親 0 件は件数 0・空の applyDetail で確認が 1 回呼ばれ、書込 0 回で success", async () => {
  const mock = mockClient([]);
  const parsed = parseScript(applySql);
  const calls: Array<[number, string, FlowDmlConfirmContext]> = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true,
    confirm: (count, operation, info) => { calls.push([count, operation, info]); return true; },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "success", result: { type: "UPDATE", updatedCount: 0 },
  });
  await disposeExecutionContext(context);
  // 通常の UPDATE / DELETE（KJ-1 の約束）と同じで、0 件でも呼ばれる。
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(0);
  expect(calls[0][2].applyDetail).toMatchObject({ parentRows: 0, changedSubtableRows: 0, tables: [] });
  expect(mock.writes()).toBe(0);
});

test("AC7 補足: $id = n で親が無いときは ArgumentError（確認は呼ばれない）", async () => {
  const mock = mockClient([]);
  const parsed = parseScript(header
    + "UPDATE APP100 SET 件数 = 1 WHERE $id = 99 APPLY 明細 (REMOVE ALL ROWS);");
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm,
  });
  const result = await executeStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  expect(result.status).toBe("error");
  expect(result.error?.message).toContain("APPLY parent $id 99 does not exist");
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
});

test("AC8 多値 APPLY は createExecutionContext が UnsupportedError（allowApplyMutation では開かない）", () => {
  const mock = mockClient();
  const parsed = parseScript(header + "UPDATE APP100 SET 件数 = 1 WHERE $id = 1 APPLY タグ (ADD 'B');");
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true, confirm: () => true,
  })).toThrow(/UnsupportedError: allowApplyMutation does not cover multi-value APPLY/);
  expect(mock.writes()).toBe(0);
});

test("allowApplyMutation を confirm なしで渡すと createExecutionContext が ArgumentError", () => {
  const mock = mockClient();
  const parsed = parseScript(applySql);
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    allowApplyMutation: true,
  })).toThrow(/ArgumentError: allowApplyMutation requires confirm/);
});

test("APPLY を含まない文の確認には applyDetail が付かない（純加法）", async () => {
  const mock = mockClient();
  const parsed = parseScript(header + "UPDATE APP100 SET 件数 = 1 WHERE 顧客コード = 'C001';");
  const infos: FlowDmlConfirmContext[] = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    confirm: (_count, _operation, info) => { infos.push(info); return true; },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
  await disposeExecutionContext(context);
  expect(infos).toHaveLength(1);
  expect(infos[0]).not.toHaveProperty("applyDetail");
});
