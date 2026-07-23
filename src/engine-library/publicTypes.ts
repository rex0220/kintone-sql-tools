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

export interface QueryColumn {
  name: string;
  valueType: "string";
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
  metrics: QueryMetrics;
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
