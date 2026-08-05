export interface ReadonlyKintoneFieldValue {
  readonly value: unknown;
}

export type ReadonlyKintoneRecord = Readonly<
  Record<string, ReadonlyKintoneFieldValue>
>;

export interface ReadonlyGetRecordsParams {
  app: number;
  query: string;
  fields: string[];
  totalCount?: boolean;
}

export interface ReadonlyGetRecordsResult {
  records: ReadonlyKintoneRecord[];
  totalCount?: string;
  searchAborted?: boolean;
}

export interface ReadonlyCursorOpenParams {
  app: number;
  fields?: string[];
  query: string;
  size: 500;
}

export interface ReadonlyCursorPage {
  records: ReadonlyKintoneRecord[];
  next: boolean;
}

export interface ReadonlyCursorHandle {
  readonly totalCount: number;
  nextPage(): Promise<ReadonlyCursorPage>;
  close(): Promise<void>;
}

export interface ReadonlyAppInfo {
  appId: number;
  name: string;
  description: string;
}

/**
 * Read-only field metadata supplied to the engine.
 *
 * `VALIDATE` only checks constraints present in this metadata. If a BYO client
 * omits `optionOrder`, `required`, or the min/max metadata below, those
 * constraints are not validated and the result can silently contain zero
 * errors. BYO clients must pass the corresponding values from
 * `/k/v1/app/form/fields.json`.
 *
 * `createReadonlyKintoneClient()` supplies these values automatically, so its
 * users do not need to change their client.
 *
 * To make DESCRIBE report value-origin metadata accurately, BYO clients may
 * also supply the four optional boolean flags below. Omitted flags are shown
 * as empty strings for backward compatibility.
 */
export interface ReadonlyFieldInfo {
  code: string;
  label: string;
  fieldType: string;
  optionOrder?: Record<string, number>;
  sortKind?: "number" | "string";
  required?: boolean;
  minValue?: string;
  maxValue?: string;
  minLength?: string;
  maxLength?: string;
  hasLookup?: boolean;
  isLookupCopyTarget?: boolean;
  isUnique?: boolean;
  isCalculated?: boolean;
  inSubtable?: boolean;
  subtableCode?: string;
}

export type ReadonlyNumberRoundingMode = "HALF_EVEN" | "UP" | "DOWN";

export interface ReadonlyNumberPrecision {
  digits: number;
  decimalPlaces: number;
  roundingMode: ReadonlyNumberRoundingMode;
}

export interface ReadonlyProcessStatusState {
  readonly name: string;
  readonly index: number;
}

export interface ReadonlyProcessStatuses {
  enable: boolean;
  states: ReadonlyProcessStatusState[] | null;
}

export interface ReadonlyKintoneClient {
  getRecords(params: ReadonlyGetRecordsParams): Promise<ReadonlyGetRecordsResult>;
  openCursor(params: ReadonlyCursorOpenParams): Promise<ReadonlyCursorHandle>;
  getApps(): Promise<readonly ReadonlyAppInfo[]>;
  getFields(appId: number): Promise<readonly ReadonlyFieldInfo[]>;
  getNumberPrecision(appId: number): Promise<ReadonlyNumberPrecision>;
  getProcessStatuses(appId: number): Promise<ReadonlyProcessStatuses>;
}

export interface RunQueryOptions {
  client: ReadonlyKintoneClient;
  logicalApps?: Readonly<Record<string, number>>;
  maxRecords?: number;
  onLimitReached?: "error" | "truncate";
  fetchParallel?: number;
  cursorMaxActive?: number;
}

/**
 * Options for one read-only runBatch invocation.
 *
 * Temporary tables and variables exist only for that invocation. A batch is
 * fail-closed: any failed statement makes runBatch throw instead of returning
 * a partial BatchResult.
 */
export interface RunBatchOptions {
  client: ReadonlyKintoneClient;
  logicalApps?: Readonly<Record<string, number>>;
  maxRecords?: number;
  onLimitReached?: "error" | "truncate";
  fetchParallel?: number;
  cursorMaxActive?: number;
  /**
   * DECLARE されたバッチ変数へ渡す文字列値。
   * キーは @ を付けず、大文字小文字を区別しない。SET 変数には注入できない。
   */
  variables?: Readonly<Record<string, string>>;
  /**
   * CREATE TEMP TABLE 1 表あたりの実体化行数上限（既定 10,000）。
   * 超過は onLimitReached: "truncate" でも常に error となる。
   *
   * 一時テーブルは利用者アプリのプロセス内メモリに runBatch 呼び出し単位で実体化される。
   * 同時に存在できるのは最大 16 表で、DROP TEMP TABLE により解放された枠は同じバッチ内で再利用できる。
   */
  tempTableMaxRows?: number;
}

export interface QueryColumn {
  name: string;
  displayName?: string;
  valueType: "string";
  /** 元 kintone フィールド型または導出型（例: NUMBER / DROP_DOWN / KSQL_NUMBER / KSQL_UNKNOWN）。 */
  fieldType?: string;
  /** ソート比較器の種別。undefined の列は文字列比較を既定とする。 */
  sortKind?: "number" | "string";
  /** 非 CTE の直接フィールド参照列（$id 等含む）の参照元アプリ ID。式・集計・CTE 列は undefined。 */
  sourceApp?: number;
}

export interface QueryMetrics {
  recordGetCalls: number;
  fetchedRows: number;
  elapsedMs: number;
  cursorRecordsScanned: number;
  /** 取得上限に達したか。true なら結果は全件ではない。 */
  limitReached?: boolean;
  /** 上限に達したアプリ ID（判明した範囲・重複なし・昇順）。 */
  limitReachedApps?: readonly number[];
}

export type ValidateConstraintCategory = "required" | "length" | "range" | "choice";

export interface ValidateConstraintMetadata {
  /** Constraint categories present on the fields targeted by VALIDATE. */
  present: ValidateConstraintCategory[];
  /** Known constraint categories absent from the fields targeted by VALIDATE. */
  absent: ValidateConstraintCategory[];
}

export interface QueryResult {
  type: "query";
  rows: readonly Readonly<Record<string, string>>[];
  columns: readonly QueryColumn[];
  rowCount: number;
  warnings: readonly string[];
  /** Present only for an existing-record VALIDATE query. */
  validateStats?: {
    errorRecords: number;
    errorCount: number;
    constraintMetadata?: ValidateConstraintMetadata;
  };
  metrics: QueryMetrics;
}

/** Named now so a future DML VALIDATE ONLY result can extend this union additively. */
export type BatchResultItem = QueryResult;

export interface BatchStatementInfo {
  /** Zero-based statement index in the submitted batch. */
  readonly index: number;
  /** Parser statement type, such as SELECT or CREATE_TEMP_TABLE. */
  readonly type: string;
  /**
   * Successful BatchResult values contain successful statements only.
   * A statement error makes runBatch throw instead of returning this DTO.
   */
  readonly status: "success" | "error" | "skipped";
  readonly tempTable?: string;
  readonly rowCount?: number;
  readonly resultIndex?: number;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly skippedReason?: string;
}

/**
 * Successful read-only batch result.
 *
 * There is intentionally no `ok` field: if any statement fails, runBatch
 * throws KsqlEngineError and returns no partial results. The error identifies
 * the failed statement through statementIndex and statementType.
 */
export interface BatchResult {
  readonly type: "batch";
  readonly batch: true;
  readonly statementCount: number;
  readonly statements: readonly BatchStatementInfo[];
  /**
   * Row-returning statement results.
   * Every metrics object is the same batch-wide aggregate, not a per-statement
   * measurement; do not use it to attribute cost to an individual statement.
   */
  readonly results: readonly BatchResultItem[];
  readonly warnings: readonly string[];
}

export interface ExplainResult {
  type: "explain";
  lines: readonly string[];
  text: string;
  plan?: {
    statements: readonly {
      index: number;
      fetch: "none" | "count_only" | "exact" | "prefiltered" | "all";
      sources: readonly {
        app: number;
        alias: string | null;
        role: "main" | "join" | "union" | "cte" | "subquery";
        fetch: "none" | "count_only" | "exact" | "prefiltered" | "all";
        pending: boolean;
        kintoneQuery: string | null;
        limit: number | null;
      }[];
    }[];
  };
  metrics: QueryMetrics;
}

export interface CreateReadonlyKintoneClientOptions {
  cursorMaxActive?: number;
}
