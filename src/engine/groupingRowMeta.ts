import type { ProcessRow } from "./evalWhere";

const groupingRowMetaKey: unique symbol = Symbol("ksql.groupingRowMeta");

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

/** Object spread omits non-enumerable symbols, so engine clones use this helper. */
export function cloneGroupingRow(row: ProcessRow): ProcessRow {
  const clone: ProcessRow = { ...row };
  const meta = getGroupingRowMeta(row);
  return meta ? attachGroupingRowMeta(clone, meta.includedCanonicalIds) : clone;
}
