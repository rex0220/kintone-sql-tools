import type { CsvDmlSource } from "../types/ast";
import type { ImportSourcePayload, ImportMaterializedTable } from "./types";
import { decodeCsv } from "./csvDecoder";
import { ImportSourceError } from "./sourceLoader";
export { materializeJsonDmlSource } from "./jsonMaterializer";
export type { JsonTargetField } from "./jsonMaterializer";

/** Flat CSV half of the shared SELECT/CSV DML materialization boundary. */
export function materializeCsvDmlSource(
  source: CsvDmlSource,
  payload: ImportSourcePayload,
  maxRows: number
): ImportMaterializedTable {
  const decoded = decodeCsv(payload.bytes, {
    encoding: source.encoding ?? payload.encoding ?? "utf8",
    hasHeader: source.hasHeader,
    columns: source.columns,
  });
  if (decoded.rows.length > maxRows) {
    throw new ImportSourceError(`source rows (${decoded.rows.length}) exceed maxRecords (${maxRows}).`);
  }
  const rows = decoded.rows.map((values) => Object.fromEntries(decoded.columns.map((column, i) => [column, values[i]])));
  return {
    rows,
    columns: decoded.columns,
    // CSV cells are decoded as strings; projections such as CAST may replace this metadata downstream.
    columnMeta: new Map(decoded.columns.map((column) => [column, { fieldType: "SINGLE_LINE_TEXT" }])),
  };
}
