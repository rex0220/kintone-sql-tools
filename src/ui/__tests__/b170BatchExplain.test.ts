import type { KintoneClient } from "../../execute";
import { buildPluginBatchExplainPlans } from "../batchExplain";

const client: KintoneClient = {
  async getRecords() { throw new Error("records API must not be called"); },
  async openCursor() { throw new Error("cursor API must not be called"); },
  async postRecords() { throw new Error("write API must not be called"); },
  async putRecords() { throw new Error("write API must not be called"); },
  async deleteRecords() { throw new Error("write API must not be called"); },
  async getApps() { return []; },
  async getFields() { return []; },
  async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
  async getProcessStatuses() { return { enable: false, states: null }; },
};

test("E-6 plugin batch EXPLAIN reaches shared default as-of injection", async () => {
  const plans = await buildPluginBatchExplainPlans(
    "-- @ksql dialect: 1\nSELECT @NOW() AS n; SELECT @MONTH_START() AS m;",
    client,
    {
      maxRecords: 10_000,
      cursorMaxActive: 2,
      importEnabled: false,
      recursiveCteMaxDepth: 100,
      recursiveCteMaxRows: 10_000,
      recursiveCteMaxExpansions: 100_000,
    }
  );
  expect(plans.statementCount).toBe(2);
});

test("B173 AC-17/21: plugin batch EXPLAIN は条件 1・2 を対象外にして文・データ適格性を表示する", async () => {
  const getFields = jest.fn(async () => [
    { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", isUnique: true },
  ]);
  const plans = await buildPluginBatchExplainPlans(
    "SELECT key FROM APP1 WHERE key > 'A';" +
      "UPSERT INTO APP1 (key) VALUES ('B') ON DUPLICATE (key)",
    { ...client, getFields },
    {
      maxRecords: 10_000,
      cursorMaxActive: 2,
      importEnabled: false,
      recursiveCteMaxDepth: 100,
      recursiveCteMaxRows: 10_000,
      recursiveCteMaxExpansions: 100_000,
    }
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toContain("native UPSERT statement/data eligibility: ELIGIBLE");
  expect(text).toContain("native UPSERT execution surface: NOT_APPLICABLE");
  expect(getFields).toHaveBeenCalledTimes(1);
});
