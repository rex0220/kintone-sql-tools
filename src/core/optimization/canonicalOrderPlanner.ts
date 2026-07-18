import type { OrderByItem, SelectStatement } from "../../types/ast";
import type { SelectMode } from "../../converter/selectToKintone";
import type { ResolvedFieldSemantics } from "../fieldSemantics";
import type { PredicateCapability } from "./whereCapability";

export type CanonicalOrderPlanKind =
  | "CANONICAL_REST_TOP_N"
  | "CANONICAL_LOCAL"
  | "KORDER_NATIVE"
  | "KORDER_CURSOR";

export type CanonicalOrderReasonCode =
  | "ORDER_KEY_NOT_REST_EQUIVALENT"
  | "ORDER_KEY_AMBIGUOUS"
  | "ORDER_KEY_UNRESOLVED"
  | "ORDER_KEY_UNSUPPORTED"
  | "WHERE_NOT_EXACT"
  | "QUERY_SHAPE_LOCAL"
  | "LIMIT_NOT_REST_WINDOW"
  | "OFFSET_NOT_REST_WINDOW"
  | "MAX_RECORDS_WINDOW"
  | "KLIKE_NOT_REST_WINDOW";

export interface CanonicalOrderPlan {
  readonly kind: CanonicalOrderPlanKind;
  readonly requiresCompleteInput: boolean;
  readonly localOrderBy: boolean;
  readonly applyLocalOffsetLimit: boolean;
  readonly reasonCodes: readonly CanonicalOrderReasonCode[];
  /** KORDER_CURSOR が先頭から走査する行数。KORDER plan だけが設定する。 */
  readonly scanRows?: number;
}

export interface CanonicalOrderPlanInput {
  readonly stmt: SelectStatement;
  readonly staticMode: SelectMode;
  readonly whereCapability: PredicateCapability;
  readonly orderSemantics: ReadonlyMap<string, ResolvedFieldSemantics>;
  readonly maxRecords: number;
  readonly hasKlike: boolean;
}

const REST_OFFSET_MAX = 10_000;
const REST_LIMIT_MAX = 500;

function fieldSemantics(
  item: OrderByItem,
  semantics: ReadonlyMap<string, ResolvedFieldSemantics>
): ResolvedFieldSemantics | undefined {
  return item.key.type === "FIELD_NAME" ? semantics.get(item.key.name) : undefined;
}

/**
 * 通常 ORDER BY の実行主体を決める純粋 planner。
 * 初期 REST top-N allowlist は $id だけであり、REST が受理する他型を流用しない。
 */
export function planCanonicalOrder(input: CanonicalOrderPlanInput): CanonicalOrderPlan {
  const { stmt } = input;
  const reasons: CanonicalOrderReasonCode[] = [];
  const windowOrderBy = stmt.columns.flatMap((column) =>
    column.type === "WINDOW_COL" ? column.orderBy : []
  );
  const allOrderBy = [...stmt.orderBy, ...windowOrderBy];

  for (const item of allOrderBy) {
    if (item.key.type !== "FIELD_NAME") continue;
    const semantics = fieldSemantics(item, input.orderSemantics);
    if (!semantics) {
      reasons.push("ORDER_KEY_UNRESOLVED");
      continue;
    }
    if (semantics.fieldType === "KSQL_AMBIGUOUS") reasons.push("ORDER_KEY_AMBIGUOUS");
    else if (semantics.compareMode === "unsupported") reasons.push("ORDER_KEY_UNSUPPORTED");
  }

  if (reasons.includes("ORDER_KEY_AMBIGUOUS")) {
    throw new Error(
      "ArgumentError: ORDER BY key is an ambiguous column reference " +
      "(reason=ORDER_KEY_AMBIGUOUS). Qualify the key with its table alias."
    );
  }
  if (reasons.includes("ORDER_KEY_UNSUPPORTED") || reasons.includes("ORDER_KEY_UNRESOLVED")) {
    const reason = reasons.includes("ORDER_KEY_UNSUPPORTED")
      ? "ORDER_KEY_UNSUPPORTED"
      : "ORDER_KEY_UNRESOLVED";
    throw new Error(`ArgumentError: ORDER BY key has no canonical comparison contract (reason=${reason}).`);
  }

  const allRestEquivalent = stmt.orderBy.length > 0 && windowOrderBy.length === 0 && stmt.orderBy.every((item) =>
    item.key.type === "FIELD_NAME" && item.key.name === "$id"
  );
  if (!allRestEquivalent) reasons.push("ORDER_KEY_NOT_REST_EQUIVALENT");
  if (input.whereCapability !== "EXACT_PUSHDOWN") reasons.push("WHERE_NOT_EXACT");
  if (input.staticMode !== "SIMPLE") reasons.push("QUERY_SHAPE_LOCAL");
  if (stmt.limit === null || stmt.limit < 0 || stmt.limit > REST_LIMIT_MAX) {
    reasons.push("LIMIT_NOT_REST_WINDOW");
  }
  if ((stmt.offset ?? 0) < 0 || (stmt.offset ?? 0) > REST_OFFSET_MAX) {
    reasons.push("OFFSET_NOT_REST_WINDOW");
  }
  if (stmt.limit !== null && stmt.limit > input.maxRecords) reasons.push("MAX_RECORDS_WINDOW");
  if (input.hasKlike) reasons.push("KLIKE_NOT_REST_WINDOW");

  if (reasons.length === 0) {
    return {
      kind: "CANONICAL_REST_TOP_N",
      requiresCompleteInput: false,
      localOrderBy: false,
      applyLocalOffsetLimit: false,
      reasonCodes: [],
    };
  }
  return {
    kind: "CANONICAL_LOCAL",
      requiresCompleteInput: allOrderBy.length > 0,
      localOrderBy: stmt.orderBy.length > 0,
      applyLocalOffsetLimit: stmt.orderBy.length > 0,
    reasonCodes: [...new Set(reasons)],
  };
}
