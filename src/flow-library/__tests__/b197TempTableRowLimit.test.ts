import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowKintoneClient,
} from "../index";

/**
 * B197 / 依頼 KJ-11 の ②: `tempTableMaxRows` を**読む量**の上限から
 * **出来た表の行数**の上限に変える。
 *
 * v3.92.0 までは `CREATE TEMP TABLE … AS SELECT` の読み取りの `maxRecords` に差し替えていたため、
 *
 * 1. 集計して 1 行しか残さない文でも**読んだ件数**で止まった（依頼元の主な困りごと）
 * 2. 止めた上限と違う名前（`maxRecords`）で案内した
 * 3. JOIN・UNION・CTE・`GENERATE_SERIES` で**出来た表が上限を超えても通った**（資料の約束が効かない）
 *
 * 読む量の上限は `maxRecords`。ただし **`tempTableMaxRows` のほうが大きいときはその値まで読む**
 * （MCP は `maxRecords` の既定が 500 で、`tempTableMaxRows` だけ上げて大きい表を作る使い方が公開の契約）。
 */
const FIELDS = [
  { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "v", label: "v", fieldType: "NUMBER", writable: true },
];

function mockClient(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    $id: { type: "__ID__", value: String(index + 1) },
    k: { type: "SINGLE_LINE_TEXT", value: index % 2 ? "A" : "B" },
    v: { type: "NUMBER", value: String(index) },
  }));
  let readRows = 0;
  const value = {
    async getRecords(params: { query: string; totalCount?: boolean }) {
      const query = params.query ?? "";
      const offset = Number(/offset (\d+)/.exec(query)?.[1] ?? 0);
      const limit = /limit (\d+)/.exec(query)?.[1];
      // 押し下げた `v < N` だけ真似る（JOIN の試験で元の表を小さくするため）
      const lt = /v < (\d+)/.exec(query);
      const hit = lt ? rows.filter((row) => Number(row.v.value) < Number(lt[1])) : rows;
      const page = hit.slice(offset, limit === undefined ? undefined : offset + Number(limit));
      readRows += page.length;
      return params.totalCount === true
        ? { records: page, totalCount: String(hit.length) }
        : { records: page };
    },
    async openCursor() {
      let sent = false;
      return {
        totalCount: rows.length,
        async nextPage() { const records = sent ? [] : rows; sent = true; return { records, next: false }; },
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
  return { value, readRows: () => readRows };
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string, options: Record<string, unknown>, count = 12) {
  const mock = mockClient(count);
  const parsed = parseScript(`${header}${sql}`);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, ...options,
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

test("B197: 集計して 1 行しか残さない文は、読む量が maxRecords 以内なら通る（KJ-11 の M）", async () => {
  // v3.92.0 では tempTableMaxRows: 5 が読取の上限になって 12 件目で止まっていた
  const { results } = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\nSELECT n FROM #c;",
    { maxRecords: 100, tempTableMaxRows: 5 }
  );
  expect(results[0].status).toBe("success");
  expect((results[1].result as { rows: Array<Record<string, string>> }).rows).toEqual([{ n: "12" }]);
});

test("B197: GROUP BY で 2 行に畳む文も、読む量が収まれば通る", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #g AS SELECT k, COUNT(*) AS n FROM APP200 GROUP BY k;\nSELECT COUNT(*) AS c FROM #g;",
    { maxRecords: 100, tempTableMaxRows: 5 }
  );
  expect(results[0]).toMatchObject({ status: "success", rowCount: 2 });
});

test("B197: 出来た表の行数が上限を超えたら TempTableRowLimitError（登録しない）", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #r AS SELECT k, v FROM APP200;\nSELECT COUNT(*) AS c FROM #r;",
    { maxRecords: 100, tempTableMaxRows: 5 }
  );
  expect(results[0]).toMatchObject({ status: "error", error: { code: "TempTableRowLimitError" } });
  expect(results[0].error?.message).toContain("12 行");
  expect(results[0].error?.message).toContain("tempTableMaxRows");
});

test("B197: JOIN で増えた行も上限で止める（v3.92.0 では通っていた穴）", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #s AS SELECT k FROM APP200 WHERE v < 3;\n"
    + "CREATE TEMP TABLE #j AS SELECT a.k FROM #s a CROSS JOIN #s b;\nSELECT COUNT(*) AS c FROM #j;",
    { maxRecords: 100, tempTableMaxRows: 5 }
  );
  expect(results[0].status).toBe("success");
  // 3 行 × 3 行 = 9 行 > 5 行
  expect(results[1]).toMatchObject({ status: "error", error: { code: "TempTableRowLimitError" } });
  expect(results[1].error?.message).toContain("9 行");
});

test("B197: GENERATE_SERIES で増えた行も上限で止める（レコードを 1 件も読まない形）", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #n AS WITH s AS (GENERATE_SERIES(1, 20) AS n) SELECT n FROM s;\n"
    + "SELECT COUNT(*) AS c FROM #n;",
    { maxRecords: 100, tempTableMaxRows: 5 }
  );
  expect(results[0]).toMatchObject({ status: "error", error: { code: "TempTableRowLimitError" } });
  expect(results[0].error?.message).toContain("20 行");
});

test("B197: 読む量が maxRecords で止まったら、maxRecords の名前で案内する", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #r AS SELECT k, v FROM APP200;\nSELECT COUNT(*) AS c FROM #r;",
    { maxRecords: 5, tempTableMaxRows: 5 }
  );
  expect(results[0]).toMatchObject({ status: "error", error: { code: "FetchAllLimitError" } });
  expect(results[0].error?.message).toContain("maxRecords");
});

test("B197: tempTableMaxRows のほうが大きいときはそこまで読み、その名前で案内する", async () => {
  const { results, readRows } = await run(
    "CREATE TEMP TABLE #r AS SELECT k, v FROM APP200;\nSELECT COUNT(*) AS c FROM #r;",
    { maxRecords: 3, tempTableMaxRows: 8 }
  );
  // 読む量の上限は max(3, 8) = 8 行＝8 行まで読んで止まる
  expect(results[0]).toMatchObject({ status: "error", error: { code: "TempTableRowLimitError" } });
  expect(results[0].error?.message).toContain("8 行・tempTableMaxRows");
  expect(results[0].error?.message).toContain("maxRecords は 3 行");
  expect(readRows()).toBeLessThanOrEqual(12);
});

test("B197: tempTableMaxRows だけ上げれば大きい表が作れる（MCP の公開の契約と同じ使い方）", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #r AS SELECT k, v FROM APP200;\nSELECT COUNT(*) AS c FROM #r;",
    { maxRecords: 5, tempTableMaxRows: 20 }
  );
  expect(results[0]).toMatchObject({ status: "success", rowCount: 12 });
  expect((results[1].result as { rows: Array<Record<string, string>> }).rows).toEqual([{ c: "12" }]);
});

test("B197: 上限ちょうどの行数は通る", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #r AS SELECT k, v FROM APP200;\nSELECT COUNT(*) AS c FROM #r;",
    { maxRecords: 100, tempTableMaxRows: 12 }
  );
  expect(results[0]).toMatchObject({ status: "success", rowCount: 12 });
});
