import type { ResolvedFieldSemantics } from "../fieldSemantics";
import { compareCanonicalValues } from "../scalarCompare";
import {
  isCanonicalJoinDate,
  isCanonicalJoinDateTime,
  isCanonicalJoinTime,
} from "./joinDateTimeLiteralPolicy";
import { nativeWhereOperatorsForType } from "./whereCapability";

export type JoinKeyPrefilterReason =
  | "JOIN_KEY_FIELD_TYPE_UNRESOLVED"
  | "JOIN_KEY_OPERATOR_UNAVAILABLE"
  | "JOIN_KEY_SEMANTICS_UNRESOLVED"
  | "JOIN_KEY_EMPTY_VALUE"
  | "JOIN_KEY_NON_CANONICAL_VALUE"
  | "JOIN_KEY_LIMIT_EXCEEDED"
  | "JOIN_KEY_SOURCE_UNAVAILABLE"
  | "JOIN_KEY_SOURCE_KIND_UNSUPPORTED"
  | "JOIN_KEY_VALUES_RUNTIME";

export type JoinKeyPrefilterPlan =
  | { readonly kind: "EMPTY_SOURCE" }
  | { readonly kind: "IN"; readonly values: readonly string[]; readonly relation: "exact" }
  | { readonly kind: "RANGE"; readonly min: string; readonly max: string; readonly relation: "superset" }
  | { readonly kind: "RANGE_CANDIDATE"; readonly relation: "superset"; readonly reason: "JOIN_KEY_VALUES_RUNTIME" }
  | { readonly kind: "FALLBACK"; readonly reason: JoinKeyPrefilterReason };

export interface JoinKeyPrefilterInput {
  readonly fieldType?: string;
  readonly sourceSemantics?: ResolvedFieldSemantics;
  readonly sourceRowCount?: number;
  readonly values?: readonly string[];
  readonly hasEmptyValue?: boolean;
  readonly maxInKeys: number;
}

const DATETIME_TYPES = new Set(["DATETIME", "CREATED_TIME", "UPDATED_TIME"]);

function canonicalFor(fieldType: string, value: string): boolean {
  if (fieldType === "DATE") return isCanonicalJoinDate(value);
  if (fieldType === "TIME") return isCanonicalJoinTime(value);
  if (DATETIME_TYPES.has(fieldType)) return isCanonicalJoinDateTime(value);
  return false;
}

function semanticsMatch(fieldType: string, semantics: ResolvedFieldSemantics | undefined): boolean {
  if (!semantics || semantics.compareMode !== "string") return false;
  if (fieldType === "DATE") return semantics.fieldType === "DATE";
  if (fieldType === "TIME") return semantics.fieldType === "TIME";
  if (DATETIME_TYPES.has(fieldType)) return DATETIME_TYPES.has(semantics.fieldType);
  return false;
}

export function planJoinKeyPrefilter(input: JoinKeyPrefilterInput): JoinKeyPrefilterPlan {
  if (input.sourceRowCount === 0) return { kind: "EMPTY_SOURCE" };
  if (!input.fieldType) {
    return { kind: "FALLBACK", reason: "JOIN_KEY_FIELD_TYPE_UNRESOLVED" };
  }

  const operators = nativeWhereOperatorsForType(input.fieldType);
  if (operators.has("in")) {
    if (input.values === undefined) {
      return { kind: "FALLBACK", reason: "JOIN_KEY_VALUES_RUNTIME" };
    }
    const values = [...new Set(input.values.filter((value) => value.length > 0))];
    if (values.length === 0) return { kind: "EMPTY_SOURCE" };
    if (values.length > input.maxInKeys) {
      return { kind: "FALLBACK", reason: "JOIN_KEY_LIMIT_EXCEEDED" };
    }
    return { kind: "IN", values, relation: "exact" };
  }

  if (!operators.has(">=") || !operators.has("<=")) {
    return { kind: "FALLBACK", reason: "JOIN_KEY_OPERATOR_UNAVAILABLE" };
  }
  if (input.values === undefined) {
    return { kind: "RANGE_CANDIDATE", relation: "superset", reason: "JOIN_KEY_VALUES_RUNTIME" };
  }
  if (!semanticsMatch(input.fieldType, input.sourceSemantics)) {
    return { kind: "FALLBACK", reason: "JOIN_KEY_SEMANTICS_UNRESOLVED" };
  }
  const sourceSemantics = input.sourceSemantics!;
  if (input.hasEmptyValue) {
    return { kind: "FALLBACK", reason: "JOIN_KEY_EMPTY_VALUE" };
  }
  const values = [...new Set(input.values)];
  if (values.some((value) => !canonicalFor(input.fieldType!, value))) {
    return { kind: "FALLBACK", reason: "JOIN_KEY_NON_CANONICAL_VALUE" };
  }
  if (values.length === 0) {
    return { kind: "FALLBACK", reason: "JOIN_KEY_EMPTY_VALUE" };
  }

  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    if (compareCanonicalValues(value, min, sourceSemantics) < 0) min = value;
    if (compareCanonicalValues(value, max, sourceSemantics) > 0) max = value;
  }
  return { kind: "RANGE", min, max, relation: "superset" };
}
