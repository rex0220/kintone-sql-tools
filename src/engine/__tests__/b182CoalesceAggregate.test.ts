import type { KintoneRecord } from "../../converter/dmlToKintone";
import { execute, executeBatch, type KintoneClient, type SelectResult } from "../../execute";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { syntheticSemantics } from "../../core/fieldSemantics";
import { runFullScan } from "../process";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { value }]));
}

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

const rows = [
  record({ company: "small", amount: "9050000", calc: "9050000", memo: "9" }),
  record({ company: "large", amount: "20700000", calc: "20700000", memo: "20" }),
];

function runFull(sql: string, input = rows) {
  return runFullScan({
    stmt: parse(sql),
    tables: new Map([[null, input]]),
    fieldSemanticsResolver: (field) => field.field === "amount" ? syntheticSemantics("number") : syntheticSemantics("string"),
    havingFieldSemanticsResolver: (field) => field.field === "metric" ? syntheticSemantics("number") : undefined,
  });
}

function client(input = rows): KintoneClient {
  return {
    async getRecords(params) {
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: input.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* read-only */ },
    async deleteRecords() { /* read-only */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "company", label: "company", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" as const },
        { code: "amount", label: "amount", fieldType: "NUMBER", sortKind: "number" as const },
        { code: "calc", label: "calc", fieldType: "CALC", sortKind: "number" as const },
        { code: "memo", label: "memo", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" as const },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

async function run(sql: string): Promise<SelectResult> {
  return await execute(sql, client(), { cacheContext: `b182-${Math.random()}` }) as SelectResult;
}

test("B182: 集計を包む算術を GROUP BY あり・なしで集計後に評価する", () => {
  expect(runFull(`SELECT company,
    COALESCE(SUM(amount),0)+0 AS plus,
    COALESCE(SUM(amount),0)*1 AS times,
    ISNULL(SUM(amount),0)*1 AS isnull,
    COALESCE(SUM(amount),0)*100.0/2 AS rate,
    NULLIF(SUM(amount),0)+0 AS nullif
    FROM APP100 GROUP BY company ORDER BY plus ASC`).rows).toEqual([
    { company: "small", plus: "9050000", times: "9050000", isnull: "9050000", rate: "452500000", nullif: "9050000" },
    { company: "large", plus: "20700000", times: "20700000", isnull: "20700000", rate: "1035000000", nullif: "20700000" },
  ]);

  expect(runFull("SELECT COALESCE(SUM(amount),0)+0 AS actual, SUM(amount)+0 AS expected FROM APP100").rows)
    .toEqual([{ actual: "29750000", expected: "29750000" }]);
});

test("B182: 0 行・HAVING alias・DISTINCT でも実体化値を使う", () => {
  expect(runFull("SELECT COALESCE(SUM(amount),0)*1 AS total FROM APP100", []).rows)
    .toEqual([{ total: "0" }]);
  expect(runFull(
    "SELECT company, COALESCE(SUM(amount),0)+0 AS metric FROM APP100 GROUP BY company HAVING metric > 10000000"
  ).rows).toEqual([{ company: "large", metric: "20700000" }]);
  expect(runFull("SELECT DISTINCT COALESCE(SUM(amount),0)+0 AS total FROM APP100").rows)
    .toEqual([{ total: "29750000" }]);
});

test("B182: LEFT JOIN 不一致側は 0、一致側は集計値になる", () => {
  const result = runFullScan({
    stmt: parse("SELECT a.company, COALESCE(SUM(b.amount),0)+0 AS total FROM APP1 a LEFT JOIN APP2 b ON a.company=b.company GROUP BY a.company ORDER BY total ASC"),
    tables: new Map([
      ["a", [record({ company: "missing" }), record({ company: "matched" })]],
      ["b", [record({ company: "matched", amount: "99" })]],
    ]),
  });
  expect(result.rows).toEqual([
    { company: "missing", total: "0" },
    { company: "matched", total: "99" },
  ]);
});

test("B182: CTE の ORDER BY・RANK・累計は数値順になる", async () => {
  const base = "WITH g AS (SELECT company,COALESCE(SUM(amount),0) AS total FROM APP100 GROUP BY company) ";
  const desc = await run(base + "SELECT company,total,RANK() OVER (ORDER BY total DESC) AS rank,SUM(total) OVER (ORDER BY total DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM g ORDER BY total DESC");
  expect(desc.rows).toEqual([
    { company: "large", total: "20700000", rank: "1", running: "20700000" },
    { company: "small", total: "9050000", rank: "2", running: "29750000" },
  ]);
  expect((await run(base + "SELECT company,total FROM g ORDER BY total ASC")).rows.map((row) => row.company))
    .toEqual(["small", "large"]);
});

test("B182: 全数値の NULLIF・GREATEST・LEAST は数値順、文字列混在は文字列順を維持する", async () => {
  for (const expression of ["NULLIF(SUM(amount),0)", "GREATEST(SUM(amount),0)", "LEAST(SUM(amount),99999999)"]) {
    const result = await run(`WITH g AS (SELECT company,${expression} AS total FROM APP100 GROUP BY company) SELECT company,total FROM g ORDER BY total DESC`);
    expect(result.rows.map((row) => row.company)).toEqual(["large", "small"]);
  }
  for (const expression of ["COALESCE(SUM(amount),'none')", "GREATEST(SUM(amount),'a')"]) {
    const result = await run(`WITH g AS (SELECT company,${expression} AS total FROM APP100 GROUP BY company) SELECT company,total FROM g ORDER BY total DESC`);
    expect(result.rows.map((row) => row.company)).toEqual(["small", "large"]);
  }
  expect((await run("SELECT company,COALESCE(memo,'－') AS text FROM APP100 ORDER BY text DESC")).rows.map((row) => row.company))
    .toEqual(["small", "large"]);
  expect((await run("SELECT company,COALESCE(calc,0) AS value FROM APP100 ORDER BY value DESC")).rows.map((row) => row.company))
    .toEqual(["large", "small"]);
  expect((await run("SELECT company FROM APP100 WHERE COALESCE(amount,0) > 10000000")).rows)
    .toEqual([{ company: "large" }]);
});

test("B182: 文書の推奨 3 形と修正後 COALESCE は同じ値・順序になる", async () => {
  const result = await run(`WITH g AS (SELECT company,
    CASE WHEN SUM(amount) = '' THEN 0 ELSE SUM(amount) END AS by_case,
    SUM(COALESCE(amount,0)) AS by_inner,
    CAST(COALESCE(SUM(amount),0) AS NUMBER) AS by_cast,
    COALESCE(SUM(amount),0) AS by_fixed
    FROM APP100 GROUP BY company)
    SELECT company,by_case,by_inner,by_cast,by_fixed FROM g ORDER BY by_fixed DESC`);
  expect(result.rows).toEqual([
    { company: "large", by_case: "20700000", by_inner: "20700000", by_cast: "20700000", by_fixed: "20700000" },
    { company: "small", by_case: "9050000", by_inner: "9050000", by_cast: "9050000", by_fixed: "9050000" },
  ]);
});

test("B182: EXPLAIN の reason 行は GROUP BY だけの文で変わらず、集計を包む算術では集計ありになる", async () => {
  const reasonOf = (result: SelectResult): string | undefined =>
    result.rows.map((row) => row.plan).find((line) => line.trim().startsWith("reason:"))?.trim();
  expect(reasonOf(await run("EXPLAIN SELECT company FROM APP100 GROUP BY company")))
    .toBe("reason:        GROUP BY あり");
  expect(reasonOf(await run("EXPLAIN SELECT COALESCE(SUM(amount),0)+0 AS total FROM APP100")))
    .toBe("reason:        集計関数（COUNT / SUM 等）あり");
});

test("B182: 一時テーブルと executeStatement バッチ経路でも値・数値順・列 shape を維持する", async () => {
  const batch = await executeBatch(
    "SELECT COALESCE(SUM(amount),0)+0 AS total FROM APP100;" +
    "CREATE TEMP TABLE #g AS SELECT company,COALESCE(SUM(amount),0) AS total FROM APP100 GROUP BY company;" +
    "SELECT company,total FROM #g ORDER BY total DESC",
    client(),
    { cacheContext: "b182-flow" }
  );
  const result = batch.statements[0].result as SelectResult;
  expect(result).toMatchObject({ columns: ["total"], rows: [{ total: "29750000" }], warnings: [] });
  expect((batch.statements[2].result as SelectResult).rows).toEqual([
    { company: "large", total: "20700000" },
    { company: "small", total: "9050000" },
  ]);
});
