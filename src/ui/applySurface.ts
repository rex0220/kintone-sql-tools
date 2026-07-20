import type { ExecuteOptions, Statement } from "../core";

export type PluginApplyOptions = Pick<
  ExecuteOptions,
  "allowApplyMutation" | "dmlMaxRows" | "dmlMaxSubtableRows"
>;

/** Plugin は APPLY にだけ固定 100/500（親/子）と mutation capability を公開する。 */
export function resolvePluginApplyOptions(statements: readonly Statement[]): PluginApplyOptions {
  const applyUpdates = statements.filter((statement): statement is Extract<Statement, { type: "UPDATE" }> =>
    statement.type === "UPDATE" && (statement.applyBlocks?.length ?? 0) > 0
  );
  if (applyUpdates.length === 0) return {};
  // Phase 15b opens only the core capability. Until Phase 16c can render the
  // prepared collection detail, plugin mutation remains fail-closed.
  const containsMutation = applyUpdates.some((statement) =>
    statement.validateOnly !== true
    && statement.applyBlocks!.every((block) => block.targetKind === "SUBTABLE")
  );
  return {
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 500,
    ...(containsMutation ? { allowApplyMutation: true } : {}),
  };
}
