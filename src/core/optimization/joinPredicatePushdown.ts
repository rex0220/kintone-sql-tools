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
import {
  SERVER_ONLY_WHERE_FUNCTION_NAMES,
} from "../relativeDateFunction";
import {
  serverOnlyFunctionOccurrencesInWhere,
} from "./relativeDateFullScanExactPlan";
import { classifyWhereCapability } from "./whereCapability";

/**
 * Phase A item 全体の server ⊇ client 集合関係。
 * server-only 関数 leaf の消費証明とは意図的に別型にする。
 */
export type JoinPushdownItemRelation = "exact" | "superset";
export type JoinPushdownRelation = JoinPushdownItemRelation;
export type JoinPushdownClassification = JoinPushdownItemRelation | "unsafe";

/**
 * Phase B 関数 leaf 単体の6点契約のうち、Step 1 で証明できる exactness。
 * item relation の "exact" / "superset" と代入互換にしない。
 */
export type JoinServerFunctionConsumptionRelation = "function-leaf-exact";
export type JoinServerFunctionVariant = "EXACT_LEAF" | "WHOLE_WHERE_EXACT";

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
  readonly relation: JoinPushdownItemRelation;
}

export interface JoinServerFunctionConsumption {
  readonly targetAlias: string;
  readonly appId: number;
  /** 採用・serialize・residual 除去で共有する元 leaf identity。 */
  readonly predicate: WhereExpr;
  readonly functionLeaves: readonly BinaryExpr[];
  /** 同名関数も重複を保持する occurrence multiset の列挙。 */
  readonly functionOccurrences: readonly string[];
  readonly relation: JoinServerFunctionConsumptionRelation;
  readonly consumption: "leaf" | "whole-where";
  readonly serializedPredicate: string;
  readonly staticProof: {
    readonly classifier: "EXACT_PUSHDOWN";
    readonly ownership: "OWNED";
    readonly serialization: "OCCURRENCE_MULTISET_EXACT";
    readonly residualIdentityConsumption: "CONFIRMED";
  };
  /**
   * §2.3(4) は runtime fetch query への束縛で確定する。
   * 静的 proof と実行許可を型で区別する。
   */
  readonly fetchBinding:
    | "PENDING_STEP_2"
    | {
        readonly status: "BOUND_TO_TARGET_FETCH";
        readonly targetAlias: string;
        readonly appId: number;
        readonly query: string;
      };
}

export interface JoinServerFunctionCandidate {
  readonly variant: JoinServerFunctionVariant;
  readonly staticContract:
    | "CONFIRMED"
    | "INCOMPLETE";
  readonly fetchContract: "PENDING_STEP_2" | "CONFIRMED";
}

export type JoinPushdownRejectionReason =
  | "AMBIGUOUS_FIELD"
  | "UNKNOWN_FIELD_OR_METADATA"
  | "CROSS_ALIAS_OR"
  | "CROSS_TABLE_BINARY"
  | "KLIKE_OR"
  | "NOT"
  | "UNSAFE_RELATION";

export interface JoinPushdownRejection {
  readonly reason: JoinPushdownRejectionReason;
}

export interface JoinPushdownPlan {
  readonly items: readonly JoinPushdownItem[];
  readonly appliedKlikes: ReadonlySet<KlikeExpr>;
  readonly allKlikes: readonly KlikeExpr[];
  readonly rejections: readonly JoinPushdownRejection[];
  readonly serverFunctionCandidate: JoinServerFunctionCandidate | null;
  readonly serverFunctionConsumptions: readonly JoinServerFunctionConsumption[];
  readonly allServerFunctionOccurrences: readonly string[];
  readonly adoptedServerFunctionOccurrences: readonly string[];
  readonly residualWhere: WhereExpr | null;
  readonly residualServerFunctionOccurrences: readonly string[];
  /** alias ごとに records fetch へそのまま渡す、検証済みの完全な query。 */
  readonly fetchQueriesByAlias: ReadonlyMap<string, string>;
}

export interface JoinPushdownLeafClassification {
  readonly relation: JoinPushdownClassification;
  readonly owner?: Extract<JoinFieldOwner, { status: "OWNED" }>;
}

export type JoinServerFunctionLeafClassification =
  | {
      readonly relation: JoinServerFunctionConsumptionRelation;
      readonly owner: Extract<JoinFieldOwner, { status: "OWNED" }>;
      readonly functionOccurrences: readonly string[];
    }
  | { readonly relation: "unsafe" };

interface Fragment {
  readonly owner: Extract<JoinFieldOwner, { status: "OWNED" }>;
  readonly predicate: WhereExpr;
  readonly relation: JoinPushdownItemRelation;
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
 * B77/B78 matrix と JOIN ownership を両方通した server-only 関数 leaf。
 * Phase A item relation classifier とは独立した型を返す。
 */
export function classifyJoinServerFunctionLeaf(
  predicate: BinaryExpr,
  sources: readonly JoinPushdownSource[]
): JoinServerFunctionLeafClassification {
  const functionOccurrences = serverOnlyFunctionOccurrencesInWhere(predicate);
  if (functionOccurrences.length === 0 || predicate.left.type !== "FIELD") {
    return Object.freeze({ relation: "unsafe" });
  }
  const owner = resolveJoinFieldOwner(predicate.left, sources);
  if (owner.status !== "OWNED" || owner.source.sourceKind !== "APP") {
    return Object.freeze({ relation: "unsafe" });
  }
  const capability = classifyWhereCapability(predicate, (field) => {
    const resolved = resolveJoinFieldOwner(field, sources);
    if (resolved.status !== "OWNED" || resolved.source !== owner.source) return undefined;
    const type = resolved.source.fieldTypes.get(resolved.fieldCode);
    return type === undefined ? undefined : resolveFieldSemantics({ fieldType: type });
  });
  if (capability.capability !== "EXACT_PUSHDOWN") {
    return Object.freeze({ relation: "unsafe" });
  }
  return Object.freeze({
    relation: "function-leaf-exact",
    owner,
    functionOccurrences: Object.freeze([...functionOccurrences]),
  });
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
  const serverFunctionFoundation = buildServerFunctionFoundation(where, sources);
  const appliedKlikes = new Set<KlikeExpr>();
  if (serverFunctionFoundation.serverFunctionCandidate?.variant === "WHOLE_WHERE_EXACT") {
    for (const klike of allKlikes) appliedKlikes.add(klike);
  } else {
    for (const item of items) collectKlikes(item.predicate, appliedKlikes);
  }
  return Object.freeze({
    items: Object.freeze(items),
    appliedKlikes,
    allKlikes: Object.freeze([...allKlikes]),
    rejections: Object.freeze(collectRejections(where, sources)),
    fetchQueriesByAlias: new Map<string, string>(),
    ...serverFunctionFoundation,
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
  const serverFunctionFoundation = emptyServerFunctionFoundation(where);
  return Object.freeze({
    items: Object.freeze(items),
    appliedKlikes: new Set<KlikeExpr>(),
    allKlikes: Object.freeze([]),
    rejections: Object.freeze(collectRejections(where, sources)),
    fetchQueriesByAlias: new Map<string, string>(),
    ...serverFunctionFoundation,
  });
}

/**
 * 第5-L の静的 plan を alias ごとの実 fetch query へ原子的に束縛する。
 * 全 item / consumption を先に serialize・照合し、1件でも不整合なら未束縛 plan を返す。
 * 第5-W を第5-Lより先に束縛し、whole WHERE と leaf を重複送信しない。
 */
export function bindJoinServerFunctionFetches(
  plan: JoinPushdownPlan,
  sources: readonly JoinPushdownSource[]
): JoinPushdownPlan {
  if (
    plan.serverFunctionCandidate?.staticContract !== "CONFIRMED"
    || plan.serverFunctionConsumptions.length === 0
    || plan.residualServerFunctionOccurrences.length !== 0
    || !sameStringMultiset(
      plan.allServerFunctionOccurrences,
      plan.adoptedServerFunctionOccurrences
    )
    || plan.allKlikes.some((klike) => !plan.appliedKlikes.has(klike))
  ) {
    return plan;
  }

  const queryPartsByAlias = new Map<string, string[]>();
  const append = (alias: string, query: string): void => {
    const parts = queryPartsByAlias.get(alias);
    if (parts) parts.push(query);
    else queryPartsByAlias.set(alias, [query]);
  };

  try {
    if (plan.serverFunctionCandidate.variant === "EXACT_LEAF") {
      for (const item of plan.items) {
        append(item.targetAlias, serializeJoinPushdownItem(item, sources));
      }
    }
    for (const consumption of plan.serverFunctionConsumptions) {
      const source = sources.find((candidate) =>
        candidate.alias === consumption.targetAlias
        && candidate.appId === consumption.appId
        && candidate.sourceKind === "APP"
      );
      if (!source) return plan;
      const serialized = serializeJoinPushdownItem({
        targetAlias: consumption.targetAlias,
        appId: consumption.appId,
        predicate: consumption.predicate,
        relation: "exact",
      }, sources);
      if (
        serialized !== consumption.serializedPredicate
        || !sameStringMultiset(
          serverFunctionOccurrencesInSerializedQuery(serialized),
          consumption.functionOccurrences
        )
      ) {
        return plan;
      }
      append(consumption.targetAlias, serialized);
    }
  } catch {
    return plan;
  }

  const fetchQueriesByAlias = new Map<string, string>();
  for (const [alias, parts] of queryPartsByAlias) {
    fetchQueriesByAlias.set(
      alias,
      parts.length === 1
        ? parts[0]
        : parts.map((part) => `(${part})`).join(" and ")
    );
  }

  const boundConsumptions = plan.serverFunctionConsumptions.map((consumption) => {
    const query = fetchQueriesByAlias.get(consumption.targetAlias);
    if (!query) return null;
    return Object.freeze({
      ...consumption,
      fetchBinding: Object.freeze({
        status: "BOUND_TO_TARGET_FETCH" as const,
        targetAlias: consumption.targetAlias,
        appId: consumption.appId,
        query,
      }),
    });
  });
  if (boundConsumptions.some((consumption) => consumption === null)) return plan;

  return Object.freeze({
    ...plan,
    serverFunctionCandidate: Object.freeze({
      ...plan.serverFunctionCandidate,
      fetchContract: "CONFIRMED" as const,
    }),
    serverFunctionConsumptions: Object.freeze(
      boundConsumptions as JoinServerFunctionConsumption[]
    ),
    fetchQueriesByAlias,
  });
}

/** 第5-L guard/runtime が共有する、実 fetch 束縛済み plan の意味検証。 */
export function isJoinServerFunctionFetchPlan(
  plan: JoinPushdownPlan
): boolean {
  if (
    plan.serverFunctionCandidate === null
    || plan.serverFunctionCandidate.staticContract !== "CONFIRMED"
    || plan.serverFunctionCandidate.fetchContract !== "CONFIRMED"
    || plan.serverFunctionConsumptions.length === 0
    || plan.residualServerFunctionOccurrences.length !== 0
    || !sameStringMultiset(
      plan.allServerFunctionOccurrences,
      plan.adoptedServerFunctionOccurrences
    )
  ) {
    return false;
  }
  if (!plan.serverFunctionConsumptions.every((consumption) => {
    const binding = consumption.fetchBinding;
    return binding !== "PENDING_STEP_2"
      && binding.status === "BOUND_TO_TARGET_FETCH"
      && binding.targetAlias === consumption.targetAlias
      && binding.appId === consumption.appId
      && binding.query === plan.fetchQueriesByAlias.get(consumption.targetAlias)
      && binding.query.includes(consumption.serializedPredicate);
  })) {
    return false;
  }
  for (const [alias, query] of plan.fetchQueriesByAlias) {
    const expected = plan.serverFunctionConsumptions
      .filter((consumption) => consumption.targetAlias === alias)
      .flatMap((consumption) => [...consumption.functionOccurrences]);
    if (
      expected.length > 0
      && !sameStringMultiset(
        serverFunctionOccurrencesInSerializedQuery(query),
        expected
      )
    ) {
      return false;
    }
  }
  if (
    plan.serverFunctionCandidate.variant === "WHOLE_WHERE_EXACT"
    && (
      plan.serverFunctionConsumptions.length !== 1
      || plan.serverFunctionConsumptions[0].consumption !== "whole-where"
      || plan.residualWhere !== null
      || plan.allKlikes.some((klike) => !plan.appliedKlikes.has(klike))
      || countSerializedKlikes(queryForWholeWhere(plan)) !== plan.allKlikes.length
    )
  ) {
    return false;
  }
  return true;
}

type ServerFunctionFoundation = Pick<
  JoinPushdownPlan,
  | "serverFunctionCandidate"
  | "serverFunctionConsumptions"
  | "allServerFunctionOccurrences"
  | "adoptedServerFunctionOccurrences"
  | "residualWhere"
  | "residualServerFunctionOccurrences"
>;

function buildServerFunctionFoundation(
  where: WhereExpr | null,
  sources: readonly JoinPushdownSource[]
): ServerFunctionFoundation {
  if (where === null) return emptyServerFunctionFoundation(null);
  const allOccurrences = Object.freeze([
    ...serverOnlyFunctionOccurrencesInWhere(where),
  ]);
  if (allOccurrences.length === 0) return emptyServerFunctionFoundation(where);

  const wholeWhere = buildWholeWhereServerFunctionFoundation(
    where,
    sources,
    allOccurrences
  );
  if (wholeWhere !== null) return wholeWhere;

  const candidates = collectServerFunctionLeavesOnAndSpine(where);
  const consumptions: JoinServerFunctionConsumption[] = [];
  const adoptedLeaves = new Set<BinaryExpr>();
  for (const leaf of candidates) {
    const classification = classifyJoinServerFunctionLeaf(leaf, sources);
    if (classification.relation !== "function-leaf-exact") continue;

    const guardItem: JoinPushdownItem = {
      targetAlias: classification.owner.alias,
      appId: classification.owner.appId,
      predicate: leaf,
      relation: "exact",
    };
    let serializedPredicate: string;
    try {
      serializedPredicate = serializeJoinPushdownItem(guardItem, sources);
    } catch {
      continue;
    }
    const serializedOccurrences =
      serverFunctionOccurrencesInSerializedQuery(serializedPredicate);
    if (!sameStringMultiset(serializedOccurrences, classification.functionOccurrences)) {
      continue;
    }

    adoptedLeaves.add(leaf);
    consumptions.push(Object.freeze({
      targetAlias: classification.owner.alias,
      appId: classification.owner.appId,
      predicate: leaf,
      functionLeaves: Object.freeze([leaf]),
      functionOccurrences: classification.functionOccurrences,
      relation: classification.relation,
      consumption: "leaf",
      serializedPredicate,
      staticProof: Object.freeze({
        classifier: "EXACT_PUSHDOWN",
        ownership: "OWNED",
        serialization: "OCCURRENCE_MULTISET_EXACT",
        residualIdentityConsumption: "CONFIRMED",
      }),
      fetchBinding: "PENDING_STEP_2",
    }));
  }

  const residualWhere = removeAdoptedLeavesFromAndSpine(where, adoptedLeaves);
  const residualOccurrences = Object.freeze(residualWhere === null
    ? []
    : [...serverOnlyFunctionOccurrencesInWhere(residualWhere)]);
  const adoptedOccurrences = Object.freeze(consumptions.flatMap(
    (consumption) => [...consumption.functionOccurrences]
  ));
  const staticContract =
    sameStringMultiset(allOccurrences, adoptedOccurrences)
      && residualOccurrences.length === 0
      ? "CONFIRMED"
      : "INCOMPLETE";
  return {
    serverFunctionCandidate: Object.freeze({
      variant: "EXACT_LEAF",
      staticContract,
      fetchContract: "PENDING_STEP_2",
    }),
    serverFunctionConsumptions: Object.freeze(consumptions),
    allServerFunctionOccurrences: allOccurrences,
    adoptedServerFunctionOccurrences: adoptedOccurrences,
    residualWhere,
    residualServerFunctionOccurrences: residualOccurrences,
  };
}

function buildWholeWhereServerFunctionFoundation(
  where: WhereExpr,
  sources: readonly JoinPushdownSource[],
  allOccurrences: readonly string[]
): ServerFunctionFoundation | null {
  const owner = classifyWholeWhereExactOwner(where, sources);
  if (owner === null) return null;

  const item: JoinPushdownItem = {
    targetAlias: owner.alias,
    appId: owner.appId,
    predicate: where,
    relation: "exact",
  };
  let serializedPredicate: string;
  try {
    serializedPredicate = serializeJoinPushdownItem(item, sources);
  } catch {
    return null;
  }
  if (
    !sameStringMultiset(
      serverFunctionOccurrencesInSerializedQuery(serializedPredicate),
      allOccurrences
    )
  ) {
    return null;
  }
  const allKlikes = new Set<KlikeExpr>();
  collectKlikes(where, allKlikes);
  if (countSerializedKlikes(serializedPredicate) !== allKlikes.size) return null;

  const functionLeaves = Object.freeze(collectServerFunctionLeaves(where));
  const consumption: JoinServerFunctionConsumption = Object.freeze({
    targetAlias: owner.alias,
    appId: owner.appId,
    predicate: where,
    functionLeaves,
    functionOccurrences: Object.freeze([...allOccurrences]),
    relation: "function-leaf-exact",
    consumption: "whole-where",
    serializedPredicate,
    staticProof: Object.freeze({
      classifier: "EXACT_PUSHDOWN",
      ownership: "OWNED",
      serialization: "OCCURRENCE_MULTISET_EXACT",
      residualIdentityConsumption: "CONFIRMED",
    }),
    fetchBinding: "PENDING_STEP_2",
  });
  return {
    serverFunctionCandidate: Object.freeze({
      variant: "WHOLE_WHERE_EXACT",
      staticContract: "CONFIRMED",
      fetchContract: "PENDING_STEP_2",
    }),
    serverFunctionConsumptions: Object.freeze([consumption]),
    allServerFunctionOccurrences: Object.freeze([...allOccurrences]),
    adoptedServerFunctionOccurrences: Object.freeze([...allOccurrences]),
    residualWhere: null,
    residualServerFunctionOccurrences: Object.freeze([]),
  };
}

function classifyWholeWhereExactOwner(
  where: WhereExpr,
  sources: readonly JoinPushdownSource[]
): Extract<JoinFieldOwner, { status: "OWNED" }> | null {
  switch (where.type) {
    case "BINARY": {
      const functionOccurrences = serverOnlyFunctionOccurrencesInWhere(where);
      if (functionOccurrences.length > 0) {
        const classification = classifyJoinServerFunctionLeaf(where, sources);
        return classification.relation === "function-leaf-exact"
          ? classification.owner
          : null;
      }
      const classification = classifyJoinPushdownLeaf(where, sources);
      return classification.relation === "exact" && classification.owner !== undefined
        ? classification.owner
        : null;
    }
    case "LOGICAL": {
      const left = classifyWholeWhereExactOwner(where.left, sources);
      const right = classifyWholeWhereExactOwner(where.right, sources);
      return left !== null && right !== null && sameOwner(left, right) ? left : null;
    }
    case "GROUP":
    case "NOT":
      return classifyWholeWhereExactOwner(where.expr, sources);
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return null;
  }
}

function collectServerFunctionLeaves(where: WhereExpr): BinaryExpr[] {
  switch (where.type) {
    case "BINARY":
      return serverOnlyFunctionOccurrencesInWhere(where).length > 0 ? [where] : [];
    case "LOGICAL":
      return [
        ...collectServerFunctionLeaves(where.left),
        ...collectServerFunctionLeaves(where.right),
      ];
    case "GROUP":
    case "NOT":
      return collectServerFunctionLeaves(where.expr);
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return [];
  }
}

function emptyServerFunctionFoundation(
  where: WhereExpr | null
): ServerFunctionFoundation {
  const occurrences = where === null
    ? []
    : serverOnlyFunctionOccurrencesInWhere(where);
  return {
    serverFunctionCandidate: null,
    serverFunctionConsumptions: Object.freeze([]),
    allServerFunctionOccurrences: Object.freeze([...occurrences]),
    adoptedServerFunctionOccurrences: Object.freeze([]),
    residualWhere: where,
    residualServerFunctionOccurrences: Object.freeze([...occurrences]),
  };
}

function collectServerFunctionLeavesOnAndSpine(
  where: WhereExpr
): readonly BinaryExpr[] {
  switch (where.type) {
    case "BINARY":
      return serverOnlyFunctionOccurrencesInWhere(where).length > 0 ? [where] : [];
    case "LOGICAL":
      return where.op === "AND"
        ? [
          ...collectServerFunctionLeavesOnAndSpine(where.left),
          ...collectServerFunctionLeavesOnAndSpine(where.right),
        ]
        : [];
    case "GROUP":
      return collectServerFunctionLeavesOnAndSpine(where.expr);
    case "NOT":
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return [];
  }
}

function removeAdoptedLeavesFromAndSpine(
  where: WhereExpr,
  adoptedLeaves: ReadonlySet<BinaryExpr>
): WhereExpr | null {
  if (where.type === "BINARY") return adoptedLeaves.has(where) ? null : where;
  if (where.type === "LOGICAL") {
    if (where.op !== "AND") return where;
    const left = removeAdoptedLeavesFromAndSpine(where.left, adoptedLeaves);
    const right = removeAdoptedLeavesFromAndSpine(where.right, adoptedLeaves);
    if (left === null) return right;
    if (right === null) return left;
    if (left === where.left && right === where.right) return where;
    return { ...where, left, right };
  }
  if (where.type === "GROUP") {
    const expr = removeAdoptedLeavesFromAndSpine(where.expr, adoptedLeaves);
    if (expr === null) return null;
    return expr === where.expr ? where : { ...where, expr };
  }
  return where;
}

function serverFunctionOccurrencesInSerializedQuery(query: string): string[] {
  const matches: Array<{ readonly name: string; readonly index: number }> = [];
  for (const name of SERVER_ONLY_WHERE_FUNCTION_NAMES) {
    const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
      matches.push({ name, index: match.index });
    }
  }
  return matches
    .sort((left, right) => left.index - right.index)
    .map((match) => match.name);
}

function sameStringMultiset(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function countSerializedKlikes(query: string): number {
  return [...query.matchAll(/\s(?:not\s+)?like\s/g)].length;
}

function queryForWholeWhere(plan: JoinPushdownPlan): string {
  const consumption = plan.serverFunctionConsumptions[0];
  return consumption === undefined
    ? ""
    : (plan.fetchQueriesByAlias.get(consumption.targetAlias) ?? "");
}

function collectRejections(
  where: WhereExpr | null,
  sources: readonly JoinPushdownSource[]
): JoinPushdownRejection[] {
  if (where === null) return [];
  const reasons = new Set<JoinPushdownRejectionReason>();
  const visit = (expr: WhereExpr): void => {
    if (expr.type === "BINARY") {
      if (expr.left.type !== "FIELD") {
        reasons.add("UNSAFE_RELATION");
        return;
      }
      const owner = resolveJoinFieldOwner(expr.left, sources);
      if (owner.status === "AMBIGUOUS") {
        reasons.add("AMBIGUOUS_FIELD");
        return;
      }
      if (owner.status === "UNKNOWN") {
        reasons.add("UNKNOWN_FIELD_OR_METADATA");
        return;
      }
      if (containsFieldReference(expr.right)) {
        reasons.add("CROSS_TABLE_BINARY");
        return;
      }
      if (classifyJoinPushdownLeaf(expr, sources).relation === "unsafe") {
        reasons.add("UNSAFE_RELATION");
      }
      return;
    }
    if (expr.type === "LOGICAL") {
      if (expr.op === "OR") {
        if (containsKlike(expr)) {
          reasons.add("KLIKE_OR");
          return;
        }
        const left = classifyTree(expr.left, sources);
        const right = classifyTree(expr.right, sources);
        if (left.length !== 1 || right.length !== 1
          || !sameOwner(left[0].owner, right[0].owner)) {
          reasons.add("CROSS_ALIAS_OR");
          return;
        }
      }
      visit(expr.left);
      visit(expr.right);
      return;
    }
    if (expr.type === "GROUP") {
      visit(expr.expr);
      return;
    }
    if (expr.type === "NOT") {
      reasons.add("NOT");
      return;
    }
    reasons.add("UNSAFE_RELATION");
  };
  visit(where);
  return [...reasons].map((reason) => Object.freeze({ reason }));
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
    case "NOT":
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
