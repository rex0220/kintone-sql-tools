import type {
  GroupingFieldItem,
  GroupingSet,
  NormalizedGroupingSpec,
  SelectStatement,
} from "../types/ast";
import type {
  GroupingFieldResolver,
  ResolvedGroupingField,
} from "./groupingValidation";

/**
 * B65 Phase1 Step 4 candidate limits.
 * Effective values remain subject to the Step 5 Node/browser benchmark.
 */
export const B65_MAX_GROUPING_SETS = 64;
export const B65_MAX_GROUPING_ITEMS = 16;
export const B65_MAX_GENERATED_ROWS = 50_000;

export interface ResolvedGroupingItem extends ResolvedGroupingField {
  field: GroupingFieldItem;
}

export interface ResolvedGroupingSet {
  items: readonly ResolvedGroupingItem[];
}

export interface ResolvedGroupingSpec {
  type: "GROUPING_SETS";
  source: "ROLLUP" | "GROUPING_SETS" | "CUBE";
  allItems: readonly ResolvedGroupingItem[];
  sets: readonly ResolvedGroupingSet[];
}

/**
 * Expand a field-only CUBE after proving its power-set cardinality is within
 * the candidate set limit. Duplicate argument positions and resulting
 * equivalent sets remain explicit.
 */
export function expandCubeGroupingSets(items: readonly GroupingFieldItem[]): GroupingSet[] {
  let expandedSetCount = 1;
  for (const _item of items) {
    if (expandedSetCount > Math.floor(B65_MAX_GROUPING_SETS / 2)) {
      const rejectedSetCount = expandedSetCount * 2;
      throw new Error(
        `ArgumentError: B65 expanded grouping set count ${rejectedSetCount} exceeds limit ` +
        `${B65_MAX_GROUPING_SETS} (reason=GROUPING_SET_LIMIT_EXCEEDED).`
      );
    }
    expandedSetCount *= 2;
  }

  let sets: GroupingSet[] = [{ items: [] }];
  for (const item of items) {
    sets = sets.flatMap((set) => [
      { items: [...set.items, item] },
      { items: [...set.items] },
    ]);
  }
  return sets;
}

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

/**
 * Resolve parser identities once against physical metadata, then pass this
 * immutable execution shape to the engine. Canonically identical syntax items
 * share the allItems identity while duplicate sets/items remain explicit.
 */
export function resolveGroupingSpec(
  stmt: SelectStatement,
  resolve: GroupingFieldResolver
): ResolvedGroupingSpec | null {
  const normalized = normalizeGroupingSpec(stmt);
  if (normalized.type !== "GROUPING_SETS") return null;

  const byCanonicalId = new Map<string, ResolvedGroupingItem>();
  const resolveItem = (field: GroupingFieldItem): ResolvedGroupingItem => {
    const resolved = resolve(field);
    const existing = byCanonicalId.get(resolved.canonicalId);
    if (existing) return existing;
    const item = { ...resolved, field };
    byCanonicalId.set(item.canonicalId, item);
    return item;
  };

  const allItems = normalized.allItems.map(resolveItem).filter(
    (item, index, items) =>
      items.findIndex((candidate) => candidate.canonicalId === item.canonicalId) === index
  );
  const sets = normalized.sets.map((set) => ({
    items: set.items.map(resolveItem),
  }));
  return {
    type: "GROUPING_SETS",
    source: normalized.source,
    allItems,
    sets,
  };
}
