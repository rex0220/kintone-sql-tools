import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  executeBatch,
  type BatchExecuteResult,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import { UNRESOLVED_AGGREGATE_COMPARISON_WARNING } from "../engine/process";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

const records = [
  record({ $id: "1", 区分: "A", 名前: "O'Reilly", 数量: "2" }),
  record({ $id: "2", 区分: "A", 名前: "O'Reilly", 数量: "2" }),
  record({ $id: "3", 区分: "A", 名前: "other", 数量: "1" }),
];

function client(): KintoneClient {
  return {
    async getRecords(params) {
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: records.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected mutation"); },
    async putRecords() { throw new Error("unexpected mutation"); },
    async deleteRecords() { throw new Error("unexpected mutation"); },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "区分", label: "区分", fieldType: "SINGLE_LINE_TEXT" },
        { code: "名前", label: "名前", fieldType: "SINGLE_LINE_TEXT" },
        { code: "数量", label: "数量", fieldType: "NUMBER" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

function selectResult(batch: BatchExecuteResult): SelectResult {
  expect(batch.ok).toBe(true);
  const result = batch.statements[batch.statements.length - 1]?.result;
  expect(result?.type).toBe("SELECT");
  return result as SelectResult;
}

async function batchSelect(sql: string, cacheContext: string): Promise<SelectResult> {
  return selectResult(await executeBatch(sql, client(), { cacheContext }));
}

const variableArg = "CASE WHEN 名前=@target THEN 数量 ELSE 0 END";
const literalArg = "CASE WHEN 名前='missing' THEN 数量 ELSE 0 END";

describe("B164 comparison aggregate references", () => {
  test("起票逐語相当: CASE probe・HAVING・SELECT 値・リテラル全列一致", async () => {
    const columns =
      `SUM(${variableArg}) AS 合計, ` +
      `CASE WHEN SUM(${variableArg})=0 THEN 'ZERO' ELSE 'NONZERO' END AS 判定, ` +
      `CASE WHEN SUM(${variableArg})>=0 THEN 'NONNEG' ELSE 'NEG' END AS 符号, ` +
      `CASE WHEN SUM(${variableArg}) < -1.79e308 THEN 'INFINITY' ELSE 'FINITE' END AS 有限性`;
    const variable = await batchSelect(
      `DECLARE @target='missing'; SELECT 区分, ${columns} FROM APP164 GROUP BY 区分 ` +
        `HAVING SUM(${variableArg})=0`,
      "b164-acceptance-variable"
    );
    const literal = await execute(
      `SELECT 区分, ${columns.split(variableArg).join(literalArg)} FROM APP164 GROUP BY 区分 ` +
        `HAVING SUM(${literalArg})=0`,
      client(),
      { cacheContext: "b164-acceptance-literal" }
    ) as SelectResult;

    expect(variable.rows).toEqual([{ 区分: "A", 合計: "0", 判定: "ZERO", 符号: "NONNEG", 有限性: "FINITE" }]);
    expect(variable.rows).toEqual(literal.rows);
    expect(variable.columns).toEqual(literal.columns);
    expect(variable.warnings).toEqual([]);
  });

  test("AND・OR・NOT の複数 occurrence と引用符エスケープ変数", async () => {
    const result = await batchSelect(
      `DECLARE @target='O''Reilly'; SELECT SUM(${variableArg}) AS 合計, ` +
        `CASE WHEN SUM(${variableArg})=4 AND (SUM(${variableArg})>3 OR NOT (SUM(${variableArg})<4)) ` +
        `THEN 'OK' ELSE 'NG' END AS 判定 FROM APP164 GROUP BY 区分 HAVING SUM(${variableArg})=4`,
      "b164-logical-quote"
    );
    expect(result.rows).toEqual([{ 合計: "4", 判定: "OK" }]);
    expect(result.warnings).toEqual([]);
  });

  test.each([
    "COUNT", "SUM", "AVG", "MAX", "MIN", "GROUP_CONCAT",
    "STDDEV_POP", "STDDEV_SAMP", "VAR_POP", "VAR_SAMP", "MEDIAN", "MODE",
  ])("%s の直接比較と DISTINCT は解決後の式を参照する", async (func) => {
    const varExpr = `CASE WHEN 名前=@target THEN 数量 ELSE 0 END`;
    const litExpr = `CASE WHEN 名前='O''Reilly' THEN 数量 ELSE 0 END`;
    const op = func === "GROUP_CONCAT" ? "!=''" : ">=0";
    const variableDistinct = func === "MODE" ? "" : ` AND ${func}(DISTINCT ${varExpr})${op}`;
    const literalDistinct = func === "MODE" ? "" : ` AND ${func}(DISTINCT ${litExpr})${op}`;
    const variable = await batchSelect(
      `DECLARE @target='O''Reilly'; SELECT ` +
        `CASE WHEN ${func}(${varExpr})${op}${variableDistinct} ` +
        `THEN 'OK' ELSE 'NG' END AS 判定 FROM APP164`,
      `b164-all-${func}`
    );
    const literal = await execute(
      `SELECT CASE WHEN ${func}(${litExpr})${op}${literalDistinct} ` +
        `THEN 'OK' ELSE 'NG' END AS 判定 FROM APP164`,
      client(),
      { cacheContext: `b164-all-${func}-literal` }
    ) as SelectResult;
    expect(variable.rows).toEqual([{ 判定: "OK" }]);
    expect(variable.rows).toEqual(literal.rows);
    expect(variable.warnings).toEqual([]);
  });

  test("GROUPING SETS の各 set で CASE/HAVING の直接比較を解決する", async () => {
    const result = await batchSelect(
      `DECLARE @target='missing'; SELECT 区分, GROUPING(区分) AS g, SUM(${variableArg}) AS 合計, ` +
        `CASE WHEN SUM(${variableArg})=0 THEN 'ZERO' ELSE 'NONZERO' END AS 判定 ` +
        `FROM APP164 GROUP BY GROUPING SETS ((区分),()) HAVING SUM(${variableArg})=0 ` +
        `ORDER BY GROUPING(区分), 区分`,
      "b164-grouping-sets"
    );
    expect(result.rows).toEqual([
      { 区分: "A", g: "0", 合計: "0", 判定: "ZERO" },
      { 区分: "", g: "1", 合計: "0", 判定: "ZERO" },
    ]);
  });

  test("集計算術式と THEN/ELSE 集計の既存経路を変えない", async () => {
    const result = await batchSelect(
      `DECLARE @target='O''Reilly'; SELECT SUM(${variableArg})+1 AS 算術, ` +
        `CASE WHEN COUNT(*)>0 THEN SUM(${variableArg}) ELSE AVG(${variableArg}) END AS 分岐 FROM APP164`,
      "b164-unchanged-paths"
    );
    expect(result.rows).toEqual([{ 算術: "5", 分岐: "4" }]);
    expect(result.warnings).toEqual([]);
  });

  test("HAVING 非掲出は現状 0 行のまま新診断を返す", async () => {
    const result = await batchSelect(
      `DECLARE @target='O''Reilly'; SELECT 区分, COUNT(*) AS 件数 FROM APP164 GROUP BY 区分 ` +
        `HAVING SUM(${variableArg})=4`,
      "b164-unlisted-having"
    );
    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([UNRESOLVED_AGGREGATE_COMPARISON_WARNING]);
    expect(result.warnings?.join(" ")).not.toMatch(/aggregateRef|synthetic|lookup|key/i);
  });

  test("ORDER BY alias・window・UNION 各枝を回帰させない", async () => {
    const ordered = await batchSelect(
      `DECLARE @target='O''Reilly'; SELECT 区分, SUM(${variableArg}) AS 合計, ` +
        `CASE WHEN SUM(${variableArg})=4 THEN 'OK' ELSE 'NG' END AS 判定 ` +
        `FROM APP164 GROUP BY 区分 ORDER BY 合計 DESC`,
      "b164-order"
    );
    expect(ordered.rows).toEqual([{ 区分: "A", 合計: "4", 判定: "OK" }]);

    const window = await execute(
      "SELECT 区分, ROW_NUMBER() OVER (ORDER BY $id) AS rn FROM APP164 ORDER BY rn",
      client(),
      { cacheContext: "b164-window" }
    ) as SelectResult;
    expect(window.rows.map((row) => row.rn)).toEqual(["1", "2", "3"]);

    const union = await batchSelect(
      `DECLARE @target='missing'; ` +
        `SELECT CASE WHEN SUM(${variableArg})=0 THEN 'ZERO' ELSE 'NG' END AS 判定 FROM APP164 ` +
        `UNION ALL SELECT CASE WHEN SUM(${variableArg})=0 THEN 'ZERO' ELSE 'NG' END AS 判定 FROM APP164`,
      "b164-union"
    );
    expect(union.rows).toEqual([{ 判定: "ZERO" }, { 判定: "ZERO" }]);
    expect(union.warnings).toEqual([]);
  });
});
