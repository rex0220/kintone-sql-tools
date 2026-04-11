// ============================================================
// JS 集計エンジン
//
// FULL_SCAN モード（JOIN / GROUP BY / DISTINCT）の後処理を担う。
// kintone API から取得した全件レコードを受け取り、
// SQL の意味論に従って加工して返す。
//
// 処理パイプライン（FULL_SCAN）:
//   1. flatten  — KintoneRecord → ProcessRow
//   2. join     — 複数テーブルを結合
//   3. filter   — JS 側 WHERE（JOIN 後フィルタ）
//   4. groupBy  — GROUP BY + 集計関数
//   5. having   — HAVING フィルタ
//   6. distinct — DISTINCT 重複除去
//   7. orderBy  — ORDER BY ソート
//   8. limit    — LIMIT 件数制限
//   9. project  — SELECT 列プロジェクション（フィールド選択・AS alias）
// ============================================================

import type {
  SelectStatement,
  SelectColumn,
  JoinClause,
  OrderByItem,
  OrderByKey,
  GroupByKey,
  WhereExpr,
  AggregateFunc,
  AggregateColumn,
  ArithNode,
  WildcardColumn,
  AggOperand,
  StringFuncArg,
  CaseWhenExpr,
  StringFuncExpr,
} from "../types/ast";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { evalWhere, evalCaseWhen, ProcessRow } from "./evalWhere";
import {
  evalArithExpr,
  evalStringFunc,
  applyRoundOp,
  resolveFieldRef,
} from "./evalFunc";

export { ProcessRow };

// ============================================================
// 1. flatten — KintoneRecord → ProcessRow
// ============================================================

/**
 * kintone レコードをフラットな文字列マップに変換する。
 * JOIN がある場合は tableAlias をキーのプレフィックスに付与する。
 *
 * 例（alias="a"）: { 名前: {value:"田中"} } → { "a.名前": "田中" }
 * 例（alias=null）: { 名前: {value:"田中"} } → { "名前": "田中" }
 */
export function flatten(record: KintoneRecord, alias: string | null): ProcessRow {
  const row: ProcessRow = {};
  for (const [field, fv] of Object.entries(record)) {
    // ユーザー選択・サブテーブル等は value が配列/オブジェクトになる場合がある
    const val = (fv as { value: unknown }).value;
    const strVal = typeof val === "string" ? val : JSON.stringify(val ?? "");
    if (alias) {
      row[`${alias}.${field}`] = strVal; // 修飾キー: "APP89.顧客名"
      row[field]               = strVal; // 非修飾フォールバック: "顧客名"
    } else {
      row[field] = strVal;
    }
  }
  return row;
}

// ============================================================
// 2. join
// ============================================================

/**
 * 左テーブルの行と右テーブルの行を結合する。
 *
 * - INNER JOIN: 結合条件を満たす行のみ
 * - LEFT  JOIN: 左の全行 + 条件を満たす右行（右が存在しない場合は空文字）
 * - RIGHT JOIN: 右の全行 + 条件を満たす左行（左が存在しない場合は空文字）
 *
 * 結合キーは ON a.field = b.field 形式（等値結合のみ）。
 */
export function applyJoin(
  leftRows: ProcessRow[],
  rightRows: ProcessRow[],
  join: JoinClause
): ProcessRow[] {
  const { on, type: joinType } = join;
  const leftKey  = on.left.tableAlias
    ? `${on.left.tableAlias}.${on.left.field}`
    : on.left.field;
  const rightKey = on.right.tableAlias
    ? `${on.right.tableAlias}.${on.right.field}`
    : on.right.field;

  // ── RIGHT JOIN ──────────────────────────────────────────────
  if (joinType === "RIGHT") {
    // 左テーブルをインデックス化し、右テーブルを全件走査
    const leftIndex = new Map<string, ProcessRow[]>();
    for (const lRow of leftRows) {
      const k = lRow[leftKey] ?? "";
      const bucket = leftIndex.get(k);
      if (bucket) bucket.push(lRow);
      else leftIndex.set(k, [lRow]);
    }
    const emptyLeft: ProcessRow = {};
    for (const key of Object.keys(leftRows[0] ?? {})) emptyLeft[key] = "";

    const result: ProcessRow[] = [];
    for (const rRow of rightRows) {
      const k = rRow[rightKey] ?? "";
      const matched = leftIndex.get(k) ?? [];
      if (matched.length > 0) {
        for (const lRow of matched) result.push({ ...lRow, ...rRow });
      } else {
        result.push({ ...emptyLeft, ...rRow });
      }
    }
    return result;
  }

  // ── INNER / LEFT JOIN ────────────────────────────────────────
  // 右テーブルを結合キーでインデックス化（O(n+m) にする）
  const rightIndex = new Map<string, ProcessRow[]>();
  for (const rRow of rightRows) {
    const k = rRow[rightKey] ?? "";
    const bucket = rightIndex.get(k);
    if (bucket) bucket.push(rRow);
    else rightIndex.set(k, [rRow]);
  }

  const result: ProcessRow[] = [];

  for (const lRow of leftRows) {
    const k = lRow[leftKey] ?? "";
    const matched = rightIndex.get(k) ?? [];

    if (matched.length > 0) {
      for (const rRow of matched) {
        result.push({ ...lRow, ...rRow });
      }
    } else if (joinType === "LEFT") {
      // LEFT JOIN: 右側が存在しない場合は空文字で埋める
      const emptyRight: ProcessRow = {};
      for (const key of Object.keys(rightRows[0] ?? {})) emptyRight[key] = "";
      result.push({ ...lRow, ...emptyRight });
    }
    // INNER JOIN かつ非マッチ → 除外（何もしない）
  }

  return result;
}

// ============================================================
// 3. filter — JS 側 WHERE 評価
// ============================================================

export function applyFilter(
  rows: ProcessRow[],
  where: WhereExpr | null
): ProcessRow[] {
  if (where === null) return rows;
  return rows.filter((row) => evalWhere(where, row));
}

// ============================================================
// 4. groupBy + 集計
// ============================================================

/**
 * GROUP BY フィールドでグループ化し、SELECT 句の集計関数を評価する。
 * 出力行のキー:
 *   - GROUP BY フィールド → そのまま
 *   - 集計カラム → alias があれば alias、なければ "COUNT(*)" 等の合成名
 */
export function applyGroupBy(
  rows: ProcessRow[],
  groupByKeys: GroupByKey[],
  columns: SelectColumn[]
): ProcessRow[] {
  // グループキー → 行リスト
  const groups = new Map<string, ProcessRow[]>();
  for (const row of rows) {
    const key = groupByKeys.map((k) => evalGroupByKey(k, row)).join("\x00");
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const result: ProcessRow[] = [];
  for (const groupRows of groups.values()) {
    // 元行の全フィールドをコピー（式の再評価やフィールド参照のため）
    const outRow: ProcessRow = { ...groupRows[0] };

    // 式キーの計算値を確定値として上書き
    for (const k of groupByKeys) {
      if (k.type === "ARITH_KEY") {
        outRow[arithColDefaultKey(k.expr)] = String(evalArithExpr(k.expr, groupRows[0]));
      } else if (k.type === "FUNC_KEY") {
        outRow[stringFuncDefaultKey(k.expr)] = evalStringFunc(k.expr, groupRows[0]);
      }
    }

    // 集計カラムを評価
    for (const col of columns) {
      if (col.type === "AGGREGATE") {
        const outputKey = col.alias ?? aggregateSyntheticName(col.func, col.distinct, col.arg);
        outRow[outputKey] = String(evalAggregate(col.func, col.distinct, col.arg, groupRows));
      } else if (col.type === "ARITH_AGG_COL") {
        const outputKey = col.alias ?? aggArithDefaultKey(col.expr);
        outRow[outputKey] = String(evalAggArithExpr(col.expr, groupRows));
      } else if (col.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(col.expr)) {
        const outputKey = col.alias ?? stringFuncDefaultKey(col.expr);
        const resolvedExpr = resolveAggInStringFuncExpr(col.expr, groupRows);
        outRow[outputKey] = evalStringFunc(resolvedExpr, outRow);
      }
    }

    result.push(outRow);
  }
  return result;
}

/** GROUP BY キーをグループ分け用文字列に評価する */
function evalGroupByKey(key: GroupByKey, row: ProcessRow): string {
  if (key.type === "FIELD_NAME") return row[key.name] ?? "";
  if (key.type === "FUNC_KEY")   return evalStringFunc(key.expr, row);
  return String(evalArithExpr(key.expr, row)); // ARITH_KEY
}

// ------------------------------------------------------------
// 集計関数の評価
// ------------------------------------------------------------

function evalAggregate(
  func: AggregateFunc,
  distinct: boolean,
  arg: WildcardColumn | ArithNode,
  rows: ProcessRow[]
): number {
  // COUNT(*)
  if (arg.type === "WILDCARD") {
    return func === "COUNT" ? rows.length : 0;
  }

  // 各行で arg を評価し、非空・非 NaN の文字列値を収集
  const strValues: string[] = [];
  for (const row of rows) {
    let strVal: string;
    if (arg.type === "FIELD_REF") {
      // 単純フィールド参照: 空文字はスキップ（COUNT(field) の既存動作を維持）
      const raw = row[arg.field];
      if (raw === undefined || raw === "") continue;
      strVal = raw;
    } else {
      // 算術式 / 関数: 数値として評価し NaN はスキップ
      const n = evalArithExpr(arg, row);
      if (isNaN(n)) continue;
      strVal = String(n);
    }
    strValues.push(strVal);
  }

  // DISTINCT: 文字列レベルで重複除去
  const eff = distinct ? [...new Set(strValues)] : strValues;

  if (func === "COUNT") return eff.length;

  const nums = eff.map(Number);
  switch (func) {
    case "SUM": return nums.reduce((a, b) => a + b, 0);
    case "AVG": return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
    case "MAX": return nums.length === 0 ? 0 : Math.max(...nums);
    case "MIN": return nums.length === 0 ? 0 : Math.min(...nums);
  }
}

/** 集計算術式を評価する（グループ行全体を受け取る） */
function evalAggArithExpr(node: AggOperand, rows: ProcessRow[]): number {
  if (node.type === "NUMBER")    return node.value;
  if (node.type === "AGG_REF")   return evalAggregate(node.func, node.distinct, node.arg, rows);
  // AGG_ARITH
  const l = evalAggArithExpr(node.left, rows);
  const r = evalAggArithExpr(node.right, rows);
  switch (node.op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/": return r !== 0 ? l / r : NaN;
    case "%": return r !== 0 ? l % r : NaN;
  }
}

/** alias なし時のデフォルトキー名: "SUM(金額)*1.1" 形式 */
function aggArithDefaultKey(node: AggOperand): string {
  if (node.type === "NUMBER")    return String(node.value);
  if (node.type === "AGG_REF")   return aggregateSyntheticName(node.func, node.distinct, node.arg);
  return `${aggArithDefaultKey(node.left)}${node.op}${aggArithDefaultKey(node.right)}`;
}

/** 集計関数の引数を表示用文字列に変換する */
function aggregateArgLabel(arg: WildcardColumn | ArithNode): string {
  if (arg.type === "WILDCARD") return "*";
  return arithColDefaultKey(arg); // FIELD_REF / NUMBER / ARITH / STRING_FUNC を処理済み
}

// "COUNT(*)" / "SUM(金額)" / "SUM(単価*数量)" / "COUNT(DISTINCT 種別)" 形式の合成名
function aggregateSyntheticName(
  func: AggregateFunc,
  distinct: boolean,
  arg: WildcardColumn | ArithNode
): string {
  const argStr = aggregateArgLabel(arg);
  return distinct ? `${func}(DISTINCT ${argStr})` : `${func}(${argStr})`;
}

// ============================================================
// 5. having
// ============================================================

export function applyHaving(
  rows: ProcessRow[],
  having: WhereExpr | null
): ProcessRow[] {
  if (having === null) return rows;
  return rows.filter((row) => evalWhere(having, row));
}

// ============================================================
// 6. distinct
// ============================================================

/**
 * SELECT 列に基づいて重複行を除去する。
 * GROUP BY 後には不要だが DISTINCT SELECT では使用する。
 */
export function applyDistinct(
  rows: ProcessRow[],
  columns: SelectColumn[]
): ProcessRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = buildDistinctKey(row, columns);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildDistinctKey(row: ProcessRow, columns: SelectColumn[]): string {
  if (columns.some((c) => c.type === "WILDCARD")) {
    // SELECT * → 全フィールドを含むキー
    return JSON.stringify(Object.entries(row).sort());
  }
  const values: string[] = [];
  for (const col of columns) {
    if (col.type === "FIELD") {
      values.push(row[col.field] ?? "");
      continue;
    }
    if (col.type === "PARENT_WILDCARD") {
      for (const key of Object.keys(row).filter((k) => k.startsWith("_p.")).sort()) {
        values.push(row[key] ?? "");
      }
    }
  }
  return values.join("\x00");
}

// ============================================================
// 7. orderBy
// ============================================================

export type OptionOrderMap = Map<string, Map<string, number>>;
export type FieldSortKindMap = Map<string, "number" | "string">;

export function applyOrderBy(
  rows: ProcessRow[],
  orderBy: OrderByItem[],
  optionOrders?: OptionOrderMap,
  sortKinds?: FieldSortKindMap
): ProcessRow[] {
  if (orderBy.length === 0) return rows;

  return [...rows].sort((a, b) => {
    for (const { key, direction } of orderBy) {
      const av = evalOrderKey(key, a);
      const bv = evalOrderKey(key, b);

      const cmp = compareOrderValues(av, bv, key, optionOrders, sortKinds);
      if (cmp !== 0) return direction === "ASC" ? cmp : -cmp;
    }
    return 0;
  });
}

function evalOrderKey(key: OrderByKey, row: ProcessRow): string {
  switch (key.type) {
    case "FIELD_NAME": return row[key.name] ?? "";
    case "ARITH_KEY":  return String(evalArithExpr(key.expr, row));
    case "FUNC_KEY":   return evalStringFunc(key.expr, row);
  }
}

function compareOrderValues(
  av: string,
  bv: string,
  key: OrderByKey,
  optionOrders?: OptionOrderMap,
  sortKinds?: FieldSortKindMap
): number {
  if (key.type === "FIELD_NAME") {
    const orderMap = optionOrders?.get(key.name);
    if (orderMap) {
      const ac = compareByChoiceOrder(av, bv, orderMap);
      if (ac !== 0) return ac;
      return av.localeCompare(bv, "ja");
    }

    const sortKind = sortKinds?.get(key.name);
    if (sortKind === "number") {
      return compareAsNumber(av, bv);
    }
    if (sortKind === "string") {
      return av.localeCompare(bv, "ja");
    }
  }

  // 数値比較が可能な場合は数値として比較
  return compareAuto(av, bv);
}

function compareByChoiceOrder(
  av: string,
  bv: string,
  orderMap: Map<string, number>
): number {
  const aValues = parseChoiceValues(av);
  const bValues = parseChoiceValues(bv);
  const aRank = minChoiceIndex(aValues, orderMap);
  const bRank = minChoiceIndex(bValues, orderMap);
  if (aRank !== bRank) return aRank - bRank;
  return 0;
}

function parseChoiceValues(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [""];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr.map((v) => String(v ?? ""));
      }
    } catch {
      // fall through
    }
  }
  return [trimmed];
}

function minChoiceIndex(values: string[], orderMap: Map<string, number>): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const value of values) {
    const idx = orderMap.get(value);
    const rank = idx ?? Number.MAX_SAFE_INTEGER;
    if (rank < min) min = rank;
  }
  return min;
}

function compareAsNumber(av: string, bv: string): number {
  const an = Number(av);
  const bn = Number(bv);
  const numeric = !Number.isNaN(an) && !Number.isNaN(bn);
  return numeric ? an - bn : av.localeCompare(bv, "ja");
}

function compareAuto(av: string, bv: string): number {
  const an = Number(av);
  const bn = Number(bv);
  const numeric = !Number.isNaN(an) && !Number.isNaN(bn);
  return numeric ? an - bn : av.localeCompare(bv, "ja");
}

// ============================================================
// 8. limit / offset
// ============================================================

export function applyLimit(
  rows: ProcessRow[],
  limit: number | null,
  offset: number | null
): ProcessRow[] {
  const start = offset ?? 0;
  if (limit === null) return rows.slice(start);
  return rows.slice(start, start + limit);
}

// ============================================================
// 9. project — SELECT 列プロジェクション
// ============================================================

/**
 * 処理済み行から SELECT 句で指定された列だけを取り出し、
 * AS alias があれば alias 名に変換して返す。
 *
 * @returns rows — 射影後の行リスト
 *          columns — SELECT 列定義順のカラム名リスト（表示順保証用）
 */
export function project(
  rows: ProcessRow[],
  columns: SelectColumn[],
  scalarCache?: Map<number, string>
): { rows: ProcessRow[]; columns: string[] } {
  // SELECT * → そのまま全フィールド
  if (columns.length === 1 && columns[0].type === "WILDCARD") {
    const projected = rows.map((row) => stripParentShortcutColumns(row));
    const cols = projected.length > 0 ? Object.keys(projected[0]) : [];
    return { rows: projected, columns: cols };
  }

  const orderedKeys: string[] = [];
  const defaultFieldKeys = buildDefaultFieldOutputKeys(columns);

  const projected = rows.map((row, rowIdx) => {
    const out: ProcessRow = {};
    for (const [colIdx, col] of columns.entries()) {
      switch (col.type) {
        case "WILDCARD":
          Object.assign(out, stripParentShortcutColumns(row));
          break;
        case "PARENT_WILDCARD": {
          const parentKeys = Object.keys(row).filter((k) => k.startsWith("_p.")).sort();
          for (const key of parentKeys) {
            out[key] = row[key] ?? "";
            if (rowIdx === 0) orderedKeys.push(key);
          }
          break;
        }
        case "FIELD": {
          const key = col.alias ?? defaultFieldKeys.get(colIdx) ?? col.field;
          out[key] = resolveFieldRef(row, col.field);
          if (rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "LITERAL_COL": {
          const key = col.alias ?? `'${col.value}'`;
          out[key] = col.value;
          if (rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "AGGREGATE": {
          const srcKey = aggregateSyntheticName(col.func, col.distinct, col.arg);
          const dstKey = col.alias ?? srcKey;
          out[dstKey] = row[col.alias ?? srcKey] ?? row[srcKey] ?? "0";
          if (rowIdx === 0) orderedKeys.push(dstKey);
          break;
        }
        case "ARITH_AGG_COL": {
          const key = col.alias ?? aggArithDefaultKey(col.expr);
          out[key] = row[key] ?? "0";
          if (rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "ARITH_COL": {
          const val = evalArithExpr(col.expr, row);
          const key = col.alias ?? arithColDefaultKey(col.expr);
          out[key] = String(val);
          if (rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "CASE_COL": {
          const key = col.alias ?? "case";
          out[key] = evalCaseWhen(col.expr, row);
          if (rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "STRFUNC_COL": {
          const key = col.alias ?? stringFuncDefaultKey(col.expr);
          out[key] = row[key] ?? evalStringFunc(col.expr, row);
          if (rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "SCALAR_SUBQUERY_COL": {
          const key = col.alias ?? "(subquery)";
          out[key] = scalarCache?.get(colIdx) ?? "";
          if (rowIdx === 0) orderedKeys.push(key);
          break;
        }
      }
    }
    return out;
  });

  return { rows: projected, columns: orderedKeys };
}

function buildDefaultFieldOutputKeys(columns: SelectColumn[]): Map<number, string> {
  const qualifierCollisionCount = new Map<string, number>();

  for (const col of columns) {
    if (col.type !== "FIELD" || col.alias) continue;
    const unqualified = stripTableQualifier(col.field);
    qualifierCollisionCount.set(unqualified, (qualifierCollisionCount.get(unqualified) ?? 0) + 1);
  }

  const keys = new Map<number, string>();
  for (const [idx, col] of columns.entries()) {
    if (col.type !== "FIELD" || col.alias) continue;
    const unqualified = stripTableQualifier(col.field);
    const duplicate = (qualifierCollisionCount.get(unqualified) ?? 0) > 1;
    const hasTableQualifier = col.field.includes(".") && !col.field.startsWith("_p.");
    keys.set(idx, duplicate && hasTableQualifier ? col.field : unqualified);
  }
  return keys;
}

function stripTableQualifier(field: string): string {
  if (field.startsWith("_p.")) return field;
  const dot = field.indexOf(".");
  if (dot <= 0) return field;
  const unqualified = field.slice(dot + 1);
  return unqualified || field;
}

function stripParentShortcutColumns(row: ProcessRow): ProcessRow {
  const out: ProcessRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_p.")) continue;
    out[k] = v;
  }
  return out;
}

/** alias なし時のデフォルトキー名: "左辺 op 右辺" */
function arithColDefaultKey(expr: ArithNode): string {
  const nodeLabel = (n: ArithNode): string => {
    if (n.type === "FIELD_REF")   return n.field;
    if (n.type === "NUMBER")      return String(n.value);
    if (n.type === "STRING_FUNC") return stringFuncDefaultKey(n);
    return `(${nodeLabel(n.left)}${n.op}${nodeLabel(n.right)})`;
  };
  // トップレベルは括弧なし: "$id*1.1"、ネストのみ括弧あり
  if (expr.type === "ARITH") {
    return `${nodeLabel(expr.left)}${expr.op}${nodeLabel(expr.right)}`;
  }
  return nodeLabel(expr);
}

// evalCaseWhen は evalWhere.ts にある（循環依存を避けるため）

/** alias なし時のデフォルトキー名: "UPPER(名前)" 形式 */
function stringFuncDefaultKey(expr: StringFuncExpr): string {
  const argStrs = expr.args.map((a) => {
    if (a.type === "STRING")      return `'${a.value}'`;
    if (a.type === "STRING_FUNC") return stringFuncDefaultKey(a);
    if (a.type === "AGG_REF" || a.type === "AGG_ARITH") return aggArithDefaultKey(a);
    return arithColDefaultKey(a); // ArithNode
  });
  return `${expr.func}(${argStrs.join(",")})`;
}

function hasAggregateInStringFuncArg(arg: StringFuncArg): boolean {
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
  if (arg.type === "STRING_FUNC") return hasAggregateInStringFuncExpr(arg);
  return false;
}

function hasAggregateInStringFuncExpr(expr: StringFuncExpr): boolean {
  return expr.args.some((arg) => hasAggregateInStringFuncArg(arg));
}

function resolveAggInStringFuncArg(arg: StringFuncArg, rows: ProcessRow[]): StringFuncArg {
  if (arg.type === "AGG_REF") {
    return {
      type: "NUMBER",
      value: evalAggregate(arg.func, arg.distinct, arg.arg, rows),
    };
  }
  if (arg.type === "AGG_ARITH") {
    return { type: "NUMBER", value: evalAggArithExpr(arg, rows) };
  }
  if (arg.type === "STRING_FUNC") {
    return resolveAggInStringFuncExpr(arg, rows);
  }
  return arg;
}

function resolveAggInStringFuncExpr(expr: StringFuncExpr, rows: ProcessRow[]): StringFuncExpr {
  return {
    type: "STRING_FUNC",
    func: expr.func,
    args: expr.args.map((arg) => resolveAggInStringFuncArg(arg, rows)),
  };
}

// ============================================================
// 統合エントリポイント: FULL_SCAN パイプライン
// ============================================================

export interface FullScanInput {
  /** メインテーブル（alias → records） */
  tables: Map<string | null, KintoneRecord[]>;
  stmt: SelectStatement;
  /** スカラーサブクエリ列の事前実行結果: 列インデックス → 値 */
  scalarCache?: Map<number, string>;
  /** 選択肢ソート順（field key -> option label -> index） */
  optionOrders?: OptionOrderMap;
  /** フィールドごとの強制ソート種別 */
  sortKinds?: FieldSortKindMap;
}

/**
 * FULL_SCAN モードの全処理を一気に実行する。
 * テーブルは { alias → KintoneRecord[] } の Map で渡す。
 *
 * 単一テーブル: Map に alias=null で 1エントリ
 * JOIN:        Map に alias ごとのエントリを複数
 */
export function runFullScan(input: FullScanInput): { rows: ProcessRow[]; columns: string[] } {
  const { stmt, tables, scalarCache, optionOrders, sortKinds } = input;

  // 1. flatten
  let rows: ProcessRow[] = [];
  const mainAlias = stmt.from.alias;
  const mainRecords = tables.get(mainAlias) ?? tables.get(null) ?? [];
  rows = mainRecords.map((r) => flatten(r, mainAlias));

  // 2. join
  for (const join of stmt.joins) {
    const rightAlias = join.table.alias;
    const rightRecords = tables.get(rightAlias) ?? [];
    const rightRows = rightRecords.map((r) => flatten(r, rightAlias));
    rows = applyJoin(rows, rightRows, join);
  }

  // 3. filter — JS 側 WHERE 評価
  // JOIN があれば常に適用（kintone クエリでは複数テーブルの結合条件を表現不可）
  // JOIN がなくても WHERE に関数が含まれる場合は kintone 側でフィルタできないため JS で評価
  rows = applyFilter(rows, stmt.where);

  // 4. GROUP BY + 集計
  // GROUP BY がなくても集計関数があれば全行を1グループとして集計する
  const hasAggregate = stmt.columns.some((c) =>
    c.type === "AGGREGATE" ||
    c.type === "ARITH_AGG_COL" ||
    (c.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(c.expr))
  );
  if (stmt.groupBy.length > 0 || hasAggregate) {
    rows = applyGroupBy(rows, stmt.groupBy, stmt.columns);
  }

  // 5. HAVING
  rows = applyHaving(rows, stmt.having);

  // 6. DISTINCT
  if (stmt.distinct) {
    rows = applyDistinct(rows, stmt.columns);
  }

  // 7. ORDER BY
  rows = applyOrderBy(rows, stmt.orderBy, optionOrders, sortKinds);

  // 8. LIMIT / OFFSET
  rows = applyLimit(rows, stmt.limit, stmt.offset);

  // 9. project
  return project(rows, stmt.columns, scalarCache);
}
