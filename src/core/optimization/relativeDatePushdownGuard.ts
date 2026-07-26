import { resolveSelectMode, type SelectMode } from "../../converter/selectToKintone";
import { whereToKintone } from "../../converter/whereToKintone";
import type {
  DeleteStatement,
  SelectStatement,
  Statement,
  UnionStatement,
  UpdateStatement,
  WhereExpr,
  WithStatement,
} from "../../types/ast";
import { buildInlinedQuery, canInlineSingleCte } from "../cteInlining";
import {
  isRelativeDateFunctionName,
  WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN,
} from "../relativeDateFunction";
import {
  buildRelativeDateFullScanExactPlan,
  relativeDateFunctionOccurrencesInWhere,
  type RelativeDateFullScanExactPlan,
} from "./relativeDateFullScanExactPlan";
import type {
  RelativeDatePrefilterDecomposition,
  RelativeDatePrefilterPlan,
} from "./relativeDatePrefilterPlan";
import type {
  PredicateCapabilityReason,
  PredicateCapabilityResult,
} from "./whereCapability";

export type RelativeDatePlanReasonCode =
  | "WHERE_RELATIVE_DATE_ARGUMENT_INVALID"
  | "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED"
  | "WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED"
  | "WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED"
  | "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN";

export type RelativeDatePlanNodeKind = "SELECT" | "DML" | "FORBIDDEN";

export interface RelativeDatePlanNode {
  readonly kind: RelativeDatePlanNodeKind;
  readonly source: SelectStatement | UpdateStatement | DeleteStatement | Statement;
  readonly functionNames: readonly string[];
  readonly path: string;
  readonly selectMode?: SelectMode;
  readonly capability?: PredicateCapabilityResult;
  readonly restQuery?: string;
  readonly prefilterPlan?: RelativeDatePrefilterPlan;
  readonly phase2PrefilterEligible?: boolean;
  readonly fullScanExactPlan?: RelativeDateFullScanExactPlan;
  readonly allowForm?: "FULL_SCAN_EXACT";
  readonly clientWhereEvaluation: boolean;
  readonly allowed: boolean;
}

export interface RelativeDatePushdownPlan {
  readonly hasRelativeDate: boolean;
  readonly nodes: readonly RelativeDatePlanNode[];
  readonly allowed: boolean;
  readonly rejection?: {
    readonly functionName: string;
    readonly path: string;
    /** 最も具体的な R2 reason。reasonCodes は診断で失ってはならない全理由。 */
    readonly code: RelativeDatePlanReasonCode;
    readonly reasonCodes: readonly RelativeDatePlanReasonCode[];
  };
}

export interface RelativeDateCapabilityResolver {
  select(select: SelectStatement): Promise<PredicateCapabilityResult>;
  dml(statement: UpdateStatement | DeleteStatement): Promise<PredicateCapabilityResult>;
  prefilterDecomposition?(
    select: SelectStatement
  ): Promise<RelativeDatePrefilterDecomposition | null>;
}

interface WalkCandidate {
  readonly kind: RelativeDatePlanNodeKind;
  readonly source: SelectStatement | UpdateStatement | DeleteStatement | Statement;
  readonly where: WhereExpr | null;
  readonly functionNames: readonly string[];
  readonly path: string;
  readonly allowPhase2Prefilter?: boolean;
  readonly allowFullScanExact: boolean;
  readonly relativeFunctionOccurrences: readonly string[];
}

function relativeDateFunctionNamesInNode(node: unknown, stopAtNestedSelect: boolean): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (valueNode: unknown): void => {
    if (Array.isArray(valueNode)) {
      valueNode.forEach(visit);
      return;
    }
    if (valueNode === null || typeof valueNode !== "object") return;
    const value = valueNode as Record<string, unknown>;
    if (
      value["type"] === "KINTONE_FUNC"
      && typeof value["name"] === "string"
      && isRelativeDateFunctionName(value["name"])
      && !seen.has(value["name"])
    ) {
      seen.add(value["name"]);
      names.push(value["name"]);
      return;
    }
    // A nested SELECT owns its WHERE and must be planned independently.
    if (stopAtNestedSelect && value["type"] === "SELECT") return;
    Object.values(value).forEach(visit);
  };
  visit(node);
  return names;
}

/** WHERE 内だけを走査する。SELECT source は statement walker が別 node として扱う。 */
export function relativeDateFunctionNamesInWhere(where: WhereExpr | null): string[] {
  return relativeDateFunctionNamesInNode(where, true);
}

function nestedSelects(node: unknown, root?: object): SelectStatement[] {
  const found: SelectStatement[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object" || seen.has(value as object)) return;
    seen.add(value as object);
    const object = value as Record<string, unknown>;
    if (object["type"] === "SELECT" && value !== root) {
      found.push(value as SelectStatement);
      return;
    }
    Object.values(object).forEach(visit);
  };
  visit(node);
  return found;
}

function collectSelect(
  select: SelectStatement,
  path: string,
  candidates: WalkCandidate[],
  forceForbidden: boolean,
  allowPhase2 = true,
  allowFullScanExact = true,
  forceNestedForbidden = forceForbidden
): void {
  const functionNames = relativeDateFunctionNamesInWhere(select.where);
  if (functionNames.length > 0) {
    candidates.push({
      kind: forceForbidden ? "FORBIDDEN" : "SELECT",
      source: select,
      where: select.where,
      functionNames,
      path,
      allowPhase2Prefilter: allowPhase2,
      allowFullScanExact,
      relativeFunctionOccurrences: relativeDateFunctionOccurrencesInWhere(select.where!),
    });
  }
  nestedSelects(select, select).forEach((nested, index) =>
    collectSelect(
      nested,
      `${path}.select-source[${index}]`,
      candidates,
      forceNestedForbidden,
      forceNestedForbidden ? false : allowPhase2,
      forceNestedForbidden ? false : allowFullScanExact,
      forceNestedForbidden
    )
  );
}

function collectUnion(
  union: UnionStatement,
  path: string,
  candidates: WalkCandidate[],
  forceForbidden: boolean,
  allowFullScanExact = true
): void {
  if (union.left.type === "UNION") {
    collectUnion(union.left, `${path}.left`, candidates, forceForbidden, allowFullScanExact);
  } else {
    collectSelect(union.left, `${path}.left`, candidates, forceForbidden, true, allowFullScanExact);
  }
  collectSelect(union.right, `${path}.right`, candidates, forceForbidden, true, allowFullScanExact);
}

function collectWith(
  statement: WithStatement,
  path: string,
  candidates: WalkCandidate[],
  inheritedForbidden: boolean
): void {
  if (!inheritedForbidden && canInlineSingleCte(statement)) {
    collectSelect(buildInlinedQuery(statement), `${path}.inlined`, candidates, false, true, true);
    return;
  }
  statement.ctes.forEach((cte, index) => {
    if (cte.query.type === "SELECT") {
      // B75: materialized CTE bodies may use relative dates only when the whole
      // WHERE is pushed down exactly. Phase2 residuals and nested SELECTs remain
      // fail-closed because neither path has been verified for CTE materialization.
      collectSelect(cte.query, `${path}.cte[${index}]`, candidates, false, false, true, true);
    } else if (cte.query.type === "UNION") {
      collectUnion(cte.query, `${path}.cte[${index}]`, candidates, true, false);
    }
  });
  if (statement.query.type === "SELECT") {
    collectSelect(statement.query, `${path}.main`, candidates, false, false, true, true);
  } else {
    collectUnion(statement.query, `${path}.main`, candidates, true, false);
  }
}

function collectStatement(
  statement: Statement,
  path: string,
  candidates: WalkCandidate[],
  forceForbidden = false
): void {
  switch (statement.type) {
    case "SELECT":
      collectSelect(statement, path, candidates, forceForbidden);
      return;
    case "UNION":
      collectUnion(statement, path, candidates, forceForbidden);
      return;
    case "WITH":
      collectWith(statement, path, candidates, forceForbidden);
      return;
    case "CREATE_TEMP_TABLE":
      if (statement.query.type === "WITH") collectWith(statement.query, `${path}.query`, candidates, true);
      else if (statement.query.type === "UNION") collectUnion(statement.query, `${path}.query`, candidates, true, false);
      else collectSelect(statement.query, `${path}.query`, candidates, true, true, false);
      return;
    case "EXPLAIN":
      collectStatement(statement.query, `${path}.query`, candidates, forceForbidden);
      return;
    case "VALIDATE":
    case "REORDER": {
      const functionNames = relativeDateFunctionNamesInWhere(statement.where);
      if (functionNames.length > 0) {
        candidates.push({
          kind: "FORBIDDEN",
          source: statement,
          where: statement.where,
          functionNames,
          path,
          allowFullScanExact: false,
          relativeFunctionOccurrences: relativeDateFunctionOccurrencesInWhere(statement.where!),
        });
      }
      nestedSelects(statement, statement).forEach((select, index) =>
        collectSelect(select, `${path}.select-source[${index}]`, candidates, true, true, false)
      );
      return;
    }
    case "UPDATE":
    case "DELETE": {
      const functionNames = relativeDateFunctionNamesInWhere(statement.where);
      if (functionNames.length > 0) {
        const forbidden = forceForbidden
          || Boolean(statement.subtableCode)
          || (statement.type === "UPDATE"
            && (statement.from != null || Boolean(statement.applyBlocks?.length)));
        candidates.push({
          kind: forbidden ? "FORBIDDEN" : "DML",
          source: statement,
          where: statement.where,
          functionNames,
          path,
          allowFullScanExact: false,
          relativeFunctionOccurrences: relativeDateFunctionOccurrencesInWhere(statement.where!),
        });
      }
      if (statement.type === "UPDATE" && statement.applyBlocks?.length) {
        const applyFunctions = relativeDateFunctionNamesInNode(statement.applyBlocks, true);
        if (applyFunctions.length > 0) {
          candidates.push({
            kind: "FORBIDDEN",
            source: statement,
            where: null,
            functionNames: applyFunctions,
            path: `${path}.apply`,
            allowFullScanExact: false,
            relativeFunctionOccurrences: [],
          });
        }
      }
      nestedSelects(statement, statement).forEach((select, index) =>
        collectSelect(
          select,
          `${path}.select-source[${index}]`,
          candidates,
          forceForbidden,
          false,
          false
        )
      );
      return;
    }
    default:
      nestedSelects(statement, statement).forEach((select, index) =>
        collectSelect(
          select,
          `${path}.select-source[${index}]`,
          candidates,
          forceForbidden,
          false,
          false
        )
      );
  }
}

export function serializationContainsFunctions(query: string, names: readonly string[]): boolean {
  return names.every((name) => new RegExp(`\\b${name}\\s*\\(`).test(query));
}

/**
 * Phase2 A の第2許可候補を、実行副作用なしで判定する。
 * decomposition の eligible 契約に加えて物理 source と実行 mode を再確認する。
 */
export function allowRelativeDatePrefilterPlan(
  select: SelectStatement,
  decomposition: RelativeDatePrefilterDecomposition
): boolean {
  return decomposition.eligible === true
    && resolveSelectMode(select) === "FULL_SCAN"
    && select.orderMode !== "KINTONE_NATIVE"
    && select.from.cteName === null
    && !select.from.subtableCode
    && select.joins.length === 0;
}

function rejectedNode(candidate: WalkCandidate): RelativeDatePlanNode {
  return {
    kind: candidate.kind,
    source: candidate.source,
    functionNames: candidate.functionNames,
    path: candidate.path,
    clientWhereEvaluation: true,
    allowed: false,
  };
}

function relativeDateReasonCodes(
  capability: PredicateCapabilityResult | undefined
): RelativeDatePlanReasonCode[] {
  const codes = (capability?.reasons ?? [])
    .filter((reason): reason is PredicateCapabilityReason & { functionName: string } =>
      reason.functionName !== undefined
    )
    .map((reason) => reason.code)
    .filter((code): code is RelativeDatePlanReasonCode => code.startsWith("WHERE_RELATIVE_DATE_"));
  if (!codes.includes(WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN)) {
    codes.push(WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN);
  }
  return [...new Set(codes)];
}

function rejectionFor(
  candidate: WalkCandidate,
  capability?: PredicateCapabilityResult
): NonNullable<RelativeDatePushdownPlan["rejection"]> {
  const reasonCodes = relativeDateReasonCodes(capability);
  return {
    functionName: candidate.functionNames[0],
    path: candidate.path,
    code: reasonCodes.find((code) =>
      code !== WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN
    ) ?? WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN,
    reasonCodes,
  };
}

/**
 * Execution と EXPLAIN が共有する B67 plan walk。
 *
 * 各 SELECT node / DML target WHERE を独立に分類し、相対日付関数が
 * 一意な物理 APP の REST query へ完全押し下げされ、取得後 WHERE 評価が
 * 0 の計画だけを許可する。
 */
export async function buildRelativeDatePushdownPlan(
  statement: Statement,
  resolver: RelativeDateCapabilityResolver
): Promise<RelativeDatePushdownPlan> {
  const candidates: WalkCandidate[] = [];
  collectStatement(statement, "statement", candidates);
  const nodes: RelativeDatePlanNode[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "FORBIDDEN") {
      const node = rejectedNode(candidate);
      nodes.push(node);
      return {
        hasRelativeDate: true,
        nodes,
        allowed: false,
        rejection: rejectionFor(candidate),
      };
    }

    if (candidate.kind === "SELECT") {
      const select = candidate.source as SelectStatement;
      const physicalTopLevel =
        select.from.cteName === null
        && !select.from.subtableCode
        && select.joins.length === 0;
      const selectMode = resolveSelectMode(select);
      const capability = await resolver.select(select);
      let restQuery = "";
      try {
        restQuery = candidate.where === null ? "" : whereToKintone(candidate.where);
      } catch {
        restQuery = "";
      }
      let allowed =
        physicalTopLevel
        && selectMode === "SIMPLE"
        // Canonical ORDER BY may switch to a local complete-input plan. Phase 1
        // only opens the explicit KORDER server plan for relative-date WHERE.
        && (select.orderBy.length === 0 || select.orderMode === "KINTONE_NATIVE")
        && capability.capability === "EXACT_PUSHDOWN"
        && serializationContainsFunctions(restQuery, candidate.functionNames);
      let prefilterPlan: RelativeDatePrefilterPlan | undefined;
      let phase2PrefilterEligible: boolean | undefined;
      if (
        !allowed
        && candidate.allowPhase2Prefilter !== false
        && capability.capability === "SUPERSET_PREFILTER"
        && resolver.prefilterDecomposition
      ) {
        const decomposition = await resolver.prefilterDecomposition(select);
        if (
          decomposition?.eligible === true
          && allowRelativeDatePrefilterPlan(select, decomposition)
        ) {
          prefilterPlan = decomposition.plan;
          phase2PrefilterEligible = true;
          allowed = true;
        }
      }
      let fullScanExactPlan: RelativeDateFullScanExactPlan | undefined;
      if (!allowed && capability.capability === "EXACT_PUSHDOWN") {
        fullScanExactPlan = buildRelativeDateFullScanExactPlan({
          select,
          selectMode,
          capability,
          context: { allowFullScanExact: candidate.allowFullScanExact },
          serializedWholeWhere: restQuery || null,
          relativeFunctionNames: candidate.relativeFunctionOccurrences,
        }) ?? undefined;
        if (fullScanExactPlan) {
          prefilterPlan = fullScanExactPlan.prefilterPlan;
          allowed = true;
        }
      }
      const node: RelativeDatePlanNode = {
        kind: candidate.kind,
        source: candidate.source,
        functionNames: candidate.functionNames,
        path: candidate.path,
        selectMode,
        capability,
        restQuery,
        ...(prefilterPlan ? { prefilterPlan, phase2PrefilterEligible } : {}),
        ...(fullScanExactPlan
          ? { fullScanExactPlan, allowForm: fullScanExactPlan.allowForm }
          : {}),
        clientWhereEvaluation: !allowed,
        allowed,
      };
      nodes.push(node);
      if (!allowed) {
        return {
          hasRelativeDate: true,
          nodes,
          allowed: false,
          rejection: rejectionFor(candidate, capability),
        };
      }
      continue;
    }

    const dml = candidate.source as UpdateStatement | DeleteStatement;
    const capability = await resolver.dml(dml);
    let restQuery = "";
    try {
      restQuery = candidate.where === null ? "" : whereToKintone(candidate.where);
    } catch {
      restQuery = "";
    }
    const allowed =
      capability.capability === "EXACT_PUSHDOWN"
      && serializationContainsFunctions(restQuery, candidate.functionNames);
    const node: RelativeDatePlanNode = {
      kind: candidate.kind,
      source: candidate.source,
      functionNames: candidate.functionNames,
      path: candidate.path,
      capability,
      restQuery,
      clientWhereEvaluation: !allowed,
      allowed,
    };
    nodes.push(node);
    if (!allowed) {
      return {
        hasRelativeDate: true,
        nodes,
        allowed: false,
        rejection: rejectionFor(candidate, capability),
      };
    }
  }

  return {
    hasRelativeDate: candidates.length > 0,
    nodes,
    allowed: true,
  };
}

export function assertRelativeDatePushdownPlan(plan: RelativeDatePushdownPlan): void {
  if (!plan.allowed && plan.rejection) {
    const details = plan.rejection.reasonCodes.filter((code) =>
      code !== WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN
    );
    throw new Error(
      `${plan.rejection.functionName}: ${WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN}` +
      `${details.length > 0 ? ` (reason=${details.join(", ")})` : ""} ` +
      `(path=${plan.rejection.path})`
    );
  }
}
