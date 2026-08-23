// B172: /flow 公開面から maxRecords / tempTableMaxRows を渡したら効くことの固定。
// 依頼 F-3（ksql-flow）は「公開オプションに読取上限の変更手段が無い」を前提にしていたが、
// 実測では v3.69.0 から配線済み。型と配線だけでなく「渡したら効く」をここで固定する。
import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  type FlowKintoneClient,
} from "../index";

function makeRecords(count: number) {
  return Array.from({ length: count }, (_v, i) => ({
    $id: { value: String(i + 1) },
    顧客コード: { value: `C${i % 5}` },
    金額: { value: "10" },
  }));
}

function mockClient(records: ReturnType<typeof makeRecords>): FlowKintoneClient {
  return {
    async getRecords(params) {
      if (params.totalCount) return { records: [], totalCount: String(records.length) };
      // fetchAll の $id シーク＋ limit/offset ページングを尊重する
      const cursorMatch = /\$id > (\d+)/.exec(params.query);
      const pageMatch = /limit (\d+) offset (\d+)/.exec(params.query);
      const cursorId = cursorMatch ? Number(cursorMatch[1]) : 0;
      const limit = pageMatch ? Number(pageMatch[1]) : 500;
      const offset = pageMatch ? Number(pageMatch[2]) : 0;
      const filtered = records
        .filter((record) => Number(record.$id.value) > cursorId)
        .sort((a, b) => Number(a.$id.value) - Number(b.$id.value));
      return { records: filtered.slice(offset, offset + limit) };
    },
    async openCursor() {
      return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} };
    },
    async postRecords(params) { return { ids: params.records.map((_r, i) => String(i + 1)) }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "顧客コード", label: "顧客コード", fieldType: "SINGLE_LINE_TEXT" },
        { code: "金額", label: "金額", fieldType: "NUMBER" },
      ];
    },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  };
}

const GROUP_BY_SCRIPT = `-- @ksql dialect: 1
SELECT 顧客コード, SUM(金額) AS 計 FROM APP1 GROUP BY 顧客コード;`;

const TEMP_TABLE_SCRIPT = `-- @ksql dialect: 1
CREATE TEMP TABLE #t AS SELECT 顧客コード, 金額 FROM APP1;
SELECT 顧客コード, SUM(金額) AS 計 FROM #t GROUP BY 顧客コード;`;

async function runScript(
  script: string,
  client: FlowKintoneClient,
  options: { maxRecords?: number; tempTableMaxRows?: number }
) {
  const { statements, meta } = parseScript(script);
  const ctx = createExecutionContext({ client, statements, meta, ...options });
  try {
    const results = [];
    for (const stmt of statements) results.push(await executeStatement(stmt, ctx));
    return results;
  } finally {
    await disposeExecutionContext(ctx);
  }
}

test("未指定時は既定 10,000 で GROUP BY が明示エラー停止する（10,001 件）", async () => {
  const results = await runScript(GROUP_BY_SCRIPT, mockClient(makeRecords(10_001)), {});
  expect(results[0].status).toBe("error");
  expect(results[0].error?.code).toBe("FetchAllLimitError");
});

test("maxRecords を下げると効く（25 件 vs maxRecords=10）＝配線の証明", async () => {
  const results = await runScript(GROUP_BY_SCRIPT, mockClient(makeRecords(25)), { maxRecords: 10 });
  expect(results[0].status).toBe("error");
  expect(results[0].error?.code).toBe("FetchAllLimitError");
});

test("maxRecords を上げると既定超の GROUP BY が完走し集計値も正しい（10,001 件 vs maxRecords=25000）", async () => {
  const results = await runScript(GROUP_BY_SCRIPT, mockClient(makeRecords(10_001)), { maxRecords: 25_000 });
  expect(results[0].status).toBe("success");
  const rows = (results[0].result as { rows: Array<Record<string, unknown>> }).rows;
  expect(rows).toHaveLength(5);
  const total = rows.reduce((sum, row) => sum + Number(row["計"]), 0);
  expect(total).toBe(100_010);
});

test("maxRecords 引き上げだけでは temp 実体化が既定 10,000 で止まる（独立性・F-3 の見ていない穴）", async () => {
  const results = await runScript(TEMP_TABLE_SCRIPT, mockClient(makeRecords(10_001)), { maxRecords: 25_000 });
  expect(results[0].status).toBe("error");
  expect(results[0].error?.message).toMatch(/10000/);
  // 後続文は前文失敗でスキップされる
  expect(results[1].status).toBe("skipped");
});

test("maxRecords と tempTableMaxRows を両方揃えると temp 経由でも完走する", async () => {
  const results = await runScript(
    TEMP_TABLE_SCRIPT,
    mockClient(makeRecords(10_001)),
    { maxRecords: 25_000, tempTableMaxRows: 25_000 }
  );
  expect(results[0].status).toBe("success");
  expect(results[0].rowCount).toBe(10_001);
  expect(results[1].status).toBe("success");
});

test("explainScript も maxRecords を受け取り解決する（3 面同値の explain 面）", async () => {
  const result = await explainScript(GROUP_BY_SCRIPT, {
    client: mockClient(makeRecords(25)),
    maxRecords: 25_000,
  });
  expect(result.statementCount).toBe(1);
  expect(result.statements[0].plan.length).toBeGreaterThan(0);
});
