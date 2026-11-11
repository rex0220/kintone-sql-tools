import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  validateScript,
  type FlowKintoneClient,
  type ParseScriptOptions,
  type StatementResult,
} from "../index";

// B217（kSQL アクションの依頼 KJ-13）: 文の数（既定 20）と同時に残っている一時テーブルの数（既定 16）を、
// /flow の呼び出し側が maxBatchStatements / maxTempTables で変えられる。
// B218: validateScript も、実行の入口と同じバッチの検査（一時テーブルの数など）を返す。

function mockClient() {
  const calls: string[] = [];
  const value = {
    async getRecords(params: { app: number; query: string }) {
      calls.push(`getRecords app${params.app}`);
      return {
        records: [
          { $id: { value: "1" }, k: { value: "A" } },
          { $id: { value: "2" }, k: { value: "B" } },
        ],
      };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { calls.push("postRecords"); return { ids: [] }; },
    async putRecords() { calls.push("putRecords"); },
    async deleteRecords() { calls.push("deleteRecords"); },
    async getApps() { return []; },
    async getFields() { return [{ code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" }]; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
  return { client: value as unknown as FlowKintoneClient, calls };
}

/** 一時テーブルを temps 個作り、ASSERT で埋めて statements 文にする（最後は SELECT）。 */
function script(statements: number, temps: number): string {
  const lines = ["-- @ksql dialect: 1", "CREATE TEMP TABLE #t1 AS SELECT k FROM APP1;"];
  for (let index = 2; index <= temps; index += 1) {
    lines.push(`CREATE TEMP TABLE #t${index} AS SELECT k FROM #t${index - 1};`);
  }
  while (lines.length - 1 < statements - 1) lines.push(`ASSERT (SELECT COUNT(*) FROM #t${temps}) = 2, 'x';`);
  lines.push(`SELECT k FROM #t${temps};`);
  expect(lines.length - 1).toBe(statements);
  return lines.join("\n");
}

const errors = (diagnostics: ReadonlyArray<{ severity: string; message: string }>) =>
  diagnostics.filter((item) => item.severity === "error").map((item) => item.message);

async function runAll(sql: string, opts: ParseScriptOptions & { tempTablesMaxTotalRows?: number }) {
  const { client, calls } = mockClient();
  const parsed = parseScript(sql, opts);
  expect(errors(parsed.diagnostics)).toEqual([]);
  const context = createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta, ...opts });
  let last: StatementResult | undefined;
  try {
    for (const statement of parsed.statements) {
      last = await executeStatement(statement, context);
      if (last.status === "error") break;
    }
  } finally {
    await disposeExecutionContext(context);
  }
  return { last: last!, calls };
}

const LIMITS = { maxBatchStatements: 50, maxTempTables: 30, tempTablesMaxTotalRows: 20_000 } as const;

describe("B217 既定（20 文・16 個）は変わらない", () => {
  test("20 文・16 個はどの入口も通る", async () => {
    const sql = script(20, 16);
    const { client } = mockClient();
    expect(errors(parseScript(sql).diagnostics)).toEqual([]);
    expect(errors(await validateScript(sql, { client }))).toEqual([]);
    await expect(explainScript(sql, { client })).resolves.toBeDefined();
    const { last } = await runAll(sql, {});
    expect(last.status).toBe("success");
  });

  test("21 文は解析で止まる", () => {
    expect(errors(parseScript(script(21, 5)).diagnostics)).toEqual(["batch exceeds 20 statements."]);
  });

  test("17 個は検査・実行計画・実行の入口で止まる（レコードを読まない）", async () => {
    const sql = script(18, 17);
    const { client, calls } = mockClient();
    expect(errors(await validateScript(sql, { client }))).toEqual(["ParseError: batch exceeds 16 temp tables."]);
    await expect(explainScript(sql, { client })).rejects.toThrow("batch exceeds 16 temp tables.");
    const parsed = parseScript(sql);
    expect(() => createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta }))
      .toThrow("batch exceeds 16 temp tables.");
    expect(calls).toEqual([]);
  });
});

describe("B217 maxBatchStatements / maxTempTables を渡す", () => {
  test("50 文・30 個はどの入口も通り、最後まで流れる", async () => {
    const sql = script(50, 30);
    const { client } = mockClient();
    expect(errors(parseScript(sql, LIMITS).diagnostics)).toEqual([]);
    expect(errors(await validateScript(sql, { ...LIMITS, client }))).toEqual([]);
    await expect(explainScript(sql, { ...LIMITS, client })).resolves.toBeDefined();
    const { last } = await runAll(sql, LIMITS);
    expect(last.status).toBe("success");
  });

  test("script を渡す形でも 50 文・30 個が流れる", async () => {
    const { client } = mockClient();
    const context = createExecutionContext({ client, script: script(50, 30), ...LIMITS });
    await disposeExecutionContext(context);
  });

  test("51 文は効いている上限の数で止まる", async () => {
    const sql = script(51, 5);
    const { client } = mockClient();
    expect(errors(parseScript(sql, LIMITS).diagnostics)).toEqual(["batch exceeds 50 statements."]);
    expect(errors(await validateScript(sql, { ...LIMITS, client }))).toEqual(["batch exceeds 50 statements."]);
    await expect(explainScript(sql, { ...LIMITS, client })).rejects.toThrow("batch exceeds 50 statements.");
  });

  test("31 個は効いている上限の数で止まる", async () => {
    const sql = script(32, 31);
    const { client, calls } = mockClient();
    expect(errors(await validateScript(sql, { ...LIMITS, client }))).toEqual(["ParseError: batch exceeds 30 temp tables."]);
    await expect(explainScript(sql, { ...LIMITS, client })).rejects.toThrow("batch exceeds 30 temp tables.");
    const parsed = parseScript(sql, LIMITS);
    expect(() => createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta, ...LIMITS }))
      .toThrow("batch exceeds 30 temp tables.");
    expect(calls).toEqual([]);
  });

  test("16 より多くするのに tempTablesMaxTotalRows が無ければ、レコードを読む前に止まる", () => {
    const { client, calls } = mockClient();
    const parsed = parseScript(script(18, 17), { maxTempTables: 30 });
    expect(() => createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta, maxTempTables: 30 }))
      .toThrow("ArgumentError: maxTempTables above 16 requires tempTablesMaxTotalRows");
    expect(calls).toEqual([]);
  });

  test("16 ちょうどなら tempTablesMaxTotalRows は要らない", () => {
    const { client } = mockClient();
    const parsed = parseScript(script(17, 16), { maxTempTables: 16 });
    expect(() => createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta, maxTempTables: 16 }))
      .not.toThrow();
  });

  test("解析は 50 で、実行の入口に渡し忘れたら、解析と同じ文で止まる（レコードを読まない）", () => {
    const { client, calls } = mockClient();
    const parsed = parseScript(script(30, 5), { maxBatchStatements: 50 });
    expect(() => createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta }))
      .toThrow("batch exceeds 20 statements.");
    expect(calls).toEqual([]);
  });

  test.each([
    ["maxBatchStatements", 0], ["maxBatchStatements", 101], ["maxBatchStatements", 1.5],
    ["maxTempTables", 0], ["maxTempTables", 65], ["maxTempTables", Number.NaN],
  ] as const)("%s = %p は RangeError", (name, value) => {
    expect(() => parseScript("SELECT k FROM APP1", { [name]: value })).toThrow(RangeError);
  });

  test("天井ちょうど（100 / 64）は受ける", () => {
    expect(errors(parseScript(script(100, 5), { maxBatchStatements: 100, maxTempTables: 64 }).diagnostics)).toEqual([]);
  });
});

describe("B218 validateScript がバッチの検査を返す", () => {
  test("未定義の一時テーブルの参照（v3.95.0 は検査を通り、実行の入口で止まっていた）", async () => {
    const sql = "-- @ksql dialect: 1\nCREATE TEMP TABLE #a AS SELECT k FROM APP1;\nSELECT k FROM #nope;";
    const diagnostics = await validateScript(sql);
    expect(diagnostics.filter((item) => item.severity === "error")).toEqual([
      expect.objectContaining({ code: "KSQL1202", statementIndex: 1, message: expect.stringContaining("#nope") }),
    ]);
    const { client } = mockClient();
    const parsed = parseScript(sql);
    expect(() => createExecutionContext({ client, statements: parsed.statements, meta: parsed.meta }))
      .toThrow("#nope");
  });

  test("一時テーブルの数の誤りは、超えた文の位置（行）に付く", async () => {
    const diagnostics = await validateScript(script(18, 17));
    const error = diagnostics.find((item) => item.severity === "error")!;
    expect(error.statementIndex).toBe(16);
    expect(error.line).toBe(18);
  });

  test("通る SQL には何も足さない", async () => {
    expect(errors(await validateScript(script(10, 3)))).toEqual([]);
  });
});
