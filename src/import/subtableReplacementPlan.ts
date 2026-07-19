import type { KintoneRecord } from "../converter/dmlToKintone";
import type { ImportValidationError, PreparedImportParent } from "./importRecordValidation";
import type { MaterializedImportRecord } from "./types";

export interface CsvReplacementExistingParent {
  readonly id: number;
  readonly revision?: number;
  readonly record: KintoneRecord;
}
export interface CsvImportTableWriteDetail {
  readonly table: string;
  readonly existingRows: number;
  readonly inputRows: number;
  readonly updateRows: number;
  readonly addRows: number;
  readonly deleteRows: number;
  readonly rowIdNotFound: number;
}
export interface CsvImportParentWritePlan {
  readonly parentRow: number;
  readonly targetId: number;
  readonly revision?: number;
  readonly valid: boolean;
  readonly top: KintoneRecord;
  readonly subtables: ReadonlyMap<string, readonly { rowId?: string; record: KintoneRecord }[]>;
  readonly tables: readonly CsvImportTableWriteDetail[];
  readonly errors: readonly ImportValidationError[];
}

function tableRows(record: KintoneRecord, table: string): readonly { id?: string; value?: KintoneRecord }[] {
  const raw = record[table]?.value;
  return Array.isArray(raw) ? raw as readonly { id?: string; value?: KintoneRecord }[] : [];
}

/** Source row IDs must be deterministic before any mutation is considered. */
export function assertNoDuplicateCsvSubtableRowIds(records: readonly MaterializedImportRecord[]): void {
  const seen = new Map<string, number>();
  for (const parent of records) for (const [table, rows] of parent.subtables) for (const row of rows) {
    if (!row.rowId) continue;
    const key = `${table}\u0000${row.rowId}`;
    if (seen.has(key)) throw new Error(`ERR_SUBTABLE_ROW_ID_DUP_SOURCE: duplicate row ID ${row.rowId} in ${table}`);
    seen.set(key, parent.rowNumber);
  }
}

export function buildCsvSubtableReplacementPlan(
  sources: readonly MaterializedImportRecord[],
  prepared: readonly PreparedImportParent[],
  targetIds: readonly (number | undefined)[],
  existingById: ReadonlyMap<number, CsvReplacementExistingParent>,
  ownership: ReadonlyMap<string, readonly { parentId: number; table: string }[]>
): readonly CsvImportParentWritePlan[] {
  return prepared.map((parent, index) => {
    const source = sources[index];
    const targetId = targetIds[index];
    const existing = targetId === undefined ? undefined : existingById.get(targetId);
    const errors: ImportValidationError[] = [...parent.errors];
    if (!existing || targetId === undefined) return { parentRow: parent.parentRow, targetId: targetId ?? 0, valid: false, top: parent.top, subtables: new Map(), tables: [], errors };
    const subtables = new Map<string, { rowId?: string; record: KintoneRecord }[]>();
    const tables: CsvImportTableWriteDetail[] = [];
    for (const table of parent.replacementTables) {
      const current = tableRows(existing.record, table);
      const currentIds = new Set(current.map((row) => row.id).filter((id): id is string => !!id));
      const input = source.subtables.get(table) ?? [];
      const normalized = parent.subtables.get(table) ?? [];
      let updateRows = 0, addRows = 0, rowIdNotFound = 0;
      const payloadRows = input.map((row, rowIndex) => {
        const normalizedRecord = normalized[rowIndex] ?? {};
        if (row.rowId && currentIds.has(row.rowId)) { updateRows++; return { rowId: row.rowId, record: normalizedRecord }; }
        if (row.rowId) {
          const owners = ownership.get(row.rowId) ?? [];
          if (owners.some((owner) => owner.parentId !== targetId || owner.table !== table)) errors.push({
            operation: "UPDATE", parentRow: parent.parentRow, field: row.rowId, subtable: table,
            subrow: row.childRowNumber, sourceRow: row.sourceRowNumber,
            code: "ERR_IMPORT_FIELD_OWNERSHIP", message: `rowIdOwnedElsewhere: ${row.rowId}`,
            sourceValues: row.values,
          });
          rowIdNotFound++;
        }
        addRows++;
        return { record: normalizedRecord };
      });
      subtables.set(table, payloadRows);
      tables.push({ table, existingRows: current.length, inputRows: input.length, updateRows, addRows, deleteRows: current.length - updateRows, rowIdNotFound });
    }
    return { parentRow: parent.parentRow, targetId, ...(existing.revision === undefined ? {} : { revision: existing.revision }), valid: errors.length === 0, top: parent.top, subtables, tables, errors };
  });
}
