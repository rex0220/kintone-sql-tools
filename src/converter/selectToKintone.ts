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
  ArithExpr,
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
} from "../types/ast";
import { whereToKintone } from "./whereToKintone";
import { isLike } from "../core/like";

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
  if (stmt.groupBy.length > 0) return "FULL_SCAN";
  if (stmt.distinct) return "FULL_SCAN";
  if (stmt.columns.some((c) =>
    c.type === "AGGREGATE" ||
    c.type === "ARITH_AGG_COL" ||
    c.type === "SCALAR_SUBQUERY_COL" ||
    (c.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(c.expr))
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
  targetTable: TableRef
): string[] {
  const plan = collectRequiredFieldsByTable(stmt);
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
    }
  }
  return [...new Set(fields)];
}

function collectArithFields(expr: ArithExpr, out: string[]): void {
  collectArithNode(expr.left, out);
  collectArithNode(expr.right, out);
}

function collectArithNode(node: ArithNode, out: string[]): void {
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
  if (arg.type === "STRING")      return; // 文字列リテラル: フィールド参照なし
  if (arg.type === "STRING_FUNC") { collectStringFuncFields(arg, out); return; }
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") { collectAggOperandFields(arg, out); return; }
  collectArithNode(arg, out);             // ArithNode: FIELD_REF / NUMBER / ARITH
}

function collectAggOperandFields(node: AggOperand, out: string[]): void {
  if (node.type === "AGG_REF") {
    if (node.arg.type !== "WILDCARD") collectArithNode(node.arg, out);
    return;
  }
  if (node.type === "AGG_ARITH") {
    collectAggOperandFields(node.left, out);
    collectAggOperandFields(node.right, out);
  }
}

function hasAggregateInStringFuncExpr(expr: StringFuncExpr): boolean {
  return expr.args.some((arg) => {
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
    if (arg.type === "STRING_FUNC") return hasAggregateInStringFuncExpr(arg);
    return false;
  });
}

interface RequiredFieldState {
  table: TableRef;
  allFields: boolean;
  fields: Set<string>;
}

function collectRequiredFieldsByTable(
  stmt: SelectStatement
): Map<TableRef, RequiredFieldState> {
  const physicalTables = [stmt.from, ...stmt.joins.map((j) => j.table)]
    .filter((t) => t.cteName === null);
  const states = new Map<TableRef, RequiredFieldState>();
  for (const table of physicalTables) {
    states.set(table, { table, allFields: false, fields: new Set<string>() });
  }
  if (states.size === 0) return states;

  const firstPhysicalTable = physicalTables[0] ?? null;
  const subtableTable = physicalTables.find((t) => !!t.subtableCode) ?? null;
  const aliasToTable = new Map<string, TableRef>();
  for (const table of physicalTables) {
    if (table.alias) aliasToTable.set(table.alias, table);
    if (!table.subtableCode) {
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
  const markAllPhysicalTables = () => {
    for (const t of physicalTables) markAll(t);
  };
  const markAllSubtableTables = () => {
    for (const t of physicalTables) {
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
    phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"
  ) => {
    if (!rawName || rawName === "*") return;

    if (rawName === "_p.*") {
      markAllSubtableTables();
      return;
    }
    if (rawName.endsWith(".*")) {
      const qualifier = rawName.slice(0, -2);
      if (!qualifier) {
        markAllPhysicalTables();
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
    }

    if (firstPhysicalTable) addFieldToTable(firstPhysicalTable, rawName);
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
    }
    addFieldName(field, phase);
  };

  const walkArith = (node: ArithNode, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
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
      if (node.arg.type !== "WILDCARD") walkArith(node.arg, phase);
      return;
    }
    if (node.type === "AGG_ARITH") {
      walkAgg(node.left, phase);
      walkAgg(node.right, phase);
    }
  };

  const walkStringArg = (arg: StringFuncArg, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    if (arg.type === "STRING") return;
    if (arg.type === "STRING_FUNC") {
      walkStringFunc(arg, phase);
      return;
    }
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") {
      walkAgg(arg, phase);
      return;
    }
    walkArith(arg, phase);
  };

  const walkStringFunc = (expr: StringFuncExpr, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    for (const arg of expr.args) walkStringArg(arg, phase);
  };

  const walkCaseResult = (result: CaseResult, phase: "where" | "having" | "groupBy" | "orderBy" | "select" = "select"): void => {
    if (result.type === "STRING") return;
    if (result.type === "ARRAY") return;
    if (result.type === "STRING_FUNC") {
      walkStringFunc(result, phase);
      return;
    }
    walkArith(result, phase);
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
      addFieldRef(fv.field, fv.tableAlias, phase);
      return;
    }
    if (fv.type === "FUNC_FIELD") {
      walkStringFunc(fv.expr, phase);
      return;
    }
    if (fv.type === "ARITH_FIELD") {
      walkArith(fv.expr, phase);
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
        return;
    }
  };

  const walkGroupByKey = (k: GroupByKey) => {
    if (k.type === "FIELD_NAME") {
      addFieldName(k.name, "groupBy");
      return;
    }
    if (k.type === "ARITH_KEY") {
      walkArith(k.expr, "groupBy");
      return;
    }
    walkStringFunc(k.expr, "groupBy");
  };

  const walkOrderByKey = (k: OrderByKey) => {
    if (k.type === "FIELD_NAME") {
      addFieldName(k.name, "orderBy");
      return;
    }
    if (k.type === "ARITH_KEY") {
      walkArith(k.expr, "orderBy");
      return;
    }
    walkStringFunc(k.expr, "orderBy");
  };

  for (const col of stmt.columns) {
    switch (col.type) {
      case "WILDCARD":
        markAllPhysicalTables();
        break;
      case "PARENT_WILDCARD":
        markAllSubtableTables();
        break;
      case "FIELD":
        addFieldName(col.field, "select");
        break;
      case "LITERAL_COL":
        break;
      case "AGGREGATE":
        if (col.arg.type !== "WILDCARD") walkArith(col.arg, "select");
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
      case "SCALAR_SUBQUERY_COL":
        break;
    }
  }

  for (const join of stmt.joins) {
    addFieldRef(join.on.left.field, join.on.left.tableAlias, "where");
    addFieldRef(join.on.right.field, join.on.right.tableAlias, "where");
  }
  walkWhere(stmt.where, "where");
  for (const gk of stmt.groupBy) walkGroupByKey(gk);
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
    if (col.type === "SCALAR_SUBQUERY_COL") {
      names.add(col.alias ?? "(subquery)");
    }
  }
  return names;
}

function aggregateSyntheticName(
  func: AggregateFunc,
  distinct: boolean,
  arg: { type: "WILDCARD" } | ArithNode
): string {
  const argStr = arg.type === "WILDCARD" ? "*" : arithNodeLabel(arg);
  return distinct ? `${func}(DISTINCT ${argStr})` : `${func}(${argStr})`;
}

function arithNodeLabel(node: ArithNode): string {
  if (node.type === "FIELD_REF") return node.field;
  if (node.type === "NUMBER") return String(node.value);
  if (node.type === "STRING_FUNC") return stringFuncLabel(node);
  return `(${arithNodeLabel(node.left)}${node.op}${arithNodeLabel(node.right)})`;
}

function stringFuncLabel(expr: StringFuncExpr): string {
  const args = expr.args.map((a) => {
    if (a.type === "STRING") return `'${a.value}'`;
    if (a.type === "STRING_FUNC") return stringFuncLabel(a);
    if (a.type === "AGG_REF") return aggregateSyntheticName(a.func, a.distinct, a.arg);
    if (a.type === "AGG_ARITH") return "agg_arith";
    return arithNodeLabel(a);
  });
  return `${expr.func}(${args.join(",")})`;
}

function isAggregateSyntheticName(name: string): boolean {
  return /^(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT)\(/i.test(name);
}
