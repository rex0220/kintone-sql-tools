// ============================================================
// SelectStatement AST → kintone GET /k/v1/records パラメータ変換
//
// 「単純 SELECT」（JOIN / GROUP BY なし）の場合のみ kintone クエリに変換できる。
// JOIN / GROUP BY がある場合は全件取得して JS 側で処理するため、
// この関数は呼び出さず fetchAll() を使う。
// ============================================================

import type {
  SelectStatement,
  SelectColumn,
  OrderByItem,
  LegacyArithExpr,
  ArithNode,
  StringFuncExpr,
  StringFuncArg,
  WhereExpr,
  FieldValue,
  AggOperand,
  GroupByKey,
  OrderByKey,
  SqlValue,
  CaseWhenExpr,
  CaseResult,
  TableRef,
  AggregateFunc,
  ScalarValueExpr,
  AggregateArgExpr,
} from "../types/ast";
import { numberLiteralText } from "../types/ast";
import { whereToKintone } from "./whereToKintone";
import { isLike } from "../core/like";
import { aggregateSyntheticName } from "../core/aggregateExpression";
import { normalizeGroupingSpec } from "../core/grouping";
import { containsAggregate } from "../core/groupingValidation";
import type {
  PlainGroupByResolution,
  PlainGroupByResolutionPlan,
} from "../core/optimization/plainGroupByPlan";

// ------------------------------------------------------------
// kintone GET パラメータ
// ------------------------------------------------------------

export interface KintoneGetParams {
  app: number;
  query: string;         // kintone クエリ文字列
  fields: string[];      // 取得フィールド一覧（空 = 全フィールド）
  totalCount: boolean;
}

// ------------------------------------------------------------
// 変換モード判定
// ------------------------------------------------------------

export type SelectMode =
  | "SIMPLE"     // kintone クエリに直接変換（API 側でソート・件数制限）
  | "FULL_SCAN"; // 全件取得 → JS 側で GROUP BY / JOIN / DISTINCT 処理

export function hasWindowColumns(columns: SelectColumn[]): boolean {
  return columns.some((column) => column.type === "WINDOW_COL");
}

/**
 * SELECT 文が SIMPLE モードか FULL_SCAN モードかを判定する。
 *
 * FULL_SCAN になる条件:
 *   - JOIN が 1 件以上ある
 *   - GROUP BY がある
 *   - DISTINCT がある
 *   - 集計関数（COUNT / SUM 等）が SELECT 句にある
 *   - WHERE 句に関数（UPPER / LENGTH 等）が含まれる
 *     → kintone API は関数を評価できないため全件取得して JS でフィルタ
 */
export function resolveSelectMode(stmt: SelectStatement): SelectMode {
  if (stmt.from.subtableCode) return "FULL_SCAN";
  if (stmt.joins.some((j) => j.table.subtableCode)) return "FULL_SCAN";
  if (stmt.joins.length > 0) return "FULL_SCAN";
  if (normalizeGroupingSpec(stmt).type !== "NONE") return "FULL_SCAN";
  if (stmt.distinct) return "FULL_SCAN";
  if (hasWindowColumns(stmt.columns)) return "FULL_SCAN";
  if (stmt.columns.some((c) =>
    c.type === "AGGREGATE" ||
    c.type === "ARITH_AGG_COL" ||
    c.type === "SCALAR_SUBQUERY_COL" ||
    (c.type === "CASE_COL" && containsAggregate(c.expr)) ||
    (c.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(c.expr)) ||
    (c.type === "SCALAR_VALUE_COL" && scalarValueHasAggregate(c.expr))
  )) return "FULL_SCAN";
  if (whereRequiresJsEval(stmt.where)) return "FULL_SCAN";
  if (stmt.orderBy.some((o) => o.key.type !== "FIELD_NAME")) return "FULL_SCAN";
  return "SIMPLE";
}

/**
 * WHERE 式に、kintone へ安全に押し下げられず JS 評価が必要な要素があるかを判定する。
 * 左辺の関数・算術式、右辺式・サブクエリ、LIKE / NOT LIKE などを再帰的に検出する。
 */
export function whereRequiresJsEval(where: WhereExpr | null): boolean {
  if (where === null) return false;
  switch (where.type) {
    case "BOOLEAN":   return true;
    case "BINARY":
      return isFunc(where.left) || where.right.type === "ARITH_VALUE" || where.right.type === "CASE_VALUE" || where.right.type === "SUBQUERY_IN_LIST" || where.right.type === "SCALAR_SUBQUERY" || isLike(where);
    case "NULL_CHECK": return isFunc(where.field);
    case "LOGICAL":   return whereRequiresJsEval(where.left) || whereRequiresJsEval(where.right);
    case "NOT":
    case "GROUP":     return whereRequiresJsEval(where.expr);
    case "EXISTS":    return true; // 常に FULL_SCAN
  }
}

/** kintone クエリに変換できない左辺（関数・算術式・CASE WHEN）かどうか */
function isFunc(fv: FieldValue): boolean {
  return fv.type === "FUNC_FIELD" || fv.type === "ARITH_FIELD" || fv.type === "CASE_FIELD";
}

// ------------------------------------------------------------
// SIMPLE モード: kintone GET パラメータへ変換
// ------------------------------------------------------------

/**
 * SIMPLE モードの SELECT 文を kintone GET パラメータに変換する。
 * FULL_SCAN の場合は呼び出し元でエラー・または fetchAll() に切り替えること。
 */
export function selectToKintoneParams(stmt: SelectStatement): KintoneGetParams {
  const queryParts: string[] = [];
  const hasPagination = stmt.limit !== null || stmt.offset !== null;
  const shouldInjectDefaultOrder = hasPagination && stmt.orderBy.length === 0;

  // WHERE
  if (stmt.where !== null) {
    queryParts.push(whereToKintone(stmt.where));
  }

  // ORDER BY
  if (stmt.orderBy.length > 0) {
    const orderStr = stmt.orderBy.map(convertOrderBy).join(", ");
    queryParts.push(`order by ${orderStr}`);
  } else if (shouldInjectDefaultOrder) {
    // kintone query は limit/offset 単独だと CB_IL02 になる環境があるため
    // 安定動作のために既定の並び順を補完する。
    queryParts.push("order by $id asc");
  }

  // LIMIT / OFFSET
  if (stmt.limit !== null) {
    queryParts.push(`limit ${stmt.limit}`);
  }
  if (stmt.offset !== null) {
    queryParts.push(`offset ${stmt.offset}`);
  }

  return {
    app: stmt.from.appId,
    query: queryParts.join(" "),
    fields: extractFields(stmt.columns),
    totalCount: false,
  };
}

// ------------------------------------------------------------
// FULL_SCAN モード: 全件取得用の最小パラメータ
// ------------------------------------------------------------

/**
 * FULL_SCAN 用: WHERE だけを kintone クエリに変換し全件取得する。
 * ORDER BY / LIMIT は JS 側で処理するため含めない。
 * ページング（limit 500 offset N）は呼び出し元の fetchAll() が付与する。
 */
export function selectToFetchAllParams(
  stmt: SelectStatement,
  appId: number
): Omit<KintoneGetParams, "totalCount"> {
  const queryParts: string[] = [];

  // WHERE に関数が含まれる場合は kintone クエリに変換できない
  // → 全件取得して JS 側でフィルタ（applyFilter が FULL_SCAN パイプラインで実行される）
  // JOIN ありでは複数テーブル条件を単一アプリへ安全に押し込めないため、
  // API 側 WHERE 変換は行わず JS 側フィルタに一任する。
  if (stmt.where !== null && stmt.joins.length === 0 && !whereRequiresJsEval(stmt.where)) {
    queryParts.push(whereToKintone(stmt.where));
  }

  return {
    app: appId,
    query: queryParts.join(" "),
    fields: [],  // 全件取得なので全フィールドを取得する
  };
}

/**
 * FULL_SCAN 時に、対象テーブルで必要な取得フィールドを返す。
 * 返り値が空配列の場合は「全フィールド取得」を意味する。
 */
export function selectToFetchAllFields(
  stmt: SelectStatement,
  targetTable: TableRef,
  plainGroupByPlan?: PlainGroupByResolutionPlan
): string[] {
  const plan = collectRequiredFieldsByTable(stmt, plainGroupByPlan);
  const target = plan.get(targetTable);
  if (!target) return [];
  if (target.allFields) return [];

  const fields = new Set(target.fields);
  if (target.table.subtableCode) {
    // サブテーブル仮想テーブルは親レコード取得時にサブテーブル本体が必須
    fields.add(target.table.subtableCode);
  }
  // 1件も不要列がない場合でも、全フィールド取得にフォールバックしないよう $id を最小取得
  if (fields.size === 0) fields.add("$id");
  return [...fields];
}

// ------------------------------------------------------------
// ヘルパー
// ------------------------------------------------------------

/**
 * ORDER BY アイテムを kintone クエリ形式に変換。
 * FIELD_NAME のみ変換可（ARITH_KEY / FUNC_KEY は FULL_SCAN で JS ソートするため呼ばれない）。
 */
function convertOrderBy(item: OrderByItem): string {
  const dir = item.direction === "ASC" ? "asc" : "desc";
  if (item.key.type !== "FIELD_NAME") {
    throw new Error("ORDER BY 式は kintone クエリに変換できません（FULL_SCAN が必要です）");
  }
  return `${item.key.name} ${dir}`;
}

/**
 * SELECT 句から取得フィールド一覧を抽出する。
 * SELECT * や集計関数の場合は空配列（kintone = 全フィールド取得）。
 */
function extractFields(columns: SelectColumn[]): string[] {
  // * / 集計関数 / CASE WHEN が含まれる場合は全フィールド取得
  const hasWildcard = columns.some(
    (c) => c.type === "WILDCARD" || c.type === "AGGREGATE" || c.type === "ARITH_AGG_COL" || c.type === "CASE_COL" || c.type === "SCALAR_SUBQUERY_COL"
  );
  if (hasWildcard) return [];

  const fields: string[] = [];
  for (const col of columns) {
    if (col.type === "FIELD") {
      fields.push(normalizeSimpleFieldRef(col.field));
    } else if (col.type === "ARITH_COL") {
      collectArithNode(col.expr, fields);
    } else if (col.type === "STRFUNC_COL") {
      collectStringFuncFields(col.expr, fields);
    } else if (col.type === "SCALAR_VALUE_COL") {
      collectScalarValueFields(col.expr, fields);
    }
  }
  return [...new Set(fields)];
}

function collectArithFields(expr: LegacyArithExpr, out: string[]): void {
  collectArithNode(expr.left, out);
  collectArithNode(expr.right, out);
}

function collectArithNode(node: ArithNode, out: string[]): void {
  if (node.type === "VARIABLE") throw new Error(
    `InternalError: unresolved arithmetic variable @${node.name} reached SELECT field collection.`
  );
  if (node.type === "FIELD_REF")        out.push(normalizeSimpleFieldRef(node.field));
  else if (node.type === "ARITH")       collectArithFields(node, out);
  else if (node.type === "STRING_FUNC") collectStringFuncFields(node, out);
}

/**
 * SIMPLE モードでは単一テーブル参照のみのため、修飾付きフィールド参照
 * (例: "a.金額" / "APP100.金額") は kintone フィールドコード ("金額") に正規化する。
 */
function normalizeSimpleFieldRef(field: string): string {
  const dot = field.indexOf(".");
  if (dot <= 0) return field;
  const unqualified = field.slice(dot + 1);
  return unqualified || field;
}

function collectStringFuncFields(expr: StringFuncExpr, out: string[]): void {
  for (const arg of expr.args) {
    collectStringFuncArgFields(arg, out);
  }
}

function collectStringFuncArgFields(arg: StringFuncArg, out: string[]): void {
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH" || arg.type === "AGG_GROUP_KEY" || arg.type === "VARIABLE") { collectAggOperandFields(arg, out); return; }
  collectScalarValueFields(arg, out);
}

function collectScalarValueFields(expr: ScalarValueExpr, out: string[]): void {
  if (expr.type === "FIELD") { out.push(normalizeSimpleFieldRef(expr.tableAlias ? `${expr.tableAlias}.${expr.field}` : expr.field)); return; }
  if (expr.type === "STRING_FUNC") { collectStringFuncFields(expr, out); return; }
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    collectScalarValueFields(expr.left, out);
    collectScalarValueFields(expr.right, out);
    return;
  }
  if (expr.type === "CASE_WHEN") {
    for (const branch of expr.branches) collectCaseResultScalarFields(branch.result, out);
    if (expr.elseResult) collectCaseResultScalarFields(expr.elseResult, out);
  }
}

function collectCaseResultScalarFields(result: CaseResult, out: string[]): void {
  if (result.type === "ARRAY") return;
  if (result.type === "AGG_REF" || result.type === "AGG_ARITH") { collectAggOperandFields(result, out); return; }
  if (result.type === "FIELD_REF" || result.type === "ARITH") { collectArithNode(result, out); return; }
  collectScalarValueFields(result, out);
}

function collectAggOperandFields(node: AggOperand, out: string[]): void {
  if (node.type === "AGG_REF") {
    if (node.arg.type !== "WILDCARD") collectAggregateArgFields(node.arg, out);
    return;
  }
  if (node.type === "AGG_ARITH") {
    collectAggOperandFields(node.left, out);
    collectAggOperandFields(node.right, out);
  }
  if (node.type === "AGG_GROUP_KEY") {
    out.push(normalizeSimpleFieldRef(node.tableAlias ? `${node.tableAlias}.${node.field}` : node.field));
  }
}

function collectAggregateArgFields(node: AggregateArgExpr, out: string[]): void {
  if (node.type === "FIELD_REF" || node.type === "ARITH") collectArithNode(node, out);
  else collectScalarValueFields(node, out);
}

function hasAggregateInStringFuncExpr(expr: StringFuncExpr): boolean {
  return expr.args.some((arg) => {
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
    if (arg.type === "AGG_GROUP_KEY" || arg.type === "VARIABLE") return false;
    return scalarValueHasAggregate(arg);
  });
}

function scalarValueHasAggregate(expr: ScalarValueExpr): boolean {
  if (expr.type === "STRING_FUNC") return hasAggregateInStringFuncExpr(expr);
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    return scalarValueHasAggregate(expr.left) || scalarValueHasAggregate(expr.right);
  }
  if (expr.type === "CASE_WHEN") {
    return expr.branches.some((b) => caseResultHasAggregate(b.result))
      || (expr.elseResult !== null && caseResultHasAggregate(expr.elseResult));
  }
  return false;
}

function caseResultHasAggregate(result: CaseResult): boolean {
  if (result.type === "AGG_REF" || result.type === "AGG_ARITH") return true;
  if (result.type === "ARRAY" || result.type === "FIELD_REF" || result.type === "ARITH") return false;
  return scalarValueHasAggregate(result);
}

interface RequiredFieldState {
  table: TableRef;
  allFields: boolean;
  fields: Set<string>;
}

export interface SelectFieldReferencePlan {
  readonly bySource: ReadonlyMap<TableRef, ReadonlySet<string>>;
  readonly unqualified: ReadonlySet<string>;
}

/** B86: SELECT が参照する列を、物理／実体化を区別せず source ごとに収集する。 */
export function collectSelectFieldReferencesBySource(
  stmt: SelectStatement,
  plainGroupByPlan?: PlainGroupByResolutionPlan
): SelectFieldReferencePlan {
  const unqualified = new Set<string>();
  const states = collectRequiredFieldsByTable(stmt, plainGroupByPlan, {
    includeMaterialized: true,
    unqualified,
  });
  return {
    bySource: new Map(
      [...states.entries()].map(([table, state]) => [table, new Set(state.fields)])
    ),
    unqualified,
  };
}

function collectRequiredFieldsByTable(
  stmt: SelectStatement,
  plainGroupByPlan?: PlainGroupByResolutionPlan,
  sourceAware?: {
    readonly includeMaterialized: true;
    readonly unqualified: Set<string>;
  }
): Map<TableRef, RequiredFieldState> {
  const allTables = [stmt.from, ...stmt.joins.map((j) => j.table)];
  const physicalTables = [stmt.from, ...stmt.joins.map((j) => j.table)]
    .filter((t) => t.cteName === null);
  const targetTables = sourceAware ? allTables : physicalTables;
  const states = new Map<TableRef, RequiredFieldState>();
  for (const table of targetTables) {
    states.set(table, { table, allFields: false, fields: new Set<string>() });
  }
  if (states.size === 0) return states;

  const firstTargetTable = targetTables[0] ?? null;
  const subtableTable = targetTables.find((t) => !!t.subtableCode) ?? null;
  const aliasToTable = new Map<string, TableRef>();
  for (const table of targetTables) {
    if (table.alias) aliasToTable.set(table.alias, table);
    if (table.cteName !== null) {
      aliasToTable.set(table.cteName, table);
    } else if (!table.subtableCode) {
      aliasToTable.set(`APP${table.appId}`, table);
      aliasToTable.set(`app${table.appId}`, table);
    }
  }

  const selectAliases = collectSelectOutputNames(stmt.columns);

  const markAll = (table: TableRef) => {
    const st = states.get(table);
    if (!st) return;
    st.allFields = true;
    st.fields.clear();
  };
  const markAllTargetTables = () => {
    for (const t of targetTables) markAll(t);
  };
  const markAllSubtableTables = () => {
    for (const t of targetTables) {
      if (t.subtableCode) markAll(t);
    }
  };

  const addFieldToTable = (table: TableRef, fieldName: string) => {
    const st = states.get(table);
    if (!st || st.allFields) return;

    if (table.subtableCode) {
      // _p.xxx は親フィールド参照。親取得時は xxx を fields 指定すればよい。
      if (fieldName.startsWith("_p.")) {
        const parentField = fieldName.slice(3);
        if (parentField && parentField !== "*") st.fields.add(parentField);
        return;
      }
      // サブテーブル行の列は subtableCode 本体から展開できるため個別取得は不要
      if (fieldName === "_pid" || fieldName === "_rid" || fieldName === "_idx" || fieldName === "$id") {
        return;
      }
      return;
    }

    if (!fieldName) return;
    st.fields.add(fieldName);
  };

  const addFieldName = (
    rawName: string,
    phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select",
    groupResolution?: PlainGroupByResolution
  ) => {
    if (!rawName || rawName === "*") return;

    if (rawName === "_p.*") {
      markAllSubtableTables();
      return;
    }
    if (rawName.endsWith(".*")) {
      const qualifier = rawName.slice(0, -2);
      if (!qualifier) {
        markAllTargetTables();
        return;
      }
      if (qualifier === "_p") {
        markAllSubtableTables();
        return;
      }
      const target = aliasToTable.get(qualifier);
      if (target) {
        markAll(target);
        return;
      }
      return;
    }

    // B71: plan 済み plain GROUP BY は schema 解決結果を唯一の取得列根拠にする。
    // PHYSICAL だけを確定 source に追加し、alias は従来どおり取得対象にしない。
    if (phase === "groupBy" && groupResolution !== undefined) {
      if (groupResolution.kind === "PHYSICAL") {
        const source = allTables[groupResolution.sourceIndex];
        if (source && (sourceAware || source.cteName === null)) {
          addFieldToTable(source, groupResolution.fieldCode);
        }
      }
      return;
    }

    // ORDER BY / HAVING の FIELD_NAME は列 alias / 集計合成名を指せるため除外
    if ((phase === "orderBy" || phase === "having" || phase === "groupBy") && selectAliases.has(rawName)) {
      return;
    }
    if ((phase === "orderBy" || phase === "having" || phase === "groupBy") && isAggregateSyntheticName(rawName)) {
      return;
    }

    const dot = rawName.indexOf(".");
    if (dot > 0) {
      const qualifier = rawName.slice(0, dot);
      const field = rawName.slice(dot + 1);
      if (qualifier === "_p") {
        if (subtableTable) addFieldToTable(subtableTable, `_p.${field}`);
        return;
      }
      const target = aliasToTable.get(qualifier);
      if (target) {
        addFieldToTable(target, field);
        return;
      }
      if (sourceAware) return;
    }

    if (sourceAware) {
      sourceAware.unqualified.add(rawName);
    } else if (firstTargetTable) {
      addFieldToTable(firstTargetTable, rawName);
    }
  };

  const addFieldRef = (
    field: string,
    tableAlias: string | null,
    phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"
  ) => {
    if (tableAlias) {
      if (tableAlias === "_p") {
        if (subtableTable) addFieldToTable(subtableTable, `_p.${field}`);
        return;
      }
      const target = aliasToTable.get(tableAlias);
      if (target) {
        addFieldToTable(target, field);
        return;
      }
      if (sourceAware) return;
    }
    addFieldName(field, phase);
  };

  const walkArith = (node: ArithNode, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    if (node.type === "VARIABLE") {
      throw new Error(
        `InternalError: unresolved arithmetic variable @${node.name} reached source-aware field collection.`
      );
    }
    if (node.type === "FIELD_REF") {
      addFieldName(node.field, phase);
      return;
    }
    if (node.type === "ARITH") {
      walkArith(node.left, phase);
      walkArith(node.right, phase);
      return;
    }
    if (node.type === "STRING_FUNC") {
      walkStringFunc(node, phase);
      return;
    }
  };

  const walkAgg = (node: AggOperand, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    if (node.type === "AGG_REF") {
      if (node.arg.type !== "WILDCARD") walkAggregateArg(node.arg, phase);
      return;
    }
    if (node.type === "AGG_ARITH") {
      walkAgg(node.left, phase);
      walkAgg(node.right, phase);
    }
    if (node.type === "AGG_GROUP_KEY") {
      addFieldRef(node.field, node.tableAlias ?? null, phase);
    }
  };

  const walkStringArg = (arg: StringFuncArg, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH" || arg.type === "AGG_GROUP_KEY" || arg.type === "VARIABLE") {
      walkAgg(arg, phase);
      return;
    }
    walkScalar(arg, phase);
  };

  const walkStringFunc = (expr: StringFuncExpr, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    for (const arg of expr.args) walkStringArg(arg, phase);
  };

  const walkScalar = (expr: ScalarValueExpr, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    if (expr.type === "FIELD") {
      addFieldRef(expr.field, expr.tableAlias, phase);
      return;
    }
    if (expr.type === "STRING_FUNC") { walkStringFunc(expr, phase); return; }
    if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
      walkScalar(expr.left, phase);
      walkScalar(expr.right, phase);
      return;
    }
    if (expr.type === "CASE_WHEN") walkCase(expr, phase);
  };

  const walkAggregateArg = (
    expr: AggregateArgExpr,
    phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"
  ): void => {
    if (expr.type === "FIELD_REF" || expr.type === "ARITH") {
      walkArith(expr, phase);
      return;
    }
    walkScalar(expr, phase);
  };

  const walkCaseResult = (result: CaseResult, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    if (result.type === "ARRAY") return;
    if (result.type === "AGG_REF" || result.type === "AGG_ARITH") { walkAgg(result, phase); return; }
    if (result.type === "FIELD_REF" || result.type === "ARITH") { walkArith(result, phase); return; }
    walkScalar(result, phase);
  };

  const walkCase = (expr: CaseWhenExpr, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    for (const b of expr.branches) {
      walkWhere(b.condition, phase);
      walkCaseResult(b.result, phase);
    }
    if (expr.elseResult) walkCaseResult(expr.elseResult, phase);
  };

  const walkFieldValue = (
    fv: FieldValue,
    phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"
  ): void => {
    if (fv.type === "FIELD") {
      if (fv.aggregateRef) {
        walkAgg(fv.aggregateRef, phase);
        return;
      }
      addFieldRef(fv.field, fv.tableAlias, phase);
      return;
    }
    if (fv.type === "FUNC_FIELD") {
      walkStringFunc(fv.expr, phase);
      return;
    }
    if (fv.type === "AGG_FIELD") {
      walkAgg(fv.expr, phase);
      return;
    }
    if (fv.type === "ARITH_FIELD") {
      walkArith(fv.expr, phase);
      return;
    }
    if (fv.type === "GROUPING_FIELD") {
      // GROUPING(arg) is virtual state. Its physical source is collected once
      // from normalized grouping allItems below.
      return;
    }
    walkCase(fv.expr, phase);
  };

  const walkSqlValue = (
    v: SqlValue,
    phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"
  ): void => {
    if (v.type === "ARITH_VALUE") {
      walkArith(v.expr, phase);
      return;
    }
    if (v.type === "CASE_VALUE") {
      walkCase(v.expr, phase);
      return;
    }
    // IN_LIST / SUBQUERY / SCALAR_SUBQUERY / LITERAL は収集不要
  };

  const walkWhere = (
    where: WhereExpr | null,
    phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "where"
  ): void => {
    if (!where) return;
    switch (where.type) {
      case "BINARY":
        walkFieldValue(where.left, phase);
        walkSqlValue(where.right, phase);
        return;
      case "NULL_CHECK":
        walkFieldValue(where.field, phase);
        return;
      case "LOGICAL":
        walkWhere(where.left, phase);
        walkWhere(where.right, phase);
        return;
      case "NOT":
      case "GROUP":
        walkWhere(where.expr, phase);
        return;
      case "EXISTS":
      case "BOOLEAN":
        return;
    }
  };

  const walkGroupByKey = (k: GroupByKey, resolution?: PlainGroupByResolution) => {
    if (k.type === "FIELD_NAME") {
      addFieldName(k.name, "groupBy", resolution);
      return;
    }
    if (k.type === "ARITH_KEY") {
      walkArith(k.expr, "groupBy");
      return;
    }
    walkStringFunc(k.expr, "groupBy");
  };

  const walkOrderByKey = (k: OrderByKey, phase: "orderBy" | "select" = "orderBy") => {
    if (k.type === "FIELD_NAME") {
      addFieldName(k.name, phase);
      return;
    }
    if (k.type === "ARITH_KEY") {
      walkArith(k.expr, phase);
      return;
    }
    if (k.type === "GROUPING_KEY") {
      // GROUPING(arg) is not an additional physical projection field.
      return;
    }
    walkStringFunc(k.expr, phase);
  };

  for (const col of stmt.columns) {
    switch (col.type) {
      case "WILDCARD":
        markAllTargetTables();
        break;
      case "PARENT_WILDCARD":
        markAllSubtableTables();
        break;
      case "FIELD":
        addFieldName(col.field, "select");
        break;
      case "LITERAL_COL":
        break;
      case "VARIABLE_COL":
        throw new Error(`internal error: unresolved SELECT variable @${col.name}`);
      case "AGGREGATE":
        if (col.arg.type !== "WILDCARD") walkAggregateArg(col.arg, "select");
        break;
      case "ARITH_AGG_COL":
        walkAgg(col.expr, "select");
        break;
      case "ARITH_COL":
        walkArith(col.expr, "select");
        break;
      case "CASE_COL":
        walkCase(col.expr, "select");
        break;
      case "STRFUNC_COL":
        walkStringFunc(col.expr, "select");
        break;
      case "SCALAR_VALUE_COL":
        walkScalar(col.expr, "select");
        break;
      case "GROUPING_COL":
        // allItems is the single physical-field source for GROUPING(arg).
        break;
      case "SCALAR_SUBQUERY_COL":
        break;
      case "WINDOW_COL":
        if ((col.windowKind === "AGGREGATE" || col.windowKind === "VALUE") && col.arg.type !== "WILDCARD") {
          walkAggregateArg(col.arg, "select");
        }
        for (const ref of col.partitionBy) addFieldRef(ref.field, ref.tableAlias, "select");
        for (const item of col.orderBy) walkOrderByKey(item.key, "select");
        break;
    }
  }

  for (const join of stmt.joins) {
    addFieldRef(join.on.left.field, join.on.left.tableAlias, "where");
    addFieldRef(join.on.right.field, join.on.right.tableAlias, "where");
  }
  walkWhere(stmt.where, "where");
  const grouping = normalizeGroupingSpec(stmt);
  if (grouping.type === "PLAIN") {
    grouping.allItems.forEach((item, index) =>
      walkGroupByKey(item, plainGroupByPlan?.items[index])
    );
  } else if (grouping.type === "GROUPING_SETS") {
    for (const item of grouping.allItems) {
      // B65 items cannot resolve through SELECT aliases: always source-first.
      addFieldRef(item.field, item.tableAlias, "select");
    }
  }
  walkWhere(stmt.having, "having");
  for (const ob of stmt.orderBy) walkOrderByKey(ob.key);

  return states;
}

function collectSelectOutputNames(columns: SelectColumn[]): Set<string> {
  const names = new Set<string>();
  for (const col of columns) {
    if (col.type === "FIELD" && col.alias) {
      names.add(col.alias);
      continue;
    }
    if (col.type === "LITERAL_COL") {
      names.add(col.alias ?? `'${col.value}'`);
      continue;
    }
    if (col.type === "AGGREGATE") {
      if (col.alias) names.add(col.alias);
      else names.add(aggregateSyntheticName(col.func, col.distinct, col.arg));
      continue;
    }
    if (col.type === "ARITH_AGG_COL") {
      if (col.alias) names.add(col.alias);
      continue;
    }
    if (col.type === "ARITH_COL") {
      if (col.alias) names.add(col.alias);
      continue;
    }
    if (col.type === "CASE_COL") {
      names.add(col.alias ?? "case");
      continue;
    }
    if (col.type === "STRFUNC_COL") {
      if (col.alias) names.add(col.alias);
      continue;
    }
    if (col.type === "SCALAR_VALUE_COL") {
      if (col.alias) names.add(col.alias);
      continue;
    }
    if (col.type === "GROUPING_COL") {
      names.add(col.alias
        ?? `GROUPING(${col.ref.field.tableAlias ? `${col.ref.field.tableAlias}.` : ""}${col.ref.field.field})`);
      continue;
    }
    if (col.type === "SCALAR_SUBQUERY_COL") {
      names.add(col.alias ?? "(subquery)");
      continue;
    }
    if (col.type === "WINDOW_COL") {
      names.add(col.alias);
    }
  }
  return names;
}

function isAggregateSyntheticName(name: string): boolean {
  return /^(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STDDEV_POP|STDDEV_SAMP|VAR_POP|VAR_SAMP|MEDIAN|MODE)\(/i.test(name);
}
