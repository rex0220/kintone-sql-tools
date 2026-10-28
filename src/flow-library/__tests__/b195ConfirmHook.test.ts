import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  KsqlFlowError,
  parseScript,
  type FlowDmlConfirm,
  type FlowDmlConfirmContext,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

const keyFields = [
  { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", isUnique: true },
  { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
];

const applyFields = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
];

function keyRecord(id: number, key: string): Rec {
  return { $id: { value: String(id) }, $revision: { value: "1" }, key: { value: key }, value: { value: "v" } };
}

function applyParent(): Rec {
  return {
    $id: { value: "8" },
    $revision: { value: "3" },
    親: { value: "before" },
    テーブル: { value: [{ id: "101", value: { 子: { value: "old" } } }] },
  };
}

/** APP1 = 書込先（K1..K3）、APP2 = INSERT / UPSERT の SELECT 元（K1, K8）、APP3 = 0 件、APP4221 = APPLY の親。 */
function mockClient(options: { readDelayMs?: number } = {}) {
  const data = new Map<number, Rec[]>([
    [1, [keyRecord(1, "K1"), keyRecord(2, "K2"), keyRecord(3, "K3")]],
    [2, [keyRecord(21, "K1"), keyRecord(22, "K8")]],
    [3, []],
    [4221, [applyParent()]],
  ]);
  const recordsOf = (app: number, query: string): Rec[] => {
    const records = data.get(app) ?? [];
    if (!/\bin\s*\(/i.test(query)) return records;
    const keys = new Set([...query.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
    return records.filter((record) => keys.has(String(record.key?.value)));
  };
  let nextId = 1000;
  const postRecords = jest.fn(async ({ records }: { app: number; records: unknown[] }) => ({
    ids: records.map(() => String(++nextId)),
  }));
  const putRecords = jest.fn(async (_params: unknown) => undefined);
  const deleteRecords = jest.fn(async (_params: unknown) => undefined);
  const getRecords = jest.fn(async (params: { app: number; query: string; totalCount?: boolean }) => {
    if (options.readDelayMs) await new Promise((resolve) => setTimeout(resolve, options.readDelayMs));
    const records = recordsOf(params.app, params.query);
    return params.totalCount ? { records, totalCount: String(records.length) } : { records };
  });
  const value = {
    getRecords,
    async openCursor(params: { app: number; query: string }) {
      const records = recordsOf(params.app, params.query);
      return {
        totalCount: records.length,
        async nextPage() { return { records, next: false }; },
        async close() {},
      };
    },
    postRecords,
    putRecords,
    deleteRecords,
    async getApps() { return []; },
    async getFields(appId: number) { return appId === 4221 ? applyFields : keyFields; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
  const writes = () => postRecords.mock.calls.length + putRecords.mock.calls.length + deleteRecords.mock.calls.length;
  return { value, postRecords, putRecords, deleteRecords, getRecords, writes };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("AC1 件数・operation・statementType が内部の呼出し元どおりに渡る（UPDATE / DELETE / INSERT SELECT / UPSERT / UPSERT SELECT）", async () => {
  const mock = mockClient();
  const parsed = parseScript([
    "-- @ksql dialect: 1",
    "UPDATE APP1 SET value = 'u' WHERE $id > 0;",
    "DELETE FROM APP1 WHERE $id > 0;",
    "INSERT INTO APP1 (key, value) SELECT key, value FROM APP2;",
    "UPSERT INTO APP1 (key, value) VALUES ('K1', 'a'), ('K9', 'b') KEY (key);",
    "UPSERT INTO APP1 (key, value) SELECT key, value FROM APP2 KEY (key);",
  ].join("\n"));
  const calls: Array<[number, string, FlowDmlConfirmContext]> = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    confirm: async (count, operation, info) => { calls.push([count, operation, info]); return true; },
  });
  for (const statement of parsed.statements) {
    await expect(executeStatement(statement, context)).resolves.toMatchObject({ status: "success" });
  }
  await disposeExecutionContext(context);

  expect(calls.map(([count, operation, info]) => [count, operation, info.statementIndex, info.statementType])).toEqual([
    [3, "UPDATE", 0, "UPDATE"],
    [3, "DELETE", 1, "DELETE"],
    [2, "INSERT", 2, "INSERT_SELECT"],
    [2, "UPDATE", 3, "UPSERT"],          // 追加 1（K9）+ 更新 1（K1）
    [2, "UPDATE", 4, "UPSERT_SELECT"],   // 追加 1（K8）+ 更新 1（K1）
  ]);
  for (const [, , info] of calls) {
    expect(info).toMatchObject({ statementCount: 5, targetAppId: 1 });
    expect(info).not.toHaveProperty("logicalAppName");
    expect(info).not.toHaveProperty("applyDetail");
    expect(info.signal).toBeInstanceOf(AbortSignal);
    expect(info.signal.aborted).toBe(false);
  }
});

const applySql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 APPLY テーブル (PATCH SET 子 = 'patched' WHERE _rid = '101')";

test("APPLY は公開の options では書けない（allowApplyMutation が公開されていない）。フックも呼ばれない", async () => {
  const mock = mockClient();
  const parsed = parseScript(applySql);
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({ client: mock.value, statements: parsed.statements, meta: parsed.meta, confirm });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "UnsupportedError" },
  });
  await disposeExecutionContext(context);
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
});

test("B198 以降: allowApplyMutation + confirm なら APPLY は書ける（詳細は b198ApplyMutation.test.ts）", async () => {
  const mock = mockClient();
  const parsed = parseScript(applySql);
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, confirm,
    allowApplyMutation: true,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
  await disposeExecutionContext(context);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][2]).toMatchObject({ applyDetail: { kind: "APPLY_PATCH", parentRows: 1 } });
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
});

test("AC2 LAPP の文は物理のアプリ ID と正規化した論理名で渡る", async () => {
  const mock = mockClient();
  const parsed = parseScript(
    "-- @ksql dialect: 1\nUPDATE LAPP_Target SET value = 'u' WHERE $id > 0;",
    { apps: { target: 1 } }
  );
  const infos: FlowDmlConfirmContext[] = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    confirm: (_count, _operation, info) => { infos.push(info); return true; },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "success", result: { type: "UPDATE", updatedCount: 3 },
  });
  await disposeExecutionContext(context);

  expect(infos).toHaveLength(1);
  expect(infos[0].targetAppId).toBe(1);
  expect(infos[0].logicalAppName).toBe("TARGET");
  expect(mock.putRecords.mock.calls[0][0]).toMatchObject({ app: 1 });
});

test.each([
  ["false", false],
  ["undefined", undefined],
  ["truthy non-boolean", "yes"],
])("AC3 フックが %s を返すと書込 0 回・OperationCancelledError・後続は fail-fast で skipped", async (_label, answer) => {
  const mock = mockClient();
  const parsed = parseScript("UPDATE APP1 SET value = 'u' WHERE $id > 0; DELETE FROM APP1 WHERE $id > 0;");
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    confirm: (async () => answer) as unknown as FlowDmlConfirm,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "OperationCancelledError" },
  });
  await expect(executeStatement(parsed.statements[1], context)).resolves.toMatchObject({
    status: "skipped", skippedReason: "fail-fast",
  });
  expect(mock.writes()).toBe(0);
  await disposeExecutionContext(context);
});

test("AC3 フックが reject すると、その文は reject の code の error で書込 0 回", async () => {
  const mock = mockClient();
  const parsed = parseScript("UPDATE APP1 SET value = 'u' WHERE $id > 0");
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    confirm: async () => { throw new Error("LockLostError: lock is gone."); },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "LockLostError" },
  });
  expect(mock.writes()).toBe(0);
  await disposeExecutionContext(context);
});

test("AC4 確認を待つ間に期限が来ると signal が中止され、期限切れの結果。後から true でも書かない", async () => {
  const mock = mockClient();
  const parsed = parseScript("UPDATE APP1 SET value = 'u' WHERE $id > 0; DELETE FROM APP1 WHERE $id > 0;");
  let seen: AbortSignal | undefined;
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, timeoutMs: 40,
    confirm: (_count, _operation, info) => {
      seen = info.signal;
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 120));
    },
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "TimeoutError" },
  });
  expect(seen?.aborted).toBe(true);
  expect((seen?.reason as Error).name).toBe("TimeoutError");
  await expect(executeStatement(parsed.statements[1], context)).resolves.toMatchObject({
    status: "skipped", skippedReason: "timeout",
  });
  await sleep(160);
  expect(mock.writes()).toBe(0);
  await disposeExecutionContext(context);
});

test("AC5 確認を待つ間に dispose すると signal が中止され、dispose 済みのエラー。後から true でも書かない", async () => {
  const mock = mockClient();
  const parsed = parseScript("UPDATE APP1 SET value = 'u' WHERE $id > 0");
  const answer = deferred<boolean>();
  const entered = deferred<AbortSignal>();
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    confirm: (_count, _operation, info) => { entered.resolve(info.signal); return answer.promise; },
  });
  const execution = executeStatement(parsed.statements[0], context);
  const signal = await entered.promise;
  expect(signal.aborted).toBe(false);
  await disposeExecutionContext(context);
  expect(signal.aborted).toBe(true);
  expect((signal.reason as Error).name).toBe("ExecutionContextDisposedError");
  await expect(execution).resolves.toMatchObject({
    status: "error", error: { code: "ExecutionContextDisposedError" },
  });
  answer.resolve(true);
  await sleep(20);
  expect(mock.writes()).toBe(0);
  await expect(executeStatement(parsed.statements[0], context)).rejects.toMatchObject({
    code: "ExecutionContextDisposedError",
  });
});

test("AC6 呼ばれない文: 対象 0 件の UPSERT と INSERT VALUES。0 件の UPDATE は件数 0 で呼ばれる", async () => {
  const mock = mockClient();
  const parsed = parseScript([
    "-- @ksql dialect: 1",
    "UPSERT INTO APP1 (key, value) SELECT key, value FROM APP3 KEY (key);",
    "INSERT INTO APP1 (key, value) VALUES ('K7', 'x');",
    "UPDATE APP3 SET value = 'u' WHERE $id > 0;",
  ].join("\n"));
  const calls: Array<[number, string, number]> = [];
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    confirm: (count, operation, info) => { calls.push([count, operation, info.statementIndex]); return true; },
  });
  for (const statement of parsed.statements) {
    await expect(executeStatement(statement, context)).resolves.toMatchObject({ status: "success" });
  }
  await disposeExecutionContext(context);
  expect(calls).toEqual([[0, "UPDATE", 2]]);
  expect(mock.postRecords).toHaveBeenCalledTimes(1);   // INSERT VALUES は確認なしで書く
});

test("約束 3 の補足: INSERT VALUES でも ON ERROR SKIP 付きは確認フックを通る", async () => {
  const mock = mockClient();
  const parsed = parseScript(
    "INSERT INTO APP1 (key, value) VALUES ('K7', 'x') ON ERROR SKIP INTO #err; SELECT * FROM #err"
  );
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({ client: mock.value, statements: parsed.statements, meta: parsed.meta, confirm });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
  await disposeExecutionContext(context);
  expect(confirm).toHaveBeenCalledWith(1, "INSERT", expect.objectContaining({ statementType: "INSERT" }));
  expect(mock.postRecords).toHaveBeenCalledTimes(1);
});

test("約束 3 の補足: INSERT VALUES でも CHECK 付きは確認フックを通る", async () => {
  const mock = mockClient();
  const parsed = parseScript("INSERT INTO APP1 (key, value) VALUES ('K7', 'x') CHECK WHEN value = '' THEN 'empty'");
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({ client: mock.value, statements: parsed.statements, meta: parsed.meta, confirm });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({ status: "success" });
  await disposeExecutionContext(context);
  expect(confirm).toHaveBeenCalledWith(1, "INSERT", expect.objectContaining({ statementType: "INSERT" }));
  expect(mock.postRecords).toHaveBeenCalledTimes(1);
});

test("約束 5: 確認の前に期限が過ぎていればフックを呼ばず、切り離された実行も書かない", async () => {
  const mock = mockClient({ readDelayMs: 60 });
  const parsed = parseScript("UPDATE APP1 SET value = 'u' WHERE $id > 0");
  const confirm = jest.fn<ReturnType<FlowDmlConfirm>, Parameters<FlowDmlConfirm>>(() => true);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, timeoutMs: 20, confirm,
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "TimeoutError" },
  });
  await sleep(120);
  expect(confirm).not.toHaveBeenCalled();
  expect(mock.writes()).toBe(0);
  await disposeExecutionContext(context);
});

function upsertValues(count: number): string {
  const rows = Array.from({ length: count }, (_, index) => `('N${index + 1}','v')`);
  return `-- @ksql dialect: 1\nUPSERT INTO APP1 (key,value) VALUES ${rows.join(",")} KEY (key);`;
}

test("約束 5（confirm なし）: 期限切れの結果を返したあと、切り離された実行は次のチャンクを書かない", async () => {
  const mock = mockClient();
  const parsed = parseScript(upsertValues(250));
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, timeoutMs: 30,
    onChunkWritten: (info) => (info.chunkIndex === 0 ? sleep(80) : undefined),
  });
  await expect(executeStatement(parsed.statements[0], context)).resolves.toMatchObject({
    status: "error", error: { code: "TimeoutError" },
  });
  await sleep(120);
  expect(mock.postRecords).toHaveBeenCalledTimes(1);
  await disposeExecutionContext(context);
});

test("約束 5（confirm なし）: 書込の途中で dispose すると次のチャンクを書かず dispose 済みのエラー", async () => {
  const mock = mockClient();
  const parsed = parseScript(upsertValues(250));
  const gate = deferred<void>();
  const firstChunk = deferred<void>();
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    onChunkWritten: async (info) => {
      if (info.chunkIndex !== 0) return;
      firstChunk.resolve();
      await gate.promise;
    },
  });
  const execution = executeStatement(parsed.statements[0], context);
  await firstChunk.promise;
  await disposeExecutionContext(context);
  gate.resolve();
  await expect(execution).resolves.toMatchObject({
    status: "error", error: { code: "ExecutionContextDisposedError" },
  });
  expect(mock.postRecords).toHaveBeenCalledTimes(1);
});

test("IMPORT を含むスクリプトに confirm を渡すと createExecutionContext が ArgumentError", () => {
  const parsed = parseScript("IMPORT INTO APP1 (key) FROM CSV source", { enableImport: true });
  let thrown: unknown;
  try {
    createExecutionContext({
      client: mockClient().value, statements: parsed.statements, meta: parsed.meta, enableImport: true,
      confirm: () => true,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(KsqlFlowError);
  expect(thrown).toMatchObject({ code: "ArgumentError" });
});

test("confirm が関数でなければ createExecutionContext が TypeError", () => {
  const parsed = parseScript("UPDATE APP1 SET value = 'u' WHERE $id > 0");
  expect(() => createExecutionContext({
    client: mockClient().value, statements: parsed.statements, meta: parsed.meta,
    confirm: true as unknown as FlowDmlConfirm,
  })).toThrow(expect.objectContaining({ code: "TypeError" }));
});
