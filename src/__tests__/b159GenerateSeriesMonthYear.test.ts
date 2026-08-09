import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  executeBatch,
  getSelectColumnMeta,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import { createKsqlMcpTools } from "../mcp/tools";

type CountingClient = KintoneClient & { calls: Record<string, number> };

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

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
        fieldType: code === "金額" ? "NUMBER" : code === "月" ? "DATE" : "SINGLE_LINE_TEXT",
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
    cacheContext: `b159-${Math.random()}`,
  }) as SelectResult;
}

function values(result: SelectResult, column = result.columns[0]): string[] {
  return result.rows.map((row) => row[column] ?? "");
}

async function errorFor(sql: string, mock = client()): Promise<Error> {
  try { await run(sql, mock); } catch (error) { return error as Error; }
  throw new Error("expected rejection");
}

const LAG_WARNING = "前 の ORDER BY は全順序でないため、同順内の前後関係は未規定です。ウィンドウの各パーティション内で、ORDER BY の値の組が入力行を一意に識別するとクエリ構造または保証済みのデータ制約から確認できる場合に限り、この警告は無視できます。元の集約キーをすべて ORDER BY に含む形や、JOIN 後も同じ系列値が各パーティション内で高々1行と保証できる形が該当します。生成列、再帰の深さ列、または $id に由来する列であるという理由だけでは無視できません。";

describe("B159 GENERATE_SERIES month/year step", () => {
  test.each([
    ["month 正方向", "'2025-08-01','2026-08-01','1 month'", 13, "2025-08-01", "2026-08-01"],
    ["months 係数付き", "'2025-08-01','2026-08-31','2 months'", 7, "2025-08-01", "2026-08-01"],
    ["単数形と係数不一致", "'2025-08-01','2026-02-01','+2 month'", 4, "2025-08-01", "2026-02-01"],
    ["month 負方向", "'2026-08-01','2026-02-01','-2 months'", 4, "2026-08-01", "2026-02-01"],
    ["year 正方向", "'2022-01-01','2026-01-01','1 year'", 5, "2022-01-01", "2026-01-01"],
    ["years 係数付き", "'2022-01-01','2026-12-31','2 years'", 3, "2022-01-01", "2026-01-01"],
    ["year 負方向", "'2026-01-01','2020-01-01','-2 year'", 4, "2026-01-01", "2020-01-01"],
    ["month stop 非アンカー", "'2025-08-01','2025-10-15','1 month'", 3, "2025-08-01", "2025-10-01"],
    ["month 負 stop 非アンカー", "'2025-10-01','2025-08-15','-1 month'", 2, "2025-10-01", "2025-09-01"],
    ["year 負 stop 非アンカー", "'2026-01-01','2025-12-31','-1 year'", 1, "2026-01-01", "2026-01-01"],
  ])("%s", async (_name, args, count, first, last) => {
    const result = await run(`WITH s AS (GENERATE_SERIES(${args}) AS d) SELECT d FROM s`);
    expect(result.rowCount).toBe(count);
    expect(values(result, "d")[0]).toBe(first);
    const generated = values(result, "d");
    expect(generated[generated.length - 1]).toBe(last);
    expect(new Set(values(result, "d")).size).toBe(count);
  });

  test.each([
    ["'2025-08-01','2026-08-01','-1 month'"],
    ["'2026-08-01','2025-08-01','1 month'"],
    ["'2022-01-01','2026-01-01','-1 year'"],
    ["'2026-01-01','2022-01-01','1 year'"],
  ])("向きが逆なら0行: %s", async (args) => {
    expect(await run(`WITH s AS (GENERATE_SERIES(${args}) AS d) SELECT d FROM s`))
      .toMatchObject({ columns: ["d"], rows: [], rowCount: 0 });
  });

  test("start=stop は step の正負に関係なく1行", async () => {
    const result = await run("WITH a AS (GENERATE_SERIES('2025-08-01','2025-08-01','-1 month') AS d), b AS (GENERATE_SERIES('2025-01-01','2025-01-01','1 year') AS d) SELECT d FROM a UNION ALL SELECT d FROM b");
    expect(values(result, "d")).toEqual(["2025-08-01", "2025-01-01"]);
  });

  test.each([
    ["'2025-08-01','2026-08-01','0 month'", "ArgumentError: GENERATE_SERIES の日付 step に 0 month は指定できません。"],
    ["'2022-01-01','2026-01-01','-0 years'", "ArgumentError: GENERATE_SERIES の日付 step に 0 year は指定できません。"],
    ["'2025-08-31','2026-08-01','1 month'", "ArgumentError: GENERATE_SERIES の month step では start に月初（YYYY-MM-01）を指定してください。"],
    ["'2025-02-01','2028-01-01','1 year'", "ArgumentError: GENERATE_SERIES の year step では start に年初（YYYY-01-01）を指定してください。"],
    ["'2025-08-01','2026-08-01','1 week'", "ArgumentError: GENERATE_SERIES の日付 step は day、days、month、months、year、years のみ対応しています。"],
    ["'2025-08-01','2026-08-01','1.5 months'", "ArgumentError: GENERATE_SERIES の日付 step の係数には安全な整数を指定してください。"],
    ["'2025-08-01','2026-08-01','1e2 months'", "ArgumentError: GENERATE_SERIES の日付 step の係数には安全な整数を指定してください。"],
    ["'2025-08-01','2026-08-01','9007199254740992 months'", "ArgumentError: GENERATE_SERIES の日付 step の係数には安全な整数を指定してください。"],
  ])("逐語エラー: %s", async (args, message) => {
    expect((await errorFor(`WITH s AS (GENERATE_SERIES(${args}) AS d) SELECT d FROM s`)).message).toBe(message);
  });

  test("型不一致文言を month/year 対応へ更新する", async () => {
    expect((await errorFor("WITH s AS (GENERATE_SERIES('2025-08-01','2025-09-01',1) AS d) SELECT d FROM s")).message)
      .toBe("ArgumentError: GENERATE_SERIES の step が系列の型と一致しません。整数系列には整数、DATE 系列には day、month、year 単位を指定してください。");
  });

  test("向きが逆でも start アンカー違反を先に拒否する", async () => {
    expect((await errorFor("WITH s AS (GENERATE_SERIES('2025-08-15','2024-08-01','1 month') AS d) SELECT d FROM s")).message)
      .toBe("ArgumentError: GENERATE_SERIES の month step では start に月初（YYYY-MM-01）を指定してください。");
  });

  test("変数解決前の既知アンカーと解決後の step/上限を検査する", async () => {
    const tools = createKsqlMcpTools({ profile: "prod" }, {
      createRuntime: async () => { throw new Error("runtime must not be created"); },
    });
    await expect(tools.validate({
      sql: "DECLARE @stop='2026-08-01'; WITH s AS (GENERATE_SERIES('2025-08-15',@stop,'1 month') AS d) SELECT d FROM s;",
    })).rejects.toThrow("month step では start に月初");

    const anchor = await executeBatch("DECLARE @start='2025-08-15'; WITH s AS (GENERATE_SERIES(@start,'2026-08-01','1 month') AS d) SELECT d FROM s;", client());
    expect(anchor.statements[1]).toMatchObject({ status: "error", error: { message: expect.stringContaining("month step では start に月初") } });
    const over = await executeBatch("DECLARE @stop='1833-05-01'; DECLARE @step='1 month'; WITH s AS (GENERATE_SERIES('1000-01-01',@stop,@step) AS d) SELECT d FROM s;", client());
    expect(over.statements[2]).toMatchObject({ status: "error", error: { message: "ArgumentError: GENERATE_SERIES の生成件数 10001 行が上限 10000 行を超えています。" } });
  });

  test.each([
    ["0 month", "DECLARE @step='0 month';", "'2025-08-01','2026-08-01',@step", "'2025-08-01','2026-08-01','0 month'", "ArgumentError: GENERATE_SERIES の日付 step に 0 month は指定できません。"],
    ["未対応単位", "DECLARE @step='1 week';", "'2025-08-01','2026-08-01',@step", "'2025-08-01','2026-08-01','1 week'", "ArgumentError: GENERATE_SERIES の日付 step は day、days、month、months、year、years のみ対応しています。"],
    ["不正係数", "DECLARE @step='1.5 years';", "'2022-01-01','2026-01-01',@step", "'2022-01-01','2026-01-01','1.5 years'", "ArgumentError: GENERATE_SERIES の日付 step の係数には安全な整数を指定してください。"],
    ["year 非年初アンカー", "DECLARE @start='2025-02-01';", "@start,'2026-01-01','1 year'", "'2025-02-01','2026-01-01','1 year'", "ArgumentError: GENERATE_SERIES の year step では start に年初（YYYY-01-01）を指定してください。"],
  ])("変数解決後の逐語エラーはリテラルと同じ: %s", async (_name, declaration, variableArgs, literalArgs, message) => {
    const batch = await executeBatch(`${declaration} WITH s AS (GENERATE_SERIES(${variableArgs}) AS d) SELECT d FROM s;`, client());
    const variableMessage = batch.statements[1].error?.message;
    const literalMessage = (await errorFor(`WITH s AS (GENERATE_SERIES(${literalArgs}) AS d) SELECT d FROM s`)).message;
    expect(variableMessage).toBe(message);
    expect(variableMessage).toBe(literalMessage);
  });

  test("月・年の境界値をアンカーと行番号から生成する", async () => {
    expect(values(await run("WITH s AS (GENERATE_SERIES('0001-01-01','0001-03-01','1 month') AS d) SELECT d FROM s"), "d"))
      .toEqual(["0001-01-01", "0001-02-01", "0001-03-01"]);
    expect(values(await run("WITH s AS (GENERATE_SERIES('9999-01-01','9999-01-01','1 year') AS d) SELECT d FROM s"), "d"))
      .toEqual(["9999-01-01"]);
  });

  test("10,000行境界・LIMIT非回避・WITH内合計", async () => {
    expect((await run("WITH s AS (GENERATE_SERIES('1000-01-01','1833-04-01','1 month') AS d) SELECT COUNT(*) AS n FROM s")).rows)
      .toEqual([{ n: "10000" }]);
    expect((await errorFor("WITH s AS (GENERATE_SERIES('1000-01-01','1833-05-01','1 month') AS d) SELECT d FROM s LIMIT 1")).message)
      .toBe("ArgumentError: GENERATE_SERIES の生成件数 10001 行が上限 10000 行を超えています。");
    expect((await errorFor("WITH a AS (GENERATE_SERIES('1000-01-01','1499-12-01','1 month') AS d), b AS (GENERATE_SERIES('2000-01-01','2416-08-01','1 month') AS d) SELECT d FROM a UNION ALL SELECT d FROM b")).message)
      .toBe("ArgumentError: この WITH 文の GENERATE_SERIES 生成件数合計 11000 行が上限 10000 行を超えています。");
  });

  test("LAST_DAY・DATE_FORMAT・うるう年を DATE 意味論で合成する", async () => {
    const leap = await run("WITH m AS (GENERATE_SERIES('2024-01-01','2024-03-01','1 month') AS 月) SELECT 月,LAST_DAY(月) AS 月末,DATE_FORMAT(月,'%Y-%m') AS 月キー FROM m ORDER BY 月");
    expect(leap.rows).toEqual([
      { 月: "2024-01-01", 月末: "2024-01-31", 月キー: "2024-01" },
      { 月: "2024-02-01", 月末: "2024-02-29", 月キー: "2024-02" },
      { 月: "2024-03-01", 月末: "2024-03-31", 月キー: "2024-03" },
    ]);
    const common = await run("WITH m AS (GENERATE_SERIES('2025-02-01','2025-02-01','1 month') AS 月) SELECT LAST_DAY(月) AS 月末 FROM m");
    expect(common.rows).toEqual([{ 月末: "2025-02-28" }]);
  });

  test("DATEメタと直接生成列の LAG/LEAD 警告抑止を維持する", async () => {
    const result = await run("WITH m AS (GENERATE_SERIES('2025-08-01','2025-10-01','1 month') AS 月) SELECT 月,LAG(月) OVER (ORDER BY 月) AS 前月,LEAD(月) OVER (ORDER BY 月 DESC) AS 次月 FROM m ORDER BY 月", client(), true);
    expect(getSelectColumnMeta(result)?.get("月")).toMatchObject({ fieldType: "DATE", sortKind: "string" });
    expect(getSelectColumnMeta(result)?.get("前月")).toMatchObject({ fieldType: "DATE" });
    expect(getSelectColumnMeta(result)?.get("次月")).toMatchObject({ fieldType: "DATE" });
    expect(result.warnings).toEqual([]);
  });

  test("CROSS JOIN 後は DATE メタを保ち、全順序警告を維持する", async () => {
    const mock = client({
      200: Array.from({ length: 8 }, (_value, index) => record({ 製品コード: `P${index + 1}` })),
    });
    const result = await run("WITH m AS (GENERATE_SERIES('2026-01-01','2026-12-01','1 month') AS 月), p AS (SELECT 製品コード FROM APP200) SELECT m.月,p.製品コード,LAG(m.月) OVER (ORDER BY m.月) AS 前月 FROM m CROSS JOIN p ORDER BY m.月,p.製品コード", mock, true);
    expect(result.rowCount).toBe(96);
    expect(getSelectColumnMeta(result)?.get("月")).toMatchObject({ fieldType: "DATE" });
    expect(result.warnings?.join("\n")).toContain("全順序でない");
  });

  test.each([
    ["month", "'2025-08-01','2025-10-01','1 month'", ["2025-08-01", "2025-08-01", "2025-09-01"]],
    ["year", "'2024-01-01','2026-01-01','1 year'", ["2024-01-01", "2024-01-01", "2025-01-01"]],
  ])("%s 系列は通常 JOIN 後も全順序警告を維持する", async (_unit, args, appDates) => {
    const mock = client({ 200: appDates.map((月) => record({ 月 })) });
    const result = await run(`WITH s AS (GENERATE_SERIES(${args}) AS d), j AS (SELECT s.d,a.月 FROM s JOIN APP200 AS a ON s.d=a.月), w AS (SELECT d,LAG(d) OVER (ORDER BY d) AS 前 FROM j) SELECT d,前 FROM w`, mock);
    expect(result.warnings).toEqual([LAG_WARNING]);
  });

  test.each([
    ["month", "'2025-08-01','2025-10-01','1 month'", ["2025-08-01", "2025-08-01", "2025-09-01"]],
    ["year", "'2024-01-01','2026-01-01','1 year'", ["2024-01-01", "2024-01-01", "2025-01-01"]],
  ])("%s 系列は一時テーブル経由でも全順序警告を維持する", async (_unit, args, appDates) => {
    const mock = client({ 200: appDates.map((月) => record({ 月 })) });
    const batch = await executeBatch(
      `CREATE TEMP TABLE #series AS WITH s AS (GENERATE_SERIES(${args}) AS d) SELECT d FROM s; ` +
      "WITH j AS (SELECT s.d,a.月 FROM #series AS s JOIN APP200 AS a ON s.d=a.月), w AS (SELECT d,LAG(d) OVER (ORDER BY d) AS 前 FROM j) SELECT d,前 FROM w;",
      mock,
      { cacheContext: `b159-temp-warning-${_unit}-${Math.random()}` }
    );
    expect((batch.statements[1].result as SelectResult).warnings).toEqual([LAG_WARNING]);
  });

  test("月次0埋め後の LAG は空月直後に0を返す", async () => {
    const mock = client({
      100: [record({ 月キー: "2025-08", 金額: "10" }), record({ 月キー: "2025-10", 金額: "30" })],
    });
    const result = await run(`WITH m AS (
      GENERATE_SERIES('2025-08-01','2026-08-01','1 month') AS 月
    ), 月キー付き AS (
      SELECT 月,DATE_FORMAT(月,'%Y-%m') AS 月キー FROM m
    ), 月次実績 AS (
      SELECT 月キー,SUM(金額) AS 実績 FROM APP100 GROUP BY 月キー
    ), 月次0埋め AS (
      SELECT m.月,CASE WHEN a.実績='' THEN 0 ELSE a.実績 END AS 実績
      FROM 月キー付き AS m LEFT JOIN 月次実績 AS a ON m.月キー=a.月キー
    ), 月次比較 AS (
      SELECT 月,実績,LAG(実績) OVER (ORDER BY 月) AS 前月実績 FROM 月次0埋め
    ) SELECT 月,実績,前月実績 FROM 月次比較 ORDER BY 月`, mock);
    expect(result.rowCount).toBe(13);
    expect(result.rows.slice(0, 3)).toEqual([
      { 月: "2025-08-01", 実績: "10", 前月実績: "" },
      { 月: "2025-09-01", 実績: "0", 前月実績: "10" },
      { 月: "2025-10-01", 実績: "30", 前月実績: "0" },
    ]);
    expect(result.rows[result.rows.length - 1]).toEqual({ 月: "2026-08-01", 実績: "0", 前月実績: "0" });
  });

  test("EXPLAIN は単位を正規化し API none を表示する", async () => {
    const mock = client();
    const result = await run("EXPLAIN WITH m AS (GENERATE_SERIES('2025-08-01','2026-08-01','1 months') AS 月), y AS (GENERATE_SERIES('2022-01-01','2026-12-31','+2 year') AS 年) SELECT 月 FROM m", mock);
    const plan = values(result, "plan").join("\n");
    for (const text of [
      "series type:   DATE", "step:          1 month", "rows:          13",
      "step:          2 years", "rows:          3", "row guard:     13 / 10000",
      "records API:   none",
    ]) expect(plan).toContain(text);
    expect(mock.calls).toEqual({});
  });

  test.each([
    ["'-1 years'", "-1 year"],
    ["'-2 year'", "-2 years"],
  ])("EXPLAIN step 正規化を逐語固定する: %s", async (step, normalized) => {
    const result = await run(`EXPLAIN WITH y AS (GENERATE_SERIES('2026-01-01','2022-01-01',${step}) AS 年) SELECT 年 FROM y`);
    expect(values(result, "plan")).toContain(`  step:          ${normalized}`);
  });
});
