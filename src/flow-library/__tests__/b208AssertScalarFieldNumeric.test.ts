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
  { code: "受注日", label: "受注日", fieldType: "DATE", writable: true },
  { code: "区分", label: "区分", fieldType: "DROP_DOWN", writable: true, optionOrder: { A: 0, B: 1 } },
];

/** $id = 10 の行は 残数 = 9（9 <= 100 は数値なら真・辞書順なら偽） */
const rows = Array.from({ length: 12 }, (_, index) => ({
  $id: { type: "__ID__", value: String(index + 1) },
  残数: { type: "NUMBER", value: String(index) },
  文字: { type: "SINGLE_LINE_TEXT", value: String(index) },
  受注日: { type: "DATE", value: "2026-11-09" },
  区分: { type: "DROP_DOWN", value: index % 2 ? "A" : "B" },
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

// ============================================================
// B209（案 ア）: 変数の型を効かせ、数値と文字列の混在は止める
// ============================================================

async function runWith(sql: string, variables?: Record<string, string | string[]>) {
  const parsed = parseScript(`${header}${sql}`);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mockClient(), statements: parsed.statements, meta: parsed.meta, maxRecords: 1000,
    ...(variables ? { variables } : {}),
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
  return results;
}

test("B209: 数値リテラルで宣言した変数は数値として比べる（12 <= 10000 が成立）", async () => {
  const results = await runWith(
    "DECLARE @limit = 10000;\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';"
  );
  expect(lastStatus(results)).toBe("success");
});

test("B209: 同じ形で上限が小さければ止まる（12 <= 2 は不成立）", async () => {
  const results = await runWith(
    "DECLARE @limit = 2;\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';"
  );
  expect(lastStatus(results)).toBe("error");
  expect((results[results.length - 1] as { error?: { message: string } }).error?.message)
    .toContain("assertion failed");
});

test("B209: 注入した値も宣言の型で解釈する（文字列 \"10000\" が数値になる）", async () => {
  const results = await runWith(
    "DECLARE @limit = 1;\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';",
    { limit: "10000" }
  );
  expect(lastStatus(results)).toBe("success");
});

test("B209: 数値の宣言に数値でない値を注入したら、レコードを読む前に ArgumentError", async () => {
  await expect(runWith(
    "DECLARE @limit = 10000;\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';",
    { limit: "たくさん" }
  )).rejects.toThrow(/declared as a number/);
});

test("B209: 文字列で宣言した変数との大小比較は止める（辞書順に落とさない）", async () => {
  const results = await runWith(
    "DECLARE @limit = '2';\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';"
  );
  expect(lastStatus(results)).toBe("error");
  const message = (results[results.length - 1] as { error?: { message: string } }).error?.message ?? "";
  expect(message).toContain("数値と文字列を比べています");
  expect(message).toContain("DECLARE @limit = 10000");
});

test("B209: BETWEEN の混在も止める", async () => {
  const results = await runWith(
    "DECLARE @high = '100';\nASSERT (SELECT COUNT(*) FROM APP200) BETWEEN 0 AND @high, 'ng';"
  );
  expect(lastStatus(results)).toBe("error");
  expect((results[results.length - 1] as { error?: { message: string } }).error?.message)
    .toContain("数値と文字列を比べています");
});

test("B209: 等値は混在でも今までどおり（止めない）", async () => {
  const results = await runWith(
    "DECLARE @n = '12';\nASSERT (SELECT COUNT(*) FROM APP200) = @n, 'ng';"
  );
  expect(lastStatus(results)).toBe("success");
});

test("B209: 文字列どうしの辞書順は不変（ISO の日付）", async () => {
  const results = await runWith("ASSERT '2026-08-22' >= '2026-01-01', 'ng';");
  expect(lastStatus(results)).toBe("success");
});

test("B209: 空文字の比較は定義済みの規則のまま（WHERE と同じ −∞）", async () => {
  expect(lastStatus(await runWith("ASSERT '' < -1000000, 'ng';"))).toBe("success");
  expect(lastStatus(await runWith("ASSERT '' >= -1000000, 'ng';"))).toBe("error");
});

test("B209: WHERE の変数の置換は変わらない（押し下げの形を変えていない）", async () => {
  const calls: string[] = [];
  const base = mockClient() as unknown as { getRecords: (p: { query: string }) => Promise<unknown> };
  const original = base.getRecords.bind(base);
  const client = { ...base, async getRecords(params: { query: string }) { calls.push(params.query); return original(params); } };
  const parsed = parseScript(
    `${header}DECLARE @limit = 5;\nSELECT $id FROM APP200 WHERE 残数 > @limit;`
  );
  const context = createExecutionContext({
    client: client as never, statements: parsed.statements, meta: parsed.meta, maxRecords: 1000,
  });
  for (const statement of parsed.statements) await executeStatement(statement, context);
  await disposeExecutionContext(context);
  // 数値リテラルの宣言でも STRING ノードのまま置換する＝クエリの形は今までと同じ。
  // どんな形で送っているかをそのまま出して固定する（押し下げの有無が変わっていないこと）
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.join(" | ")).toMatchSnapshot("WHERE の変数の置換（B209 で変えていない）");
});

// ============================================================
// レビュー（Codex）が求めた負例と、システム列の扱い
// ============================================================

test("B208: $revision と $id は数値（engine 全体の systemColumnMeta と一貫）", async () => {
  // 依頼文で「$revision は文字列のシステム項目」と例示したのは誤りで、
  // systemColumnMeta は $revision も $id も number と宣言している（ORDER BY なども数値で扱う）
  expect(lastStatus(await run("ASSERT (SELECT $revision FROM APP200 WHERE $id = 10) <= 100, 'ng';"))).toBe("success");
  expect(lastStatus(await run("ASSERT (SELECT $id FROM APP200 WHERE $id = 10) <= 100, 'ng';"))).toBe("success");
});

test("B208: 日付の項目は文字列のまま（辞書順が正しい形）", async () => {
  // DATE / DATETIME は文字列なので、数値リテラルとの大小比較は混在エラー（B209）
  const results = await run("ASSERT (SELECT 受注日 FROM APP200 WHERE $id = 1) <= 20260101, 'ng';");
  expect(lastStatus(results)).toBe("error");
  expect((results[results.length - 1] as { error?: { message: string } }).error?.message)
    .toContain("数値と文字列を比べています");
});

test("B208: 選択肢の項目は数値に昇格しない", async () => {
  const results = await run("ASSERT (SELECT 区分 FROM APP200 WHERE $id = 1) <= 100, 'ng';");
  expect(lastStatus(results)).toBe("error");
  expect((results[results.length - 1] as { error?: { message: string } }).error?.message)
    .toContain("数値と文字列を比べています");
});

// ============================================================
// 2 回目のレビュー: 宣言の型の判定を算術・数値関数まで広げる（過剰停止を閉じる）
// ============================================================

test.each([
  ["算術式の宣言（12 <= 15）", "DECLARE @limit = 10 + 5;", "success"],
  ["算術式の宣言（12 <= 5 は不成立）", "DECLARE @limit = 2 + 3;", "error"],
  ["数値を返す関数の宣言（12 <= 15）", "DECLARE @limit = ABS(-15);", "success"],
] as const)("B209: %s", async (_label, declare, expected) => {
  const results = await runWith(`${declare}\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';`);
  expect(lastStatus(results)).toBe(expected);
  if (expected === "error") {
    // **混在のエラーではなく**、数値として比べた結果の不成立であること
    const message = (results[results.length - 1] as { error?: { message: string } }).error?.message ?? "";
    expect(message).toContain("assertion failed");
    expect(message).not.toContain("数値と文字列を比べています");
  }
});

test("B209: 算術式で宣言した変数への注入も十進で検証する（0x10 は弾く・1e3 は通す）", async () => {
  await expect(runWith(
    "DECLARE @limit = 10 + 5;\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';",
    { limit: "0x10" }
  )).rejects.toThrow(/declared as a number/);
  // 1e3（= 1000）は比較の十進パーサーが読めるので通し、数値として比べる
  expect(lastStatus(await runWith(
    "DECLARE @limit = 10 + 5;\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';",
    { limit: "1e3" }
  ))).toBe("success");
});

test("B209: 数値で宣言しても読めない値は数値と言わない（CONCAT で作った文字列）", async () => {
  // 宣言が文字列を返す関数なら印は付かず、混在の比較として止まる（辞書順に落とさない）
  const results = await runWith(
    "DECLARE @limit = CONCAT('1', '0');\nASSERT (SELECT COUNT(*) FROM APP200) <= @limit, 'ng';"
  );
  expect(lastStatus(results)).toBe("error");
  expect((results[results.length - 1] as { error?: { message: string } }).error?.message)
    .toContain("数値と文字列を比べています");
});

// ============================================================
// MINOR 1: システム列だけの SELECT では項目定義を取りに行かない
// ============================================================

async function runCountingGetFields(sql: string): Promise<{ status: string; getFields: number }> {
  let getFields = 0;
  const base = mockClient() as unknown as Record<string, unknown>;
  const client = {
    ...base,
    async getFields(...args: unknown[]) {
      getFields += 1;
      return (base.getFields as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as FlowKintoneClient;
  const parsed = parseScript(`${header}${sql}`);
  const context = createExecutionContext({
    client, statements: parsed.statements, meta: parsed.meta, maxRecords: 1000,
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
  return { status: results[results.length - 1].status, getFields };
}

test.each([
  ["$id だけ", "ASSERT (SELECT $id FROM APP200 WHERE $id = 10) <= 100, 'ng';", 0],
  ["$revision だけ", "ASSERT (SELECT $revision FROM APP200 WHERE $id = 10) <= 100, 'ng';", 0],
] as const)("B208: %s の ASSERT は項目定義を取りに行かない（getFields 0 回）", async (_label, sql, expected) => {
  const { status, getFields } = await runCountingGetFields(sql);
  expect(status).toBe("success");
  expect(getFields).toBe(expected);
});

test("B208: ふつうの項目の ASSERT は項目定義を 1 回だけ取る（キャッシュに乗る）", async () => {
  const { status, getFields } = await runCountingGetFields(
    "ASSERT (SELECT 残数 FROM APP200 WHERE $id = 10) <= 100, 'ng';\n"
    + "ASSERT (SELECT 残数 FROM APP200 WHERE $id = 11) <= 100, 'ng';"
  );
  expect(status).toBe("success");
  expect(getFields).toBe(1);
});

test("B208: 来歴の分からない一時テーブルの列は数値に昇格しない", async () => {
  // 文字列を連結した列（型が決まらない）を一時テーブルに入れて比べる
  const results = await run(
    "CREATE TEMP TABLE #m AS SELECT CONCAT('1', '2') AS mix FROM APP200 WHERE $id = 1;\n"
    + "ASSERT (SELECT mix FROM #m) <= 100, 'ng';"
  );
  expect(lastStatus(results)).toBe("error");
  expect((results[results.length - 1] as { error?: { message: string } }).error?.message)
    .toContain("数値と文字列を比べています");
});
