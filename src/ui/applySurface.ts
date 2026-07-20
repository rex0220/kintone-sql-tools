import type { ExecuteOptions, Statement } from "../core";

export type PluginApplyOptions = Pick<
  ExecuteOptions,
  "allowApplyMutation" | "dmlMaxRows" | "dmlMaxSubtableRows"
>;

/** Plugin は APPLY にだけ固定 100/500（親/子）と mutation capability を公開する。 */
export function resolvePluginApplyOptions(statements: readonly Statement[]): PluginApplyOptions {
  const applyStatements = statements.filter(isPluginApplyStatement);
  if (applyStatements.length === 0) return {};
  const containsMutation = applyStatements.some((statement) => statement.validateOnly !== true);
  return {
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 500,
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
