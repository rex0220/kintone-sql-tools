import {
  execute, executeBatch, getSelectColumnMeta,
  type KintoneClient, type KintoneFieldInfo, type SelectResult,
} from "../../execute";
import { completeInputReasons } from "../../core/dmlGuard";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import { serializeCsvExport } from "../../export/csvSerializer";
import { Lexer } from "../../lexer/lexer";
import { Parser, WINDOW_RESULT_IN_EXPRESSION_MESSAGE } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function client(records: KintoneRecord[]): KintoneClient & { fields: string[][] } {
  const fields: string[][] = [];
  const metadata: KintoneFieldInfo[] = [
    { code: "$id", label: "$id", fieldType: "__ID__", sortKind: "number" },
    { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
    { code: "年月", label: "年月", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
    { code: "売上", label: "売上", fieldType: "NUMBER", sortKind: "number" },
    { code: "件数", label: "件数", fieldType: "NUMBER", sortKind: "number" },
    { code: "日付", label: "日付", fieldType: "DATE", sortKind: "string" },
    { code: "個数", label: "個数", fieldType: "NUMBER", sortKind: "number" },
    { code: "入出庫区分", label: "入出庫区分", fieldType: "DROP_DOWN", sortKind: "string" },
  ];
  return {
    fields,
    async getRecords(params) { fields.push([...(params.fields ?? [])]); return { records }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {}, async deleteRecords() {}, async getApps() { return []; },
    async getFields() { return metadata; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

const sales = [
  record({ $id: "1", 会社名: "A", 年月: "2026-01", 日付: "2026-01-01", 入出庫区分: "出庫", 個数: "9", 売上: "9", 件数: "9" }),
  record({ $id: "2", 会社名: "A", 年月: "2026-02", 日付: "2026-02-01", 入出庫区分: "出庫", 個数: "10", 売上: "10", 件数: "10" }),
  record({ $id: "3", 会社名: "B", 年月: "2026-03", 売上: "99", 件数: "99" }),
  record({ $id: "4", 会社名: "B", 年月: "2026-04", 売上: "100", 件数: "100" }),
  record({ $id: "5", 会社名: "C", 年月: "2026-05", 売上: "9050000", 件数: "9050000" }),
  record({ $id: "6", 会社名: "D", 年月: "2026-06", 売上: "20700000", 件数: "20700000" }),
  record({ $id: "7", 会社名: "E", 年月: "2026-07", 売上: "9050000", 件数: "9050000" }),
];

test("B184-B: 構成比・累積構成比・ABC の1段版を実行する", async () => {
  const sql = "SELECT 会社名, SUM(売上) AS 売上合計, RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位, " +
    "ROUND(SUM(売上) * 100.0 / SUM(SUM(売上)) OVER (), 1) AS 構成比, " +
    "ROUND(SUM(SUM(売上)) OVER (ORDER BY SUM(売上) DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) * 100.0 / SUM(SUM(売上)) OVER (), 1) AS 累積構成比, " +
    "CASE WHEN SUM(SUM(売上)) OVER (ORDER BY SUM(売上) DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) * 100.0 / SUM(SUM(売上)) OVER () <= 80 THEN 'A' " +
    "WHEN SUM(SUM(売上)) OVER (ORDER BY SUM(売上) DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) * 100.0 / SUM(SUM(売上)) OVER () <= 95 THEN 'B' ELSE 'C' END AS 区分 " +
    "FROM APP100 GROUP BY 会社名 ORDER BY 売上合計 DESC, 会社名";
  const result = await execute(sql, client(sales), { cacheContext: "b184b-abc" }) as SelectResult;
  const staged = await execute(
    "WITH base AS (SELECT 会社名, SUM(売上) AS 売上合計 FROM APP100 GROUP BY 会社名), " +
      "ranked AS (SELECT 会社名, 売上合計, RANK() OVER (ORDER BY 売上合計 DESC) AS 順位, " +
      "SUM(売上合計) OVER () AS 総計, " +
      "SUM(売上合計) OVER (ORDER BY 売上合計 DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS 累計 " +
      "FROM base) SELECT 会社名, 売上合計, 順位, ROUND(売上合計 * 100.0 / 総計, 1) AS 構成比, " +
      "ROUND(累計 * 100.0 / 総計, 1) AS 累積構成比, " +
      "CASE WHEN 累計 * 100.0 / 総計 <= 80 THEN 'A' WHEN 累計 * 100.0 / 総計 <= 95 THEN 'B' ELSE 'C' END AS 区分 " +
      "FROM ranked ORDER BY 売上合計 DESC, 会社名",
    client(sales), { cacheContext: "b184b-abc-staged" }
  ) as SelectResult;
  expect(result).toMatchObject({ rows: staged.rows, columns: staged.columns, warnings: staged.warnings });
  expect(result.columns).toEqual(["会社名", "売上合計", "順位", "構成比", "累積構成比", "区分"]);
  expect(result.rows.map((row) => [row.会社名, row.順位, row.区分])).toEqual([
    ["D", "1", "A"], ["C", "2", "A"], ["E", "2", "C"], ["B", "4", "C"], ["A", "5", "C"],
  ]);
  expect(parse(sql).hiddenWindows).toHaveLength(2);
});

test("B190: CTE を source にした非集計 SELECT で CASE 条件の左辺に隠し窓を置ける", async () => {
  // v3.81.0〜v3.82.0 は `unknown field code(s): __ksql_window_0 (base)` で落ちていた
  // （CASE 条件の左辺 FieldValue だけ hiddenWindowRef を取得列・B86 検査から除外していなかった）
  const c = client(sales);
  const result = await execute(
    "WITH base AS (SELECT 会社名, SUM(売上) AS 売上合計 FROM APP100 GROUP BY 会社名) " +
      "SELECT 会社名, CASE WHEN SUM(売上合計) OVER () = 0 THEN 0 " +
      "ELSE ROUND(売上合計 * 100.0 / SUM(売上合計) OVER (), 1) END AS 構成比, " +
      "CASE WHEN RANK() OVER (ORDER BY 売上合計 DESC) <= 2 THEN 'TOP' ELSE '-' END AS 区分 " +
      "FROM base ORDER BY 売上合計 DESC, 会社名",
    c, { cacheContext: "b190-cte" }
  ) as SelectResult;
  const staged = await execute(
    "WITH base AS (SELECT 会社名, SUM(売上) AS 売上合計 FROM APP100 GROUP BY 会社名), " +
      "ranked AS (SELECT 会社名, 売上合計, SUM(売上合計) OVER () AS 総計, RANK() OVER (ORDER BY 売上合計 DESC) AS 順位 FROM base) " +
      "SELECT 会社名, CASE WHEN 総計 = 0 THEN 0 ELSE ROUND(売上合計 * 100.0 / 総計, 1) END AS 構成比, " +
      "CASE WHEN 順位 <= 2 THEN 'TOP' ELSE '-' END AS 区分 " +
      "FROM ranked ORDER BY 売上合計 DESC, 会社名",
    client(sales), { cacheContext: "b190-cte-staged" }
  ) as SelectResult;
  expect(result.columns).toEqual(["会社名", "構成比", "区分"]);
  expect(result.rows).toEqual(staged.rows);
  expect(result.rows.map((row) => [row.会社名, row.構成比, row.区分])).toEqual([
    ["D", "53.4", "TOP"], ["C", "23.3", "TOP"], ["E", "23.3", "TOP"], ["B", "0", "-"], ["A", "0", "-"],
  ]);
  // 隠し窓の内部名は kintone の取得列（fields）に出さない
  expect(c.fields.flat().some((name) => name.startsWith("__ksql_window_"))).toBe(false);
});

test("B190: 一時テーブルを source にした非集計 SELECT でも CASE 条件の隠し窓が通る", async () => {
  const batch = await executeBatch(
    "CREATE TEMP TABLE #base AS SELECT 会社名, SUM(売上) AS 売上合計 FROM APP100 GROUP BY 会社名; " +
      "SELECT 会社名, CASE WHEN RANK() OVER (ORDER BY 売上合計 DESC) <= 2 THEN 'TOP' ELSE '-' END AS 区分 " +
      "FROM #base ORDER BY 売上合計 DESC, 会社名",
    client(sales), { cacheContext: "b190-temp" }
  );
  expect(batch.statements.map((s) => s.status)).toEqual(["success", "success"]);
  const result = batch.statements[1].result as SelectResult;
  expect(result.columns).toEqual(["会社名", "区分"]);
  expect(result.rows.map((row) => [row.会社名, row.区分])).toEqual([
    ["D", "TOP"], ["C", "TOP"], ["E", "TOP"], ["B", "-"], ["A", "-"],
  ]);
});

test("B184-B: LAG の算術・CASE・COALESCE・連結と複数の隠し窓を評価する", async () => {
  const result = await execute(
    "SELECT 年月, 件数 - LAG(件数) OVER (ORDER BY 年月) AS 前月差, " +
      "CASE WHEN LAG(件数) OVER (ORDER BY 年月) = '' THEN '' ELSE LAG(件数) OVER (ORDER BY 年月) END AS 前月, " +
      "COALESCE(LAG(件数) OVER (ORDER BY 年月), 0) AS 補完, " +
      "'x' || LEAD(件数) OVER (ORDER BY 年月) AS 次月文字 FROM APP100 ORDER BY 年月",
    client(sales), { cacheContext: "b184b-lag" }
  ) as SelectResult;
  expect(result.rows[0]).toMatchObject({ 前月差: "9", 前月: "", 補完: "0", 次月文字: "x10" });
  expect(result.rows[1]).toMatchObject({ 前月差: "1", 前月: "9", 補完: "9" });
});

test("B184-B: 非集計 SELECT、DISTINCT、CSV、column meta に隠し列を出さない", async () => {
  const result = await execute(
    "SELECT DISTINCT CASE WHEN 売上 - LAG(売上) OVER (ORDER BY $id) >= 0 THEN '同区分' ELSE '同区分' END AS 区分 FROM APP100",
    client(sales), { cacheContext: "b184b-outputs", captureColumnMeta: true }
  ) as SelectResult;
  expect(result.columns).toEqual(["区分"]);
  expect(result.rows).toEqual([{ 区分: "同区分" }]);
  expect(Object.keys(result.rows[0])).toEqual(["区分"]);
  expect(serializeCsvExport({ columns: result.columns, rows: result.rows, columnMeta: getSelectColumnMeta(result) }).text)
    .toBe("区分\r\n同区分\r\n");
  expect([...getSelectColumnMeta(result)!.keys()]).toEqual(["区分"]);
});

test("B184-B: 完全入力理由・取得列・意味型を引き継ぐ", async () => {
  const ranking = parse("SELECT 売上 - LAG(売上) OVER (ORDER BY $id) AS 差 FROM APP100");
  expect([...completeInputReasons(ranking)]).toContain("WINDOW_ORDER");
  const aggregate = parse("SELECT ROUND(SUM(売上) OVER () / 10, 1) AS 比率 FROM APP100");
  expect([...completeInputReasons(aggregate)]).toContain("AGGREGATE_WINDOW");
  const c = client(sales);
  const result = await execute(
    "SELECT COALESCE(LAG(件数) OVER (ORDER BY 年月), 0) AS n FROM APP100 ORDER BY n",
    c, { cacheContext: "b184b-semantics", captureColumnMeta: true }
  ) as SelectResult;
  expect(new Set(c.fields[0])).toEqual(new Set(["$id", "件数", "年月"]));
  expect(getSelectColumnMeta(result)?.get("n")?.sortKind).toBe("number");
  expect(result.rows.map((row) => row.n)).toEqual(["0", "9", "10", "99", "100", "9050000", "20700000"]);
});

test("B184-B: R16 掲載の1段版を実行する", async () => {
  const result = await execute(
    "SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数, " +
      "SUM(個数) - LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')) AS 前月差, " +
      "CASE WHEN LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')) = '' THEN '' " +
      "ELSE ROUND((SUM(個数) - LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m'))) * 100.0 " +
      "/ LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')), 1) END AS 前月比 " +
      "FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY DATE_FORMAT(日付, '%Y-%m') ORDER BY 年月",
    client(sales.slice(0, 2)), { cacheContext: "b184b-doc-r16" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { 年月: "2026-01", 出庫数: "9", 前月差: "9", 前月比: "" },
    { 年月: "2026-02", 出庫数: "10", 前月差: "1", 前月比: "11.1" },
  ]);
});

test.each([
  "SELECT x FROM APP1 WHERE SUM(x) OVER () > 0",
  "SELECT x FROM APP1 GROUP BY x HAVING SUM(x) OVER () > 0",
  "SELECT a.x FROM APP1 a JOIN APP2 b ON SUM(a.x) OVER () = b.x",
  "SELECT x FROM APP1 GROUP BY SUM(x) OVER ()",
  "SELECT x FROM APP1 ORDER BY SUM(x) OVER ()",
  "SELECT SUM(RANK() OVER ()) OVER () AS x FROM APP1",
])("B184-B: SELECT 式外または window 内 window は従来文言で拒否する: %s", (sql) => {
  expect(() => parse(sql)).toThrow(WINDOW_RESULT_IN_EXPRESSION_MESSAGE);
});
