import type { KintoneRecord } from "../../converter/dmlToKintone";
import {
  execute,
  executeBatch,
  type KintoneClient,
  type SelectResult,
} from "../../execute";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { runFullScan } from "../process";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

const sales = [
  record({ $id: "1", 商談フェーズ: "p9", 売上: "9", 原価: "1", 数量: "1", 有効: "yes" }),
  record({ $id: "2", 商談フェーズ: "p10", 売上: "10", 原価: "2", 数量: "1", 有効: "yes" }),
  record({ $id: "3", 商談フェーズ: "p99", 売上: "99", 原価: "100", 数量: "1", 有効: "no" }),
  record({ $id: "4", 商談フェーズ: "p100", 売上: "100", 原価: "99", 数量: "1", 有効: "yes" }),
  record({ $id: "5", 商談フェーズ: "p905", 売上: "9050000", 原価: "50", 数量: "1", 有効: "yes" }),
  record({ $id: "6", 商談フェーズ: "p207", 売上: "20700000", 原価: "60", 数量: "1", 有効: "yes" }),
];

interface TestClient extends KintoneClient {
  readonly getCalls: Array<{ app: number; fields: string[] }>;
}

function client(recordsByApp: Record<number, KintoneRecord[]> = { 100: sales }): TestClient {
  const getCalls: Array<{ app: number; fields: string[] }> = [];
  return {
    getCalls,
    async getRecords(params) {
      getCalls.push({ app: params.app, fields: [...params.fields] });
      const rows = recordsByApp[params.app] ?? [];
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: rows.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) {
      const schemaRows = appId === 100 ? sales : (recordsByApp[appId] ?? []);
      const codes = new Set(schemaRows.flatMap((row) => Object.keys(row)));
      return [...codes]
        .filter((code) => !code.startsWith("$"))
        .map((code) => ({
          code,
          label: code,
          fieldType: ["売上", "原価", "数量"].includes(code) ? "NUMBER" : "SINGLE_LINE_TEXT",
        }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

let cacheSequence = 0;

async function run(sql: string, currentClient = client()): Promise<SelectResult> {
  return await execute(sql, currentClient, { cacheContext: `b187-${cacheSequence++}` }) as SelectResult;
}

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

describe("B187 HAVING-only aggregate materialization", () => {
  test.each([
    [">", 9], ["<", 9],
    [">", 10], ["<", 10],
    [">", 99], ["<", 99],
    [">", 100], ["<", 100],
    [">", 9050000], ["<", 9050000],
    [">", 20700000], ["<", 20700000],
  ] as const)("SELECT 非掲出 SUM の %s %s は掲出形と同じ行集合になる", async (operator, threshold) => {
    const prefix = "SELECT 商談フェーズ, COUNT(*) AS n";
    const suffix = ` FROM APP100 GROUP BY 商談フェーズ HAVING SUM(売上) ${operator} ${threshold} ORDER BY 商談フェーズ`;
    const hidden = await run(prefix + suffix);
    const visible = await run(`${prefix}, SUM(売上) AS s${suffix}`);

    expect(hidden.rows).toEqual(visible.rows.map(({ s: _s, ...row }) => row));
    expect(hidden.columns).toEqual(["商談フェーズ", "n"]);
    expect(hidden.rows.every((row) => Object.keys(row).sort().join(",") === "n,商談フェーズ")).toBe(true);
    expect(hidden.warnings).toEqual([]);
  });

  test("複数集計・集計算術・CASE 引数・文字列関数で包んだ集計を再帰的に実体化する", async () => {
    const multiple = await run(
      "SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ " +
      "HAVING SUM(売上) > 1 AND COUNT(数量) < 5 ORDER BY 商談フェーズ"
    );
    expect(multiple.rows).toHaveLength(6);
    expect(multiple.warnings).toEqual([]);

    const arithmetic = await run(
      "SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ " +
      "HAVING SUM(売上) - SUM(原価) > 0 ORDER BY 商談フェーズ"
    );
    expect(arithmetic.rows.map((row) => row.商談フェーズ)).toEqual(["p10", "p100", "p207", "p9", "p905"]);
    expect(arithmetic.warnings).toEqual([]);

    const caseArgument = await run(
      "SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ " +
      "HAVING SUM(CASE WHEN 有効='yes' THEN 売上 ELSE 0 END) > 99 ORDER BY 商談フェーズ"
    );
    expect(caseArgument.rows.map((row) => row.商談フェーズ)).toEqual(["p100", "p207", "p905"]);
    expect(caseArgument.warnings).toEqual([]);

    const stringWrapper = await run(
      "SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ " +
      "HAVING FORMAT(SUM(売上),'0') = '100'"
    );
    expect(stringWrapper.rows).toEqual([{ 商談フェーズ: "p100", n: "1" }]);
    expect(stringWrapper.warnings).toEqual([]);
  });

  test("GROUP BY なしの HAVING は従来どおり parser が拒否し、0 行入力は警告を出さない", async () => {
    await expect(run("SELECT COUNT(*) AS n FROM APP100 HAVING SUM(売上) > 9"))
      .rejects.toThrow("文の区切りには ; が必要です");

    const empty = await run(
      "SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ HAVING SUM(売上) > 9",
      client({ 100: [] })
    );
    expect(empty).toMatchObject({ columns: ["商談フェーズ", "n"], rows: [], warnings: [] });
  });

  test("LEFT JOIN 不一致側の SUM を SELECT 掲出形と同じ値で HAVING 評価する", () => {
    const tables = () => new Map<string | null, KintoneRecord[]>([
      ["a", [record({ 区分: "matched" }), record({ 区分: "missing" })]],
      ["b", [record({ 区分: "matched", 売上: "10" })]],
    ]);
    const result = runFullScan({
      stmt: parse(
        "SELECT a.区分, COUNT(*) AS n FROM APP1 a LEFT JOIN APP2 b ON a.区分=b.区分 " +
        "GROUP BY a.区分 HAVING SUM(b.売上) <= 0 ORDER BY a.区分"
      ),
      tables: tables(),
    });
    expect(result.rows).toEqual([{ 区分: "missing", n: "1" }]);

    const visible = runFullScan({
      stmt: parse(
        "SELECT a.区分, SUM(b.売上) AS s FROM APP1 a LEFT JOIN APP2 b ON a.区分=b.区分 " +
        "GROUP BY a.区分 ORDER BY a.区分"
      ),
      tables: tables(),
    });
    expect(visible.rows).toEqual([
      { 区分: "matched", s: "10" },
      { 区分: "missing", s: "0" },
    ]);
  });

  test("CTE と一時テーブルの executeStatement 経路でも同じ HAVING 専用集計を使う", async () => {
    const cte = await run(
      "WITH source AS (SELECT 商談フェーズ, 売上 FROM APP100) " +
      "SELECT 商談フェーズ, COUNT(*) AS n FROM source GROUP BY 商談フェーズ " +
      "HAVING SUM(売上) > 99 ORDER BY 商談フェーズ"
    );
    expect(cte.rows.map((row) => row.商談フェーズ)).toEqual(["p100", "p207", "p905"]);
    expect(cte.warnings).toEqual([]);

    const batch = await executeBatch(
      "CREATE TEMP TABLE #source AS SELECT 商談フェーズ, 売上 FROM APP100;" +
      "SELECT 商談フェーズ, COUNT(*) AS n FROM #source GROUP BY 商談フェーズ " +
      "HAVING SUM(売上) > 99 ORDER BY 商談フェーズ",
      client(),
      { cacheContext: `b187-temp-${cacheSequence++}` }
    );
    const temp = batch.statements[1].result as SelectResult;
    expect(temp.rows).toEqual(cte.rows);
    expect(temp.warnings).toEqual([]);
  });

  test("ROLLUP の各 grouping set で HAVING 専用 SUM を評価する", async () => {
    const result = await run(
      "SELECT 商談フェーズ, GROUPING(商談フェーズ) AS g, COUNT(*) AS n FROM APP100 " +
      "GROUP BY ROLLUP(商談フェーズ) HAVING SUM(売上) > 99 " +
      "ORDER BY GROUPING(商談フェーズ), 商談フェーズ"
    );
    expect(result.rows).toEqual([
      { 商談フェーズ: "p100", g: "0", n: "1" },
      { 商談フェーズ: "p207", g: "0", n: "1" },
      { 商談フェーズ: "p905", g: "0", n: "1" },
      { 商談フェーズ: "", g: "1", n: "6" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("SELECT 掲出形の結果・警告を維持し、HAVING 専用集計を出力へ漏らさない", async () => {
    const hidden = await run(
      "SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ HAVING SUM(売上) > 9050000"
    );
    expect(hidden).toMatchObject({
      columns: ["商談フェーズ", "n"],
      rows: [{ 商談フェーズ: "p207", n: "1" }],
      warnings: [],
    });

    const visible = await run(
      "SELECT 商談フェーズ, COUNT(*) AS n, SUM(売上) AS s FROM APP100 " +
      "GROUP BY 商談フェーズ HAVING SUM(売上) > 9050000"
    );
    expect(visible).toMatchObject({
      columns: ["商談フェーズ", "n", "s"],
      rows: [{ 商談フェーズ: "p207", n: "1", s: "20700000" }],
      warnings: [],
    });
  });

  test("HAVING 専用集計で records GET の回数・取得列を増やさない", async () => {
    const hiddenClient = client();
    const visibleClient = client();
    await run(
      "SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ HAVING SUM(売上) > 9",
      hiddenClient
    );
    await run(
      "SELECT 商談フェーズ, COUNT(*) AS n, SUM(売上) AS s FROM APP100 GROUP BY 商談フェーズ HAVING SUM(売上) > 9",
      visibleClient
    );
    expect(hiddenClient.getCalls).toEqual(visibleClient.getCalls);
    expect(hiddenClient.getCalls).toHaveLength(1);
  });

  test("文書例を実行でき、EXPLAIN の reason と取得列は掲出形と同じ", async () => {
    const documented = await run(
      "SELECT 商談フェーズ, COUNT(*) AS 件数 FROM APP100 GROUP BY 商談フェーズ " +
      "HAVING SUM(売上) > 1000000 ORDER BY 商談フェーズ"
    );
    expect(documented).toMatchObject({
      columns: ["商談フェーズ", "件数"],
      rows: [
        { 商談フェーズ: "p207", 件数: "1" },
        { 商談フェーズ: "p905", 件数: "1" },
      ],
      warnings: [],
    });

    const hidden = await run(
      "EXPLAIN SELECT 商談フェーズ, COUNT(*) AS n FROM APP100 GROUP BY 商談フェーズ HAVING SUM(売上) > 9"
    );
    const visible = await run(
      "EXPLAIN SELECT 商談フェーズ, COUNT(*) AS n, SUM(売上) AS s FROM APP100 " +
      "GROUP BY 商談フェーズ HAVING SUM(売上) > 9"
    );
    const relevant = (result: SelectResult) => result.rows
      .map((row) => String(row.plan).trim())
      .filter((line) => line.startsWith("reason:") || line.startsWith("fields:"));
    expect(relevant(hidden)).toEqual(relevant(visible));
    expect(relevant(hidden)).toContain("reason:        GROUP BY あり, 集計関数（COUNT / SUM 等）あり");
    expect(relevant(hidden).some((line) => line.includes("商談フェーズ") && line.includes("売上"))).toBe(true);
  });
});
