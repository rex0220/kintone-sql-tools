// ============================================================
// kintone SQL Plugin — AST 型定義
// Phase 1 スコープ対応
// ============================================================

import { toPlainDecimal } from "../core/exactDecimal";

// ------------------------------------------------------------
// トップレベル
// ------------------------------------------------------------

/** FROM なし SELECT を AST 上で表す予約 cteName。 */
export const NO_FROM_CTE_NAME = "__NO_FROM__";

export type Statement =
  | SelectStatement
  | UnionStatement
  | WithStatement
  | InsertStatement
  | InsertSelectStatement
  | UpsertStatement
  | UpsertSelectStatement
  | UpdateStatement
  | DeleteStatement
  | ReorderStatement
  | ValidateStatement
  | ShowAppsStatement
  | DescribeStatement
  | ExplainStatement
  | CreateTempTableStatement
  | DropTempTableStatement
  | SetVariableStatement
  | DeclareVariableStatement
  | AssertStatement
  | ImportStatement;

// ------------------------------------------------------------
// SHOW / DESCRIBE
// ------------------------------------------------------------

/** SHOW APPS — アプリ一覧 */
export interface ShowAppsStatement {
  type: "SHOW_APPS";
}

/** DESCRIBE APP100 — フィールド定義一覧 */
export interface DescribeStatement {
  type: "DESCRIBE";
  appId: number;
}

/** EXPLAIN SELECT / INSERT / UPDATE / DELETE / UPSERT / REORDER ... — 実行計画表示 */
export interface ExplainStatement {
  type: "EXPLAIN";
  query:
    | SelectStatement
    | UnionStatement
    | WithStatement
    | InsertStatement
    | InsertSelectStatement
    | UpsertStatement
    | UpsertSelectStatement
    | UpdateStatement
    | DeleteStatement
    | ReorderStatement
    | ValidateStatement
    | ImportStatement;
}

// ------------------------------------------------------------
// VALIDATE existing records
// ------------------------------------------------------------

/** Existing-record constraint audit. This statement never writes to kintone. */
export type ValidateTarget =
  | { kind: "FIELD"; field: string }
  | { kind: "SUBTABLE"; subtableCode: string; children: string[] };

export interface ValidateStatement {
  type: "VALIDATE";
  appId: number;
  /** Explicit audit targets. Omitted means constraints plus every NUMBER, including subtable children. */
  targets?: ValidateTarget[];
  /** Aggregate violations by record, subtable, field, and error code. */
  summary?: true;
  where: WhereExpr | null;
  checkGroups?: CheckGroup[];
  /** Batch-scoped materialization destination. */
  errorTable?: string;
}

// ------------------------------------------------------------
// 一時テーブル（バッチ内スコープ）
// ------------------------------------------------------------

/** CREATE TEMP TABLE #name AS SELECT ... — SELECT 結果をバッチ内一時テーブルとして実体化 */
export interface CreateTempTableStatement {
  type: "CREATE_TEMP_TABLE";
  name: string; // "#" を含む一時テーブル名（例: "#temp"）
  query: SelectStatement | UnionStatement | WithStatement;
}

/** DROP TEMP TABLE #name — 一時テーブルの明示破棄（バッチ終了時は自動破棄） */
export interface DropTempTableStatement {
  type: "DROP_TEMP_TABLE";
  name: string;
}

// ------------------------------------------------------------
// バッチ変数
// ------------------------------------------------------------

export interface SetVariableStatement {
  type: "SET_VARIABLE";
  /** @ を除き、小文字へ正規化した名前 */
  name: string;
  expr: ScalarExpr | ArrayLiteral;
}

export interface DeclareVariableStatement {
  type: "DECLARE_VARIABLE";
  /** @ を除き、小文字へ正規化した名前 */
  name: string;
  /** 明示された相対日付トークン型。注釈なし DECLARE では存在しない。 */
  annotation?: "RELATIVE_DATE";
  /** 外部注入が無い場合だけ評価する既定値式 */
  default: Exclude<ScalarExpr, ScalarSubquery> | RelativeDateFunction;
}

/** SET RHS 専用。ScalarArithExpr はパーサーがフィールド参照を拒否する。 */
export type ScalarExpr =
  | StringLiteral
  | NumberLiteral
  | LegacyKintoneFunction
  | StringFuncExpr
  | ScalarArithExpr
  | ScalarSubquery;

export type ScalarArithExpr = LegacyArithExpr;

// ------------------------------------------------------------
// ASSERT（アサーション — 実行時ゲート）
// ------------------------------------------------------------

/** ASSERT の比較演算子（BETWEEN は AssertStatement.op で表現） */
export type AssertCompareOp = "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=";

/**
 * ASSERT のオペランド。
 * リテラル・算術式・スカラーサブクエリのみ（FROM コンテキストが無いため
 * フィールド参照は不可。ArithExpr の葉も NUMBER に限る — パーサで検証）
 */
export type AssertOperand =
  | NumberLiteral
  | StringLiteral
  | VariableRef
  | ScalarSubquery
  | LegacyArithExpr;

/**
 * ASSERT <式> <比較演算子> <式> / ASSERT <式> BETWEEN <式> AND <式>
 *
 * op が比較演算子のとき right を使い、BETWEEN のとき low / high を使う。
 */
export interface AssertStatement {
  type: "ASSERT";
  left: AssertOperand;
  op: AssertCompareOp | "BETWEEN";
  right: AssertOperand | null;
  low: AssertOperand | null;
  high: AssertOperand | null;
  /** 条件部の正規化テキスト（AssertError の "assertion failed: ..." メッセージ用） */
  text: string;
}

// ------------------------------------------------------------
// WITH 句（CTE）
// ------------------------------------------------------------

/** WITH name AS (query) の1定義 */
export interface CteDefinition {
  name: string;
  query: SelectStatement | UnionStatement | ShowAppsStatement | DescribeStatement | GenerateSeriesStatement;
}

export type GenerateSeriesArgument = NumberLiteral | StringLiteral | VariableRef;

/** WITH name AS (GENERATE_SERIES(...)) — input record を持たない系列 CTE。 */
export interface GenerateSeriesStatement {
  type: "GENERATE_SERIES";
  args: GenerateSeriesArgument[];
  columnAlias: string;
}

export interface WithStatement {
  type: "WITH";
  ctes: CteDefinition[];
  query: SelectStatement | UnionStatement;
}

// ------------------------------------------------------------
// UNION / UNION ALL
// ------------------------------------------------------------

export interface UnionStatement {
  type: "UNION";
  all: boolean;                          // true = UNION ALL（重複保持）
  left: SelectStatement | UnionStatement; // 左辺（連鎖で再帰的に UNION になる）
  right: SelectStatement;                // 右辺は常に単一 SELECT
}

// ------------------------------------------------------------
// SELECT
// ------------------------------------------------------------

export interface SelectStatement {
  type: "SELECT";
  distinct: boolean;
  columns: SelectColumn[];       // * または フィールド指定
  from: TableRef;
  joins: JoinClause[];
  where: WhereExpr | null;
  groupBy: GroupByKey[];
  /** B65 grouping-set syntax only. Absent for ordinary GROUP BY compatibility. */
  grouping?: GroupingSpec;
  having: WhereExpr | null;
  orderMode: "CANONICAL" | "KINTONE_NATIVE";
  orderBy: OrderByItem[];
  limit: number | null;
  offset: number | null;
}

/** SELECT 句の各カラム */
export type SelectColumn =
  | WildcardColumn          // *
  | ParentWildcardColumn    // _p.*
  | FieldColumn             // フィールド名 [AS alias]
  | LiteralColumn           // 'text' [AS alias]
  | AggregateColumn         // COUNT(*) / SUM(f) / ...
  | AggArithColumn          // SUM(f) * 1.1 [AS alias]
  | ArithColumn             // field * 1.1 [AS alias]
  | CaseColumn              // CASE WHEN ... END [AS alias]
  | StringFuncColumn        // UPPER(f) / CONCAT(a,b) / ... [AS alias]
  | ScalarValueColumn       // a || b / scalar-value arithmetic [AS alias]
  | GroupingColumn          // GROUPING(field) [AS alias]
  | WindowColumn            // ROW_NUMBER() OVER (...) AS alias
  | ScalarSubqueryColumn    // (SELECT ...) [AS alias]
  | VariableColumn;         // @variable AS alias (batch resolver only)

/** SELECT 列別名の SQL 上の表記。照合には引き続き alias の正規形を使う。 */
export interface SelectAliasDisplay {
  aliasDisplay?: string;
}

/** Batch-only SELECT column. Always resolved before execution. */
export interface VariableColumn extends SelectAliasDisplay {
  type: "VARIABLE_COL";
  name: string;
  alias: string;
}

export interface WildcardColumn {
  type: "WILDCARD";
}

/** 親フィールド一括展開（サブテーブル専用）: _p.* */
export interface ParentWildcardColumn {
  type: "PARENT_WILDCARD";
}

export interface FieldColumn extends SelectAliasDisplay {
  type: "FIELD";
  field: Identifier;
  alias: string | null;
}

export interface LiteralColumn extends SelectAliasDisplay {
  type: "LITERAL_COL";
  value: string;
  alias: string | null;
}

export interface AggregateColumn extends SelectAliasDisplay {
  type: "AGGREGATE";
  func: AggregateFunc;
  distinct: boolean;      // COUNT(DISTINCT f)
  arg: WildcardColumn | AggregateArgExpr;  // COUNT(*) → WILDCARD、それ以外は集計引数式
  separator?: string;     // GROUP_CONCAT の区切り文字（未指定時は ","）
  alias: string | null;
}

export type AggregateFunc =
  | "COUNT" | "SUM" | "AVG" | "MAX" | "MIN" | "GROUP_CONCAT"
  | "STDDEV_POP" | "STDDEV_SAMP" | "VAR_POP" | "VAR_SAMP" | "MEDIAN" | "MODE";

export type WindowFunc = "ROW_NUMBER" | "RANK" | "DENSE_RANK";
export type WindowAggFunc = "SUM" | "COUNT" | "AVG" | "MIN" | "MAX";
export type ValueWindowFunc = "LAG" | "LEAD";
export type WindowFrameUnit = "ROWS" | "RANGE";

export interface WindowFrame {
  unit: WindowFrameUnit;
  source: "DEFAULT" | "EXPLICIT";
}

/** 順位系ウィンドウ関数。v1 は出力名の衝突を避けるため alias 必須。 */
export interface RankingWindowColumn extends SelectAliasDisplay {
  type: "WINDOW_COL";
  windowKind?: "RANKING";
  func: WindowFunc;
  partitionBy: FieldRef[];
  orderBy: OrderByItem[];
  alias: string;
}

/** B125 Phase 1 の集計ウィンドウ関数。 */
export interface AggregateWindowColumn extends SelectAliasDisplay {
  type: "WINDOW_COL";
  windowKind: "AGGREGATE";
  aggFunc: WindowAggFunc;
  arg: WildcardColumn | AggregateArgExpr;
  frame: WindowFrame | null;
  partitionBy: FieldRef[];
  orderBy: OrderByItem[];
  alias: string;
}

/** B128 Phase 2a の値参照ウィンドウ関数。 */
export interface ValueWindowColumn extends SelectAliasDisplay {
  type: "WINDOW_COL";
  windowKind: "VALUE";
  valueFunc: ValueWindowFunc;
  arg: ScalarValueExpr;
  offset: number;
  partitionBy: FieldRef[];
  orderBy: OrderByItem[];
  alias: string;
}

export type WindowColumn = RankingWindowColumn | AggregateWindowColumn | ValueWindowColumn;

/** windowKind 未設定の既存 AST も順位系として扱う。 */
export function isRankingWindow(column: WindowColumn): column is RankingWindowColumn {
  return column.windowKind === undefined || column.windowKind === "RANKING";
}

export function isAggregateWindow(column: WindowColumn): column is AggregateWindowColumn {
  return column.windowKind === "AGGREGATE";
}

export function isValueWindow(column: WindowColumn): column is ValueWindowColumn {
  return column.windowKind === "VALUE";
}

/** SELECT 句の算術式カラム: field * 1.1 AS alias / 2 * field / (a+b)*c */
export interface ArithColumn extends SelectAliasDisplay {
  type: "ARITH_COL";
  expr: ArithNode;   // 単独数値・フィールド参照・ネスト式すべて受け入れる
  alias: string | null;
}

// ------------------------------------------------------------
// 文字列関数
// ------------------------------------------------------------

export type StringFuncName =
  | "UPPER" | "LOWER" | "TRIM" | "LTRIM" | "RTRIM"
  | "LENGTH" | "LENGTH_CHAR" | "SUBSTRING" | "CONCAT" | "REPLACE" | "TRANSLATE" | "COALESCE"
  | "REGEXP_LIKE" | "REGEXP_REPLACE" | "REGEXP_SUBSTR"
  | "NULLIF" | "ISNULL" | "LEFT" | "RIGHT" | "INSTR" | "LPAD" | "RPAD"
  | "GREATEST" | "LEAST"
  | "ROUND" | "FLOOR" | "CEIL" | "TRUNCATE"
  | "CAST"  | "FORMAT"
  | "YEAR"  | "MONTH" | "DAY" | "DAYOFWEEK" | "QUARTER" | "WEEK"
  | "DATE_FORMAT" | "DATEDIFF" | "DATE_ADD" | "LAST_DAY"
  | "ABS" | "MOD" | "POWER" | "SQRT"
  | "CURRENT_DATE" | "CURRENT_TIMESTAMP";

/** 文字列関数の引数。集約入り関数の既存構文は AggOperand で保持する。 */
export type StringFuncArg = ScalarValueExpr | AggOperand;

export interface StringFuncExpr {
  type: "STRING_FUNC";
  func: StringFuncName;
  args: StringFuncArg[];
}

/** SELECT 句の文字列関数カラム */
export interface StringFuncColumn extends SelectAliasDisplay {
  type: "STRFUNC_COL";
  expr: StringFuncExpr;
  alias: string | null;
}

/** SELECT 句の汎用スカラー値式カラム。 */
export interface ScalarValueColumn extends SelectAliasDisplay {
  type: "SCALAR_VALUE_COL";
  expr: ScalarValueExpr;
  alias: string | null;
}

/** B65 aggregate-context discriminator. Kept out of the general scalar union. */
export interface GroupingRef {
  type: "GROUPING_REF";
  field: FieldRef;
}

export interface GroupingColumn extends SelectAliasDisplay {
  type: "GROUPING_COL";
  ref: GroupingRef;
  alias: string | null;
}

/** スカラーサブクエリ: (SELECT ...) — 1行1列の値を返す */
export interface ScalarSubquery {
  type: "SCALAR_SUBQUERY";
  query: SelectStatement;
}

/** SELECT 句のスカラーサブクエリカラム: (SELECT ...) [AS alias] */
export interface ScalarSubqueryColumn extends SelectAliasDisplay {
  type: "SCALAR_SUBQUERY_COL";
  query: SelectStatement;
  alias: string | null;
}

// ------------------------------------------------------------
// CASE WHEN
// ------------------------------------------------------------

/** CASE WHEN の THEN / ELSE 結果値 */
export type CaseResult = ArrayLiteral | ScalarValueExpr | ArithNode | AggregateRef | AggArithExpr;

export interface CaseWhenClause {
  condition: WhereExpr;
  result: CaseResult;
}

export interface CaseWhenExpr {
  type: "CASE_WHEN";
  branches: CaseWhenClause[];
  elseResult: CaseResult | null;
}

/** SELECT 句の CASE WHEN カラム */
export interface CaseColumn extends SelectAliasDisplay {
  type: "CASE_COL";
  expr: CaseWhenExpr;
  alias: string | null;
}

// ------------------------------------------------------------
// FROM / JOIN
// ------------------------------------------------------------

/** FROM または JOIN で参照するテーブル（kintone アプリ または CTE） */
export interface TableRef {
  appId: number;          // APP100 → 100。CTE 参照時は 0
  alias: string | null;
  cteName: string | null; // CTE 参照名（FROM cte_name 形式）。通常は null
  subtableCode?: string | null; // APP100$明細 → "明細"
}

export type JoinType = "INNER" | "LEFT" | "RIGHT" | "CROSS";

export type JoinClause =
  | {
      type: "INNER" | "LEFT" | "RIGHT";
      table: TableRef;
      on: JoinCondition;
    }
  | {
      type: "CROSS";
      table: TableRef;
      on: null;
    };

/** ON a.field = b.field 形式のみサポート（Phase 1） */
export interface JoinCondition {
  left: QualifiedIdentifier;   // エイリアス付き: a.顧客ID
  right: QualifiedIdentifier;
}

/** テーブルエイリアス付き識別子 */
export interface QualifiedIdentifier {
  tableAlias: string | null;
  field: string;
}

// ------------------------------------------------------------
// WHERE / HAVING 式
// ------------------------------------------------------------

export type WhereExpr =
  | BinaryExpr       // =, !=, >, <, >=, <=, LIKE, IN
  | NullCheckExpr    // IS NULL / IS NOT NULL
  | LogicalExpr      // AND / OR
  | NotExpr          // NOT
  | GroupExpr        // (...)
  | ExistsExpr       // EXISTS (SELECT ...)
  | BooleanPredicate; // resolved-only constant predicate

/** Internal predicate produced while resolving an empty array variable. */
export interface BooleanPredicate {
  type: "BOOLEAN";
  value: boolean;
}

/** EXISTS (SELECT ...) / NOT EXISTS (SELECT ...) */
export interface ExistsExpr {
  type: "EXISTS";
  not: boolean;
  query: SelectStatement;
}

/** 二項比較 */
export interface BinaryExpr {
  type: "BINARY";
  op: CompareOp;
  left: FieldValue;
  right: SqlValue;
}

export type CompareOp =
  | "=" | "!=" | "<>" | ">" | "<" | ">=" | "<="
  | "LIKE" | "NOT_LIKE" | "KLIKE" | "NOT_KLIKE" | "IN" | "NOT_IN";

/** IS NULL / IS NOT NULL */
export interface NullCheckExpr {
  type: "NULL_CHECK";
  field: FieldValue;
  not: boolean;       // true → IS NOT NULL
}

/** AND / OR */
export interface LogicalExpr {
  type: "LOGICAL";
  op: "AND" | "OR";
  left: WhereExpr;
  right: WhereExpr;
}

/** NOT */
export interface NotExpr {
  type: "NOT";
  expr: WhereExpr;
}

/** 括弧グループ */
export interface GroupExpr {
  type: "GROUP";
  expr: WhereExpr;
}

// ------------------------------------------------------------
// 値
// ------------------------------------------------------------

/** WHERE の左辺 */
export type FieldValue =
  | FieldRef
  | AggregateFieldValue
  | FuncFieldValue
  | ArithFieldValue
  | CaseFieldValue
  | GroupingFieldValue;

/** 通常のフィールド参照: [alias.]field */
export interface FieldRef {
  type: "FIELD";
  tableAlias: string | null;
  field: string;
  /** SELECT CASE 条件・HAVING で合成フィールド名へ変換した集計の評価情報。 */
  aggregateRef?: AggregateRef;
}

/** HAVING 左辺に直接書かれた集計算術式。 */
export interface AggregateFieldValue {
  type: "AGG_FIELD";
  expr: AggOperand;
}

/** 関数呼び出しを LEFT に持つ WHERE 式: UPPER(f) = '...' / LENGTH(f) > 5 */
export interface FuncFieldValue {
  type: "FUNC_FIELD";
  expr: StringFuncExpr;
}

/** 算術式を LEFT に持つ WHERE 式: 金額 * 1.1 > 10000 / (a + b) * c < 100 */
export interface ArithFieldValue {
  type: "ARITH_FIELD";
  expr: ArithNode;
}

/** CASE WHEN を LEFT に持つ WHERE 式: CASE WHEN ... END = '高額' */
export interface CaseFieldValue {
  type: "CASE_FIELD";
  expr: CaseWhenExpr;
}

export interface GroupingFieldValue {
  type: "GROUPING_FIELD";
  ref: GroupingRef;
}

/** WHERE の右辺（リテラル・kintone 関数・算術式・CASE WHEN） */
export type SqlValue =
  | StringLiteral
  | NumberLiteral
  | VariableRef
  | ArrayLiteral
  | KintoneFunction
  | InList
  | SubqueryInList
  | ArithSqlValue
  | CaseSqlValue
  | ScalarSubquery
  | VariableInList;

/** バッチ変数参照。name は @ を除いた小文字。 */
export interface VariableRef {
  type: "VARIABLE";
  name: string;
}

/** Parenthesis-free IN @list batch reference. */
export interface VariableInList {
  type: "VARIABLE_IN_LIST";
  name: string;
}

/** 配列リテラル: ['val1', 'val2'] — INSERT VALUES / UPDATE SET 専用 */
export interface ArrayLiteral {
  type: "ARRAY";
  elements: StringLiteral[];
}

/** 算術式を RIGHT に持つ WHERE 式: WHERE 税込 = 金額 * 1.1 */
export interface ArithSqlValue {
  type: "ARITH_VALUE";
  expr: ArithNode;
}

/** CASE WHEN を RIGHT に持つ式: WHERE 分類 = CASE WHEN ... END */
/** または UPDATE SET 列 = CASE WHEN ... END */
export interface CaseSqlValue {
  type: "CASE_VALUE";
  expr: CaseWhenExpr;
}

export interface StringLiteral {
  type: "STRING";
  value: string;
  /** バッチ変数から解決された値。整数文字列の受理判定にだけ使用する。 */
  fromVariable?: true;
}

export interface NumberLiteral {
  type: "NUMBER";
  value: number;
  /** Original SQL lexeme. Parser-produced nodes always provide this. */
  raw?: string;
}

export function makeNumberLiteral(raw: string): NumberLiteral {
  return { type: "NUMBER", value: Number(raw), raw };
}

export function numberLiteralText(node: NumberLiteral): string {
  // Canonicalize to a plain decimal (no exponent, no leading `+`) so the lexeme
  // never leaks to kintone query/DML, which reject `1e3`/`+5`. Lossless: keeps
  // all digits without Number(). Falls back to the raw text if not finite.
  const source = node.raw ?? String(node.value);
  return toPlainDecimal(source) ?? source;
}

/** Legacy kintone functions. Keep this runtime shape byte-for-byte stable. */
export interface LegacyKintoneFunction {
  type: "KINTONE_FUNC";
  name: "TODAY" | "NOW" | "LOGINUSER" | "PRIMARY_ORGANIZATION";
}

export type RelativeDatePeriodUnit = "DAYS" | "WEEKS" | "MONTHS" | "YEARS";

export type RelativeDateWeekday =
  | "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY"
  | "THURSDAY" | "FRIDAY" | "SATURDAY";

export type RelativeDateMonthDay =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20
  | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31;

/** Server-only relative date functions accepted only by the WHERE value parser. */
export type RelativeDateFunction =
  | {
      type: "KINTONE_FUNC";
      name: "YESTERDAY" | "TOMORROW" | "THIS_YEAR" | "LAST_YEAR" | "NEXT_YEAR";
      args: { kind: "NONE" };
    }
  | {
      type: "KINTONE_FUNC";
      name: "FROM_TODAY";
      args: {
        kind: "FROM_TODAY";
        offset: number;
        offsetText: string;
        unit: RelativeDatePeriodUnit;
      };
    }
  | {
      type: "KINTONE_FUNC";
      name: "THIS_WEEK" | "LAST_WEEK" | "NEXT_WEEK";
      args: { kind: "WEEK"; weekday: RelativeDateWeekday | null };
    }
  | {
      type: "KINTONE_FUNC";
      name: "THIS_MONTH" | "LAST_MONTH" | "NEXT_MONTH";
      args: { kind: "MONTH"; day: RelativeDateMonthDay | "LAST" | null };
    };

export type KintoneFunction = LegacyKintoneFunction | RelativeDateFunction;

/** kintone functions supported as singleton IN-list elements. */
export type InListFunction =
  Omit<LegacyKintoneFunction, "name"> & {
    name: "LOGINUSER" | "PRIMARY_ORGANIZATION";
  };

/** IN (v1, v2, ...) */
export interface InList {
  type: "IN_LIST";
  values: (StringLiteral | NumberLiteral | VariableRef | InListFunction)[];
}

/** IN (SELECT ...) / NOT IN (SELECT ...) */
export interface SubqueryInList {
  type: "SUBQUERY_IN_LIST";
  query: SelectStatement;
  /** サブクエリの結果から取り出す列名（実行時に解決） */
  column: string | null;
}

// ------------------------------------------------------------
// GROUP BY
// ------------------------------------------------------------

/** GROUP BY のキー */
export type GroupByKey =
  | { type: "FIELD_NAME"; name: string }         // GROUP BY フィールド名
  | { type: "ARITH_KEY"; expr: ArithNode }        // GROUP BY 金額 * 1.1
  | { type: "FUNC_KEY";  expr: StringFuncExpr };  // GROUP BY SUBSTRING(作成日時, 1, 7)

/** B65 Phase1 grouping items are physical field references only. */
export type GroupingFieldItem = FieldRef;

export interface GroupingSet {
  items: GroupingFieldItem[];
}

export interface GroupingSpec {
  type: "GROUPING_SETS";
  source: "GROUPING_SETS" | "ROLLUP" | "CUBE";
  allItems: GroupingFieldItem[];
  sets: GroupingSet[];
}

export type NormalizedGroupingSpec =
  | { type: "NONE" }
  | { type: "PLAIN"; allItems: GroupByKey[]; sets: readonly [GroupByKey[]] }
  | {
      type: "GROUPING_SETS";
      source: "GROUPING_SETS" | "ROLLUP" | "CUBE";
      allItems: GroupingFieldItem[];
      sets: GroupingSet[];
    };

// ------------------------------------------------------------
// ORDER BY
// ------------------------------------------------------------

/** ORDER BY のソートキー */
export type OrderByKey =
  | { type: "FIELD_NAME"; name: string }        // ORDER BY 名前 / alias
  | { type: "ARITH_KEY"; expr: ArithNode }       // ORDER BY 金額 * 1.1
  | { type: "FUNC_KEY";  expr: StringFuncExpr }  // ORDER BY UPPER(名前)
  | { type: "GROUPING_KEY"; ref: GroupingRef };  // ORDER BY GROUPING(field)

export interface OrderByItem {
  key: OrderByKey;
  direction: "ASC" | "DESC";
}

// ------------------------------------------------------------
// INSERT
// ------------------------------------------------------------

export interface InsertStatement {
  type: "INSERT";
  appId: number;
  subtableCode?: string | null;
  fields: string[];
  values: InsertRow[];
  applyBlocks?: ApplyBlock[];
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
  checkGroups?: CheckGroup[];
}

/** 1 行分の値リスト */
export type InsertRow = (StringLiteral | NumberLiteral | ArrayLiteral | CaseSqlValue)[];

// ------------------------------------------------------------
// UPSERT
// ------------------------------------------------------------

/**
 * UPSERT INTO APP100 (フィールド1, ...) VALUES (値1, ...) ON DUPLICATE (キーフィールド)
 *
 * キーフィールドの値が一致するレコードが存在すれば UPDATE、なければ INSERT。
 */
export interface UpsertStatement {
  type: "UPSERT";
  appId: number;
  fields: string[];
  values: InsertRow[];
  /** ON DUPLICATE (フィールド名) — 重複判定キー */
  keyFields: string[];
  /** 新規親を作成する分岐のサブテーブル初期行操作。省略時は undefined。 */
  onInsertApplyBlocks?: ApplyBlock[];
  /** 既存親を更新する分岐のサブテーブル操作。省略時は undefined。 */
  onUpdateApplyBlocks?: ApplyBlock[];
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
  checkGroups?: CheckGroup[];
}

// ------------------------------------------------------------
// UPSERT INTO ... SELECT
// ------------------------------------------------------------

export interface UpsertSelectStatement {
  type: "UPSERT_SELECT";
  appId: number;
  fields: string[];
  select: SelectStatement;
  keyFields: string[];
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
  checkGroups?: CheckGroup[];
}

// ------------------------------------------------------------
// INSERT INTO ... SELECT
// ------------------------------------------------------------

export interface InsertSelectStatement {
  type: "INSERT_SELECT";
  appId: number;
  fields: string[];          // ターゲットフィールド（列順）
  select: SelectStatement;   // ソースクエリ
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
  checkGroups?: CheckGroup[];
}

// ------------------------------------------------------------
// IMPORT (B39)
// ------------------------------------------------------------

export type ImportEncoding = "utf8" | "sjis";

export interface CsvDmlSource {
  kind: "CSV";
  sourceName: string;
  /** Omitted means loader metadata, then UTF-8. */
  encoding?: ImportEncoding;
  hasHeader: boolean;
  /** Header mapping policy. POSITION preserves the Phase 1 contract. */
  mappingMode: "POSITION" | "BY_NAME";
  /** BY_NAME-only opt-in for headers absent from the destination form. */
  ignoreUnknownColumns: boolean;
  /** Valid only with NO HEADER. */
  columns?: string[];
  /** CSV-row projection. It is deliberately FROM-less. */
  projection?: SelectStatement;
}

export interface JsonDmlSource {
  kind: "JSON";
  sourceName: string;
}

export type ImportTarget =
  | { kind: "FIELD"; field: string }
  | {
      kind: "SUBTABLE";
      subtableCode: string;
      children: string[];
      /** cli-kintone CSV row-id header. JSON deliberately has no row-id input. */
      rowIdSourceHeader?: string;
    };

/** SELECT remains here so all three DML source paths share one materializer. */
export type DmlSource =
  | { kind: "SELECT"; query: SelectStatement }
  | CsvDmlSource
  | JsonDmlSource;

export interface ImportStatement {
  type: "IMPORT";
  appId: number;
  fields: string[];
  /** Present for Phase 5 syntax; fields remains the top-level-only compatibility view. */
  targets?: ImportTarget[];
  source: CsvDmlSource | JsonDmlSource;
  /** Dedicated pure-UPDATE mode; absence preserves INSERT/UPSERT behavior. */
  writeMode?: "UPDATE_RECORD_NUMBER";
  /** Exact, case-sensitive CSV header used only for record-number lookup. */
  recordNumberSourceHeader?: string;
  /** CSV-only destructive replacement allow-list. */
  replaceSubtables?: string[];
  /** Presence selects UPSERT; absence selects INSERT. */
  keyFields?: string[];
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
  checkGroups?: CheckGroup[];
}

// ------------------------------------------------------------
// UPDATE
// ------------------------------------------------------------

export interface UpdateStatement {
  type: "UPDATE";
  appId: number;
  subtableCode?: string | null;
  assignments: Assignment[];
  where: WhereExpr;   // WHERE 必須（UI で警告）
  /** UPDATE ... FROM source。未指定時は従来の UPDATE。 */
  from?: UpdateFromSource | null;
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
  checkGroups?: CheckGroup[];
  /** UPDATE ... WHERE に続くサブテーブル変更計画。 */
  applyBlocks?: ApplyBlock[];
}

export type ApplyBlock = SubtableApplyBlock | MultiValueApplyBlock;

/** 行操作を持つ SUBTABLE 用 APPLY block。field 型との整合は metadata 解決時に検証する。 */
export interface SubtableApplyBlock {
  field: string;
  targetKind: "SUBTABLE";
  operations: SubtableApplyOperation[];
}

/** 集合要素操作を持つ複数値 field 用 APPLY block。field 型との整合は metadata 解決時に検証する。 */
export interface MultiValueApplyBlock {
  field: string;
  targetKind: "MULTI_VALUE";
  operations: MultiValueApplyOperation[];
}

export type ApplyOperation = SubtableApplyOperation | MultiValueApplyOperation;
export type SubtableApplyOperation = PatchOperation | AppendOperation | RemoveOperation;
export type MultiValueApplyOperation = AddOperation | RemoveValueOperation;

export interface PatchOperation {
  kind: "PATCH";
  assignments: Assignment[];
  selector: RowSelector;
  expectRows?: ExpectRowsGuard;
}

/** v1.1 用の構文ノード。Phase 1 では scope validator が実行を拒否する。 */
export interface AppendOperation {
  kind: "APPEND";
  fields: string[];
  values: InsertRow[];
}

/** v1.2 用の構文ノード。Phase 1 では scope validator が実行を拒否する。 */
export interface RemoveOperation {
  kind: "REMOVE";
  selector: RowSelector;
  expectRows?: ExpectRowsGuard;
}

/** 複数値 field の集合へ文字列値を追加する。実 mutation は Phase 15b で接続する。 */
export interface AddOperation {
  kind: "ADD";
  value: string;
}

/** 複数値 field の集合から文字列値を除去する。行 REMOVE とは別 node。 */
export interface RemoveValueOperation {
  kind: "REMOVE_VALUE";
  value: string;
}

export type RowSelector =
  | { kind: "WHERE"; where: WhereExpr }
  | { kind: "ALL_ROWS" };

export type ExpectRowsGuard =
  | { kind: "EXACT"; count: number }
  | { kind: "BETWEEN"; min: number; max: number }
  | { kind: "AT_LEAST"; count: number }
  | { kind: "AT_MOST"; count: number };

export interface CheckGroup {
  rules: CheckRule[];
}

export interface CheckRule {
  condition: WhereExpr;
  message: ScalarValueExpr;
}

export interface Assignment {
  field: string;
  value: AssignmentValue;
}

/** UPDATE ... FROM のソース（v1 は #temp または実アプリのみ）。 */
export interface UpdateFromSource {
  /** 実アプリ ID。#temp の場合は 0。 */
  appId: number;
  /** #temp 名。実アプリの場合は null。collectRefs が参照を検出する既存キー名を踏襲。 */
  cteName: string | null;
  alias: string;
  /** 更新先の結合キー。v1 のレコード番号結合は "$id"。 */
  targetJoinField: string;
  joinKeyField: string;
  targetFilter: WhereExpr | null;
}

/** UPDATE ... FROM の SET 右辺で参照するソース列。 */
export interface SourceFieldValue {
  type: "SOURCE_FIELD";
  alias: string;
  field: string;
}

/** UPDATE SET 専用。文字列関数は行ごとに現在値を参照して評価する。 */
export type AssignmentValue = SqlValue | LegacyArithExpr | StringFuncExpr | ConcatExpr | ArithExpr | SourceFieldValue;

// ------------------------------------------------------------
// 算術式（UPDATE SET のみ）
// SET 金額 = 金額 * 1.1  →  left=FieldRef, op="*", right=NumberLiteral
// ------------------------------------------------------------

export type ArithOp = "+" | "-" | "*" | "/" | "%";

/**
 * 算術ノード（再帰型）
 *   FIELD_REF:   フィールド参照
 *   NUMBER:      数値リテラル
 *   ARITH:       ネストした算術式  例: (金額 + 消費税) * 1.1
 *   STRING_FUNC: 関数呼び出し結果を数値として使う  例: ROUND(f)/2, LENGTH(s)*100
 *   VARIABLE:    バッチ変数参照（実行前に数値リテラルへ解決される）
 */
export type ArithNode =
  | { type: "FIELD_REF"; field: string }
  | NumberLiteral
  | LegacyArithExpr
  | StringFuncExpr
  | VariableRef;

/** 後方互換エイリアス */
export type ArithOperand = ArithNode;

export interface LegacyArithExpr {
  type: "ARITH";
  left: ArithNode;
  op: ArithOp;
  right: ArithNode;
}

// ------------------------------------------------------------
// 汎用スカラー値式（B38）
// ------------------------------------------------------------

/** 値レベルのスカラー式。比較・述語・集約・サブクエリは含めない。 */
export type ScalarValueExpr =
  | StringLiteral
  | NumberLiteral
  | FieldRef
  | VariableRef
  | StringFuncExpr
  | ArithExpr
  | ConcatExpr
  | CaseWhenExpr;

/** 集計引数。既存 SQL は ArithNode のまま保持し、新規の値式だけ ScalarValueExpr を使う。 */
export type AggregateArgExpr = ArithNode | ScalarValueExpr;

/** ScalarValueExpr 専用の算術式。旧 ArithNode/LegacyArithExpr とは分離する。 */
export interface ArithExpr {
  type: "SCALAR_ARITH";
  left: ScalarValueExpr;
  op: ArithOp;
  right: ScalarValueExpr;
}

export interface ConcatExpr {
  type: "CONCAT_OP";
  left: ScalarValueExpr;
  right: ScalarValueExpr;
}

/** 仕様上の CaseExpr 名。既存 CASE AST をそのまま再利用する。 */
export type CaseExpr = CaseWhenExpr;

// ------------------------------------------------------------
// DELETE
// ------------------------------------------------------------

export interface DeleteStatement {
  type: "DELETE";
  appId: number;
  subtableCode?: string | null;
  where: WhereExpr;   // WHERE なしは禁止（パーサーがエラー）
}

// ------------------------------------------------------------
// REORDER（サブテーブル並び替え）
// ------------------------------------------------------------

export interface ReorderStatement {
  type: "REORDER";
  appId: number;
  subtableCode: string;
  all: boolean;
  by: OrderByItem[];
  where: WhereExpr | null;
}

// ------------------------------------------------------------
// 集計算術式（SELECT 句: SUM(金額) * 1.1 等）
// ------------------------------------------------------------

/** 集計算術式のオペランド */
export type AggOperand =
  | AggregateRef   // SUM(金額), COUNT(*) など
  | NumberLiteral  // 数値リテラル
  | AggGroupKeyRef // ordinary GROUP BY キーとして検証済みのフィールド参照
  | VariableRef    // @変数（実行前に NumberLiteral へ解決）
  | AggArithExpr;  // ネスト

/** ordinary GROUP BY キーとして表記一致を検証済みのフィールド参照。 */
export interface AggGroupKeyRef {
  type: "AGG_GROUP_KEY";
  field: string;
  tableAlias?: string;
}

/** 集計関数への参照（算術式の被演算子として使う） */
export interface AggregateRef {
  type: "AGG_REF";
  func: AggregateFunc;
  distinct: boolean;
  arg: WildcardColumn | AggregateArgExpr;
  separator?: string;
}

/** 集計結果を含む算術式（再帰型） */
export interface AggArithExpr {
  type: "AGG_ARITH";
  left: AggOperand;
  op: ArithOp;
  right: AggOperand;
}

/** SELECT 句の集計算術式カラム: SUM(金額) * 1.1 [AS alias] */
export interface AggArithColumn extends SelectAliasDisplay {
  type: "ARITH_AGG_COL";
  expr: AggOperand;
  alias: string | null;
}

// ------------------------------------------------------------
// 共通
// ------------------------------------------------------------

/** クォートなし識別子（日本語含む） */
export type Identifier = string;
