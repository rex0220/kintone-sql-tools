import { buildBatchExplainPlans, resolveBatchVariableReferences, type KintoneClient } from "../execute";
import { asOfVariableName } from "../core/asOfClock";
import { parseSqlStatementsForScript } from "../core/sql";

const client: KintoneClient = {
  async getRecords() { return { records: [] }; },
  async openCursor() { return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} }; },
  async postRecords() { return { ids: [] }; },
  async putRecords() {},
  async deleteRecords() {},
  async getApps() { return []; },
  async getFields() { return []; },
  async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
  async getProcessStatuses() { return { enable: false, states: null }; },
};

test("E-6 buildBatchExplainPlans injects four as-of values once", async () => {
  await expect(buildBatchExplainPlans(
    "-- @ksql dialect: 1\nSELECT @NOW() AS n; SELECT @MONTH_START() AS m;",
    client,
    undefined,
    "b170-as-of",
    10_000,
    2,
    false,
    100,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new Date("2026-08-21T12:34:56.000Z"),
    "UTC"
  )).resolves.toMatchObject({ statementCount: 2 });
});

test("B171: EXPLAIN は INSERT VALUES の as-of 4関数を解決して計画化する", async () => {
  const result = await buildBatchExplainPlans(
    "-- @ksql dialect: 1\nINSERT INTO APP1 (n,d,m,nm) VALUES (@NOW(),@TODAY(),@MONTH_START(),@NEXT_MONTH_START())",
    client,
    undefined,
    "b171-insert-values-as-of",
    10_000,
    2,
    false,
    100,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new Date("2026-08-21T18:00:00.123Z"),
    "Asia/Tokyo"
  );
  expect(result).toMatchObject({ statementCount: 1, statements: [{ type: "INSERT" }] });
  expect(JSON.stringify(result)).not.toContain("\u0000");
});

test("E-6 missing internal as-of variable never exposes the U+0000 name", () => {
  const statement = parseSqlStatementsForScript(
    "-- @ksql dialect: 1\nSELECT @NOW() AS captured"
  ).statements[0];
  let message = "";
  try {
    resolveBatchVariableReferences(statement, new Map());
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("@NOW() などの as-of 関数");
  expect(message).not.toContain("\u0000");
  expect(message).not.toContain(asOfVariableName("NOW"));
});
