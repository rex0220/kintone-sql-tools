import type { CsvDmlSource } from "../types/ast";
import type { ImportSourcePayload, ImportMaterializedTable, IgnoredImportColumn, ImportRowError } from "./types";
import type { KintoneFieldInfo } from "../execute";
import { decodeCsv } from "./csvDecoder";
import { ImportSourceError } from "./sourceLoader";
import { convertImportCsvValue, ImportCsvValueError } from "./convertImportCsvValue";
export { materializeJsonDmlSource } from "./jsonMaterializer";
export type { JsonTargetField } from "./jsonMaterializer";

/** Flat CSV half of the shared SELECT/CSV DML materialization boundary. */
export function materializeCsvDmlSource(
  source: CsvDmlSource,
  payload: ImportSourcePayload,
  maxRows: number,
  targetCodes?: readonly string[],
  fieldInfos?: readonly KintoneFieldInfo[],
  recordNumberSourceHeader?: string
): ImportMaterializedTable {
  const encoding = source.encoding ?? payload.encoding ?? "utf8";
  const decoded = decodeCsv(payload.bytes, {
    encoding,
    hasHeader: source.hasHeader,
    columns: source.columns,
  });
  if (decoded.rows.length > maxRows) {
    throw new ImportSourceError(`source rows (${decoded.rows.length}) exceed maxRecords (${maxRows}).`);
  }
  if (source.mappingMode === "BY_NAME") {
    if (!targetCodes || !fieldInfos) throw new Error("InternalError: BY NAME requires destination form metadata.");
    if (new Set(targetCodes).size !== targetCodes.length) {
      throw new ImportSourceError("ERR_IMPORT_HEADER_REUSED: a BY NAME header cannot be consumed more than once.");
    }
    const indexes = new Map(decoded.columns.map((column, index) => [column, index]));
    for (const code of targetCodes) {
      if (!indexes.has(code)) throw new ImportSourceError(`ERR_IMPORT_MISSING_COLUMN: required header \"${code}\" is missing.`);
    }
    const infoByCode = new Map(fieldInfos.map((info) => [info.code, info]));
    const targetSet = new Set(targetCodes);
    if (recordNumberSourceHeader && targetSet.has(recordNumberSourceHeader)) {
      throw new ImportSourceError("ERR_IMPORT_HEADER_REUSED: record-number source header is lookup-only and cannot be a write target.");
    }
    if (recordNumberSourceHeader && !indexes.has(recordNumberSourceHeader)) {
      throw new ImportSourceError(`ERR_IMPORT_MISSING_COLUMN: required header \"${recordNumberSourceHeader}\" is missing.`);
    }
    const ignoredKnownColumns: IgnoredImportColumn[] = [];
    const ignoredUnknownColumns: IgnoredImportColumn[] = [];
    const nonEmpty = (index: number) => decoded.rows.filter((row) => row[index] !== "").length;
    const reasonFor = (info: KintoneFieldInfo): string => {
      if (info.fieldType === "FILE") return "FILE attachment is outside flat IMPORT scope";
      if (info.inSubtable || info.fieldType === "SUBTABLE") return "subtable field is not writable in Phase 3";
      if (info.writable === false) return `non-writable ${info.fieldType} field`;
      return `known export-only ${info.fieldType} field`;
    };
    for (const [index, column] of decoded.columns.entries()) {
      if (targetSet.has(column) || column === recordNumberSourceHeader) continue;
      const info = infoByCode.get(column);
      if (info) ignoredKnownColumns.push({ column, reason: reasonFor(info), nonEmptyCells: nonEmpty(index) });
      else if (!source.ignoreUnknownColumns) throw new ImportSourceError(`ERR_IMPORT_UNKNOWN_COLUMN: unknown CSV header \"${column}\".`);
      else ignoredUnknownColumns.push({ column, reason: "unknown column ignored by explicit policy", nonEmptyCells: nonEmpty(index) });
    }
    for (const code of targetCodes) {
      const info = infoByCode.get(code);
      if (!info) throw new Error(`ArgumentError: DML target field ${code} does not exist.`);
      if (info.inSubtable || info.writable === false || info.fieldType === "FILE" || info.fieldType === "SUBTABLE") {
        throw new Error(`ArgumentError: DML target field ${code} is not writable (${info.fieldType}).`);
      }
    }
    const importRowErrors: ImportRowError[][] = [];
    const rows = decoded.rows.map((values) => {
      const errors: ImportRowError[] = [];
      const row: Record<string, unknown> = {};
      for (const code of targetCodes) {
        const raw = values[indexes.get(code)!];
        try { row[code] = convertImportCsvValue(raw, infoByCode.get(code)?.fieldType, { cliKintone: true }); }
        catch (error) {
          if (!(error instanceof ImportCsvValueError)) throw error;
          row[code] = raw;
          errors.push({ field: code, code: error.code, message: error.message });
        }
      }
      importRowErrors.push(errors);
      return row as Record<string, string>;
    });
    return {
      receipt: { rows: decoded.rows.length, encoding },
      rows, columns: [...targetCodes],
      columnMeta: new Map(targetCodes.map((code) => [code, { fieldType: infoByCode.get(code)?.fieldType ?? "SINGLE_LINE_TEXT" }])),
      importRowErrors,
      ...(recordNumberSourceHeader ? { recordNumberSourceValues: decoded.rows.map((row) => row[indexes.get(recordNumberSourceHeader)!]) } : {}),
      importAudit: { mapping: "BY_NAME", writtenColumns: [...targetCodes], ignoredKnownColumns, ignoredUnknownColumns },
    };
  }
  const rows = decoded.rows.map((values) => Object.fromEntries(decoded.columns.map((column, i) => [column, values[i]])));
  return {
    receipt: { rows: decoded.rows.length, encoding },
    rows,
    columns: decoded.columns,
    // CSV cells are decoded as strings; projections such as CAST may replace this metadata downstream.
    columnMeta: new Map(decoded.columns.map((column) => [column, { fieldType: "SINGLE_LINE_TEXT" }])),
  };
}
