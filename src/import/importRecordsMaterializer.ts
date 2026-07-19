import type { CsvDmlSource, ImportTarget, JsonDmlSource } from "../types/ast";
import { decodeCsv } from "./csvDecoder";
import { decodeJsonRecords, type DecodedJsonObject, type DecodedJsonValue } from "./jsonDecoder";
import { ImportSourceError } from "./sourceLoader";
import type { ImportSourcePayload, MaterializedImportRecords } from "./types";

const sourceFail = (parentRow: number, code: string, message: string): never => {
  throw new ImportSourceError(`JSON subtable validation failed (parentRow=${parentRow}, field=${code}): ${message}`);
};

/** Structural JSON materialization only; form-scoped value validation is a later boundary. */
export function materializeJsonImportRecords(
  _source: JsonDmlSource,
  payload: ImportSourcePayload,
  targets: readonly ImportTarget[],
  maxParents: number,
  maxChildRows = maxParents
): MaterializedImportRecords {
  if (payload.encoding && payload.encoding !== "utf8") throw new ImportSourceError("JSON source is UTF-8 only.");
  const decoded = decodeJsonRecords(payload.bytes);
  if (decoded.length > maxParents) throw new ImportSourceError(`source parent rows (${decoded.length}) exceed maxRecords (${maxParents}).`);
  const targetByCode = new Map(targets.map((target) => [target.kind === "FIELD" ? target.field : target.subtableCode, target]));
  if (targetByCode.size !== targets.length) throw new ImportSourceError("IMPORT targets contain duplicates.");
  let childTotal = 0;
  return {
    records: decoded.map((record, index) => {
      const parentRow = index + 1;
      for (const code of record.keys()) if (!targetByCode.has(code)) sourceFail(parentRow, code, "unknown key (not declared in INTO).");
      const top = new Map();
      const subtables = new Map();
      const replacementTables = new Set<string>();
      for (const target of targets) {
        const code = target.kind === "FIELD" ? target.field : target.subtableCode;
        if (!record.has(code)) continue;
        const value = record.get(code)!;
        if (target.kind === "FIELD") {
          if (value instanceof Map) sourceFail(parentRow, code, "object is not accepted for a top-level field.");
          top.set(code, value);
          continue;
        }
        if (!Array.isArray(value)) sourceFail(parentRow, code, "subtable value must be an array.");
        replacementTables.add(code);
        const children = new Set(target.children);
        const rows = (value as DecodedJsonValue[]).map((entry, childIndex) => {
          if (!(entry instanceof Map)) sourceFail(parentRow, code, `childRow=${childIndex + 1} must be an object.`);
          const child = entry as DecodedJsonObject;
          for (const childCode of child.keys()) {
            if (!children.has(childCode)) sourceFail(parentRow, childCode, `unknown child key in subtable ${code} at childRow=${childIndex + 1}.`);
          }
          childTotal++;
          if (childTotal > maxChildRows) throw new ImportSourceError(`source child rows (${childTotal}) exceed limit (${maxChildRows}).`);
          return { childRowNumber: childIndex + 1, values: child };
        });
        subtables.set(code, rows);
      }
      return { rowNumber: parentRow, top, subtables, replacementTables };
    }),
  };
}

/** Groups cli-kintone '*' rows while retaining both logical and physical positions. */
export function materializeCliKintoneCsvImportRecords(
  source: CsvDmlSource,
  payload: ImportSourcePayload,
  targets: readonly ImportTarget[],
  replacementTables: readonly string[],
  maxParents: number
): MaterializedImportRecords {
  const decoded = decodeCsv(payload.bytes, {
    encoding: source.encoding ?? payload.encoding ?? "utf8", hasHeader: source.hasHeader, columns: source.columns,
  });
  if (!source.hasHeader || decoded.columns[0] !== "*") throw new ImportSourceError('ERR_IMPORT_MARKER: first CSV header must be "*".');
  const indexes = new Map(decoded.columns.map((code, index) => [code, index]));
  const fields = targets.filter((target): target is Extract<ImportTarget, { kind: "FIELD" }> => target.kind === "FIELD");
  const tables = targets.filter((target): target is Extract<ImportTarget, { kind: "SUBTABLE" }> => target.kind === "SUBTABLE");
  for (const field of fields) if (!indexes.has(field.field)) throw new ImportSourceError(`ERR_IMPORT_MISSING_COLUMN: required header "${field.field}" is missing.`);
  for (const table of tables) {
    if (!table.rowIdSourceHeader || !indexes.has(table.rowIdSourceHeader)) throw new ImportSourceError(`ERR_IMPORT_MISSING_COLUMN: row-ID header for ${table.subtableCode} is missing.`);
    for (const child of table.children) if (!indexes.has(child)) throw new ImportSourceError(`ERR_IMPORT_MISSING_COLUMN: required child header "${child}" is missing.`);
  }
  const records: Array<{ rowNumber: number; markerRowNumber: number; top: Map<string, string>; subtables: Map<string, Array<{ childRowNumber: number; sourceRowNumber: number; rowId?: string; values: Map<string, string> }>>; replacementTables: Set<string> }> = [];
  let current: typeof records[number] | undefined;
  decoded.rows.forEach((cells, physicalIndex) => {
    const sourceRowNumber = physicalIndex + 2;
    const marker = cells[0];
    if (marker !== "" && marker !== "*") throw new ImportSourceError(`ERR_IMPORT_MARKER: invalid marker ${JSON.stringify(marker)} at source row ${sourceRowNumber}.`);
    if (marker === "*") {
      if (records.length >= maxParents) throw new ImportSourceError(`source parent rows exceed maxRecords (${maxParents}).`);
      current = {
        rowNumber: records.length + 1, markerRowNumber: sourceRowNumber,
        top: new Map(fields.map((field) => [field.field, cells[indexes.get(field.field)!]])),
        subtables: new Map(tables.map((table) => [table.subtableCode, []])), replacementTables: new Set(replacementTables),
      };
      records.push(current);
    } else if (!current) {
      throw new ImportSourceError(`ERR_IMPORT_MARKER: first data row must start a parent (source row ${sourceRowNumber}).`);
    } else {
      for (const field of fields) {
        if (cells[indexes.get(field.field)!] !== "") throw new ImportSourceError(`ERR_IMPORT_PARENT_VALUE_ON_CONTINUATION: ${field.field} at source row ${sourceRowNumber}.`);
      }
    }
    for (const table of tables) {
      const rowId = cells[indexes.get(table.rowIdSourceHeader!)!];
      const values = new Map(table.children.map((child) => [child, cells[indexes.get(child)!]]));
      if (rowId === "" && [...values.values()].every((value) => value === "")) continue;
      const rows = current!.subtables.get(table.subtableCode)!;
      rows.push({ childRowNumber: rows.length + 1, sourceRowNumber, ...(rowId ? { rowId } : {}), values });
    }
  });
  if (records.length === 0) throw new ImportSourceError("CSV has no parent rows.");
  return { records };
}
