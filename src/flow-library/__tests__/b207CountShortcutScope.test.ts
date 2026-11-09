import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  type FlowKintoneClient,
} from "../index";

/**
 * B207: `COUNT(*)` の近道（`totalCount: true` ＋ `limit 1` の 1 回）を
 * **ASSERT / EXIT / SET のスカラーサブクエリ**と **`CREATE TEMP TABLE … AS SELECT`** にも効かせる。
 *
 * 依頼 KJ-11 の ①＝近道の印（`countTotalCountRootSelects`）が**文としての SELECT と UNION の枝**だけに
 * 付いていたので、計画は `COUNT_TOTAL_COUNT` と表示するのに実行は全件読み、
 * `maxRecords` に当たって `FetchAllLimitError` になっていた。
 *
 * 理由は B105（UNION の枝）と同じ＝**終端**（下流が要るのは値 1 つ／集計後の 1 行だけで、元レコードは要らない）。
 * 適用の判定（`COUNT(*)` だけ・`GROUP BY` / `JOIN` なし・物理アプリ・`WHERE` が完全に押し下がる）は変えない。
 */
const FIELDS = [
  { code: "残数", label: "残数", fieldType: "NUMBER", writable: true },
  { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT", writable: true },
];
const ROWS = Array.from({ length: 12 }, (_, index) => ({
  $id: { type: "__ID__", value: String(index + 1) },
  残数: { type: "NUMBER", value: String(index) },
  区分: { type: "SINGLE_LINE_TEXT", value: index % 2 ? "A" : "B" },
}));

function mockClient() {
  const calls: Array<{ query: string; totalCount: boolean }> = [];
  const value = {
    async getRecords(params: { query: string; totalCount?: boolean }) {
      const query = params.query ?? "";
      calls.push({ query, totalCount: params.totalCount === true });
      let hit = ROWS;
      const eq = /区分 in \("([^"]*)"\)/.exec(query) ?? /区分 = "([^"]*)"/.exec(query);
      if (eq) hit = hit.filter((row) => row.区分.value === eq[1]);
      const offset = Number(/offset (\d+)/.exec(query)?.[1] ?? 0);
      const limit = /limit (\d+)/.exec(query)?.[1];
      const page = hit.slice(offset, limit === undefined ? undefined : offset + Number(limit));
      return params.totalCount === true
        ? { records: page, totalCount: String(hit.length) }
        : { records: page };
    },
    async openCursor() {
      let sent = false;
      return {
        totalCount: ROWS.length,
        async nextPage() { const records = sent ? [] : ROWS; sent = true; return { records, next: false }; },
        async close() {},
      };
    },
    async postRecords(params: { records: unknown[] }) {
      return { ids: params.records.map((_, index) => String(index + 1)) };
    },
    async putRecords() {}, async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return FIELDS; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
  return { value, calls };
}

const header = "-- @ksql dialect: 1\n";

/** 記録 12 件・`maxRecords: 10`＝近道が効かなければ必ず FetchAllLimitError になる。 */
async function run(sql: string, maxRecords = 10) {
  const mock = mockClient();
  const parsed = parseScript(`${header}${sql}`);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, maxRecords,
  });
  const results = [];
  try {
    for (const statement of parsed.statements) {
      const result = await executeStatement(statement, context);
      results.push(result);
      if (result.status === "error") break;
    }
  } finally {
    await disposeExecutionContext(context);
  }
  return { ...mock, results };
}

const shortcutCalls = (calls: Array<{ query: string; totalCount: boolean }>) =>
  calls.filter((call) => call.totalCount && / ?limit 1$/.test(call.query));

test("B207: ASSERT のスカラーサブクエリの COUNT(*) は 1 回の GET で数える", async () => {
  const { calls, results } = await run("ASSERT (SELECT COUNT(*) FROM APP200) <= 100, 'too many';");
  expect(results[0].status).toBe("success");
  expect(calls).toHaveLength(1);
  expect(shortcutCalls(calls)).toHaveLength(1);
});

test("B207: EXIT SUCCESS IF も同じ", async () => {
  const { calls, results } = await run("EXIT SUCCESS IF (SELECT COUNT(*) FROM APP200) = 0, 'none';");
  expect(results[0].status).toBe("success");
  expect(shortcutCalls(calls)).toHaveLength(1);
});

test("B207: SET のスカラーサブクエリも同じ", async () => {
  const { calls, results } = await run("SET @n = (SELECT COUNT(*) FROM APP200);\nASSERT @n = 12, 'ng';");
  expect(results[1].status).toBe("success");
  expect(shortcutCalls(calls)).toHaveLength(1);
});

test("B207: CREATE TEMP TABLE … AS SELECT COUNT(*) も 1 回の GET", async () => {
  const { calls, results } = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\nSELECT n FROM #c;"
  );
  expect(results[0].status).toBe("success");
  expect(results[1].status).toBe("success");
  expect((results[1].result as { rows: Array<Record<string, string>> }).rows).toEqual([{ n: "12" }]);
  expect(shortcutCalls(calls)).toHaveLength(1);
});

test("B207: 依頼 KJ-11 の形（読む前に件数で止める）が通る", async () => {
  const { calls, results } = await run(
    "DECLARE @m_too_many = '';\n"
    + "ASSERT (SELECT COUNT(*) FROM APP200) <= 10, @m_too_many;\n"
    + "SELECT $id FROM APP200 WHERE 残数 < 3;"
  );
  // 12 件 > 10 件なので ASSERT で止まる（FetchAllLimitError ではなく AssertError）
  const assertResult = results.find((result) => result.type === "ASSERT");
  expect(assertResult?.status).toBe("error");
  expect((assertResult as { error?: { code?: string } }).error?.code).toBe("AssertError");
  // 数えるために全件を読んでいない
  expect(calls).toHaveLength(1);
  expect(shortcutCalls(calls)).toHaveLength(1);
});

test("B207: WHERE が押し下がる形も近道に入る", async () => {
  const { calls, results } = await run("ASSERT (SELECT COUNT(*) FROM APP200 WHERE 区分 = 'A') <= 100, 'ng';");
  expect(results[0].status).toBe("success");
  expect(shortcutCalls(calls)).toHaveLength(1);
});

test("B207: 判定の条件を外れる形は従来どおり全件（GROUP BY あり）", async () => {
  const { calls } = await run(
    "CREATE TEMP TABLE #g AS SELECT 区分, COUNT(*) AS n FROM APP200 GROUP BY 区分;\nSELECT n FROM #g;",
    1000
  );
  expect(shortcutCalls(calls)).toHaveLength(0);
});

test("B207: COUNT(列) は対象外（空のレコードを除くので totalCount と意味が違う）", async () => {
  const { calls } = await run("ASSERT (SELECT COUNT(区分) FROM APP200) <= 100, 'ng';", 1000);
  expect(shortcutCalls(calls)).toHaveLength(0);
});

test("B207: 一時テーブルを読む COUNT(*) は近道に入らない（物理アプリではない）", async () => {
  const { calls, results } = await run(
    "CREATE TEMP TABLE #r AS SELECT $id FROM APP200;\nASSERT (SELECT COUNT(*) FROM #r) = 12, 'ng';",
    1000
  );
  expect(results[1].status).toBe("success");
  expect(shortcutCalls(calls)).toHaveLength(0);
});

test("B207: 計画（COUNT_TOTAL_COUNT）と実行が一致する", async () => {
  const mock = mockClient();
  const sql = `${header}ASSERT (SELECT COUNT(*) FROM APP200) <= 100, 'ng';`;
  const plan = await explainScript(sql, { client: mock.value, maxRecords: 10 });
  const text = typeof plan === "string" ? plan : JSON.stringify(plan);
  expect(text).toContain("COUNT_TOTAL_COUNT");
  // 実行側も近道（= 計画の表示どおり）
  const { calls } = await run("ASSERT (SELECT COUNT(*) FROM APP200) <= 100, 'ng';");
  expect(shortcutCalls(calls)).toHaveLength(1);
});
