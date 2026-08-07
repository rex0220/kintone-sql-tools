import type { SelectStatement, WhereExpr } from "../../types/ast";
import type { KlikeExpr } from "../like";
import { isKlike } from "../like";
import {
  extractSafePushdownPlan,
  type SafePushdownOptions,
} from "./wherePredicatePushdown";
import type { SupportedLeafRelation } from "./supportedLeafPolicy";

export interface KlikePushdownMetadata {
  fieldTypesByApp?: ReadonlyMap<number, ReadonlyMap<string, string>>;
  fieldOptionsByApp?: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<string>>>;
}

export interface KlikePushdownPlanOptions extends KlikePushdownMetadata {
  /** parse/analyze 段階だけ、置換前の @variable を候補として認める。 */
  allowUnresolvedVariables?: boolean;
}

/**
 * 1つの SELECT に対する共有プレフィルタ計画。
 * conditions と appliedKlikes は同じ抽出結果から作り、検証・fetch・JS 評価で共有する。
 */
export interface KlikePushdownPlan {
  mainCondition: WhereExpr | null;
  mainRelation: Exclude<SupportedLeafRelation, "unsafe"> | null;
  joinConditions: ReadonlyMap<string, WhereExpr>;
  joinRelations: ReadonlyMap<string, Exclude<SupportedLeafRelation, "unsafe">>;
  appliedKlikes: ReadonlySet<KlikeExpr>;
  allKlikes: readonly KlikeExpr[];
}

interface SingleTableKlikePushdownOptions extends SafePushdownOptions {
  /** SELECT の subtable / CTE / alias なし JOIN では main-table 抽出自体を行わない。 */
  readonly extractCondition?: boolean;
}

export interface SingleTableKlikePushdownPlan {
  readonly condition: WhereExpr | null;
  readonly relation: Exclude<SupportedLeafRelation, "unsafe"> | null;
  readonly appliedKlikes: ReadonlySet<KlikeExpr>;
  readonly allKlikes: readonly KlikeExpr[];
}

/**
 * 単一テーブルの safe prefilter と KLIKE identity 集合を同じ AST から作る共有 primitive。
 * 抽出器が返す leaf を clone せず、そのまま appliedKlikes へ収集する。
 */
export function buildSingleTableKlikePushdownPlan(
  where: WhereExpr | null,
  options: SingleTableKlikePushdownOptions = {}
): SingleTableKlikePushdownPlan {
  const extracted = where !== null && options.extractCondition !== false
    ? extractSafePushdownPlan(where, options)
    : { condition: null, relation: null };
  const { condition, relation } = extracted;
  const appliedKlikes = new Set<KlikeExpr>();
  collectKlikes(condition, appliedKlikes);
  const allKlikes = new Set<KlikeExpr>();
  collectKlikes(where, allKlikes);
  return { condition, relation, appliedKlikes, allKlikes: [...allKlikes] };
}

export function buildKlikePushdownPlan(
  stmt: SelectStatement,
  options: KlikePushdownPlanOptions = {}
): KlikePushdownPlan {
  const joinsAreSafeForKlike = stmt.joins.every((join) => join.type === "INNER");
  const common = {
    allowKlike: joinsAreSafeForKlike,
    allowUnresolvedKlikeVariables: options.allowUnresolvedVariables,
  };

  const mainIsPhysical = !stmt.from.subtableCode && stmt.from.cteName === null;
  const mainHasUsableAlias = stmt.joins.length === 0 || stmt.from.alias !== null;
  const mainPlan = buildSingleTableKlikePushdownPlan(stmt.where, {
    ...common,
    extractCondition: mainIsPhysical && mainHasUsableAlias && joinsAreSafeForKlike,
    tableAlias: stmt.from.alias ?? undefined,
    allowUnqualifiedFields: stmt.joins.length === 0,
    fieldTypes: options.fieldTypesByApp?.get(stmt.from.appId),
    fieldOptions: options.fieldOptionsByApp?.get(stmt.from.appId),
  });
  const mainCondition = mainPlan.condition;

  const joinConditions = new Map<string, WhereExpr>();
  const joinRelations = new Map<string, "exact" | "superset">();
  if (stmt.where !== null) {
    for (const join of stmt.joins) {
      if (join.type !== "INNER"
        || !join.table.alias || join.table.subtableCode || join.table.cteName !== null) continue;
      const extracted = extractSafePushdownPlan(stmt.where, {
        ...common,
        tableAlias: join.table.alias,
        fieldTypes: options.fieldTypesByApp?.get(join.table.appId),
        fieldOptions: options.fieldOptionsByApp?.get(join.table.appId),
      });
      if (extracted.condition !== null && extracted.relation !== null) {
        joinConditions.set(join.table.alias, extracted.condition);
        joinRelations.set(join.table.alias, extracted.relation);
      }
    }
  }

  const appliedKlikes = new Set<KlikeExpr>(mainPlan.appliedKlikes);
  for (const condition of joinConditions.values()) collectKlikes(condition, appliedKlikes);

  return {
    mainCondition,
    mainRelation: mainPlan.relation,
    joinConditions,
    joinRelations,
    appliedKlikes,
    allKlikes: mainPlan.allKlikes,
  };
}

export function unappliedKlikes(plan: KlikePushdownPlan): KlikeExpr[] {
  return plan.allKlikes.filter((expr) => !plan.appliedKlikes.has(expr));
}

function collectKlikes(where: WhereExpr | null, out: Set<KlikeExpr>): void {
  if (where === null) return;
  if (isKlike(where)) {
    out.add(where);
    return;
  }
  switch (where.type) {
    case "LOGICAL":
      collectKlikes(where.left, out);
      collectKlikes(where.right, out);
      return;
    case "NOT":
    case "GROUP":
      collectKlikes(where.expr, out);
      return;
    case "BINARY":
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return;
  }
}
