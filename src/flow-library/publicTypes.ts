import type { Statement } from "../types/ast";

export type { Statement };

export type DiagnosticCode =
  | "KSQL1001" | "KSQL1002" | "KSQL1003" | "KSQL1004" | "KSQL1005" | "KSQL1006"
  | "KSQL1101"
  | "KSQL1201" | "KSQL1202" | "KSQL1203"
  | "KSQL1301" | "KSQL1302" | "KSQL1303" | "KSQL1304" | "KSQL1305" | "KSQL1306";

export interface Diagnostic {
  severity: "error" | "warning";
  code: DiagnosticCode;
  message: string;
  line: number;
  column: number;
  statementIndex?: number;
}

export interface ScriptHeaderMeta {
  name: string | null;
  dependsOn: string[];
  timeout: number | null;
  dialect: 0 | 1;
}

export interface FieldInfo {
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
  defaultValue?: unknown;
  hasLookup?: boolean;
  isLookupCopyTarget?: boolean;
  isUnique?: boolean;
  isCalculated?: boolean;
  inSubtable?: boolean;
  writable?: boolean;
  subtableCode?: string;
}

export interface KintoneRecordValue {
  value: string | string[] | Array<{ code: string }>;
}
export type KintoneRecord = Record<string, KintoneRecordValue>;

export interface FlowKintoneClient {
  getRecords(params: { app: number; query: string; fields: string[]; totalCount?: boolean }): Promise<{
    records: KintoneRecord[];
    totalCount?: string;
    searchAborted?: boolean;
  }>;
  openCursor(params: { app: number; fields?: string[]; query: string; size: 500 }): Promise<{
    readonly totalCount: number;
    nextPage(): Promise<{ records: KintoneRecord[]; next: boolean }>;
    close(): Promise<void>;
  }>;
  postRecords(params: { app: number; records: KintoneRecord[] }): Promise<{ ids: string[] }>;
  putRecords(params: {
    app: number;
    records: Array<{ id: number; revision?: number; record: KintoneRecord }>;
  }): Promise<void>;
  deleteRecords(params: { app: number; ids: number[] }): Promise<void>;
  getApps(): Promise<Array<{ appId: number; name: string; description: string }>>;
  getFields(appId: number): Promise<FieldInfo[]>;
  getNumberPrecision(appId: number): Promise<{
    digits: number;
    decimalPlaces: number;
    roundingMode: "HALF_EVEN" | "UP" | "DOWN";
  }>;
  getProcessStatuses(appId: number): Promise<{
    enable: boolean;
    states: Array<{ name: string; index: number }> | null;
  }>;
}

export type SchemaResolver = (
  appId: number
) => readonly FieldInfo[] | Promise<readonly FieldInfo[]>;

export interface ParseScriptOptions {
  apps?: Readonly<Record<string, number>>;
}

export interface ParseScriptResult {
  meta: ScriptHeaderMeta;
  statements: Statement[];
  statementRanges: Array<{ start: number; end: number }>;
  diagnostics: Diagnostic[];
}

export interface ValidateScriptOptions extends ParseScriptOptions {
  strict?: boolean;
  schema?: SchemaResolver;
  client?: Pick<FlowKintoneClient, "getFields">;
}

export interface ExplainScriptOptions extends ParseScriptOptions {
  client: FlowKintoneClient;
  variables?: Readonly<Record<string, string>>;
  maxRecords?: number;
  cursorMaxActive?: number;
  dmlMaxRows?: number;
  dmlMaxSubtableRows?: number;
  resolveMetadata?: boolean;
  recursiveCteMaxDepth?: number;
  recursiveCteMaxRows?: number;
  recursiveCteMaxExpansions?: number;
}

export interface ExplainScriptResult {
  statementCount: number;
  statements: Array<{ index: number; type: string; plan: string[] }>;
}

export interface CreateExecutionContextOptions extends ParseScriptOptions {
  client: FlowKintoneClient;
  script?: string;
  statements?: readonly Statement[];
  meta?: ScriptHeaderMeta;
  variables?: Readonly<Record<string, string>>;
  maxRecords?: number;
  recursiveCteMaxDepth?: number;
  recursiveCteMaxRows?: number;
  recursiveCteMaxExpansions?: number;
  onLimitReached?: "error" | "truncate";
  fetchParallel?: number;
  cacheContext?: string;
  cursorMaxActive?: number;
  dmlMaxRows?: number;
  dmlMaxSubtableRows?: number;
  tempTableMaxRows?: number;
  timeoutMs?: number;
  asOf?: Date;
  timezone?: string;
  continueOnError?: boolean;
}

declare const executionContextBrand: unique symbol;
/** Opaque, sequential-only statement execution handle. */
export interface ExecutionContext {
  readonly [executionContextBrand]: true;
}

export interface StatementError {
  code: string;
  message: string;
  readonly cause?: unknown;
}

export interface ExecutionMetrics {
  getCalls: number;
  postCalls: number;
  putCalls: number;
  deleteCalls: number;
  fieldCalls: number;
  numberPrecisionCalls: number;
  appsCalls: number;
  processStatusCalls: number;
  cursorCreateCalls: number;
  cursorGetCalls: number;
  cursorDeleteCalls: number;
  cursorRecordsScanned: number;
  cursorActiveCurrent: number;
  cursorActivePeak: number;
  cursorCleanupFailures: number;
  cursorCreateOutcomeUnknown: number;
  cursorQuarantinedCurrent: number;
  fetchedRows: number;
  limitReached: boolean;
  limitReachedApps: number[];
  elapsedMs: number;
}

export type StatementResultKind =
  | "STATEMENT"
  | "ASSERT_PASSED"
  | "ASSERT_WARNING"
  | "ASSERT_VIOLATION"
  | "EXIT_NO_DATA";

export interface StatementResult {
  index: number;
  type: string;
  status: "success" | "error" | "skipped";
  kind: StatementResultKind;
  result?: unknown;
  tempTable?: string;
  rowCount?: number;
  error?: StatementError;
  skippedReason?: string;
  metrics: ExecutionMetrics;
}

export interface CreateKintoneClientConfig {
  baseUrl: string;
  guestSpaceId?: number;
  auth:
    | { type: "apiToken"; apiToken: string | ((appId: number) => string) }
    | { type: "password"; username: string; password: string };
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  cursorMaxActive?: number;
}
