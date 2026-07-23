import { execute, type KintoneClient, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([code, value]) => [code, { value }]));
}

function client(
  rows: KintoneRecord[],
  fieldTypes: Record<string, string> = {}
): KintoneClient & { recordCalls: number } {
  return {
    recordCalls: 0,
    async getRecords(params) {
      this.recordCalls++;
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: rows.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields() {
      const codes = new Set(rows.flatMap((row) => Object.keys(row)));
      Object.keys(fieldTypes).forEach((code) => codes.add(code));
      return [...codes]
        .filter((code) => !code.startsWith("$"))
        .map((code) => ({
          code,
          label: code,
          fieldType: fieldTypes[code] ?? "SINGLE_LINE_TEXT",
        }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const aggregateRows = [
  record({ $id: "1", 地域: "東", 状態: "受注", 金額: "1", 値: "1" }),
  record({ $id: "2", 地域: "東", 状態: "失注", 金額: "3", 値: "01" }),
  record({ $id: "3", 地域: "西", 状態: "受注", 金額: "10", 値: "10" }),
  record({ $id: "4", 地域: "西", 状態: "受注", 金額: "10", 値: "10" }),
  record({ $id: "5", 地域: "除外", 状態: "受注", 金額: "100", 値: "100" }),
];

test("B65-A01: B64 CASE 集計は set/bucket ごとに独立し grand total は WHERE 後の全入力", async () => {
  const result = await execute(
    "SELECT 地域, GROUPING(地域) AS g, " +
    "SUM(CASE WHEN 状態='受注' THEN 金額 ELSE 0 END) AS 受注額, " +
    "COUNT(CASE WHEN 状態='受注' THEN 1 END) AS 受注数 " +
    "FROM APP1 WHERE 地域!='除外' GROUP BY ROLLUP(地域) " +
    "ORDER BY GROUPING(地域), 地域",
    client(aggregateRows, { 金額: "NUMBER" }),
    { cacheContext: "b65-a01" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 地域: "東", g: "0", 受注額: "1", 受注数: "1" },
    { 地域: "西", g: "0", 受注額: "20", 受注数: "2" },
    { 地域: "", g: "1", 受注額: "21", 受注数: "3" },
  ]);
});

test("B65-A02: COUNT DISTINCT と数値 DISTINCT 統計は set 間で集合を共有しない", async () => {
  const result = await execute(
    "SELECT 地域, GROUPING(地域) AS g, COUNT(DISTINCT 値) AS text_distinct, " +
    "MEDIAN(DISTINCT 値) AS numeric_distinct_median " +
    "FROM APP1 WHERE 地域!='除外' GROUP BY ROLLUP(地域) " +
    "ORDER BY GROUPING(地域), 地域",
    client(aggregateRows, { 値: "NUMBER" }),
    { cacheContext: "b65-a02" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 地域: "東", g: "0", text_distinct: "2", numeric_distinct_median: "1" },
    { 地域: "西", g: "0", text_distinct: "1", numeric_distinct_median: "10" },
    { 地域: "", g: "1", text_distinct: "3", numeric_distinct_median: "5.5" },
  ]);
});

test("B65-A03: 全 B56 統計を各 set で評価し空集合規約を維持する", async () => {
  const rowsWithEmptyStatBucket = [
    ...aggregateRows,
    record({ $id: "6", 地域: "空", 状態: "失注", 金額: "7", 値: "7" }),
  ];
  const result = await execute(
    "SELECT 地域, GROUPING(地域) AS g, " +
    "STDDEV_POP(CASE WHEN 状態='受注' THEN 金額 END) AS sp, " +
    "STDDEV_SAMP(CASE WHEN 状態='受注' THEN 金額 END) AS ss, " +
    "VAR_POP(CASE WHEN 状態='受注' THEN 金額 END) AS vp, " +
    "VAR_SAMP(CASE WHEN 状態='受注' THEN 金額 END) AS vs, " +
    "MEDIAN(CASE WHEN 状態='受注' THEN 金額 END) AS med, " +
    "MODE(CASE WHEN 状態='受注' THEN 金額 END) AS mode " +
    "FROM APP1 WHERE 地域!='除外' GROUP BY ROLLUP(地域) " +
    "ORDER BY GROUPING(地域), 地域",
    client(rowsWithEmptyStatBucket, { 金額: "NUMBER" }),
    { cacheContext: "b65-a03-values" }
  ) as SelectResult;

  expect(result.rows.find((row) => row.地域 === "東")).toMatchObject({
    地域: "東", g: "0", sp: "0", ss: "", vp: "0", vs: "", med: "1", mode: "1",
  });
  expect(result.rows.find((row) => row.地域 === "西")).toMatchObject({
    地域: "西", g: "0", sp: "0", ss: "0", vp: "0", vs: "0", med: "10", mode: "10",
  });
  expect(result.rows.find((row) => row.地域 === "空")).toMatchObject({
    地域: "空", g: "0", sp: "", ss: "", vp: "", vs: "", med: "", mode: "",
  });
  expect(result.rows.find((row) => row.g === "1")).toMatchObject({
    地域: "", g: "1", med: "10", mode: "10",
  });
});

test("B65-A03: B56 非数値は fail-closed、完全入力 error は両 reason を併記する", async () => {
  await expect(execute(
    "SELECT 地域, VAR_POP(金額) AS variance FROM APP1 GROUP BY ROLLUP(地域)",
    client([record({ $id: "1", 地域: "東", 金額: "bad" })], { 金額: "NUMBER" }),
    { cacheContext: "b65-a03-nonnumeric" }
  )).rejects.toThrow(/ArgumentError:.*VAR_POP.*bad/);

  const overLimit = Array.from({ length: 101 }, (_, index) =>
    record({ $id: String(index + 1), 地域: `R${index}`, 金額: String(index) })
  );
  await expect(execute(
    "SELECT 地域, STDDEV_POP(金額) AS sd FROM APP1 GROUP BY ROLLUP(地域)",
    client(overLimit, { 金額: "NUMBER" }),
    {
      cacheContext: "b65-a03-reasons",
      maxRecords: 100,
      onLimitReached: "truncate",
    }
  )).rejects.toThrow(
    /complete input reason: GROUPING_SETS, STATISTICAL_AGGREGATE.*onLimit=truncate/
  );
});

test("B65-A04: HAVING は全 set 縦結合後に各行へ作用し未選択の直接集計は追加計算しない", async () => {
  const result = await execute(
    "SELECT 地域, GROUPING(地域) AS g, SUM(金額) AS total " +
    "FROM APP1 WHERE 地域!='除外' GROUP BY ROLLUP(地域) HAVING total >= 10 " +
    "ORDER BY GROUPING(地域), 地域",
    client(aggregateRows, { 金額: "NUMBER" }),
    { cacheContext: "b65-a04" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { 地域: "西", g: "0", total: "20" },
    { 地域: "", g: "1", total: "24" },
  ]);

  const direct = await execute(
    "SELECT 地域, GROUPING(地域) AS g, COUNT(*) AS n " +
    "FROM APP1 GROUP BY ROLLUP(地域) HAVING MEDIAN(金額) > 0",
    client(aggregateRows, { 金額: "NUMBER" }),
    { cacheContext: "b65-a04-direct" }
  ) as SelectResult;
  expect(direct.rows).toEqual([]);
});

test("B65-A05: HAVING GROUPING は records fetch 前の明示拒否を維持する", async () => {
  const mock = client(aggregateRows, { 金額: "NUMBER" });
  await expect(execute(
    "SELECT 地域, SUM(金額) FROM APP1 GROUP BY ROLLUP(地域) HAVING GROUPING(地域)=0",
    mock,
    { cacheContext: "b65-a05" }
  )).rejects.toThrow(/GROUPING\(\).*only allowed in SELECT/);
  expect(mock.recordCalls).toBe(0);
});
