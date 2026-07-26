import { whereToKintone } from "../../converter/whereToKintone";
import type {
  BinaryExpr,
  FieldRef,
  SelectStatement,
  WhereExpr,
} from "../../types/ast";
import type { KlikeExpr } from "../like";
import {
  SERVER_ONLY_WHERE_FUNCTION_NAMES,
  isServerOnlyWhereFunctionName,
} from "../relativeDateFunction";
import {
  buildSingleTableKlikePushdownPlan,
} from "./klikePushdownPlan";
import { serializationContainsFunctions } from "./relativeDatePushdownGuard";
import {
  classifyWhereCapability,
  type PredicateCapability,
  type PredicateCapabilityReason,
  type WhereFieldSemanticsResolver,
} from "./whereCapability";

export interface RelativeDatePrefilterPlan {
  readonly prefilterWhere: WhereExpr | null;
  readonly residualWhere: WhereExpr | null;
  /** prefilter への serialize を個別確認した、元 AST 上の leaf。 */
  readonly exactRelativeLeaves: readonly BinaryExpr[];
  readonly relativeFunctionNames: ReadonlySet<string>;
  /** buildSingleTableKlikePushdownPlan と同じ leaf identity 集合。 */
  readonly appliedKlikes: ReadonlySet<KlikeExpr>;
  readonly capability: PredicateCapability;
  readonly reasons: readonly PredicateCapabilityReason[];
}

export type RelativeDatePrefilterIneligibleReason =
  | "NO_WHERE"
  | "NO_RELATIVE_DATE"
  | "NOT_DIRECT_PHYSICAL_APP"
  | "JOIN_UNSUPPORTED"
  | "SUBTABLE_UNSUPPORTED"
  | "RELATIVE_DATE_CONTEXT_UNSUPPORTED"
  | "RELATIVE_DATE_LEAF_NOT_EXACT"
  | "RELATIVE_DATE_LEAF_COUNT_MISMATCH"
  | "PREFILTER_SERIALIZATION_FAILED"
  | "PREFILTER_FUNCTION_MISSING"
  | "RESIDUAL_RELATIVE_DATE_REMAINED"
  | "CAPABILITY_NOT_SUPERSET_PREFILTER"
  | "DEFER_TO_PHASE1";

export interface EligibleRelativeDatePrefilterResult {
  readonly eligible: true;
  readonly plan: RelativeDatePrefilterPlan;
}

export interface IneligibleRelativeDatePrefilterResult {
  readonly eligible: false;
  readonly disposition: "INELIGIBLE" | "DEFER_PHASE1";
  readonly reasonCodes: readonly RelativeDatePrefilterIneligibleReason[];
  readonly capability: PredicateCapability;
  readonly reasons: readonly PredicateCapabilityReason[];
}

export type RelativeDatePrefilterDecomposition =
  | EligibleRelativeDatePrefilterResult
  | IneligibleRelativeDatePrefilterResult;

/**
 * failure path を決定的に検証するための unit-test seam。
 * 通常 caller は指定せず、production dependency をそのまま使用する。
 */
export interface RelativeDatePrefilterTestSeam {
  readonly serialize?: (where: WhereExpr) => string;
  readonly containsFunctions?: (query: string, names: readonly string[]) => boolean;
  readonly rewriteResidual?: (
    where: WhereExpr,
    adoptedLeaves: ReadonlySet<BinaryExpr>
  ) => WhereExpr | null;
}

const EMPTY_REASONS: readonly PredicateCapabilityReason[] = [];

/**
 * 単一の物理 APP SELECT を exact 相対日付 prefilter と client residual に分解する。
 *
 * 実行可否は変更せず、同じ leaf の classify / serialize / surgery 対応を
 * 1個の plan object に固定するだけの副作用なし primitive である。
 */
export function decomposeRelativeDatePrefilter(
  stmt: SelectStatement,
  resolveField: WhereFieldSemanticsResolver,
  testSeam: RelativeDatePrefilterTestSeam = {}
): RelativeDatePrefilterDecomposition {
  const capability = classifyWhereCapability(stmt.where, resolveField);
  const reject = (
    reasonCodes: readonly RelativeDatePrefilterIneligibleReason[],
    disposition: "INELIGIBLE" | "DEFER_PHASE1" = "INELIGIBLE"
  ): IneligibleRelativeDatePrefilterResult => ({
    eligible: false,
    disposition,
    reasonCodes,
    capability: capability.capability,
    reasons: capability.reasons,
  });

  if (stmt.where === null) return reject(["NO_WHERE"]);
  if (stmt.from.subtableCode) return reject(["SUBTABLE_UNSUPPORTED"]);
  if (stmt.joins.length > 0) return reject(["JOIN_UNSUPPORTED"]);
  if (stmt.from.cteName !== null || stmt.from.appId <= 0) {
    return reject(["NOT_DIRECT_PHYSICAL_APP"]);
  }

  const occurrences = collectServerFunctionOccurrences(stmt.where);
  if (occurrences.length === 0) return reject(["NO_RELATIVE_DATE"]);

  // capability 名だけで先に落とさず、AND-only / leaf exact の具体的な
  // decomposition failure を先に確定する。
  const spine = collectServerFunctionLeavesOnAndSpine(stmt.where, resolveField);
  if (!spine.ok) return reject(spine.reasonCodes);
  if (!sameRelativeMultiset(occurrences, spine.leaves)) {
    return reject(["RELATIVE_DATE_LEAF_COUNT_MISMATCH"]);
  }

  if (capability.capability === "EXACT_PUSHDOWN") {
    return reject(["DEFER_TO_PHASE1"], "DEFER_PHASE1");
  }
  if (capability.capability !== "SUPERSET_PREFILTER") {
    return reject(["CAPABILITY_NOT_SUPERSET_PREFILTER"]);
  }

  const fieldMetadata = collectFieldMetadata(stmt.where, resolveField);
  const safePlan = buildSingleTableKlikePushdownPlan(stmt.where, {
    tableAlias: stmt.from.alias ?? undefined,
    allowUnqualifiedFields: true,
    allowKlike: true,
    fieldTypes: fieldMetadata.fieldTypes,
    fieldOptions: fieldMetadata.fieldOptions,
  });

  const serialize = testSeam.serialize ?? whereToKintone;
  const containsFunctions =
    testSeam.containsFunctions ?? serializationContainsFunctions;
  const confirmedLeaves: BinaryExpr[] = [];
  for (const leaf of spine.leaves) {
    const name = serverFunctionNameOf(leaf);
    if (name === null) return reject(["RELATIVE_DATE_LEAF_COUNT_MISMATCH"]);
    let query: string;
    try {
      query = serialize(leaf);
    } catch {
      return reject(["PREFILTER_SERIALIZATION_FAILED"]);
    }
    if (!containsFunctions(query, [name])) {
      return reject(["PREFILTER_FUNCTION_MISSING"]);
    }
    confirmedLeaves.push(leaf);
  }

  const safeLeaves = collectBinaryIdentities(safePlan.condition);
  const adoptedLeaves = new Set<BinaryExpr>(confirmedLeaves);
  const prefilterWhere = selectPrefilterInOriginalOrder(
    stmt.where,
    adoptedLeaves,
    safeLeaves
  );
  if (prefilterWhere === null) {
    return reject(["RELATIVE_DATE_LEAF_COUNT_MISMATCH"]);
  }

  let prefilterQuery: string;
  try {
    prefilterQuery = serialize(prefilterWhere);
  } catch {
    return reject(["PREFILTER_SERIALIZATION_FAILED"]);
  }
  const expectedNames = confirmedLeaves.map((leaf) => serverFunctionNameOf(leaf)!);
  if (
    !containsFunctions(prefilterQuery, [...new Set(expectedNames)])
    || !serializedMultisetContains(prefilterQuery, expectedNames)
  ) {
    return reject(["PREFILTER_FUNCTION_MISSING"]);
  }

  const residualWhere = testSeam.rewriteResidual
    ? testSeam.rewriteResidual(stmt.where, adoptedLeaves)
    : replaceAdoptedLeaves(stmt.where, adoptedLeaves);
  if (
    residualWhere !== null
    && collectServerFunctionOccurrences(residualWhere).length > 0
  ) {
    return reject(["RESIDUAL_RELATIVE_DATE_REMAINED"]);
  }
  if (residualWhere === null) {
    return reject(["DEFER_TO_PHASE1"], "DEFER_PHASE1");
  }

  const relativeFunctionNames = new Set<string>();
  for (const name of expectedNames) relativeFunctionNames.add(name);
  return {
    eligible: true,
    plan: {
      prefilterWhere,
      residualWhere,
      exactRelativeLeaves: confirmedLeaves,
      relativeFunctionNames,
      appliedKlikes: safePlan.appliedKlikes,
      capability: capability.capability,
      reasons: capability.reasons,
    },
  };
}

type SpineResult =
  | { readonly ok: true; readonly leaves: readonly BinaryExpr[] }
  | {
    readonly ok: false;
    readonly reasonCodes: readonly RelativeDatePrefilterIneligibleReason[];
  };

function collectServerFunctionLeavesOnAndSpine(
  where: WhereExpr,
  resolveField: WhereFieldSemanticsResolver
): SpineResult {
  const leaves: BinaryExpr[] = [];
  let failure: RelativeDatePrefilterIneligibleReason | null = null;
  const visit = (node: WhereExpr): void => {
    if (failure !== null) return;
    switch (node.type) {
      case "GROUP":
        visit(node.expr);
        return;
      case "LOGICAL":
        if (node.op === "AND") {
          visit(node.left);
          visit(node.right);
          return;
        }
        if (collectServerFunctionOccurrences(node).length > 0) {
          failure = "RELATIVE_DATE_CONTEXT_UNSUPPORTED";
        }
        return;
      case "NOT":
        if (collectServerFunctionOccurrences(node).length > 0) {
          failure = "RELATIVE_DATE_CONTEXT_UNSUPPORTED";
        }
        return;
      case "BINARY": {
        const name = serverFunctionNameOf(node);
        if (name === null) return;
        const result = classifyWhereCapability(node, resolveField);
        if (result.capability !== "EXACT_PUSHDOWN") {
          failure = "RELATIVE_DATE_LEAF_NOT_EXACT";
          return;
        }
        leaves.push(node);
        return;
      }
      case "EXISTS":
        if (collectServerFunctionOccurrences(node).length > 0) {
          failure = "RELATIVE_DATE_CONTEXT_UNSUPPORTED";
        }
        return;
      case "NULL_CHECK":
      case "BOOLEAN":
        return;
    }
  };
  visit(where);
  return failure === null
    ? { ok: true, leaves }
    : { ok: false, reasonCodes: [failure] };
}

function serverFunctionNameOf(leaf: BinaryExpr): string | null {
  if (
    leaf.right.type === "KINTONE_FUNC"
    && isServerOnlyWhereFunctionName(leaf.right.name)
  ) {
    return leaf.right.name;
  }
  if (
    leaf.right.type === "IN_LIST"
    && leaf.right.values.length === 1
    && leaf.right.values[0].type === "KINTONE_FUNC"
    && isServerOnlyWhereFunctionName(leaf.right.values[0].name)
  ) {
    return leaf.right.values[0].name;
  }
  return null;
}

function collectServerFunctionOccurrences(where: WhereExpr): BinaryExpr[] {
  const found: BinaryExpr[] = [];
  const visitWhere = (node: WhereExpr): void => {
    if (node.type === "BINARY" && serverFunctionNameOf(node) !== null) {
      found.push(node);
      return;
    }
    switch (node.type) {
      case "LOGICAL":
        visitWhere(node.left);
        visitWhere(node.right);
        return;
      case "NOT":
      case "GROUP":
        visitWhere(node.expr);
        return;
      case "EXISTS":
        if (node.query.where !== null) visitWhere(node.query.where);
        return;
      case "BINARY":
      case "NULL_CHECK":
      case "BOOLEAN":
        return;
    }
  };
  visitWhere(where);
  return found;
}

function sameRelativeMultiset(
  occurrences: readonly BinaryExpr[],
  candidates: readonly BinaryExpr[]
): boolean {
  if (occurrences.length !== candidates.length) return false;
  const remaining = new Set(candidates);
  for (const occurrence of occurrences) {
    if (!remaining.delete(occurrence)) return false;
  }
  return remaining.size === 0;
}

function collectBinaryIdentities(where: WhereExpr | null): ReadonlySet<BinaryExpr> {
  const found = new Set<BinaryExpr>();
  const visit = (node: WhereExpr): void => {
    switch (node.type) {
      case "BINARY":
        found.add(node);
        return;
      case "LOGICAL":
        visit(node.left);
        visit(node.right);
        return;
      case "NOT":
      case "GROUP":
        visit(node.expr);
        return;
      case "NULL_CHECK":
      case "EXISTS":
      case "BOOLEAN":
        return;
    }
  };
  if (where !== null) visit(where);
  return found;
}

function selectPrefilterInOriginalOrder(
  where: WhereExpr,
  relativeLeaves: ReadonlySet<BinaryExpr>,
  safeLeaves: ReadonlySet<BinaryExpr>
): WhereExpr | null {
  switch (where.type) {
    case "BINARY":
      return relativeLeaves.has(where) || safeLeaves.has(where) ? where : null;
    case "LOGICAL":
      if (where.op !== "AND") return null;
      {
        const left = selectPrefilterInOriginalOrder(where.left, relativeLeaves, safeLeaves);
        const right = selectPrefilterInOriginalOrder(where.right, relativeLeaves, safeLeaves);
        if (left !== null && right !== null) return { ...where, left, right };
        return left ?? right;
      }
    case "GROUP": {
      const expr = selectPrefilterInOriginalOrder(where.expr, relativeLeaves, safeLeaves);
      return expr === null ? null : { ...where, expr };
    }
    case "NULL_CHECK":
    case "NOT":
    case "EXISTS":
    case "BOOLEAN":
      return null;
  }
}

const TRUE_PREDICATE: WhereExpr = { type: "BOOLEAN", value: true };

function replaceAdoptedLeaves(
  where: WhereExpr,
  adoptedLeaves: ReadonlySet<BinaryExpr>
): WhereExpr | null {
  if (where.type === "BINARY" && adoptedLeaves.has(where)) return TRUE_PREDICATE;
  switch (where.type) {
    case "LOGICAL": {
      if (where.op !== "AND") return where;
      const left = replaceAdoptedLeaves(where.left, adoptedLeaves) ?? TRUE_PREDICATE;
      const right = replaceAdoptedLeaves(where.right, adoptedLeaves) ?? TRUE_PREDICATE;
      if (isTrue(left)) return isTrue(right) ? null : right;
      if (isTrue(right)) return left;
      if (left === where.left && right === where.right) return where;
      return { ...where, left, right };
    }
    case "GROUP": {
      const expr = replaceAdoptedLeaves(where.expr, adoptedLeaves) ?? TRUE_PREDICATE;
      if (isTrue(expr)) return TRUE_PREDICATE;
      return expr === where.expr ? where : { ...where, expr };
    }
    case "BINARY":
    case "NULL_CHECK":
    case "NOT":
    case "EXISTS":
    case "BOOLEAN":
      return where;
  }
}

function isTrue(where: WhereExpr): boolean {
  return where.type === "BOOLEAN" && where.value;
}

function collectFieldMetadata(
  where: WhereExpr,
  resolveField: WhereFieldSemanticsResolver
): {
  readonly fieldTypes: ReadonlyMap<string, string>;
  readonly fieldOptions: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const fields = new Map<string, FieldRef>();
  const visitValue = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visitValue);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record["type"] === "SELECT") return;
    if (
      record["type"] === "FIELD"
      && typeof record["field"] === "string"
      && typeof record["tableAlias"] !== "undefined"
    ) {
      fields.set(record["field"], value as FieldRef);
      return;
    }
    Object.values(record).forEach(visitValue);
  };
  visitValue(where);

  const fieldTypes = new Map<string, string>();
  const fieldOptions = new Map<string, ReadonlySet<string>>();
  for (const [fieldCode, field] of fields) {
    const semantics = resolveField(field);
    if (!semantics) continue;
    fieldTypes.set(fieldCode, semantics.fieldType);
    if (semantics.optionOrder) {
      fieldOptions.set(fieldCode, new Set(semantics.optionOrder.keys()));
    }
  }
  return { fieldTypes, fieldOptions };
}

function serializedMultisetContains(
  query: string,
  expectedNames: readonly string[]
): boolean {
  const expected = new Map<string, number>();
  for (const name of expectedNames) {
    if (!SERVER_ONLY_WHERE_FUNCTION_NAMES.has(name)) return false;
    expected.set(name, (expected.get(name) ?? 0) + 1);
  }
  for (const [name, count] of expected) {
    const matches = query.match(new RegExp(`\\b${name}\\s*\\(`, "g"));
    if ((matches?.length ?? 0) < count) return false;
  }
  return true;
}
