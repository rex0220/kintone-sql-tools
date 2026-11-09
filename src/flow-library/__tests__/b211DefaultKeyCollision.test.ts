import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowKintoneClient,
} from "../index";

/**
 * B211: 別名の無い関数の列は、中の CASE を "case" と略した既定の名前になる（`CAST(case,'NUMBER')`）。
 * 中身の違う 2 列が同じ名前になり、行のオブジェクトで後の列が前の列を上書きして黙って消えていた。
 * 再帰 CTE の列名リストで受けると、2 列とも 2 列目の値になった。
 *
 * 直したこと（案 B ＋ 再帰 CTE を位置で受ける）:
 * - 中身の違う式が同じ既定の名前になったら、2 つ目から番号を付ける（`CAST(case,'NUMBER')_2`）
 * - 重なっていない列・中身が同じ式どうし（値も同じ）の名前は変えない
 * - 再帰 CTE は、列名リストの名前を位置どおり別名として付けてから seed と再帰項を実行する
 *
 * x は NUMBER で 1 と 5 の 2 行。`x > 2` は 1 の行で偽、5 の行で真。
 */
const FIELDS = [
  { code: "x", label: "x", fieldType: "NUMBER", writable: true },
  { code: "番号", label: "番号", fieldType: "NUMBER", writable: true },
];
const rows = [1, 5].map((value, index) => ({
  $id: { type: "__ID__", value: String(index + 1) },
  x: { type: "NUMBER", value: String(value) },
  番号: { type: "NUMBER", value: String(index + 1) },
}));

function mockClient() {
  return {
    async getRecords(params: { query: string; totalCount?: boolean }) {
      return params.totalCount === true ? { records: rows, totalCount: String(rows.length) } : { records: rows };
    },
    async openCursor() {
      let sent = false;
      return {
        totalCount: rows.length,
        async nextPage() { const records = sent ? [] : rows; sent = true; return { records, next: false }; },
        async close() {},
      };
    },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return FIELDS; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
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
  const last = results[results.length - 1] as {
    status: string; error?: { message: string };
    result?: { rows?: Array<Record<string, string>>; columns?: string[] };
  };
  if (last.status !== "success") throw new Error(`${last.status}: ${last.error?.message ?? ""}`);
  return { rows: last.result?.rows ?? [], columns: last.result?.columns ?? [] };
}

const CAST_A = "CAST(CASE WHEN x > 2 THEN 1 ELSE 0 END AS NUMBER)";
const CAST_B = "CAST(CASE WHEN x > 2 THEN 10 ELSE 20 END AS NUMBER)";

describe("B211: 中身の違う式が同じ既定の名前になったら、2 つ目から番号を付ける", () => {
  test("CAST(CASE …) を 2 列（どちらも消えない）", async () => {
    const result = await run(`SELECT ${CAST_A}, ${CAST_B} FROM APP200`);
    expect(result.columns).toEqual(["CAST(case,'NUMBER')", "CAST(case,'NUMBER')_2"]);
    expect(result.rows).toEqual([
      { "CAST(case,'NUMBER')": "0", "CAST(case,'NUMBER')_2": "20" },
      { "CAST(case,'NUMBER')": "1", "CAST(case,'NUMBER')_2": "10" },
    ]);
  });

  test("3 列なら _2・_3", async () => {
    const result = await run(
      `SELECT ${CAST_A}, ${CAST_B}, CAST(CASE WHEN x > 2 THEN 100 ELSE 200 END AS NUMBER) FROM APP200`
    );
    expect(result.columns).toEqual(["CAST(case,'NUMBER')", "CAST(case,'NUMBER')_2", "CAST(case,'NUMBER')_3"]);
    expect(result.rows[0]).toEqual({ "CAST(case,'NUMBER')": "0", "CAST(case,'NUMBER')_2": "20", "CAST(case,'NUMBER')_3": "200" });
  });

  test("COALESCE(CASE …) と、算術の中の関数", async () => {
    const coalesce = await run(
      "SELECT COALESCE(CASE WHEN x > 2 THEN 1 ELSE 0 END, 9), COALESCE(CASE WHEN x > 2 THEN 10 ELSE 20 END, 9) FROM APP200"
    );
    expect(coalesce.rows[0]).toEqual({ "COALESCE(case,9)": "0", "COALESCE(case,9)_2": "20" });
    const arith = await run(
      "SELECT 0 + ROUND(CASE WHEN x > 2 THEN 1 ELSE 0 END, 0), 0 + ROUND(CASE WHEN x > 2 THEN 10 ELSE 20 END, 0) FROM APP200"
    );
    expect(Object.values(arith.rows[0])).toEqual(["0", "20"]);
  });

  test("集計を含む式の列（GROUP BY あり）も消えない", async () => {
    const result = await run(
      "SELECT 番号, CONCAT('', CASE WHEN x > 2 THEN COUNT(*) ELSE 0 END), CONCAT('', CASE WHEN x > 2 THEN 0 ELSE COUNT(*) END) "
      + "FROM APP200 GROUP BY 番号, x ORDER BY 番号"
    );
    expect(result.rows.map((row) => Object.values(row))).toEqual([["1", "0", "1"], ["2", "1", "0"]]);
  });

  test("ワイルドカードと一緒でも消えない", async () => {
    const result = await run(`SELECT *, ${CAST_A}, ${CAST_B} FROM APP200`);
    expect(result.rows[0]["CAST(case,'NUMBER')"]).toBe("0");
    expect(result.rows[0]["CAST(case,'NUMBER')_2"]).toBe("20");
  });

  test("一時テーブルに入れても 2 列とも残る", async () => {
    const result = await run(
      `CREATE TEMP TABLE #t AS SELECT ${CAST_A}, ${CAST_B} FROM APP200;\n`
      + "SELECT * FROM #t"
    );
    expect(result.columns).toEqual(["CAST(case,'NUMBER')", "CAST(case,'NUMBER')_2"]);
    expect(result.rows).toEqual([
      { "CAST(case,'NUMBER')": "0", "CAST(case,'NUMBER')_2": "20" },
      { "CAST(case,'NUMBER')": "1", "CAST(case,'NUMBER')_2": "10" },
    ]);
  });

  test("UNION ALL の枝でも消えない（位置で合わせる）", async () => {
    const result = await run(`SELECT ${CAST_A}, ${CAST_B} FROM APP200 UNION ALL SELECT 7 AS a, 8 AS b`);
    expect(result.rows.map((row) => Object.values(row))).toEqual([["0", "20"], ["1", "10"], ["7", "8"]]);
  });
});

describe("B211: 再帰 CTE は列名リストを位置で受ける", () => {
  test("列名リストで受けた 2 つの CAST(CASE …) が、それぞれの値になる", async () => {
    const result = await run(
      "WITH RECURSIVE r (n, a, b) AS ("
      + `SELECT 番号, ${CAST_A}, ${CAST_B} FROM APP200 WHERE 番号 = 1 `
      + "UNION ALL "
      + "SELECT s.番号, CAST(CASE WHEN s.x > 2 THEN 1 ELSE 0 END AS NUMBER), CAST(CASE WHEN s.x > 2 THEN 10 ELSE 20 END AS NUMBER) "
      + "FROM r AS e INNER JOIN APP200 AS s ON s.番号 = e.n WHERE s.番号 = 2"
      + ") SELECT n, a, b FROM r"
    );
    // 番号 1（x = 1）は a 0・b 20。再帰項は e.n = 1 に s.番号 = 1 で当たるが WHERE s.番号 = 2 で落ちるので 1 行
    expect(result.rows).toEqual([{ n: "1", a: "0", b: "20" }]);
  });

  test("同じ式を 2 回でも、列名リストのそれぞれに入る", async () => {
    const result = await run(
      "WITH RECURSIVE r (n, a, b) AS ("
      + "SELECT 番号, ROUND(x), ROUND(x) FROM APP200 WHERE 番号 = 1 "
      + "UNION ALL SELECT s.番号, ROUND(s.x), ROUND(s.x) FROM r AS e INNER JOIN APP200 AS s ON s.番号 = e.n WHERE s.番号 = 2"
      + ") SELECT n, a, b FROM r"
    );
    expect(result.rows).toEqual([{ n: "1", a: "1", b: "1" }]);
  });

  test("書いた別名が重なって中身が違うときは、実行の前に止める（どちらの値か決められない）", async () => {
    await expect(run(
      "WITH RECURSIVE r (n, a, b) AS ("
      + `SELECT 番号, ${CAST_A} AS v, ${CAST_B} AS v FROM APP200 WHERE 番号 = 1 `
      + "UNION ALL SELECT s.番号, 1 AS v, 2 AS w FROM r AS e INNER JOIN APP200 AS s ON s.番号 = e.n WHERE s.番号 = 2"
      + ") SELECT n, a, b FROM r"
    )).rejects.toThrow(/別名/);
  });
});

describe("B211: 変えないこと", () => {
  test("重なっていない列の名前は変えない", async () => {
    const result = await run(`SELECT ${CAST_A} FROM APP200`);
    expect(result.columns).toEqual(["CAST(case,'NUMBER')"]);
  });

  test("中身が同じ式どうしは、今までどおり同じ名前（値も同じ）", async () => {
    const result = await run("SELECT ROUND(x), ROUND(x) FROM APP200");
    expect(result.columns).toEqual(["ROUND(x)", "ROUND(x)"]);
    expect(result.rows).toEqual([{ "ROUND(x)": "1" }, { "ROUND(x)": "5" }]);
  });

  test("列そのものの CASE は今までどおり case・case_2", async () => {
    const result = await run("SELECT CASE WHEN x > 2 THEN 1 ELSE 0 END, CASE WHEN x > 2 THEN 10 ELSE 20 END FROM APP200");
    expect(result.columns).toEqual(["case", "case_2"]);
  });

  test("別名を付けた列は今までどおり", async () => {
    const result = await run(`SELECT ${CAST_A} AS a, ${CAST_B} AS b FROM APP200`);
    expect(result.rows).toEqual([{ a: "0", b: "20" }, { a: "1", b: "10" }]);
  });
});
