import { execute, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../../execute";
import { completeInputReasons } from "../../core/dmlGuard";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function client(records: KintoneRecord[]): KintoneClient & { fields: string[][] } {
  const fields: string[][] = [];
  const metadata: KintoneFieldInfo[] = [
    { code: "会社名", label: "会社名", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
    { code: "地域", label: "地域", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
    { code: "売上", label: "売上", fieldType: "NUMBER", sortKind: "number" },
  ];
  return {
    fields,
    async getRecords(params) {
      fields.push([...(params.fields ?? [])]);
      return { records };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return metadata; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

function parse(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

const rows = [
  record({ 会社名: "A", 地域: "東", 売上: "9" }),
  record({ 会社名: "A", 地域: "東", 売上: "10" }),
  record({ 会社名: "B", 地域: "東", 売上: "99" }),
  record({ 会社名: "B", 地域: "東", 売上: "100" }),
  record({ 会社名: "C", 地域: "西", 売上: "9050000" }),
  record({ 会社名: "D", 地域: "西", 売上: "20700000" }),
  record({ 会社名: "E", 地域: "西", 売上: "9050000" }),
];

const oneStage =
  "SELECT 会社名, SUM(売上) AS 売上合計, " +
  "RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位, " +
  "SUM(SUM(売上)) OVER () AS 総計, " +
  "SUM(SUM(売上)) OVER (ORDER BY SUM(売上) DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS 累計 " +
  "FROM APP100 GROUP BY 会社名 ORDER BY 売上合計 DESC, 会社名";

const twoStage =
  "WITH base AS (SELECT 会社名, SUM(売上) AS 売上合計 FROM APP100 GROUP BY 会社名) " +
  "SELECT 会社名, 売上合計, RANK() OVER (ORDER BY 売上合計 DESC) AS 順位, " +
  "SUM(売上合計) OVER () AS 総計, " +
  "SUM(売上合計) OVER (ORDER BY 売上合計 DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS 累計 " +
  "FROM base ORDER BY 売上合計 DESC, 会社名";

test("B184-A: 1段版は2段版と行・値・列順・warningsが一致する", async () => {
  const direct = await execute(oneStage, client(rows), { cacheContext: "b184a-one" }) as SelectResult;
  const staged = await execute(twoStage, client(rows), { cacheContext: "b184a-two" }) as SelectResult;
  expect(direct).toMatchObject({ rows: staged.rows, columns: staged.columns, warnings: staged.warnings });
  expect(direct.rows.map((row) => [row.会社名, row.売上合計, row.順位])).toEqual([
    ["D", "20700000", "1"],
    ["C", "9050000", "2"],
    ["E", "9050000", "2"],
    ["B", "199", "4"],
    ["A", "19", "5"],
  ]);
});

test("B184-A: 集計別名・集計式・グループキー・SELECT外集計を解決する", async () => {
  const result = await execute(
    "SELECT 地域, 会社名, SUM(売上) AS 売上合計, " +
      "RANK() OVER (PARTITION BY 地域 ORDER BY 売上合計 DESC) AS alias_rank, " +
      "RANK() OVER (ORDER BY SUM(売上) DESC) AS expression_rank, " +
      "RANK() OVER (ORDER BY COUNT(*) DESC, 会社名) AS hidden_rank " +
      "FROM APP100 GROUP BY 地域, 会社名 ORDER BY expression_rank, 会社名",
    client(rows),
    { cacheContext: "b184a-reference-forms" }
  ) as SelectResult;
  expect(result.columns).toEqual(["地域", "会社名", "売上合計", "alias_rank", "expression_rank", "hidden_rank"]);
  expect(result.rows[0]).toMatchObject({ 会社名: "D", alias_rank: "1", expression_rank: "1", hidden_rank: "4" });
  expect(result.rows.every((row) => !("COUNT(*)" in row))).toBe(true);
});

test("B184-A: HAVING後のグループ行だけをウィンドウ評価する", async () => {
  const result = await execute(
    "SELECT 会社名, SUM(売上) AS total, RANK() OVER (ORDER BY SUM(売上) DESC) AS r, " +
      "SUM(SUM(売上)) OVER (ORDER BY SUM(売上) DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running " +
      "FROM APP100 GROUP BY 会社名 HAVING SUM(売上) >= 199 ORDER BY r, 会社名",
    client(rows),
    { cacheContext: "b184a-having" }
  ) as SelectResult;
  expect(result.rows.map((row) => [row.会社名, row.r, row.running])).toEqual([
    ["D", "1", "20700000"], ["C", "2", "29750000"], ["E", "2", "38800000"], ["B", "4", "38800199"],
  ]);
});

test("B184-A: LAGの引数に同一SELECTの集計式を指定できる", async () => {
  const result = await execute(
    "SELECT 会社名, SUM(売上) AS total, LAG(SUM(売上)) OVER (ORDER BY 会社名) AS previous " +
      "FROM APP100 GROUP BY 会社名 ORDER BY 会社名",
    client(rows),
    { cacheContext: "b184a-lag-aggregate" }
  ) as SelectResult;
  expect(result.rows.map((row) => [row.会社名, row.total, row.previous])).toEqual([
    ["A", "19", ""], ["B", "199", "19"], ["C", "9050000", "199"],
    ["D", "20700000", "9050000"], ["E", "9050000", "20700000"],
  ]);
});

test("B184-A: ウィンドウ内の未グループ化フィールドと曖昧な別名を既存診断で拒否する", async () => {
  await expect(execute(
    "SELECT 会社名, SUM(売上) AS total, RANK() OVER (ORDER BY 売上) AS r FROM APP100 GROUP BY 会社名",
    client(rows),
    { cacheContext: "b184a-non-grouped" }
  )).rejects.toThrow(/B65_NON_GROUPED_DEPENDENCY/);
  await expect(execute(
    "SELECT 会社名, SUM(売上) AS x, COUNT(*) AS x, RANK() OVER (ORDER BY x) AS r FROM APP100 GROUP BY 会社名",
    client(rows),
    { cacheContext: "b184a-ambiguous-alias" }
  )).rejects.toThrow(/B65_NON_GROUPED_DEPENDENCY/);
});

test("B184-A: ROLLUPのGROUPING()をPARTITION BYとORDER BYで評価する", async () => {
  const result = await execute(
    "SELECT 地域, GROUPING(地域) AS g, SUM(売上) AS total, " +
      "RANK() OVER (PARTITION BY GROUPING(地域) ORDER BY GROUPING(地域), SUM(売上) DESC) AS r " +
      "FROM APP100 GROUP BY ROLLUP(地域) ORDER BY g, 地域",
    client(rows),
    { cacheContext: "b184a-rollup" }
  ) as SelectResult;
  expect(result.rows.map((row) => [row.地域, row.g, row.r])).toEqual([
    ["東", "0", "2"], ["西", "0", "1"], ["", "1", "1"],
  ]);
});

test("B184-A: 同一SELECTの全GROUP BYキーが既定RANGEのORDER BYにあれば警告を抑止する", async () => {
  const warned = await execute(
    "SELECT 会社名, SUM(売上) AS total, SUM(SUM(売上)) OVER (ORDER BY total) AS running FROM APP100 GROUP BY 会社名",
    client(rows),
    { cacheContext: "b184a-range-warn" }
  ) as SelectResult;
  const unique = await execute(
    "SELECT 会社名, SUM(売上) AS total, SUM(SUM(売上)) OVER (ORDER BY total, 会社名) AS running FROM APP100 GROUP BY 会社名",
    client(rows),
    { cacheContext: "b184a-range-unique" }
  ) as SelectResult;
  expect(warned.warnings).toHaveLength(1);
  expect(unique.warnings).toEqual([]);
});

test("B184-A: complete input理由を併記し、ウィンドウ集計のためだけに取得列を増やさない", async () => {
  const ranking = parse("SELECT 会社名, SUM(売上) AS total, RANK() OVER (ORDER BY SUM(売上)) AS r FROM APP100 GROUP BY 会社名");
  expect([...completeInputReasons(ranking)]).toEqual(expect.arrayContaining(["GROUP_BY", "AGGREGATE", "WINDOW_ORDER"]));
  const aggregate = parse("SELECT 会社名, SUM(売上) AS total, SUM(SUM(売上)) OVER () AS grand FROM APP100 GROUP BY 会社名");
  expect([...completeInputReasons(aggregate)]).toEqual(expect.arrayContaining(["GROUP_BY", "AGGREGATE", "AGGREGATE_WINDOW"]));
  const one = client(rows);
  const base = client(rows);
  await execute(oneStage, one, { cacheContext: "b184a-fields-one" });
  await execute("SELECT 会社名, SUM(売上) AS 売上合計 FROM APP100 GROUP BY 会社名", base, { cacheContext: "b184a-fields-base" });
  expect(new Set(one.fields[0])).toEqual(new Set(base.fields[0]));
});

test("B184-A: DISTINCT・LIMIT・ウィンドウ別名ORDER BYをGROUP BY後に適用する", async () => {
  const result = await execute(
    "SELECT DISTINCT 地域, RANK() OVER (ORDER BY SUM(売上) DESC) AS r " +
      "FROM APP100 GROUP BY 地域 ORDER BY r LIMIT 1",
    client(rows),
    { cacheContext: "b184a-distinct-limit" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ 地域: "西", r: "1" }]);
});

test("B184-A: 言語リファレンス掲載例を実行できる", async () => {
  const result = await execute(
    "SELECT 会社名, SUM(売上) AS 売上合計, RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位 " +
      "FROM APP100 GROUP BY 会社名 ORDER BY 順位, 会社名",
    client(rows),
    { cacheContext: "b184a-doc-example" }
  ) as SelectResult;
  expect(result.rows[0]).toMatchObject({ 会社名: "D", 売上合計: "20700000", 順位: "1" });
});
