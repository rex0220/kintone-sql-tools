import type { WhereExpr, FieldValue } from "../../types/ast";

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
}

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
  return extractAndLeaves(where, (expr) => isSafeComparison(expr, options));
}

/**
 * EXPLAIN と実行前の型メタ取得判定に使う、一般数値フィールドの構文上の候補抽出。
 * 型は未確定なので `$id` を除外し、実際の kintone query には直接使わない。
 */
export function extractNumericPushdownCandidates(
  where: WhereExpr,
  options: Omit<SafePushdownOptions, "fieldTypes"> = {}
): WhereExpr | null {
  return extractAndLeaves(where, (expr) => isNumericCandidate(expr, options));
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
      return null;
  }
}

function isSafeComparison(
  expr: Extract<WhereExpr, { type: "BINARY" }>,
  options: SafePushdownOptions
): boolean {
  if (isSafeIdComparison(expr, options)) return true;
  if (!isNumericCandidate(expr, options)) return false;
  return options.fieldTypes?.get(expr.left.field) === "NUMBER";
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
  options: Omit<SafePushdownOptions, "fieldTypes">
): expr is typeof expr & { left: Extract<FieldValue, { type: "FIELD" }> } {
  if (expr.left.type !== "FIELD" || expr.left.field === "$id") return false;
  if (!isTargetField(expr.left, options)) return false;
  if (expr.right.type !== "NUMBER") return false;
  if (expr.op === "=") return true;
  return (expr.op === "<" || expr.op === ">")
    && Number.isSafeInteger(expr.right.value);
}

function isTargetField(
  field: Extract<FieldValue, { type: "FIELD" }>,
  options: Omit<SafePushdownOptions, "fieldTypes">
): boolean {
  const targetAlias = options.tableAlias ?? null;
  if (field.tableAlias === targetAlias) return true;
  return options.allowUnqualifiedFields === true && field.tableAlias === null;
}
