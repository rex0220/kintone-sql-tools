import type {
  GroupingFieldItem,
  GroupingSet,
  NormalizedGroupingSpec,
  SelectStatement,
} from "../types/ast";

function groupingFieldSyntaxKey(item: GroupingFieldItem): string {
  return `${item.tableAlias ?? ""}\u0000${item.field}`;
}

/**
 * The single accessor for ordinary GROUP BY and B65 grouping-set syntax.
 * Ordinary statements retain their byte-equivalent public AST (no grouping property).
 */
export function normalizeGroupingSpec(stmt: SelectStatement): NormalizedGroupingSpec {
  if (stmt.grouping !== undefined && stmt.groupBy.length > 0) {
    throw new Error("internal error: SELECT cannot contain both groupBy and grouping.");
  }
  if (stmt.grouping === undefined) {
    return stmt.groupBy.length === 0
      ? { type: "NONE" }
      : { type: "PLAIN", allItems: stmt.groupBy, sets: [stmt.groupBy] };
  }

  // Parser-produced specs already carry this shape. Rebuild allItems defensively so
  // hand-built ASTs cannot introduce a stale list. Physical canonical de-duplication
  // is performed by the metadata-backed planning validator.
  const seen = new Set<string>();
  const allItems: GroupingFieldItem[] = [];
  for (const set of stmt.grouping.sets) {
    for (const item of set.items) {
      const key = groupingFieldSyntaxKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      allItems.push(item);
    }
  }
  const sets: GroupingSet[] = stmt.grouping.sets.map((set) => ({ items: [...set.items] }));
  return {
    type: "GROUPING_SETS",
    source: stmt.grouping.source,
    allItems,
    sets,
  };
}

export function hasGroupingClause(stmt: SelectStatement): boolean {
  return normalizeGroupingSpec(stmt).type !== "NONE";
}
