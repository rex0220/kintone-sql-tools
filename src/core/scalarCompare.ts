import { syntheticSemantics, type ResolvedFieldSemantics } from "./fieldSemantics";

export type ScalarCompareOp = "=" | "!=" | "<>" | ">" | "<" | ">=" | "<=";
export type ScalarExtreme = "greatest" | "least";
export type CompareResult = -1 | 0 | 1;

export function compareCodePointStrings(left: string, right: string): CompareResult {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  while (true) {
    const av = a.next();
    const bv = b.next();
    if (av.done || bv.done) {
      if (av.done && bv.done) return 0;
      return av.done ? -1 : 1;
    }
    const ac = av.value.codePointAt(0) ?? 0;
    const bc = bv.value.codePointAt(0) ?? 0;
    if (ac < bc) return -1;
    if (ac > bc) return 1;
  }
}

function triCompare(left: number, right: number): CompareResult {
  return left < right ? -1 : left > right ? 1 : 0;
}

type NumberKey =
  | { band: 0 | 1 | 3 | 4 }
  | { band: 2; value: number }
  | { band: 5; value: string };

function numberKey(value: string): NumberKey {
  if (value === "") return { band: 0 };
  const numeric = Number(value);
  if (numeric === Number.NEGATIVE_INFINITY) return { band: 1 };
  if (Number.isFinite(numeric)) return { band: 2, value: numeric };
  if (numeric === Number.POSITIVE_INFINITY) return { band: 3 };
  if (value === "NaN") return { band: 4 };
  return { band: 5, value };
}

function compareNumbers(left: string, right: string): CompareResult {
  const a = numberKey(left);
  const b = numberKey(right);
  if (a.band !== b.band) return a.band < b.band ? -1 : 1;
  if (a.band === 2 && b.band === 2) return triCompare(a.value, b.value);
  if (a.band === 5 && b.band === 5) return compareCodePointStrings(a.value, b.value);
  return 0;
}

interface RecordNumberKey {
  empty: boolean;
  normalizedId: string;
  display: string;
}

function recordNumberKey(value: string, allowPrefix: boolean): RecordNumberKey {
  if (value === "") return { empty: true, normalizedId: "", display: value };
  const match = /^\d+$/.test(value)
    ? value
    : allowPrefix
      ? /-(\d+)$/.exec(value)?.[1]
      : undefined;
  if (match === undefined) {
    throw new Error(`ArgumentError: invalid ${allowPrefix ? "RECORD_NUMBER" : "$id"} value: ${value}`);
  }
  return {
    empty: false,
    normalizedId: match.replace(/^0+(?=\d)/, ""),
    display: value,
  };
}

function compareRecordNumbers(left: string, right: string, allowPrefix: boolean): CompareResult {
  const a = recordNumberKey(left, allowPrefix);
  const b = recordNumberKey(right, allowPrefix);
  if (a.empty || b.empty) return a.empty === b.empty ? 0 : a.empty ? -1 : 1;
  if (a.normalizedId.length !== b.normalizedId.length) {
    return a.normalizedId.length < b.normalizedId.length ? -1 : 1;
  }
  const idCmp = compareCodePointStrings(a.normalizedId, b.normalizedId);
  return idCmp !== 0 ? idCmp : compareCodePointStrings(a.display, b.display);
}

interface OptionElementKey {
  knownBand: 0 | 1;
  rank: number;
  label: string;
}

function parseOptionValues(value: string, fieldType: string): string[] {
  if (value === "") return [];
  if (fieldType !== "CHECK_BOX" && fieldType !== "MULTI_SELECT") return [value];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? "")) : [value];
  } catch {
    return [value];
  }
}

function optionVector(value: string, semantics: ResolvedFieldSemantics): OptionElementKey[] {
  const order = semantics.optionOrder ?? new Map<string, number>();
  const unique = [...new Set(parseOptionValues(value, semantics.fieldType))];
  const vector = unique.map((label): OptionElementKey => {
    const rank = order.get(label);
    return rank === undefined
      ? { knownBand: 1, rank: 0, label }
      : { knownBand: 0, rank, label };
  });
  vector.sort(compareOptionElement);
  return vector;
}

function compareOptionElement(left: OptionElementKey, right: OptionElementKey): CompareResult {
  if (left.knownBand !== right.knownBand) return left.knownBand < right.knownBand ? -1 : 1;
  if (left.rank !== right.rank) return left.rank < right.rank ? -1 : 1;
  return compareCodePointStrings(left.label, right.label);
}

function compareOptions(
  left: string,
  right: string,
  semantics: ResolvedFieldSemantics
): CompareResult {
  const a = optionVector(left, semantics);
  const b = optionVector(right, semantics);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const cmp = compareOptionElement(a[index], b[index]);
    if (cmp !== 0) return cmp;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

export function compareCanonicalValues(
  left: string,
  right: string,
  semantics: ResolvedFieldSemantics
): CompareResult {
  switch (semantics.compareMode) {
    case "string":
      return compareCodePointStrings(left, right);
    case "number":
      return compareNumbers(left, right);
    case "recordNumber":
      return compareRecordNumbers(left, right, semantics.fieldType === "RECORD_NUMBER");
    case "option":
      return compareOptions(left, right, semantics);
    case "unsupported":
      throw new Error(`ArgumentError: values of type ${semantics.fieldType} cannot be compared.`);
  }
}

export function compareScalarValues(
  op: ScalarCompareOp,
  left: string,
  right: string,
  semantics: ResolvedFieldSemantics = syntheticSemantics("string")
): boolean {
  const cmp = compareCanonicalValues(left, right, semantics);
  switch (op) {
    case "=": return cmp === 0;
    case "!=":
    case "<>": return cmp !== 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
  }
}

/** GREATEST / LEAST は B19 の集合全体モードを維持する。 */
export function selectScalarExtreme(values: readonly string[], extreme: ScalarExtreme): string {
  if (extreme === "least" && values.includes("")) return "";
  const candidates = extreme === "greatest" ? values.filter((value) => value !== "") : [...values];
  if (candidates.length === 0) return "";

  const numeric = candidates.every((value) => !Number.isNaN(Number(value)));
  const compare = (left: string, right: string): CompareResult => {
    if (numeric) {
      const numericCmp = triCompare(Number(left), Number(right));
      if (numericCmp !== 0) return numericCmp;
    }
    return compareCodePointStrings(left, right);
  };
  return candidates.reduce((best, candidate) => {
    const cmp = compare(candidate, best);
    return extreme === "greatest" ? (cmp > 0 ? candidate : best) : (cmp < 0 ? candidate : best);
  });
}
