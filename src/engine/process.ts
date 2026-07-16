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
//   6. window   — ウィンドウ関数
//   7. distinct — DISTINCT 重複除去
//   8. orderBy  — ORDER BY ソート
//   9. limit    — LIMIT 件数制限
//  10. project  — SELECT 列プロジェクション（フィールド選択・AS alias）
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
  FieldRef,
  WindowColumn,
} from "../types/ast";
import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  evalWhere,
  evalCaseWhen,
  ProcessRow,
  type FieldTypeResolver,
} from "./evalWhere";
import {
  evalArithExpr,
  evalStringFunc,
  applyRoundOp,
  resolveFieldRef,
} from "./evalFunc";

export { ProcessRow };

/** MIN/MAX の直接フィールド参照を数値順・文字列順へ分類する。 */
export type AggregateSortKindResolver =
  (field: FieldRef) => "number" | "string" | undefined;

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
    const strVal = val == null
      ? ""
      : (typeof val === "string" ? val : JSON.stringify(val));
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

  // LEFT JOIN: 右側が存在しない場合の空行テンプレート（RIGHT JOIN 側と同形）
  const emptyRight: ProcessRow = {};
  for (const key of Object.keys(rightRows[0] ?? {})) emptyRight[key] = "";

  for (const lRow of leftRows) {
    const k = lRow[leftKey] ?? "";
    const matched = rightIndex.get(k) ?? [];

    if (matched.length > 0) {
      for (const rRow of matched) {
        result.push({ ...lRow, ...rRow });
      }
    } else if (joinType === "LEFT") {
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
  where: WhereExpr | null,
  resolveFieldType?: FieldTypeResolver,
  appliedKlikes?: ReadonlySet<object>
): ProcessRow[] {
  if (where === null) return rows;
  return rows.filter((row) => evalWhere(where, row, resolveFieldType, appliedKlikes));
}

// ============================================================
// 4. groupBy + 集計
// ============================================================

/** SELECT 句に集計（AGGREGATE / ARITH_AGG_COL / 集計入り STRFUNC_COL）が含まれるか */
export function hasAggregateColumns(columns: SelectColumn[]): boolean {
  return columns.some((c) =>
    c.type === "AGGREGATE" ||
    c.type === "ARITH_AGG_COL" ||
    (c.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(c.expr))
  );
}

/**
 * GROUP BY フィールドでグループ化し、SELECT 句の集計関数を評価する。
 * 出力行のキー:
 *   - GROUP BY フィールド → そのまま
 *   - 集計カラム → alias があれば alias、なければ "COUNT(*)" 等の合成名
 */
export function applyGroupBy(
  rows: ProcessRow[],
  groupByKeys: GroupByKey[],
  columns: SelectColumn[],
  resolveAggSortKind?: AggregateSortKindResolver
): ProcessRow[] {
  // グループキー → 行リスト
  const groups = new Map<string, ProcessRow[]>();
  for (const row of rows) {
    const key = groupByKeys.map((k) => evalGroupByKey(k, row)).join("\x00");
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  // GROUP BY なし集計は入力 0 行でも 1 行返す（SQL 標準準拠。COUNT=0、SUM/AVG/MIN/MAX は
  // 全値空グループと同じ 0 — 空集合だけ NULL にすると ksql 内の既存規約と不整合になる）。
  // 集計列の存在を条件に含めるのは applyGroupBy 単独の契約のため（runFullScan 経由では
  // hasAggregate ゲート後のみ呼ばれ常に真だが、非集計列のみの直接呼び出しで合成しない）
  if (groups.size === 0 && groupByKeys.length === 0 && hasAggregateColumns(columns)) {
    groups.set("", []);
  }

  const result: ProcessRow[] = [];
  for (const groupRows of groups.values()) {
    // 元行の全フィールドをコピー（式の再評価やフィールド参照のため）。
    // 空の仮想グループでは groupRows[0] が undefined だが、undefined のスプレッドは {} になる
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
        const syntheticKey = aggregateSyntheticName(col.func, col.distinct, col.arg);
        const value = String(evalAggregate(col.func, col.distinct, col.arg, col.separator, groupRows, resolveAggSortKind));
        outRow[col.alias ?? syntheticKey] = value;
        // HAVING / ORDER BY は集計を合成名（例: SUM(売上)）のフィールド参照として
        // 解決するため、alias 付きでも合成名キーを併記する（project で出力からは落ちる）。
        // これがないと「集計列に alias を付けると HAVING が常に偽になる」
        // （row["SUM(売上)"] → "" → Number("") = 0 → 0 > 0 = false）
        if (col.alias) outRow[syntheticKey] = value;
      } else if (col.type === "ARITH_AGG_COL") {
        const outputKey = col.alias ?? aggArithDefaultKey(col.expr);
        outRow[outputKey] = String(evalAggArithExpr(col.expr, groupRows, resolveAggSortKind));
      } else if (col.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(col.expr)) {
        const outputKey = col.alias ?? stringFuncDefaultKey(col.expr);
        const resolvedExpr = resolveAggInStringFuncExpr(col.expr, groupRows, resolveAggSortKind);
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
  separator: string | undefined,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): number | string {
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
  if (func === "GROUP_CONCAT") return eff.join(separator ?? ",");

  const sortKind = (func === "MIN" || func === "MAX") && arg.type === "FIELD_REF"
    ? resolveAggSortKind?.(toAggregateFieldRef(arg.field))
    : undefined;
  if (sortKind === "string") {
    if (eff.length === 0) return "";
    return func === "MAX" ? maxStringOf(eff) : minStringOf(eff);
  }

  const nums = eff.map(Number);
  switch (func) {
    case "SUM": return nums.reduce((a, b) => a + b, 0);
    case "AVG": return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
    // Math.max(...nums) は要素数が多いと RangeError になるためループで求める
    case "MAX": return nums.length === 0 ? 0 : maxOf(nums);
    case "MIN": return nums.length === 0 ? 0 : minOf(nums);
  }
}

function toAggregateFieldRef(field: string): FieldRef {
  const dot = field.indexOf(".");
  return dot > 0
    ? { type: "FIELD", tableAlias: field.slice(0, dot), field: field.slice(dot + 1) }
    : { type: "FIELD", tableAlias: null, field };
}

function maxStringOf(values: string[]): string {
  let value = values[0];
  for (const candidate of values) if (candidate > value) value = candidate;
  return value;
}

function minStringOf(values: string[]): string {
  let value = values[0];
  for (const candidate of values) if (candidate < value) value = candidate;
  return value;
}

function maxOf(nums: number[]): number {
  let m = nums[0];
  for (const n of nums) if (n > m) m = n;
  return m;
}

function minOf(nums: number[]): number {
  let m = nums[0];
  for (const n of nums) if (n < m) m = n;
  return m;
}

/** 集計算術式を評価する（グループ行全体を受け取る） */
function evalAggArithExpr(
  node: AggOperand,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): number {
  if (node.type === "NUMBER")    return node.value;
  if (node.type === "AGG_REF")   return Number(evalAggregate(node.func, node.distinct, node.arg, node.separator, rows, resolveAggSortKind));
  // AGG_ARITH
  const l = evalAggArithExpr(node.left, rows, resolveAggSortKind);
  const r = evalAggArithExpr(node.right, rows, resolveAggSortKind);
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
  having: WhereExpr | null,
  resolveFieldType?: FieldTypeResolver
): ProcessRow[] {
  if (having === null) return rows;
  return rows.filter((row) => evalWhere(having, row, resolveFieldType));
}

// ============================================================
// distinct
// ============================================================

/**
 * SELECT 列に基づいて重複行を除去する。
 * GROUP BY 後には不要だが DISTINCT SELECT では使用する。
 */
export function applyDistinct(
  rows: ProcessRow[],
  columns: SelectColumn[]
): ProcessRow[] {
  if (rows.length === 0) return rows;
  const keyFor = buildDistinctKeyBuilder(rows, columns);
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = keyFor(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * DISTINCT 用のキー生成関数を構築する。
 *
 * 列リストの確定（WILDCARD / PARENT_WILDCARD は全行のキー集合の union）は
 * 呼び出しごとに 1 回だけ行い、行ループでは値の収集のみ行う。
 * 値は JSON.stringify で結合し、区切り文字の衝突（値に \x00 等を含むケース）と
 * 「キー欠損（null）」と「空文字（""）」の区別を保証する。
 */
function buildDistinctKeyBuilder(
  rows: ProcessRow[],
  columns: SelectColumn[]
): (row: ProcessRow) => string {
  // SELECT * → 全行のキー集合の union（後続行にのみ存在するキーも判定に含める）
  if (columns.some((c) => c.type === "WILDCARD")) {
    const allKeys = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) allKeys.add(k);
    }
    const keys = [...allKeys].sort();
    return (row) => JSON.stringify(keys.map((k) => (row[k] !== undefined ? row[k] : null)));
  }

  // _p.* の union（PARENT_WILDCARD がある場合のみ収集）
  let sortedParentKeys: string[] = [];
  if (columns.some((c) => c.type === "PARENT_WILDCARD")) {
    const parentKeys = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (k.startsWith("_p.")) parentKeys.add(k);
      }
    }
    sortedParentKeys = [...parentKeys].sort();
  }

  return (row) => {
    const values: Array<string | null> = [];
    for (const col of columns) {
      if (col.type === "FIELD") {
        values.push(row[col.field] ?? "");
        continue;
      }
      if (col.type === "WINDOW_COL") {
        values.push(row[col.alias] ?? "");
        continue;
      }
      if (col.type === "PARENT_WILDCARD") {
        for (const k of sortedParentKeys) {
          values.push(row[k] !== undefined ? row[k] : null);
        }
      }
    }
    return JSON.stringify(values);
  };
}

// ============================================================
// orderBy（ウィンドウ内ソートと比較器を共有）
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

  return sortDecoratedRows(rows, orderBy, optionOrders, sortKinds).rows.map((item) => item.row);
}

interface DecoratedSortRow {
  row: ProcessRow;
  keys: SortKey[];
}

interface DecoratedSortResult {
  rows: DecoratedSortRow[];
  compare: (a: DecoratedSortRow, b: DecoratedSortRow) => number;
}

function sortDecoratedRows(
  rows: ProcessRow[],
  orderBy: OrderByItem[],
  optionOrders?: OptionOrderMap,
  sortKinds?: FieldSortKindMap
): DecoratedSortResult {

  // キーごとの比較設定（選択肢順マップ / ソート種別）を 1 回だけ解決
  const keyMeta: SortKeyMeta[] = orderBy.map(({ key }) => ({
    orderMap: key.type === "FIELD_NAME" ? optionOrders?.get(key.name) : undefined,
    sortKind: key.type === "FIELD_NAME" ? sortKinds?.get(key.name) : undefined,
  }));

  // ソートキーを行ごとに前計算する（比較のたびの式評価・数値変換を避ける）
  const decorated: DecoratedSortRow[] = rows.map((row) => ({
    row,
    keys: orderBy.map(({ key }, i): SortKey => {
      const s = evalOrderKey(key, row);
      const n = Number(s);
      const orderMap = keyMeta[i].orderMap;
      return {
        s,
        n,
        isNum: !Number.isNaN(n),
        rank: orderMap ? minChoiceIndex(parseChoiceValues(s), orderMap) : 0,
      };
    }),
  }));

  const compare = (a: DecoratedSortRow, b: DecoratedSortRow) =>
    compareDecoratedRows(a, b, orderBy, keyMeta);
  decorated.sort(compare);

  return { rows: decorated, compare };
}

function compareDecoratedRows(
  a: DecoratedSortRow,
  b: DecoratedSortRow,
  orderBy: OrderByItem[],
  keyMeta: SortKeyMeta[]
): number {
  for (let i = 0; i < orderBy.length; i++) {
    const cmp = compareSortKeys(a.keys[i], b.keys[i], keyMeta[i]);
    if (cmp !== 0) return orderBy[i].direction === "ASC" ? cmp : -cmp;
  }
  return 0;
}

interface SortKey {
  /** 文字列値 */
  s: string;
  /** 数値解釈（NaN の場合は isNum=false） */
  n: number;
  isNum: boolean;
  /** 選択肢順ランク（orderMap がある場合のみ有効） */
  rank: number;
}

interface SortKeyMeta {
  orderMap?: Map<string, number>;
  sortKind?: "number" | "string";
}

function compareSortKeys(a: SortKey, b: SortKey, meta: SortKeyMeta): number {
  if (meta.orderMap) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.s.localeCompare(b.s, "ja");
  }
  if (meta.sortKind === "string") {
    return a.s.localeCompare(b.s, "ja");
  }
  // sortKind="number" / 自動判定: 両辺とも数値のときだけ数値比較（従来と同じ規則）
  return a.isNum && b.isNum ? a.n - b.n : a.s.localeCompare(b.s, "ja");
}

function evalOrderKey(key: OrderByKey, row: ProcessRow): string {
  switch (key.type) {
    case "FIELD_NAME": return row[key.name] ?? "";
    case "ARITH_KEY":  return String(evalArithExpr(key.expr, row));
    case "FUNC_KEY":   return evalStringFunc(key.expr, row);
  }
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

// ============================================================
// window（パイプラインでは HAVING 後・DISTINCT 前）
// ============================================================

/** HAVING 後の同じ入力行集合に対し、各ウィンドウ列を独立に評価する。 */
export function applyWindow(
  rows: ProcessRow[],
  columns: SelectColumn[],
  optionOrders?: OptionOrderMap,
  sortKinds?: FieldSortKindMap
): ProcessRow[] {
  const windows = columns.filter((column): column is WindowColumn => column.type === "WINDOW_COL");
  if (rows.length === 0 || windows.length === 0) return rows;

  for (const window of windows) {
    const partitions = new Map<string, ProcessRow[]>();
    for (const row of rows) {
      const key = JSON.stringify(window.partitionBy.map((ref) => resolveWindowField(row, ref)));
      const partition = partitions.get(key);
      if (partition) partition.push(row);
      else partitions.set(key, [row]);
    }

    for (const partition of partitions.values()) {
      const sortedResult = sortDecoratedRows(partition, window.orderBy, optionOrders, sortKinds);
      const sorted = sortedResult.rows;
      let rank = 1;
      let denseRank = 1;
      for (let index = 0; index < sorted.length; index++) {
        if (index > 0 && sortedResult.compare(sorted[index - 1], sorted[index]) !== 0) {
          rank = index + 1;
          denseRank++;
        }
        const value = window.func === "ROW_NUMBER"
          ? index + 1
          : window.func === "RANK"
            ? rank
            : denseRank;
        sorted[index].row[window.alias] = String(value);
      }
    }
  }
  return rows;
}

function resolveWindowField(row: ProcessRow, ref: FieldRef): string {
  const name = ref.tableAlias ? `${ref.tableAlias}.${ref.field}` : ref.field;
  return resolveFieldRef(row, name);
}

// ============================================================
// limit / offset
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
// project — SELECT 列プロジェクション
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
  scalarCache?: Map<number, string>,
  resolveFieldType?: FieldTypeResolver,
  sourceColumns?: readonly string[]
): { rows: ProcessRow[]; columns: string[] } {
  // SELECT * → そのまま全フィールド
  if (columns.length === 1 && columns[0].type === "WILDCARD") {
    const projected = rows.map((row) => stripParentShortcutColumns(row));
    const cols = projected.length > 0 ? Object.keys(projected[0]) : [...(sourceColumns ?? [])];
    return { rows: projected, columns: cols };
  }

  const defaultFieldKeys = buildDefaultFieldOutputKeys(columns);
  const hasWildcard = columns.some(
    (col) => col.type === "WILDCARD" || col.type === "PARENT_WILDCARD"
  );
  const outputKeys = hasWildcard ? null : computeOutputKeys(columns, defaultFieldKeys);
  const orderedKeys: string[] = outputKeys ?? [];

  // 複数列の投影にワイルドカードが混在する場合、実データがあれば従来どおり
  // 行から列を決める。0 行では行ループが回らないため、非ワイルドカード列だけを
  // AST から復元する。* / _p.* は列リストに寄与させない。
  if (hasWildcard && rows.length === 0) {
    return { rows: [], columns: computeExplicitOutputKeys(columns, defaultFieldKeys) };
  }

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
          const key = outputKeys?.[colIdx] ?? col.alias ?? defaultFieldKeys.get(colIdx) ?? col.field;
          out[key] = resolveFieldRef(row, col.field);
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "LITERAL_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? `'${col.value}'`;
          out[key] = col.value;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "AGGREGATE": {
          const srcKey = aggregateSyntheticName(col.func, col.distinct, col.arg);
          const dstKey = outputKeys?.[colIdx] ?? col.alias ?? srcKey;
          out[dstKey] = row[col.alias ?? srcKey] ?? row[srcKey] ?? "0";
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(dstKey);
          break;
        }
        case "ARITH_AGG_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? aggArithDefaultKey(col.expr);
          out[key] = row[key] ?? "0";
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "ARITH_COL": {
          const val = evalArithExpr(col.expr, row);
          const key = outputKeys?.[colIdx] ?? col.alias ?? arithColDefaultKey(col.expr);
          out[key] = String(val);
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "CASE_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? "case";
          out[key] = evalCaseWhen(col.expr, row, resolveFieldType);
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "STRFUNC_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? stringFuncDefaultKey(col.expr);
          if (hasAggregateInStringFuncExpr(col.expr)) {
            const srcKey = stringFuncDefaultKey(col.expr);
            out[key] = row[col.alias ?? srcKey] ?? row[srcKey] ?? evalStringFunc(col.expr, row);
          } else {
            out[key] = evalStringFunc(col.expr, row);
          }
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "SCALAR_SUBQUERY_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? "(subquery)";
          out[key] = scalarCache?.get(colIdx) ?? "";
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "WINDOW_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias;
          out[key] = row[col.alias] ?? "";
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
      }
    }
    return out;
  });

  return { rows: projected, columns: orderedKeys };
}

/** ワイルドカードを含まない SELECT 列の出力キーを AST から算出する。 */
function computeOutputKeys(
  columns: SelectColumn[],
  defaultFieldKeys: Map<number, string>
): string[] {
  return columns.map((col, colIdx) => computeOutputKey(col, colIdx, defaultFieldKeys));
}

/** ワイルドカード混在の 0 行投影で、明示列の出力キーだけを復元する。 */
function computeExplicitOutputKeys(
  columns: SelectColumn[],
  defaultFieldKeys: Map<number, string>
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const [colIdx, col] of columns.entries()) {
    if (col.type === "WILDCARD" || col.type === "PARENT_WILDCARD") continue;
    const key = computeOutputKey(col, colIdx, defaultFieldKeys);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function computeOutputKey(
  col: SelectColumn,
  colIdx: number,
  defaultFieldKeys: Map<number, string>
): string {
  switch (col.type) {
    case "FIELD":
      return col.alias ?? defaultFieldKeys.get(colIdx) ?? col.field;
    case "LITERAL_COL":
      return col.alias ?? `'${col.value}'`;
    case "AGGREGATE":
      return col.alias ?? aggregateSyntheticName(col.func, col.distinct, col.arg);
    case "ARITH_AGG_COL":
      return col.alias ?? aggArithDefaultKey(col.expr);
    case "ARITH_COL":
      return col.alias ?? arithColDefaultKey(col.expr);
    case "CASE_COL":
      return col.alias ?? "case";
    case "STRFUNC_COL":
      return col.alias ?? stringFuncDefaultKey(col.expr);
    case "SCALAR_SUBQUERY_COL":
      return col.alias ?? "(subquery)";
    case "WINDOW_COL":
      return col.alias;
    case "WILDCARD":
    case "PARENT_WILDCARD":
      throw new Error("internal: computeOutputKey received a wildcard column");
  }
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

function resolveAggInStringFuncArg(
  arg: StringFuncArg,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): StringFuncArg {
  if (arg.type === "AGG_REF") {
    const value = evalAggregate(arg.func, arg.distinct, arg.arg, arg.separator, rows, resolveAggSortKind);
    return typeof value === "number" ? { type: "NUMBER", value } : { type: "STRING", value };
  }
  if (arg.type === "AGG_ARITH") {
    return { type: "NUMBER", value: evalAggArithExpr(arg, rows, resolveAggSortKind) };
  }
  if (arg.type === "STRING_FUNC") {
    return resolveAggInStringFuncExpr(arg, rows, resolveAggSortKind);
  }
  return arg;
}

function resolveAggInStringFuncExpr(
  expr: StringFuncExpr,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): StringFuncExpr {
  return {
    type: "STRING_FUNC",
    func: expr.func,
    args: expr.args.map((arg) => resolveAggInStringFuncArg(arg, rows, resolveAggSortKind)),
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
  /** WHERE / SELECT CASE 等、物理行を評価する際のフィールド型解決器 */
  fieldTypeResolver?: FieldTypeResolver;
  /** HAVING 用。集計列 alias を物理フィールドと誤認しない解決器 */
  havingFieldTypeResolver?: FieldTypeResolver;
  /** MIN/MAX の直接フィールド参照用ソート種別解決器。 */
  aggregateSortKindResolver?: AggregateSortKindResolver;
  /** kintone プレフィルタで適用済みの KLIKE ノード。集合外は evalWhere が拒否する。 */
  appliedKlikes?: ReadonlySet<object>;
  /** 単一の実体化ソースが保持する出力列。0 行の単独 SELECT * にのみ使う。 */
  sourceColumns?: readonly string[];
}

/**
 * FULL_SCAN モードの全処理を一気に実行する。
 * テーブルは { alias → KintoneRecord[] } の Map で渡す。
 *
 * 単一テーブル: Map に alias=null で 1エントリ
 * JOIN:        Map に alias ごとのエントリを複数
 */
export function runFullScan(input: FullScanInput): { rows: ProcessRow[]; columns: string[] } {
  const {
    stmt,
    tables,
    scalarCache,
    optionOrders,
    sortKinds,
    fieldTypeResolver,
    havingFieldTypeResolver,
    aggregateSortKindResolver,
    appliedKlikes,
    sourceColumns,
  } = input;

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
  rows = applyFilter(rows, stmt.where, fieldTypeResolver, appliedKlikes);

  // 4. GROUP BY + 集計
  // GROUP BY がなくても集計関数があれば全行を1グループとして集計する
  if (stmt.groupBy.length > 0 || hasAggregateColumns(stmt.columns)) {
    rows = applyGroupBy(rows, stmt.groupBy, stmt.columns, aggregateSortKindResolver);
  }

  // 5. HAVING
  rows = applyHaving(rows, stmt.having, havingFieldTypeResolver);

  // 6. ウィンドウ関数
  rows = applyWindow(rows, stmt.columns, optionOrders, sortKinds);

  // 7. DISTINCT
  if (stmt.distinct) {
    rows = applyDistinct(rows, stmt.columns);
  }

  // 8. ORDER BY
  rows = applyOrderBy(rows, stmt.orderBy, optionOrders, sortKinds);

  // 9. LIMIT / OFFSET
  rows = applyLimit(rows, stmt.limit, stmt.offset);

  // 10. project
  return project(rows, stmt.columns, scalarCache, fieldTypeResolver, sourceColumns);
}
