import type { CompareOp, FieldRef, FieldValue, SqlValue, WhereExpr } from "../../types/ast";
import type { ResolvedFieldSemantics } from "../fieldSemantics";

export type PredicateCapability =
  | "EXACT_PUSHDOWN"
  | "SUPERSET_PREFILTER"
  | "LOCAL_ONLY"
  | "UNSUPPORTED";

export interface PredicateCapabilityReason {
  readonly code:
    | "WHERE_EXACT"
    | "WHERE_RESIDUAL"
    | "WHERE_SUPERSET_PREFILTER"
    | "WHERE_FIELD_UNRESOLVED"
    | "WHERE_OPERATOR_UNSUPPORTED"
    | "WHERE_EXPRESSION_LOCAL_ONLY";
  readonly field?: string;
  readonly fieldType?: string;
  readonly operator?: string;
}

export interface PredicateCapabilityResult {
  readonly capability: PredicateCapability;
  readonly reasons: readonly PredicateCapabilityReason[];
}

export type WhereFieldSemanticsResolver = (
  field: FieldRef
) => ResolvedFieldSemantics | undefined;

type NativeOperator = "=" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "not in" | "like" | "not like";

const RANGE_AND_EQUALITY = ["=", "!=", ">", "<", ">=", "<="] as const;
const EQUALITY_IN = ["=", "!=", "in", "not in"] as const;
const NATIVE_OPERATORS = new Map<string, ReadonlySet<NativeOperator>>([
  ["RECORD_NUMBER", new Set([...RANGE_AND_EQUALITY, "in", "not in"])],
  ["__ID__", new Set([...RANGE_AND_EQUALITY, "in", "not in"])],
  ["CREATOR", new Set(["in", "not in"])],
  ["MODIFIER", new Set(["in", "not in"])],
  ["CREATED_TIME", new Set(RANGE_AND_EQUALITY)],
  ["UPDATED_TIME", new Set(RANGE_AND_EQUALITY)],
  ["DATE", new Set(RANGE_AND_EQUALITY)],
  ["TIME", new Set(RANGE_AND_EQUALITY)],
  ["DATETIME", new Set(RANGE_AND_EQUALITY)],
  ["SINGLE_LINE_TEXT", new Set(["=", "!=", "in", "not in", "like", "not like"])],
  ["LINK", new Set(["=", "!=", "in", "not in", "like", "not like"])],
  ["NUMBER", new Set([...RANGE_AND_EQUALITY, "in", "not in"])],
  ["CALC", new Set([...RANGE_AND_EQUALITY, "in", "not in"])],
  ["MULTI_LINE_TEXT", new Set(["like", "not like"])],
  ["RICH_TEXT", new Set(["like", "not like"])],
  ["CHECK_BOX", new Set(["in", "not in"])],
  ["RADIO_BUTTON", new Set(["in", "not in"])],
  ["DROP_DOWN", new Set(["in", "not in"])],
  ["MULTI_SELECT", new Set(["in", "not in"])],
  ["FILE", new Set(["like", "not like"])],
  ["USER_SELECT", new Set(["in", "not in"])],
  ["ORGANIZATION_SELECT", new Set(["in", "not in"])],
  ["GROUP_SELECT", new Set(["in", "not in"])],
  ["STATUS", new Set(EQUALITY_IN)],
]);

const LOCAL_SCALAR_TYPES = new Set([
  "RECORD_NUMBER", "__ID__", "CREATOR", "MODIFIER",
  "CREATED_TIME", "UPDATED_TIME", "DATE", "TIME", "DATETIME",
  "SINGLE_LINE_TEXT", "LINK", "NUMBER", "CALC", "MULTI_LINE_TEXT", "RICH_TEXT",
  "RADIO_BUTTON", "DROP_DOWN", "STATUS",
  // 一時表・CTE・式列は kintone REST へは送らず、共有ローカル評価器で扱う。
  "KSQL_STRING", "KSQL_NUMBER", "KSQL_BOOLEAN",
]);

const LOCAL_COLLECTION_TYPES = new Set([
  "CHECK_BOX", "MULTI_SELECT", "FILE", "USER_SELECT", "ORGANIZATION_SELECT",
  "GROUP_SELECT", "STATUS_ASSIGNEE", "CATEGORY",
]);

export function nativeWhereOperatorsForType(fieldType: string): ReadonlySet<NativeOperator> {
  return NATIVE_OPERATORS.get(fieldType) ?? new Set();
}

export function classifyWhereCapability(
  where: WhereExpr | null,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  if (where === null) {
    return { capability: "EXACT_PUSHDOWN", reasons: [{ code: "WHERE_EXACT" }] };
  }
  return classifyNode(where, resolveField);
}

function classifyNode(
  where: WhereExpr,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  switch (where.type) {
    case "BINARY":
      return classifyBinary(where.op, where.left, where.right.type, resolveField);
    case "NULL_CHECK":
      if (where.field.type !== "FIELD") return localExpression();
      return classifyLocalOnlyField(where.field, where.not ? "IS NOT NULL" : "IS NULL", resolveField);
    case "EXISTS":
      return localExpression();
    case "GROUP":
      return classifyNode(where.expr, resolveField);
    case "NOT": {
      const inner = classifyNode(where.expr, resolveField);
      // 上位集合の補集合は上位集合ではないため、NOT の外へ prefilter 能力を漏らさない。
      return inner.capability === "SUPERSET_PREFILTER"
        ? { capability: "LOCAL_ONLY", reasons: [{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }] }
        : inner;
    }
    case "LOGICAL": {
      const left = classifyNode(where.left, resolveField);
      const right = classifyNode(where.right, resolveField);
      return combineLogical(where.op, left, right);
    }
  }
}

function classifyBinary(
  op: CompareOp,
  left: FieldValue,
  rightType: SqlValue["type"],
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  if (left.type !== "FIELD") return localExpression();
  const semantics = resolveField(left);
  if (!semantics) {
    return unsupported("WHERE_FIELD_UNRESOLVED", left.field, undefined, normalizeOperator(op));
  }
  if (!hasLocalContract(semantics.fieldType, op)) {
    return unsupported("WHERE_OPERATOR_UNSUPPORTED", left.field, semantics.fieldType, normalizeOperator(op));
  }

  const nativeOp = normalizeOperator(op);
  const native = nativeWhereOperatorsForType(semantics.fieldType);
  const rightCanPush = rightType === "STRING" || rightType === "NUMBER" || rightType === "IN_LIST"
    || rightType === "KINTONE_FUNC";
  const structureAllows = !semantics.requiresCollectionOperators || (nativeOp !== "=" && nativeOp !== "!=");
  const sqlLikeIsResidual = op === "LIKE" || op === "NOT_LIKE";
  if (rightCanPush && structureAllows && native.has(nativeOp) && !sqlLikeIsResidual) {
    return {
      capability: "EXACT_PUSHDOWN",
      reasons: [{
        code: "WHERE_EXACT",
        field: left.field,
        fieldType: semantics.fieldType,
        operator: nativeOp,
      }],
    };
  }
  return {
    capability: "LOCAL_ONLY",
    reasons: [{
      code: "WHERE_RESIDUAL",
      field: left.field,
      fieldType: semantics.fieldType,
      operator: nativeOp,
    }],
  };
}

function classifyLocalOnlyField(
  field: FieldRef,
  operator: string,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  const semantics = resolveField(field);
  if (!semantics) return unsupported("WHERE_FIELD_UNRESOLVED", field.field, undefined, operator);
  if (!LOCAL_SCALAR_TYPES.has(semantics.fieldType) && !LOCAL_COLLECTION_TYPES.has(semantics.fieldType)) {
    return unsupported("WHERE_OPERATOR_UNSUPPORTED", field.field, semantics.fieldType, operator);
  }
  return {
    capability: "LOCAL_ONLY",
    reasons: [{ code: "WHERE_RESIDUAL", field: field.field, fieldType: semantics.fieldType, operator }],
  };
}

function hasLocalContract(fieldType: string, op: CompareOp): boolean {
  if (LOCAL_SCALAR_TYPES.has(fieldType)) return true;
  if (!LOCAL_COLLECTION_TYPES.has(fieldType)) return false;
  return op === "=" || op === "!=" || op === "<>" || op === "IN" || op === "NOT_IN"
    || op === "LIKE" || op === "NOT_LIKE" || op === "KLIKE" || op === "NOT_KLIKE";
}

function normalizeOperator(op: CompareOp): NativeOperator {
  switch (op) {
    case "<>": return "!=";
    case "IN": return "in";
    case "NOT_IN": return "not in";
    case "LIKE":
    case "KLIKE": return "like";
    case "NOT_LIKE":
    case "NOT_KLIKE": return "not like";
    default: return op;
  }
}

function combineLogical(
  op: "AND" | "OR",
  left: PredicateCapabilityResult,
  right: PredicateCapabilityResult
): PredicateCapabilityResult {
  const reasons = [...left.reasons, ...right.reasons];
  if (left.capability === "UNSUPPORTED" || right.capability === "UNSUPPORTED") {
    return { capability: "UNSUPPORTED", reasons };
  }
  if (left.capability === "EXACT_PUSHDOWN" && right.capability === "EXACT_PUSHDOWN") {
    return { capability: "EXACT_PUSHDOWN", reasons };
  }
  if (op === "AND" && (left.capability === "EXACT_PUSHDOWN" || right.capability === "EXACT_PUSHDOWN"
    || left.capability === "SUPERSET_PREFILTER" || right.capability === "SUPERSET_PREFILTER")) {
    return {
      capability: "SUPERSET_PREFILTER",
      reasons: [{ code: "WHERE_SUPERSET_PREFILTER" }, ...reasons],
    };
  }
  return { capability: "LOCAL_ONLY", reasons };
}

function localExpression(): PredicateCapabilityResult {
  return { capability: "LOCAL_ONLY", reasons: [{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }] };
}

function unsupported(
  code: "WHERE_FIELD_UNRESOLVED" | "WHERE_OPERATOR_UNSUPPORTED",
  field?: string,
  fieldType?: string,
  operator?: string
): PredicateCapabilityResult {
  return { capability: "UNSUPPORTED", reasons: [{ code, field, fieldType, operator }] };
}
