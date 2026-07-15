import type { WhereExpr, FieldValue } from "../../types/ast";

export interface SafePushdownOptions {
  /** JOIN 時に抽出対象とするテーブルエイリアス。 */
  tableAlias?: string;
  /**
   * 単一テーブルでは、正しいエイリアス付き参照に加えて非修飾参照も安全に扱える。
   * JOIN 時は false のままにし、対象エイリアスの明示参照だけを許可する。
   */
  allowUnqualifiedFields?: boolean;
  /** 将来の型別ホワイトリスト用。第0段では参照しない。 */
  fieldTypes?: ReadonlyMap<string, string>;
}

/**
 * WHERE から kintone へ安全に押し下げられる AND リーフだけを抽出する。
 *
 * 第0段では、必ず存在して型も静的に確定する `$id` の肯定数値比較だけを許可する。
 * GROUP は透過するが、OR / NOT / NULL 判定 / EXISTS はサブツリーごと除外する。
 */
export function extractSafePushdownLeaves(
  where: WhereExpr,
  options: SafePushdownOptions = {}
): WhereExpr | null {
  switch (where.type) {
    case "BINARY":
      return isSafeIdComparison(where, options) ? where : null;

    case "LOGICAL":
      if (where.op !== "AND") return null;
      {
        const left = extractSafePushdownLeaves(where.left, options);
        const right = extractSafePushdownLeaves(where.right, options);
        if (left && right) return { ...where, left, right };
        return left ?? right ?? null;
      }

    case "GROUP":
      return extractSafePushdownLeaves(where.expr, options);

    case "NULL_CHECK":
    case "NOT":
    case "EXISTS":
      return null;
  }
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
