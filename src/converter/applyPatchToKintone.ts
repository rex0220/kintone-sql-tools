import type { ApplyPatchPlan, ApplyPatchTablePlan } from "../core/applyPatchPlanner";
import type { KintonePutParams, KintoneRecord } from "./dmlToKintone";

function argument(message: string): never {
  throw new Error(`ArgumentError: ${message}`);
}

/** B44 は revision=0 fallback を許さない。 */
export function requireRevision(record: KintoneRecord): number {
  const revision = Number(record["$revision"]?.value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    return argument("APPLY snapshot $revision must be a positive integer.");
  }
  return revision;
}

export function applyPatchPlanToKintone(plan: ApplyPatchPlan): KintonePutParams {
  if (!Number.isSafeInteger(plan.parentId) || plan.parentId <= 0) {
    return argument("APPLY plan parentId must be a positive integer.");
  }
  if (!Number.isSafeInteger(plan.revision) || plan.revision <= 0) {
    return argument("APPLY plan revision must be a positive integer.");
  }
  const record: Record<string, { value: unknown }> = { ...plan.parentValues };
  const seenTables = new Set<string>();
  for (const table of plan.tables) {
    if (seenTables.has(table.table)) argument(`APPLY plan contains duplicate table ${table.table}.`);
    seenTables.add(table.table);
    assertTablePlan(table);
    record[table.table] = { value: table.payloadRows };
  }
  return {
    app: plan.app,
    records: [{
      id: plan.parentId,
      revision: plan.revision,
      record: record as unknown as KintoneRecord,
    }],
  };
}

/** ファイル名と同じ短い公開名も提供する。 */
export const applyPatchToKintone = applyPatchPlanToKintone;

function assertTablePlan(table: ApplyPatchTablePlan): void {
  const snapshotIds = assertUniqueIds(table.snapshotRowIds, `${table.table} snapshot`);
  const payloadIds = table.payloadRows.flatMap((row) => row.id === undefined ? [] : [row.id]);
  for (const row of table.payloadRows) {
    if (row.id === undefined && row.value === undefined) {
      argument(`APPLY ${table.payloadShape} table ${table.table} contains an APPEND row without value.`);
    }
  }
  assertUniqueIds(payloadIds, `${table.table} payload`);

  if (table.payloadShape === "PATCH_ONLY") {
    const payloadPrefixIds = table.payloadRows.slice(0, snapshotIds.length)
      .map((row) => row.id ?? "");
    assertSameOrderedIds(snapshotIds, payloadPrefixIds,
      `APPLY PATCH_ONLY table ${table.table} must retain every snapshot row id in order.`);
    if (table.payloadRows.slice(snapshotIds.length).some((row) => row.id !== undefined)) {
      argument(`APPLY PATCH_ONLY table ${table.table} must place every APPEND row after snapshot rows.`);
    }
    const postPrefixIds = table.postImageRows.slice(0, snapshotIds.length)
      .map((row) => row.id ?? "");
    assertSameOrderedIds(snapshotIds, postPrefixIds,
      `APPLY PATCH_ONLY table ${table.table} post-image must retain every snapshot row id in order.`);
    if (table.postImageRows.slice(snapshotIds.length).some((row) => row.id !== undefined)) {
      argument(`APPLY PATCH_ONLY table ${table.table} post-image must place every APPEND row after snapshot rows.`);
    }
    return;
  }

  const removed = assertUniqueIds(table.removedRowIds, `${table.table} removed`);
  const survivorIds = table.postImageRows.flatMap((row) => row.id === undefined ? [] : [row.id]);
  assertSameOrderedIds(survivorIds, payloadIds,
    `APPLY FULL_SURVIVORS table ${table.table} payload must enumerate every survivor in order.`);
  if (table.payloadRows.some((row) => row.value === undefined)) {
    argument(`APPLY FULL_SURVIVORS table ${table.table} requires values for every survivor.`);
  }
  const survivorSet = new Set(survivorIds);
  for (const id of removed) {
    if (survivorSet.has(id)) argument(`APPLY FULL_SURVIVORS table ${table.table} has intersecting survivor/removed id ${id}.`);
  }
  const partition = new Set([...survivorIds, ...removed]);
  if (partition.size !== snapshotIds.length || snapshotIds.some((id) => !partition.has(id))) {
    argument(`APPLY FULL_SURVIVORS table ${table.table} does not partition every snapshot row.`);
  }
}

function assertUniqueIds(ids: readonly string[], label: string): string[] {
  const out = [...ids];
  const seen = new Set<string>();
  for (const id of out) {
    if (!id) argument(`APPLY ${label} contains an empty row id.`);
    if (seen.has(id)) argument(`APPLY ${label} contains duplicate row id ${id}.`);
    seen.add(id);
  }
  return out;
}

function assertSameOrderedIds(actual: readonly string[], expected: readonly string[], message: string): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    argument(message);
  }
}
