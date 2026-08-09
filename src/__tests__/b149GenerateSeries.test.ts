import type { KintoneRecord } from "../converter/dmlToKintone";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  execute,
  executeBatch,
  getSelectColumnMeta,
  type BatchExecuteResult,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import { createKsqlMcpTools } from "../mcp/tools";
import { parseSqlStatement } from "../core/sql";
import { KSQL_DOCS } from "../mcp/docsResources";
import { explainInputSchema, queryInputSchema, saveQueryInputSchema, validateInputSchema } from "../mcp/schemas";
import { STATEMENT_SYNTAX_CATALOG } from "../mcp/statementSyntaxCatalog";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

type CountingClient = KintoneClient & { calls: Record<string, number> };

function client(recordsByApp: Record<number, KintoneRecord[]> = {}): CountingClient {
  const calls: Record<string, number> = {};
  const count = (name: string): void => { calls[name] = (calls[name] ?? 0) + 1; };
  return {
    calls,
    async getRecords(params) {
      count("records");
      const rows = recordsByApp[params.app] ?? [];
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: rows.slice(offset, offset + limit) };
    },
    async openCursor() { count("cursor"); throw new Error("unexpected cursor"); },
    async postRecords() { count("post"); return { ids: [] }; },
    async putRecords() { count("put"); },
    async deleteRecords() { count("delete"); },
    async getApps() { count("apps"); return []; },
    async getFields(appId) {
      count("fields");
      const codes = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...codes].filter((code) => !code.startsWith("$")).map((code) => ({
        code,
        label: code,
        fieldType: code === "金額" || code === "系列キー" ? "NUMBER" : "DATE",
      }));
    },
    async getProcessStatuses() { count("statuses"); return { enable: false, states: [] }; },
    async getNumberPrecision() {
      count("precision");
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

async function run(sql: string, mock = client(), captureColumnMeta = false): Promise<SelectResult> {
  return await execute(sql, mock, {
    captureColumnMeta,
    cacheContext: `b149-${Math.random()}`,
  }) as SelectResult;
}

function values(result: SelectResult, column = result.columns[0]): string[] {
  return result.rows.map((row) => row[column] ?? "");
}

async function errorFor(sql: string, mock = client()): Promise<Error> {
  try { await run(sql, mock); } catch (error) { return error as Error; }
  throw new Error("expected rejection");
}

const DERIVED_ORDER_ADVICE = "ウィンドウの各パーティション内で、ORDER BY の値の組が入力行を一意に識別するとクエリ構造または保証済みのデータ制約から確認できる場合に限り、この警告は無視できます。元の集約キーをすべて ORDER BY に含む形や、JOIN 後も同じ系列値が各パーティション内で高々1行と保証できる形が該当します。生成列、再帰の深さ列、または $id に由来する列であるという理由だけでは無視できません。";
const LAG_WARNING = `前 の ORDER BY は全順序でないため、同順内の前後関係は未規定です。${DERIVED_ORDER_ADVICE}`;
const RANGE_WARNING = `累計 は既定フレーム（RANGE）で評価されます。ORDER BY の値が同じ行はすべて同じ値になります。行ごとの値が必要なら ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示するか、${DERIVED_ORDER_ADVICE}`;

describe("B149 GENERATE_SERIES", () => {
  test("A1: 既定 step、stop 包含、公開結果、API 0回", async () => {
    const mock = client();
    const result = await run("WITH s AS (GENERATE_SERIES(1, 5)) SELECT generate_series FROM s ORDER BY generate_series", mock);
    expect(result).toMatchObject({
      type: "SELECT",
      columns: ["generate_series"],
      rows: [1, 2, 3, 4, 5].map((n) => ({ generate_series: String(n) })),
      rowCount: 5,
      warnings: [],
    });
    expect(mock.calls).toEqual({});
  });

  test.each([
    ["A2", "GENERATE_SERIES(2, 100, 49) AS n", ["2", "51", "100"]],
    ["A3", "GENERATE_SERIES(7, 28, 10) AS n", ["7", "17", "27"]],
    ["A4", "GENERATE_SERIES(100, 2, -49) AS n", ["100", "51", "2"]],
    ["A5", "GENERATE_SERIES(35, 4, -10) AS n", ["35", "25", "15", "5"]],
    ["A7", "GENERATE_SERIES(1, 5, +2) AS n", ["1", "3", "5"]],
    ["A8", "GENERATE_SERIES(1e2, 5e2, 1e2) AS n", ["100", "200", "300", "400", "500"]],
  ])("%s: 整数境界", async (_id, expression, expected) => {
    expect(values(await run(`WITH s AS (${expression}) SELECT n FROM s`), "n")).toEqual(expected);
  });

  test("A6: start=stop は step の正負それぞれ1行", async () => {
    const result = await run("WITH a AS (GENERATE_SERIES(7,7,3) AS n), b AS (GENERATE_SERIES(7,7,-3) AS n) SELECT n FROM a UNION ALL SELECT n FROM b");
    expect(values(result, "n")).toEqual(["7", "7"]);
  });

  test.each([
    ["GENERATE_SERIES(1,5,2) AS n", ["1", "3", "5"]],
    ["GENERATE_SERIES(1,5,-2) AS n", []],
    ["GENERATE_SERIES(5,1,2) AS n", []],
    ["GENERATE_SERIES(5,1,-2) AS n", ["5", "3", "1"]],
  ])("§12.3 方向の4象限: %s", async (expression, expected) => {
    const result = await run(`WITH s AS (${expression}) SELECT n FROM s`);
    expect(result.columns).toEqual(["n"]);
    expect(values(result, "n")).toEqual(expected);
  });

  test.each([
    ["D1", "GENERATE_SERIES('2026-08-01','2026-08-03') AS 日付", ["2026-08-01", "2026-08-02", "2026-08-03"]],
    ["D2", "GENERATE_SERIES('2026-08-01','2026-08-05','2 days') AS 日付", ["2026-08-01", "2026-08-03", "2026-08-05"]],
    ["D3", "GENERATE_SERIES('2026-08-01','2026-08-06','2 days') AS 日付", ["2026-08-01", "2026-08-03", "2026-08-05"]],
    ["D4", "GENERATE_SERIES('2026-08-10','2026-08-03','-3 days') AS 日付", ["2026-08-10", "2026-08-07", "2026-08-04"]],
    ["D5", "GENERATE_SERIES('2024-02-28','2024-03-01','1 day') AS 日付", ["2024-02-28", "2024-02-29", "2024-03-01"]],
    ["D6", "GENERATE_SERIES('2026-08-01','2026-08-05','+2 days') AS 日付", ["2026-08-01", "2026-08-03", "2026-08-05"]],
  ])("%s: DATE 境界", async (_id, expression, expected) => {
    expect(values(await run(`WITH d AS (${expression}) SELECT 日付 FROM d`), "日付")).toEqual(expected);
  });

  test("D7: TODAY() の具体日付を DATE 終端に使う", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T03:00:00+09:00"));
    try {
      const batch = await executeBatch(
        "DECLARE @from = '2026-08-01'; DECLARE @today = TODAY(); WITH d AS (GENERATE_SERIES(@from,@today) AS 日付) SELECT 日付 FROM d ORDER BY 日付;",
        client(),
        { cacheContext: "b149-today" }
      );
      const result = batch.statements[2].result as SelectResult;
      expect(values(result, "日付")).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    } finally { jest.useRealTimers(); }
  });

  test("M1-M3: 既定列名、整数/DATE メタとソート", async () => {
    expect((await run("WITH s AS (Generate_Series(1,1)) SELECT generate_series FROM s")).columns).toEqual(["generate_series"]);
    const numbers = await run("WITH s AS (GENERATE_SERIES(2,100,49) AS n) SELECT n FROM s ORDER BY n DESC", client(), true);
    expect(values(numbers, "n")).toEqual(["100", "51", "2"]);
    expect(getSelectColumnMeta(numbers)?.get("n")).toMatchObject({ sortKind: "number", fieldType: "NUMBER" });
    const dates = await run("WITH d AS (GENERATE_SERIES('2025-12-30','2026-01-02') AS 日付) SELECT 日付 FROM d ORDER BY 日付 DESC", client(), true);
    expect(values(dates, "日付")).toEqual(["2026-01-02", "2026-01-01", "2025-12-31", "2025-12-30"]);
    expect(getSelectColumnMeta(dates)?.get("日付")).toMatchObject({ fieldType: "DATE" });
  });

  test.each([
    ["M4", "WITH s AS (GENERATE_SERIES(2,100,49) AS n), w AS (SELECT n,LAG(n) OVER (ORDER BY n) AS 前 FROM s) SELECT n,前 FROM w ORDER BY 前", "前", "NUMBER"],
    ["M5", "WITH d AS (GENERATE_SERIES('2025-12-30','2026-01-02') AS 日付), w AS (SELECT 日付,LEAD(日付) OVER (ORDER BY 日付) AS 次日 FROM d) SELECT 日付,次日 FROM w ORDER BY 次日", "次日", "DATE"],
    ["M6", "WITH s AS (GENERATE_SERIES(1,3) AS n), w AS (SELECT n,SUM(n) OVER (ORDER BY n) AS 累計 FROM s) SELECT n,累計 FROM w ORDER BY n", "累計", "KSQL_NUMBER"],
  ])("%s: 直接生成 CTE の警告抑止とメタ", async (_id, sql, column, fieldType) => {
    const result = await run(sql, client(), true);
    expect(result.warnings).toEqual([]);
    expect(getSelectColumnMeta(result)?.get(column)).toMatchObject(
      fieldType === "KSQL_NUMBER"
        ? { sortKind: "number", semantics: { compareMode: "number" } }
        : { fieldType }
    );
  });

  test("M7/M8: JOIN 後は既存警告全文を維持", async () => {
    const mock = client({ 100: [
      record({ 系列キー: "1", 金額: "10" }),
      record({ 系列キー: "1", 金額: "20" }),
      record({ 系列キー: "2", 金額: "30" }),
    ] });
    const prefix = "WITH s AS (GENERATE_SERIES(1,3) AS n), j AS (SELECT s.n,a.金額 FROM s JOIN APP100 AS a ON s.n=a.系列キー), ";
    const lag = await run(prefix + "w AS (SELECT n,LAG(n) OVER (ORDER BY n) AS 前 FROM j) SELECT n,前 FROM w", mock);
    expect(lag.warnings).toEqual([LAG_WARNING]);
    const range = await run(prefix + "w AS (SELECT n,SUM(金額) OVER (ORDER BY n) AS 累計 FROM j) SELECT n,累計 FROM w", mock);
    expect(range.warnings).toEqual([RANGE_WARNING]);
  });

  test("C1-C3: 後続 CTE、UNION、サブクエリ", async () => {
    const c1 = await run("WITH s AS (GENERATE_SERIES(1,3) AS n), x AS (SELECT n,n*10 AS value FROM s) SELECT n,value FROM x ORDER BY n");
    expect(c1.rows).toEqual([{ n: "1", value: "10" }, { n: "2", value: "20" }, { n: "3", value: "30" }]);
    const c2 = await run("WITH s AS (GENERATE_SERIES(1,3) AS n) SELECT n FROM s WHERE n<=2 UNION ALL SELECT n FROM s WHERE n>=2");
    expect(values(c2, "n")).toEqual(["1", "2", "2", "3"]);
    const c3 = await run("WITH s AS (GENERATE_SERIES(1,3) AS n) SELECT n FROM s WHERE n IN (SELECT n FROM s WHERE n>=2) ORDER BY n");
    expect(values(c3, "n")).toEqual(["2", "3"]);
  });

  test("§12.7 LEFT JOIN 0埋めと records API 1回", async () => {
    const mock = client({ 100: [
      record({ 日付: "2026-08-01", 金額: "100" }),
      record({ 日付: "2026-08-01", 金額: "50" }),
      record({ 日付: "2026-08-03", 金額: "200" }),
    ] });
    const result = await run("WITH 日付系列 AS (GENERATE_SERIES('2026-08-01','2026-08-04','1 day') AS 日付), 日別 AS (SELECT 日付,SUM(金額) AS 合計 FROM APP100 GROUP BY 日付) SELECT s.日付,CASE WHEN d.合計='' THEN 0 ELSE d.合計 END AS 合計 FROM 日付系列 AS s LEFT JOIN 日別 AS d ON s.日付=d.日付 ORDER BY s.日付", mock);
    expect(result).toMatchObject({
      columns: ["日付", "合計"], rowCount: 4,
      rows: [
        { 日付: "2026-08-01", 合計: "150" }, { 日付: "2026-08-02", 合計: "0" },
        { 日付: "2026-08-03", 合計: "200" }, { 日付: "2026-08-04", 合計: "0" },
      ],
    });
    expect(mock.calls.records).toBe(1);
  });

  test("§12.8 一時テーブルは DATE メタを維持し API 0回", async () => {
    const mock = client();
    const batch = await executeBatch("CREATE TEMP TABLE #days AS WITH d AS (GENERATE_SERIES('2026-08-01','2026-08-03') AS 日付) SELECT 日付 FROM d; SELECT 日付 FROM #days ORDER BY 日付;", mock, { captureColumnMeta: true, cacheContext: "b149-temp" });
    const result = batch.statements[1].result as SelectResult;
    expect(values(result, "日付")).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(getSelectColumnMeta(result)?.get("日付")).toMatchObject({ fieldType: "DATE" });
    expect(mock.calls).toEqual({});
  });

  test.each([
    ["GENERATE_SERIES(1,5,0)", "ArgumentError: GENERATE_SERIES の step に 0 は指定できません。"],
    ["GENERATE_SERIES('2026-08-01','2026-08-05','+0 day')", "ArgumentError: GENERATE_SERIES の日付 step に 0 day は指定できません。"],
    ["GENERATE_SERIES(1,5,0.5)", "ArgumentError: GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。"],
    ["GENERATE_SERIES(1.5,5.5)", "ArgumentError: GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。"],
    ["GENERATE_SERIES('2026-02-30','2026-03-02')", "ArgumentError: GENERATE_SERIES の日付引数には実在する YYYY-MM-DD 形式の DATE を指定してください。"],
    ["GENERATE_SERIES('2026-08-01T00:00:00Z','2026-08-03T00:00:00Z','1 day')", "ArgumentError: GENERATE_SERIES は Phase 1 では整数と DATE のみ対応しています。DATETIME と TIME は使用できません。"],
    ["GENERATE_SERIES(1,'2026-08-03')", "ArgumentError: GENERATE_SERIES の start と stop は、両方を整数または両方を DATE にしてください。"],
    ["GENERATE_SERIES('2026-08-01','2026-08-03',1)", "ArgumentError: GENERATE_SERIES の step が系列の型と一致しません。整数系列には整数、DATE 系列には day、month、year 単位を指定してください。"],
  ])("§12.9 公開エラー: %s", async (expression, message) => {
    expect((await errorFor(`WITH s AS (${expression}) SELECT generate_series FROM s`)).message).toBe(message);
  });

  test("B159: month step を DATE 系列として受理する", async () => {
    expect(values(await run("WITH s AS (GENERATE_SERIES('2026-08-01','2026-10-01','1 month') AS 日付) SELECT 日付 FROM s"), "日付"))
      .toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });

  test.each([
    ["GENERATE_SERIES(1e-400, 1e-400)", "ArgumentError: GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。"],
    ["GENERATE_SERIES(1.0000000000000000001, 2)", "ArgumentError: GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。"],
    ["GENERATE_SERIES(9007199254740990.9, 9007199254740990.9)", "ArgumentError: GENERATE_SERIES の数値系列は整数の start、stop、step のみを受け付けます。"],
    ["GENERATE_SERIES('12:00', '13:00', '1 day')", "ArgumentError: GENERATE_SERIES は Phase 1 では整数と DATE のみ対応しています。DATETIME と TIME は使用できません。"],
  ])("§12.9 丸め前の整数判定と TIME 診断: %s", async (expression, message) => {
    expect((await errorFor(`WITH s AS (${expression}) SELECT generate_series FROM s`)).message).toBe(message);
  });

  test("§12.9 FROM 直置きは修正例付き ParseError", async () => {
    const error = await errorFor("SELECT * FROM GENERATE_SERIES(1,5)");
    expect(error.name).toBe("ParseError");
    expect(error.message).toContain("WITH s AS (GENERATE_SERIES(1, 5)) SELECT generate_series FROM s");
  });

  test("X1-X6: 上限と adversarial", async () => {
    expect((await run("WITH s AS (GENERATE_SERIES(1,10000) AS n) SELECT COUNT(*) AS 件数 FROM s")).rows).toEqual([{ 件数: "10000" }]);
    expect((await errorFor("WITH s AS (GENERATE_SERIES(1,10001) AS n) SELECT COUNT(*) AS 件数 FROM s")).message).toContain("生成件数 10001 行が上限 10000 行");
    expect((await errorFor("WITH s AS (GENERATE_SERIES(1,1000000000) AS n) SELECT n FROM s LIMIT 1")).message).toContain("上限 10000 行");
    expect((await errorFor("WITH a AS (GENERATE_SERIES(1,6000) AS n),b AS (GENERATE_SERIES(1,5000) AS n) SELECT n FROM a UNION ALL SELECT n FROM b")).message).toContain("生成件数合計 11000 行");
    const empty = await run("WITH s AS (GENERATE_SERIES(1,9007199254740991,-1) AS n) SELECT n FROM s");
    expect(empty).toMatchObject({ columns: ["n"], rows: [], rowCount: 0 });
    expect((await errorFor("WITH s AS (GENERATE_SERIES(9007199254740992,9007199254740993)) SELECT generate_series FROM s")).message).toContain("整数の start、stop、step");
  });

  test("X7/X8: 変数解決後の空文字と上限", async () => {
    const empty = await executeBatch("DECLARE @start=''; WITH s AS (GENERATE_SERIES(@start,5)) SELECT generate_series FROM s;", client());
    expect(empty.statements[1]).toMatchObject({ status: "error", error: { message: "ArgumentError: GENERATE_SERIES の start に空文字は指定できません。" } });
    const over = await executeBatch("DECLARE @stop=10001; WITH s AS (GENERATE_SERIES(1,@stop) AS n) SELECT n FROM s;", client());
    expect(over.statements[1]).toMatchObject({ status: "error", error: { message: expect.stringContaining("上限 10000 行") } });
  });

  test("§12.11 EXPLAIN は系列計画を表示し全 API 0回", async () => {
    const mock = client();
    const result = await run("EXPLAIN WITH s AS (GENERATE_SERIES(2,100,49) AS n) SELECT n FROM s ORDER BY n", mock);
    const plan = values(result, "plan").join("\n");
    for (const text of ["source:        GENERATE_SERIES", "column:        n", "series type:   INTEGER", "start:         2", "stop:          100", "step:          49", "rows:          3", "row guard:     3 / 10000", "records API:   none"]) expect(plan).toContain(text);
    expect(mock.calls).toEqual({});
  });

  test("§12.12 ksql_validate はリテラル違反を静的拒否し API を作らない", async () => {
    let runtimeCalls = 0;
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async () => {
        runtimeCalls++;
        throw new Error("runtime must not be created by validate");
      },
    });
    for (const sql of [
      "WITH s AS (GENERATE_SERIES(1,10001) AS n) SELECT n FROM s",
      "WITH s AS (GENERATE_SERIES(1,5,0) AS n) SELECT n FROM s",
      "WITH s AS (GENERATE_SERIES(1,'2026-08-03') AS n) SELECT n FROM s",
      "WITH s AS (GENERATE_SERIES(1) AS n) SELECT n FROM s",
      "WITH s AS (GENERATE_SERIES(1,2,1,1) AS n) SELECT n FROM s",
      "WITH a AS (GENERATE_SERIES(1,6000) AS n),b AS (GENERATE_SERIES(1,5000) AS n) SELECT n FROM a",
    ]) {
      await expect(tools.validate({ sql })).rejects.toThrow(/ArgumentError/);
    }
    expect(runtimeCalls).toBe(0);
  });

  test("§12.12 ksql_validate は変数依存を保留し、通常実行で TODAY を解決する", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" });
    await expect(tools.validate({
      sql: "DECLARE @from='2026-08-01'; DECLARE @today=TODAY(); WITH d AS (GENERATE_SERIES(@from,@today) AS 日付) SELECT 日付 FROM d;",
    })).resolves.toMatchObject({ ok: true, batch: true, isReadOnlyBatch: true });
  });

  test("§12.13 read-only 保存クエリを query 経路で実行し書込 API 0回", async () => {
    const savedEnv = process.env.KSQL_SAVED_QUERIES;
    const dir = await mkdtemp(join(process.cwd(), ".tmp-b149-saved-"));
    process.env.KSQL_SAVED_QUERIES = join(dir, "queries.json");
    const mock = client();
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async (_options, input) => ({
        sql: input.sql,
        profileName: "prod",
        client: mock,
        cacheContext: "b149-saved",
        maxRecords: 500,
        fetchParallel: 1,
        onLimit: "error",
        timeout: 30_000,
      }),
    });
    try {
      await tools.saveQuery({
        name: "b149_dates",
        sql: "DECLARE @from='2026-08-01'; DECLARE @stop='2026-08-03'; WITH d AS (GENERATE_SERIES(@from,@stop) AS 日付) SELECT 日付 FROM d ORDER BY 日付;",
        defaultProfile: "prod",
        readOnly: true,
      });
      const ran = await tools.runSavedQuery({ name: "b149_dates" }) as {
        result: { results: Array<{ columns: string[]; rows: Array<Record<string, string>>; rowCount: number }> };
      };
      expect(ran.result.results[0]).toMatchObject({
        columns: ["日付"], rowCount: 3,
        rows: [{ 日付: "2026-08-01" }, { 日付: "2026-08-02" }, { 日付: "2026-08-03" }],
      });
      expect(mock.calls.post ?? 0).toBe(0);
      expect(mock.calls.put ?? 0).toBe(0);
      expect(mock.calls.delete ?? 0).toBe(0);
    } finally {
      if (savedEnv === undefined) delete process.env.KSQL_SAVED_QUERIES;
      else process.env.KSQL_SAVED_QUERIES = savedEnv;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("§10.11 確定エラーは後続の物理 CTE より前に拒否する", async () => {
    const mock = client({ 100: [record({ 日付: "2026-08-01" })] });
    await expect(run("WITH s AS (GENERATE_SERIES(1,10001) AS n),a AS (SELECT 日付 FROM APP100) SELECT n FROM s", mock)).rejects.toThrow(/上限 10000 行/);
    expect(mock.calls).toEqual({});
  });

  test("§12.14 WITH/SHOW/DESCRIBE と識別子の回帰", () => {
    expect(parseSqlStatement("WITH s AS (SELECT 1 AS n) SELECT n FROM s").type).toBe("WITH");
    expect(parseSqlStatement("WITH s AS (SHOW APPS) SELECT * FROM s").type).toBe("WITH");
    expect(parseSqlStatement("WITH s AS (DESCRIBE APP100) SELECT * FROM s").type).toBe("WITH");
    expect(parseSqlStatement("SELECT `GENERATE_SERIES` FROM APP100").type).toBe("SELECT");
  });

  test("§14 言語リファレンスから生成する ksql_docs と MCP schema が同期する", () => {
    const withDocs = KSQL_DOCS.languageReference.sections["13-with-cte"].text;
    for (const text of ["GENERATE_SERIES", "10,000", "ksql_validate", "ksql_run_saved_query", "LEFT JOIN", "LAG", "records API"] ) {
      expect(withDocs).toContain(text);
    }
    for (const description of [
      validateInputSchema.shape.sql.description,
      explainInputSchema.shape.sql.description,
      queryInputSchema.shape.sql.description,
      saveQueryInputSchema.shape.sql.description,
    ]) expect(description).toContain("GENERATE_SERIES");
    expect(STATEMENT_SYNTAX_CATALOG.with.template).toContain("GENERATE_SERIES");
  });
});
