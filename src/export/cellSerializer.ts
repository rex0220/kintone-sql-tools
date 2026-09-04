import { expandExponentialDecimal } from "./decimalText";
import { assertValidUtcDateTime, formatDateTimeInTimezone } from "./dateTimeText";
import type { CsvExportColumnMeta } from "./types";
import { ExportSinkInvalidValueError, ExportSinkUnsupportedColumnError } from "./types";

const STRING_ARRAY_FIELDS = new Set(["CHECK_BOX", "MULTI_SELECT", "CATEGORY"]);
const CODE_ARRAY_FIELDS = new Set([
  "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "STATUS_ASSIGNEE",
]);
const NUMERIC_FIELDS = new Set(["NUMBER", "CALC", "KSQL_NUMBER"]);

export function assertSupportedExportColumns(
  columns: readonly string[],
  columnMeta?: ReadonlyMap<string, CsvExportColumnMeta>
): void {
  for (const column of columns) {
    const fieldType = columnMeta?.get(column)?.fieldType;
    if (fieldType === "SUBTABLE") {
      throw new ExportSinkUnsupportedColumnError(
        `column ${JSON.stringify(column)} is a SUBTABLE; select the APP$明細 virtual table to export subtable rows.`
      );
    }
    if (fieldType === "FILE") {
      throw new ExportSinkUnsupportedColumnError(
        `column ${JSON.stringify(column)} is a FILE field; attachment export is not supported.`
      );
    }
  }
}

function invalidCell(rowNumber: number, column: string, reason: string): never {
  throw new ExportSinkInvalidValueError(
    `data row ${rowNumber}, column ${JSON.stringify(column)} ${reason}`
  );
}

function parseArray(value: string, rowNumber: number, column: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { return invalidCell(rowNumber, column, "does not contain a valid JSON array."); }
  if (!Array.isArray(parsed)) return invalidCell(rowNumber, column, "does not contain a JSON array.");
  return parsed;
}

export function serializeExportCell(
  value: unknown,
  column: string,
  rowNumber: number,
  meta: CsvExportColumnMeta | undefined,
  timezoneFormatter?: Intl.DateTimeFormat
): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") return invalidCell(rowNumber, column, "has a non-string value.");

  const fieldType = meta?.fieldType;
  if (fieldType && STRING_ARRAY_FIELDS.has(fieldType)) {
    const values = parseArray(value, rowNumber, column);
    if (!values.every((item): item is string => typeof item === "string")) {
      return invalidCell(rowNumber, column, "must contain only string array elements.");
    }
    return values.join("\n");
  }
  if (fieldType && CODE_ARRAY_FIELDS.has(fieldType)) {
    const values = parseArray(value, rowNumber, column);
    const codes: string[] = [];
    for (const item of values) {
      if (item === null || typeof item !== "object" || Array.isArray(item)
        || typeof (item as { code?: unknown }).code !== "string") {
        return invalidCell(rowNumber, column, "must contain objects with string code properties.");
      }
      codes.push((item as { code: string }).code);
    }
    return codes.join("\n");
  }
  if (fieldType && NUMERIC_FIELDS.has(fieldType) && /[eE]/.test(value)) {
    try { return expandExponentialDecimal(value); }
    catch (error) {
      if (error instanceof ExportSinkInvalidValueError) {
        return invalidCell(rowNumber, column, error.message.replace(/^ExportSinkInvalidValueError: /, ""));
      }
      throw error;
    }
  }
  if (fieldType === "DATETIME") {
    try {
      if (timezoneFormatter) return formatDateTimeInTimezone(value, timezoneFormatter);
      assertValidUtcDateTime(value);
      return value;
    } catch (error) {
      if (error instanceof ExportSinkInvalidValueError) {
        return invalidCell(rowNumber, column, "has an invalid DATETIME value.");
      }
      throw error;
    }
  }
  return value;
}
