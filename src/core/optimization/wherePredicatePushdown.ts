import type { WhereExpr, FieldValue, SqlValue } from "../../types/ast";

/**
 * WHERE 式から指定テーブルエイリアスの push down 可能な条件を抽出する。
 *
 * AND ノードは分解して各テーブルに振り分ける。
 * OR / NOT / GROUP は全体が同一テーブルのみを参照する場合のみ push down。
 * クロステーブル・関数付き・EXISTS は null を返す。
 */
export function extractTableCondition(
  where: WhereExpr,
  tableAlias: string
): WhereExpr | null {
  switch (where.type) {
    case "BINARY":
      if (!isSingleTableField(where.left, tableAlias)) return null;
      if (!isPushDownableRight(where.right)) return null;
      return where;

    case "NULL_CHECK":
      if (!isSingleTableField(where.field, tableAlias)) return null;
      return where;

    case "LOGICAL":
      if (where.op === "AND") {
        const left  = extractTableCondition(where.left,  tableAlias);
        const right = extractTableCondition(where.right, tableAlias);
        if (left && right) return { ...where, left, right };
        return left ?? right ?? null;
      }
      // OR: 全体が同一テーブルのみ参照する場合のみ push down
      return referencesOnlyTable(where, tableAlias) ? where : null;

    case "NOT":
    case "GROUP":
      return referencesOnlyTable(where, tableAlias) ? where : null;

    case "EXISTS":
      return null;
  }
}

/** フィールド参照が指定テーブルエイリアスのみを参照する FieldRef かどうか */
function isSingleTableField(field: FieldValue, tableAlias: string): boolean {
  // FUNC_FIELD / ARITH_FIELD / CASE_FIELD は kintone API 変換不可
  if (field.type !== "FIELD") return false;
  return field.tableAlias === tableAlias;
}

/** WHERE 右辺が kintone API に渡せるリテラル値かどうか */
function isPushDownableRight(value: SqlValue): boolean {
  switch (value.type) {
    case "STRING":
    case "NUMBER":
    case "KINTONE_FUNC":
    case "IN_LIST":
      return true;
    default:
      return false;
  }
}

/** 式全体が指定テーブルエイリアスのみを参照するかどうか */
function referencesOnlyTable(expr: WhereExpr, tableAlias: string): boolean {
  switch (expr.type) {
    case "BINARY":
      return isSingleTableField(expr.left, tableAlias) && isPushDownableRight(expr.right);
    case "NULL_CHECK":
      return isSingleTableField(expr.field, tableAlias);
    case "LOGICAL":
      return referencesOnlyTable(expr.left, tableAlias) && referencesOnlyTable(expr.right, tableAlias);
    case "NOT":
    case "GROUP":
      return referencesOnlyTable(expr.expr, tableAlias);
    case "EXISTS":
      return false;
  }
}
