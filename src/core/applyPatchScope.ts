import type {
  ApplyOperation,
  Statement,
  UpdateStatement,
  WhereExpr,
} from "../types/ast";

const V1_CAPABILITIES = Object.freeze({
  operations: new Set<ApplyOperation["kind"]>(["PATCH"]),
  multipleBlocks: false,
  expectRows: false,
  updateFrom: false,
  check: false,
  onErrorSkip: false,
  rejectLimit: false,
});

function unsupported(feature: string): never {
  throw new Error(`UnsupportedError: APPLY v1 scope does not support ${feature}`);
}

function updateWithApply(statement: Statement): UpdateStatement | null {
  if (statement.type === "UPDATE") return statement.applyBlocks?.length ? statement : null;
  if (statement.type === "EXPLAIN" && statement.query.type === "UPDATE") {
    return statement.query.applyBlocks?.length ? statement.query : null;
  }
  return null;
}

/**
 * Phase 1 の明示 capability 集合。将来 node を AST に保持したまま、
 * v1 でレビュー済みの構文だけを実行入口へ通す。
 */
export function assertApplyV1Scope(statement: Statement): void {
  const update = updateWithApply(statement);
  if (update === null) return;
  const blocks = update.applyBlocks!;

  const seen = new Set<string>();
  for (const block of blocks) {
    const key = block.field;
    if (seen.has(key)) {
      throw new Error(`ArgumentError: APPLY v1 scope allows only one block for table ${block.field}`);
    }
    seen.add(key);
  }
  if (!V1_CAPABILITIES.multipleBlocks && blocks.length !== 1) unsupported("multiple APPLY blocks in this phase");
  if (update.subtableCode) unsupported("a subtable UPDATE as the parent statement in this phase");
  if (!V1_CAPABILITIES.updateFrom && update.from != null) unsupported("UPDATE ... FROM in this phase");
  if (!V1_CAPABILITIES.check && update.checkGroups?.length) unsupported("CHECK in this phase");
  if (!V1_CAPABILITIES.onErrorSkip && update.onErrorSkip) unsupported("ON ERROR SKIP in this phase");
  if (!V1_CAPABILITIES.rejectLimit && update.rejectLimit != null) unsupported("REJECT LIMIT in this phase");
  assertSinglePositiveRecordId(update.where);

  for (const operation of blocks[0].operations) {
    if (!V1_CAPABILITIES.operations.has(operation.kind)) unsupported(`${operation.kind} in this phase`);
    if (operation.kind !== "PATCH") continue;
    if (!V1_CAPABILITIES.expectRows && operation.expectRows) unsupported("EXPECT ROWS in this phase");
    if (operation.assignments.length === 0) unsupported("an empty PATCH operation in this phase");
    for (const assignment of operation.assignments) {
      if (assignment.field.startsWith("_") || assignment.field.includes(".")) {
        unsupported("system, parent, or qualified PATCH targets in this phase");
      }
    }
    assertSafeApplyNode(operation.assignments, "PATCH assignments");
    if (operation.selector.kind === "WHERE") assertSafeChildPredicate(operation.selector.where);
  }
}

function assertSinglePositiveRecordId(where: WhereExpr): void {
  if (where.type !== "BINARY"
    || where.op !== "="
    || where.left.type !== "FIELD"
    || where.left.tableAlias !== null
    || where.left.field !== "$id"
    || where.right.type !== "NUMBER") {
    unsupported("a parent WHERE other than the single condition $id = <positive safe integer> in this phase");
  }
  const raw = where.right.raw ?? String(where.right.value);
  if (!/^\d+$/.test(raw)
    || where.right.value <= 0
    || !Number.isSafeInteger(where.right.value)) {
    unsupported("a parent $id that is not a positive safe integer in this phase");
  }
}

function assertSafeChildPredicate(where: WhereExpr): void {
  assertSafeApplyNode(where, "child row selectors");
}

function assertSafeApplyNode(node: unknown, context: string): void {
  if (Array.isArray(node)) {
    for (const value of node) assertSafeApplyNode(value, context);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const item = node as Record<string, unknown>;
  const type = typeof item["type"] === "string" ? item["type"] : null;
  const kind = typeof item["kind"] === "string" ? item["kind"] : null;
  const op = typeof item["op"] === "string" ? item["op"] : null;

  if (op === "KLIKE" || op === "NOT_KLIKE") unsupported(`KLIKE in ${context}`);
  if (type === "SELECT" || type === "SCALAR_SUBQUERY" || type === "SUBQUERY_IN_LIST" || type === "EXISTS") {
    unsupported(`subqueries in ${context}`);
  }
  if (type === "WINDOW_COL" || type === "AGGREGATE" || type === "AGG_REF" || type === "AGG_ARITH"
    || type === "ARITH_AGG_COL") unsupported(`aggregate or window expressions in ${context}`);
  if (type === "KINTONE_FUNC") unsupported(`non-deterministic kintone functions in ${context}`);

  if (type === "FIELD") {
    const alias = item["tableAlias"];
    const field = item["field"];
    if (alias !== null && alias !== undefined) unsupported(`qualified or parent field references in ${context}`);
    assertSafeChildField(field, context);
  }
  if (type === "FIELD_REF") assertSafeChildField(item["field"], context);
  if (kind === "PATCH" || kind === "APPEND" || kind === "REMOVE") {
    // Operation kinds are checked by the capability set above, not by traversal.
    return;
  }
  for (const value of Object.values(item)) assertSafeApplyNode(value, context);
}

function assertSafeChildField(field: unknown, context: string): void {
  if (typeof field !== "string") return;
  const lower = field.toLowerCase();
  if (lower === "_idx") unsupported(`_idx in ${context}`);
  if (lower.startsWith("_p.") || lower.includes(".")) unsupported(`parent or qualified field references in ${context}`);
  if (/^(count|sum|avg|min|max|group_concat)\s*\(/i.test(field)) {
    unsupported(`aggregate expressions in ${context}`);
  }
}

/** Phase 1 executor gate. Call only after assertApplyV1Scope. */
export function assertApplyExecutionEnabled(statement: Statement): void {
  if (updateWithApply(statement) !== null) {
    throw new Error("UnsupportedError: APPLY execution is not enabled in this phase");
  }
}
