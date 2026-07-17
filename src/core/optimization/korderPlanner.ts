import type { SelectStatement } from "../../types/ast";
import type { SelectMode } from "../../converter/selectToKintone";
import type { ResolvedFieldSemantics } from "../fieldSemantics";
import type { PredicateCapability } from "./whereCapability";
import type { CanonicalOrderPlan } from "./canonicalOrderPlanner";

const KORDER_NATIVE_FIELD_TYPES = new Set([
  "RECORD_NUMBER", "SINGLE_LINE_TEXT", "NUMBER", "CALC", "DATE", "DATETIME", "TIME",
  "CREATED_TIME", "UPDATED_TIME", "DROP_DOWN", "RADIO_BUTTON", "STATUS", "LINK",
  "CREATOR", "MODIFIER",
]);

export interface KorderPlanInput {
  readonly stmt: SelectStatement;
  readonly staticMode: SelectMode;
  readonly whereCapability: PredicateCapability;
  readonly orderSemantics: ReadonlyMap<string, ResolvedFieldSemantics>;
  readonly maxRecords: number;
  readonly hasKlike: boolean;
}

export function planKorderNative(input: KorderPlanInput): CanonicalOrderPlan {
  const { stmt } = input;
  const reasons: string[] = [];
  if (stmt.orderMode !== "KINTONE_NATIVE") reasons.push("KORDER_MODE_REQUIRED");
  if (stmt.from.cteName !== null || stmt.from.subtableCode || input.staticMode !== "SIMPLE") {
    reasons.push("KORDER_QUERY_SHAPE_UNSUPPORTED");
  }
  if (input.whereCapability !== "EXACT_PUSHDOWN") reasons.push("KORDER_WHERE_NOT_EXACT");
  if (input.hasKlike) reasons.push("KORDER_KLIKE_UNSUPPORTED");
  if (stmt.orderBy.length === 0) reasons.push("KORDER_KEY_REQUIRED");

  for (const item of stmt.orderBy) {
    if (item.key.type !== "FIELD_NAME") {
      reasons.push(`KORDER_KEY_NOT_DIRECT_FIELD(key=${item.key.type})`);
      continue;
    }
    const name = item.key.name;
    const semantics = input.orderSemantics.get(name);
    if (!semantics) {
      reasons.push(`KORDER_KEY_UNRESOLVED(field=${name})`);
      continue;
    }
    if (name === "$id") continue;
    if (!semantics.source || semantics.source.fieldCode !== name) {
      reasons.push(`KORDER_KEY_NOT_DIRECT_FIELD(field=${name})`);
      continue;
    }
    if (!KORDER_NATIVE_FIELD_TYPES.has(semantics.fieldType)) {
      reasons.push(`KORDER_TYPE_UNSUPPORTED(field=${name}, type=${semantics.fieldType})`);
    }
  }

  if (stmt.limit === null || stmt.limit < 0 || stmt.limit > 500) {
    reasons.push(`KORDER_LIMIT_INVALID(limit=${String(stmt.limit)})`);
  }
  if (stmt.limit !== null && stmt.limit > input.maxRecords) {
    reasons.push(`KORDER_LIMIT_EXCEEDS_MAX_RECORDS(limit=${stmt.limit}, maxRecords=${input.maxRecords})`);
  }
  const offset = stmt.offset ?? 0;
  if (offset < 0 || offset > 10_000) reasons.push(`KORDER_OFFSET_INVALID(offset=${offset})`);

  const unique = [...new Set(reasons)];
  if (unique.length > 0) {
    throw new Error(
      `ArgumentError: KORDER BY cannot be executed (mode=KINTONE_NATIVE; ${unique.join(", ")}). ` +
      "Use ORDER BY for canonical local ordering or simplify the query."
    );
  }
  return {
    kind: "KORDER_NATIVE",
    requiresCompleteInput: false,
    localOrderBy: false,
    applyLocalOffsetLimit: false,
    reasonCodes: [],
  };
}
