import type { BinaryExpr, FieldRef, SqlValue } from "../../types/ast";
import { isCanonicalJoinDate, isCanonicalJoinDateTime, isCanonicalJoinTime } from "./joinDateTimeLiteralPolicy";
import { isJoinNumberLiteralSupported } from "./joinNumberLiteralPolicy";

export type SupportedLeafRelation = "exact" | "superset" | "unsafe";

export interface SupportedLeafMetadata {
  readonly fieldCode: string;
  readonly fieldType: string;
  readonly fieldOptions?: ReadonlySet<string>;
}

const SELECTION_TYPES = new Set([
  "DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT", "STATUS",
]);

const USER_CODE_TYPES = new Set([
  "CREATOR", "MODIFIER", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT",
  "STATUS_ASSIGNEE",
]);

const KLIKE_TYPES = new Set([
  "SINGLE_LINE_TEXT", "LINK", "MULTI_LINE_TEXT", "RICH_TEXT", "FILE",
]);

const DATETIME_TYPES = new Set(["DATETIME", "CREATED_TIME", "UPDATED_TIME"]);

/** Ownership-independent B151/B152 leaf policy shared by JOIN and fallback planners. */
export function classifySupportedLeaf(
  predicate: BinaryExpr,
  metadata: SupportedLeafMetadata
): SupportedLeafRelation {
  const { fieldCode, fieldType, fieldOptions } = metadata;
  if (fieldType.startsWith("KSQL_")) return "unsafe";
  if (predicate.op === "LIKE" || predicate.op === "NOT_LIKE") return "unsafe";

  if (predicate.op === "KLIKE" || predicate.op === "NOT_KLIKE") {
    return KLIKE_TYPES.has(fieldType)
      && predicate.right.type === "STRING"
      && predicate.right.value !== ""
      ? "exact"
      : "unsafe";
  }

  if (fieldType === "__ID__" || fieldCode === "$id") {
    return isPositiveSafeInteger(predicate.right)
      && (predicate.op === "=" || predicate.op === "<" || predicate.op === ">"
        || predicate.op === "<=" || predicate.op === ">=")
      ? "exact"
      : "unsafe";
  }

  if (fieldType === "RECORD_NUMBER" || fieldType === "CALC") {
    return classifySupersetScalarOrListLiteral(predicate);
  }

  if (fieldType === "NUMBER") {
    if ((predicate.op === "IN" || predicate.op === "NOT_IN")
      && predicate.right.type === "IN_LIST"
      && predicate.right.values.length > 0
      && predicate.right.values.every((value) =>
        value.type === "NUMBER" && isJoinNumberLiteralSupported(value))) {
      return "exact";
    }
    return (predicate.op === "=" || predicate.op === "!=" || predicate.op === "<>"
      || predicate.op === "<" || predicate.op === ">"
      || predicate.op === "<=" || predicate.op === ">=")
      && predicate.right.type === "NUMBER"
      && isJoinNumberLiteralSupported(predicate.right)
      ? "exact"
      : "unsafe";
  }

  if (USER_CODE_TYPES.has(fieldType)) {
    return isNonEmptyStringList(predicate) ? "exact" : "unsafe";
  }

  if (fieldType === "SINGLE_LINE_TEXT" || fieldType === "LINK") {
    if (isNonEmptyStringList(predicate)) return "exact";
    return (predicate.op === "=" || predicate.op === "!=" || predicate.op === "<>")
      && predicate.right.type === "STRING"
      && predicate.right.value !== ""
      ? "exact"
      : "unsafe";
  }

  if (fieldType === "DATE" || fieldType === "TIME" || DATETIME_TYPES.has(fieldType)) {
    if ((predicate.op !== "=" && predicate.op !== "!=" && predicate.op !== "<>"
      && predicate.op !== "<" && predicate.op !== ">"
      && predicate.op !== "<=" && predicate.op !== ">=")
      || predicate.right.type !== "STRING") return "unsafe";
    if (fieldType === "DATE") return isCanonicalJoinDate(predicate.right.value) ? "exact" : "unsafe";
    if (fieldType === "TIME") return isCanonicalJoinTime(predicate.right.value) ? "exact" : "unsafe";
    return isCanonicalJoinDateTime(predicate.right.value) ? "exact" : "unsafe";
  }

  if (SELECTION_TYPES.has(fieldType)) {
    if (!isNonEmptyStringList(predicate) || fieldOptions === undefined) return "unsafe";
    return predicate.right.type === "IN_LIST"
      && predicate.right.values.every((value) =>
        value.type === "STRING" && fieldOptions.has(value.value))
      ? "exact"
      : "unsafe";
  }

  return "unsafe";
}

/** Metadata-free syntax gate kept beside the policy so operator families cannot drift. */
export function isSupportedLeafMetadataCandidate(
  predicate: BinaryExpr,
  isTargetField: (field: FieldRef) => boolean
): boolean {
  if (predicate.left.type !== "FIELD" || predicate.left.field === "$id") return false;
  if (!isTargetField(predicate.left)) return false;
  if (predicate.op === "IN" || predicate.op === "NOT_IN") {
    if (predicate.right.type !== "IN_LIST" || predicate.right.values.length === 0) return false;
    const firstType = predicate.right.values[0].type;
    if (firstType !== "NUMBER" && firstType !== "STRING") return false;
    return predicate.right.values.every((value) =>
      value.type === firstType && (value.type !== "STRING" || value.value !== ""));
  }
  if (predicate.op !== "=" && predicate.op !== "!=" && predicate.op !== "<>"
    && predicate.op !== "<" && predicate.op !== ">"
    && predicate.op !== "<=" && predicate.op !== ">=") return false;
  return predicate.right.type === "NUMBER"
    || (predicate.right.type === "STRING" && predicate.right.value !== "");
}

function isNonEmptyStringList(predicate: BinaryExpr): boolean {
  return (predicate.op === "IN" || predicate.op === "NOT_IN")
    && predicate.right.type === "IN_LIST"
    && predicate.right.values.length > 0
    && predicate.right.values.every((value) => value.type === "STRING" && value.value !== "");
}

function classifySupersetScalarOrListLiteral(predicate: BinaryExpr): SupportedLeafRelation {
  const supportedLiteral = (value: SqlValue): boolean =>
    (value.type === "NUMBER" && isJoinNumberLiteralSupported(value))
    || (value.type === "STRING" && value.value !== "");
  if ((predicate.op === "IN" || predicate.op === "NOT_IN")
    && predicate.right.type === "IN_LIST") {
    const values = predicate.right.values;
    if (values.length > 0 && values.every(supportedLiteral)
      && values.every((value) => value.type === values[0].type)) return "superset";
  }
  return (predicate.op === "=" || predicate.op === "!=" || predicate.op === "<>"
    || predicate.op === "<" || predicate.op === ">"
    || predicate.op === "<=" || predicate.op === ">=")
    && supportedLiteral(predicate.right)
    ? "superset"
    : "unsafe";
}

function isPositiveSafeInteger(value: SqlValue): boolean {
  return value.type === "NUMBER" && Number.isSafeInteger(value.value) && value.value > 0;
}
