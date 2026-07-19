import type { ProcessRow } from "../engine/process";
import type { ImportEncoding } from "../types/ast";
import type { DmlValidationErrorCode } from "../core/dmlValidation";
import type { DecodedJsonValue } from "./jsonDecoder";

export interface ImportSourcePayload {
  bytes: Uint8Array;
  encoding?: ImportEncoding;
}

export interface ImportSourceHandle {
  load(): Promise<ImportSourcePayload>;
}

export type ImportSourceResolver = (name: string) => ImportSourceHandle | undefined;

export interface ImportColumnMeta {
  readonly sortKind?: "number" | "string";
  readonly fieldType?: string;
}

export interface ImportMaterializedTable {
  rows: ProcessRow[];
  columns: string[];
  columnMeta?: ReadonlyMap<string, ImportColumnMeta>;
  /** JSON-only: target field names explicitly present in each source record. */
  importPresence?: readonly ReadonlySet<string>[];
  /** BY NAME conversion failures, kept row-scoped for VALIDATE/SKIP. */
  importRowErrors?: readonly (readonly ImportRowError[])[];
  importAudit?: ImportColumnAudit;
  /** Dedicated lookup-only CSV column, never part of the write payload. */
  recordNumberSourceValues?: readonly string[];
}

export interface ImportRowError { field: string; code: DmlValidationErrorCode; message: string; }
export interface IgnoredImportColumn { column: string; reason: string; nonEmptyCells: number; }
export interface ImportColumnAudit {
  mapping: "BY_NAME";
  writtenColumns: readonly string[];
  ignoredKnownColumns: readonly IgnoredImportColumn[];
  ignoredUnknownColumns: readonly IgnoredImportColumn[];
}

/** Phase 5 two-level source model. Deliberately separate from flat ProcessRow. */
export interface MaterializedImportChildRow {
  childRowNumber: number;
  sourceRowNumber?: number;
  rowId?: string;
  values: ReadonlyMap<string, DecodedJsonValue | string>;
}
export interface MaterializedImportRecord {
  rowNumber: number;
  markerRowNumber?: number;
  top: ReadonlyMap<string, DecodedJsonValue | string>;
  subtables: ReadonlyMap<string, readonly MaterializedImportChildRow[]>;
  replacementTables: ReadonlySet<string>;
}
export interface MaterializedImportRecords { records: readonly MaterializedImportRecord[]; }
