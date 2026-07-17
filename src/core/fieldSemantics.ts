export type CompareMode = "string" | "number" | "option" | "recordNumber" | "unsupported";

export interface ResolvedFieldSemantics {
  readonly fieldType: string;
  readonly compareMode: CompareMode;
  readonly inSubtable: boolean;
  /** SUBTABLE / REFERENCE_TABLE の参照先など、= / != ではなく IN 系を要求する構造。 */
  readonly requiresCollectionOperators: boolean;
  readonly optionOrder?: ReadonlyMap<string, number>;
  /** temp/CTE 後段で STATUS 等の追加metadataを遅延解決するための物理列来歴。 */
  readonly source?: Readonly<{ appId: number; fieldCode: string }>;
}

export interface FieldSemanticsSource {
  readonly fieldType: string;
  readonly sortKind?: "number" | "string";
  readonly inSubtable?: boolean;
  readonly requiresCollectionOperators?: boolean;
  readonly optionOrder?: Readonly<Record<string, number>>;
}

const STRING_FIELD_TYPES = new Set([
  "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "RICH_TEXT", "LINK",
  "DATE", "TIME", "DATETIME", "CREATED_TIME", "UPDATED_TIME",
  "CREATOR", "MODIFIER",
]);

const OPTION_FIELD_TYPES = new Set([
  "DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT", "STATUS",
]);

export function resolveFieldSemantics(source: FieldSemanticsSource): ResolvedFieldSemantics {
  let compareMode: CompareMode;
  if (source.fieldType === "RECORD_NUMBER" || source.fieldType === "__ID__") {
    compareMode = "recordNumber";
  } else if (source.fieldType === "NUMBER") {
    compareMode = "number";
  } else if (source.fieldType === "CALC") {
    compareMode = source.sortKind === "number" ? "number" : "string";
  } else if (OPTION_FIELD_TYPES.has(source.fieldType)) {
    compareMode = "option";
  } else if (STRING_FIELD_TYPES.has(source.fieldType)) {
    compareMode = "string";
  } else {
    compareMode = "unsupported";
  }

  const optionOrder = source.optionOrder
    ? new Map(Object.entries(source.optionOrder))
    : undefined;
  return {
    fieldType: source.fieldType,
    compareMode,
    inSubtable: source.inSubtable === true,
    requiresCollectionOperators: source.inSubtable === true || source.requiresCollectionOperators === true,
    ...(optionOrder && optionOrder.size > 0 ? { optionOrder } : {}),
  };
}

export function syntheticSemantics(
  compareMode: "string" | "number",
  fieldType = compareMode === "number" ? "KSQL_NUMBER" : "KSQL_STRING"
): ResolvedFieldSemantics {
  return { fieldType, compareMode, inSubtable: false, requiresCollectionOperators: false };
}

export function withFieldSemanticSource(
  semantics: ResolvedFieldSemantics,
  appId: number,
  fieldCode: string
): ResolvedFieldSemantics {
  return { ...semantics, source: { appId, fieldCode } };
}

export function fieldSemanticsEqual(
  left: ResolvedFieldSemantics | undefined,
  right: ResolvedFieldSemantics | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.fieldType !== right.fieldType ||
    left.compareMode !== right.compareMode ||
    left.inSubtable !== right.inSubtable ||
    left.requiresCollectionOperators !== right.requiresCollectionOperators
  ) return false;
  if (
    left.source?.appId !== right.source?.appId ||
    left.source?.fieldCode !== right.source?.fieldCode
  ) return false;
  const a = left.optionOrder;
  const b = right.optionOrder;
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}
