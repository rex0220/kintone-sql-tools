import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type CreateExecutionContextOptions,
  type FlowKintoneClient,
  type StatementResult,
} from "../index";

type Rec = Record<string, { value: string }>;

function records(count: number, firstId: number, key: (index: number) => string): Rec[] {
  return Array.from({ length: count }, (_, index) => ({
    $id: { value: String(firstId + index) },
    k: { value: key(index) },
    v: { value: "1" },
  }));
}

/**
 * APP1・APP2 = 19,999 件（ちょうど 20,000 件だと、最後のページが満杯のため今の fetchAll は続きを確かめずに上限超えとする）、
 * APP3 = 10 件（k は 2 種類）、APP4 = 4 件。APP9 は書込先（n は数値）。
 */
function mockClient() {
  const data = new Map<number, Rec[]>([
    [1, records(19_999, 1, (index) => `A${index}`)],
    [2, records(19_999, 100_001, (index) => `B${index}`)],
    [3, records(10, 200_001, (index) => `x${index % 2}`)],
    [4, records(4, 300_001, (index) => `D${index}`)],
  ]);
  const readRows = new Map<number, number>();
  const read = (app: number, rows: Rec[]) => {
    readRows.set(app, (readRows.get(app) ?? 0) + rows.length);
    return rows;
  };
  const select = (app: number, query: string): Rec[] => {
    let rows = data.get(app) ?? [];
    const after = query.match(/\$id\s*>\s*"?(\d+)"?/);
    if (after) rows = rows.filter((row) => Number(row.$id.value) > Number(after[1]));
    return rows;
  };
  const page = (app: number, query: string): Rec[] => {
    const offset = Number(query.match(/offset\s+(\d+)/i)?.[1] ?? 0);
    const limit = Number(query.match(/limit\s+(\d+)/i)?.[1] ?? 500);
    return select(app, query).slice(offset, offset + limit);
  };
  const postRecords = jest.fn(async ({ records: rows }: { app: number; records: unknown[] }) => ({
    ids: rows.map((_, index) => String(index + 1)),
  }));
  const putRecords = jest.fn(async (_params: unknown) => undefined);
  const deleteRecords = jest.fn(async (_params: unknown) => undefined);
  const value = {
    async getRecords(params: { app: number; query: string; totalCount?: boolean }) {
      const rows = read(params.app, page(params.app, params.query));
      return params.totalCount ? { records: rows, totalCount: String(select(params.app, params.query).length) } : { records: rows };
    },
    async openCursor(params: { app: number; query: string }) {
      const all = select(params.app, params.query);
      let offset = 0;
      return {
        totalCount: all.length,
        async nextPage() {
          const rows = read(params.app, all.slice(offset, offset + 500));
          offset += 500;
          return { records: rows, next: offset < all.length };
        },
        async close() {},
      };
    },
    postRecords,
    putRecords,
    deleteRecords,
    async getApps() { return []; },
    async getFields(appId: number) {
      return appId === 9
        ? [{ code: "n", label: "n", fieldType: "NUMBER" }]
        : [
            { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" },
            { code: "v", label: "v", fieldType: "NUMBER" },
          ];
    },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
  const writes = () => postRecords.mock.calls.length + putRecords.mock.calls.length + deleteRecords.mock.calls.length;
  return { value, readRows, writes };
}

async function run(
  sql: string,
  options: Partial<CreateExecutionContextOptions>,
  mock = mockClient()
): Promise<{ results: StatementResult[]; mock: ReturnType<typeof mockClient> }> {
  const parsed = parseScript(sql);
  const context = createExecutionContext({ client: mock.value, statements: parsed.statements, meta: parsed.meta, ...options });
  const results: StatementResult[] = [];
  for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  await disposeExecutionContext(context);
  return { results, mock };
}

test("AC1 合計の残りを超える CREATE TEMP TABLE は読取の途中で止まり、表を登録せず TempTableTotalLimitError", async () => {
  const { results, mock } = await run(
    "CREATE TEMP TABLE #a AS SELECT k, v FROM APP1; CREATE TEMP TABLE #b AS SELECT k, v FROM APP2; SELECT COUNT(*) AS c FROM #a",
    { tempTablesMaxTotalRows: 30_000, tempTableMaxRows: 20_000 }
  );
  expect(results[0]).toMatchObject({ status: "success", rowCount: 19_999, metrics: { tempTableRows: 19_999 } });
  expect(results[1]).toMatchObject({
    status: "error",
    error: { code: "TempTableTotalLimitError" },
    metrics: { tempTableRows: 19_999 },
  });
  expect(results[1].error?.message).toContain("残り（10001 行・上限 30000 行）");
  expect(mock.readRows.get(2) ?? 0).toBeLessThanOrEqual(10_500);
  expect(results[2]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
  expect(mock.writes()).toBe(0);
});

test("AC2 1 つ目の表を DROP TEMP TABLE で外すと、同じ 2 つ目の文は成功する", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #a AS SELECT k, v FROM APP1; DROP TEMP TABLE #a; CREATE TEMP TABLE #b AS SELECT k, v FROM APP2; SELECT COUNT(*) AS c FROM #b",
    { tempTablesMaxTotalRows: 30_000, tempTableMaxRows: 20_000 }
  );
  expect(results.map((result) => result.status)).toEqual(["success", "success", "success", "success"]);
  expect(results[1].metrics.tempTableRows).toBe(0);
  expect(results[2]).toMatchObject({ rowCount: 19_999, metrics: { tempTableRows: 19_999 } });
});

test("AC3 VALIDATE … INTO のエラー表への追加で合計を超えると、追加せずにエラー", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #s AS SELECT k FROM APP4; VALIDATE APP3 (v) CHECK WHEN v > 0 THEN 'bad' INTO #err; SELECT * FROM #err",
    { tempTablesMaxTotalRows: 10 }
  );
  expect(results[0]).toMatchObject({ status: "success", metrics: { tempTableRows: 4 } });
  expect(results[1]).toMatchObject({ status: "error", error: { code: "TempTableTotalLimitError" }, metrics: { tempTableRows: 4 } });
  expect(results[2]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
});

test("AC3・AC4 ON ERROR SKIP … INTO のエラー表への追加で合計を超えると、追加せず書込 0 回・後続は fail-fast", async () => {
  const { results, mock } = await run(
    "CREATE TEMP TABLE #src AS SELECT k FROM APP3; INSERT INTO APP9 (n) SELECT k FROM #src ON ERROR SKIP INTO #err; SELECT * FROM #err",
    { tempTablesMaxTotalRows: 15 }
  );
  expect(results[0]).toMatchObject({ status: "success", metrics: { tempTableRows: 10 } });
  expect(results[1]).toMatchObject({ status: "error", error: { code: "TempTableTotalLimitError" }, metrics: { tempTableRows: 10 } });
  expect(results[2]).toMatchObject({ status: "skipped", skippedReason: "fail-fast" });
  expect(mock.writes()).toBe(0);
});

test("上限の内側ならエラー表へ足せて、tempTableRows に入る", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #src AS SELECT k FROM APP3; INSERT INTO APP9 (n) SELECT k FROM #src ON ERROR SKIP INTO #err; SELECT * FROM #err",
    { tempTablesMaxTotalRows: 20 }
  );
  expect(results[1]).toMatchObject({ status: "success", metrics: { tempTableRows: 20 } });
  expect(results[2]).toMatchObject({ status: "success" });
});

test.each([
  ["CROSS JOIN（別の一時テーブル 4×4）", "CREATE TEMP TABLE #s AS SELECT k FROM APP4; CREATE TEMP TABLE #t AS SELECT a.k FROM #s a CROSS JOIN #s b; SELECT 1 AS x", 1, 4],
  ["UNION ALL（別の一時テーブル 4＋4）", "CREATE TEMP TABLE #s AS SELECT k FROM APP4; CREATE TEMP TABLE #t AS SELECT k FROM #s UNION ALL SELECT k FROM #s; SELECT 1 AS x", 1, 4],
  ["GENERATE_SERIES（読取 0 回で 100 行）", "CREATE TEMP TABLE #t AS WITH s AS (GENERATE_SERIES(1, 100)) SELECT generate_series FROM s; SELECT 1 AS x", 0, 0],
  ["INNER JOIN（重複キー 4×4）", "CREATE TEMP TABLE #t AS SELECT a.k FROM APP4 a JOIN APP4 b ON a.v = b.v; SELECT 1 AS x", 0, 0],
])("読取で止まらない経路（%s）も、登録の前に出来た行数で止める", async (_label, sql, failedIndex, rowsBefore) => {
  const { results } = await run(sql, { tempTablesMaxTotalRows: 10 });
  expect(results[failedIndex]).toMatchObject({
    status: "error",
    error: { code: "TempTableTotalLimitError" },
    metrics: { tempTableRows: rowsBefore },
  });
});

test.each([
  ["CTE の読取", "CREATE TEMP TABLE #t AS WITH c AS (SELECT k FROM APP3) SELECT k FROM c; SELECT 1 AS x"],
  ["UNION の枝の読取", "CREATE TEMP TABLE #t AS SELECT k FROM APP4 UNION ALL SELECT k FROM APP3; SELECT 1 AS x"],
  ["再帰 CTE の起点の読取", "CREATE TEMP TABLE #t AS WITH RECURSIVE r(k,d) AS (SELECT k,1 FROM APP3 UNION ALL SELECT s.k,r.d+1 FROM APP4 s JOIN r ON s.k = r.k WHERE r.d < 2) SELECT k FROM r; SELECT 1 AS x"],
  ["JOIN の右側の読取", "CREATE TEMP TABLE #t AS SELECT a.k FROM APP4 a LEFT JOIN APP3 b ON a.k = b.k; SELECT 1 AS x"],
])("%s も、合計の残りを超えたところで読取の途中で止まる", async (_label, sql) => {
  const { results } = await run(sql, { tempTablesMaxTotalRows: 5 });
  expect(results[0]).toMatchObject({ status: "error", error: { code: "TempTableTotalLimitError" }, metrics: { tempTableRows: 0 } });
  expect(results[0].error?.message).toContain("を超える読取のため");
});

test("集計も読む行数で数える: 10 件を読む GROUP BY（出来るのは 2 行）は、残り 5 行なら止まる", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #g AS SELECT k, COUNT(*) AS c FROM APP3 GROUP BY k; SELECT 1 AS x",
    { tempTablesMaxTotalRows: 5 }
  );
  expect(results[0]).toMatchObject({ status: "error", error: { code: "TempTableTotalLimitError" } });
});

test("1 表の上限のほうが厳しいときは、今と同じ FetchAllLimitError（読み替えない）", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #t AS SELECT k FROM APP3; SELECT 1 AS x",
    { tempTablesMaxTotalRows: 1_000, tempTableMaxRows: 5 }
  );
  expect(results[0]).toMatchObject({ status: "error", error: { code: "FetchAllLimitError" } });
});

test("AC5 省略すれば合計の上限なし（今と同じ）。tempTableRows は常に出る", async () => {
  const { results } = await run(
    "CREATE TEMP TABLE #s AS SELECT k FROM APP4; CREATE TEMP TABLE #t AS SELECT a.k FROM #s a CROSS JOIN #s b; SELECT 1 AS x",
    {}
  );
  expect(results[1]).toMatchObject({ status: "success", rowCount: 16, metrics: { tempTableRows: 20 } });
  expect(results[2].metrics.tempTableRows).toBe(20);
});

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "tempTablesMaxTotalRows=%p は createExecutionContext で RangeError",
  (value) => {
    const parsed = parseScript("CREATE TEMP TABLE #s AS SELECT k FROM APP4; SELECT 1 AS x");
    expect(() => createExecutionContext({
      client: mockClient().value, statements: parsed.statements, meta: parsed.meta, tempTablesMaxTotalRows: value,
    })).toThrow(expect.objectContaining({ code: "RangeError" }));
  }
);
