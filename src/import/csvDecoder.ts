import type { ImportEncoding } from "../types/ast";
import { ImportSourceError } from "./sourceLoader";

export interface DecodedCsv { columns: string[]; rows: string[][]; }

export function decodeImportText(bytes: Uint8Array, encoding: ImportEncoding): string {
  try {
    return new TextDecoder(encoding === "sjis" ? "shift_jis" : "utf-8", { fatal: true }).decode(bytes)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new ImportSourceError(`invalid ${encoding.toUpperCase()} byte sequence.`);
  }
}

/** RFC 4180 records, accepting CRLF and LF while retaining newlines inside quoted cells. */
export function parseRfc4180(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let i = 0;
  const finishCell = () => { record.push(cell); cell = ""; afterQuote = false; };
  const finishRecord = () => { finishCell(); records.push(record); record = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; afterQuote = true; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (afterQuote && ch !== "," && ch !== "\r" && ch !== "\n") {
      throw new ImportSourceError(`unexpected character after closing quote at offset ${i}.`);
    }
    if (ch === '"') {
      if (cell.length !== 0) throw new ImportSourceError(`quote in unquoted cell at offset ${i}.`);
      quoted = true; i++; continue;
    }
    if (ch === ",") { finishCell(); i++; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      finishRecord(); i++; continue;
    }
    cell += ch; i++;
  }
  if (quoted) throw new ImportSourceError("unterminated quoted cell.");
  if (cell.length > 0 || record.length > 0 || afterQuote) finishRecord();
  return records;
}

function assertColumns(columns: string[]): void {
  const seen = new Set<string>();
  columns.forEach((column, index) => {
    if (column === "") throw new ImportSourceError(`CSV column ${index + 1} has an empty name.`);
    if (seen.has(column)) throw new ImportSourceError(`CSV column name \"${column}\" is duplicated.`);
    seen.add(column);
  });
}

export function decodeCsv(
  bytes: Uint8Array,
  options: { encoding: ImportEncoding; hasHeader: boolean; columns?: string[] }
): DecodedCsv {
  const records = parseRfc4180(decodeImportText(bytes, options.encoding));
  let columns: string[];
  let rows: string[][];
  if (options.hasHeader) {
    columns = records[0] ?? [];
    rows = records.slice(1);
  } else {
    rows = records;
    columns = options.columns ? [...options.columns] : Array.from({ length: rows[0]?.length ?? 0 }, (_, i) => `c${i + 1}`);
  }
  assertColumns(columns);
  if (rows.length === 0) throw new ImportSourceError("CSV has no data rows.");
  rows.forEach((row, i) => {
    if (row.length !== columns.length) {
      throw new ImportSourceError(`CSV row ${i + (options.hasHeader ? 2 : 1)} has ${row.length} cells; expected ${columns.length}.`);
    }
  });
  return { columns, rows };
}
