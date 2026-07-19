import type { KintoneRecord } from "../converter/dmlToKintone";
import type { PreparedImportParent } from "./importRecordValidation";
import type { MaterializedImportRecords } from "./types";

export interface JsonImportExistingParent {
  readonly id: number;
  readonly revision?: number;
  readonly record: Readonly<Record<string, { readonly value?: unknown }>>;
}

export interface JsonImportTableWriteDetail {
  readonly table: string;
  readonly existingRows: number;
  readonly inputRows: number;
  readonly addRows: number;
  readonly deleteRows: number;
}

export interface JsonImportParentWritePlan {
  readonly parentRow: number;
  readonly mode: "INSERT" | "UPDATE";
  readonly targetId?: number;
  readonly revision?: number;
  readonly top: KintoneRecord;
  readonly subtables: ReadonlyMap<string, readonly KintoneRecord[]>;
  readonly tables: readonly JsonImportTableWriteDetail[];
}

/** JSON never has a row-ID channel. Keep this assertion next to the mutation plan. */
export function assertJsonImportHasNoRowIds(materialized: MaterializedImportRecords): void {
  for (const parent of materialized.records) for (const [table, rows] of parent.subtables) {
    for (const row of rows) {
      if (row.rowId !== undefined || row.values.has("_rid") || row.values.has("id")) {
        throw new Error(`ArgumentError: JSON IMPORT subtable ${table} does not accept _rid/id; rows are always newly numbered.`);
      }
    }
  }
}

export function buildJsonSubtableWritePlan(
  parents: readonly PreparedImportParent[],
  targetIds: readonly (number | undefined)[],
  existingById: ReadonlyMap<number, JsonImportExistingParent>
): readonly JsonImportParentWritePlan[] {
  return parents.map((parent, index) => {
    const targetId = targetIds[index];
    const existing = targetId === undefined ? undefined : existingById.get(targetId);
    if (targetId !== undefined && !existing) throw new Error(`InternalError: IMPORT UPSERT target APP record ${targetId} was not loaded.`);
    const tables = [...parent.subtables].map(([table, input]) => {
      const raw = existing?.record[table]?.value;
      const existingRows = Array.isArray(raw) ? raw.length : 0;
      return { table, existingRows, inputRows: input.length, addRows: input.length, deleteRows: existingRows };
    });
    return {
      parentRow: parent.parentRow,
      mode: targetId === undefined ? "INSERT" : "UPDATE",
      ...(targetId === undefined ? {} : { targetId, revision: existing?.revision }),
      top: parent.top,
      subtables: parent.subtables,
      tables,
    };
  });
}
