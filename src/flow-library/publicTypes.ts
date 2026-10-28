import type { Statement } from "../types/ast";

export type { Statement };

export type DiagnosticCode =
  | "KSQL1001" | "KSQL1002" | "KSQL1003" | "KSQL1004" | "KSQL1005" | "KSQL1006"
  | "KSQL1101"
  | "KSQL1201" | "KSQL1202" | "KSQL1203"
  | "KSQL1301" | "KSQL1302" | "KSQL1303" | "KSQL1304" | "KSQL1305" | "KSQL1306" | "KSQL1307";

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

/** Browser-neutral CSV export types shared with the engine serializer. */
export type ExportEncoding = import("../export/types").ExportEncoding;
export type FlowCsvExportColumnMeta = import("../export/types").CsvExportColumnMeta;
export type FlowCsvExportInput = import("../export/types").CsvExportInput;
export type FlowExportTextEncoder = import("../export/types").ExportTextEncoder;
export type FlowCsvExportOptions = import("../export/types").CsvExportOptions;
export type FlowCsvExportReceipt = import("../export/types").CsvExportReceipt;
export type FlowCsvExportResult = import("../export/types").CsvExportResult;

export interface FlowNamedExportSink {
  /** Exact, case-sensitive temp-table name without the leading #. */
  readonly name: string;
}

export type FlowExportSinkStatus =
  | "materialized"
  | "not-created"
  | "failed"
  | "incomplete";

export interface FlowImportSourceMaterializedInfo {
  /** バッチ内の文 index。StatementResult.index と同じ0始まり。 */
  readonly statementIndex: number;
  /** SQL の FROM CSV <name> / FROM JSON <name> で指定された source name。 */
  readonly name: string;
  /** materialize した source 種別。 */
  readonly kind: "CSV" | "JSON";
  /** decoder が返した物理 input record 数。CSV は header 除外、JSON は top-level record 数。 */
  readonly rows: number;
  /** SQL、payload、既定値を解決した後の有効文字コード。 */
  readonly encoding: ImportEncoding;
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
  /** `DECLARE` へ注入する値。文字列配列は配列として宣言した変数だけ（B203）。 */
  variables?: Readonly<Record<string, string | readonly string[]>>;
  /** 配列変数の要素数の上限（既定 500。B203） */
  variableArrayMaxElements?: number;
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
  /**
   * `DECLARE` した変数へ注入する値（キーは `@` なし・大文字小文字を区別しない）。
   * **宣言が種類を決めます**（B203）。`DECLARE @x = '…'` にはスカラーの文字列、
   * `DECLARE @ids = [];` には文字列配列を渡してください。食い違いと、文字列以外の要素は
   * `createExecutionContext` が `ArgumentError`（records API 0 回・書込 0 回）。
   * 配列は `IN @ids` / `NOT IN @ids` でだけ使えます（スカラーの位置はエラー）。
   */
  variables?: Readonly<Record<string, string | readonly string[]>>;
  /**
   * 配列変数の要素数の上限（正の安全な整数。省略時は 500。B203）。
   * 注入と `DECLARE` の既定値の両方に効き、超える配列は実行開始前に `ArgumentError`。
   * 要素は kintone へ送るクエリ（URL）の `IN` の並びになるため、長い値を多数渡すと URL が伸びます
   * （3 桁の ID なら 200 件でエンコード後 2.5 KB・500 件で 6.4 KB。日本語は 1 文字 9 字）。
   */
  variableArrayMaxElements?: number;
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
  /**
   * いま残っている一時テーブルの行数の合計の上限（B196。正の安全な整数。省略時は上限なし）。
   * CREATE TEMP TABLE とエラー表（VALIDATE / ON ERROR SKIP の INTO）を数え、DROP TEMP TABLE で外した表は数えない。
   * 登録・追加の前に確かめ、超える文は TempTableTotalLimitError（表は登録・追加しない・書込 0 回）。
   * CREATE TEMP TABLE の読取は min(tempTableMaxRows, 残り) で止める（集計なども読む行数で数える）。
   */
  tempTablesMaxTotalRows?: number;
  timeoutMs?: number;
  asOf?: Date;
  timezone?: string;
  continueOnError?: boolean;
  /** Named CREATE TEMP TABLE outputs made available to the export API. */
  exportSinks?: readonly FlowNamedExportSink[];
  /** Named, path-free source resolver. It never enables IMPORT implicitly. */
  importSource?: FlowImportSourceResolver;
  /**
   * IMPORT source の raw materialize 成功直後、mutation 前に1回 await される。
   * throw/reject は当該文を error にし、その文の mutation は0回となる。
   */
  onImportSourceMaterialized?: (
    info: FlowImportSourceMaterializedInfo
  ) => void | Promise<void>;
  /** 素の UPSERT で native UPSERT を許可する。省略時は true。 */
  enableNativeUpsert?: boolean;
  /**
   * 書込 API の各成功直後に await される。順序は現在の書込順であり、キー順は保証しない。
   * コールバックが throw した場合、その文は error になるが、通知対象チャンクは書込済み。
   */
  onChunkWritten?: (info: FlowChunkWrittenInfo) => void | Promise<void>;
  /**
   * 書込の対象を読み、書く内容を準備した直後・最初の書込 API の前に await される（B195）。
   * true 以外（false・undefined など）は取消＝その文の書込 0 回・`OperationCancelledError`。
   * 省略時は確認なしで書く。IMPORT を含むスクリプトとは併用できない（ArgumentError）。
   * APPLY の書込（allowApplyMutation）では必須で、`applyDetail` が付いて呼ばれる（B198）。
   */
  confirm?: FlowDmlConfirm;
  /**
   * APPLY の書込（サブテーブルの行操作）を許可する（B198。省略・false は従来どおり `UnsupportedError`）。
   * APPLY は不可逆で文がトランザクションでないため、**`confirm` と同時でなければ受けない**（単独で渡すと `ArgumentError`）。
   * 開くのは行の操作の APPLY（`UPDATE` / `INSERT` / `UPSERT`）だけで、
   * 多値 APPLY（チェックボックスなどの値の集合を直す形）は `/flow` では引き続き `UnsupportedError`。
   */
  allowApplyMutation?: boolean;
}

/**
 * APPLY の書込の計画（B198）。確認フックが書く前に受け取る内訳で、`applyDetail` として渡る。
 * 行数はすべて計画済みの実数（親をまたぐ合計ではなくテーブルごと）。
 */
export interface FlowApplyConfirmDetail {
  kind: "APPLY_PATCH" | "APPLY_INSERT" | "APPLY_UPSERT";
  /** 書き込む親レコード数（confirm の count と同じ）。 */
  parentRows: number;
  /** 変わる子行の数（PATCH + APPEND + REMOVE。全親・全テーブルの合計）。 */
  changedSubtableRows: number;
  /** 追加する子行の数。 */
  addedSubtableRows: number;
  tables: readonly {
    table: string;
    patchRows: number;
    appendRows: number;
    removeRows: number;
  }[];
  /** 消える子行の数。 */
  deletedRows: number;
  /** 子行が消える親レコードの数。 */
  deletedParentRows: number;
  revisionRequired: boolean;
  /** APPLY は常に不可逆（元の子行は戻せない）。 */
  irreversible: true;
  retryOnRevisionConflict: false;
  /** 100 親ごとに分割して書くため、前半だけ成功して後半が失敗し得る。 */
  nonTransactional?: true;
  partialSuccessPossible?: true;
  /** INSERT APPLY のときだけ。 */
  insertedParentRows?: number;
  /** INSERT / UPSERT の作成側に含まれる初期の子行数。 */
  initialSubtableRows?: number;
  /** UPSERT APPLY のときだけ。 */
  updatedParentRows?: number;
  /** UPSERT の分岐 APPLY のときだけ。 */
  applyBranches?: {
    insert: {
      parentRows: number;
      initialSubtableRows: number;
      tables: FlowApplyConfirmDetail["tables"];
    };
    update: {
      parentRows: number;
      changedSubtableRows: number;
      addedSubtableRows: number;
      tables: FlowApplyConfirmDetail["tables"];
      deletedRows: number;
      deletedParentRows: number;
    };
  };
}

/**
 * 確認フックに渡す文の情報（B195）。
 * 呼ばれる文と件数の意味は README の `/flow` の節を参照（呼出し回数から文番号を推測しないこと）。
 */
export interface FlowDmlConfirmContext {
  /** バッチ内の文 index（0 始まり。parseScript の statements の位置）。 */
  statementIndex: number;
  /** バッチの総文数。 */
  statementCount: number;
  /** "UPDATE" / "UPSERT_SELECT" など。operation より細かい。 */
  statementType: string;
  /** 書込先の物理アプリ ID（LAPP は解決済み）。 */
  targetAppId: number;
  /** LAPP_ で書かれた文だけ。"LAPP_" を除き NFC・大文字に正規化した論理名。 */
  logicalAppName?: string;
  /**
   * 文の期限（timeoutMs）または disposeExecutionContext が答えより先に来ると中止される。
   * そのとき文は答えを待たずに終わり、後から true を返しても書かない。答えたあとは中止しない。
   * reason は Error（name が "TimeoutError" または "ExecutionContextDisposedError"）。
   */
  signal: AbortSignal;
  /**
   * APPLY の書込のときだけ付く計画の内訳（B198）。
   * `allowApplyMutation: true` で APPLY を書く文に限り、文に 1 回（チャンクごとには増えない）。
   */
  applyDetail?: FlowApplyConfirmDetail;
}

/** 確認フック（B195）。true を返したときだけ書く。 */
export type FlowDmlConfirm = (
  count: number,
  operation: "UPDATE" | "DELETE" | "INSERT",
  context: FlowDmlConfirmContext
) => boolean | Promise<boolean>;

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
  /** 文が終わった時点で残っている一時テーブルの行数の合計（B196）。 */
  tempTableRows: number;
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
