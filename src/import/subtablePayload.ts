export type ImportScalarPayloadValue = string | readonly string[] | readonly { code: string }[];
export interface ImportChildRecordPayload {
  readonly [childCode: string]: { readonly value: ImportScalarPayloadValue };
}
export interface ImportSubtableRowPayload {
  readonly id?: string;
  readonly value: ImportChildRecordPayload;
}
export interface ImportSubtableFieldPayload {
  readonly value: readonly ImportSubtableRowPayload[];
}
export type ImportParentRecordPayload = Record<
  string,
  { readonly value: ImportScalarPayloadValue } | ImportSubtableFieldPayload
>;

export interface NormalizedImportChildRow {
  readonly rowId?: string;
  readonly values: ReadonlyMap<string, ImportScalarPayloadValue>;
}

export type JsonImportChildRow = Omit<NormalizedImportChildRow, "rowId"> & { readonly rowId?: never };

/** Dedicated recursive builder. A parent record and all its table rows stay indivisible. */
export function buildImportRecordPayload(
  top: ReadonlyMap<string, ImportScalarPayloadValue>,
  subtables: ReadonlyMap<string, readonly NormalizedImportChildRow[]>,
  rowIdMode: "DROP" | "PRESERVE"
): ImportParentRecordPayload {
  const record: ImportParentRecordPayload = {};
  for (const [code, value] of top) record[code] = { value };
  for (const [tableCode, sourceRows] of subtables) {
    record[tableCode] = {
      value: sourceRows.map((sourceRow) => ({
        ...(rowIdMode === "PRESERVE" && sourceRow.rowId ? { id: sourceRow.rowId } : {}),
        value: Object.fromEntries([...sourceRow.values].map(([childCode, value]) => [childCode, { value }])),
      })),
    };
  }
  return record;
}


/** JSON-only entry point: the DROP policy is not selectable by callers. */
export function buildJsonImportRecordPayload(
  top: ReadonlyMap<string, ImportScalarPayloadValue>,
  subtables: ReadonlyMap<string, readonly JsonImportChildRow[]>
): ImportParentRecordPayload {
  return buildImportRecordPayload(top, subtables, "DROP");
}
