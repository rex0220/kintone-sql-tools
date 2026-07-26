export const RELATIVE_DATE_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "YESTERDAY",
  "TOMORROW",
  "FROM_TODAY",
  "THIS_WEEK",
  "LAST_WEEK",
  "NEXT_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
  "NEXT_MONTH",
  "THIS_YEAR",
  "LAST_YEAR",
  "NEXT_YEAR",
]);

export const LEGACY_KINTONE_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "TODAY",
  "NOW",
  "LOGINUSER",
]);

export const SERVER_ONLY_WHERE_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  ...LEGACY_KINTONE_FUNCTION_NAMES,
  ...RELATIVE_DATE_FUNCTION_NAMES,
]);

export const WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN =
  "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN";

export const WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN =
  "WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN";

export function isRelativeDateFunctionName(name: string): boolean {
  return RELATIVE_DATE_FUNCTION_NAMES.has(name);
}

export function isLegacyKintoneFunctionName(name: string): boolean {
  return LEGACY_KINTONE_FUNCTION_NAMES.has(name);
}

export function isServerOnlyWhereFunctionName(name: string): boolean {
  return SERVER_ONLY_WHERE_FUNCTION_NAMES.has(name);
}
