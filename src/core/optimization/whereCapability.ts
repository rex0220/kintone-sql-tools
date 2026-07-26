import type { CompareOp, FieldRef, FieldValue, SqlValue, WhereExpr } from "../../types/ast";
import type { ResolvedFieldSemantics } from "../fieldSemantics";
import {
  LEGACY_KINTONE_FUNCTION_NAMES,
  isRelativeDateFunctionName,
} from "../relativeDateFunction";

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
    | "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE"
    | "WHERE_EXPRESSION_LOCAL_ONLY"
    | "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED"
    | "WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED"
    | "WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED"
    | "WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN"
    | "WHERE_RELATIVE_DATE_ARGUMENT_INVALID"
    | "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED"
    | "WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED"
    | "WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED"
    | "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN";
  readonly field?: string;
  readonly fieldType?: string;
  readonly operator?: string;
  readonly functionName?: string;
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
const RELATIVE_DATE_FIELD_TYPES = new Set([
  "DATE", "DATETIME", "CREATED_TIME", "UPDATED_TIME",
]);
const RELATIVE_DATE_OPERATORS = new Set<NativeOperator>(RANGE_AND_EQUALITY);
const LEGACY_KINTONE_FUNCTION_FIELD_TYPES = new Map<string, ReadonlySet<string>>([
  ["TODAY", new Set(["DATE", "DATETIME", "CREATED_TIME", "UPDATED_TIME"])],
  ["NOW", new Set(["DATETIME", "CREATED_TIME", "UPDATED_TIME"])],
  ["LOGINUSER", new Set(["CREATOR", "MODIFIER", "USER_SELECT"])],
]);
const LEGACY_KINTONE_FUNCTION_OPERATORS = new Map<string, ReadonlySet<NativeOperator>>([
  ["TODAY", new Set(RANGE_AND_EQUALITY)],
  ["NOW", new Set(RANGE_AND_EQUALITY)],
  ["LOGINUSER", new Set(["in", "not in"])],
]);
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

/**
 * B78 の局所意味論を制限する partial policy。
 * 未掲載型へ一般化せず、既存の hasLocalContract() に委譲する。
 */
const LOCAL_VALID_OPERATORS = new Map<string, ReadonlySet<NativeOperator>>([
  ["CREATOR", new Set(["in", "not in"])],
  ["MODIFIER", new Set(["in", "not in"])],
  ["CHECK_BOX", new Set(["in", "not in"])],
  ["MULTI_SELECT", new Set(["in", "not in"])],
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
    case "BOOLEAN":
      return { capability: "LOCAL_ONLY", reasons: [{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }] };
    case "BINARY":
      return classifyBinary(where.op, where.left, where.right, resolveField);
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
      if (inner.capability !== "SUPERSET_PREFILTER") return inner;
      if (!hasRelativeDateReason(inner.reasons)) {
        return { capability: "LOCAL_ONLY", reasons: [{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }] };
      }
      return requireExactFunctionPushdown({
        capability: "LOCAL_ONLY",
        reasons: [{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }, ...inner.reasons],
      });
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
  right: SqlValue,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  if (right.type === "KINTONE_FUNC" && isRelativeDateFunctionName(right.name)) {
    return classifyRelativeDateBinary(op, left, right, resolveField);
  }
  if (right.type === "KINTONE_FUNC" && isLegacyKintoneFunction(right)) {
    return classifyLegacyKintoneFunctionBinary(op, left, right, resolveField);
  }
  if (left.type !== "FIELD") return localExpression();
  const semantics = resolveField(left);
  if (!semantics) {
    return unsupported("WHERE_FIELD_UNRESOLVED", left.field, undefined, normalizeOperator(op));
  }
  const nativeOp = normalizeOperator(op);
  if (!isLocallyValidOperator(semantics.fieldType, nativeOp)) {
    return unsupported(
      "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE",
      left.field,
      semantics.fieldType,
      nativeOp
    );
  }
  if (!hasLocalContract(semantics.fieldType, op)) {
    return unsupported("WHERE_OPERATOR_UNSUPPORTED", left.field, semantics.fieldType, nativeOp);
  }

  const native = nativeWhereOperatorsForType(semantics.fieldType);
  const rightCanPush = right.type === "STRING" || right.type === "NUMBER" || right.type === "IN_LIST"
    || isLegacyKintoneFunction(right);
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

function isLegacyKintoneFunction(value: SqlValue): boolean {
  return value.type === "KINTONE_FUNC"
    && LEGACY_KINTONE_FUNCTION_NAMES.has(value.name);
}

/**
 * TODAY / NOW / LOGINUSER の公式 field type × operator 契約を判定する。
 * LOGINUSER の公開 IN-list parser 配線は Step 3 で行う。
 */
function classifyLegacyKintoneFunctionBinary(
  op: CompareOp,
  left: FieldValue,
  right: Extract<SqlValue, { type: "KINTONE_FUNC" }>,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  const operator = normalizeOperator(op);
  const functionName = right.name;
  if (!LEGACY_KINTONE_FUNCTION_NAMES.has(functionName) || left.type !== "FIELD") {
    return legacyKintoneFunctionUnsupported(
      "WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED",
      functionName,
      undefined,
      undefined,
      operator
    );
  }

  const semantics = resolveField(left);
  const validFieldTypes = LEGACY_KINTONE_FUNCTION_FIELD_TYPES.get(functionName)!;
  if (
    !semantics
    || !validFieldTypes.has(semantics.fieldType)
    || semantics.inSubtable
    || semantics.requiresCollectionOperators
  ) {
    return legacyKintoneFunctionUnsupported(
      "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
      functionName,
      left.field,
      semantics?.fieldType,
      operator
    );
  }

  const validOperators = LEGACY_KINTONE_FUNCTION_OPERATORS.get(functionName)!;
  if (!validOperators.has(operator)) {
    return legacyKintoneFunctionUnsupported(
      "WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED",
      functionName,
      left.field,
      semantics.fieldType,
      operator
    );
  }

  return {
    capability: "EXACT_PUSHDOWN",
    reasons: [{
      code: "WHERE_EXACT",
      functionName,
      field: left.field,
      fieldType: semantics.fieldType,
      operator,
    }],
  };
}

/**
 * B67 の相対日付比較 leaf を単体で判定する共有 classifier。
 * WHERE 全体の合成規則を通さず、Phase 1 と同じ exact 条件だけを確認する。
 */
export function classifyRelativeDateBinary(
  op: CompareOp,
  left: FieldValue,
  right: Extract<SqlValue, { type: "KINTONE_FUNC" }>,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  const operator = normalizeOperator(op);
  const functionName = right.name;
  if (left.type !== "FIELD") {
    return relativeDateUnsupported(
      "WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED",
      functionName,
      undefined,
      undefined,
      operator
    );
  }

  const semantics = resolveField(left);
  if (!semantics) {
    return relativeDateUnsupported(
      "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED",
      functionName,
      left.field,
      undefined,
      operator
    );
  }
  if (!hasValidRelativeDateArguments(right)) {
    return relativeDateUnsupported(
      "WHERE_RELATIVE_DATE_ARGUMENT_INVALID",
      functionName,
      left.field,
      semantics.fieldType,
      operator
    );
  }
  if (!RELATIVE_DATE_OPERATORS.has(operator)) {
    return relativeDateUnsupported(
      "WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED",
      functionName,
      left.field,
      semantics.fieldType,
      operator
    );
  }
  if (
    !RELATIVE_DATE_FIELD_TYPES.has(semantics.fieldType)
    || semantics.inSubtable
    || semantics.requiresCollectionOperators
  ) {
    return relativeDateUnsupported(
      "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED",
      functionName,
      left.field,
      semantics.fieldType,
      operator
    );
  }

  return {
    capability: "EXACT_PUSHDOWN",
    reasons: [{
      code: "WHERE_EXACT",
      functionName,
      field: left.field,
      fieldType: semantics.fieldType,
      operator,
    }],
  };
}

function hasValidRelativeDateArguments(
  value: Extract<SqlValue, { type: "KINTONE_FUNC" }>
): boolean {
  if (!("args" in value) || !value.args) return false;
  switch (value.name) {
    case "YESTERDAY":
    case "TOMORROW":
    case "THIS_YEAR":
    case "LAST_YEAR":
    case "NEXT_YEAR":
      return value.args.kind === "NONE";
    case "FROM_TODAY":
      return value.args.kind === "FROM_TODAY"
        && Number.isSafeInteger(value.args.offset)
        && value.args.offsetText === String(value.args.offset === 0 ? 0 : value.args.offset)
        && (value.args.unit === "DAYS" || value.args.unit === "WEEKS"
          || value.args.unit === "MONTHS" || value.args.unit === "YEARS");
    case "THIS_WEEK":
    case "LAST_WEEK":
    case "NEXT_WEEK":
      return value.args.kind === "WEEK"
        && (value.args.weekday === null || value.args.weekday === "SUNDAY"
          || value.args.weekday === "MONDAY" || value.args.weekday === "TUESDAY"
          || value.args.weekday === "WEDNESDAY" || value.args.weekday === "THURSDAY"
          || value.args.weekday === "FRIDAY" || value.args.weekday === "SATURDAY");
    case "THIS_MONTH":
    case "LAST_MONTH":
    case "NEXT_MONTH":
      return value.args.kind === "MONTH"
        && (value.args.day === null || value.args.day === "LAST"
          || (Number.isInteger(value.args.day) && value.args.day >= 1 && value.args.day <= 31));
    default:
      return false;
  }
}

function classifyLocalOnlyField(
  field: FieldRef,
  operator: string,
  resolveField: WhereFieldSemanticsResolver
): PredicateCapabilityResult {
  const semantics = resolveField(field);
  if (!semantics) return unsupported("WHERE_FIELD_UNRESOLVED", field.field, undefined, operator);
  if (!isLocallyValidOperator(semantics.fieldType, operator)) {
    return unsupported(
      "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE",
      field.field,
      semantics.fieldType,
      operator
    );
  }
  if (!LOCAL_SCALAR_TYPES.has(semantics.fieldType) && !LOCAL_COLLECTION_TYPES.has(semantics.fieldType)) {
    return unsupported("WHERE_OPERATOR_UNSUPPORTED", field.field, semantics.fieldType, operator);
  }
  return {
    capability: "LOCAL_ONLY",
    reasons: [{ code: "WHERE_RESIDUAL", field: field.field, fieldType: semantics.fieldType, operator }],
  };
}

function isLocallyValidOperator(fieldType: string, operator: string): boolean {
  const policy = LOCAL_VALID_OPERATORS.get(fieldType);
  return policy === undefined || policy.has(operator as NativeOperator);
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
    return requireExactFunctionPushdown({ capability: "UNSUPPORTED", reasons });
  }
  if (left.capability === "EXACT_PUSHDOWN" && right.capability === "EXACT_PUSHDOWN") {
    return { capability: "EXACT_PUSHDOWN", reasons };
  }
  if (op === "AND" && (left.capability === "EXACT_PUSHDOWN" || right.capability === "EXACT_PUSHDOWN"
    || left.capability === "SUPERSET_PREFILTER" || right.capability === "SUPERSET_PREFILTER")) {
    return requireExactFunctionPushdown({
      capability: "SUPERSET_PREFILTER",
      reasons: [{ code: "WHERE_SUPERSET_PREFILTER" }, ...reasons],
    });
  }
  return requireExactFunctionPushdown({ capability: "LOCAL_ONLY", reasons });
}

function localExpression(): PredicateCapabilityResult {
  return { capability: "LOCAL_ONLY", reasons: [{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }] };
}

function unsupported(
  code:
    | "WHERE_FIELD_UNRESOLVED"
    | "WHERE_OPERATOR_UNSUPPORTED"
    | "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE",
  field?: string,
  fieldType?: string,
  operator?: string
): PredicateCapabilityResult {
  return { capability: "UNSUPPORTED", reasons: [{ code, field, fieldType, operator }] };
}

type LegacyKintoneFunctionReasonCode =
  | "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED"
  | "WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED"
  | "WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED";

function legacyKintoneFunctionUnsupported(
  code: LegacyKintoneFunctionReasonCode,
  functionName: string,
  field?: string,
  fieldType?: string,
  operator?: string
): PredicateCapabilityResult {
  return requireExactFunctionPushdown({
    capability: "UNSUPPORTED",
    reasons: [{ code, functionName, field, fieldType, operator }],
  });
}

type RelativeDateReasonCode =
  | "WHERE_RELATIVE_DATE_ARGUMENT_INVALID"
  | "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED"
  | "WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED"
  | "WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED";

function relativeDateUnsupported(
  code: RelativeDateReasonCode,
  functionName: string,
  field?: string,
  fieldType?: string,
  operator?: string
): PredicateCapabilityResult {
  return requireExactRelativeDatePushdown({
    capability: "UNSUPPORTED",
    reasons: [{ code, functionName, field, fieldType, operator }],
  });
}

function hasRelativeDateReason(reasons: readonly PredicateCapabilityReason[]): boolean {
  return reasons.some((reason) =>
    reason.code.startsWith("WHERE_RELATIVE_DATE_")
    || (reason.functionName !== undefined && isRelativeDateFunctionName(reason.functionName))
  );
}

function hasLegacyKintoneFunctionReason(
  reasons: readonly PredicateCapabilityReason[]
): boolean {
  return reasons.some((reason) =>
    reason.code.startsWith("WHERE_KINTONE_FUNCTION_")
    || (reason.functionName !== undefined && LEGACY_KINTONE_FUNCTION_NAMES.has(reason.functionName))
  );
}

function requireExactRelativeDatePushdown(
  result: PredicateCapabilityResult
): PredicateCapabilityResult {
  if (
    result.capability === "EXACT_PUSHDOWN"
    || !hasRelativeDateReason(result.reasons)
    || result.reasons.some((reason) => reason.code === "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN")
  ) {
    return result;
  }
  const relative = result.reasons.find((reason) =>
    reason.code.startsWith("WHERE_RELATIVE_DATE_")
    || (reason.functionName !== undefined && isRelativeDateFunctionName(reason.functionName))
  )!;
  return {
    capability: result.capability,
    reasons: [
      ...result.reasons,
      {
        code: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
        functionName: relative.functionName,
        field: relative.field,
        fieldType: relative.fieldType,
        operator: relative.operator,
      },
    ],
  };
}

function requireExactLegacyKintoneFunctionPushdown(
  result: PredicateCapabilityResult
): PredicateCapabilityResult {
  if (
    result.capability === "EXACT_PUSHDOWN"
    || !hasLegacyKintoneFunctionReason(result.reasons)
    || result.reasons.some((reason) =>
      reason.code === "WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN"
    )
  ) {
    return result;
  }
  const legacy = result.reasons.find((reason) =>
    reason.code.startsWith("WHERE_KINTONE_FUNCTION_")
    || (reason.functionName !== undefined && LEGACY_KINTONE_FUNCTION_NAMES.has(reason.functionName))
  )!;
  return {
    capability: result.capability,
    reasons: [
      ...result.reasons,
      {
        code: "WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN",
        functionName: legacy.functionName,
        field: legacy.field,
        fieldType: legacy.fieldType,
        operator: legacy.operator,
      },
    ],
  };
}

function requireExactFunctionPushdown(
  result: PredicateCapabilityResult
): PredicateCapabilityResult {
  return requireExactLegacyKintoneFunctionPushdown(
    requireExactRelativeDatePushdown(result)
  );
}
