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

export interface KintoneNativeUpdateKey {
  field: string;
  value: string;
}

export interface KintoneNativeUpsertRecord {
  updateKey: KintoneNativeUpdateKey;
  record: KintoneRecord;
}

export interface KintoneNativeUpsertParams {
  app: number;
  upsert: true;
  records: KintoneNativeUpsertRecord[];
}

export interface KintoneNativeUpsertRecordResult {
  id: string;
  revision: string;
  operation: "INSERT" | "UPDATE";
}

export interface KintoneNativeUpsertResult {
  records: KintoneNativeUpsertRecordResult[];
}

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
  upsertRecords?(params: KintoneNativeUpsertParams): Promise<KintoneNativeUpsertResult>;
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

export type ImportEncoding = "utf8" | "sjis";

export interface FlowImportSourcePayload {
  readonly bytes: Uint8Array;
  readonly encoding?: ImportEncoding;
}

export interface FlowImportSourceLoader {
  load(): Promise<FlowImportSourcePayload>;
}

/** Exact, case-sensitive SQL source name to lazy, path-free loader. */
export type FlowImportSourceResolver = (
  name: string
) => FlowImportSourceLoader | undefined;

export interface FlowNamedImportSource {
  readonly name: string;
  readonly loader: FlowImportSourceLoader;
}

export type FlowImportProviderErrorCode =
  | "ImportSourceReadError"
  | "ImportSourceNotRegularFileError";

export interface ParseScriptOptions {
  apps?: Readonly<Record<string, number>>;
  /** Omitted/false keeps IMPORT unavailable and preserves KSQL1202. */
  enableImport?: boolean;
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
  /** /flow 本実行を想定する native UPSERT 設定。省略時は有効、false は opt-out。 */
  enableNativeUpsert?: boolean;
  variables?: Readonly<Record<string, string>>;
  /** dialect 1 の @ 付き時刻関数が共有する explain 呼出し単位の基準時刻。 */
  asOf?: Date;
  /** @TODAY() などの暦日境界に使う IANA timezone。省略時はホスト timezone。 */
  timezone?: string;
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
  /** Named, path-free source resolver. It never enables IMPORT implicitly. */
  importSource?: FlowImportSourceResolver;
  /** 素の UPSERT で native UPSERT を許可する。省略時は true。 */
  enableNativeUpsert?: boolean;
  /**
   * 書込 API の各成功直後に await される。順序は現在の書込順であり、キー順は保証しない。
   * コールバックが throw した場合、その文は error になるが、通知対象チャンクは書込済み。
   */
  onChunkWritten?: (info: FlowChunkWrittenInfo) => void | Promise<void>;
}

export interface FlowChunkWrittenInfo {
  /** バッチ内の文 index（0 始まり）。 */
  statementIndex: number;
  /** 書込 API に渡される物理アプリ ID（LAPP は解決済み）。 */
  appId: number;
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  records: number;
  /** その文で成功した書込 API リクエストの index（0 始まり）。 */
  chunkIndex: number;
  /** 単一キー UPSERT でキー値を payload から特定できる場合のみ設定される。 */
  lastKeyValue?: string;
  insertedCount?: number;
  updatedCount?: number;
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
  /** upsertRecords の呼出し回数。putCalls の内数。 */
  nativeUpsertCalls: number;
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

export interface FlowInsertResult {
  type: "INSERT";
  createdIds: string[][];
  insertedCount: number;
}

export interface FlowUpdateResult {
  type: "UPDATE";
  updatedCount: number;
}

export interface FlowDeleteResult {
  type: "DELETE";
  deletedCount: number;
}

export interface FlowUpsertResult {
  type: "UPSERT";
  insertedCount: number;
  updatedCount: number;
}

/**
 * /flow が安定契約とする通常 DML 結果。
 * 実体に APPLY / IMPORT 系の任意フィールドが載っていても、それらはこの契約の対象外。
 */
export type FlowDmlResult =
  | FlowInsertResult
  | FlowUpdateResult
  | FlowDeleteResult
  | FlowUpsertResult;

export function isDmlResult(result: unknown): result is FlowDmlResult {
  if (result === null || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  switch (value.type) {
    case "INSERT":
      return Array.isArray(value.createdIds)
        && value.createdIds.every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))
        && typeof value.insertedCount === "number";
    case "UPDATE": return typeof value.updatedCount === "number";
    case "DELETE": return typeof value.deletedCount === "number";
    case "UPSERT":
      return typeof value.insertedCount === "number" && typeof value.updatedCount === "number";
    default: return false;
  }
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
  /** コンテキスト開始から当該文終了時までの累積 deep-copy スナップショット。文単位値は前回との差分で求める。 */
  metrics: ExecutionMetrics;
}

export interface PreviewStatementOptions {
  /** Number of write-order samples to return. Defaults to 5. */
  maxSamples?: number;
}

export interface PreviewSample {
  kind: "insert" | "update" | "delete";
  /** UPSERT key, or the kintone record ID for DELETE. */
  key?: string;
  /** Current values of assignment target fields only. */
  before?: Record<string, string>;
  /** Values that the DML statement would write. */
  after?: Record<string, string>;
}

export interface PreviewResult {
  kind: "PREVIEW";
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  /** Physical kintone app ID after logical-app routing. */
  appId: number;
  counts: { insert: number; update: number; delete: number };
  /** First maxSamples entries in actual write order. */
  samples: PreviewSample[];
  /** Record-read API calls consumed by this preview. */
  reads: number;
  /** Estimated 100-record write API calls for an ordinary execution. */
  estimatedWrites: number;
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
