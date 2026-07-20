import type {
  ApplyBlock,
  ApplyOperation,
  InsertStatement,
  Statement,
  UpdateStatement,
  WhereExpr,
} from "../types/ast";

export type ApplyScopeVersion = "v1" | "v1.1" | "v1.2" | "phase10a" | "phase11" | "phase12" | "phase13a";
export type ApplyExecutionPhase = "phase10a" | "phase10b" | "phase10c" | "phase10d" | "phase11" | "phase12" | "phase13a" | "phase13b";

const APPLY_SYNTAX_CAPABILITIES: Readonly<Record<ApplyScopeVersion, {
  readonly operations: ReadonlySet<ApplyOperation["kind"]>;
  readonly insert: boolean;
  readonly multipleBlocks: boolean;
  readonly multipleParents: boolean;
  readonly idxSelectors: boolean;
  readonly expectRows: boolean;
  readonly updateFrom: boolean;
  readonly check: boolean;
  readonly onErrorSkip: boolean;
  readonly rejectLimit: boolean;
}>> = Object.freeze({
  v1: Object.freeze({
    operations: new Set<ApplyOperation["kind"]>(["PATCH"]),
    insert: false,
    multipleBlocks: false,
    multipleParents: false,
    idxSelectors: false,
    expectRows: false,
    updateFrom: false,
    check: false,
    onErrorSkip: false,
    rejectLimit: false,
  }),
  "v1.1": Object.freeze({
    operations: new Set<ApplyOperation["kind"]>(["PATCH", "APPEND"]),
    insert: false,
    multipleBlocks: true,
    multipleParents: false,
    idxSelectors: false,
    expectRows: false,
    updateFrom: false,
    check: false,
    onErrorSkip: false,
    rejectLimit: false,
  }),
  "v1.2": Object.freeze({
    operations: new Set<ApplyOperation["kind"]>(["PATCH", "APPEND", "REMOVE"]),
    insert: false,
    multipleBlocks: true,
    multipleParents: false,
    idxSelectors: false,
    expectRows: false,
    updateFrom: false,
    check: false,
    onErrorSkip: false,
    rejectLimit: false,
  }),
  phase10a: Object.freeze({
    operations: new Set<ApplyOperation["kind"]>(["PATCH", "APPEND", "REMOVE"]),
    insert: false,
    multipleBlocks: true,
    multipleParents: true,
    idxSelectors: false,
    expectRows: false,
    updateFrom: false,
    check: false,
    onErrorSkip: false,
    rejectLimit: false,
  }),
  phase11: Object.freeze({
    operations: new Set<ApplyOperation["kind"]>(["PATCH", "APPEND", "REMOVE"]),
    insert: false,
    multipleBlocks: true,
    multipleParents: true,
    idxSelectors: true,
    expectRows: false,
    updateFrom: false,
    check: false,
    onErrorSkip: false,
    rejectLimit: false,
  }),
  phase12: Object.freeze({
    operations: new Set<ApplyOperation["kind"]>(["PATCH", "APPEND", "REMOVE"]),
    insert: false,
    multipleBlocks: true,
    multipleParents: true,
    idxSelectors: true,
    expectRows: true,
    updateFrom: false,
    check: false,
    onErrorSkip: false,
    rejectLimit: false,
  }),
  phase13a: Object.freeze({
    operations: new Set<ApplyOperation["kind"]>(["PATCH", "APPEND", "REMOVE"]),
    insert: true,
    multipleBlocks: true,
    multipleParents: true,
    idxSelectors: true,
    expectRows: true,
    updateFrom: false,
    check: false,
    onErrorSkip: false,
    rejectLimit: false,
  }),
});

const APPLY_EXECUTION_CAPABILITIES: Readonly<Record<ApplyExecutionPhase, {
  readonly multipleParentPreflight: boolean;
  readonly internalPreparedWrite: boolean;
  readonly publicMultipleParentWrite: boolean;
  readonly insertWrite: boolean;
}>> = Object.freeze({
  phase10a: Object.freeze({ multipleParentPreflight: false, internalPreparedWrite: false, publicMultipleParentWrite: false, insertWrite: false }),
  phase10b: Object.freeze({ multipleParentPreflight: true, internalPreparedWrite: false, publicMultipleParentWrite: false, insertWrite: false }),
  phase10c: Object.freeze({ multipleParentPreflight: true, internalPreparedWrite: true, publicMultipleParentWrite: false, insertWrite: false }),
  phase10d: Object.freeze({ multipleParentPreflight: true, internalPreparedWrite: true, publicMultipleParentWrite: true, insertWrite: false }),
  phase11: Object.freeze({ multipleParentPreflight: true, internalPreparedWrite: true, publicMultipleParentWrite: true, insertWrite: false }),
  phase12: Object.freeze({ multipleParentPreflight: true, internalPreparedWrite: true, publicMultipleParentWrite: true, insertWrite: false }),
  phase13a: Object.freeze({ multipleParentPreflight: true, internalPreparedWrite: true, publicMultipleParentWrite: true, insertWrite: false }),
  phase13b: Object.freeze({ multipleParentPreflight: true, internalPreparedWrite: true, publicMultipleParentWrite: true, insertWrite: false }),
});

let activeVersion: ApplyScopeVersion = "v1";

function unsupported(feature: string): never {
  throw new Error(`UnsupportedError: APPLY ${activeVersion} scope does not support ${feature}`);
}

/* The active version is scoped to a synchronous validator invocation. */
function withVersion<T>(version: ApplyScopeVersion, run: () => T): T {
  const previous = activeVersion;
  activeVersion = version;
  try { return run(); } finally { activeVersion = previous; }
}

type StatementWithApply = UpdateStatement | InsertStatement;

function statementWithApply(statement: Statement): StatementWithApply | null {
  const target = statement.type === "EXPLAIN" ? statement.query : statement;
  if (target.type === "UPDATE" || target.type === "INSERT") {
    return target.applyBlocks?.length ? target : null;
  }
  return null;
}

/**
 * Phase 1 の明示 capability 集合。将来 node を AST に保持したまま、
 * v1 でレビュー済みの構文だけを実行入口へ通す。
 */
export function assertApplyScope(version: ApplyScopeVersion, statement: Statement): void {
  return withVersion(version, () => assertApplyScopeForCapabilities(statement, APPLY_SYNTAX_CAPABILITIES[version]));
}

function assertApplyScopeForCapabilities(
  statement: Statement,
  capabilities: (typeof APPLY_SYNTAX_CAPABILITIES)[ApplyScopeVersion]
): void {
  const applyStatement = statementWithApply(statement);
  if (applyStatement === null) return;
  const blocks = applyStatement.applyBlocks!;

  const seen = new Set<string>();
  for (const block of blocks) {
    const key = block.field;
    if (seen.has(key)) {
      throw new Error(`ArgumentError: APPLY ${activeVersion} scope allows only one block for table ${block.field}`);
    }
    seen.add(key);
  }
  if (!capabilities.multipleBlocks && blocks.length !== 1) unsupported("multiple APPLY blocks in this phase");
  if (applyStatement.type === "INSERT") {
    assertInsertApplyScope(applyStatement, blocks, capabilities);
    return;
  }
  const update = applyStatement;
  if (update.subtableCode) unsupported("a subtable UPDATE as the parent statement in this phase");
  if (!capabilities.updateFrom && update.from != null) unsupported("UPDATE ... FROM in this phase");
  if (!capabilities.check && update.checkGroups?.length) unsupported("CHECK in this phase");
  if (!capabilities.onErrorSkip && update.onErrorSkip) unsupported("ON ERROR SKIP in this phase");
  if (!capabilities.rejectLimit && update.rejectLimit != null) unsupported("REJECT LIMIT in this phase");
  assertSafeParentWhere(update.where, capabilities.multipleParents);

  for (const block of blocks) {
    for (const operation of block.operations) {
      if (!capabilities.operations.has(operation.kind)) unsupported(`${operation.kind} in this phase`);
      if (operation.kind === "APPEND") {
        for (const field of operation.fields) assertSafeChildField(field, "APPEND targets");
        assertSafeApplyNode(operation.values, "APPEND values");
        continue;
      }
      if (operation.kind === "REMOVE") {
        if (!capabilities.expectRows && operation.expectRows) unsupported("EXPECT ROWS in this phase");
        if (operation.selector.kind === "WHERE") {
          assertSafeChildPredicate(operation.selector.where, capabilities.idxSelectors);
        }
        continue;
      }
      if (operation.kind !== "PATCH") continue;
      if (!capabilities.expectRows && operation.expectRows) unsupported("EXPECT ROWS in this phase");
      if (operation.assignments.length === 0) unsupported("an empty PATCH operation in this phase");
      for (const assignment of operation.assignments) {
        if (assignment.field.startsWith("_") || assignment.field.startsWith("$")) {
          throw new Error(`ArgumentError: APPLY assignment target ${assignment.field} is a system field.`);
        }
        if (assignment.field.includes(".")) {
          unsupported("parent or qualified PATCH targets in this phase");
        }
      }
      assertSafeApplyNode(operation.assignments, "PATCH assignments");
      if (operation.selector.kind === "WHERE") {
        assertSafeChildPredicate(operation.selector.where, capabilities.idxSelectors);
      }
    }
  }
}

function assertInsertApplyScope(
  insert: InsertStatement,
  blocks: readonly ApplyBlock[],
  capabilities: (typeof APPLY_SYNTAX_CAPABILITIES)[ApplyScopeVersion]
): void {
  if (!capabilities.insert) unsupported("INSERT in this phase");
  if (insert.subtableCode) unsupported("a subtable INSERT as the parent statement in this phase");
  if (!capabilities.check && insert.checkGroups?.length) unsupported("CHECK in this phase");
  if (!capabilities.onErrorSkip && insert.onErrorSkip) unsupported("ON ERROR SKIP in this phase");
  if (!capabilities.rejectLimit && insert.rejectLimit != null) unsupported("REJECT LIMIT in this phase");
  for (const block of blocks) {
    for (const operation of block.operations) {
      if (operation.kind !== "APPEND") unsupported(`${operation.kind} for INSERT in this phase`);
      for (const field of operation.fields) assertSafeChildField(field, "APPEND targets");
      assertSafeApplyNode(operation.values, "APPEND values");
    }
  }
}

/** Compatibility export for callers that explicitly need the original v1 gate. */
export function assertApplyV1Scope(statement: Statement): void {
  assertApplyScope("v1", statement);
}

/** Claude §13.4-1 の0件分岐に使う、構文的な単一 `$id=<正整数>` 完全一致判定。 */
export function isSinglePositiveRecordIdWhere(where: WhereExpr): boolean {
  if (where.type !== "BINARY"
    || where.op !== "="
    || where.left.type !== "FIELD"
    || where.left.tableAlias !== null
    || where.left.field !== "$id"
    || where.right.type !== "NUMBER") {
    return false;
  }
  const raw = where.right.raw ?? String(where.right.value);
  return /^\d+$/.test(raw) && where.right.value > 0 && Number.isSafeInteger(where.right.value);
}

/**
 * syntax と execution を分ける Phase 10a の公開 mutation gate。
 * EXPLAIN は mutation routing ではないため対象外。
 */
export function assertApplyExecutionScope(phase: ApplyExecutionPhase, statement: Statement): void {
  const capabilities = APPLY_EXECUTION_CAPABILITIES[phase];
  if (statement.type === "INSERT" && statement.applyBlocks?.length) {
    if (statement.validateOnly !== true && !capabilities.insertWrite) {
      throw new Error(`UnsupportedError: APPLY ${formatExecutionPhase(phase)} INSERT execution is not connected`);
    }
    return;
  }
  if (statement.type !== "UPDATE" || !statement.applyBlocks?.length) return;
  if (!capabilities.multipleParentPreflight && !isSinglePositiveRecordIdWhere(statement.where)) {
    throw new Error(`UnsupportedError: APPLY ${formatExecutionPhase(phase)} execution does not support multiple-parent APPLY`);
  }
}

/** Public multiple-parent mutation is available only from Phase 10d onward. */
export function assertApplyPublicWriteScope(phase: ApplyExecutionPhase, statement: Statement): void {
  if (statement.type !== "UPDATE" || !statement.applyBlocks?.length
    || isSinglePositiveRecordIdWhere(statement.where)) return;
  if (!APPLY_EXECUTION_CAPABILITIES[phase].publicMultipleParentWrite) {
    throw new Error(`UnsupportedError: APPLY ${formatExecutionPhase(phase)} public multiple-parent write is not connected`);
  }
}

/** Only Phase 10c's internal prepared writer may cross the core write gate. */
export function assertApplyInternalWriteScope(phase: ApplyExecutionPhase): void {
  if (!APPLY_EXECUTION_CAPABILITIES[phase].internalPreparedWrite) {
    throw new Error(`UnsupportedError: APPLY ${formatExecutionPhase(phase)} internal prepared write is not available`);
  }
}

function formatExecutionPhase(phase: ApplyExecutionPhase): string {
  return `Phase ${phase.slice("phase".length)}`;
}

function assertSafeParentWhere(where: WhereExpr, multipleParents: boolean): void {
  if (isSinglePositiveRecordIdWhere(where)) return;
  if (where.type === "BINARY" && where.op === "=" && where.left.type === "FIELD"
    && where.left.tableAlias === null && where.left.field === "$id") {
    unsupported("a parent $id that is not a positive safe integer in this phase");
  }
  if (!multipleParents) {
    unsupported("a parent WHERE other than the single condition $id = <positive safe integer> in this phase");
  }
  assertSafeParentPredicateNode(where);
}

function assertSafeParentPredicateNode(node: unknown): void {
  if (Array.isArray(node)) {
    for (const value of node) assertSafeParentPredicateNode(value);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const item = node as Record<string, unknown>;
  const type = typeof item["type"] === "string" ? item["type"] : null;
  const op = typeof item["op"] === "string" ? item["op"] : null;
  if (op === "KLIKE" || op === "NOT_KLIKE") unsupported("KLIKE in parent WHERE");
  if (type === "SELECT" || type === "SCALAR_SUBQUERY" || type === "SUBQUERY_IN_LIST" || type === "EXISTS") {
    unsupported("subqueries in parent WHERE");
  }
  if (type === "WINDOW_COL" || type === "AGGREGATE" || type === "AGG_REF" || type === "AGG_ARITH"
    || type === "ARITH_AGG_COL") unsupported("aggregate or window expressions in parent WHERE");
  if ((type === "FIELD" || type === "FIELD_REF") && typeof item["field"] === "string"
    && /^(count|sum|avg|min|max|group_concat)\s*\(/i.test(item["field"])) {
    unsupported("aggregate or window expressions in parent WHERE");
  }
  if (type === "KINTONE_FUNC") unsupported("non-deterministic kintone functions in parent WHERE");
  for (const value of Object.values(item)) assertSafeParentPredicateNode(value);
}

function assertSafeChildPredicate(where: WhereExpr, idxSelectors: boolean): void {
  assertSafeApplyNode(where, "child row selectors", idxSelectors);
}

function assertSafeApplyNode(node: unknown, context: string, allowIdx = false): void {
  if (Array.isArray(node)) {
    for (const value of node) assertSafeApplyNode(value, context, allowIdx);
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
    assertSafeChildField(field, context, allowIdx);
  }
  if (type === "FIELD_REF") assertSafeChildField(item["field"], context, allowIdx);
  if (kind === "PATCH" || kind === "APPEND" || kind === "REMOVE") {
    // Operation kinds are checked by the capability set above, not by traversal.
    return;
  }
  for (const value of Object.values(item)) assertSafeApplyNode(value, context, allowIdx);
}

function assertSafeChildField(field: unknown, context: string, allowIdx = false): void {
  if (typeof field !== "string") return;
  const lower = field.toLowerCase();
  if (lower === "_idx" && !allowIdx) unsupported(`_idx in ${context}`);
  if (lower.startsWith("_p.") || lower.includes(".")) unsupported(`parent or qualified field references in ${context}`);
  if (/^(count|sum|avg|min|max|group_concat)\s*\(/i.test(field)) {
    unsupported(`aggregate expressions in ${context}`);
  }
}
