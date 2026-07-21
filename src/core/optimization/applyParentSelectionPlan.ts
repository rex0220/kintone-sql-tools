import type { WhereExpr } from "../../types/ast";
import type { KlikeExpr } from "../like";
import { buildSingleTableKlikePushdownPlan } from "./klikePushdownPlan";

export interface SinglePhysicalTablePushdownMetadata {
  readonly fieldTypes: ReadonlyMap<string, string>;
  readonly fieldOptions: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ApplyParentSelectionPlan {
  readonly prefilter: WhereExpr | null;
  readonly appliedKlikes: ReadonlySet<KlikeExpr>;
  readonly unappliedKlikes: readonly KlikeExpr[];
}

/** APPLY 親の単一物理 app に対する、実行 route 非依存の純粋な抽出計画。 */
export function buildApplyParentSelectionPlan(
  where: WhereExpr,
  metadata: SinglePhysicalTablePushdownMetadata
): ApplyParentSelectionPlan {
  const plan = buildSingleTableKlikePushdownPlan(where, {
    allowUnqualifiedFields: true,
    allowKlike: true,
    fieldTypes: metadata.fieldTypes,
    fieldOptions: metadata.fieldOptions,
  });
  return {
    prefilter: plan.condition,
    appliedKlikes: plan.appliedKlikes,
    unappliedKlikes: plan.allKlikes.filter((expr) => !plan.appliedKlikes.has(expr)),
  };
}
