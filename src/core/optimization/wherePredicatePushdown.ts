import type { WhereExpr, FieldValue } from "../../types/ast";
import { numberLiteralText } from "../../types/ast";
import { resolveFieldSemantics } from "../fieldSemantics";
import { classifyWhereCapability } from "./whereCapability";
import {
  classifySupportedLeaf,
  isSupportedLeafMetadataCandidate,
  type SupportedLeafRelation,
} from "./supportedLeafPolicy";

export interface SafePushdownOptions {
  /** JOIN 時に抽出対象とするテーブルエイリアス。 */
  tableAlias?: string;
  /**
   * 単一テーブルでは、正しいエイリアス付き参照に加えて非修飾参照も安全に扱える。
   * JOIN 時は false のままにし、対象エイリアスの明示参照だけを許可する。
   */
  allowUnqualifiedFields?: boolean;
  /** 一般フィールドの型別ホワイトリスト。未指定・型不明なら一般フィールドは抽出しない。 */
  fieldTypes?: ReadonlyMap<string, string>;
  /** 選択系フィールドの実在選択肢集合。未指定・対象フィールドなしなら IN は抽出しない。 */
  fieldOptions?: ReadonlyMap<string, ReadonlySet<string>>;
  /** KLIKE を安全リーフ候補に含める。外部結合などでは false にする。 */
  allowKlike?: boolean;
  /** 静的検証時だけ、未解決のバッチ変数を KLIKE 候補として扱う。 */
  allowUnresolvedKlikeVariables?: boolean;
}

type PushdownCandidateOptions = Pick<
  SafePushdownOptions,
  "tableAlias" | "allowUnqualifiedFields"
>;

/**
 * WHERE から kintone へ安全に押し下げられる AND リーフだけを抽出する。
 *
 * `$id` の肯定数値比較に加え、型メタで NUMBER と確定した一般フィールドの
 * `=` と strict `<` / `>`（安全整数境界）だけを許可する。
 * GROUP は透過するが、OR / NOT / NULL 判定 / EXISTS はサブツリーごと除外する。
 */
export function extractSafePushdownLeaves(
  where: WhereExpr,
  options: SafePushdownOptions = {}
): WhereExpr | null {
  return extractSafePushdownPlan(where, options).condition;
}

export interface SafePushdownExtraction {
  readonly condition: WhereExpr | null;
  readonly relation: Exclude<SupportedLeafRelation, "unsafe"> | null;
}

/** condition と leaf relation を同じ分類結果から構築する。 */
export function extractSafePushdownPlan(
  where: WhereExpr,
  options: SafePushdownOptions = {}
): SafePushdownExtraction {
  return extractAndLeafPlan(where, (expr) => classifySafeComparison(expr, options));
}

/**
 * EXPLAIN と実行前の型メタ取得判定に使う、一般数値フィールドの構文上の候補抽出。
 * 型は未確定なので `$id` を除外し、実際の kintone query には直接使わない。
 */
export function extractNumericPushdownCandidates(
  where: WhereExpr,
  options: PushdownCandidateOptions = {}
): WhereExpr | null {
  return extractAndLeaves(where, (expr) => isNumericCandidate(expr, options));
}

/** 数値比較と選択系 IN / NOT IN の、型メタ非依存な構文候補を抽出する。 */
export function extractTypedPushdownCandidates(
  where: WhereExpr,
  options: PushdownCandidateOptions = {}
): WhereExpr | null {
  return extractAndLeaves(
    where,
    (expr) => isSupportedLeafMetadataCandidate(expr, (field) => isTargetField(field, options))
  );
}

function extractAndLeafPlan(
  where: WhereExpr,
  classify: (expr: Extract<WhereExpr, { type: "BINARY" }>) => SupportedLeafRelation
): SafePushdownExtraction {
  switch (where.type) {
    case "BINARY": {
      const relation = classify(where);
      return relation === "unsafe"
        ? { condition: null, relation: null }
        : { condition: where, relation };
    }
    case "LOGICAL": {
      if (where.op !== "AND") return { condition: null, relation: null };
      const left = extractAndLeafPlan(where.left, classify);
      const right = extractAndLeafPlan(where.right, classify);
      if (left.condition && right.condition) {
        return {
          condition: { ...where, left: left.condition, right: right.condition },
          relation: left.relation === "exact" && right.relation === "exact" ? "exact" : "superset",
        };
      }
      return left.condition ? left : right;
    }
    case "GROUP":
      return extractAndLeafPlan(where.expr, classify);
    case "NULL_CHECK":
    case "NOT":
    case "EXISTS":
    case "BOOLEAN":
      return { condition: null, relation: null };
  }
}

function extractAndLeaves(
  where: WhereExpr,
  accept: (expr: Extract<WhereExpr, { type: "BINARY" }>) => boolean
): WhereExpr | null {
  switch (where.type) {
    case "BINARY":
      return accept(where) ? where : null;

    case "LOGICAL":
      if (where.op !== "AND") return null;
      {
        const left = extractAndLeaves(where.left, accept);
        const right = extractAndLeaves(where.right, accept);
        if (left && right) return { ...where, left, right };
        return left ?? right ?? null;
      }

    case "GROUP":
      return extractAndLeaves(where.expr, accept);

    case "NULL_CHECK":
    case "NOT":
    case "EXISTS":
    case "BOOLEAN":
      return null;
  }
}

function classifySafeComparison(
  expr: Extract<WhereExpr, { type: "BINARY" }>,
  options: SafePushdownOptions
): SupportedLeafRelation {
  if (isKlikeComparison(expr, options)) return "exact";
  if (isSafeIdComparison(expr, options)) return "exact";
  if (expr.left.type !== "FIELD" || !isTargetField(expr.left, options)) return "unsafe";
  const fieldType = options.fieldTypes?.get(expr.left.field);
  if (fieldType === undefined || fieldType.startsWith("KSQL_")) return "unsafe";
  const capability = classifyWhereCapability(expr, (field) => {
    if (!isTargetField(field, options)) return undefined;
    const type = options.fieldTypes?.get(field.field);
    return type === undefined ? undefined : resolveFieldSemantics({ fieldType: type });
  });
  if (capability.capability !== "EXACT_PUSHDOWN") return "unsafe";
  return classifySupportedLeaf(expr, {
    fieldCode: expr.left.field,
    fieldType,
    fieldOptions: options.fieldOptions?.get(expr.left.field),
  });
}

function isKlikeComparison(
  expr: Extract<WhereExpr, { type: "BINARY" }>,
  options: SafePushdownOptions
): boolean {
  if (options.allowKlike === false) return false;
  if (expr.op !== "KLIKE" && expr.op !== "NOT_KLIKE") return false;
  if (expr.left.type !== "FIELD" || !isTargetField(expr.left, options)) return false;
  return expr.right.type === "STRING"
    || (options.allowUnresolvedKlikeVariables === true && expr.right.type === "VARIABLE");
}

function isSafeIdComparison(
  expr: Extract<WhereExpr, { type: "BINARY" }>,
  options: SafePushdownOptions
): boolean {
  if (!isTargetIdField(expr.left, options)) return false;
  if (expr.right.type !== "NUMBER") return false;
  return expr.op === "="
    || expr.op === ">"
    || expr.op === "<"
    || expr.op === ">="
    || expr.op === "<=";
}

function isTargetIdField(
  field: FieldValue,
  options: SafePushdownOptions
): boolean {
  if (field.type !== "FIELD" || field.field !== "$id") return false;

  const targetAlias = options.tableAlias ?? null;
  if (field.tableAlias === targetAlias) return true;
  return options.allowUnqualifiedFields === true && field.tableAlias === null;
}

function isNumericCandidate(
  expr: Extract<WhereExpr, { type: "BINARY" }>,
  options: PushdownCandidateOptions
): expr is typeof expr & { left: Extract<FieldValue, { type: "FIELD" }> } {
  if (expr.left.type !== "FIELD" || expr.left.field === "$id") return false;
  if (!isTargetField(expr.left, options)) return false;
  if (expr.right.type !== "NUMBER") return false;
  if (expr.op === "=") return true;
  return (expr.op === "<" || expr.op === ">")
    && /^[+-]?\d+$/.test(numberLiteralText(expr.right))
    && Number.isSafeInteger(expr.right.value);
}

function isTargetField(
  field: Extract<FieldValue, { type: "FIELD" }>,
  options: PushdownCandidateOptions
): boolean {
  const targetAlias = options.tableAlias ?? null;
  if (field.tableAlias === targetAlias) return true;
  return options.allowUnqualifiedFields === true && field.tableAlias === null;
}
