import type {
  BinaryExpr,
  FieldRef,
  NumberLiteral,
  WhereExpr,
} from "../../types/ast";
import { numberLiteralText } from "../../types/ast";
import { whereToKintone } from "../../converter/whereToKintone";
import { resolveFieldSemantics } from "../fieldSemantics";
import { isKlike, type KlikeExpr } from "../like";
import { classifyWhereCapability } from "./whereCapability";

export type JoinPushdownRelation = "exact" | "superset";
export type JoinPushdownClassification = JoinPushdownRelation | "unsafe";

export type JoinPushdownSourceKind = "APP" | "CTE" | "TEMP" | "SUBTABLE";

/**
 * JOIN pushdown の ownership と集合関係を判定するための schema snapshot。
 * runtime への配線は B76 Phase A Step 2 以降で行う。
 */
export interface JoinPushdownSource {
  readonly alias: string;
  readonly appId: number;
  readonly sourceKind: JoinPushdownSourceKind;
  readonly fieldTypes: ReadonlyMap<string, string>;
  readonly fieldOptions?: ReadonlyMap<string, ReadonlySet<string>>;
}

export type JoinFieldOwner =
  | {
      readonly status: "OWNED";
      readonly alias: string;
      readonly appId: number;
      readonly fieldCode: string;
      readonly source: JoinPushdownSource;
    }
  | { readonly status: "AMBIGUOUS" }
  | { readonly status: "UNKNOWN" };

export interface JoinPushdownItem {
  readonly targetAlias: string;
  readonly appId: number;
  readonly predicate: WhereExpr;
  readonly relation: JoinPushdownRelation;
}

export interface JoinPushdownPlan {
  readonly items: readonly JoinPushdownItem[];
  readonly appliedKlikes: ReadonlySet<KlikeExpr>;
  readonly allKlikes: readonly KlikeExpr[];
}

export interface JoinPushdownLeafClassification {
  readonly relation: JoinPushdownClassification;
  readonly owner?: Extract<JoinFieldOwner, { status: "OWNED" }>;
}

interface Fragment {
  readonly owner: Extract<JoinFieldOwner, { status: "OWNED" }>;
  readonly predicate: WhereExpr;
  readonly relation: JoinPushdownRelation;
}

const SELECTION_TYPES = new Set([
  "DROP_DOWN",
  "RADIO_BUTTON",
  "CHECK_BOX",
  "MULTI_SELECT",
  "STATUS",
]);

const KLIKE_TYPES = new Set([
  "SINGLE_LINE_TEXT",
  "LINK",
  "MULTI_LINE_TEXT",
  "RICH_TEXT",
  "FILE",
]);

const DATETIME_EQUALITY_TYPES = new Set([
  "DATETIME",
  "CREATED_TIME",
  "UPDATED_TIME",
]);

const STEP2_EQUALITY_TYPES = new Set([
  "SINGLE_LINE_TEXT",
  "DATE",
  "TIME",
  "DATETIME",
  "CREATED_TIME",
  "UPDATED_TIME",
]);

/**
 * FIELD を alias / appId / field schema の三者で解決する。
 * 非修飾 field は全 source のうち実在先がちょうど1つの場合だけ OWNED になる。
 */
export function resolveJoinFieldOwner(
  field: FieldRef,
  sources: readonly JoinPushdownSource[]
): JoinFieldOwner {
  if (field.tableAlias !== null) {
    const aliases = sources.filter((source) => source.alias === field.tableAlias);
    if (aliases.length > 1) return Object.freeze({ status: "AMBIGUOUS" });
    if (aliases.length === 0) return Object.freeze({ status: "UNKNOWN" });
    const source = aliases[0];
    if (!source.fieldTypes.has(field.field)) return Object.freeze({ status: "UNKNOWN" });
    return owned(source, field.field);
  }

  const matches = sources.filter((source) => source.fieldTypes.has(field.field));
  if (matches.length > 1) return Object.freeze({ status: "AMBIGUOUS" });
  if (matches.length === 0) return Object.freeze({ status: "UNKNOWN" });
  return owned(matches[0], field.field);
}

/**
 * §5.2 の型×演算子表を leaf 単位で判定する。
 * whereCapability の REST/型契約とは統合せず、先にその gate を通したうえで
 * JOIN 固有の server ⊇ JS 集合関係だけを exact/superset に分類する。
 */
export function classifyJoinPushdownLeaf(
  predicate: BinaryExpr,
  sources: readonly JoinPushdownSource[]
): JoinPushdownLeafClassification {
  if (predicate.left.type !== "FIELD") return unsafe();
  const owner = resolveJoinFieldOwner(predicate.left, sources);
  if (owner.status !== "OWNED" || owner.source.sourceKind !== "APP") return unsafe();

  const fieldType = owner.source.fieldTypes.get(owner.fieldCode);
  if (fieldType === undefined || fieldType.startsWith("KSQL_")) return unsafe();

  const capability = classifyWhereCapability(predicate, (field) => {
    const resolved = resolveJoinFieldOwner(field, sources);
    if (resolved.status !== "OWNED" || resolved.source !== owner.source) return undefined;
    const type = resolved.source.fieldTypes.get(resolved.fieldCode);
    return type === undefined ? undefined : resolveFieldSemantics({ fieldType: type });
  });
  if (capability.capability !== "EXACT_PUSHDOWN") return unsafe();

  const relation = classifySupportedLeaf(predicate, owner, fieldType);
  return relation === "unsafe"
    ? unsafe()
    : Object.freeze({ relation, owner });
}

/**
 * WHERE tree を alias 別の immutable plan item へ合成する。
 * AND は安全因子を個別抽出し、OR は同一 owner の subtree 全体だけを採用する。
 */
export function buildJoinPushdownPlan(
  where: WhereExpr | null,
  sources: readonly JoinPushdownSource[]
): JoinPushdownPlan {
  const allKlikes = new Set<KlikeExpr>();
  collectKlikes(where, allKlikes);
  const fragments = where === null
    ? []
    : mergeAndFragments(classifyTree(where, sources));
  const items = fragments.map((fragment) => Object.freeze({
    targetAlias: fragment.owner.alias,
    appId: fragment.owner.appId,
    predicate: fragment.predicate,
    relation: fragment.relation,
  }));
  const appliedKlikes = new Set<KlikeExpr>();
  for (const item of items) collectKlikes(item.predicate, appliedKlikes);
  return Object.freeze({
    items: Object.freeze(items),
    appliedKlikes,
    allKlikes: Object.freeze([...allKlikes]),
  });
}

/**
 * B76 Phase A Step 2 の runtime 対象だけを計画する。
 * AND spine 上の DATE/TIME/DATETIME 系・SINGLE_LINE_TEXT の `=` leaf に限定し、
 * OR / GROUP その他の Step 3 対象は公開 classifier が採用可能でもここでは有効化しない。
 */
export function buildJoinPushdownStep2Plan(
  where: WhereExpr | null,
  sources: readonly JoinPushdownSource[]
): JoinPushdownPlan {
  const fragments = where === null
    ? []
    : mergeAndFragments(classifyStep2AndLeaves(where, sources));
  const items = fragments.map((fragment) => Object.freeze({
    targetAlias: fragment.owner.alias,
    appId: fragment.owner.appId,
    predicate: fragment.predicate,
    relation: fragment.relation,
  }));
  return Object.freeze({
    items: Object.freeze(items),
    appliedKlikes: new Set<KlikeExpr>(),
    allKlikes: Object.freeze([]),
  });
}

/**
 * alias を捨てる serializer の直前で、plan item の全 field ownership を再検査する。
 * plan の破損・別 APP への誤送信は全件取得へ黙ってフォールバックせず内部エラーにする。
 */
export function serializeJoinPushdownItem(
  item: JoinPushdownItem,
  sources: readonly JoinPushdownSource[]
): string {
  assertPredicateOwnership(item.predicate, item, sources);
  return whereToKintone(item.predicate);
}

function classifyStep2AndLeaves(
  where: WhereExpr,
  sources: readonly JoinPushdownSource[]
): readonly Fragment[] {
  if (where.type === "LOGICAL" && where.op === "AND") {
    return mergeAndFragments([
      ...classifyStep2AndLeaves(where.left, sources),
      ...classifyStep2AndLeaves(where.right, sources),
    ]);
  }
  if (where.type !== "BINARY") return [];
  const classification = classifyJoinPushdownLeaf(where, sources);
  if (classification.relation !== "superset" || classification.owner === undefined) return [];
  const fieldType = classification.owner.source.fieldTypes.get(classification.owner.fieldCode);
  if (fieldType === undefined || !STEP2_EQUALITY_TYPES.has(fieldType)) return [];
  return [{
    owner: classification.owner,
    predicate: where,
    relation: "superset",
  }];
}

function assertPredicateOwnership(
  predicate: WhereExpr,
  item: JoinPushdownItem,
  sources: readonly JoinPushdownSource[]
): void {
  switch (predicate.type) {
    case "LOGICAL":
      assertPredicateOwnership(predicate.left, item, sources);
      assertPredicateOwnership(predicate.right, item, sources);
      return;
    case "GROUP":
      assertPredicateOwnership(predicate.expr, item, sources);
      return;
    case "BINARY": {
      if (predicate.left.type !== "FIELD" || containsFieldReference(predicate.right)) {
        throw joinOwnershipError(item, "predicate contains a non-target or RHS field reference");
      }
      const owner = resolveJoinFieldOwner(predicate.left, sources);
      if (owner.status !== "OWNED"
        || owner.alias !== item.targetAlias
        || owner.appId !== item.appId
        || owner.source.sourceKind !== "APP") {
        throw joinOwnershipError(item, `field ${predicate.left.field} is not uniquely owned by the target`);
      }
      return;
    }
    case "NOT":
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      throw joinOwnershipError(item, "predicate shape is outside the Phase A serializer contract");
  }
}

function joinOwnershipError(item: JoinPushdownItem, reason: string): Error {
  return new Error(
    `InternalError: JOIN pushdown ownership guard failed for `
    + `${item.targetAlias}/APP${item.appId}: ${reason}.`
  );
}

function classifyTree(
  where: WhereExpr,
  sources: readonly JoinPushdownSource[]
): readonly Fragment[] {
  switch (where.type) {
    case "BINARY": {
      const classification = classifyJoinPushdownLeaf(where, sources);
      if (classification.relation === "unsafe" || classification.owner === undefined) return [];
      return [{
        owner: classification.owner,
        predicate: where,
        relation: classification.relation,
      }];
    }
    case "LOGICAL": {
      const left = classifyTree(where.left, sources);
      const right = classifyTree(where.right, sources);
      if (where.op === "AND") return mergeAndFragments([...left, ...right]);
      // KLIKE は applied node が residual 評価で無条件 true になるため、
      // exact/superset の通常述語と OR 合成できない（§5.5）。
      if (containsKlike(where)) return [];
      if (left.length !== 1 || right.length !== 1) return [];
      const a = left[0];
      const b = right[0];
      if (!sameOwner(a.owner, b.owner)) return [];
      return [{
        owner: a.owner,
        predicate: { type: "LOGICAL", op: "OR", left: a.predicate, right: b.predicate },
        relation: combineRelation(a.relation, b.relation),
      }];
    }
    case "GROUP":
      return classifyTree(where.expr, sources).map((fragment) => ({
        ...fragment,
        predicate: { type: "GROUP", expr: fragment.predicate },
      }));
    case "NOT":
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return [];
  }
}

function mergeAndFragments(fragments: readonly Fragment[]): readonly Fragment[] {
  const merged: Fragment[] = [];
  for (const fragment of fragments) {
    const index = merged.findIndex((candidate) => sameOwner(candidate.owner, fragment.owner));
    if (index < 0) {
      merged.push(fragment);
      continue;
    }
    const current = merged[index];
    merged[index] = {
      owner: current.owner,
      predicate: {
        type: "LOGICAL",
        op: "AND",
        left: current.predicate,
        right: fragment.predicate,
      },
      relation: combineRelation(current.relation, fragment.relation),
    };
  }
  return merged;
}

function classifySupportedLeaf(
  predicate: BinaryExpr,
  owner: Extract<JoinFieldOwner, { status: "OWNED" }>,
  fieldType: string
): JoinPushdownClassification {
  if (predicate.op === "LIKE" || predicate.op === "NOT_LIKE") return "unsafe";

  if (predicate.op === "KLIKE" || predicate.op === "NOT_KLIKE") {
    return KLIKE_TYPES.has(fieldType)
      && predicate.right.type === "STRING"
      && predicate.right.value !== ""
      ? "exact"
      : "unsafe";
  }

  if (fieldType === "__ID__" || owner.fieldCode === "$id") {
    return isPositiveSafeInteger(predicate.right)
      && (predicate.op === "=" || predicate.op === "<" || predicate.op === ">"
        || predicate.op === "<=" || predicate.op === ">=")
      ? "exact"
      : "unsafe";
  }

  if (fieldType === "RECORD_NUMBER") {
    // `$id` と同じ canonical domain を証明する repo contract はまだ無い。
    // §5.2 / §15.4 に従い、証明経路が実装されるまでは fail-closed にする。
    return "unsafe";
  }

  if (fieldType === "NUMBER") {
    if (predicate.right.type !== "NUMBER") return "unsafe";
    if (predicate.op === "=") return "superset";
    return (predicate.op === "<" || predicate.op === ">")
      && isSafeIntegerLiteral(predicate.right)
      ? "superset"
      : "unsafe";
  }

  if (fieldType === "SINGLE_LINE_TEXT") {
    return predicate.op === "="
      && predicate.right.type === "STRING"
      && predicate.right.value !== ""
      ? "superset"
      : "unsafe";
  }

  if (fieldType === "DATE" || fieldType === "TIME" || DATETIME_EQUALITY_TYPES.has(fieldType)) {
    if (predicate.op !== "=" || predicate.right.type !== "STRING") return "unsafe";
    if (fieldType === "DATE") return isCanonicalDate(predicate.right.value) ? "superset" : "unsafe";
    if (fieldType === "TIME") return isCanonicalTime(predicate.right.value) ? "superset" : "unsafe";
    return isCanonicalDateTime(predicate.right.value) ? "superset" : "unsafe";
  }

  if (SELECTION_TYPES.has(fieldType)) {
    if ((predicate.op !== "IN" && predicate.op !== "NOT_IN")
      || predicate.right.type !== "IN_LIST"
      || predicate.right.values.length === 0) return "unsafe";
    const options = owner.source.fieldOptions?.get(owner.fieldCode);
    if (options === undefined) return "unsafe";
    return predicate.right.values.every((value) =>
      value.type === "STRING" && value.value !== "" && options.has(value.value)
    ) ? "exact" : "unsafe";
  }

  return "unsafe";
}

function owned(
  source: JoinPushdownSource,
  fieldCode: string
): Extract<JoinFieldOwner, { status: "OWNED" }> {
  return Object.freeze({
    status: "OWNED",
    alias: source.alias,
    appId: source.appId,
    fieldCode,
    source,
  });
}

function unsafe(): JoinPushdownLeafClassification {
  return Object.freeze({ relation: "unsafe" });
}

function sameOwner(
  left: Extract<JoinFieldOwner, { status: "OWNED" }>,
  right: Extract<JoinFieldOwner, { status: "OWNED" }>
): boolean {
  return left.alias === right.alias
    && left.appId === right.appId
    && left.source === right.source;
}

function combineRelation(
  left: JoinPushdownRelation,
  right: JoinPushdownRelation
): JoinPushdownRelation {
  return left === "exact" && right === "exact" ? "exact" : "superset";
}

function isPositiveSafeInteger(value: BinaryExpr["right"]): boolean {
  return value.type === "NUMBER"
    && isSafeIntegerLiteral(value)
    && value.value > 0;
}

function isSafeIntegerLiteral(value: NumberLiteral): boolean {
  return /^-?\d+$/.test(numberLiteralText(value))
    && Number.isSafeInteger(value.value);
}

function isCanonicalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isCanonicalTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function isCanonicalDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (!match || !isCanonicalDate(match[1])) return false;
  return Number(match[2]) <= 23
    && Number(match[3]) <= 59
    && Number(match[4]) <= 59;
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

function containsKlike(where: WhereExpr): boolean {
  const found = new Set<KlikeExpr>();
  collectKlikes(where, found);
  return found.size > 0;
}

function containsFieldReference(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsFieldReference);
  const record = value as Record<string, unknown>;
  if (record.type === "FIELD" || record.type === "FIELD_REF") return true;
  return Object.values(record).some(containsFieldReference);
}
