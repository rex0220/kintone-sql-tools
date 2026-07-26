import type { SelectMode } from "../../converter/selectToKintone";
import type {
  BinaryExpr,
  SelectStatement,
  WhereExpr,
} from "../../types/ast";
import type { KlikeExpr } from "../like";
import {
  isRelativeDateFunctionName,
} from "../relativeDateFunction";
import type {
  RelativeDatePrefilterPlan,
} from "./relativeDatePrefilterPlan";
import type {
  PredicateCapabilityResult,
} from "./whereCapability";

/**
 * statement walker が SELECT node の到達 context ごとに解決する B72 専用 bit。
 * Step 1 では walker へ未配線で、pure builder の明示入力としてのみ保持する。
 */
export interface RelativeDateFullScanExactContext {
  readonly allowFullScanExact: boolean;
}

export interface RelativeDateFullScanExactPlanInput {
  readonly select: SelectStatement;
  readonly selectMode: SelectMode;
  readonly capability: PredicateCapabilityResult;
  readonly context: RelativeDateFullScanExactContext;
  /**
   * whole WHERE の serialize 済み query。null は serialize failure を表す。
   */
  readonly serializedWholeWhere: string | null;
  /**
   * whole WHERE で要求される相対日付関数の occurrence 順リスト。
   * 同名関数も重複を保ったまま渡す。
   */
  readonly relativeFunctionNames: readonly string[];
}

/**
 * guard marker と既存 Phase2-A transport を分離して保持する。
 * runtime は prefilterPlan をそのまま既存 transport として利用できる。
 */
export interface RelativeDateFullScanExactPlan {
  readonly allowForm: "FULL_SCAN_EXACT";
  readonly clientWhereEvaluation: false;
  readonly serializedWholeWhere: string;
  readonly prefilterPlan: RelativeDatePrefilterPlan;
}

/**
 * B72 第3 allow-form の pure plan foundation。
 *
 * API 呼出しや module-global state を持たず、caller が解決済みの mode /
 * capability / serialize 結果 / context bit だけから plan を決定する。
 */
export function buildRelativeDateFullScanExactPlan(
  input: RelativeDateFullScanExactPlanInput
): RelativeDateFullScanExactPlan | null {
  const {
    select,
    selectMode,
    capability,
    context,
    serializedWholeWhere,
    relativeFunctionNames,
  } = input;

  if (select.where === null) return null;
  if (select.from.appId <= 0 || select.from.cteName !== null) return null;
  if (select.from.subtableCode) return null;
  if (select.joins.length > 0) return null;
  if (!context.allowFullScanExact) return null;
  if (select.orderMode === "KINTONE_NATIVE") return null;

  const hasCanonicalOrder =
    select.orderMode === "CANONICAL" && select.orderBy.length > 0;
  if (selectMode !== "FULL_SCAN" && !hasCanonicalOrder) return null;
  if (capability.capability !== "EXACT_PUSHDOWN") return null;

  const occurrences = relativeDateFunctionOccurrencesInWhere(select.where);
  if (occurrences.length === 0) return null;
  if (!sameOccurrenceList(occurrences, relativeFunctionNames)) return null;
  if (
    serializedWholeWhere === null
    || !serializedMultisetContains(serializedWholeWhere, occurrences)
  ) {
    return null;
  }

  const prefilterPlan: RelativeDatePrefilterPlan = {
    prefilterWhere: select.where,
    residualWhere: null,
    exactRelativeLeaves: collectExactRelativeLeaves(select.where),
    relativeFunctionNames: new Set(occurrences),
    appliedKlikes: new Set<KlikeExpr>(),
    capability: capability.capability,
    reasons: capability.reasons,
  };
  const plan: RelativeDateFullScanExactPlan = {
    allowForm: "FULL_SCAN_EXACT",
    clientWhereEvaluation: false,
    serializedWholeWhere,
    prefilterPlan,
  };
  assertRelativeDateFullScanExactPlan(plan, input, occurrences);
  return plan;
}

function assertRelativeDateFullScanExactPlan(
  plan: RelativeDateFullScanExactPlan,
  input: RelativeDateFullScanExactPlanInput,
  occurrences: readonly string[]
): void {
  if (plan.allowForm !== "FULL_SCAN_EXACT") {
    throw new Error("FULL_SCAN_EXACT invariant: allowForm");
  }
  if (plan.clientWhereEvaluation !== false) {
    throw new Error("FULL_SCAN_EXACT invariant: clientWhereEvaluation");
  }
  if (input.capability.capability !== "EXACT_PUSHDOWN") {
    throw new Error("FULL_SCAN_EXACT invariant: capability");
  }
  if (
    input.select.where === null
    || plan.prefilterPlan.prefilterWhere !== input.select.where
  ) {
    throw new Error("FULL_SCAN_EXACT invariant: whole WHERE identity");
  }
  if (plan.prefilterPlan.residualWhere !== null) {
    throw new Error("FULL_SCAN_EXACT invariant: residualWhere");
  }
  if (plan.prefilterPlan.capability !== "EXACT_PUSHDOWN") {
    throw new Error("FULL_SCAN_EXACT invariant: transport capability");
  }
  if (!serializedMultisetContains(plan.serializedWholeWhere, occurrences)) {
    throw new Error("FULL_SCAN_EXACT invariant: relative occurrence serialization");
  }
}

export function relativeDateFunctionOccurrencesInWhere(where: WhereExpr): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (value["type"] === "SELECT") return;
    if (
      value["type"] === "KINTONE_FUNC"
      && typeof value["name"] === "string"
      && isRelativeDateFunctionName(value["name"])
    ) {
      names.push(value["name"]);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(where);
  return names;
}

function collectExactRelativeLeaves(where: WhereExpr): BinaryExpr[] {
  const leaves: BinaryExpr[] = [];
  const visit = (node: WhereExpr): void => {
    switch (node.type) {
      case "BINARY":
        if (
          node.right.type === "KINTONE_FUNC"
          && isRelativeDateFunctionName(node.right.name)
        ) {
          leaves.push(node);
        }
        return;
      case "LOGICAL":
        visit(node.left);
        visit(node.right);
        return;
      case "NOT":
      case "GROUP":
        visit(node.expr);
        return;
      case "EXISTS":
      case "NULL_CHECK":
      case "BOOLEAN":
        return;
    }
  };
  visit(where);
  return leaves;
}

function sameOccurrenceList(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return actual.length === expected.length
    && actual.every((name, index) => name === expected[index]);
}

function serializedMultisetContains(
  query: string,
  expectedNames: readonly string[]
): boolean {
  const expected = new Map<string, number>();
  for (const name of expectedNames) {
    if (!isRelativeDateFunctionName(name)) return false;
    expected.set(name, (expected.get(name) ?? 0) + 1);
  }
  for (const [name, count] of expected) {
    const matches = query.match(new RegExp(`\\b${name}\\s*\\(`, "g"));
    if ((matches?.length ?? 0) < count) return false;
  }
  return true;
}
