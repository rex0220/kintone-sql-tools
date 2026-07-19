import { resolveSelectMode } from "../converter/selectToKintone";
import { isKlike, whereHasKlike } from "./like";
import { buildInlinedQuery, canInlineSingleCte } from "./cteInlining";
import { buildKlikePushdownPlan, unappliedKlikes, type KlikePushdownPlan } from "./optimization/klikePushdownPlan";
import type {
  SelectStatement,
  Statement,
  UnionStatement,
  WhereExpr,
  WithStatement,
} from "../types/ast";

/** KLIKE の AST 後・実行前制約違反。 */
export class KlikeValidationError extends Error {
  constructor(message: string) {
    super(`ArgumentError: ${message}`);
    // バッチ/MCP の既存エラーコード規約に合わせ、外部コードは ArgumentError に統一する。
    this.name = "ArgumentError";
  }
}

/**
 * KLIKE の共通静的検証。
 *
 * - KLIKE は WHERE だけで使用可能。FULL_SCAN では共有計画に入る AND リーフに限定
 * - 右辺は文字列または未解決のバッチ変数だけ
 * - kintone が検索語から除外する % は拒否
 * - DML はネストした SELECT を含めて全面拒否
 */
export function validateKlikeStatement(stmt: Statement): void {
  validateStatement(stmt);
}

/** 実行時に生成した共有計画が全 KLIKE を包含することを最終確認する。 */
export function validateKlikePushdownPlan(plan: KlikePushdownPlan): void {
  if (unappliedKlikes(plan).length > 0) {
    throw new KlikeValidationError(
      "FULL_SCAN の KLIKE / NOT KLIKE を安全に押し下げられません。OR / NOT 配下、CTE・一時テーブル、LEFT / RIGHT JOIN を確認してください"
    );
  }
}

function validateStatement(stmt: Statement): void {
  switch (stmt.type) {
    case "SELECT":
      validateSelect(stmt);
      return;
    case "UNION":
      validateUnion(stmt);
      return;
    case "WITH":
      validateWith(stmt);
      return;
    case "EXPLAIN":
      validateStatement(stmt.query);
      return;
    case "CREATE_TEMP_TABLE":
      validateSelectLike(stmt.query);
      return;
    case "SET_VARIABLE":
    case "DECLARE_VARIABLE":
    case "ASSERT":
      validateNestedSelects(stmt);
      return;
    case "INSERT":
    case "INSERT_SELECT":
    case "UPSERT":
    case "UPSERT_SELECT":
    case "UPDATE":
    case "DELETE":
    case "REORDER":
      if (containsKlike(stmt)) {
        throw new KlikeValidationError(
          "KLIKE / NOT KLIKE は全 DML（UPDATE / DELETE / INSERT / UPSERT / REORDER）で使用できません"
        );
      }
      return;
    case "VALIDATE":
      if (containsKlike(stmt)) {
        throw new KlikeValidationError("KLIKE / NOT KLIKE は VALIDATE の WHERE / CHECK で使用できません");
      }
      return;
    case "SHOW_APPS":
    case "DESCRIBE":
    case "DROP_TEMP_TABLE":
      return;
  }
}

function validateSelectLike(query: SelectStatement | UnionStatement | WithStatement): void {
  if (query.type === "SELECT") validateSelect(query);
  else if (query.type === "UNION") validateUnion(query);
  else validateWith(query);
}

function validateUnion(stmt: UnionStatement): void {
  validateSelectLike(stmt.left);
  validateSelect(stmt.right);
}

function validateWith(stmt: WithStatement): void {
  if (canInlineSingleCte(stmt)) {
    // 実行時と同じ共通変換後の AST を検証する。
    validateSelect(buildInlinedQuery(stmt));
    return;
  }

  for (const cte of stmt.ctes) {
    if (cte.query.type === "SELECT") validateSelect(cte.query);
    else if (cte.query.type === "UNION") validateUnion(cte.query);
  }
  validateSelectLike(stmt.query);
}

function validateSelect(stmt: SelectStatement): void {
  validateOwnKlikeExpressions(stmt);

  if (whereHasKlike(stmt.where)) {
    const directKintoneSimple = resolveSelectMode(stmt) === "SIMPLE"
      && stmt.from.cteName === null
      && stmt.joins.every((join) => join.table.cteName === null);
    if (!directKintoneSimple) {
      const plan = buildKlikePushdownPlan(stmt, { allowUnresolvedVariables: true });
      if (unappliedKlikes(plan).length === 0) {
        validateNestedSelects(stmt);
        return;
      }
      throw new KlikeValidationError(
        "FULL_SCAN の KLIKE / NOT KLIKE は、物理テーブルに対する AND リーフとして必ず押し下げられる必要があります。OR / NOT 配下、CTE・一時テーブル、LEFT / RIGHT JOIN では使用できません"
      );
    }
  }

  validateNestedSelects(stmt);
}

/** 現在の SELECT スコープに属する KLIKE を検証する（内側 SELECT は別途検証）。 */
function validateOwnKlikeExpressions(stmt: SelectStatement): void {
  walkWithoutNestedSelects(stmt, (where) => {
    if (!isKlike(where)) return;
    if (!isDescendantOf(stmt.where, where)) {
      throw new KlikeValidationError("KLIKE / NOT KLIKE は SELECT の WHERE 句でのみ使用できます");
    }
    const right = where.right;
    if (right.type !== "STRING" && right.type !== "VARIABLE") {
      throw new KlikeValidationError(
        "KLIKE / NOT KLIKE の右辺には文字列リテラルまたは文字列バッチ変数が必要です"
      );
    }
    if (right.type === "STRING" && right.value.includes("%")) {
      throw new KlikeValidationError(
        "KLIKE / NOT KLIKE の検索語に % は使用できません。SQL ワイルドカード検索には LIKE を使用してください"
      );
    }
  });
}

function validateNestedSelects(node: unknown): void {
  walkObjects(node, (obj) => {
    if (obj.type === "SELECT") validateSelect(obj as unknown as SelectStatement);
  }, true);
}

function containsKlike(node: unknown): boolean {
  let found = false;
  walkObjects(node, (obj) => {
    if (obj.type === "BINARY" && (obj.op === "KLIKE" || obj.op === "NOT_KLIKE")) found = true;
  });
  return found;
}

function isDescendantOf(root: WhereExpr | null, target: object): boolean {
  if (root === null) return false;
  if (root === target) return true;
  switch (root.type) {
    case "LOGICAL": return isDescendantOf(root.left, target) || isDescendantOf(root.right, target);
    case "NOT":
    case "GROUP": return isDescendantOf(root.expr, target);
    case "BINARY":
    case "NULL_CHECK":
    case "EXISTS": return false;
    case "BOOLEAN": return false;
  }
}

function walkWithoutNestedSelects(
  node: unknown,
  visitWhere: (where: WhereExpr) => void
): void {
  if (Array.isArray(node)) {
    for (const value of node) walkWithoutNestedSelects(value, visitWhere);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (
    obj.type === "BINARY" || obj.type === "NULL_CHECK" || obj.type === "LOGICAL"
    || obj.type === "NOT" || obj.type === "GROUP" || obj.type === "EXISTS"
  ) {
    visitWhere(obj as unknown as WhereExpr);
  }
  for (const value of Object.values(obj)) {
    if (value !== node && isSelectObject(value)) continue;
    walkWithoutNestedSelects(value, visitWhere);
  }
}

function walkObjects(
  node: unknown,
  visit: (obj: Record<string, unknown>) => void,
  skipRoot = false
): void {
  if (Array.isArray(node)) {
    for (const value of node) walkObjects(value, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (!skipRoot) visit(obj);
  for (const value of Object.values(obj)) walkObjects(value, visit);
}

function isSelectObject(value: unknown): boolean {
  return value !== null && typeof value === "object"
    && (value as { type?: unknown }).type === "SELECT";
}
