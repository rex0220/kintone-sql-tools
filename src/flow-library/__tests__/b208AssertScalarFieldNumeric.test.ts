import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowKintoneClient,
} from "../index";

/**
 * B208: `ASSERT` / `EXIT SUCCESS IF` のスカラーサブクエリが**項目を 1 つ返す形**のとき、
 * 数値の項目でも**辞書順**で比べていた（依頼 KJ-11 の ④）。
 *
 * B171 が直したのは**列の種類が集計・算術・ウィンドウ**のときだけで、
 * ふつうの項目の列（物理アプリの NUMBER・一時テーブルに入れた集計の結果）は文字列に落ちていた。
 * **`12 <= 2` が通る（fail-open）**ので、件数ゲートが素通りする。
 *
 * ここで固定するのは「**項目の型のメタデータ**で数値に昇格する」こと。
 * 値は見ない（B171 の「実値推測禁止」はそのまま）。
 */
const FIELDS = [
  { code: "残数", label: "残数", fieldType: "NUMBER", writable: true },
  { code: "文字", label: "文字", fieldType: "SINGLE_LINE_TEXT", writable: true },
];

/** $id = 10 の行は 残数 = 9（9 <= 100 は数値なら真・辞書順なら偽） */
const rows = Array.from({ length: 12 }, (_, index) => ({
  $id: { type: "__ID__", value: String(index + 1) },
  残数: { type: "NUMBER", value: String(index) },
  文字: { type: "SINGLE_LINE_TEXT", value: String(index) },
}));

function mockClient() {
  const value = {
    async getRecords(params: { query: string; totalCount?: boolean }) {
      const query = params.query ?? "";
      const id = /\$id = (\d+)/.exec(query);
      const hit = id ? rows.filter((row) => row.$id.value === id[1]) : rows;
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
  return value;
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string) {
  const parsed = parseScript(`${header}${sql}`);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mockClient(), statements: parsed.statements, meta: parsed.meta, maxRecords: 1000,
  });
  const results = [];
  try {
    for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  } finally {
    await disposeExecutionContext(context);
  }
  return results;
}

const lastStatus = (results: Array<{ status: string }>) => results[results.length - 1].status;

test.each([
  ["物理アプリの NUMBER 項目（9 <= 100）", "ASSERT (SELECT 残数 FROM APP200 WHERE $id = 10) <= 100, 'ng';", "success"],
  ["物理アプリの NUMBER 項目（9 <= 2 は不成立）", "ASSERT (SELECT 残数 FROM APP200 WHERE $id = 10) <= 2, 'ng';", "error"],
  ["$id（10 <= 100）", "ASSERT (SELECT $id FROM APP200 WHERE $id = 10) <= 100, 'ng';", "success"],
] as const)("B208: %s", async (_label, sql, expected) => {
  expect(lastStatus(await run(sql))).toBe(expected);
});

test("B208: 一時テーブルに入れた COUNT(*) の列も数値で比べる（12 <= 100 が成立）", async () => {
  const results = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\nASSERT (SELECT n FROM #c) <= 100, 'ng';"
  );
  expect(lastStatus(results)).toBe("success");
});

test("B208（fail-open を閉じる）: 一時テーブルの COUNT(*) が 12 のとき <= 2 は不成立", async () => {
  const results = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\nASSERT (SELECT n FROM #c) <= 2, 'ng';"
  );
  expect(lastStatus(results)).toBe("error");
  expect((results[results.length - 1] as { error?: { message: string } }).error?.message)
    .toContain("assertion failed");
});

test("B208: 一時テーブルに写した NUMBER 項目も数値で比べる", async () => {
  const results = await run(
    "CREATE TEMP TABLE #r AS SELECT 残数 FROM APP200 WHERE $id = 10;\nASSERT (SELECT 残数 FROM #r) <= 100, 'ng';"
  );
  expect(lastStatus(results)).toBe("success");
});

test("B208: 文字列の項目は文字列のまま比べる（既存の規則を変えない）", async () => {
  // "9" <= "100" は辞書順で偽。項目が SINGLE_LINE_TEXT なら数値に昇格しない
  const results = await run("ASSERT (SELECT 文字 FROM APP200 WHERE $id = 10) <= 100, 'ng';");
  expect(lastStatus(results)).toBe("error");
});

test("B208: EXIT SUCCESS IF も同じ（12 = 12 で終了する）", async () => {
  const results = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\n"
    + "EXIT SUCCESS IF (SELECT n FROM #c) = 12, 'done';\nASSERT 1 = 2, 'ng';"
  );
  expect(results[1].status).toBe("success");
  // EXIT で終了するので 3 文目は実行されない（skipped で返る）
  expect(results[2].status).toBe("skipped");
  expect((results[2] as { skippedReason?: string }).skippedReason).toBe("exit");
});

test("B208: BETWEEN も桁違いの上限を数値で比べる", async () => {
  const results = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\n"
    + "ASSERT (SELECT n FROM #c) BETWEEN 0 AND 10000, 'ng';"
  );
  expect(lastStatus(results)).toBe("success");
});

test("B208: ASSERT WARN も同じ判定（12 <= 2 は警告になる）", async () => {
  const results = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\n"
    + "ASSERT WARN (SELECT n FROM #c) <= 2, 'warn';\nSELECT 1 AS x;"
  );
  expect(lastStatus(results)).toBe("success");
  const warn = results[1] as { result?: { warning?: string }; warnings?: string[] };
  expect(JSON.stringify(warn)).toContain("warn");
});

test("B208: SET のスカラーサブクエリも同じヘルパーを通る（数値として入る）", async () => {
  const results = await run(
    "CREATE TEMP TABLE #c AS SELECT COUNT(*) AS n FROM APP200;\n"
    + "SET @cnt = (SELECT n FROM #c);\nASSERT @cnt <= 100, 'ng';"
  );
  expect(lastStatus(results)).toBe("success");
});
