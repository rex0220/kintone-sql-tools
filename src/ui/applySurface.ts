import type { ExecuteOptions, Statement } from "../core";

export type PluginApplyOptions = Pick<
  ExecuteOptions,
  "allowApplyMutation" | "dmlMaxRows" | "dmlMaxSubtableRows"
>;

/** Plugin は APPLY にだけ最大取得件数由来の親/子ガードと mutation capability を公開する。 */
export function resolvePluginApplyOptions(
  statements: readonly Statement[],
  maxRecords?: number
): PluginApplyOptions {
  const applyStatements = statements.filter(isPluginApplyStatement);
  if (applyStatements.length === 0) return {};
  const containsMutation = applyStatements.some((statement) => statement.validateOnly !== true);
  const effectiveMaxRecords = typeof maxRecords === "number"
    && Number.isInteger(maxRecords)
    && maxRecords > 0
    ? maxRecords
    : 0;
  return {
    dmlMaxRows: Math.max(100, effectiveMaxRecords),
    dmlMaxSubtableRows: Math.max(500, effectiveMaxRecords),
    ...(containsMutation ? { allowApplyMutation: true } : {}),
  };
}

export function isPluginApplyStatement(
  statement: Statement
): statement is Extract<Statement, { type: "UPDATE" | "INSERT" | "UPSERT" }> {
  if (statement.type === "UPDATE" || statement.type === "INSERT") {
    return (statement.applyBlocks?.length ?? 0) > 0;
  }
  return statement.type === "UPSERT"
    && ((statement.onInsertApplyBlocks?.length ?? 0) > 0 || (statement.onUpdateApplyBlocks?.length ?? 0) > 0);
}
