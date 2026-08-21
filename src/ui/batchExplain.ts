import { buildBatchExplainPlans } from "../core";
import type { KintoneClient } from "../core";

/** プラグインの batch EXPLAIN 到達点。DOM に依存させず surface test 可能に保つ。 */
export function buildPluginBatchExplainPlans(
  sql: string,
  client: KintoneClient,
  options: {
    maxRecords: number;
    cursorMaxActive: number;
    importEnabled: boolean;
    recursiveCteMaxDepth: number;
    recursiveCteMaxRows: number;
    recursiveCteMaxExpansions: number;
  }
) {
  return buildBatchExplainPlans(
    sql,
    client,
    undefined,
    "batch-explain",
    options.maxRecords,
    options.cursorMaxActive,
    options.importEnabled,
    100,
    undefined,
    true,
    options.recursiveCteMaxDepth,
    options.recursiveCteMaxRows,
    options.recursiveCteMaxExpansions
  );
}
