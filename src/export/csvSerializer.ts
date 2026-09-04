import { assertSupportedExportColumns, serializeExportCell } from "./cellSerializer";
import { createDateTimeFormatter } from "./dateTimeText";
import { encodeExportText, resolveExportEncoding } from "./encoding";
import type { CsvExportInput, CsvExportOptions, CsvExportResult } from "./types";
import { ExportSinkDuplicateHeaderError } from "./types";

export * from "./types";

function quoteCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function assertUniqueHeaders(columns: readonly string[]): void {
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) {
      throw new ExportSinkDuplicateHeaderError(
        `CSV column name ${JSON.stringify(column)} is duplicated.`
      );
    }
    seen.add(column);
  }
}

export function serializeCsvExport(
  input: CsvExportInput,
  options: CsvExportOptions = {}
): CsvExportResult {
  const resolvedEncoding = resolveExportEncoding(options);
  const timezoneFormatter = options.timezone === undefined
    ? undefined
    : createDateTimeFormatter(options.timezone);
  assertUniqueHeaders(input.columns);
  assertSupportedExportColumns(input.columns, input.columnMeta);

  const records: string[] = [input.columns.map(quoteCsvCell).join(",")];
  input.rows.forEach((row, rowIndex) => {
    records.push(input.columns.map((column) => quoteCsvCell(serializeExportCell(
      (row as Readonly<Record<string, unknown>>)[column],
      column,
      rowIndex + 1,
      input.columnMeta?.get(column),
      timezoneFormatter
    ))).join(","));
  });
  const text = `${records.join("\r\n")}\r\n`;
  const data = encodeExportText(text, resolvedEncoding);
  return {
    text,
    data,
    receipt: {
      rows: input.rows.length,
      columns: input.columns.length,
      bytes: data.byteLength,
      encoding: resolvedEncoding.encoding,
    },
  };
}
