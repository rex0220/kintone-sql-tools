import type { SelectStatement, WhereExpr } from "../../types/ast";
import type { KlikeExpr } from "../like";
import { isKlike } from "../like";
import { extractSafePushdownLeaves } from "./wherePredicatePushdown";

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
  joinConditions: ReadonlyMap<string, WhereExpr>;
  appliedKlikes: ReadonlySet<KlikeExpr>;
  allKlikes: readonly KlikeExpr[];
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

  let mainCondition: WhereExpr | null = null;
  if (stmt.where !== null && !stmt.from.subtableCode && stmt.from.cteName === null) {
    if (stmt.joins.length === 0) {
      mainCondition = extractSafePushdownLeaves(stmt.where, {
        ...common,
        tableAlias: stmt.from.alias ?? undefined,
        allowUnqualifiedFields: true,
        fieldTypes: options.fieldTypesByApp?.get(stmt.from.appId),
        fieldOptions: options.fieldOptionsByApp?.get(stmt.from.appId),
      });
    } else if (stmt.from.alias) {
      mainCondition = extractSafePushdownLeaves(stmt.where, {
        ...common,
        tableAlias: stmt.from.alias,
        fieldTypes: options.fieldTypesByApp?.get(stmt.from.appId),
        fieldOptions: options.fieldOptionsByApp?.get(stmt.from.appId),
      });
    }
  }

  const joinConditions = new Map<string, WhereExpr>();
  if (stmt.where !== null) {
    for (const join of stmt.joins) {
      if (!join.table.alias || join.table.subtableCode || join.table.cteName !== null) continue;
      const condition = extractSafePushdownLeaves(stmt.where, {
        ...common,
        tableAlias: join.table.alias,
        fieldTypes: options.fieldTypesByApp?.get(join.table.appId),
        fieldOptions: options.fieldOptionsByApp?.get(join.table.appId),
      });
      if (condition !== null) joinConditions.set(join.table.alias, condition);
    }
  }

  const appliedKlikes = new Set<KlikeExpr>();
  collectKlikes(mainCondition, appliedKlikes);
  for (const condition of joinConditions.values()) collectKlikes(condition, appliedKlikes);

  const allKlikes = new Set<KlikeExpr>();
  collectKlikes(stmt.where, allKlikes);
  return {
    mainCondition,
    joinConditions,
    appliedKlikes,
    allKlikes: [...allKlikes],
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
