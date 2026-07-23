import type {
  FieldRef,
  GroupingRef,
  OrderByKey,
  SelectColumn,
  SelectStatement,
} from "../types/ast";
import { normalizeGroupingSpec } from "./grouping";

export interface ResolvedGroupingField {
  canonicalId: string;
  directKey: string;
  unqualifiedBridgeKey: string | null;
  physical: boolean;
}

export type GroupingFieldResolver = (field: FieldRef) => ResolvedGroupingField;

/** Step 4 wires the candidate limits to this Step 1 planning hook. */
export type GroupingPlanningGuardReason =
  | "B65_GROUPING_SET_LIMIT"
  | "B65_GROUPING_ITEM_LIMIT";

export interface GroupingPlanningGuardFacts {
  /** Expanded ROLLUP sets and explicit duplicate sets are counted independently. */
  expandedSetCount: number;
  /** Canonical physical items after metadata-backed source resolution. */
  canonicalItemCount: number;
}

export type GroupingPlanningGuardHook = (facts: GroupingPlanningGuardFacts) => void;

function displayField(field: FieldRef): string {
  return field.tableAlias ? `${field.tableAlias}.${field.field}` : field.field;
}

function refFromName(name: string): FieldRef {
  const dot = name.indexOf(".");
  return dot > 0
    ? { type: "FIELD", tableAlias: name.slice(0, dot), field: name.slice(dot + 1) }
    : { type: "FIELD", tableAlias: null, field: name };
}

function collectGroupingRefs(node: unknown, out: GroupingRef[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectGroupingRefs(item, out));
    return;
  }
  const value = node as Record<string, unknown>;
  if (value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY") return;
  if (value["type"] === "GROUPING_REF") {
    out.push(value as unknown as GroupingRef);
    return;
  }
  Object.values(value).forEach((item) => collectGroupingRefs(item, out));
}

function collectNonAggregateFieldRefs(node: unknown, out: FieldRef[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectNonAggregateFieldRefs(item, out));
    return;
  }
  const value = node as Record<string, unknown>;
  const type = value["type"];
  if (type === "SELECT" || type === "SCALAR_SUBQUERY" || type === "GROUPING_REF"
    || type === "AGG_REF" || type === "AGG_ARITH") return;
  if (type === "FIELD" && typeof value["field"] === "string") {
    out.push({
      type: "FIELD",
      tableAlias: typeof value["tableAlias"] === "string" ? value["tableAlias"] : null,
      field: value["field"] as string,
    });
    return;
  }
  if (type === "FIELD_REF" && typeof value["field"] === "string") {
    out.push(refFromName(value["field"] as string));
    return;
  }
  Object.values(value).forEach((item) => collectNonAggregateFieldRefs(item, out));
}

function containsAggregate(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsAggregate);
  const value = node as Record<string, unknown>;
  if (value["type"] === "AGG_REF" || value["type"] === "AGG_ARITH") return true;
  if (value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY") return false;
  return Object.values(value).some(containsAggregate);
}

function isAggregateMaterializedAlias(column: SelectColumn): boolean {
  if (!("alias" in column) || column.alias === null) return false;
  if (column.type === "AGGREGATE" || column.type === "ARITH_AGG_COL") return true;
  if (column.type === "STRFUNC_COL" || column.type === "SCALAR_VALUE_COL") {
    return containsAggregate(column);
  }
  return false;
}

function outputAliases(columns: SelectColumn[]): Set<string> {
  return new Set(columns.flatMap((column) =>
    "alias" in column && typeof column.alias === "string" ? [column.alias] : []
  ));
}

function isAggregateSyntheticReference(ref: FieldRef): boolean {
  return ref.tableAlias === null
    && /^(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STDDEV_POP|STDDEV_SAMP|VAR_POP|VAR_SAMP|MEDIAN|MODE)\(/.test(ref.field);
}

function validateGroupingRefMembership(
  ref: GroupingRef,
  resolve: GroupingFieldResolver,
  canonicalItems: ReadonlySet<string>
): void {
  const resolved = resolve(ref.field);
  if (!resolved.physical) {
    throw new Error(`ArgumentError: B65 grouping reference ${displayField(ref.field)} must resolve to a physical APP field.`);
  }
  if (!canonicalItems.has(resolved.canonicalId)) {
    throw new Error(
      `ArgumentError: B65 GROUPING argument ${displayField(ref.field)} is not present in grouping allItems (reason=B65_GROUPING_ARG_NOT_ITEM).`
    );
  }
}

function validateDependency(
  ref: FieldRef,
  resolve: GroupingFieldResolver,
  canonicalItems: ReadonlySet<string>,
  context: string
): void {
  const resolved = resolve(ref);
  if (!resolved.physical || !canonicalItems.has(resolved.canonicalId)) {
    throw new Error(
      `ArgumentError: B65 non-aggregate field ${displayField(ref)} in ${context} is not a grouping item (reason=B65_NON_GROUPED_DEPENDENCY).`
    );
  }
}

function keyDependencies(key: OrderByKey): FieldRef[] {
  if (key.type === "GROUPING_KEY") return [];
  if (key.type === "FIELD_NAME") return [refFromName(key.name)];
  const refs: FieldRef[] = [];
  collectNonAggregateFieldRefs(key, refs);
  return refs;
}

/**
 * Metadata-backed B65 planning validation. The resolver is shared with the
 * execution layer's physical table/field metadata and must fail on unknown or
 * ambiguous references.
 */
export function validateGroupingPlanning(
  stmt: SelectStatement,
  resolve: GroupingFieldResolver,
  planningGuardHook: GroupingPlanningGuardHook = () => undefined
): void {
  const normalized = normalizeGroupingSpec(stmt);
  const groupingRefs: GroupingRef[] = [];
  for (const column of stmt.columns) {
    if (column.type !== "WINDOW_COL") collectGroupingRefs(column, groupingRefs);
  }
  collectGroupingRefs(stmt.orderBy, groupingRefs);
  const forbiddenGroupingRefs: GroupingRef[] = [];
  collectGroupingRefs(stmt.where, forbiddenGroupingRefs);
  collectGroupingRefs(stmt.having, forbiddenGroupingRefs);
  for (const column of stmt.columns) {
    if (column.type === "WINDOW_COL") collectGroupingRefs(column, forbiddenGroupingRefs);
  }
  if (forbiddenGroupingRefs.length > 0) {
    throw new Error(
      "ArgumentError: B65 GROUPING() is not allowed in WHERE, HAVING, JOIN, window, aggregate arguments, or DML expressions in Phase1."
    );
  }

  if (normalized.type !== "GROUPING_SETS") {
    if (groupingRefs.length > 0) {
      throw new Error("ArgumentError: B65 GROUPING() requires GROUP BY ROLLUP or GROUPING SETS.");
    }
    return;
  }

  if (stmt.distinct) {
    throw new Error("ArgumentError: B65 SELECT DISTINCT is not supported in Phase1.");
  }
  if (stmt.orderMode === "KINTONE_NATIVE") {
    throw new Error("ArgumentError: B65 KORDER BY is not supported in Phase1.");
  }
  if (stmt.columns.some((column) => column.type === "WINDOW_COL")) {
    throw new Error("ArgumentError: B65 window functions are not supported in Phase1.");
  }
  if (stmt.columns.some((column) =>
    column.type === "WILDCARD" || column.type === "PARENT_WILDCARD"
  )) {
    throw new Error("ArgumentError: B65 wildcard projection is not supported in Phase1.");
  }

  const canonicalItems = new Set<string>();
  const resolvedItems: ResolvedGroupingField[] = [];
  for (const item of normalized.allItems) {
    const resolved = resolve(item);
    if (!resolved.physical) {
      throw new Error(`ArgumentError: B65 grouping item ${displayField(item)} must resolve to a physical APP field.`);
    }
    if (!canonicalItems.has(resolved.canonicalId)) {
      canonicalItems.add(resolved.canonicalId);
      resolvedItems.push(resolved);
    }
  }
  // Step 1 exposes stable, canonical planning facts only. Effective candidate
  // constants and rejection boundaries are deliberately wired in Step 4.
  planningGuardHook({
    expandedSetCount: normalized.sets.length,
    canonicalItemCount: canonicalItems.size,
  });

  for (const ref of groupingRefs) {
    validateGroupingRefMembership(ref, resolve, canonicalItems);
  }

  const aliases = outputAliases(stmt.columns);
  for (const column of stmt.columns) {
    if (column.type === "GROUPING_COL" || column.type === "AGGREGATE"
      || column.type === "ARITH_AGG_COL" || column.type === "LITERAL_COL"
      || column.type === "VARIABLE_COL" || column.type === "SCALAR_SUBQUERY_COL") continue;
    const refs: FieldRef[] = [];
    if (column.type === "FIELD") refs.push(refFromName(column.field));
    else collectNonAggregateFieldRefs(column, refs);
    for (const ref of refs) validateDependency(ref, resolve, canonicalItems, "SELECT");
  }

  if (stmt.having) {
    const refs: FieldRef[] = [];
    collectNonAggregateFieldRefs(stmt.having, refs);
    for (const ref of refs) {
      if ((ref.tableAlias === null && aliases.has(ref.field)) || isAggregateSyntheticReference(ref)) continue;
      validateDependency(ref, resolve, canonicalItems, "HAVING");
    }
  }

  for (const order of stmt.orderBy) {
    for (const ref of keyDependencies(order.key)) {
      if ((ref.tableAlias === null && aliases.has(ref.field)) || isAggregateSyntheticReference(ref)) continue;
      validateDependency(ref, resolve, canonicalItems, "ORDER BY");
    }
  }

  const collisionKeys = new Set<string>();
  for (const item of resolvedItems) {
    collisionKeys.add(item.directKey);
    if (item.unqualifiedBridgeKey !== null) collisionKeys.add(item.unqualifiedBridgeKey);
  }
  for (const column of stmt.columns) {
    if (!isAggregateMaterializedAlias(column)) continue;
    const alias = "alias" in column ? column.alias : null;
    if (alias === null) continue;
    if (collisionKeys.has(alias)) {
      throw new Error(
        `ArgumentError: B65 aggregate alias ${alias} collides with a grouping runtime key (reason=B65_AGGREGATE_ALIAS_COLLISION).`
      );
    }
  }
}
