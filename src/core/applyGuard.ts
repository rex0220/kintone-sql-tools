import type { Statement } from "../types/ast";

/** APPLY を持ち得る文種を一箇所で列挙し、将来の UPSERT 分岐追加も fail-closed にする。 */
export function statementHasApplyBlocks(statement: Statement): boolean {
  const target = statement.type === "EXPLAIN" ? statement.query : statement;
  if (target.type !== "UPDATE" && target.type !== "INSERT" && target.type !== "UPSERT") return false;
  const candidate = target as unknown as Record<string, unknown>;
  return ["applyBlocks", "onInsertApplyBlocks", "onUpdateApplyBlocks"]
    .some((key) => Array.isArray(candidate[key]) && candidate[key].length > 0);
}
