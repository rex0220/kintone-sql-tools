import type { KintoneFieldInfo } from "../execute";
import type { KintoneRecord, KintoneValue } from "../converter/dmlToKintone";
import {
  evaluateSubtableAssignmentValue,
  evaluateUpdateAssignmentValue,
  evalCaseWhenValue,
  toKintoneValue,
} from "../converter/dmlToKintone";
import { evalWhere, type FieldTypeResolver, type ProcessRow } from "../engine/evalWhere";
import type { AppendOperation, ExpectRowsGuard, FieldRef, InsertRow, PatchOperation, RemoveOperation, UpdateStatement, WhereExpr } from "../types/ast";

export interface ApplySnapshotRow {
  readonly id: string;
  readonly value: Readonly<Record<string, { readonly value: unknown }>>;
}

export interface ApplyPatchPayloadRow {
  readonly id?: string;
  readonly value?: Readonly<Record<string, { readonly value: unknown }>>;
}

export interface ApplyPatchPostImageRow {
  /** APPEND 行は PUT 成功前には未採番。Phase 2 の既存行では常に存在する。 */
  readonly id?: string;
  readonly value: Readonly<Record<string, { readonly value: unknown }>>;
}

interface ApplyPatchTablePlanBase {
  readonly table: string;
  readonly operations: readonly ApplyPatchOperationPlan[];
  /** Distinct existing/new child rows changed by this table plan. */
  readonly changedSubtableRows: number;
  readonly deletedRows: number;
  readonly snapshotRowIds: readonly string[];
  readonly payloadRows: readonly ApplyPatchPayloadRow[];
  readonly postImageRows: readonly ApplyPatchPostImageRow[];
}

export type ApplyPatchOperationPlan =
  | { readonly kind: "PATCH"; readonly matchedRows: number; readonly changedRows: number }
  | { readonly kind: "APPEND"; readonly addedRows: number }
  | { readonly kind: "REMOVE"; readonly removedRows: number };

export interface ApplyPatchOnlyTablePlan extends ApplyPatchTablePlanBase {
  readonly payloadShape: "PATCH_ONLY";
}

/** Phase 8 用の型境界。Phase 2 planner はこの shape を生成しない。 */
export interface ApplyFullSurvivorsTablePlan extends ApplyPatchTablePlanBase {
  readonly payloadShape: "FULL_SURVIVORS";
  readonly removedRowIds: readonly string[];
}

export type ApplyPatchTablePlan = ApplyPatchOnlyTablePlan | ApplyFullSurvivorsTablePlan;

export interface ApplyPatchPlan {
  readonly app: number;
  readonly parentId: number;
  readonly revision: number;
  /** v1 is a single-parent contract; a built plan always represents one parent. */
  readonly parentRows: 1;
  /** Distinct (parentId, table, rowId) child rows changed across the plan. */
  readonly changedSubtableRows: number;
  readonly parentValues: Readonly<Record<string, { readonly value: KintoneValue }>>;
  readonly tables: readonly ApplyPatchTablePlan[];
  /** Phase 3 validation が走査する、FILE を opaque のまま保持した全record post-image。 */
  readonly postImage: Readonly<Record<string, { readonly value: unknown }>>;
}

export interface ApplyPatchMetadata {
  readonly targetTables: ReadonlyMap<string, KintoneFieldInfo>;
  readonly childrenByTable: ReadonlyMap<string, ReadonlyMap<string, KintoneFieldInfo>>;
  readonly fieldsByCode: ReadonlyMap<string, KintoneFieldInfo>;
}

export interface BuildApplyPatchPlanInput {
  readonly statement: UpdateStatement;
  readonly snapshot: KintoneRecord;
  readonly fieldInfos: readonly KintoneFieldInfo[];
  readonly metadata?: ApplyPatchMetadata;
}

function argument(message: string): never {
  throw new Error(`ArgumentError: ${message}`);
}

/** Phase 1 scope が保証した単一 `$id = n` から n を取り出す。 */
export function getApplyParentId(statement: UpdateStatement): number {
  const where = statement.where;
  if (where.type !== "BINARY" || where.op !== "=" || where.left.type !== "FIELD"
    || where.left.tableAlias !== null || where.left.field !== "$id" || where.right.type !== "NUMBER"
    || !Number.isSafeInteger(where.right.value) || where.right.value <= 0) {
    return argument("APPLY parent selector must be a single positive $id.");
  }
  return where.right.value;
}

/** records API より前に APPLY のフォーム所有関係と writable 契約を確定する。 */
export function resolveApplyPatchMetadata(
  statement: UpdateStatement,
  fieldInfos: readonly KintoneFieldInfo[]
): ApplyPatchMetadata {
  const blocks = statement.applyBlocks;
  if (!blocks?.length) return argument("APPLY block is missing.");
  const fieldsByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  const targetTables = new Map<string, KintoneFieldInfo>();
  const childrenByTable = new Map<string, ReadonlyMap<string, KintoneFieldInfo>>();

  for (const assignment of statement.assignments) {
    assertWritableAssignment(assignment.field, null, fieldsByCode);
    assertParentReferences(assignment.value, fieldsByCode);
  }
  for (const block of blocks) {
    if (targetTables.has(block.field)) argument(`APPLY has more than one block for table ${block.field}.`);
    const targetTable = fieldInfos.find((field) => field.code === block.field && !field.inSubtable);
    if (!targetTable || targetTable.fieldType !== "SUBTABLE") {
      return argument(`APPLY target ${block.field} is not a SUBTABLE.`);
    }
    const targetChildren = new Map(
      fieldInfos.filter((field) => field.inSubtable && field.subtableCode === block.field)
        .map((field) => [field.code, field])
    );
    targetTables.set(block.field, targetTable);
    childrenByTable.set(block.field, targetChildren);
    for (const operation of block.operations) {
      if (operation.kind === "PATCH") {
        for (const assignment of operation.assignments) {
          assertWritableAssignment(assignment.field, block.field, fieldsByCode, targetChildren);
          assertChildReferences(assignment.value, block.field, fieldsByCode, targetChildren);
        }
        if (operation.selector.kind === "WHERE") {
          assertChildReferences(operation.selector.where, block.field, fieldsByCode, targetChildren);
        }
      } else if (operation.kind === "APPEND") {
        const specified = new Set<string>();
        for (const field of operation.fields) {
          if (specified.has(field)) argument(`APPLY APPEND specifies child ${field} more than once.`);
          specified.add(field);
          assertWritableAssignment(field, block.field, fieldsByCode, targetChildren);
        }
      } else if (operation.kind === "REMOVE" && operation.selector.kind === "WHERE") {
        assertChildReferences(operation.selector.where, block.field, fieldsByCode, targetChildren);
      }
    }
  }
  return { targetTables, childrenByTable, fieldsByCode };
}

function assertParentReferences(
  node: unknown,
  fieldsByCode: ReadonlyMap<string, KintoneFieldInfo>
): void {
  visitFieldReferences(node, (code) => {
    if (code === "$id" || code === "$revision") return;
    const field = fieldsByCode.get(code);
    if (!field || field.inSubtable) argument(`APPLY parent reference ${code} is not a top-level field.`);
    if (field.fieldType === "FILE") argument(`APPLY parent FILE reference ${code} is not supported.`);
  });
}

function assertWritableAssignment(
  code: string,
  table: string | null,
  fieldsByCode: ReadonlyMap<string, KintoneFieldInfo>,
  targetChildren?: ReadonlyMap<string, KintoneFieldInfo>
): void {
  if (code.startsWith("_") || code.startsWith("$")) {
    argument(`APPLY assignment target ${code} is a system field.`);
  }
  const field = table === null
    ? [...fieldsByCode.values()].find((item) => item.code === code && !item.inSubtable)
    : targetChildren?.get(code);
  if (!field) {
    const elsewhere = fieldsByCode.get(code);
    if (table !== null && elsewhere?.inSubtable) {
      argument(`APPLY child ${code} does not belong to subtable ${table}.`);
    }
    argument(`APPLY ${table === null ? "parent field" : "child"} ${code} does not exist.`);
  }
  if (field.fieldType === "SUBTABLE" || field.fieldType === "FILE" || field.writable === false) {
    argument(`APPLY assignment target ${code} is not writable (${field.fieldType}).`);
  }
}

function assertChildReferences(
  node: unknown,
  table: string,
  fieldsByCode: ReadonlyMap<string, KintoneFieldInfo>,
  targetChildren: ReadonlyMap<string, KintoneFieldInfo>
): void {
  visitFieldReferences(node, (code) => {
    if (code === "_rid" || code === "_idx") return;
    if (targetChildren.has(code)) return;
    const field = fieldsByCode.get(code);
    if (field?.inSubtable) argument(`APPLY child reference ${code} does not belong to subtable ${table}.`);
    argument(`APPLY child reference ${code} does not exist in subtable ${table}.`);
  });
}

/** GET field-set。FILE と子 field code は直接指定せず、table code で全子を取得する。 */
export function collectApplySnapshotFields(
  statement: UpdateStatement,
  fieldInfos: readonly KintoneFieldInfo[]
): readonly string[] {
  const metadata = resolveApplyPatchMetadata(statement, fieldInfos);
  const fields = new Set<string>(["$id", "$revision"]);
  for (const info of fieldInfos) {
    if (info.inSubtable || info.fieldType === "FILE") continue;
    fields.add(info.code);
  }
  for (const table of metadata.targetTables.values()) fields.add(table.code);
  for (const assignment of statement.assignments) {
    visitFieldReferences(assignment.value, (code) => {
      const info = metadata.fieldsByCode.get(code);
      if (!info?.inSubtable && info?.fieldType !== "FILE") fields.add(code);
    });
  }
  return [...fields];
}

/** execute.ts の従来サブテーブル DML と共有する snapshot flatten primitive。 */
export function flattenSubtableSnapshotRow(
  row: { readonly id?: string; readonly value?: Readonly<Record<string, { readonly value: unknown }>> },
  rowIndex: number
): ProcessRow {
  const flat: ProcessRow = { _rid: row.id ?? "", _idx: String(rowIndex) };
  for (const [code, cell] of Object.entries(row.value ?? {})) {
    flat[code] = normalizeUnknownToString(cell?.value);
  }
  return flat;
}

export function buildApplyPatchPlan(input: BuildApplyPatchPlanInput): ApplyPatchPlan {
  const { statement, snapshot, fieldInfos } = input;
  const metadata = input.metadata ?? resolveApplyPatchMetadata(statement, fieldInfos);
  const parentId = requirePositiveInteger(snapshot["$id"]?.value, "APPLY snapshot $id");
  const expectedParentId = getApplyParentId(statement);
  if (parentId !== expectedParentId) argument(`APPLY snapshot $id ${parentId} does not match requested $id ${expectedParentId}.`);
  return buildApplyPatchPlanForSnapshot(statement, snapshot, metadata, parentId);
}

/**
 * Phase 10a の複数親 planning primitive。
 * 親 identity は WHERE selector ではなく各 snapshot 自身の `$id` から確定する。
 */
export function buildApplyPatchPlans(
  statement: UpdateStatement,
  snapshots: readonly KintoneRecord[],
  fieldInfos: readonly KintoneFieldInfo[],
  metadata: ApplyPatchMetadata = resolveApplyPatchMetadata(statement, fieldInfos)
): readonly ApplyPatchPlan[] {
  const parentIds = new Set<number>();
  return snapshots.map((snapshot) => {
    const parentId = requirePositiveInteger(snapshot["$id"]?.value, "APPLY snapshot $id");
    if (parentIds.has(parentId)) argument(`APPLY snapshots contain duplicate parentId ${parentId}.`);
    parentIds.add(parentId);
    return buildApplyPatchPlanForSnapshot(statement, snapshot, metadata, parentId);
  });
}

function buildApplyPatchPlanForSnapshot(
  statement: UpdateStatement,
  snapshot: KintoneRecord,
  metadata: ApplyPatchMetadata,
  parentId: number
): ApplyPatchPlan {
  const revision = requirePositiveInteger(snapshot["$revision"]?.value, "APPLY snapshot $revision");
  const tablePlans: ApplyPatchTablePlan[] = [];
  for (const block of statement.applyBlocks!) {
    const targetChildren = metadata.childrenByTable.get(block.field)!;
    const snapshotRows = readSnapshotRows(snapshot, block.field);
    const seenRowIds = new Set<string>();
    for (const row of snapshotRows) {
      if (!row.id) argument(`APPLY snapshot for ${block.field} contains a row without _rid.`);
      if (seenRowIds.has(row.id)) argument(`APPLY snapshot for ${block.field} contains duplicate _rid ${row.id}.`);
      seenRowIds.add(row.id);
    }

    const childTypeResolver: FieldTypeResolver = (field: FieldRef) =>
      field.field === "_rid" ? "SINGLE_LINE_TEXT"
        : field.field === "_idx" ? "NUMBER"
          : targetChildren.get(field.field)?.fieldType;
    const resolved: Array<{ rowIndex: number; field: string; value: string }> = [];
    const appended: ApplyPatchPostImageRow[] = [];
    const operationPlans: ApplyPatchOperationPlan[] = [];
    const occupiedCells = new Set<string>();
    const patchedRowIndices = new Set<number>();
    const removedRowIndices = new Set<number>();
    const hasRemove = block.operations.some((operation) => operation.kind === "REMOVE");

    // Every selector and PATCH RHS is evaluated only against snapshotRows. APPEND rows
    // are accumulated separately and therefore cannot become visible to later operations.
    for (const [operationIndex, operation] of block.operations.entries()) {
      if (operation.kind === "APPEND") {
        const rows = buildApplyAppendRows(operation, targetChildren, block.field);
        operationPlans.push({ kind: "APPEND", addedRows: rows.length });
        appended.push(...rows);
        continue;
      }
      if (operation.kind === "REMOVE") {
        const indices = resolveRemoveTargets(operation, snapshotRows, childTypeResolver, block.field);
        if (operation.expectRows) {
          assertExpectRows(operation.expectRows, indices.length, parentId, block.field, operationIndex, operation.kind);
        }
        operationPlans.push({ kind: "REMOVE", removedRows: indices.length });
        for (const rowIndex of indices) {
          const rowId = snapshotRows[rowIndex].id;
          if (patchedRowIndices.has(rowIndex)) {
            argument(`APPLY row ${rowId} is selected by both PATCH and REMOVE.`);
          }
          if (removedRowIndices.has(rowIndex)) {
            argument(`APPLY removes row ${rowId} more than once.`);
          }
          removedRowIndices.add(rowIndex);
        }
        continue;
      }
      if (operation.kind !== "PATCH") continue;
      const indices = resolvePatchTargets(operation, snapshotRows, childTypeResolver, block.field);
      if (operation.expectRows) {
        assertExpectRows(operation.expectRows, indices.length, parentId, block.field, operationIndex, operation.kind);
      }
      operationPlans.push({ kind: "PATCH", matchedRows: indices.length, changedRows: indices.length });
      for (const rowIndex of indices) {
        const row = snapshotRows[rowIndex];
        if (removedRowIndices.has(rowIndex)) {
          argument(`APPLY row ${row.id} is selected by both PATCH and REMOVE.`);
        }
        patchedRowIndices.add(rowIndex);
        const flat = flattenSubtableSnapshotRow(row, rowIndex);
        for (const assignment of operation.assignments) {
          const key = `${row.id}\u0000${assignment.field}`;
          if (occupiedCells.has(key)) argument(`APPLY patches cell ${row.id}.${assignment.field} more than once.`);
          occupiedCells.add(key);
          resolved.push({
            rowIndex,
            field: assignment.field,
            value: evaluateSubtableAssignmentValue(assignment.value, flat, childTypeResolver),
          });
        }
      }
    }

    const updatesByIndex = new Map<number, Record<string, { value: unknown }>>();
    for (const cell of resolved) {
      const updates = updatesByIndex.get(cell.rowIndex) ?? {};
      updates[cell.field] = { value: cell.value };
      updatesByIndex.set(cell.rowIndex, updates);
    }
    const survivorRows: ApplyPatchPostImageRow[] = snapshotRows.flatMap((row, index) =>
      removedRowIndices.has(index) ? [] : [{
        id: row.id,
        value: { ...row.value, ...(updatesByIndex.get(index) ?? {}) },
      }]
    );
    const postImageRows: ApplyPatchPostImageRow[] = [...survivorRows, ...appended];
    const base = {
      table: block.field,
      operations: operationPlans,
      changedSubtableRows: updatesByIndex.size + removedRowIndices.size + appended.length,
      deletedRows: removedRowIndices.size,
      snapshotRowIds: snapshotRows.map((row) => row.id),
      postImageRows,
    };
    if (hasRemove) {
      tablePlans.push({
        ...base,
        payloadShape: "FULL_SURVIVORS",
        removedRowIds: snapshotRows.flatMap((row, index) => removedRowIndices.has(index) ? [row.id] : []),
        payloadRows: postImageRows.map((row) => ({ ...(row.id === undefined ? {} : { id: row.id }), value: row.value })),
      });
    } else {
      tablePlans.push({
        ...base,
        payloadShape: "PATCH_ONLY",
        payloadRows: [
          ...snapshotRows.map((row, index) => {
            const updates = updatesByIndex.get(index);
            return updates ? { id: row.id, value: updates } : { id: row.id };
          }),
          ...appended.map((row) => ({ value: row.value })),
        ],
      });
    }
  }

  const parentRow = kintoneRecordToProcessRow(snapshot);
  const parentValues: Record<string, { value: KintoneValue }> = {};
  for (const assignment of statement.assignments) {
    const fieldType = metadata.fieldsByCode.get(assignment.field)?.fieldType;
    parentValues[assignment.field] = {
      value: evaluateUpdateAssignmentValue(assignment.value, parentRow, fieldType, snapshot),
    };
  }
  const postImage: Record<string, { value: unknown }> = { ...snapshot } as unknown as Record<string, { value: unknown }>;
  Object.assign(postImage, parentValues);
  for (const table of tablePlans) postImage[table.table] = { value: table.postImageRows };
  return {
    app: statement.appId,
    parentId,
    revision,
    parentRows: 1,
    changedSubtableRows: tablePlans.reduce((sum, table) => sum + table.changedSubtableRows, 0),
    parentValues,
    postImage,
    tables: tablePlans,
  };
}

/** EXPECT ROWS is a per-parent, per-operation preflight guard. */
export function assertExpectRows(
  guard: ExpectRowsGuard,
  actual: number,
  parentId: number,
  table: string,
  operationIndex: number,
  operationKind: "PATCH" | "REMOVE"
): void {
  const matches = guard.kind === "EXACT" ? actual === guard.count
    : guard.kind === "BETWEEN" ? actual >= guard.min && actual <= guard.max
      : guard.kind === "AT_LEAST" ? actual >= guard.count
        : actual <= guard.count;
  if (matches) return;
  const expected = guard.kind === "EXACT" ? `exactly ${guard.count}`
    : guard.kind === "BETWEEN" ? `between ${guard.min} and ${guard.max}`
      : guard.kind === "AT_LEAST" ? `at least ${guard.count}`
        : `at most ${guard.count}`;
  argument(
    `APPLY EXPECT ROWS mismatch for parent $id ${parentId}, table ${table}, `
    + `operation ${operationIndex + 1} (${operationKind}): expected ${expected}, actual ${actual}.`
  );
}

/** Apply the complete post-image validator's primitive normalization back to the write plan. */
export function normalizeApplyPatchPlan(
  plan: ApplyPatchPlan,
  normalizedRecord: KintoneRecord
): ApplyPatchPlan {
  const tables = plan.tables.map((table) => {
    const normalizedRows = normalizedRecord[table.table]?.value as unknown;
    if (!Array.isArray(normalizedRows) || normalizedRows.length !== table.postImageRows.length) {
      return argument(`APPLY normalized post-image for ${table.table} has an unexpected row count.`);
    }
    const payloadRows = table.payloadRows.map((payload, index) => {
      const normalized = normalizedRows[index] as { value?: Record<string, { value: unknown }> };
      if (!normalized?.value) return argument(`APPLY normalized post-image for ${table.table} row ${index + 1} has no value.`);
      if (payload.id === undefined) return { value: normalized.value };
      if (payload.value === undefined) return { id: payload.id };
      return {
        id: payload.id,
        value: Object.fromEntries(Object.keys(payload.value).map((field) => [field, normalized.value![field]])),
      };
    });
    return {
      ...table,
      payloadRows,
      postImageRows: normalizedRows as ApplyPatchPostImageRow[],
    };
  });
  const parentValues = Object.fromEntries(Object.keys(plan.parentValues).map((field) => [
    field,
    normalizedRecord[field] ?? plan.parentValues[field],
  ])) as Record<string, { value: KintoneValue }>;
  return {
    ...plan,
    parentValues,
    tables,
    postImage: normalizedRecord,
  };
}

/** Shared APPEND row builder for UPDATE and create prepared planning. */
export function buildApplyAppendRows(
  operation: AppendOperation,
  children: ReadonlyMap<string, KintoneFieldInfo>,
  table: string
): ApplyPatchPostImageRow[] {
  return operation.values.map((row) => ({
    value: buildAppendValue(operation, row, children, table),
  }));
}

function buildAppendValue(
  operation: AppendOperation,
  row: InsertRow,
  children: ReadonlyMap<string, KintoneFieldInfo>,
  table: string
): Readonly<Record<string, { readonly value: unknown }>> {
  if (row.length !== operation.fields.length) {
    return argument(`APPLY APPEND for ${table} has ${row.length} values for ${operation.fields.length} fields.`);
  }
  const specified = new Map(operation.fields.map((field, index) => [field, row[index]]));
  const value: Record<string, { value: unknown }> = {};
  for (const field of children.values()) {
    // FILE is opaque for existing rows and cannot be specified or emitted for APPEND.
    if (field.fieldType === "FILE" || field.writable === false) continue;
    const sqlValue = specified.get(field.code);
    value[field.code] = { value: sqlValue === undefined
      ? appendDefaultValue(field)
      : sqlValue.type === "CASE_VALUE"
        ? evalCaseWhenValue(sqlValue.expr, {}, field.fieldType)
        : toKintoneValue(sqlValue, field.fieldType) };
  }
  return value;
}

/** Metadata default materialization used by every APPLY APPEND payload. */
export function appendDefaultValue(field: KintoneFieldInfo): unknown {
  if (field.defaultValue !== undefined && field.defaultValue !== null) return field.defaultValue;
  return ["CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]
    .includes(field.fieldType) ? [] : "";
}

function resolvePatchTargets(
  operation: PatchOperation,
  rows: readonly ApplySnapshotRow[],
  resolveFieldType: FieldTypeResolver,
  table: string
): number[] {
  return resolveSelectorTargets(operation.selector, rows, resolveFieldType, table);
}

function resolveRemoveTargets(
  operation: RemoveOperation,
  rows: readonly ApplySnapshotRow[],
  resolveFieldType: FieldTypeResolver,
  table: string
): number[] {
  return resolveSelectorTargets(operation.selector, rows, resolveFieldType, table);
}

function resolveSelectorTargets(
  selector: PatchOperation["selector"] | RemoveOperation["selector"],
  rows: readonly ApplySnapshotRow[],
  resolveFieldType: FieldTypeResolver,
  table: string
): number[] {
  if (selector.kind === "ALL_ROWS") return rows.map((_, index) => index);
  const where = selector.where;
  const indices = rows.flatMap((row, index) =>
    evalWhere(where, flattenSubtableSnapshotRow(row, index), resolveFieldType) ? [index] : []
  );
  const requestedRid = exactRidSelectorValue(where);
  if (requestedRid !== null && indices.length === 0) {
    argument(`APPLY _rid ${requestedRid} does not exist in snapshot table ${table}.`);
  }
  const requestedIdx = exactIdxSelectorValue(where);
  if (requestedIdx !== null && indices.length === 0) {
    argument(`APPLY _idx ${requestedIdx} does not exist in snapshot table ${table}.`);
  }
  return indices;
}

function exactRidSelectorValue(where: WhereExpr): string | null {
  if (where.type !== "BINARY" || where.op !== "=" || where.left.type !== "FIELD"
    || where.left.tableAlias !== null || where.left.field !== "_rid") return null;
  if (where.right.type === "STRING") return where.right.value;
  if (where.right.type === "NUMBER") return where.right.raw ?? String(where.right.value);
  return null;
}

function exactIdxSelectorValue(where: WhereExpr): number | null {
  if (where.type !== "BINARY" || where.op !== "=" || where.left.type !== "FIELD"
    || where.left.tableAlias !== null || where.left.field !== "_idx" || where.right.type !== "NUMBER") {
    return null;
  }
  return Number.isSafeInteger(where.right.value) && where.right.value >= 0 ? where.right.value : null;
}

function readSnapshotRows(snapshot: KintoneRecord, table: string): ApplySnapshotRow[] {
  const raw = snapshot[table]?.value as unknown;
  if (!Array.isArray(raw)) return argument(`APPLY snapshot field ${table} is not a subtable value.`);
  return raw.map((row) => {
    const item = row as { id?: unknown; value?: unknown };
    return {
      id: typeof item.id === "string" ? item.id : "",
      value: item.value && typeof item.value === "object"
        ? item.value as Record<string, { value: unknown }>
        : {},
    };
  });
}

function requirePositiveInteger(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) argument(`${label} must be a positive integer.`);
  return n;
}

function kintoneRecordToProcessRow(record: KintoneRecord): ProcessRow {
  const row: ProcessRow = {};
  for (const [code, cell] of Object.entries(record)) {
    row[code] = normalizeUnknownToString(cell?.value);
  }
  return row;
}

function normalizeUnknownToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function visitFieldReferences(node: unknown, visit: (code: string) => void): void {
  if (Array.isArray(node)) { node.forEach((item) => visitFieldReferences(item, visit)); return; }
  if (node === null || typeof node !== "object") return;
  const item = node as Record<string, unknown>;
  if ((item["type"] === "FIELD" || item["type"] === "FIELD_REF") && typeof item["field"] === "string") {
    visit(item["field"]);
  }
  for (const value of Object.values(item)) visitFieldReferences(value, visit);
}
