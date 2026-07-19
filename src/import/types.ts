import type { ProcessRow } from "../engine/process";
import type { ImportEncoding } from "../types/ast";

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
}
