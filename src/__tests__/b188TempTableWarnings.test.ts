import {
  BatchStatementResult,
  execute,
  executeBatch,
  KintoneClient,
  SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { buildBatchStatementSummary } from "../cli/index";
import { buildBatchEnvelope } from "../output/batchEnvelope";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

function makeClient(recordsByApp: Record<number, KintoneRecord[]> = {}): KintoneClient {
  return {
    async getRecords(params) { return { records: recordsByApp[params.app] ?? [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) { return { ids: params.records.map((_row, index) => String(index + 1)) }; },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields(appId) {
      const codes = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      if (appId === 200) codes.add("累計");
      if (appId === 101) codes.add("k");
      return [...codes].map((code) => ({
        code,
        label: code,
        fieldType: code === "$id" ? "RECORD_NUMBER" : code === "x" || code === "累計" ? "NUMBER" : "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

const rows = [
  record({ $id: "1", x: "10" }),
  record({ $id: "2", x: "10" }),
];
const selectSql = "SELECT SUM(x) OVER (ORDER BY x) AS 累計 FROM APP100";

test("B188: direct / CTE / CREATE TEMP で既定 RANGE 警告が出て、実体化文から後段へ重複しない", async () => {
  const direct = await execute(selectSql, makeClient({ 100: rows }), { cacheContext: "b188-direct" }) as SelectResult;
  const cte = await execute(
    `WITH t AS (${selectSql}) SELECT * FROM t`,
    makeClient({ 100: rows }),
    { cacheContext: "b188-cte" }
  ) as SelectResult;
  const batch = await executeBatch(
    `CREATE TEMP TABLE #t AS ${selectSql}; SELECT * FROM #t`,
    makeClient({ 100: rows }),
    { cacheContext: "b188-temp" }
  );

  expect(direct.warnings).toHaveLength(1);
  expect(cte.warnings).toHaveLength(1);
  expect(cte.warnings?.[0]).toContain("累計 は既定フレーム（RANGE）で評価されます。");
  expect(batch.statements[0].warnings).toEqual(cte.warnings);
  expect((batch.statements[1].result as SelectResult).warnings).toEqual([]);
  expect(batch.warnings).toEqual(cte.warnings);
  expect(batch.warnings?.filter((warning) => warning === cte.warnings?.[0])).toHaveLength(1);

  const envelope = buildBatchEnvelope(batch);
  expect(envelope.statements[0].warnings).toEqual(cte.warnings);
  expect(envelope.warnings).toEqual(cte.warnings);
  expect(buildBatchStatementSummary(batch.statements[0])).toContain(`warning=${cte.warnings?.[0]}`);
});

test("B188: 警告なしの CREATE TEMP は従来形のまま warnings を持たない", async () => {
  const batch = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT x FROM APP100; DROP TEMP TABLE #t",
    makeClient({ 100: rows }),
    { cacheContext: "b188-no-warning" }
  );
  expect(batch.statements[0]).toEqual({
    index: 0,
    type: "CREATE_TEMP_TABLE",
    status: "success",
    tempTable: "#t",
    rowCount: 2,
  });
  expect(batch.statements[0]).not.toHaveProperty("warnings");
});

test("B188: JOIN キー 300 件超の警告も CREATE TEMP 文へ伝播する", async () => {
  const source = Array.from({ length: 301 }, (_unused, index) =>
    record({ $id: String(index + 1), k: `K${index}` })
  );
  const batch = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT s.k FROM APP100 s INNER JOIN APP101 t ON s.k = t.k; DROP TEMP TABLE #t",
    makeClient({ 100: source, 101: [] }),
    { cacheContext: "b188-join-warning" }
  );
  expect(batch.statements[0].warnings).toContain(
    "JOINキーが 301 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 300 件）。"
  );
});

test.each([
  ["INSERT", `INSERT INTO APP200 (累計) ${selectSql}`],
  ["UPSERT", `UPSERT INTO APP200 (累計) ${selectSql} ON DUPLICATE (累計)`],
] as const)("B188: %s SELECT の source 警告を文へ伝播する", async (_label, sql) => {
  const batch = await executeBatch(sql, makeClient({ 100: rows, 200: [] }), {
    cacheContext: `b188-${_label.toLowerCase()}`,
  });
  expect(batch.statements[0].warnings?.[0]).toContain("累計 は既定フレーム（RANGE）で評価されます。");
  expect(batch.warnings).toEqual(batch.statements[0].warnings);
});

test("B188: SELECT だけのバッチでは全体 warnings に文ごとの SELECT 警告を二重に載せない（envelope 契約不変）", async () => {
  const batch = await executeBatch(
    `${selectSql}; SELECT x FROM APP100`,
    makeClient({ 100: rows }),
    { cacheContext: "b188-select-only" }
  );
  expect((batch.statements[0].result as SelectResult).warnings).toHaveLength(1);
  expect(batch.statements[0]).not.toHaveProperty("warnings");
  expect(batch.warnings).toBeUndefined();
  expect(buildBatchEnvelope(batch).warnings).toEqual([]);
});

test("B188: BatchStatementResult の warnings は任意プロパティ", () => {
  const unchanged: BatchStatementResult = { index: 0, type: "DROP_TEMP_TABLE", status: "success" };
  expect(unchanged).not.toHaveProperty("warnings");
});
