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
}

export interface ReadonlyGetRecordsResult {
  records: ReadonlyKintoneRecord[];
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

export interface ReadonlyFieldInfo {
  code: string;
  label: string;
  fieldType: string;
  optionOrder?: Record<string, number>;
  sortKind?: "number" | "string";
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
  maxRecords?: number;
  onLimitReached?: "error" | "truncate";
  fetchParallel?: number;
  cursorMaxActive?: number;
}

export interface RunBatchOptions {
  client: ReadonlyKintoneClient;
  maxRecords?: number;
  onLimitReached?: "error" | "truncate";
  fetchParallel?: number;
  cursorMaxActive?: number;
}

export interface QueryColumn {
  name: string;
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
}

export interface QueryResult {
  type: "query";
  rows: readonly Readonly<Record<string, string>>[];
  columns: readonly QueryColumn[];
  rowCount: number;
  warnings: readonly string[];
  validateStats?: {
    errorRecords: number;
    errorCount: number;
  };
  metrics: QueryMetrics;
}

/** Named now so a future DML VALIDATE ONLY result can extend this union additively. */
export type BatchResultItem = QueryResult;

export interface BatchStatementInfo {
  readonly index: number;
  readonly type: string;
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

export interface BatchResult {
  readonly type: "batch";
  readonly batch: true;
  readonly ok: boolean;
  readonly statementCount: number;
  readonly statements: readonly BatchStatementInfo[];
  /** 各要素の metrics は文別計測ではなく、同一のバッチ全体集計値。 */
  readonly results: readonly BatchResultItem[];
  readonly warnings: readonly string[];
}

export interface ExplainResult {
  type: "explain";
  lines: readonly string[];
  text: string;
  metrics: QueryMetrics;
}

export interface CreateReadonlyKintoneClientOptions {
  cursorMaxActive?: number;
}
