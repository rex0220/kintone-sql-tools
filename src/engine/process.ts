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
  AggregateWindowColumn,
  ScalarValueExpr,
  AggregateArgExpr,
  CaseResult,
  AggregateRef,
} from "../types/ast";
import { isRankingWindow, numberLiteralText } from "../types/ast";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type { PlainGroupByResolutionPlan } from "../core/optimization/plainGroupByPlan";
import {
  evalWhere,
  evalCaseWhen,
  ProcessRow,
  type FieldTypeResolver,
  type FieldSemanticsResolver,
} from "./evalWhere";
import {
  evalArithExpr,
  evalStringFunc,
  applyRoundOp,
  resolveFieldRef,
  evalScalarValueExpr,
  evalScalarValueExprNullable,
} from "./evalFunc";
import { compareCanonicalValues, compareCodePointStrings } from "../core/scalarCompare";
import { syntheticSemantics, type ResolvedFieldSemantics } from "../core/fieldSemantics";
import { aggregateOperandLabel, aggregateSyntheticName } from "../core/aggregateExpression";
import {
  B65_MAX_GENERATED_ROWS,
  normalizeGroupingSpec,
  type ResolvedGroupingItem,
  type ResolvedGroupingSpec,
} from "../core/grouping";
import {
  attachGroupingRowMeta,
  evalGroupingRef,
} from "./groupingRowMeta";
import { containsAggregate } from "../core/groupingValidation";

export { ProcessRow };

/** MIN/MAX/MODE の直接フィールド参照に比較 semantics を解決する。 */
export type AggregateSortKindResolver =
  (field: FieldRef) => "number" | "string" | ResolvedFieldSemantics | undefined;

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
  join: JoinClause,
  columns: {
    leftColumns?: readonly string[];
    rightColumns?: readonly string[];
  } = {}
): ProcessRow[] {
  const { on, type: joinType } = join;
  const leftKey  = on.left.tableAlias
    ? `${on.left.tableAlias}.${on.left.field}`
    : on.left.field;
  const rightKey = on.right.tableAlias
    ? `${on.right.tableAlias}.${on.right.field}`
    : on.right.field;

  assertJoinKeyAvailable(leftRows, leftKey, columns.leftColumns);
  assertJoinKeyAvailable(rightRows, rightKey, columns.rightColumns);

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
    for (const key of columns.leftColumns ?? Object.keys(leftRows[0] ?? {})) emptyLeft[key] = "";

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
  for (const key of columns.rightColumns ?? Object.keys(rightRows[0] ?? {})) emptyRight[key] = "";

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

/** JOIN キーの空文字値は許可し、プロパティ自体の欠落だけを拒否する。 */
function assertJoinKeyAvailable(
  rows: readonly ProcessRow[],
  key: string,
  savedColumns?: readonly string[]
): void {
  const missing = rows.length > 0
    ? rows.some((row) => !Object.prototype.hasOwnProperty.call(row, key))
    : savedColumns !== undefined && !savedColumns.includes(key);
  if (missing) {
    throw new Error(`ArgumentError: JOIN key ${key} is not available in the materialized table.`);
  }
}

// ============================================================
// 3. filter — JS 側 WHERE 評価
// ============================================================

export function applyFilter(
  rows: ProcessRow[],
  where: WhereExpr | null,
  resolveFieldType?: FieldTypeResolver,
  appliedKlikes?: ReadonlySet<object>,
  resolveFieldSemantics?: FieldSemanticsResolver
): ProcessRow[] {
  if (where === null) return rows;
  return rows.filter((row) => evalWhere(where, row, resolveFieldType, appliedKlikes, resolveFieldSemantics));
}

// ============================================================
// 4. groupBy + 集計
// ============================================================

/** SELECT 句に集計（AGGREGATE / ARITH_AGG_COL / 集計入り STRFUNC_COL）が含まれるか */
export function hasAggregateColumns(columns: SelectColumn[]): boolean {
  return columns.some((c) =>
    c.type === "AGGREGATE" ||
    c.type === "ARITH_AGG_COL" ||
    (c.type === "CASE_COL" && containsAggregate(c.expr)) ||
    (c.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(c.expr)) ||
    (c.type === "SCALAR_VALUE_COL" && scalarValueHasAggregate(c.expr))
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
  resolveAggSortKind?: AggregateSortKindResolver,
  resolutionPlan?: PlainGroupByResolutionPlan,
  aliasEvaluationContext: SelectColumnEvaluationContext = {}
): ProcessRow[] {
  if (resolutionPlan && resolutionPlan.items.length !== groupByKeys.length) {
    throw new Error("InternalError: plain GROUP BY resolution plan length does not match group keys.");
  }
  // グループキー → 行リスト
  const groups = new Map<string, ProcessRow[]>();
  for (const row of rows) {
    const key = groupByKeys.map((groupKey, index) =>
      evalGroupByKey(
        groupKey,
        row,
        resolutionPlan?.items[index],
        columns,
        aliasEvaluationContext
      )
    ).join("\x00");
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

    materializeAggregateColumns(outRow, groupRows, columns, resolveAggSortKind);

    result.push(outRow);
  }
  return result;
}

interface GroupingBucketNode {
  children: Map<string, GroupingBucketNode>;
  rows?: ProcessRow[];
}

/**
 * Evaluate expanded grouping sets in explicit order. A nested Map is used as a
 * structural tuple key, so embedded NULs or other separators cannot collide.
 * Only the current set's buckets are retained.
 */
export function applyGroupingSets(
  rows: ProcessRow[],
  spec: ResolvedGroupingSpec,
  columns: SelectColumn[],
  resolveAggSortKind?: AggregateSortKindResolver,
  limits: { maxGeneratedRows?: number } = {}
): ProcessRow[] {
  const result: ProcessRow[] = [];
  let generatedRows = 0;
  const countBucket = (): void => {
    generatedRows++;
    if (limits.maxGeneratedRows !== undefined && generatedRows > limits.maxGeneratedRows) {
      throw new Error(
        `LimitError: B65 generated grouping rows ${generatedRows} exceed limit ${limits.maxGeneratedRows} ` +
        "(reason=GROUPING_OUTPUT_LIMIT_EXCEEDED)."
      );
    }
  };

  for (const set of spec.sets) {
    const root: GroupingBucketNode = { children: new Map() };
    const buckets: ProcessRow[][] = [];

    for (const row of rows) {
      let node = root;
      for (const item of set.items) {
        const value = groupingItemValue(item, row);
        let child = node.children.get(value);
        if (!child) {
          child = { children: new Map() };
          node.children.set(value, child);
        }
        node = child;
      }
      if (!node.rows) {
        countBucket();
        node.rows = [];
        buckets.push(node.rows);
      }
      node.rows.push(row);
    }

    // An empty set has one bucket even for empty input. Non-empty sets do not.
    if (rows.length === 0 && set.items.length === 0) {
      countBucket();
      root.rows = [];
      buckets.push(root.rows);
    }

    const includedCanonicalIds = new Set(set.items.map((item) => item.canonicalId));
    for (const groupRows of buckets) {
      const outRow: ProcessRow = { ...groupRows[0] };
      const includedValues = new Map<string, string>();
      for (const item of set.items) {
        if (!includedValues.has(item.canonicalId)) {
          includedValues.set(item.canonicalId, groupingItemValue(item, groupRows[0]));
        }
      }

      // Conservative Step 2 interpretation: only metadata-resolved runtime keys
      // are overwritten. No inferred aliases or ambiguous unqualified bridges.
      for (const item of spec.allItems) {
        const value = includedValues.get(item.canonicalId) ?? "";
        outRow[item.directKey] = value;
        if (item.unqualifiedBridgeKey !== null) {
          outRow[item.unqualifiedBridgeKey] = value;
        }
      }

      materializeAggregateColumns(outRow, groupRows, columns, resolveAggSortKind);
      attachGroupingRowMeta(outRow, includedCanonicalIds);
      result.push(outRow);
    }
  }

  return result;
}

function groupingItemValue(item: ResolvedGroupingItem, row: ProcessRow | undefined): string {
  if (!row) return "";
  return row[item.directKey]
    ?? (item.unqualifiedBridgeKey === null ? undefined : row[item.unqualifiedBridgeKey])
    ?? "";
}

function materializeAggregateColumns(
  outRow: ProcessRow,
  groupRows: ProcessRow[],
  columns: SelectColumn[],
  resolveAggSortKind?: AggregateSortKindResolver
): void {
  for (const [columnIndex, col] of columns.entries()) {
    if (col.type === "AGGREGATE") {
      const syntheticKey = aggregateSyntheticName(col.func, col.distinct, col.arg);
      const value = String(evalAggregate(col.func, col.distinct, col.arg, col.separator, groupRows, resolveAggSortKind));
      outRow[col.alias ?? syntheticKey] = value;
      // HAVING / ORDER BY resolve aggregate expressions through the synthetic key.
      if (col.alias) outRow[syntheticKey] = value;
    } else if (col.type === "ARITH_AGG_COL") {
      materializeAggregateDependencies(outRow, groupRows, col.expr, resolveAggSortKind);
      const outputKey = col.alias ?? aggArithDefaultKey(col.expr);
      outRow[outputKey] = String(evalAggArithExpr(col.expr, groupRows, resolveAggSortKind));
    } else if (col.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(col.expr)) {
      materializeAggregateDependencies(outRow, groupRows, col.expr, resolveAggSortKind);
      const outputKey = col.alias ?? stringFuncDefaultKey(col.expr);
      const resolvedExpr = resolveAggInStringFuncExpr(col.expr, groupRows, resolveAggSortKind);
      outRow[outputKey] = evalStringFunc(resolvedExpr, outRow);
    } else if (col.type === "SCALAR_VALUE_COL" && scalarValueHasAggregate(col.expr)) {
      materializeAggregateDependencies(outRow, groupRows, col.expr, resolveAggSortKind);
      const outputKey = col.alias ?? scalarValueDefaultKey(col.expr);
      const resolvedExpr = resolveAggInScalarValue(col.expr, groupRows, resolveAggSortKind);
      outRow[outputKey] = String(evalScalarValueExpr(resolvedExpr, outRow));
    } else if (col.type === "CASE_COL" && containsAggregate(col.expr)) {
      materializeAggregateDependencies(outRow, groupRows, col.expr, resolveAggSortKind);
      const resolvedExpr = resolveAggInCaseExpr(col.expr, groupRows, resolveAggSortKind);
      const resolveAggregateSemantics: FieldSemanticsResolver = (field) => field.aggregateRef
        ? aggregateResultSemantics(field.aggregateRef, resolveAggSortKind)
        : undefined;
      outRow[caseMaterializedKey(col.alias, columnIndex)] = evalCaseWhen(
        resolvedExpr,
        outRow,
        undefined,
        resolveAggregateSemantics
      );
    }
  }
}

function caseMaterializedKey(alias: string | null, columnIndex: number): string {
  return alias ?? `__ksql_case_column_${columnIndex}`;
}

function collectAggregateRefs(node: unknown, out: AggregateRef[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((value) => collectAggregateRefs(value, out));
    return;
  }
  const value = node as Record<string, unknown>;
  if (value["type"] === "AGG_REF") {
    out.push(value as unknown as AggregateRef);
    return;
  }
  if (value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY") return;
  Object.values(value).forEach((child) => collectAggregateRefs(child, out));
}

function materializeAggregateDependencies(
  outRow: ProcessRow,
  rows: ProcessRow[],
  node: unknown,
  resolveAggSortKind?: AggregateSortKindResolver
): void {
  const refs: AggregateRef[] = [];
  collectAggregateRefs(node, refs);
  for (const ref of refs) {
    const key = aggregateSyntheticName(ref.func, ref.distinct, ref.arg);
    if (outRow[key] !== undefined) continue;
    outRow[key] = String(evalAggregate(
      ref.func,
      ref.distinct,
      ref.arg,
      ref.separator,
      rows,
      resolveAggSortKind
    ));
  }
}

/** GROUP BY キーをグループ分け用文字列に評価する */
function evalGroupByKey(
  key: GroupByKey,
  row: ProcessRow,
  resolution: PlainGroupByResolutionPlan["items"][number] | undefined,
  columns: SelectColumn[],
  aliasEvaluationContext: SelectColumnEvaluationContext
): string {
  if (key.type === "FIELD_NAME") {
    if (!resolution) return row[key.name] ?? "";
    if (resolution.kind === "PHYSICAL") return row[resolution.runtimeKey] ?? "";
    if (resolution.kind === "ALIAS_SAFE") {
      const column = columns[resolution.columnIndex];
      if (!column) {
        throw new Error(
          `InternalError: GROUP BY alias column index ${resolution.columnIndex} is out of range.`
        );
      }
      const value = evaluateSelectColumnValue(
        column,
        row,
        resolution.columnIndex,
        aliasEvaluationContext
      );
      if (typeof value !== "string") {
        throw new Error("InternalError: GROUP BY alias resolved to an expanded SELECT column.");
      }
      return value;
    }
    throw new Error(
      `InternalError: unresolved plain GROUP BY item ${resolution.kind} reached evaluation.`
    );
  }
  if (key.type === "FUNC_KEY")   return evalStringFunc(key.expr, row);
  return String(evalArithExpr(key.expr, row)); // ARITH_KEY
}

// ------------------------------------------------------------
// 集計関数の評価
// ------------------------------------------------------------

function evalAggregate(
  func: AggregateFunc,
  distinct: boolean,
  arg: WildcardColumn | AggregateArgExpr,
  separator: string | undefined,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): number | string {
  // COUNT(*)
  if (arg.type === "WILDCARD") {
    return func === "COUNT" ? rows.length : 0;
  }

  // 各行で arg を評価する。null（スキップ）を一度だけ除去して以降の順序を維持する。
  const strValues = aggregateRowValues(func, arg, rows)
    .filter((value): value is string => value !== null);

  const statistical = func === "STDDEV_POP" || func === "STDDEV_SAMP"
    || func === "VAR_POP" || func === "VAR_SAMP" || func === "MEDIAN";

  // 既存 6 集計は文字列単位、統計集計は Number 化後の数値同値単位で DISTINCT を行う。
  const numericValues = statistical ? strValues.map((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`ArgumentError: ${func} の引数に非数値または非有限の値があります: ${value}`);
    }
    return numeric;
  }) : null;
  const eff = distinct
    ? statistical
      ? [...new Set(numericValues!)]
      : [...new Set(strValues)]
    : statistical ? numericValues! : strValues;

  if (func === "COUNT") return eff.length;
  if (func === "GROUP_CONCAT") return eff.join(separator ?? ",");

  const comparison = (func === "MIN" || func === "MAX" || func === "MODE")
    ? resolveAggregateArgSemantics(arg, resolveAggSortKind)
    : undefined;
  const semantics = typeof comparison === "string"
    ? syntheticSemantics(comparison)
    : comparison ?? (arg.type === "FIELD_REF" || arg.type === "FIELD" || arg.type === "STRING"
      || arg.type === "CONCAT_OP" || arg.type === "CASE_WHEN"
      ? syntheticSemantics("string")
      : syntheticSemantics("number"));
  if (func === "MODE") {
    if (strValues.length === 0) return "";
    const frequencies = new Map<string, number>();
    for (const value of strValues) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
    let result = "";
    let maxFrequency = 0;
    for (const [candidate, frequency] of frequencies) {
      if (frequency > maxFrequency) {
        result = candidate;
        maxFrequency = frequency;
        continue;
      }
      if (frequency !== maxFrequency) continue;
      const canonical = compareCanonicalValues(candidate, result, semantics);
      if (canonical < 0 || (canonical === 0 && compareCodePointStrings(candidate, result) < 0)) {
        result = candidate;
      }
    }
    return result;
  }
  if (func === "MIN" || func === "MAX") {
    const comparableValues = eff as string[];
    if (comparableValues.length === 0) return 0;
    let result = comparableValues[0];
    for (const candidate of comparableValues.slice(1)) {
      const cmp = compareCanonicalValues(candidate, result, semantics);
      if ((func === "MAX" && cmp > 0) || (func === "MIN" && cmp < 0)) result = candidate;
    }
    return result;
  }

  const nums = statistical ? eff as number[] : (eff as string[]).map(Number);
  switch (func) {
    case "SUM": return nums.reduce((a, b) => a + b, 0);
    case "AVG": return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
    case "MEDIAN": {
      if (nums.length === 0) return "";
      const sorted = [...nums].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    case "VAR_POP":
    case "VAR_SAMP":
    case "STDDEV_POP":
    case "STDDEV_SAMP": {
      const sample = func === "VAR_SAMP" || func === "STDDEV_SAMP";
      if (nums.length === 0 || (sample && nums.length < 2)) return "";
      // Welford を先頭値からの差分に適用し、大きな共通オフセットによる丸め誤差を抑える。
      const origin = nums[0];
      let count = 0;
      let mean = 0;
      let m2 = 0;
      for (const rawValue of nums) {
        const value = rawValue - origin;
        count++;
        const delta = value - mean;
        mean += delta / count;
        m2 += delta * (value - mean);
      }
      const variance = Math.max(0, m2 / (sample ? count - 1 : count));
      return func === "STDDEV_POP" || func === "STDDEV_SAMP"
        ? Math.sqrt(variance)
        : variance;
    }
  }
}

/** 行位置を保ったまま集計引数を評価する。null は既存集計規則上のスキップを表す。 */
function aggregateRowValues(
  func: AggregateFunc,
  arg: AggregateArgExpr,
  rows: ProcessRow[]
): (string | null)[] {
  return rows.map((row): string | null => {
    let strVal: string;
    if (arg.type === "FIELD_REF") {
      // 単純フィールド参照: 空文字はスキップ（COUNT(field) の既存動作を維持）
      const raw = row[arg.field];
      if (raw === undefined || (raw === "" && func !== "MIN" && func !== "MAX")) return null;
      strVal = raw;
    } else if (arg.type === "ARITH" || arg.type === "NUMBER") {
      // 算術式: 数値として評価し NaN はスキップ
      const n = evalArithExpr(arg, row);
      if (isNaN(n)) return null;
      strVal = String(n);
    } else {
      const value = evalScalarValueExprNullable(arg, row);
      if (value === null) return null;
      if (value === "" && func !== "MIN" && func !== "MAX") return null;
      if (typeof value === "number" && Number.isNaN(value)) return null;
      strVal = String(value);
    }
    return strVal;
  });
}

function toAggregateFieldRef(field: string): FieldRef {
  const dot = field.indexOf(".");
  return dot > 0
    ? { type: "FIELD", tableAlias: field.slice(0, dot), field: field.slice(dot + 1) }
    : { type: "FIELD", tableAlias: null, field };
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
  return aggregateOperandLabel(node);
}

function resolveAggregateArgSemantics(
  arg: AggregateArgExpr,
  resolver?: AggregateSortKindResolver
): "number" | "string" | ResolvedFieldSemantics | undefined {
  if (arg.type === "FIELD_REF") return resolver?.(toAggregateFieldRef(arg.field)) ?? "string";
  if (arg.type === "FIELD") return resolver?.(arg) ?? "string";
  if (arg.type === "NUMBER" || arg.type === "ARITH" || arg.type === "SCALAR_ARITH") return "number";
  if (arg.type === "STRING" || arg.type === "CONCAT_OP" || arg.type === "VARIABLE") return "string";
  if (arg.type === "STRING_FUNC") {
    const numeric = new Set(["LENGTH", "LENGTH_CHAR", "INSTR", "ROUND", "FLOOR", "CEIL", "TRUNCATE", "YEAR", "MONTH", "DAY", "DATEDIFF", "ABS", "MOD", "POWER", "SQRT", "DAYOFWEEK", "QUARTER", "WEEK"]);
    if (arg.func === "CAST") return arg.args[1]?.type === "STRING" && arg.args[1].value === "NUMBER" ? "number" : "string";
    return numeric.has(arg.func) ? "number" : "string";
  }
  const results = [...arg.branches.map((branch) => branch.result), ...(arg.elseResult === null ? [] : [arg.elseResult])]
    .filter((result) => result.type !== "ARRAY")
    .map((result) => resolveAggregateArgSemantics(result as AggregateArgExpr, resolver));
  if (results.length === 0 || results.some((result) => result === undefined)) return "string";
  const kinds = results.map((result) => typeof result === "string"
    ? result
    : result!.compareMode === "number" || result!.compareMode === "recordNumber" ? "number" : "string");
  if (!kinds.every((kind) => kind === kinds[0])) return "string";
  const first = results[0];
  return results.every((result) => JSON.stringify(result) === JSON.stringify(first)) ? first : kinds[0];
}

function aggregateResultSemantics(
  ref: AggregateRef,
  resolver?: AggregateSortKindResolver
): ResolvedFieldSemantics {
  if (ref.func === "COUNT" || ref.func === "SUM" || ref.func === "AVG"
    || ref.func === "STDDEV_POP" || ref.func === "STDDEV_SAMP"
    || ref.func === "VAR_POP" || ref.func === "VAR_SAMP" || ref.func === "MEDIAN") {
    return syntheticSemantics("number");
  }
  if (ref.func === "GROUP_CONCAT" || ref.func === "MODE") {
    return syntheticSemantics("string");
  }
  const semantics = ref.arg.type === "WILDCARD"
    ? "string"
    : resolveAggregateArgSemantics(ref.arg, resolver) ?? "string";
  return typeof semantics === "string" ? syntheticSemantics(semantics) : semantics;
}

// ============================================================
// 5. having
// ============================================================

export function applyHaving(
  rows: ProcessRow[],
  having: WhereExpr | null,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): ProcessRow[] {
  if (having === null) return rows;
  return rows.filter((row) => evalWhere(having, row, resolveFieldType, undefined, resolveFieldSemantics));
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
  columns: SelectColumn[],
  scalarCache?: Map<number, string>,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): ProcessRow[] {
  if (rows.length === 0) return rows;
  const keyFor = buildDistinctKeyBuilder(rows, columns, {
    scalarCache,
    resolveFieldType,
    resolveFieldSemantics,
  });
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
  columns: SelectColumn[],
  context: SelectColumnEvaluationContext
): (row: ProcessRow) => string {
  // SELECT * → 全行のキー集合の union（後続行にのみ存在するキーも判定に含める）。
  // DISTINCT の既存契約どおり hidden qualified key と _p.* も raw row の一部として扱う。
  let sortedWildcardKeys: string[] = [];
  if (columns.some((c) => c.type === "WILDCARD")) {
    const allKeys = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) allKeys.add(k);
    }
    sortedWildcardKeys = [...allKeys].sort();
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

  const distinctContext: SelectColumnEvaluationContext = {
    ...context,
    wildcardKeys: sortedWildcardKeys,
    parentWildcardKeys: sortedParentKeys,
  };
  return (row) => JSON.stringify(buildDistinctTuple(columns, row, distinctContext));
}

// ============================================================
// orderBy（ウィンドウ内ソートと比較器を共有）
// ============================================================

export type OptionOrderMap = Map<string, Map<string, number>>;
export type FieldSortKindMap = Map<string, "number" | "string">;
export type FieldSemanticsMap = ReadonlyMap<string, ResolvedFieldSemantics>;
export type OrderByAliasEvaluator = (name: string, row: ProcessRow) => string | undefined;

export function applyOrderBy(
  rows: ProcessRow[],
  orderBy: OrderByItem[],
  optionOrders?: OptionOrderMap,
  sortKinds?: FieldSortKindMap,
  fieldSemantics?: FieldSemanticsMap,
  aliasEvaluator?: OrderByAliasEvaluator
): ProcessRow[] {
  if (orderBy.length === 0) return rows;

  return sortDecoratedRows(rows, orderBy, optionOrders, sortKinds, fieldSemantics, aliasEvaluator).rows.map((item) => item.row);
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
  sortKinds?: FieldSortKindMap,
  fieldSemantics?: FieldSemanticsMap,
  aliasEvaluator?: OrderByAliasEvaluator
): DecoratedSortResult {

  // キーごとの比較設定（選択肢順マップ / ソート種別）を 1 回だけ解決
  const keyMeta: SortKeyMeta[] = orderBy.map(({ key }) => {
    if (key.type === "ARITH_KEY") return { semantics: syntheticSemantics("number") };
    if (key.type === "FUNC_KEY") {
      return { semantics: syntheticSemantics(NUMERIC_ORDER_FUNCTIONS.has(key.expr.func) ? "number" : "string") };
    }
    if (key.type === "GROUPING_KEY") return { semantics: syntheticSemantics("number") };
    const semantics = fieldSemantics?.get(key.name);
    if (semantics) return { semantics };
    const orderMap = optionOrders?.get(key.name);
    if (orderMap) {
      return {
        semantics: {
          fieldType: "MULTI_SELECT",
          compareMode: "option",
          inSubtable: false,
          requiresCollectionOperators: false,
          optionOrder: orderMap,
        },
      };
    }
    return { semantics: syntheticSemantics(sortKinds?.get(key.name) ?? "string") };
  });

  // ソートキーを行ごとに前計算する（比較のたびの式評価・数値変換を避ける）
  const decorated: DecoratedSortRow[] = rows.map((row) => ({
    row,
    keys: orderBy.map(({ key }, i): SortKey => {
      const s = evalOrderKey(key, row, aliasEvaluator);
      return { s };
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
  s: string;
}

interface SortKeyMeta {
  semantics: ResolvedFieldSemantics;
}

function compareSortKeys(a: SortKey, b: SortKey, meta: SortKeyMeta): number {
  return compareCanonicalValues(a.s, b.s, meta.semantics);
}

const NUMERIC_ORDER_FUNCTIONS = new Set([
  "LENGTH", "LENGTH_CHAR", "INSTR", "ROUND", "FLOOR", "CEIL", "TRUNCATE",
  "YEAR", "MONTH", "DAY", "DATEDIFF", "ABS", "MOD", "POWER", "SQRT",
  "DAYOFWEEK", "QUARTER", "WEEK",
]);

function evalOrderKey(key: OrderByKey, row: ProcessRow, aliasEvaluator?: OrderByAliasEvaluator): string {
  switch (key.type) {
    case "FIELD_NAME": return aliasEvaluator?.(key.name, row) ?? row[key.name] ?? "";
    case "ARITH_KEY":  return String(evalArithExpr(key.expr, row));
    case "FUNC_KEY":   return evalStringFunc(key.expr, row);
    case "GROUPING_KEY": return evalGroupingRef(key.ref, row);
  }
}

/** SELECT 出力 alias を、project 前の入力行から評価する resolver に事前コンパイルする。 */
export function buildOrderByAliasEvaluator(
  columns: SelectColumn[],
  scalarCache?: Map<number, string>,
  resolveFieldType?: FieldTypeResolver,
  resolveFieldSemantics?: FieldSemanticsResolver
): OrderByAliasEvaluator {
  const evaluators = new Map<string, (row: ProcessRow) => string>();
  for (const [columnIndex, column] of columns.entries()) {
    if (!("alias" in column) || column.alias === null) continue;
    const alias = column.alias;
    switch (column.type) {
      case "FIELD":
        evaluators.set(alias, (row) => resolveFieldRef(row, column.field));
        break;
      case "LITERAL_COL":
        evaluators.set(alias, () => column.value);
        break;
      case "AGGREGATE": {
        const source = aggregateSyntheticName(column.func, column.distinct, column.arg);
        evaluators.set(alias, (row) => row[alias] ?? row[source] ?? "0");
        break;
      }
      case "ARITH_AGG_COL": {
        const source = aggArithDefaultKey(column.expr);
        evaluators.set(alias, (row) => row[alias] ?? row[source] ?? "0");
        break;
      }
      case "WINDOW_COL":
        evaluators.set(alias, (row) => row[alias] ?? "");
        break;
      case "ARITH_COL":
        evaluators.set(alias, (row) => String(evalArithExpr(column.expr, row)));
        break;
      case "STRFUNC_COL": {
        const source = stringFuncDefaultKey(column.expr);
        evaluators.set(alias, (row) => hasAggregateInStringFuncExpr(column.expr)
          ? row[alias] ?? row[source] ?? evalStringFunc(column.expr, row, resolveFieldType, resolveFieldSemantics)
          : evalStringFunc(column.expr, row, resolveFieldType, resolveFieldSemantics));
        break;
      }
      case "CASE_COL":
        evaluators.set(alias, (row) => containsAggregate(column.expr)
          ? row[alias] ?? ""
          : evalCaseWhen(column.expr, row, resolveFieldType, resolveFieldSemantics));
        break;
      case "SCALAR_VALUE_COL": {
        const source = scalarValueDefaultKey(column.expr);
        evaluators.set(alias, (row) => scalarValueHasAggregate(column.expr)
          ? row[alias] ?? row[source] ?? ""
          : String(evalScalarValueExpr(column.expr, row, resolveFieldType, resolveFieldSemantics)));
        break;
      }
      case "SCALAR_SUBQUERY_COL":
        evaluators.set(alias, () => scalarCache?.get(columnIndex) ?? "");
        break;
      case "GROUPING_COL":
        evaluators.set(alias, (row) => evalGroupingRef(column.ref, row));
        break;
      case "VARIABLE_COL":
        break;
    }
  }
  return (name, row) => evaluators.get(name)?.(row);
}

// ============================================================
// window（パイプラインでは HAVING 後・DISTINCT 前）
// ============================================================

/** HAVING 後の同じ入力行集合に対し、各ウィンドウ列を独立に評価する。 */
export function applyWindow(
  rows: ProcessRow[],
  columns: SelectColumn[],
  optionOrders?: OptionOrderMap,
  sortKinds?: FieldSortKindMap,
  fieldSemantics?: FieldSemanticsMap,
  resolveAggSortKind?: AggregateSortKindResolver
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
      const sortedResult = sortDecoratedRows(partition, window.orderBy, optionOrders, sortKinds, fieldSemantics);
      const sorted = sortedResult.rows;
      if (!isRankingWindow(window)) {
        applyAggregateWindow(window, sortedResult, resolveAggSortKind);
        continue;
      }
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

function applyAggregateWindow(
  window: AggregateWindowColumn,
  sortedResult: DecoratedSortResult,
  resolveAggSortKind?: AggregateSortKindResolver
): void {
  const sorted = sortedResult.rows;
  const values = window.arg.type === "WILDCARD"
    ? null
    : aggregateRowValues(window.aggFunc, window.arg, sorted.map((item) => item.row));
  const comparison = window.arg.type === "WILDCARD"
    ? undefined
    : resolveAggregateArgSemantics(window.arg, resolveAggSortKind);
  const semantics = typeof comparison === "string"
    ? syntheticSemantics(comparison)
    : comparison ?? syntheticSemantics("string");
  const output: string[] = [];
  let count = 0;
  let sum = 0;
  let best: string | undefined;

  for (let index = 0; index < sorted.length; index++) {
    const value = values?.[index] ?? null;
    if (window.arg.type === "WILDCARD") {
      count++;
    } else if (value !== null) {
      if (window.aggFunc === "COUNT") {
        count++;
      } else if (window.aggFunc === "SUM" || window.aggFunc === "AVG") {
        sum += Number(value);
        count++;
      } else if (best === undefined) {
        best = value;
      } else {
        const cmp = compareCanonicalValues(value, best, semantics);
        if ((window.aggFunc === "MAX" && cmp > 0) || (window.aggFunc === "MIN" && cmp < 0)) {
          best = value;
        }
      }
    }

    const result = window.aggFunc === "COUNT"
      ? count
      : window.aggFunc === "SUM"
        ? sum
        : window.aggFunc === "AVG"
          ? count === 0 ? 0 : sum / count
          : best ?? 0;
    output.push(String(result));
  }

  if (window.frame === null) {
    const finalValue = output[output.length - 1];
    for (const item of sorted) item.row[window.alias] = finalValue;
    return;
  }
  if (window.frame.unit === "RANGE") {
    for (let start = 0; start < sorted.length;) {
      let end = start;
      while (end + 1 < sorted.length && sortedResult.compare(sorted[end], sorted[end + 1]) === 0) end++;
      for (let index = start; index <= end; index++) sorted[index].row[window.alias] = output[end];
      start = end + 1;
    }
    return;
  }
  for (let index = 0; index < sorted.length; index++) sorted[index].row[window.alias] = output[index];
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

export interface SelectColumnEvaluationContext {
  scalarCache?: Map<number, string>;
  resolveFieldType?: FieldTypeResolver;
  resolveFieldSemantics?: FieldSemanticsResolver;
  /** WILDCARD を固定順で評価する場合のキー。DISTINCT は全行 union を渡す。 */
  wildcardKeys?: readonly string[];
  /** PARENT_WILDCARD を固定順で評価する場合の _p.* キー。 */
  parentWildcardKeys?: readonly string[];
}

interface ExpandedSelectColumnValue {
  kind: "EXPANDED";
  entries: ReadonlyArray<readonly [string, string | null]>;
}

export type SelectColumnValue = string | ExpandedSelectColumnValue;

/**
 * SELECT 列1個を project / DISTINCT 共通の意味論で評価する。
 *
 * 集計を含む列は applyGroupBy()/applyGroupingSets() が materialize 済みの
 * alias / synthetic key を読む。ここでは groupRows を受け取らず、再集計しない。
 */
export function evaluateSelectColumnValue(
  column: SelectColumn,
  row: ProcessRow,
  columnIndex: number,
  context: SelectColumnEvaluationContext = {}
): SelectColumnValue {
  switch (column.type) {
    case "VARIABLE_COL":
      throw new Error(`internal error: unresolved SELECT variable @${column.name}`);
    case "WILDCARD": {
      const keys = context.wildcardKeys ?? Object.keys(row);
      return {
        kind: "EXPANDED",
        entries: keys.map((key) => [key, row[key] !== undefined ? row[key] : null] as const),
      };
    }
    case "PARENT_WILDCARD": {
      const keys = context.parentWildcardKeys
        ?? Object.keys(row).filter((key) => key.startsWith("_p.")).sort();
      return {
        kind: "EXPANDED",
        entries: keys.map((key) => [key, row[key] !== undefined ? row[key] : null] as const),
      };
    }
    case "FIELD":
      return resolveFieldRef(row, column.field);
    case "LITERAL_COL":
      return column.value;
    case "AGGREGATE": {
      const source = aggregateSyntheticName(column.func, column.distinct, column.arg);
      return row[column.alias ?? source] ?? row[source] ?? "0";
    }
    case "ARITH_AGG_COL": {
      const source = column.alias ?? aggArithDefaultKey(column.expr);
      return row[source] ?? "0";
    }
    case "ARITH_COL":
      return String(evalArithExpr(column.expr, row));
    case "CASE_COL":
      return containsAggregate(column.expr)
        ? row[caseMaterializedKey(column.alias, columnIndex)] ?? ""
        : evalCaseWhen(
          column.expr,
          row,
          context.resolveFieldType,
          context.resolveFieldSemantics
        );
    case "GROUPING_COL":
      return evalGroupingRef(column.ref, row);
    case "STRFUNC_COL": {
      const source = stringFuncDefaultKey(column.expr);
      return hasAggregateInStringFuncExpr(column.expr)
        ? row[column.alias ?? source]
          ?? row[source]
          ?? evalStringFunc(
            column.expr,
            row,
            context.resolveFieldType,
            context.resolveFieldSemantics
          )
        : evalStringFunc(
          column.expr,
          row,
          context.resolveFieldType,
          context.resolveFieldSemantics
        );
    }
    case "SCALAR_VALUE_COL": {
      const source = scalarValueDefaultKey(column.expr);
      return scalarValueHasAggregate(column.expr)
        ? row[column.alias ?? source] ?? row[source] ?? ""
        : String(evalScalarValueExpr(
          column.expr,
          row,
          context.resolveFieldType,
          context.resolveFieldSemantics
        ));
    }
    case "SCALAR_SUBQUERY_COL":
      return context.scalarCache?.get(columnIndex) ?? "";
    case "WINDOW_COL":
      return row[column.alias] ?? "";
  }
}

/** SELECT list を列位置順の DISTINCT tuple へ評価する。 */
export function buildDistinctTuple(
  columns: SelectColumn[],
  row: ProcessRow,
  context: SelectColumnEvaluationContext = {}
): readonly unknown[] {
  return columns.map((column, columnIndex) => {
    const value = evaluateSelectColumnValue(column, row, columnIndex, context);
    return typeof value === "string"
      ? value
      : value.entries.map(([, entryValue]) => entryValue);
  });
}

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
  sourceColumns?: readonly string[],
  resolveFieldSemantics?: FieldSemanticsResolver,
  hiddenQualifiedAliases?: ReadonlySet<string>
): { rows: ProcessRow[]; columns: string[] } {
  // SELECT * → そのまま全フィールド
  if (columns.length === 1 && columns[0].type === "WILDCARD") {
    const projected = rows.map((row) => {
      const visible = stripHiddenQualifiedColumns(
        stripParentShortcutColumns(row),
        hiddenQualifiedAliases
      );
      const value = evaluateSelectColumnValue(columns[0], row, 0, {
        wildcardKeys: Object.keys(visible),
      });
      const out: ProcessRow = {};
      if (typeof value !== "string") {
        for (const [key, entryValue] of value.entries) {
          if (entryValue !== null) out[key] = entryValue;
        }
      }
      return out;
    });
    const cols = projected.length > 0 ? Object.keys(projected[0]) : [...(sourceColumns ?? [])];
    return { rows: projected, columns: cols };
  }

  const defaultFieldKeys = buildDefaultFieldOutputKeys(columns);
  const defaultCaseKeys = buildDefaultCaseOutputKeys(columns);
  const hasWildcard = columns.some(
    (col) => col.type === "WILDCARD" || col.type === "PARENT_WILDCARD"
  );
  const outputKeys = hasWildcard ? null : computeOutputKeys(columns, defaultFieldKeys, defaultCaseKeys);
  const orderedKeys: string[] = outputKeys ?? [];

  // 複数列の投影にワイルドカードが混在する場合、実データがあれば従来どおり
  // 行から列を決める。0 行では行ループが回らないため、非ワイルドカード列だけを
  // AST から復元する。* / _p.* は列リストに寄与させない。
  if (hasWildcard && rows.length === 0) {
    return { rows: [], columns: computeExplicitOutputKeys(columns, defaultFieldKeys, defaultCaseKeys) };
  }

  const projected = rows.map((row, rowIdx) => {
    const out: ProcessRow = {};
    const evaluationContext: SelectColumnEvaluationContext = {
      scalarCache,
      resolveFieldType,
      resolveFieldSemantics,
      wildcardKeys: Object.keys(stripHiddenQualifiedColumns(
        stripParentShortcutColumns(row),
        hiddenQualifiedAliases
      )),
      parentWildcardKeys: Object.keys(row).filter((key) => key.startsWith("_p.")).sort(),
    };
    for (const [colIdx, col] of columns.entries()) {
      const value = evaluateSelectColumnValue(col, row, colIdx, evaluationContext);
      switch (col.type) {
        case "VARIABLE_COL":
          // evaluateSelectColumnValue() throws before reaching this branch.
          break;
        case "WILDCARD":
          if (typeof value !== "string") {
            for (const [key, entryValue] of value.entries) {
              if (entryValue !== null) out[key] = entryValue;
            }
          }
          break;
        case "PARENT_WILDCARD": {
          if (typeof value !== "string") {
            for (const [key, entryValue] of value.entries) {
              if (entryValue !== null) out[key] = entryValue;
              if (rowIdx === 0) orderedKeys.push(key);
            }
          }
          break;
        }
        case "FIELD": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? defaultFieldKeys.get(colIdx) ?? col.field;
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "LITERAL_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? `'${col.value}'`;
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "AGGREGATE": {
          const srcKey = aggregateSyntheticName(col.func, col.distinct, col.arg);
          const dstKey = outputKeys?.[colIdx] ?? col.alias ?? srcKey;
          out[dstKey] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(dstKey);
          break;
        }
        case "ARITH_AGG_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? aggArithDefaultKey(col.expr);
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "ARITH_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? arithColDefaultKey(col.expr);
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "CASE_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? defaultCaseKeys.get(colIdx) ?? "case";
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "GROUPING_COL": {
          const key = outputKeys?.[colIdx]
            ?? col.alias
            ?? `GROUPING(${col.ref.field.tableAlias ? `${col.ref.field.tableAlias}.` : ""}${col.ref.field.field})`;
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "STRFUNC_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? stringFuncDefaultKey(col.expr);
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "SCALAR_VALUE_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? scalarValueDefaultKey(col.expr);
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "SCALAR_SUBQUERY_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias ?? "(subquery)";
          out[key] = value as string;
          if (outputKeys === null && rowIdx === 0) orderedKeys.push(key);
          break;
        }
        case "WINDOW_COL": {
          const key = outputKeys?.[colIdx] ?? col.alias;
          out[key] = value as string;
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
  defaultFieldKeys: Map<number, string>,
  defaultCaseKeys: Map<number, string>
): string[] {
  return columns.map((col, colIdx) => computeOutputKey(col, colIdx, defaultFieldKeys, defaultCaseKeys));
}

/** ワイルドカード混在の 0 行投影で、明示列の出力キーだけを復元する。 */
function computeExplicitOutputKeys(
  columns: SelectColumn[],
  defaultFieldKeys: Map<number, string>,
  defaultCaseKeys: Map<number, string>
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const [colIdx, col] of columns.entries()) {
    if (col.type === "WILDCARD" || col.type === "PARENT_WILDCARD") continue;
    const key = computeOutputKey(col, colIdx, defaultFieldKeys, defaultCaseKeys);
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
  defaultFieldKeys: Map<number, string>,
  defaultCaseKeys: Map<number, string>
): string {
  switch (col.type) {
    case "VARIABLE_COL":
      throw new Error(`internal error: unresolved SELECT variable @${col.name}`);
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
      return col.alias ?? defaultCaseKeys.get(colIdx) ?? "case";
    case "STRFUNC_COL":
      return col.alias ?? stringFuncDefaultKey(col.expr);
    case "SCALAR_VALUE_COL":
      return col.alias ?? scalarValueDefaultKey(col.expr);
    case "GROUPING_COL":
      return col.alias ?? `GROUPING(${col.ref.field.tableAlias ? `${col.ref.field.tableAlias}.` : ""}${col.ref.field.field})`;
    case "SCALAR_SUBQUERY_COL":
      return col.alias ?? "(subquery)";
    case "WINDOW_COL":
      return col.alias;
    case "WILDCARD":
    case "PARENT_WILDCARD":
      throw new Error("internal: computeOutputKey received a wildcard column");
  }
}

function buildDefaultCaseOutputKeys(columns: SelectColumn[]): Map<number, string> {
  const used = new Set(columns.flatMap((column) =>
    "alias" in column && column.alias !== null ? [column.alias] : []
  ));
  const keys = new Map<number, string>();
  let suffix = 1;
  for (const [columnIndex, column] of columns.entries()) {
    if (column.type !== "CASE_COL" || column.alias !== null) continue;
    let key: string;
    do {
      key = suffix === 1 ? "case" : `case_${suffix}`;
      suffix++;
    } while (used.has(key));
    used.add(key);
    keys.set(columnIndex, key);
  }
  return keys;
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
    if (n.type === "VARIABLE") throw new Error(
      `InternalError: unresolved arithmetic variable @${n.name} reached arithmetic column labeling.`
    );
    if (n.type === "FIELD_REF")   return n.field;
    if (n.type === "NUMBER")      return numberLiteralText(n);
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
    if (a.type === "AGG_REF" || a.type === "AGG_ARITH") return aggArithDefaultKey(a);
    return scalarValueDefaultKey(a);
  });
  return `${expr.func}(${argStrs.join(",")})`;
}

function scalarValueDefaultKey(expr: ScalarValueExpr): string {
  switch (expr.type) {
    case "STRING": return `'${expr.value}'`;
    case "NUMBER": return numberLiteralText(expr);
    case "VARIABLE": return `@${expr.name}`;
    case "FIELD": return expr.tableAlias ? `${expr.tableAlias}.${expr.field}` : expr.field;
    case "STRING_FUNC": return stringFuncDefaultKey(expr);
    case "CASE_WHEN": return "case";
    case "SCALAR_ARITH": return `${scalarValueDefaultKey(expr.left)}${expr.op}${scalarValueDefaultKey(expr.right)}`;
    case "CONCAT_OP": return `${scalarValueDefaultKey(expr.left)}||${scalarValueDefaultKey(expr.right)}`;
  }
}

function hasAggregateInStringFuncArg(arg: StringFuncArg): boolean {
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
  return scalarValueHasAggregate(arg);
}

function scalarValueHasAggregate(expr: ScalarValueExpr): boolean {
  if (expr.type === "STRING_FUNC") return hasAggregateInStringFuncExpr(expr);
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    return scalarValueHasAggregate(expr.left) || scalarValueHasAggregate(expr.right);
  }
  if (expr.type === "CASE_WHEN") {
    return expr.branches.some((branch) => caseResultHasAggregate(branch.result))
      || (expr.elseResult !== null && caseResultHasAggregate(expr.elseResult));
  }
  return false;
}

function caseResultHasAggregate(result: CaseResult): boolean {
  if (result.type === "AGG_REF" || result.type === "AGG_ARITH") return true;
  if (result.type === "ARRAY" || result.type === "FIELD_REF" || result.type === "ARITH") return false;
  return scalarValueHasAggregate(result);
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
    return typeof value === "number"
      ? { type: "NUMBER", value, raw: String(value) }
      : { type: "STRING", value };
  }
  if (arg.type === "AGG_ARITH") {
    const value = evalAggArithExpr(arg, rows, resolveAggSortKind);
    return { type: "NUMBER", value, raw: String(value) };
  }
  if (arg.type === "STRING_FUNC") {
    return resolveAggInStringFuncExpr(arg, rows, resolveAggSortKind);
  }
  return resolveAggInScalarValue(arg, rows, resolveAggSortKind);
}

function resolveAggInScalarValue(
  expr: ScalarValueExpr,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): ScalarValueExpr {
  if (expr.type === "STRING_FUNC") return resolveAggInStringFuncExpr(expr, rows, resolveAggSortKind);
  if (expr.type === "CASE_WHEN") return resolveAggInCaseExpr(expr, rows, resolveAggSortKind);
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    return {
      ...expr,
      left: resolveAggInScalarValue(expr.left, rows, resolveAggSortKind),
      right: resolveAggInScalarValue(expr.right, rows, resolveAggSortKind),
    };
  }
  return expr;
}

function resolveAggInCaseResult(
  result: CaseResult,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): CaseResult {
  if (result.type === "AGG_REF") {
    const value = evalAggregate(
      result.func,
      result.distinct,
      result.arg,
      result.separator,
      rows,
      resolveAggSortKind
    );
    return typeof value === "number"
      ? { type: "NUMBER", value, raw: String(value) }
      : { type: "STRING", value };
  }
  if (result.type === "AGG_ARITH") {
    const value = evalAggArithExpr(result, rows, resolveAggSortKind);
    return { type: "NUMBER", value, raw: String(value) };
  }
  if (result.type === "ARRAY" || result.type === "FIELD_REF" || result.type === "ARITH") return result;
  return resolveAggInScalarValue(result, rows, resolveAggSortKind);
}

function resolveAggInCaseExpr(
  expr: CaseWhenExpr,
  rows: ProcessRow[],
  resolveAggSortKind?: AggregateSortKindResolver
): CaseWhenExpr {
  return {
    ...expr,
    branches: expr.branches.map((branch) => ({
      ...branch,
      result: resolveAggInCaseResult(branch.result, rows, resolveAggSortKind),
    })),
    elseResult: expr.elseResult === null
      ? null
      : resolveAggInCaseResult(expr.elseResult, rows, resolveAggSortKind),
  };
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
  /** ORDER BY / WINDOW キーごとの共有意味型 */
  orderSemantics?: FieldSemanticsMap;
  /** WHERE / SELECT CASE 等、物理行を評価する際のフィールド型解決器 */
  fieldTypeResolver?: FieldTypeResolver;
  fieldSemanticsResolver?: FieldSemanticsResolver;
  /** HAVING 用。集計列 alias を物理フィールドと誤認しない解決器 */
  havingFieldTypeResolver?: FieldTypeResolver;
  havingFieldSemanticsResolver?: FieldSemanticsResolver;
  /** MIN/MAX/MODE の直接フィールド参照用比較 semantics 解決器。 */
  aggregateSortKindResolver?: AggregateSortKindResolver;
  /** kintone プレフィルタで適用済みの KLIKE ノード。集合外は evalWhere が拒否する。 */
  appliedKlikes?: ReadonlySet<object>;
  /** undefined は元 WHERE、null は残余なし、WhereExpr はその残余だけを評価する。 */
  residualWhere?: WhereExpr | null;
  /** 単一の実体化ソースが保持する出力列。0 行の単独 SELECT * にのみ使う。 */
  sourceColumns?: readonly string[];
  /** 0 行でも JOIN キーを検証するための、alias ごとの保存済みソース列。 */
  tableColumns?: ReadonlyMap<string | null, readonly string[]>;
  /** 実行時だけ補った alias。SELECT * の出力には修飾キーを露出させない。 */
  hiddenQualifiedAliases?: ReadonlySet<string>;
  /** Metadata-resolved B65 identity. Public execution remains gated until Step 3. */
  resolvedGroupingSpec?: ResolvedGroupingSpec;
  /** SELECT-local に確定した B71 plain GROUP BY 解決計画。 */
  plainGroupByPlan?: PlainGroupByResolutionPlan;
}

function stripHiddenQualifiedColumns(
  row: ProcessRow,
  hiddenQualifiedAliases?: ReadonlySet<string>
): ProcessRow {
  if (!hiddenQualifiedAliases || hiddenQualifiedAliases.size === 0) return row;
  const out: ProcessRow = {};
  for (const [key, value] of Object.entries(row)) {
    if ([...hiddenQualifiedAliases].some((alias) => key.startsWith(`${alias}.`))) continue;
    out[key] = value;
  }
  return out;
}

function flattenedColumns(columns: readonly string[] | undefined, alias: string | null): string[] | undefined {
  if (columns === undefined) return undefined;
  return alias
    ? columns.flatMap((column) => [`${alias}.${column}`, column])
    : [...columns];
}

function mergeKnownColumns(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  rows: readonly ProcessRow[]
): string[] | undefined {
  if (left === undefined && right === undefined && rows.length === 0) return undefined;
  return [...new Set([
    ...(left ?? []),
    ...(right ?? []),
    ...Object.keys(rows[0] ?? {}),
  ])];
}

function deriveOutputOrderSemantics(
  columns: SelectColumn[],
  resolveAggSortKind?: AggregateSortKindResolver
): Map<string, ResolvedFieldSemantics> {
  const result = new Map<string, ResolvedFieldSemantics>();
  for (const column of columns) {
    if (!("alias" in column) || !column.alias) continue;
    if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL") {
      result.set(column.alias, syntheticSemantics("number"));
    } else if (column.type === "WINDOW_COL") {
      if (isRankingWindow(column) || column.aggFunc === "COUNT" || column.aggFunc === "SUM" || column.aggFunc === "AVG") {
        result.set(column.alias, syntheticSemantics("number"));
      } else if (column.arg.type !== "WILDCARD") {
        const semantics = resolveAggregateArgSemantics(column.arg, resolveAggSortKind) ?? "string";
        result.set(column.alias, typeof semantics === "string" ? syntheticSemantics(semantics) : semantics);
      }
    } else if (column.type === "AGGREGATE") {
      if (column.func === "COUNT" || column.func === "SUM" || column.func === "AVG"
        || column.func === "STDDEV_POP" || column.func === "STDDEV_SAMP"
        || column.func === "VAR_POP" || column.func === "VAR_SAMP" || column.func === "MEDIAN") {
        result.set(column.alias, syntheticSemantics("number"));
      } else if (column.func === "GROUP_CONCAT") {
        result.set(column.alias, syntheticSemantics("string"));
      }
    } else if (column.type === "LITERAL_COL" || column.type === "CASE_COL" || column.type === "SCALAR_SUBQUERY_COL" || column.type === "SCALAR_VALUE_COL") {
      result.set(column.alias, syntheticSemantics("string"));
    } else if (column.type === "STRFUNC_COL") {
      result.set(column.alias, syntheticSemantics(NUMERIC_ORDER_FUNCTIONS.has(column.expr.func) ? "number" : "string"));
    }
  }
  return result;
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
    orderSemantics,
    fieldTypeResolver,
    fieldSemanticsResolver,
    havingFieldTypeResolver,
    havingFieldSemanticsResolver,
    aggregateSortKindResolver,
    appliedKlikes,
    sourceColumns,
    tableColumns,
    hiddenQualifiedAliases,
    resolvedGroupingSpec,
    plainGroupByPlan,
  } = input;
  const effectiveOrderSemantics = deriveOutputOrderSemantics(stmt.columns, aggregateSortKindResolver);
  for (const [key, value] of orderSemantics ?? []) effectiveOrderSemantics.set(key, value);

  // 1. flatten
  let rows: ProcessRow[] = [];
  const mainAlias = stmt.from.alias;
  const mainRecords = tables.get(mainAlias) ?? tables.get(null) ?? [];
  rows = mainRecords.map((r) => flatten(r, mainAlias));
  let knownColumns = mergeKnownColumns(
    flattenedColumns(tableColumns?.get(mainAlias), mainAlias),
    undefined,
    rows
  );

  // 2. join
  for (const join of stmt.joins) {
    const rightAlias = join.table.alias;
    const rightRecords = tables.get(rightAlias) ?? [];
    const rightRows = rightRecords.map((r) => flatten(r, rightAlias));
    const rightColumns = mergeKnownColumns(
      flattenedColumns(tableColumns?.get(rightAlias), rightAlias),
      undefined,
      rightRows
    );
    rows = applyJoin(rows, rightRows, join, {
      leftColumns: knownColumns,
      rightColumns,
    });
    knownColumns = mergeKnownColumns(knownColumns, rightColumns, rows);
  }

  // 3. filter — JS 側 WHERE 評価
  // JOIN があれば常に適用（kintone クエリでは複数テーブルの結合条件を表現不可）
  // JOIN がなくても WHERE に関数が含まれる場合は kintone 側でフィルタできないため JS で評価
  const filterWhere = input.residualWhere !== undefined ? input.residualWhere : stmt.where;
  rows = applyFilter(rows, filterWhere, fieldTypeResolver, appliedKlikes, fieldSemanticsResolver);

  // 4. GROUP BY + 集計
  // GROUP BY がなくても集計関数があれば全行を1グループとして集計する
  const grouping = normalizeGroupingSpec(stmt);
  if (grouping.type === "GROUPING_SETS") {
    if (!resolvedGroupingSpec) {
      throw new Error("internal error: B65 grouping sets require a metadata-resolved grouping spec.");
    }
    rows = applyGroupingSets(
      rows,
      resolvedGroupingSpec,
      stmt.columns,
      aggregateSortKindResolver,
      { maxGeneratedRows: B65_MAX_GENERATED_ROWS }
    );
  } else if (grouping.type === "PLAIN" || hasAggregateColumns(stmt.columns)) {
    rows = applyGroupBy(
      rows,
      grouping.type === "PLAIN" ? grouping.allItems : [],
      stmt.columns,
      aggregateSortKindResolver,
      grouping.type === "PLAIN" ? plainGroupByPlan : undefined,
      {
        scalarCache,
        resolveFieldType: fieldTypeResolver,
        resolveFieldSemantics: fieldSemanticsResolver,
      }
    );
  }

  // 5. HAVING
  const resolveHavingSemantics: FieldSemanticsResolver = (field) => field.aggregateRef
    ? aggregateResultSemantics(field.aggregateRef, aggregateSortKindResolver)
    : havingFieldSemanticsResolver?.(field);
  rows = applyHaving(rows, stmt.having, havingFieldTypeResolver, resolveHavingSemantics);

  // 6. ウィンドウ関数
  rows = applyWindow(
    rows,
    stmt.columns,
    optionOrders,
    sortKinds,
    effectiveOrderSemantics,
    aggregateSortKindResolver
  );

  // 7. DISTINCT
  if (stmt.distinct) {
    rows = applyDistinct(
      rows,
      stmt.columns,
      scalarCache,
      fieldTypeResolver,
      fieldSemanticsResolver
    );
  }

  // 8. ORDER BY
  rows = applyOrderBy(
    rows,
    stmt.orderBy,
    optionOrders,
    sortKinds,
    effectiveOrderSemantics,
    buildOrderByAliasEvaluator(stmt.columns, scalarCache, fieldTypeResolver, fieldSemanticsResolver)
  );

  // 9. LIMIT / OFFSET
  rows = applyLimit(rows, stmt.limit, stmt.offset);

  // 10. project
  return project(
    rows,
    stmt.columns,
    scalarCache,
    fieldTypeResolver,
    sourceColumns,
    fieldSemanticsResolver,
    hiddenQualifiedAliases
  );
}
