import type { ProcessRow } from "./evalWhere";
import type { GroupingRef } from "../types/ast";

const groupingRowMetaKey: unique symbol = Symbol("ksql.groupingRowMeta");
const groupingRefCanonicalIds = new WeakMap<GroupingRef, string>();

export interface GroupingRowMeta {
  includedCanonicalIds: ReadonlySet<string>;
}

type RowWithGroupingMeta = ProcessRow & {
  [groupingRowMetaKey]?: GroupingRowMeta;
};

export function attachGroupingRowMeta(
  row: ProcessRow,
  includedCanonicalIds: ReadonlySet<string>
): ProcessRow {
  Object.defineProperty(row, groupingRowMetaKey, {
    value: { includedCanonicalIds },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return row;
}

export function getGroupingRowMeta(row: ProcessRow): GroupingRowMeta | undefined {
  return (row as RowWithGroupingMeta)[groupingRowMetaKey];
}

/** Step 3's GROUPING() evaluator reads membership only through this resolver. */
export function readGroupingMembership(row: ProcessRow): ReadonlySet<string> | undefined {
  return getGroupingRowMeta(row)?.includedCanonicalIds;
}

/** Planning binds each dedicated GROUPING() node to its metadata-resolved source identity. */
export function bindGroupingRefCanonicalId(ref: GroupingRef, canonicalId: string): void {
  groupingRefCanonicalIds.set(ref, canonicalId);
}

/**
 * Evaluate GROUPING() exclusively from the row membership sidecar.
 * Physical field values are deliberately ignored because detail empty cells and
 * super-aggregate rows both use the external empty-string representation.
 */
export function evalGroupingRef(ref: GroupingRef, row: ProcessRow): "0" | "1" {
  const membership = readGroupingMembership(row);
  if (!membership) {
    throw new Error("internal error: GROUPING() evaluation requires B65 grouping row membership.");
  }
  const canonicalId = groupingRefCanonicalIds.get(ref);
  if (!canonicalId) {
    throw new Error("internal error: GROUPING() reference was not resolved during B65 planning.");
  }
  return membership.has(canonicalId) ? "0" : "1";
}

/** Object spread omits non-enumerable symbols, so engine clones use this helper. */
export function cloneGroupingRow(row: ProcessRow): ProcessRow {
  const clone: ProcessRow = { ...row };
  const meta = getGroupingRowMeta(row);
  return meta ? attachGroupingRowMeta(clone, meta.includedCanonicalIds) : clone;
}
