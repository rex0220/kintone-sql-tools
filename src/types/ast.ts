// ============================================================
// kintone SQL Plugin — AST 型定義
// Phase 1 スコープ対応
// ============================================================

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
  | ShowAppsStatement
  | DescribeStatement
  | ExplainStatement
  | CreateTempTableStatement
  | DropTempTableStatement
  | SetVariableStatement
  | DeclareVariableStatement
  | AssertStatement;

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
    | ReorderStatement;
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
  expr: ScalarExpr;
}

export interface DeclareVariableStatement {
  type: "DECLARE_VARIABLE";
  /** @ を除き、小文字へ正規化した名前 */
  name: string;
  /** 外部注入が無い場合だけ評価する既定値式 */
  default: Exclude<ScalarExpr, ScalarSubquery>;
}

/** SET RHS 専用。ScalarArithExpr はパーサーがフィールド参照を拒否する。 */
export type ScalarExpr =
  | StringLiteral
  | NumberLiteral
  | KintoneFunction
  | StringFuncExpr
  | ScalarArithExpr
  | ScalarSubquery;

export type ScalarArithExpr = ArithExpr;

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
  | ArithExpr;

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
  query: SelectStatement | UnionStatement | ShowAppsStatement | DescribeStatement;
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
  having: WhereExpr | null;
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
  | ScalarSubqueryColumn;   // (SELECT ...) [AS alias]

export interface WildcardColumn {
  type: "WILDCARD";
}

/** 親フィールド一括展開（サブテーブル専用）: _p.* */
export interface ParentWildcardColumn {
  type: "PARENT_WILDCARD";
}

export interface FieldColumn {
  type: "FIELD";
  field: Identifier;
  alias: string | null;
}

export interface LiteralColumn {
  type: "LITERAL_COL";
  value: string;
  alias: string | null;
}

export interface AggregateColumn {
  type: "AGGREGATE";
  func: AggregateFunc;    // COUNT / SUM / AVG / MAX / MIN / GROUP_CONCAT
  distinct: boolean;      // COUNT(DISTINCT f)
  arg: WildcardColumn | ArithNode;  // COUNT(*) → WILDCARD、それ以外は算術式
  separator?: string;     // GROUP_CONCAT の区切り文字（未指定時は ","）
  alias: string | null;
}

export type AggregateFunc = "COUNT" | "SUM" | "AVG" | "MAX" | "MIN" | "GROUP_CONCAT";

/** SELECT 句の算術式カラム: field * 1.1 AS alias / 2 * field / (a+b)*c */
export interface ArithColumn {
  type: "ARITH_COL";
  expr: ArithNode;   // 単独数値・フィールド参照・ネスト式すべて受け入れる
  alias: string | null;
}

// ------------------------------------------------------------
// 文字列関数
// ------------------------------------------------------------

export type StringFuncName =
  | "UPPER" | "LOWER" | "TRIM" | "LTRIM" | "RTRIM"
  | "LENGTH" | "SUBSTRING" | "CONCAT" | "REPLACE" | "COALESCE"
  | "NULLIF" | "ISNULL"
  | "ROUND" | "FLOOR" | "CEIL"
  | "CAST"  | "FORMAT"
  | "YEAR"  | "MONTH" | "DAY"
  | "DATE_FORMAT" | "DATEDIFF" | "DATE_ADD"
  | "ABS" | "MOD" | "POWER" | "SQRT"
  | "CURRENT_DATE" | "CURRENT_TIMESTAMP";

/** 文字列関数の引数: 文字列リテラル / 算術ノード / ネストした文字列関数 / 集計算術 */
export type StringFuncArg = StringLiteral | ArithNode | StringFuncExpr | AggOperand;

export interface StringFuncExpr {
  type: "STRING_FUNC";
  func: StringFuncName;
  args: StringFuncArg[];
}

/** SELECT 句の文字列関数カラム */
export interface StringFuncColumn {
  type: "STRFUNC_COL";
  expr: StringFuncExpr;
  alias: string | null;
}

/** スカラーサブクエリ: (SELECT ...) — 1行1列の値を返す */
export interface ScalarSubquery {
  type: "SCALAR_SUBQUERY";
  query: SelectStatement;
}

/** SELECT 句のスカラーサブクエリカラム: (SELECT ...) [AS alias] */
export interface ScalarSubqueryColumn {
  type: "SCALAR_SUBQUERY_COL";
  query: SelectStatement;
  alias: string | null;
}

// ------------------------------------------------------------
// CASE WHEN
// ------------------------------------------------------------

/** CASE WHEN の THEN / ELSE 結果値 */
export type CaseResult = StringLiteral | ArrayLiteral | ArithNode | StringFuncExpr;

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
export interface CaseColumn {
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

export type JoinType = "INNER" | "LEFT" | "RIGHT";

export interface JoinClause {
  type: JoinType;
  table: TableRef;
  on: JoinCondition;
}

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
  | ExistsExpr;      // EXISTS (SELECT ...)

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
export type FieldValue = FieldRef | FuncFieldValue | ArithFieldValue | CaseFieldValue;

/** 通常のフィールド参照: [alias.]field */
export interface FieldRef {
  type: "FIELD";
  tableAlias: string | null;
  field: string;
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
  | ScalarSubquery;

/** バッチ変数参照。name は @ を除いた小文字。 */
export interface VariableRef {
  type: "VARIABLE";
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
}

export interface NumberLiteral {
  type: "NUMBER";
  value: number;
}

/** kintone 専用関数: TODAY() / NOW() / LOGINUSER() */
export interface KintoneFunction {
  type: "KINTONE_FUNC";
  name: "TODAY" | "NOW" | "LOGINUSER";
}

/** IN (v1, v2, ...) */
export interface InList {
  type: "IN_LIST";
  values: (StringLiteral | NumberLiteral | VariableRef)[];
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

// ------------------------------------------------------------
// ORDER BY
// ------------------------------------------------------------

/** ORDER BY のソートキー */
export type OrderByKey =
  | { type: "FIELD_NAME"; name: string }        // ORDER BY 名前 / alias
  | { type: "ARITH_KEY"; expr: ArithNode }       // ORDER BY 金額 * 1.1
  | { type: "FUNC_KEY";  expr: StringFuncExpr }; // ORDER BY UPPER(名前)

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
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
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
  validateOnly?: boolean;
  validationErrorTable?: string | null;
  onErrorSkip?: boolean;
  errorTable?: string;
  rejectLimit?: number | null;
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

export type AssignmentValue = SqlValue | ArithExpr | SourceFieldValue;

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
 */
export type ArithNode =
  | { type: "FIELD_REF"; field: string }
  | NumberLiteral
  | ArithExpr
  | StringFuncExpr;

/** 後方互換エイリアス */
export type ArithOperand = ArithNode;

export interface ArithExpr {
  type: "ARITH";
  left: ArithNode;
  op: ArithOp;
  right: ArithNode;
}

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
  | AggArithExpr;  // ネスト

/** 集計関数への参照（算術式の被演算子として使う） */
export interface AggregateRef {
  type: "AGG_REF";
  func: AggregateFunc;
  distinct: boolean;
  arg: WildcardColumn | ArithNode;
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
export interface AggArithColumn {
  type: "ARITH_AGG_COL";
  expr: AggOperand;
  alias: string | null;
}

// ------------------------------------------------------------
// 共通
// ------------------------------------------------------------

/** クォートなし識別子（日本語含む） */
export type Identifier = string;
