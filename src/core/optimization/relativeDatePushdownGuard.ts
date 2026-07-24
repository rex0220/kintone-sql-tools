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
}

interface WalkCandidate {
  readonly kind: RelativeDatePlanNodeKind;
  readonly source: SelectStatement | UpdateStatement | DeleteStatement | Statement;
  readonly where: WhereExpr | null;
  readonly functionNames: readonly string[];
  readonly path: string;
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
  forceForbidden: boolean
): void {
  const functionNames = relativeDateFunctionNamesInWhere(select.where);
  if (functionNames.length > 0) {
    candidates.push({
      kind: forceForbidden ? "FORBIDDEN" : "SELECT",
      source: select,
      where: select.where,
      functionNames,
      path,
    });
  }
  nestedSelects(select, select).forEach((nested, index) =>
    collectSelect(nested, `${path}.select-source[${index}]`, candidates, forceForbidden)
  );
}

function collectUnion(
  union: UnionStatement,
  path: string,
  candidates: WalkCandidate[],
  forceForbidden: boolean
): void {
  if (union.left.type === "UNION") collectUnion(union.left, `${path}.left`, candidates, forceForbidden);
  else collectSelect(union.left, `${path}.left`, candidates, forceForbidden);
  collectSelect(union.right, `${path}.right`, candidates, forceForbidden);
}

function collectWith(
  statement: WithStatement,
  path: string,
  candidates: WalkCandidate[],
  inheritedForbidden: boolean
): void {
  if (!inheritedForbidden && canInlineSingleCte(statement)) {
    collectSelect(buildInlinedQuery(statement), `${path}.inlined`, candidates, false);
    return;
  }
  statement.ctes.forEach((cte, index) => {
    if (cte.query.type === "SELECT") {
      collectSelect(cte.query, `${path}.cte[${index}]`, candidates, true);
    } else if (cte.query.type === "UNION") {
      collectUnion(cte.query, `${path}.cte[${index}]`, candidates, true);
    }
  });
  if (statement.query.type === "SELECT") {
    collectSelect(statement.query, `${path}.main`, candidates, true);
  } else {
    collectUnion(statement.query, `${path}.main`, candidates, true);
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
      else if (statement.query.type === "UNION") collectUnion(statement.query, `${path}.query`, candidates, true);
      else collectSelect(statement.query, `${path}.query`, candidates, true);
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
        });
      }
      nestedSelects(statement, statement).forEach((select, index) =>
        collectSelect(select, `${path}.select-source[${index}]`, candidates, true)
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
          });
        }
      }
      nestedSelects(statement, statement).forEach((select, index) =>
        collectSelect(select, `${path}.select-source[${index}]`, candidates, forceForbidden)
      );
      return;
    }
    default:
      nestedSelects(statement, statement).forEach((select, index) =>
        collectSelect(select, `${path}.select-source[${index}]`, candidates, forceForbidden)
      );
  }
}

export function serializationContainsFunctions(query: string, names: readonly string[]): boolean {
  return names.every((name) => new RegExp(`\\b${name}\\s*\\(`).test(query));
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
      const allowed =
        physicalTopLevel
        && selectMode === "SIMPLE"
        // Canonical ORDER BY may switch to a local complete-input plan. Phase 1
        // only opens the explicit KORDER server plan for relative-date WHERE.
        && (select.orderBy.length === 0 || select.orderMode === "KINTONE_NATIVE")
        && capability.capability === "EXACT_PUSHDOWN"
        && serializationContainsFunctions(restQuery, candidate.functionNames);
      const node: RelativeDatePlanNode = {
        kind: candidate.kind,
        source: candidate.source,
        functionNames: candidate.functionNames,
        path: candidate.path,
        selectMode,
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
