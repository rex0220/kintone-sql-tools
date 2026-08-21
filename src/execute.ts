// ============================================================
// execute — SQL 文字列を受け取り kintone API を呼び出して結果を返す
//
// 依存関係はすべて注入（KintoneClient）するため、
// kintone 環境外でのテストが可能。
//
// 処理フロー:
//   SELECT（SIMPLE）  → GET → project
//   SELECT（FULL_SCAN）→ 全テーブル fetchAll → runFullScan
//   INSERT            → POST（100件バッチ）
//   UPDATE            → fetchAll（$id 取得）→ 確認 → PUT バッチ
//   DELETE            → fetchAll（$id 取得）→ 確認 → DELETE バッチ
// ============================================================

import { Lexer, LexError } from "./lexer/lexer";
import { Parser, ParseError } from "./parser/parser";
import type { Statement, SelectStatement, SelectColumn, InsertStatement, InsertSelectStatement, UpdateStatement, DeleteStatement, Assignment, LegacyArithExpr, ArithNode, AggOperand, AggregateArgExpr, UnionStatement, WithStatement, WhereExpr, BinaryExpr, FieldValue, FieldRef, ShowAppsStatement, DescribeStatement, UpsertStatement, UpsertSelectStatement, TableRef, ReorderStatement, OrderByKey, OrderByItem, ExplainStatement, CaseWhenExpr, CaseResult, StringFuncExpr, StringFuncArg, AssertStatement, AssertOperand, ExitStatement, ScalarSubquery, ScalarExpr, ScalarValueExpr, ValidateStatement, CheckGroup, ImportStatement, CsvDmlSource, JsonDmlSource, ApplyOperation, GroupByKey, KintoneFunction, WindowColumn, GenerateSeriesStatement, CteDefinition } from "./types/ast";
import { NO_FROM_CTE_NAME, numberLiteralText } from "./types/ast";
import { analyzeBatch, BatchAnalysisError, type BatchAnalysis } from "./core/batch";
import { completeInputReasons, requiresCompleteInput, type CompleteInputReason } from "./core/dmlGuard";
import { assertApplyExecutionScope, assertApplyPublicWriteScope, assertApplyScope, isSinglePositiveRecordIdWhere, statementHasMultiValueApply } from "./core/applyPatchScope";
import {
  buildApplyPatchPlan,
  collectApplySnapshotFields,
  flattenSubtableSnapshotRow,
  getApplyParentId,
  normalizeApplyPatchPlan,
  resolveApplyPatchMetadata,
} from "./core/applyPatchPlanner";
import { prepareApplyPatchWrite, type PreparedApplyWrite } from "./core/applyPatchPrepare";
import { prepareApplyInsert, type PreparedApplyInsert } from "./core/applyInsertPrepare";
import {
  prepareApplyUpsert,
  type ApplyUpsertMatch,
  type PreparedApplyUpsert,
} from "./core/applyUpsertPrepare";
import { executePreparedApplyInsert } from "./core/applyInsertExecutePrepared";
import { executePreparedApplyUpsert } from "./core/applyUpsertExecutePrepared";
import {
  ApplyWritePartialFailureError,
  executePreparedApplyWrite,
  type ApplyWriteFailureDetail,
  type ApplyWriteProgress,
} from "./core/applyPatchExecutePrepared";
import {
  buildPreparedApplyInsertDiagnostic,
  buildPreparedApplyUpdateDiagnostic,
  buildPreparedApplyUpsertDiagnostic,
  buildStaticApplyDiagnostic,
  withApplyDiagnosticProgress,
  type ApplyDiagnostic,
  type ApplyDiagnosticBranch,
  type ApplyDiagnosticTarget,
} from "./core/applyDiagnostic";
import { applyPatchPlanToKintone, requireRevision } from "./converter/applyPatchToKintone";
import {
  fieldSemanticsEqual,
  resolveFieldSemantics,
  syntheticSemantics,
  withFieldSemanticSource,
  type ResolvedFieldSemantics,
} from "./core/fieldSemantics";
import type { ProcessStatusState } from "./core/processStatus";
import type { NumberPrecision } from "./core/numberPrecision";
import { validateDeclaredBatchVariables } from "./core/batchVariables";
import { isOuterJoinNonPreservedTable, statementContainsOuterJoin } from "./core/outerJoinSearchAbortGuard";
import { compareCanonicalValues, compareScalarValues } from "./core/scalarCompare";
import { parseExactDecimal } from "./core/exactDecimal";
import { validateKlikePushdownPlan } from "./core/klikeValidation";
import { validateStatementStatic } from "./core/statementValidation";
import { GENERATE_SERIES_MAX_ROWS, resolveGenerateSeries } from "./core/generateSeries";
import {
  RecursiveCteLimitCounter,
  resolveRecursiveCteLimits,
  type RecursiveCteLimits,
} from "./core/recursiveCte";
import {
  buildJoinKeyPrefilterQueries,
  JOIN_KEY_IN_CHUNK_SIZE,
  planJoinKeyPrefilter,
} from "./core/optimization/joinKeyPrefilter";
import {
  CROSS_JOIN_MAX_ROWS,
  planCrossJoinRows,
  type CrossJoinRowPlan,
} from "./core/optimization/crossJoinRowPlan";
import { buildInlinedQuery, canInlineSingleCte } from "./core/cteInlining";
import {
  buildGroupingExplainMetadata,
  whereNeedsFieldMetadata,
} from "./core/explainMetadata";
import {
  normalizeGroupingSpec,
  type ResolvedGroupingSpec,
} from "./core/grouping";
import {
  enforceGroupingPlanningCandidateLimits,
  validateGroupingPlanning,
  type GroupingFieldResolver,
  type ResolvedGroupingField,
} from "./core/groupingValidation";
import {
  collectSelectFieldReferencesBySource,
  resolveSelectMode,
  selectToKintoneParams,
  selectToFetchAllParams,
  selectToFetchAllFields,
  whereRequiresJsEval,
  SelectMode,
} from "./converter/selectToKintone";
import { whereToKintone } from "./converter/whereToKintone";
import {
  insertToPostBatches,
  updateToGetQuery,
  updateToPutBatches,
  hasArithAssignment,
  hasRowDependentAssignment,
  updateToGetQueryForArith,
  updateToPutBatchesArith,
  updateFromToPutBatches,
  deleteToGetQuery,
  deleteToDeleteBatches,
  toKintoneValue,
  evalCaseWhenValue,
  evaluateSubtableAssignmentValue,
  KintonePostParams,
  KintonePutParams,
  KintoneDeleteParams,
  FieldTypeMap,
  DmlConvertError,
} from "./converter/dmlToKintone";
import { fetchAll, FetchAllLimitError, PageFetcher } from "./api/fetchAll";
import {
  fetchRecordsForSharedPlan,
  resolveDmlTargetIds,
} from "./core/optimization/sharedPlanner";
import {
  extractSafePushdownLeaves,
  extractTypedPushdownCandidates,
} from "./core/optimization/wherePredicatePushdown";
import {
  buildKlikePushdownPlan,
  type KlikePushdownPlan,
} from "./core/optimization/klikePushdownPlan";
import {
  bindJoinServerFunctionFetches,
  buildJoinPushdownPlan,
  isJoinServerFunctionFetchPlan,
  serializeJoinPushdownItem,
  type JoinPushdownPlan,
  type JoinPushdownSource,
} from "./core/optimization/joinPredicatePushdown";
import { buildApplyParentSelectionPlan, type ApplyParentSelectionPlan } from "./core/optimization/applyParentSelectionPlan";
import {
  planCanonicalOrder,
  type CanonicalOrderPlan,
} from "./core/optimization/canonicalOrderPlanner";
import { planKorder } from "./core/optimization/korderPlanner";
import { executeKorderCursor } from "./core/optimization/korderCursorExecutor";
import { buildKorderCursorQuery } from "./converter/korderCursorQuery";
import {
  planPlainGroupByResolution,
  resolvePlainGroupBySourceSchemas,
  type PlainGroupByResolutionPlan,
  type PlainGroupBySourceSchemaInput,
} from "./core/optimization/plainGroupByPlan";
import {
  buildOrdinaryDependencyPolicy,
  isAggregateQueryBlock,
  validateAggregateDependencies,
  validateAggregateDependenciesStatic,
} from "./core/aggregateDependencyValidation";
import { APP_SYSTEM_FIELD_CODES, isSystemLikeFieldCode } from "./core/systemFields";
import { deriveEmptyWildcardColumns } from "./core/emptyWildcardSchema";
import { whereHasKlike, whereHasLike } from "./core/like";
import {
  runFullScan,
  project,
  flatten,
  ProcessRow,
  applyOrderBy,
  buildOrderByAliasEvaluator,
  applyLimit,
  applyWindow,
  OptionOrderMap,
  FieldSortKindMap,
  type AggregateSortKindResolver,
} from "./engine/process";
import { expandSubtableRecords } from "./converter/subtableAdapter";
import type { ResolvedSubqueryInList, ResolvedExistsExpr, ResolvedScalarSubquery, FieldTypeResolver, FieldSemanticsResolver } from "./engine/evalWhere";
import { evalWhere, evalCaseWhen, resolveKintoneFunc } from "./engine/evalWhere";
import { evalArithExpr, evalStringFunc, type EvaluationContext } from "./engine/evalFunc";
import { parseSqlStatementsForScript } from "./core/sql";
import type { KintoneRecord } from "./converter/dmlToKintone";
import type { KintoneGetResponse } from "./api/fetchAll";
import type { KintoneCursorHandle, KintoneCursorOpenParams } from "./api/kintoneCursor";
export type { KintoneCursorHandle, KintoneCursorOpenParams } from "./api/kintoneCursor";
import {
  renderValidationValue,
  materializeDmlUpdateModeSparseRecords,
  validateDmlCandidates,
  VALIDATION_META_COLUMNS,
  type DmlValidationCandidate,
  type ValidationOperation,
} from "./core/dmlValidationCandidates";
import {
  buildDmlValidationPostImage,
  collectDmlPrevalidationSnapshotFields,
  mergeDmlCandidateValidation,
} from "./core/dmlPrevalidation";
import { validateAndNormalizeDmlValue } from "./core/dmlValidation";
import {
  buildValidationCellLocator,
  getAuditableConstraintCategories,
  renderExistingValidationValue,
  resolveExistingValidationTargets,
  VALIDATE_CONSTRAINT_CATEGORIES,
  type ExistingValidationTarget,
  type ValidateConstraintCategory,
} from "./core/existingRecordValidation";
import {
  buildPostImageFieldIndex,
  POST_IMAGE_VALIDATION_SUFFIX_COLUMNS,
  postImageNeedsNumberPrecision,
  validatePostImage,
} from "./core/postImageValidation";
import { collectCheckFieldRefs, collectCheckComparisonFieldRefs, customCheckParseError, evaluateCustomChecks, type CheckFieldRef } from "./core/dmlCustomCheck";
import {
  classifyWhereCapability,
  normalizeChoiceEquality,
  type ChoiceEqualityRewrite,
  type PredicateCapabilityResult,
  type WhereFieldSemanticsResolver,
} from "./core/optimization/whereCapability";
import {
  allowRelativeDatePrefilterPlan,
  assertRelativeDatePushdownPlan,
  buildRelativeDatePushdownPlan,
  type RelativeDatePlanNode,
  type RelativeDatePushdownPlan,
} from "./core/optimization/relativeDatePushdownGuard";
import {
  decomposeRelativeDatePrefilter,
  type RelativeDatePrefilterPlan,
} from "./core/optimization/relativeDatePrefilterPlan";
import {
  buildRelativeDateFullScanExactPlan,
  serverOnlyFunctionOccurrencesInWhere,
  type RelativeDateFullScanExactPlan,
} from "./core/optimization/relativeDateFullScanExactPlan";
import { isRelativeDateFunctionName } from "./core/relativeDateFunction";
import type { ImportSourceHandle, ImportSourceResolver, MaterializedImportRecords } from "./import/types";
import { loadImportSource, resolveImportSource } from "./import/sourceLoader";
import { materializeCsvDmlSource, materializeJsonDmlSource } from "./import/materializeDmlSource";
import { materializeCliKintoneCsvImportRecords, materializeJsonImportRecords } from "./import/importRecordsMaterializer";
import { assertImportRejectLimit, prepareImportRecords, type PreparedImportRecords, type ImportValidationError } from "./import/importRecordValidation";
import { IMPORT_VALIDATION_META_COLUMNS, materializeImportValidationErrors } from "./import/importErrors";
import { buildImportRecordPayload, buildJsonImportRecordPayload, type ImportScalarPayloadValue } from "./import/subtablePayload";
import { assertJsonImportHasNoRowIds, buildJsonSubtableWritePlan, type JsonImportTableWriteDetail } from "./import/jsonSubtableWritePlan";
import { assertNoDuplicateCsvSubtableRowIds, buildCsvSubtableReplacementPlan, type CsvImportTableWriteDetail } from "./import/subtableReplacementPlan";
import { bindImportProjection, IMPORT_PROJECTION_SOURCE } from "./import/importProjection";
import { preflightImportRecordNumbers } from "./import/recordNumberUpdate";
// ============================================================
// kintone API クライアントインターフェース
// ============================================================

export interface KintoneClient {
  /** GET /k/v1/records.json（1ページ分） */
  getRecords: PageFetcher;
  /** POST/GET/DELETE records/cursor.json を作成時のrouteへ束縛する。 */
  openCursor: (params: KintoneCursorOpenParams) => Promise<KintoneCursorHandle>;
  /** POST /k/v1/records.json（INSERT） */
  postRecords: (params: KintonePostParams) => Promise<{ ids: string[] }>;
  /** PUT /k/v1/records.json（UPDATE） */
  putRecords: (params: KintonePutParams) => Promise<void>;
  /** DELETE /k/v1/records.json（DELETE） */
  deleteRecords: (params: KintoneDeleteParams) => Promise<void>;
  /** GET /k/v1/apps.json（SHOW APPS） */
  getApps: () => Promise<KintoneAppInfo[]>;
  /** GET /k/v1/app/form/fields.json（DESCRIBE） */
  getFields: (appId: number) => Promise<KintoneFieldInfo[]>;
  /** GET /k/v1/app/settings.json（数値の有効桁数と丸め設定） */
  getNumberPrecision: (appId: number) => Promise<NumberPrecision>;
  /** GET /k/v1/app/status.json（プロセス管理設定） */
  getProcessStatuses: (appId: number) => Promise<KintoneProcessStatuses>;
}

export interface KintoneProcessStatuses {
  enable: boolean;
  /** 実行ユーザーの表示言語に対応する状態名と数値化済み定義順。未設定は null。 */
  states: ProcessStatusState[] | null;
}

const SEARCH_ABORTED_WARNING =
  "検索が 10 万件で打ち切られ、結果が欠落した可能性があります。";

interface SearchAbortCollector {
  aborted: boolean;
}

export class SearchAbortedError extends Error {
  constructor() {
    super("SearchAbortedError: kintone の検索が 10 万件で打ち切られたため、完全な対象集合を確定できません。");
    this.name = "SearchAbortedError";
  }
}

export interface KintoneAppInfo {
  appId: number;
  name: string;
  description: string;
}

export interface KintoneFieldInfo {
  code: string;
  label: string;
  fieldType: string;
  /** 選択肢ラベル -> 並び順 index */
  optionOrder?: Record<string, number>;
  /** ソート種別（CALC設定などに基づく） */
  sortKind?: "number" | "string";
  /** 比較・planner・実体化が共有する解決済み意味型。 */
  semantics?: ResolvedFieldSemantics;
  required?: boolean;
  minValue?: string;
  maxValue?: string;
  minLength?: string;
  maxLength?: string;
  defaultValue?: unknown;
  /** true は値が他アプリのキーであるルックアップフィールド。 */
  hasLookup?: boolean;
  /** true は値が同一アプリのルックアップからコピーされたスナップショット。 */
  isLookupCopyTarget?: boolean;
  /** true はフィールド値の重複が禁止されている。 */
  isUnique?: boolean;
  /** true は CALC または非空の計算式で導出されるフィールド。 */
  isCalculated?: boolean;
  /** true の場合、サブテーブルの子フィールドとして create 検証の必須/既定値走査から除外する。 */
  inSubtable?: boolean;
  /** false は計算・システム・ルックアップコピー先等の書込不可フィールド。 */
  writable?: boolean;
  /** Phase 5: direct owning table. Undefined for top-level fields. */
  subtableCode?: string;
}

// ============================================================
// 実行結果型
// ============================================================

export type ExecuteResult =
  | SelectResult
  | InsertResult
  | UpdateResult
  | DeleteResult
  | UpsertResult
  | ReorderResult
  | AssertResult
  | ExitResult
  | DmlValidationResult;

/** 1 回の execute() で発生した kintone API 呼び出しの計測値 */
export interface ExecuteMetrics {
  /** GET /k/v1/records.json の呼び出し回数 */
  getCalls: number;
  /** POST /k/v1/records.json の呼び出し回数 */
  postCalls: number;
  /** PUT /k/v1/records.json の呼び出し回数 */
  putCalls: number;
  /** DELETE /k/v1/records.json の呼び出し回数 */
  deleteCalls: number;
  /** GET /k/v1/app/form/fields.json の呼び出し回数（キャッシュヒット時は増えない） */
  fieldCalls: number;
  /** GET /k/v1/app/settings.json の呼び出し回数（キャッシュヒット時は増えない） */
  numberPrecisionCalls: number;
  /** GET /k/v1/apps.json の呼び出し回数 */
  appsCalls: number;
  /** GET /k/v1/app/status.json の呼び出し回数（キャッシュヒット時は増えない） */
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
  /** GET で取得したレコード総数（全ページ・サブクエリ含む） */
  fetchedRows: number;
  /** 取得上限による打ち切りが発生したか */
  limitReached: boolean;
  /** 取得上限に達したアプリ ID（重複なし。公開時に昇順化する） */
  limitReachedApps: number[];
  /** execute() 全体の所要時間（ミリ秒） */
  elapsedMs: number;
}

export interface SelectResult {
  type: "SELECT";
  rows: ProcessRow[];
  /** SELECT 列定義順のカラム名リスト（表示順保証用） */
  columns: string[];
  /** 実際に返した行数（LIMIT 適用後） */
  rowCount: number;
  /** VALIDATE の集約前エラー統計。汎用 SELECT には付与しない。 */
  validateStats?: {
    errorRecords: number;
    errorCount: number;
    constraintMetadata?: {
      present: ValidateConstraintCategory[];
      absent: ValidateConstraintCategory[];
    };
  };
  /** 実行時警告（例: 上限到達で打ち切り） */
  warnings?: string[];
  /** API 呼び出し計測値（execute() 経由の実行時のみ付与） */
  metrics?: ExecuteMetrics;
}

/** CTE / 一時テーブルの実体化結果。空結果でも出力列を保持する。 */
export interface MaterializedColumnMeta {
  readonly displayName?: string;
  readonly sortKind?: "number" | "string";
  readonly fieldType?: string;
  readonly semantics?: ResolvedFieldSemantics;
  /** engine ライブラリへ公開する直接参照列の物理アプリ。内部実体化の同定には使わない。 */
  readonly publicSourceApp?: number;
}

export type MaterializedColumnMetaMap = ReadonlyMap<string, MaterializedColumnMeta>;

export interface MaterializedTable {
  readonly rows: ProcessRow[];
  readonly columns: string[];
  readonly columnMeta?: MaterializedColumnMetaMap;
  readonly importPresence?: readonly ReadonlySet<string>[];
  readonly importRowErrors?: readonly (readonly import("./import/types").ImportRowError[])[];
  readonly importAudit?: import("./import/types").ImportColumnAudit;
  readonly recordNumberSourceValues?: readonly string[];
  /** 直接の生成 CTE だけが持つ一意列。再実体化時には伝播しない。 */
  readonly uniqueGeneratedColumn?: string;
}

/** 公開 SelectResult を拡張せず、実体化時だけ列メタを結果オブジェクトへ関連付ける。 */
const materializedMetaBySelectResult = new WeakMap<SelectResult, MaterializedColumnMetaMap>();

/** ExecuteOptions.captureColumnMeta 有効時に関連付けた列メタを取得する（なければ undefined）。 */
export function getSelectColumnMeta(result: SelectResult): MaterializedColumnMetaMap | undefined {
  return materializedMetaBySelectResult.get(result);
}
const materializedMetaByValidationResult = new WeakMap<DmlValidationResult, MaterializedColumnMetaMap>();

interface ImportExecutionSource {
  source: CsvDmlSource | JsonDmlSource;
  handle: ImportSourceHandle;
  cache: Map<ImportSourceHandle, Promise<Awaited<ReturnType<ImportSourceHandle["load"]>>>>;
  audit?: import("./import/types").ImportColumnAudit;
}
const importSourceByDmlStatement = new WeakMap<object, ImportExecutionSource>();

export interface InsertResult {
  type: "INSERT";
  /** 作成されたレコード ID（バッチごと） */
  createdIds: string[][];
  insertedCount: number;
  /** B44 INSERT APPLY progress. Absent for ordinary INSERT. */
  successfulChunks?: ApplyWriteProgress["successfulChunks"];
  successfulParents?: ApplyWriteProgress["successfulParents"];
  nonTransactional?: ApplyWriteProgress["nonTransactional"];
  /** B44 shared APPLY diagnostic. Absent for ordinary INSERT. */
  diagnostic?: ApplyDiagnostic;
  affectedRows?: number;
  skippedRows?: number;
  rejectLimit?: number | null;
  errTable?: string;
  metrics?: ExecuteMetrics;
  importDetail?: ImportConfirmDetail;
}

export interface UpdateResult {
  type: "UPDATE";
  updatedCount: number;
  /** B44 multiple-parent APPLY progress. Absent for ordinary and single-parent UPDATE. */
  successfulChunks?: ApplyWriteProgress["successfulChunks"];
  successfulParents?: ApplyWriteProgress["successfulParents"];
  nonTransactional?: ApplyWriteProgress["nonTransactional"];
  /** B44 shared APPLY diagnostic. Absent for ordinary UPDATE. */
  diagnostic?: ApplyDiagnostic;
  affectedRows?: number;
  skippedRows?: number;
  rejectLimit?: number | null;
  errTable?: string;
  metrics?: ExecuteMetrics;
  importDetail?: ImportConfirmDetail;
}

export interface DeleteResult {
  type: "DELETE";
  deletedCount: number;
  metrics?: ExecuteMetrics;
}

export interface UpsertResult {
  type: "UPSERT";
  insertedCount: number;
  updatedCount: number;
  /** B44 UPSERT APPLY progress. Absent for ordinary UPSERT. */
  successfulChunks?: ApplyWriteProgress["successfulChunks"];
  successfulParents?: ApplyWriteProgress["successfulParents"];
  successfulInsertChunks?: number;
  successfulUpdateChunks?: number;
  nonTransactional?: ApplyWriteProgress["nonTransactional"];
  /** B44 shared APPLY diagnostic. Absent for ordinary UPSERT. */
  diagnostic?: ApplyDiagnostic;
  affectedRows?: number;
  skippedRows?: number;
  rejectLimit?: number | null;
  errTable?: string;
  metrics?: ExecuteMetrics;
  importDetail?: ImportConfirmDetail;
}

export interface ReorderResult {
  type: "REORDER";
  reorderedParentCount: number;
  metrics?: ExecuteMetrics;
}

export interface AssertResult {
  type: "ASSERT";
  /** 評価した条件（パーサが再構成した正規化テキスト） */
  condition: string;
  /** 条件が成立したか。既存利用者には純加法。 */
  passed?: boolean;
  /** ASSERT WARN 不成立時の利用者向け警告。 */
  warning?: string;
  metrics?: ExecuteMetrics;
}

export interface ExitResult {
  type: "EXIT";
  condition: string;
  exited: boolean;
  message: string;
  metrics?: ExecuteMetrics;
}

export interface DmlValidationResult {
  type: "VALIDATION";
  operation: "INSERT" | "UPDATE" | "UPSERT";
  validatedRows: number;
  validRows: number;
  invalidRows: number;
  errorCount: number;
  columns: string[];
  errors: ProcessRow[];
  errTable?: string;
  metrics?: ExecuteMetrics;
  /** IMPORT Phase 5 read-only preflight detail. */
  importDetail?: ImportValidationDetail;
  /** B44 APPLY operation counts. Absent for ordinary VALIDATE ONLY results. */
  apply?: ApplyValidationDetail[];
  /** B44 APPLY safety-guard diagnostics. Absent for ordinary VALIDATE ONLY results. */
  guards?: ApplyGuardDetail;
  /** Phase 14b UPSERT APPLY branch diagnostics. */
  applyBranches?: {
    readonly create: { readonly apply: readonly ApplyValidationDetail[]; readonly guards: ApplyGuardDetail };
    readonly update: { readonly apply: readonly ApplyValidationDetail[]; readonly guards: ApplyGuardDetail };
  };
  /** B44 REMOVE totals. Present for APPLY VALIDATE ONLY. */
  deletedRows?: { readonly total: number; readonly parentRows: number };
  /** B44 shared APPLY diagnostic. Legacy apply/guards fields are derived from this detail. */
  diagnostic?: ApplyDiagnostic;
}

export interface ApplyValidationDetail {
  readonly field: string;
  readonly operations: readonly {
    readonly kind: "PATCH" | "APPEND" | "REMOVE" | "ADD" | "REMOVE_VALUE";
    readonly matchedRows?: number;
    readonly changedRows?: number;
    readonly addedRows?: number;
    readonly removedRows?: number;
    readonly value?: string;
    readonly changed?: boolean;
  }[];
  readonly changedSubtableRows: number;
  readonly deletedRows: number;
  /** Phase 15b collection diagnostics; absent for SUBTABLE APPLY. */
  readonly multiValue?: {
    readonly fieldType: string;
    readonly addedValues: number;
    readonly removedValues: number;
    readonly changedValues: number;
    readonly postImages: readonly { readonly parentId: number; readonly value: readonly unknown[] }[];
  };
}

export interface ApplyGuardDetail {
  readonly revisionRequired: boolean;
  readonly parentRows: number;
  readonly dmlMaxRows: number;
  readonly subtableRows: number;
  readonly dmlMaxSubtableRows: number;
  readonly wouldExceed: boolean;
}

export interface ImportValidationDetail {
  preflight: "ACTUAL_DATA";
  parents: { total: number; valid: number; invalid: number; mutationCandidates: number };
  tables: Record<string, { parentsPresent?: number; childRows?: number; validChildRows?: number; invalidChildRows?: number; existingRows?: number; inputRows?: number; updateRows?: number; addRows?: number; deleteRows?: number; rowIdNotFound?: number }>;
  rowIdPolicy?: "PRESERVE_EXISTING";
  rowIdNotFound?: number;
  writesKintone: false;
}

export interface JsonImportConfirmDetail {
  readonly kind: "IMPORT_JSON_SUBTABLE";
  readonly rowIdPolicy: "DROP_AND_RENUMBER_ALL";
  readonly parentsToWrite: number;
  readonly insertedParents: number;
  readonly updatedParents: number;
  readonly hasDeletes: boolean;
  readonly parents: readonly {
    parentRow: number;
    mode: "INSERT" | "UPDATE";
    targetId?: number;
    tables: readonly JsonImportTableWriteDetail[];
  }[];
}
export interface CsvImportConfirmDetail {
  readonly kind: "IMPORT_CSV_SUBTABLE_REPLACE";
  readonly rowIdPolicy: "PRESERVE_EXISTING";
  readonly parentsToWrite: number;
  readonly insertedParents: 0;
  readonly updatedParents: number;
  readonly hasDeletes: boolean;
  readonly totalDeleteRows: number;
  readonly rowIdNotFound: number;
  readonly invalidParents: number;
  readonly parents: readonly { parentRow: number; mode: "UPDATE"; targetId: number; tables: readonly CsvImportTableWriteDetail[] }[];
}
export type ImportConfirmDetail = JsonImportConfirmDetail | CsvImportConfirmDetail;

export interface ApplyConfirmDetail {
  readonly kind: "APPLY_PATCH" | "APPLY_INSERT" | "APPLY_UPSERT";
  readonly parentRows: number;
  readonly changedSubtableRows: number;
  readonly addedSubtableRows: number;
  readonly tables: readonly {
    readonly table: string;
    readonly patchRows: number;
    readonly appendRows: number;
    readonly removeRows: number;
  }[];
  /** Prepared collection post-images. Phase 16 surfaces may render this without re-planning. */
  readonly multiValues?: readonly {
    readonly field: string;
    readonly fieldType: string;
    readonly addedValues: number;
    readonly removedValues: number;
    readonly changedValues: number;
    readonly parents: readonly { readonly parentId: number; readonly postImage: readonly unknown[] }[];
  }[];
  readonly deletedRows: number;
  readonly deletedParentRows: number;
  readonly revisionRequired: boolean;
  readonly irreversible: true;
  readonly retryOnRevisionConflict: false;
  /** Present for chunked APPLY: a later PUT/POST can fail after an earlier prefix committed. */
  readonly nonTransactional?: true;
  readonly partialSuccessPossible?: true;
  /** Present for INSERT APPLY so Phase 16 surfaces need not infer create semantics. */
  readonly insertedParentRows?: number;
  /** Initial child rows included in the POST create image. */
  readonly initialSubtableRows?: number;
  /** Present for UPSERT APPLY so surfaces need not infer branch counts. */
  readonly updatedParentRows?: number;
  readonly applyBranches?: {
    readonly insert: {
      readonly parentRows: number;
      readonly initialSubtableRows: number;
      readonly tables: ApplyConfirmDetail["tables"];
    };
    readonly update: {
      readonly parentRows: number;
      readonly changedSubtableRows: number;
      readonly addedSubtableRows: number;
      readonly tables: ApplyConfirmDetail["tables"];
      readonly deletedRows: number;
      readonly deletedParentRows: number;
    };
  };
}

// ============================================================
// オプション
// ============================================================

/**
 * confirm コールバックに渡される文コンテキスト（バッチ実行時のみ）。
 * executeBatch が文ごとに confirm をラップして注入する。単文実行では undefined。
 * confirm の呼び出し有無は文タイプに依存する（INSERT VALUES は confirm 非経由・
 * UPSERT 系は対象 0 件で呼ばれない）ため、呼び出し回数から文番号を推測せず
 * このコンテキストを使うこと。
 */
export interface DmlConfirmContext {
  /** バッチ内の文 index（0 始まり） */
  statementIndex: number;
  /** バッチの総文数 */
  statementCount: number;
  /** DML 文タイプ（"UPDATE" / "UPSERT_SELECT" 等。operation より細粒度） */
  statementType: string;
  /** 書き込み先アプリ ID（StatementAnalysis.targetAppId の転記。DML では実質非 null） */
  targetAppId: number | null;
  /** Phase 5C destructive replacement audit. Optional for backward compatibility. */
  importDetail?: ImportConfirmDetail;
  /** B44 APPLY preflight detail. Mutually exclusive with importDetail. */
  applyDetail?: ApplyConfirmDetail;
  /** Phase 16a shared APPLY detail. Additive; applyDetail remains byte-for-byte compatible. */
  applyDiagnostic?: ApplyDiagnostic;
}

export interface ExecuteOptions {
  /**
   * SELECT / WITH / UNION の実行結果に列メタ（fieldType・sortKind・semantics）を
   * 関連付ける。有効時は getSelectColumnMeta(result) で取得できる。既定 false（従来動作）。
   */
  captureColumnMeta?: boolean;
  /**
   * UPDATE / DELETE（および INSERT_SELECT の書き込み）実行前に呼ばれる確認コールバック。
   * false を返すとキャンセルして OperationCancelledError を投げる。
   * 省略時は確認なしで実行。context はバッチ実行時のみ渡される（後方互換の optional）。
   */
  confirm?: (
    count: number,
    operation: "UPDATE" | "DELETE" | "INSERT",
    context?: DmlConfirmContext
  ) => Promise<boolean>;
  /** 全件取得の上限（デフォルト: 10_000） */
  maxRecords?: number;
  /** 再帰 CTE の最大深さ（positive safe integer、既定 100） */
  recursiveCteMaxDepth?: number;
  /** 再帰 CTE の累積結果行数上限（positive safe integer、既定 10,000） */
  recursiveCteMaxRows?: number;
  /** 再帰 CTE の中間展開数上限（positive safe integer、既定 100,000） */
  recursiveCteMaxExpansions?: number;
  /** 取得上限到達時の動作（SELECT系のみ） */
  onLimitReached?: "error" | "truncate";
  /** fetchAll の並列取得数（1 = 直列） */
  fetchParallel?: number;
  /** フィールド関連キャッシュの文脈キー（例: CLI profile 名） */
  cacheContext?: string;
  /** EXPLAINへ表示するhost単位のprocess-local Cursor上限（1..5、既定2） */
  cursorMaxActive?: number;
  /** B39 IMPORT gate (v3.6.0). Omitted/false keeps IMPORT unavailable. */
  enableImport?: boolean;
  /** Named, path-free source resolver. Used only when enableImport is true. */
  importSource?: ImportSourceResolver;
  /** The surface promises to render importDetail before returning true. */
  supportsImportConfirmDetail?: boolean;
  /** APPLY parent-row hard cap. Positive safe integer; core default is 100. */
  dmlMaxRows?: number;
  /** APPLY changed-child-row hard cap. Positive safe integer; core default is 100. */
  dmlMaxSubtableRows?: number;
  /** Surface capability gate. Omitted/false keeps APPLY mutation unavailable. */
  allowApplyMutation?: boolean;
  /** B43 snapshot loader seam. Usually omitted; normal UPDATE validation reuses its shared GET. */
  loadUpdateModeSnapshots?: (input: DmlUpdateModeSnapshotLoadInput) => Promise<ReadonlyMap<number, KintoneRecord>>;
}

const statementEvaluationContextKey: unique symbol = Symbol("statementEvaluationContext");
type InternalExecuteOptions = ExecuteOptions & {
  [statementEvaluationContextKey]?: EvaluationContext;
};

function bindStatementEvaluationContext(options: ExecuteOptions): ExecuteOptions {
  const internal = options as InternalExecuteOptions;
  if (internal[statementEvaluationContextKey]) return options;
  return {
    ...options,
    [statementEvaluationContextKey]: { statementInstant: new Date() },
  } as InternalExecuteOptions;
}

function statementEvaluationContext(options: ExecuteOptions): EvaluationContext {
  return (options as InternalExecuteOptions)[statementEvaluationContextKey] ?? {};
}

export interface DmlUpdateModeSnapshotLoadInput {
  readonly appId: number;
  readonly candidates: readonly DmlValidationCandidate[];
  readonly fields: readonly string[];
}

// ============================================================
// メイン: execute
// ============================================================

const defaultCacheContextByClient = new WeakMap<KintoneClient, string>();
let nextDefaultCacheContextId = 1;
let nextCacheInvocationId = 1;

function resolveCacheContext(client: KintoneClient, explicit?: string): string {
  if (explicit) return explicit;
  let context = defaultCacheContextByClient.get(client);
  if (!context) {
    context = `client:${nextDefaultCacheContextId++}`;
    defaultCacheContextByClient.set(client, context);
  }
  return context;
}

function createInvocationCacheContext(cacheContext: string): string {
  return `${cacheContext}\0inv:${nextCacheInvocationId++}`;
}

/**
 * SQL 文字列を受け取り、kintone API を呼び出して結果を返す。
 * API 呼び出し回数・取得行数・所要時間を計測し、結果の metrics に付与する。
 *
 * @param sql     SQL 文字列
 * @param client  kintone API クライアント
 * @param options 確認コールバック・上限件数等
 */
export async function execute(
  sql: string,
  client: KintoneClient,
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  resolveRecursiveCteLimits(options);
  const startedAt = Date.now();
  const cacheContext = createInvocationCacheContext(
    resolveCacheContext(client, options.cacheContext)
  );
  try {
    const stmt = parseSql(sql, options.enableImport === true);
    const metrics = createEmptyMetrics();
    const countedClient = wrapClientWithMetrics(client, metrics);
    const collector: SearchAbortCollector = { aborted: false };
    const guardedClient = wrapClientWithSearchAbort(
      countedClient,
      collector,
      !isSelectLikeStatement(stmt) || statementContainsOuterJoin(stmt)
    );
    const result = await executeParsedStatement(
      stmt,
      guardedClient,
      options,
      cacheContext
    );
    metrics.elapsedMs = Date.now() - startedAt;
    const finalResult = { ...attachSearchAbortWarning(result, collector), metrics };
    if (result.type === "SELECT") {
      const columnMeta = materializedMetaBySelectResult.get(result);
      if (columnMeta) materializedMetaBySelectResult.set(finalResult as SelectResult, columnMeta);
    }
    return finalResult;
  } finally {
    releaseMetadataCacheScope(cacheContext);
  }
}

function createEmptyMetrics(): ExecuteMetrics {
  return {
    getCalls: 0,
    postCalls: 0,
    putCalls: 0,
    deleteCalls: 0,
    fieldCalls: 0,
    numberPrecisionCalls: 0,
    appsCalls: 0,
    processStatusCalls: 0,
    cursorCreateCalls: 0,
    cursorGetCalls: 0,
    cursorDeleteCalls: 0,
    cursorRecordsScanned: 0,
    cursorActiveCurrent: 0,
    cursorActivePeak: 0,
    cursorCleanupFailures: 0,
    cursorCreateOutcomeUnknown: 0,
    cursorQuarantinedCurrent: 0,
    fetchedRows: 0,
    limitReached: false,
    limitReachedApps: [],
    elapsedMs: 0,
  };
}

const LIMIT_METRICS_SINK = Symbol("limitMetricsSink");
type LimitMetricsClient = KintoneClient & {
  [LIMIT_METRICS_SINK]?: ExecuteMetrics;
};

function markLimitReached(client: KintoneClient, appId: number): void {
  const metrics = (client as LimitMetricsClient)[LIMIT_METRICS_SINK];
  if (!metrics) return;
  metrics.limitReached = true;
  if (!metrics.limitReachedApps.includes(appId)) metrics.limitReachedApps.push(appId);
}

/**
 * KintoneClient の全メソッドを計測カウンタ付きでラップする。
 * getFields はキャッシュ（fieldInfoCache）より内側で呼ばれるため、
 * キャッシュヒット時は fieldCalls が増えない = 実際の API 呼び出し回数を表す。
 */
function wrapClientWithMetrics(
  client: KintoneClient,
  metrics: ExecuteMetrics
): LimitMetricsClient {
  return {
    [LIMIT_METRICS_SINK]: metrics,
    getRecords: async (params) => {
      metrics.getCalls += 1;
      const res = await client.getRecords(params);
      metrics.fetchedRows += res.records.length;
      return res;
    },
    openCursor: async (params) => {
      metrics.cursorCreateCalls += 1;
      let handle: KintoneCursorHandle;
      try {
        handle = await client.openCursor(params);
      } catch (error) {
        if (error instanceof Error && error.name === "CursorCreateOutcomeUnknownError") {
          metrics.cursorCreateOutcomeUnknown += 1;
          metrics.cursorQuarantinedCurrent += 1;
        }
        throw error;
      }
      metrics.cursorActiveCurrent += 1;
      metrics.cursorActivePeak = Math.max(metrics.cursorActivePeak, metrics.cursorActiveCurrent);
      let released = false;
      const markReleased = () => {
        if (released) return;
        released = true;
        metrics.cursorActiveCurrent -= 1;
      };
      return {
        totalCount: handle.totalCount,
        nextPage: async () => {
          metrics.cursorGetCalls += 1;
          const page = await handle.nextPage();
          metrics.cursorRecordsScanned += page.records.length;
          if (!page.next) markReleased();
          return page;
        },
        close: async () => {
          if (!released) metrics.cursorDeleteCalls += 1;
          try {
            await handle.close();
            markReleased();
          } catch (error) {
            metrics.cursorCleanupFailures += 1;
            metrics.cursorQuarantinedCurrent += 1;
            throw error;
          }
        },
      };
    },
    postRecords: (params) => {
      metrics.postCalls += 1;
      return client.postRecords(params);
    },
    putRecords: (params) => {
      metrics.putCalls += 1;
      return client.putRecords(params);
    },
    deleteRecords: (params) => {
      metrics.deleteCalls += 1;
      return client.deleteRecords(params);
    },
    getApps: () => {
      metrics.appsCalls += 1;
      return client.getApps();
    },
    getFields: (appId) => {
      metrics.fieldCalls += 1;
      return client.getFields(appId);
    },
    getNumberPrecision: (appId) => {
      metrics.numberPrecisionCalls += 1;
      return client.getNumberPrecision(appId);
    },
    getProcessStatuses: (appId) => {
      metrics.processStatusCalls += 1;
      return client.getProcessStatuses(appId);
    },
  };
}

const SEARCH_ABORT_FAIL_CLOSED = Symbol("searchAbortFailClosed");
type SearchAbortGuardedClient = KintoneClient & {
  [SEARCH_ABORT_FAIL_CLOSED]?: true;
};

function wrapClientWithSearchAbort(
  client: KintoneClient,
  collector: SearchAbortCollector,
  failClosed: boolean
): KintoneClient {
  if (failClosed && (client as SearchAbortGuardedClient)[SEARCH_ABORT_FAIL_CLOSED]) {
    return client;
  }
  return {
    ...client,
    ...(failClosed ? { [SEARCH_ABORT_FAIL_CLOSED]: true as const } : {}),
    getRecords: async (params) => {
      const response = await client.getRecords(params);
      if (response.searchAborted) {
        collector.aborted = true;
        if (failClosed) throw new SearchAbortedError();
      }
      return response;
    },
  };
}

function wrapClientWithCursorScope(client: KintoneClient): {
  client: KintoneClient;
  closeActive: () => Promise<void>;
} {
  const active = new Set<KintoneCursorHandle>();
  return {
    client: {
      ...client,
      openCursor: async (params) => {
        const handle = await client.openCursor(params);
        active.add(handle);
        const remove = () => active.delete(handle);
        return {
          totalCount: handle.totalCount,
          async nextPage() {
            const page = await handle.nextPage();
            if (!page.next) remove();
            return page;
          },
          async close() {
            try { await handle.close(); }
            finally { remove(); }
          },
        };
      },
    },
    closeActive: async () => {
      await Promise.all([...active].map((handle) => handle.close().catch(() => undefined)));
    },
  };
}

function isSelectLikeStatement(stmt: Statement): boolean {
  return stmt.type === "SELECT" || stmt.type === "UNION" || stmt.type === "WITH";
}

function attachSearchAbortWarning(
  result: ExecuteResult,
  collector: SearchAbortCollector
): ExecuteResult {
  if (!collector.aborted || result.type !== "SELECT") return result;
  const warnings = new Set(result.warnings ?? []);
  warnings.add(SEARCH_ABORTED_WARNING);
  return { ...result, warnings: [...warnings] };
}

async function assertRelativeDateExecutionPlan(
  stmt: Statement,
  client: KintoneClient,
  cacheContext: string
): Promise<RelativeDatePushdownPlan> {
  const plan = await resolveRelativeDateExecutionPlan(stmt, client, cacheContext);
  assertRelativeDatePushdownPlan(plan);
  return plan;
}

async function resolveRelativeDateExecutionPlan(
  stmt: Statement,
  client: KintoneClient,
  cacheContext: string
): Promise<RelativeDatePushdownPlan> {
  return buildRelativeDatePushdownPlan(stmt, {
    select: async (select) => {
      const { resolver } = await normalizeSelectChoiceEquality(select, client, cacheContext);
      return classifyWhereCapability(select.where, resolver);
    },
    dml: (dml) => resolveDmlWhereCapability(dml, client, cacheContext),
    prefilterDecomposition: async (select) => {
      if (select.where === null) return null;
      const { resolver } = await normalizeSelectChoiceEquality(select, client, cacheContext);
      return decomposeRelativeDatePrefilter(select, resolver);
    },
    joinServerFunctionPlan: async (select) => {
      await normalizeSelectChoiceEquality(select, client, cacheContext);
      const metadata = await loadTypedPushdownMeta(select, client, cacheContext);
      const runtimePlan = buildRuntimeJoinPushdownPlan(select, metadata);
      if (runtimePlan === null) return null;
      if (isJoinServerFunctionFetchPlan(runtimePlan.joinPlan)) {
        boundJoinRuntimePlans.set(select, runtimePlan);
      }
      return runtimePlan.joinPlan;
    },
  });
}

/** パース済み Statement を種別でルーティングして実行する（単文・バッチ共通の入口） */
async function executeParsedStatement(
  stmt: Statement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<ExecuteResult> {
  options = bindStatementEvaluationContext(options);
  const relativeDatePlan = await resolveRelativeDateExecutionPlan(stmt, client, cacheContext);
  // EXPLAIN は拒否計画そのものを副作用なしで表示する。実行文だけ fail-closed にする。
  if (stmt.type !== "EXPLAIN") assertRelativeDatePushdownPlan(relativeDatePlan);
  const unresolved = findVariableRef(stmt);
  if (unresolved !== null && !isApplyParentKlikeStatement(stmt)) {
    throw new Error(`ParseError: variable @${unresolved} is not defined in a batch.`);
  }
  assertApplyScope("phase15b", stmt);
  assertApplyExecutionScope("phase15b", stmt);
  validateStatementStatic(stmt);
  if (stmt.type !== "EXPLAIN") {
    await validateStatementGroupingPlanning(stmt, client, cacheContext);
  }
  if (stmt.type === "IMPORT") return executeImport(stmt, client, options, cacheContext);
  if (stmt.type === "UPDATE" && stmt.applyBlocks?.length) {
    if (stmt.validationErrorTable) {
      throw new Error("ArgumentError: VALIDATE ONLY INTO requires a batch.");
    }
    return executeUpdate(stmt, client, options, cacheContext);
  }
  if ("validateOnly" in stmt && stmt.validateOnly === true) {
    if (stmt.validationErrorTable) {
      throw new Error("ArgumentError: VALIDATE ONLY INTO requires a batch.");
    }
    return executeDmlValidation(stmt, client, { ...options, onLimitReached: "error" }, cacheContext, undefined, 1);
  }
  if ("onErrorSkip" in stmt && stmt.onErrorSkip === true) {
    throw new Error("ArgumentError: ON ERROR SKIP requires a batch.");
  }
  switch (stmt.type) {
    case "VALIDATE":      return executeExistingRecordValidation(stmt, client, options, cacheContext);
    case "SELECT":        return executeSelect(
      markCountTotalCountRoot(stmt),
      client,
      options,
      cacheContext,
      undefined,
      options.captureColumnMeta === true,
      options.captureColumnMeta === true
    );
    case "UNION":         return executeUnion(
      stmt,
      client,
      options,
      cacheContext,
      options.captureColumnMeta === true,
      options.captureColumnMeta === true
    );
    case "WITH":          return executeWith(stmt, client, options, cacheContext, undefined, options.captureColumnMeta === true);
    case "INSERT":        return executeInsert(stmt, client, options, cacheContext);
    case "INSERT_SELECT": return executeInsertSelect(stmt, client, options, cacheContext);
    case "UPSERT":        return executeUpsert(stmt, client, options, cacheContext);
    case "UPSERT_SELECT": return executeUpsertSelect(stmt, client, options, cacheContext);
    case "UPDATE":        return executeUpdate(stmt, client, options, cacheContext);
    case "DELETE":        return executeDelete(stmt, client, options, cacheContext);
    case "REORDER":       return executeReorder(stmt, client, options, cacheContext);
    case "SHOW_APPS":     return executeShowApps(client);
    case "DESCRIBE":      return executeDescribe(stmt, client, cacheContext);
    case "EXPLAIN":       return executeExplain(
      stmt,
      client,
      cacheContext,
      options.maxRecords ?? 10_000,
      options.cursorMaxActive ?? 2,
      stmt.query.type === "UPDATE" && stmt.query.applyBlocks?.length
        ? resolveApplyGuardLimit(options.dmlMaxRows, "dmlMaxRows", DEFAULT_APPLY_MAX_ROWS) : DEFAULT_APPLY_MAX_ROWS,
      stmt.query.type === "UPDATE" && stmt.query.applyBlocks?.length
        ? resolveApplyGuardLimit(options.dmlMaxSubtableRows, "dmlMaxSubtableRows", DEFAULT_APPLY_MAX_SUBTABLE_ROWS) : DEFAULT_APPLY_MAX_SUBTABLE_ROWS,
      relativeDatePlan,
      options.recursiveCteMaxDepth,
      options.recursiveCteMaxRows,
      options.recursiveCteMaxExpansions
    );
    // 一時テーブルはバッチスコープのため単文実行では拒否する（executeBatch を使う）
    case "CREATE_TEMP_TABLE":
      throw new Error("ArgumentError: CREATE TEMP TABLE requires a batch (temp tables are batch-scoped).");
    case "DROP_TEMP_TABLE":
      throw new Error("ArgumentError: DROP TEMP TABLE requires a batch (temp tables are batch-scoped).");
    case "SET_VARIABLE":
      throw new Error("ArgumentError: SET variable requires a batch.");
    case "DECLARE_VARIABLE":
      throw new Error("ArgumentError: DECLARE variable requires a batch.");
    case "ASSERT":        return executeAssert(stmt, client, options, cacheContext);
    case "EXIT":
      throw new Error("ArgumentError: EXIT SUCCESS IF はバッチ専用です");
  }
}

const EXISTING_VALIDATION_COLUMNS = [
  "$id", "$err_field", "$err_code", "$err_message", "$err_value",
  "$err_subtable", "$err_subrow", "$err_subrow_id", "$err_count",
];
const EXISTING_VALIDATION_SUMMARY_COLUMNS = [
  "$id", "$err_subtable", "$err_field", "$err_code", "$err_count",
];

function collectValidateWhereFields(where: WhereExpr | null): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  const add = (field: string) => { if (!seen.has(field)) { seen.add(field); fields.push(field); } };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "FIELD" && typeof obj.field === "string") add(obj.field);
    if (obj.type === "FIELD_REF" && typeof obj.field === "string") add(obj.field);
    Object.values(obj).forEach(visit);
  };
  visit(where);
  return fields;
}

function existingValidationColumnMeta(summary = false): MaterializedColumnMetaMap {
  const columns = summary ? EXISTING_VALIDATION_SUMMARY_COLUMNS : EXISTING_VALIDATION_COLUMNS;
  return new Map(columns.map((column) => [column, {
    fieldType: column === "$id" || column === "$err_count" ? "KSQL_NUMBER" : "KSQL_STRING",
    sortKind: column === "$id" || column === "$err_count" ? "number" as const : "string" as const,
    semantics: syntheticSemantics(column === "$id" || column === "$err_count" ? "number" : "string"),
  }]));
}

async function executeExistingRecordValidation(
  stmt: ValidateStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<SelectResult> {
  if (stmt.errorTable) throw new Error("ArgumentError: VALIDATE INTO requires a batch.");
  return executeExistingRecordValidationCore(stmt, client, options, cacheContext);
}

async function executeExistingRecordValidationCore(
  stmt: ValidateStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<SelectResult> {
  const fieldInfos = await getFieldsCached(stmt.appId, client, cacheContext);
  const infoByCode = new Map(fieldInfos.filter((field) => !field.inSubtable).map((field) => [field.code, field]));
  const childCodes = new Set(fieldInfos.filter((field) => field.inSubtable).map((field) => field.code));
  const targets = resolveExistingValidationTargets(stmt, fieldInfos);
  const presentConstraintCategories = new Set(
    targets.flatMap((target) => getAuditableConstraintCategories(target.field))
  );
  const constraintMetadata = {
    present: VALIDATE_CONSTRAINT_CATEGORIES.filter((category) => presentConstraintCategories.has(category)),
    absent: VALIDATE_CONSTRAINT_CATEGORIES.filter((category) => !presentConstraintCategories.has(category)),
  };
  const checkGroups = stmt.checkGroups ?? [];
  const checkRefs = collectCheckFieldRefs(checkGroups);
  for (const ref of checkRefs) {
    if (ref.field !== "$id" && !infoByCode.has(ref.field) && !childCodes.has(ref.field)) {
      throw customCheckParseError(`CHECK のフィールド ${ref.field} は APP${stmt.appId} に存在しません`);
    }
    if (ref.field !== "$id" && !infoByCode.has(ref.field) && childCodes.has(ref.field)) {
      throw new Error(`ArgumentError: VALIDATE の CHECK ではサブテーブル子フィールド ${ref.field} を参照できません。`);
    }
  }
  const evaluationTypes = new Map([...infoByCode].map(([code, field]) => [code, field.fieldType]));
  evaluationTypes.set("$id", "RECORD_NUMBER");
  assertCheckComparisonTypes(stmt, evaluationTypes);

  const whereFields = collectValidateWhereFields(stmt.where);
  const requiredFields = [...new Set([
    "$id",
    ...targets.map((target) => target.subtableCode ?? target.field.code),
    ...whereFields,
    ...checkRefs.map((ref) => ref.field),
  ])];
  for (const field of whereFields) {
    if (field !== "$id" && !infoByCode.has(field) && !childCodes.has(field)) {
      throw new Error(`ArgumentError: WHERE field ${field} does not exist in APP${stmt.appId}.`);
    }
    if (field !== "$id" && !infoByCode.has(field) && childCodes.has(field)) {
      throw new Error(`ArgumentError: VALIDATE の WHERE ではサブテーブル子フィールド ${field} を参照できません。`);
    }
  }

  const numberPrecision = targets.some((target) => target.field.fieldType === "NUMBER")
    ? await getNumberPrecisionCached(stmt.appId, client, cacheContext)
    : undefined;
  const semantics = (field: FieldRef) => field.field === "$id"
    ? resolveFieldSemantics({ fieldType: "__ID__" })
    : infoByCode.get(field.field)?.semantics ?? (infoByCode.has(field.field)
      ? resolveFieldSemantics(infoByCode.get(field.field)!)
      : undefined);
  const capability = classifyWhereCapability(stmt.where, semantics);
  if (capability.capability === "UNSUPPORTED") {
    throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(capability)}).`);
  }
  const fieldTypes = new Map([...infoByCode].map(([code, field]) => [code, field.fieldType]));
  const fieldOptions = new Map([...infoByCode.values()].flatMap((field) => field.optionOrder
    ? [[field.code, new Set(Object.keys(field.optionOrder))] as const]
    : []));
  const prefilter = stmt.where === null
    ? null
    : capability.capability === "EXACT_PUSHDOWN"
      ? stmt.where
      : extractSafePushdownLeaves(stmt.where, {
          allowUnqualifiedFields: true,
          fieldTypes,
          fieldOptions,
          allowKlike: false,
        });
  const query = prefilter === null ? "" : whereToKintone(prefilter);
  const records = await fetchAll(client.getRecords, stmt.appId, query, requiredFields, {
    maxRecords: options.maxRecords ?? 10_000,
    parallel: options.fetchParallel ?? 1,
    onLimit: "error",
  });
  const validationRows = records.map((record) => ({
    id: String(record["$id"]?.value ?? ""),
    record,
    flat: flatten(record, null),
  })).filter((row) => stmt.where === null || evalWhere(
    stmt.where,
    row.flat,
    (field) => evaluationTypes.get(field.field),
    undefined,
    undefined,
    statementEvaluationContext(options)
  ));

  const rows: ProcessRow[] = [];
  const detailRows = new Map<string, ProcessRow>();
  const summaryRows = new Map<string, ProcessRow>();
  const errorRecordIds = new Set<string>();
  let errorCount = 0;
  const appendError = (error: {
    id: string; field: string; code: string; message: string; value: string;
    subtable?: string; subrow?: number; subrowId?: string;
  }): void => {
    errorRecordIds.add(error.id);
    errorCount += 1;
    if (stmt.summary) {
      const key = JSON.stringify([error.id, error.subtable ?? "", error.field, error.code]);
      const current = summaryRows.get(key);
      if (current) current["$err_count"] = String(Number(current["$err_count"]) + 1);
      else summaryRows.set(key, {
        "$id": error.id,
        "$err_subtable": error.subtable ?? "",
        "$err_field": error.field,
        "$err_code": error.code,
        "$err_count": "1",
      });
      return;
    }
    const key = JSON.stringify([error.id, error.subtable ?? "", error.field, error.code, error.message]);
    const current = detailRows.get(key);
    if (current) {
      current["$err_count"] = String(Number(current["$err_count"]) + 1);
      if (error.subrow !== undefined) {
        current["$err_subrow"] = `${current["$err_subrow"]},${error.subrow}`;
        current["$err_subrow_id"] = `${current["$err_subrow_id"]},${error.subrowId ?? ""}`;
      }
    }
    else detailRows.set(key, {
      "$id": error.id,
      "$err_field": error.field,
      "$err_code": error.code,
      "$err_message": error.message,
      "$err_value": error.value,
      "$err_subtable": error.subtable ?? "",
      "$err_subrow": error.subrow === undefined ? "" : String(error.subrow),
      "$err_subrow_id": error.subrowId ?? "",
      "$err_count": "1",
    });
  };
  const topTargets = targets.filter((target) => !target.subtableCode);
  const subtableTargets = new Map<string, ExistingValidationTarget[]>();
  for (const target of targets) {
    if (!target.subtableCode) continue;
    const children = subtableTargets.get(target.subtableCode) ?? [];
    children.push(target);
    subtableTargets.set(target.subtableCode, children);
  }
  for (const row of validationRows) {
    for (const target of topTargets) {
      const raw = row.record[target.field.code]?.value;
      const validation = validateAndNormalizeDmlValue(raw, target.field, numberPrecision);
      if (!validation.ok) appendError({
        id: row.id, field: target.field.code, code: validation.code,
        message: validation.message, value: renderExistingValidationValue(raw, target.field.fieldType),
      });
    }
    for (const [tableCode, childTargets] of subtableTargets) {
      const tableRows = row.record[tableCode]?.value;
      if (!Array.isArray(tableRows)) continue;
      for (let i = 0; i < tableRows.length; i++) {
        const tableRow = tableRows[i] as { id?: string | number; value?: Record<string, { value?: unknown }> };
        for (const target of childTargets) {
          const raw = tableRow.value?.[target.field.code]?.value;
          const validation = validateAndNormalizeDmlValue(raw, target.field, numberPrecision);
          if (!validation.ok) {
            const locator = buildValidationCellLocator(tableCode, i, tableRow);
            appendError({
            id: row.id, field: target.field.code, code: validation.code,
            message: validation.message, value: renderExistingValidationValue(raw, target.field.fieldType),
            ...locator,
          });
          }
        }
      }
    }
    for (const check of evaluateCustomChecks(checkGroups, row.flat, (field) => evaluationTypes.get(field.field))) {
      appendError({ id: row.id, field: "", code: "ERR_CHECK", message: check.message, value: "" });
    }
  }
  if (stmt.summary) rows.push(...summaryRows.values());
  else {
    for (const row of detailRows.values()) {
      const count = Number(row["$err_count"]);
      if (row["$err_subtable"] !== "" && count >= 2) {
        row["$err_message"] = `${row["$err_message"]}（${count}行: ${row["$err_subrow"]}）`;
      }
      rows.push(row);
    }
  }
  const columns = stmt.summary ? EXISTING_VALIDATION_SUMMARY_COLUMNS : EXISTING_VALIDATION_COLUMNS;
  const result: SelectResult = {
    type: "SELECT",
    columns: [...columns],
    rows,
    rowCount: rows.length,
    validateStats: {
      errorRecords: errorRecordIds.size,
      errorCount,
      constraintMetadata,
    },
  };
  materializedMetaBySelectResult.set(result, existingValidationColumnMeta(stmt.summary === true));
  return result;
}

// ============================================================
// バッチ実行（フェーズ1 S4）
//
// `;` 区切りの複文を validate-all-first（analyzeBatch）で検証した後、
// 順次実行する。一時テーブル（#name）はバッチ内スコープの
// Map<string, MaterializedTable> に行と列を実体化し、CTE キャッシュと同じ機構で
// FULL_SCAN エンジンに注入する。
// ============================================================

/** 一時テーブル1個の実体化行数上限（仕様 §5.6）。onLimitReached は適用せず常に error */
export const TEMP_TABLE_MAX_ROWS = 10_000;

export interface BatchExecuteOptions extends ExecuteOptions {
  /** DECLARE されたバッチ変数の外部注入値（キーは @ なし、大文字小文字を区別しない） */
  variables?: Readonly<Record<string, string>>;
  /** 実行時エラー後も後続文を実行する（read-only バッチのみ指定可。既定 false = fail-fast） */
  continueOnError?: boolean;
  /** バッチ合計のタイムアウト（ミリ秒）。到達時: 実行中の文 = error(TimeoutError)、未実行の文 = skipped("timeout") */
  timeoutMs?: number;
  /** 一時テーブル実体化の行数上限（既定 TEMP_TABLE_MAX_ROWS） */
  tempTableMaxRows?: number;
}

export interface BatchStatementError {
  code: string;
  message: string;
  /** Original statement failure. Non-enumerable so envelope serialization stays unchanged. */
  readonly cause?: unknown;
  /** Already committed prefix of a non-transactional APPLY statement. */
  partialSuccess?: ApplyWriteFailureDetail;
}

function appendValidationErrors(
  tempTables: Map<string, MaterializedTable>,
  name: string,
  columns: string[],
  rows: ProcessRow[],
  maxRows: number,
  columnMeta: MaterializedColumnMetaMap
): void {
  const current = tempTables.get(name);
  if (current && (
    current.columns.length !== columns.length
    || current.columns.some((c, i) => c !== columns[i])
    || !materializedColumnMetaEqual(current.columnMeta, columnMeta)
  )) {
    throw new Error(`ArgumentError: validation error table ${name} has a different schema.`);
  }
  const existingRows = current?.rows ?? [];
  if (existingRows.length + rows.length > maxRows) {
    throw new Error(`ArgumentError: temp table ${name} exceeds max rows (${maxRows}).`);
  }
  // schema・件数を先に検査し、既存値を変更せず単一setで反映する。
  tempTables.set(name, { columns: [...columns], rows: [...existingRows, ...rows], columnMeta });
}

function materializedColumnMetaEqual(
  left: MaterializedColumnMetaMap | undefined,
  right: MaterializedColumnMetaMap | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const [column, meta] of left) {
    const candidate = right.get(column);
    if (
      !candidate ||
      candidate.displayName !== meta.displayName ||
      candidate.sortKind !== meta.sortKind ||
      candidate.fieldType !== meta.fieldType ||
      !fieldSemanticsEqual(candidate.semantics, meta.semantics)
    ) return false;
  }
  return true;
}

export interface BatchStatementResult {
  index: number;
  type: string;
  status: "success" | "error" | "skipped";
  /** success した文の実行結果（CREATE / DROP TEMP TABLE は持たない） */
  result?: ExecuteResult;
  /** CREATE / DROP TEMP TABLE の対象一時テーブル名 */
  tempTable?: string;
  /** CREATE_TEMP_TABLE の実体化行数 */
  rowCount?: number;
  error?: BatchStatementError;
  /** "fail-fast" / "dependency: #name" / "timeout" / "assertion" / "exit" */
  skippedReason?: string;
}

export interface BatchExecuteResult {
  /** エラーがなく、skipped が正常な EXIT によるものだけなら true */
  ok: boolean;
  statementCount: number;
  statements: BatchStatementResult[];
  /** 静的解析結果（isReadOnlyBatch / containsDml 等。呼び出し層の検証・整形用） */
  analysis: BatchAnalysis;
  metrics?: ExecuteMetrics;
}

type VarValue =
  | { type: "string"; value: string; placeholder?: true }
  | { type: "number"; value: number; raw?: string }
  | { type: "relative-date"; value: KintoneFunction }
  | { type: "array"; elements: Array<{ type: "string"; value: string }> };

/** バッチタイムアウト。message 接頭辞で code = TimeoutError として報告される */
class BatchTimeoutError extends Error {
  constructor() {
    super("TimeoutError: batch timeout exceeded.");
  }
}

/**
 * `;` 区切りの複文バッチを順次実行する。
 *
 * - validate-all-first: 静的検証（analyzeBatch）に違反があれば1文も実行せずに throw
 * - 実行時エラーは throw せず、文ごとの status（success / error / skipped）で返す
 * - fail-fast（既定）: エラー文以降は skipped("fail-fast")
 * - continueOnError: エラー文を記録して続行。ただし失敗した CREATE に依存する文は
 *   skipped("dependency: #name")（S3 の依存グラフを使用）
 */
export async function executeBatch(
  sql: string,
  client: KintoneClient,
  options: BatchExecuteOptions = {}
): Promise<BatchExecuteResult> {
  resolveRecursiveCteLimits(options);
  const { statements } = parseSqlStatementsForScript(sql, { import: options.enableImport === true });
  const analysis = analyzeBatch(statements);
  // APPLY execution capability は batch の先行文を含む一切の API 呼び出し前に検査する。
  statements.forEach((statement) => assertApplyExecutionScope("phase15b", statement));
  if (options.allowApplyMutation !== true && statements.some((statement) =>
    statementHasMultiValueApply(statement)
    || (statement.type === "UPSERT" && statementHasApplyMutation(statement))
  )) {
    throw new Error("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  }
  // API 呼び出しや文実行より前に、注入キーの正規化と DECLARE 照合を完了する。
  const injectedVariables = validateDeclaredBatchVariables(statements, options.variables);
  const relativeDateVariables = prepareRelativeDateVariables(statements, injectedVariables);
  const batchOptions: BatchExecuteOptions = { ...options, variables: injectedVariables };

  if (options.continueOnError && analysis.containsDml) {
    throw new Error("ArgumentError: continueOnError is not allowed for batches containing DML.");
  }
  // DML 文内の一時テーブル参照は SELECT-based DML（INSERT_SELECT / UPSERT_SELECT）
  // でのみ許可する（temp のみ・APP 混在とも。v1.7.0）。件数判定は書き込み前の
  // confirm フックが担うため dmlMaxRows と整合する。
  // それ以外（UPDATE のサブクエリ等）は引き続き拒否
  for (const s of analysis.statements) {
    if (!s.isDml || s.tempTablesReferenced.length === 0) continue;
    if (s.statementType === "INSERT_SELECT" || s.statementType === "UPSERT_SELECT") continue;
    const parsed = statements[s.index];
    if (parsed?.type === "UPDATE" && parsed.from?.cteName != null) continue;
    throw new BatchAnalysisError(
      `ArgumentError: temp table references in ${s.statementType} are not supported yet.`,
      s.index
    );
  }

  const metrics = createEmptyMetrics();
  const countedClient = wrapClientWithMetrics(client, metrics);
  const startedAt = Date.now();
  const deadline = options.timeoutMs != null ? startedAt + options.timeoutMs : null;
  const cacheContext = createInvocationCacheContext(
    resolveCacheContext(client, options.cacheContext)
  );

  try {
    const tempTables = new Map<string, MaterializedTable>();
    const variables = new Map<string, VarValue>();
    const results: BatchStatementResult[] = [];
    /** success しなかった文の index（error / skipped）。依存スキップの判定に使う */
    const failed = new Set<number>();
    /** fail-fast / timeout / assertion / exit で中断済みなら以降の文の skippedReason */
    let aborted: "fail-fast" | "timeout" | "assertion" | "exit" | null = null;

    for (let i = 0; i < statements.length; i++) {
      const info = analysis.statements[i];
      const base = { index: i, type: info.statementType };

      if (aborted) {
        results.push({ ...base, status: "skipped", skippedReason: aborted });
        if (aborted !== "exit") failed.add(i);
        continue;
      }

      // 依存スキップ: 依存先（一時テーブルを CREATE した文）が success していない
      const brokenDep = info.dependsOn.find((d) => failed.has(d));
      if (brokenDep !== undefined) {
        const depName =
          analysis.statements[brokenDep].tempTablesCreated[0] ?? `statement ${brokenDep}`;
        results.push({ ...base, status: "skipped", skippedReason: `dependency: ${depName}` });
        failed.add(i);
        continue;
      }

      if (deadline !== null && Date.now() >= deadline) {
        results.push({ ...base, status: "skipped", skippedReason: "timeout" });
        failed.add(i);
        aborted = "timeout";
        continue;
      }

      try {
        const remaining = deadline !== null ? deadline - Date.now() : null;
        // confirm に文コンテキストを注入する（呼び出し回数からの文番号推測は
        // INSERT VALUES 非経由・0 件 UPSERT スキップで崩れるため、ここで束縛する）
        const userConfirm = batchOptions.confirm;
        const stmtOptions: BatchExecuteOptions = userConfirm
          ? {
            ...batchOptions,
            confirm: (count, operation, detailContext) => userConfirm(count, operation, {
              statementIndex: i,
              statementCount: statements.length,
              statementType: info.statementType,
              targetAppId: info.targetAppId,
              ...(detailContext?.importDetail ? { importDetail: detailContext.importDetail } : {}),
              ...(detailContext?.applyDetail ? { applyDetail: detailContext.applyDetail } : {}),
              ...(detailContext?.applyDiagnostic ? { applyDiagnostic: detailContext.applyDiagnostic } : {}),
            }),
          }
          : batchOptions;
        const searchAbortCollector: SearchAbortCollector = { aborted: false };
        const statementClient = wrapClientWithSearchAbort(
          countedClient,
          searchAbortCollector,
          (
            info.statementType !== "SELECT"
            && info.statementType !== "UNION"
            && info.statementType !== "WITH"
          ) || statementContainsOuterJoin(statements[i])
        );
        const cursorScope = wrapClientWithCursorScope(statementClient);
        const boundOptions = bindStatementEvaluationContext(stmtOptions) as BatchExecuteOptions;
        const statementContext: ExecutionContext = {
          stmt: statements[i],
          info,
          client: cursorScope.client,
          options: boundOptions,
          cacheContext,
          tempTables,
          variables,
          relativeDateVariables,
          clock: statementEvaluationContext(boundOptions),
        };
        const outcome = await runWithDeadline(
          executeBatchStatement(statementContext),
          remaining,
          cursorScope.closeActive
        );
        if (outcome.result) {
          outcome.result = attachSearchAbortWarning(outcome.result, searchAbortCollector);
        }
        const { exitTriggered, ...statementOutcome } = outcome;
        results.push({ ...base, status: "success", ...statementOutcome });
        if (exitTriggered) aborted = "exit";
      } catch (e) {
        results.push({
          ...base,
          status: "error",
          error: toBatchStatementError(e),
          ...(e instanceof RejectLimitExceededError ? { result: e.diagnostic } : {}),
        });
        failed.add(i);
        if (e instanceof BatchTimeoutError) {
          aborted = "timeout";
        } else if (e instanceof AssertError) {
          // ASSERT 失敗は continueOnError を無視して常に停止する（設計判断 D3:
          // ASSERT は後続実行のゲートであり、続行を許すと存在意義が消える）
          aborted = "assertion";
        } else if (info.statementType === "SET_VARIABLE" || info.statementType === "DECLARE_VARIABLE") {
          // 変数値が欠けた状態で後続を実行しない（continueOnError より優先）
          aborted = "fail-fast";
        } else if (!options.continueOnError) {
          aborted = "fail-fast";
        }
      }
    }

    metrics.elapsedMs = Date.now() - startedAt;
    return {
      ok: results.every((r) => r.status === "success" || r.skippedReason === "exit"),
      statementCount: statements.length,
      statements: results,
      analysis,
      metrics,
    };
  } finally {
    releaseMetadataCacheScope(cacheContext);
  }
}

function statementHasApplyMutation(statement: Statement): boolean {
  if (statement.type === "UPDATE" || statement.type === "INSERT") {
    return statement.validateOnly !== true && Boolean(statement.applyBlocks?.length);
  }
  return statement.type === "UPSERT"
    && statement.validateOnly !== true
    && Boolean(statement.onInsertApplyBlocks?.length || statement.onUpdateApplyBlocks?.length);
}

interface ExecutionContext {
  readonly stmt: Statement;
  readonly info: BatchAnalysis["statements"][number];
  readonly client: KintoneClient;
  readonly options: BatchExecuteOptions;
  readonly cacheContext: string;
  readonly tempTables: Map<string, MaterializedTable>;
  readonly variables: Map<string, VarValue>;
  readonly relativeDateVariables: ReadonlyMap<string, KintoneFunction>;
  readonly clock: EvaluationContext;
}

interface BatchStatementOutcome extends Partial<BatchStatementResult> {
  /** 内部制御用。BatchStatementResult には露出しない。 */
  exitTriggered?: boolean;
}

/** 1文をバッチ文脈（一時テーブルストア付き）で実行する */
async function executeBatchStatement(
  context: ExecutionContext
): Promise<BatchStatementOutcome> {
  const {
    stmt, info, client, options, cacheContext, tempTables, variables,
    relativeDateVariables, clock,
  } = context;
  if (stmt.type === "SET_VARIABLE") {
    const resolvedStmt = resolveBatchVariableReferences(stmt, variables);
    validateStatementStatic(resolvedStmt);
    await assertRelativeDateExecutionPlan(resolvedStmt, client, cacheContext);
    if (resolvedStmt.expr.type === "ARRAY") {
      variables.set(stmt.name, {
        type: "array",
        elements: resolvedStmt.expr.elements.map((element) => ({ type: "string", value: element.value })),
      });
    } else if (resolvedStmt.expr.type === "SCALAR_SUBQUERY") {
      try {
        const value = await evaluateScalarSubquery(
          resolvedStmt.expr.query,
          client,
          options,
          cacheContext,
          tempTables
        );
        const first = resolvedStmt.expr.query.columns[0];
        let numeric = first?.type === "ARITH_COL"
          || first?.type === "ARITH_AGG_COL"
          || (first?.type === "WINDOW_COL" && (first.windowKind === undefined || first.windowKind === "RANKING"
            || (first.windowKind === "AGGREGATE"
              && (first.aggFunc === "COUNT" || first.aggFunc === "SUM" || first.aggFunc === "AVG"))))
          || (first?.type === "AGGREGATE"
            && (first.func === "COUNT" || first.func === "SUM" || first.func === "AVG"
              || first.func === "STDDEV_POP" || first.func === "STDDEV_SAMP"
              || first.func === "VAR_POP" || first.func === "VAR_SAMP" || first.func === "MEDIAN"));
        if ((first?.type === "AGGREGATE" && first.func === "MODE")
          || (first?.type === "WINDOW_COL" && first.windowKind === "VALUE")
          || (first?.type === "WINDOW_COL" && first.windowKind === "AGGREGATE"
            && (first.aggFunc === "MIN" || first.aggFunc === "MAX"))) {
          const meta = (await inferSelectColumnMeta(
            resolvedStmt.expr.query,
            ["__scalar__"],
            client,
            cacheContext,
            tempTables
          )).get("__scalar__");
          numeric = meta?.semantics?.compareMode === "number" || meta?.sortKind === "number";
        }
        const numberValue = numeric ? Number(value) : Number.NaN;
        variables.set(stmt.name, numeric && Number.isFinite(numberValue)
          ? { type: "number", value: numberValue, raw: value }
          : { type: "string", value });
      } catch (e) {
        if (e instanceof ScalarSubqueryError) {
          throw new Error(`ArgumentError: ${e.message}`);
        }
        throw e;
      }
    } else {
      variables.set(stmt.name, evaluateScalarExpr(resolvedStmt.expr, clock));
    }
    return {};
  }

  if (stmt.type === "DECLARE_VARIABLE") {
    if (stmt.annotation === "RELATIVE_DATE") {
      variables.set(stmt.name, {
        type: "relative-date",
        value: relativeDateVariables.get(stmt.name)!,
      });
      return {};
    }
    const injected = options.variables ?? {};
    if (Object.prototype.hasOwnProperty.call(injected, stmt.name)) {
      variables.set(stmt.name, { type: "string", value: injected[stmt.name] });
    } else {
      const value = evaluateScalarExpr(
        stmt.default as Exclude<ScalarExpr, ScalarSubquery>,
        clock
      );
      variables.set(stmt.name, {
        type: "string",
        value: value.type === "number" ? (value.raw ?? String(value.value)) : value.value,
      });
    }
    return {};
  }

  const resolvedStmt = resolveBatchVariableReferences(stmt, variables);
  assertApplyScope("phase15b", resolvedStmt);
  assertApplyExecutionScope("phase15b", resolvedStmt);
  // KLIKE の %・右辺型は、バッチ変数を実リテラルへ置換した後にも検証する。
  validateStatementStatic(resolvedStmt);
  await assertRelativeDateExecutionPlan(resolvedStmt, client, cacheContext);

  if (resolvedStmt.type === "VALIDATE") {
    const result = await executeExistingRecordValidationCore(
      resolvedStmt,
      client,
      { ...options, onLimitReached: "error" },
      cacheContext
    );
    if (resolvedStmt.errorTable) {
      appendValidationErrors(
        tempTables,
        resolvedStmt.errorTable,
        result.columns,
        result.rows,
        options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
        materializedMetaBySelectResult.get(result) ?? existingValidationColumnMeta(resolvedStmt.summary === true)
      );
    }
    return { result };
  }

  if (resolvedStmt.type === "IMPORT") {
    return { result: await executeImport(resolvedStmt, client, options, cacheContext, tempTables) };
  }

  if ("validateOnly" in resolvedStmt && resolvedStmt.validateOnly === true) {
    const result = await executeDmlValidation(
      resolvedStmt,
      client,
      { ...options, onLimitReached: "error" },
      cacheContext,
      tempTables,
      info.index + 1
    );
    if (resolvedStmt.validationErrorTable) {
      appendValidationErrors(
        tempTables,
        resolvedStmt.validationErrorTable,
        result.columns,
        result.errors,
        options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
        materializedMetaByValidationResult.get(result) ?? new Map()
      );
    }
    return { result };
  }

  if ("onErrorSkip" in resolvedStmt && resolvedStmt.onErrorSkip === true) {
    return {
      result: await executeOnErrorSkip(
        resolvedStmt,
        client,
        { ...options, onLimitReached: "error" },
        cacheContext,
        tempTables,
        info.index + 1
      ),
    };
  }

  if (resolvedStmt.type === "CREATE_TEMP_TABLE") {
    // 実体化は onLimitReached を適用せず常に error
    //（truncate による暗黙の欠損が後続文の結果を静かに歪めるため。仕様 §5.6）
    const materializeOptions: ExecuteOptions = {
      ...options,
      maxRecords: options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
      onLimitReached: "error",
    };
    const result = await runSelectLike(resolvedStmt.query, client, materializeOptions, cacheContext, tempTables);
    tempTables.set(resolvedStmt.name, {
      rows: result.rows,
      columns: result.columns,
      columnMeta: materializedMetaBySelectResult.get(result),
    });
    return { tempTable: resolvedStmt.name, rowCount: result.rows.length };
  }

  if (stmt.type === "DROP_TEMP_TABLE") {
    tempTables.delete(stmt.name); // ストアの解放（存在は analyzeBatch が検証済み）
    return { tempTable: stmt.name };
  }

  // EXPLAIN はプラン表示のみ（kintone アクセスなし）のため一時テーブル参照を含んでも安全
  if (stmt.type === "EXPLAIN") {
    const explainStmt = resolvedStmt as ExplainStatement;
    explainMaterializedTables.set(explainStmt, tempTables);
    try {
      return { result: await executeParsedStatement(explainStmt, client, options, cacheContext) };
    } finally {
      explainMaterializedTables.delete(explainStmt);
    }
  }

  // ASSERT: 既存の成立時は no-result のまま。WARN 不成立時だけ警告結果を残す。
  if (resolvedStmt.type === "ASSERT") {
    const result = await executeAssert(resolvedStmt, client, options, cacheContext, tempTables);
    return result.warning !== undefined ? { result } : {};
  }

  if (resolvedStmt.type === "EXIT") {
    const result = await executeExit(resolvedStmt, client, options, cacheContext, tempTables);
    return { result, ...(result.exited ? { exitTriggered: true } : {}) };
  }

  // 一時テーブルを参照する文はストアを注入して実行
  if (info.tempTablesReferenced.length > 0) {
    if (resolvedStmt.type === "SELECT" || resolvedStmt.type === "UNION") {
      return {
        result: await executeQueryWithCte(
          resolvedStmt,
          client,
          options,
          tempTables,
          cacheContext,
          options.captureColumnMeta === true
        ),
      };
    }
    if (resolvedStmt.type === "WITH") {
      return { result: await executeWith(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    // SELECT-based DML（ソースは temp のみ / APP 混在とも。事前チェックで検証済み）
    if (resolvedStmt.type === "INSERT_SELECT") {
      return { result: await executeInsertSelect(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    if (resolvedStmt.type === "UPSERT_SELECT") {
      return { result: await executeUpsertSelect(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    if (resolvedStmt.type === "UPDATE" && resolvedStmt.from?.cteName != null) {
      return { result: await executeUpdate(resolvedStmt, client, options, cacheContext, tempTables) };
    }
    // ここに来るのは想定外（他の DML 参照は事前チェックで拒否済み）
    throw new Error(`ArgumentError: temp table references in ${stmt.type} are not supported yet.`);
  }

  // 一時テーブルと無関係な文は既存の単文実行経路をそのまま使う
  return { result: await executeParsedStatement(resolvedStmt, client, options, cacheContext) };
}

/** CREATE TEMP TABLE の AS 句（SELECT / UNION / WITH）を一時テーブルストア付きで実行する */
async function runSelectLike(
  query: SelectStatement | UnionStatement | WithStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable>
): Promise<SelectResult> {
  if (query.type === "WITH") {
    return executeWith(query, client, options, cacheContext, tempTables, true);
  }
  return executeQueryWithCte(query, client, options, tempTables, cacheContext, true);
}

/**
 * 文の実行に残り時間の期限を課す。到達時は BatchTimeoutError を投げる。
 * 注意: 進行中の kintone リクエスト自体は中断されない（AbortSignal の
 * 伝播はレート制御基盤 P0-1 とあわせて対応する）。
 */
async function runWithDeadline<T>(
  work: Promise<T>,
  remainingMs: number | null,
  onTimeout?: () => Promise<void>
): Promise<T> {
  if (remainingMs === null) return work;
  if (remainingMs <= 0) {
    if (onTimeout) await onTimeout();
    void work.catch(() => { /* 破棄する実行の未処理拒否を抑止 */ });
    throw new BatchTimeoutError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const guardedWork = work.then(
    (value) => timedOut ? new Promise<T>(() => undefined) : value,
    (error) => {
      if (timedOut) return new Promise<T>(() => undefined);
      throw error;
    }
  );
  try {
    return await Promise.race([
      guardedWork,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void (async () => {
            if (onTimeout) {
              let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  onTimeout(),
                  new Promise<void>((resolve) => {
                    cleanupTimer = setTimeout(resolve, 5_000);
                    cleanupTimer.unref?.();
                  }),
                ]);
              } finally {
                if (cleanupTimer) clearTimeout(cleanupTimer);
              }
            }
            reject(new BatchTimeoutError());
          })();
        }, remainingMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof BatchTimeoutError) {
      void work.catch(() => { /* 同上 */ });
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * エラーを文ごとの報告形式に変換する。
 * code の優先順: Error の name / オブジェクトの code プロパティ
 * → message の "XxxError:" 接頭辞 → "Error"。
 * プラグインの kintone.api は Error ではなく素のオブジェクト（{ code, message, id }）で
 * reject するため、オブジェクト形式も解釈する（String(e) だと "[object Object]" になる）
 */
function toBatchStatementError(e: unknown): BatchStatementError {
  let error: BatchStatementError;
  if (e instanceof ApplyWritePartialFailureError) {
    error = { code: e.name, message: e.message, partialSuccess: e.partialSuccess };
  } else if (e instanceof Error) {
    const name = e.name !== "Error" ? e.name : null;
    error = { code: name ?? codeFromMessagePrefix(e.message), message: e.message };
  } else if (e !== null && typeof e === "object") {
    const obj = e as { message?: unknown; code?: unknown };
    const message =
      typeof obj.message === "string" && obj.message.length > 0
        ? obj.message
        : safeJsonStringify(e);
    const code =
      typeof obj.code === "string" && obj.code.length > 0
        ? obj.code
        : codeFromMessagePrefix(message);
    error = { code, message };
  } else {
    const message = String(e);
    error = { code: codeFromMessagePrefix(message), message };
  }
  Object.defineProperty(error, "cause", {
    value: e,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

/** message の "XxxError:" 接頭辞をコードとして抽出する（なければ "Error"） */
function codeFromMessagePrefix(message: string): string {
  return message.match(/^([A-Za-z]+Error):/)?.[1] ?? "Error";
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function parseSqlBatch(sql: string, enableImport = false, dialect1 = false): Statement[] {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens, { import: enableImport, dialect1 }).parseStatements();
}

function parseRelativeDateVariableValue(name: string, value: string): KintoneFunction {
  try {
    const statements = parseSqlBatch(`DECLARE @__b111 RELATIVE_DATE = ${value}`);
    const declaration = statements[0];
    if (
      statements.length !== 1
      || declaration?.type !== "DECLARE_VARIABLE"
      || declaration.annotation !== "RELATIVE_DATE"
    ) {
      throw new Error("token was not consumed as one RELATIVE_DATE declaration");
    }
    return declaration.default as KintoneFunction;
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `ArgumentError: RELATIVE_DATE variable @${name} requires one supported relative-date function token.${detail}`
    );
  }
}

function prepareRelativeDateVariables(
  statements: readonly Statement[],
  injectedVariables: Readonly<Record<string, string>>
): ReadonlyMap<string, KintoneFunction> {
  const prepared = new Map<string, KintoneFunction>();
  for (const stmt of statements) {
    if (stmt.type !== "DECLARE_VARIABLE" || stmt.annotation !== "RELATIVE_DATE") continue;
    prepared.set(
      stmt.name,
      Object.prototype.hasOwnProperty.call(injectedVariables, stmt.name)
        ? parseRelativeDateVariableValue(stmt.name, injectedVariables[stmt.name])
        : stmt.default as KintoneFunction
    );
  }
  return prepared;
}

function evaluateScalarExpr(
  expr: Exclude<ScalarExpr, ScalarSubquery>,
  evaluationContext: EvaluationContext = {}
): Exclude<VarValue, { type: "array" } | { type: "relative-date" }> {
  switch (expr.type) {
    case "STRING":
      return { type: "string", value: expr.value };
    case "NUMBER":
      return { type: "number", value: expr.value, raw: numberLiteralText(expr) };
    case "KINTONE_FUNC":
      return { type: "string", value: resolveKintoneFunc(expr.name, evaluationContext) };
    case "STRING_FUNC":
      return { type: "string", value: evalStringFunc(expr, {}, undefined, undefined, evaluationContext) };
    case "ARITH": {
      const value = evalArithExpr(expr, {}, evaluationContext);
      if (!Number.isFinite(value)) {
        throw new Error("ArgumentError: SET scalar arithmetic produced a non-finite number.");
      }
      return { type: "number", value, raw: String(value) };
    }
  }
}

/** Resolve batch references, expand array IN values, and simplify predicates. */
export function resolveBatchVariableReferences<T>(node: T, variables: Map<string, VarValue>): T {
  return resolveBatchVariableReferencesInternal(node, variables, false);
}

function resolveBatchVariableReferencesInternal<T>(
  node: T,
  variables: Map<string, VarValue>,
  numericArithmeticOperand: false | "ARITH" | "AGG_ARITH"
): T {
  if (Array.isArray(node)) {
    return node.map((v) => resolveBatchVariableReferencesInternal(v, variables, false)) as T;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "VARIABLE" && typeof obj["name"] === "string") {
      const value = variables.get(obj["name"]);
      if (value === undefined) {
        throw new Error(`ParseError: variable @${obj["name"]} is not defined in this batch.`);
      }
      if (value.type === "array") {
        throw new Error(`ParseError: array variable @${obj["name"]} can only be used as IN @${obj["name"]}.`);
      }
      if (value.type === "relative-date") return value.value as T;
      if (
        numericArithmeticOperand
        && value.type !== "number"
        && !(value.type === "string" && value.placeholder === true)
      ) {
        throw new Error(
          `ArgumentError: variable @${obj["name"]} is not numeric and cannot be used in arithmetic.`
        );
      }
      return (numericArithmeticOperand && value.type === "string" && value.placeholder === true
        ? {
            type: "NUMBER",
            value: 0,
            raw: numericArithmeticOperand === "AGG_ARITH" ? `@${obj["name"]}` : value.value,
          }
        : value.type === "number"
        ? {
            type: "NUMBER",
            value: value.value,
            raw: numericArithmeticOperand === "AGG_ARITH"
              ? `@${obj["name"]}`
              : value.raw ?? String(value.value),
          }
        : { type: "STRING", value: value.value, fromVariable: true }) as T;
    }
    if (obj["type"] === "VARIABLE_COL" && typeof obj["name"] === "string" && typeof obj["alias"] === "string") {
      const value = variables.get(obj["name"]);
      if (value === undefined) throw new Error(`ParseError: variable @${obj["name"]} is not defined in this batch.`);
      if (value.type === "array") throw new Error(`ParseError: array variable @${obj["name"]} cannot be used as a SELECT column.`);
      if (value.type === "relative-date") {
        throw new Error(`InternalError: RELATIVE_DATE variable @${obj["name"]} reached a SELECT column.`);
      }
      const aliasDisplay = typeof obj["aliasDisplay"] === "string"
        ? { aliasDisplay: obj["aliasDisplay"] }
        : {};
      return (value.type === "number"
        ? { type: "ARITH_COL", expr: { type: "NUMBER", value: value.value, raw: value.raw ?? String(value.value) }, alias: obj["alias"], ...aliasDisplay }
        : { type: "LITERAL_COL", value: value.value, alias: obj["alias"], ...aliasDisplay }) as T;
    }
    if (obj["type"] === "VARIABLE_IN_LIST") return obj as T;
    const resolved = Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        resolveBatchVariableReferencesInternal(
          value,
          variables,
          (key === "left" || key === "right")
            ? obj["type"] === "AGG_ARITH"
              ? "AGG_ARITH"
              : (obj["type"] === "ARITH" || obj["type"] === "SCALAR_ARITH")
                ? "ARITH"
                : false
            : false
        ),
      ])
    ) as Record<string, unknown>;
    if (typeof obj["aliasDisplay"] === "string") {
      resolved["aliasDisplay"] = obj["aliasDisplay"];
    }
    if (resolved["type"] === "BINARY") {
      const right = resolved["right"] as Record<string, unknown> | undefined;
      if (right?.["type"] === "VARIABLE_IN_LIST" && typeof right["name"] === "string") {
        const value = variables.get(right["name"]);
        if (value === undefined) throw new Error(`ParseError: variable @${right["name"]} is not defined in this batch.`);
        if (value.type !== "array") {
          throw new Error(`ParseError: scalar variable @${right["name"]} cannot be used as IN @${right["name"]}; use IN (@${right["name"]}) instead.`);
        }
        if (value.elements.length === 0) {
          return { type: "BOOLEAN", value: resolved["op"] === "NOT_IN" } as T;
        }
        resolved["right"] = {
          type: "IN_LIST",
          values: value.elements.map((element) => ({ type: "STRING", value: element.value })),
        };
      }
    }
    const simplified = simplifyBooleanWhere(resolved);
    if (simplified["type"] === "SELECT" && isBooleanNode(simplified["where"], true)) {
      simplified["where"] = null;
    }
    if ((simplified["type"] === "UPDATE" || simplified["type"] === "DELETE" || simplified["type"] === "REORDER")
        && isBooleanNode(simplified["where"], true)) {
      throw new Error("ArgumentError: empty-array simplification makes the target WHERE always true; use an explicit safe target condition.");
    }
    return simplified as T;
  }
  return node;
}

function isBooleanNode(value: unknown, expected?: boolean): value is { type: "BOOLEAN"; value: boolean } {
  return value !== null && typeof value === "object"
    && (value as { type?: unknown }).type === "BOOLEAN"
    && (expected === undefined || (value as { value?: unknown }).value === expected);
}

function simplifyBooleanWhere(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj["type"] === "NOT" && isBooleanNode(obj["expr"])) {
    return { type: "BOOLEAN", value: !obj["expr"].value };
  }
  if (obj["type"] === "GROUP" && isBooleanNode(obj["expr"])) return obj["expr"];
  if (obj["type"] === "LOGICAL") {
    const left = obj["left"];
    const right = obj["right"];
    if (obj["op"] === "AND") {
      if (isBooleanNode(left, false) || isBooleanNode(right, false)) return { type: "BOOLEAN", value: false };
      if (isBooleanNode(left, true)) return right as Record<string, unknown>;
      if (isBooleanNode(right, true)) return left as Record<string, unknown>;
    } else if (obj["op"] === "OR") {
      if (isBooleanNode(left, true) || isBooleanNode(right, true)) return { type: "BOOLEAN", value: true };
      if (isBooleanNode(left, false)) return right as Record<string, unknown>;
      if (isBooleanNode(right, false)) return left as Record<string, unknown>;
    }
  }
  return obj;
}

function findVariableRef(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findVariableRef(value);
      if (found !== null) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ((obj["type"] === "VARIABLE" || obj["type"] === "VARIABLE_COL" || obj["type"] === "VARIABLE_IN_LIST")
        && typeof obj["name"] === "string") return obj["name"];
    for (const value of Object.values(obj)) {
      const found = findVariableRef(value);
      if (found !== null) return found;
    }
  }
  return null;
}

// ============================================================
// ASSERT（バッチ強化第1弾 §2）
// ============================================================

/** ASSERT 失敗。message 接頭辞で code = AssertError として報告される */
export class AssertError extends Error {
  constructor(message: string) {
    super(`AssertError: ${message}`);
    this.name = "AssertError";
  }
}

/** ASSERT / SET に依存しないスカラーサブクエリの形状エラー。 */
class ScalarSubqueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScalarSubqueryError";
  }
}

/**
 * ASSERT 文を評価する。条件が false なら AssertError を投げる。
 * サブクエリの一時テーブル参照はバッチ実行時のみ解決できる（tempTables 経由）。
 */
async function executeAssert(
  stmt: AssertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<AssertResult> {
  const evaluation = await evaluateAssertCondition(stmt, client, options, cacheContext, tempTables);
  if (!evaluation.passed) {
    if (stmt.warn === true) {
      return {
        type: "ASSERT",
        condition: stmt.text,
        passed: false,
        warning: stmt.message ?? `assertion failed: ${stmt.text} (actual: ${evaluation.actual}).`,
      };
    }
    const suffix = stmt.message !== undefined ? ` ${stmt.message}` : "";
    throw new AssertError(`assertion failed: ${stmt.text} (actual: ${evaluation.actual}).${suffix}`);
  }
  // 既存 ASSERT 成功結果の列挙可能な形は変えない。
  return { type: "ASSERT", condition: stmt.text };
}

async function executeExit(
  stmt: ExitStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<ExitResult> {
  const evaluation = await evaluateAssertCondition(stmt, client, options, cacheContext, tempTables);
  return {
    type: "EXIT",
    condition: stmt.text,
    exited: evaluation.passed,
    message: stmt.message,
  };
}

async function evaluateAssertCondition(
  stmt: AssertStatement | ExitStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<{ passed: boolean; actual: string }> {
  const left = await evalAssertOperand(stmt.left, client, options, cacheContext, tempTables);
  const semantics = stmt.left.type === "NUMBER" || stmt.left.type === "ARITH"
    ? syntheticSemantics("number")
    : syntheticSemantics("string");

  if (stmt.op === "BETWEEN") {
    if (stmt.low === null || stmt.high === null) {
      throw new Error("ArgumentError: malformed ASSERT statement.");
    }
    const low  = await evalAssertOperand(stmt.low,  client, options, cacheContext, tempTables);
    const high = await evalAssertOperand(stmt.high, client, options, cacheContext, tempTables);
    // WHERE の BETWEEN と同じ >= AND <= 展開
    return {
      passed: compareScalarValues(">=", left, low, semantics)
        && compareScalarValues("<=", left, high, semantics),
      actual: left,
    };
  }

  if (stmt.right === null) {
    throw new Error("ArgumentError: malformed ASSERT statement.");
  }
  const right = await evalAssertOperand(stmt.right, client, options, cacheContext, tempTables);
  return { passed: compareScalarValues(stmt.op, left, right, semantics), actual: left };
}

/** ASSERT のオペランドを文字列値に評価する（サブクエリは 1行1列を実行時検証） */
async function evalAssertOperand(
  operand: AssertOperand,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<string> {
  switch (operand.type) {
    case "VARIABLE":
      throw new Error(`ParseError: unresolved batch variable @${operand.name}.`);
    case "NUMBER": return numberLiteralText(operand);
    case "STRING": return operand.value;
    case "ARITH":  return String(evalAssertArith(operand));
    case "SCALAR_SUBQUERY": {
      try {
        return await evaluateScalarSubquery(
          operand.query,
          client,
          options,
          cacheContext,
          tempTables
        );
      } catch (e) {
        if (e instanceof ScalarSubqueryError) throw new AssertError(e.message);
        throw e;
      }
    }
  }
}

/** スカラーサブクエリを1回実行し、厳密に1行1列の文字列値へ変換する。 */
async function evaluateScalarSubquery(
  sourceQuery: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<string> {
  const { query, probed } = withScalarProbeLimit(sourceQuery);
  const result = await runSubquery(query, client, options, cacheContext, tempTables);
  if (result.columns.length !== 1) {
    throw new ScalarSubqueryError(
      `scalar subquery returned ${result.columns.length} columns (expected 1 column).`
    );
  }
  if (result.rowCount === 0) {
    throw new ScalarSubqueryError("scalar subquery returned no rows (expected 1 row).");
  }
  if (result.rowCount > 1) {
    // probe（LIMIT 2 打ち切り）時は総行数が分からない
    const rows = probed && result.rowCount === 2 ? "2 or more rows" : `${result.rowCount} rows`;
    throw new ScalarSubqueryError(`scalar subquery returned ${rows} (expected 1 row).`);
  }
  return result.rows[0]?.[result.columns[0]] ?? "";
}

/**
 * 非集計・非 GROUP BY・非 DISTINCT のスカラー検証は 2 行取得できた時点で
 * 「複数行」と確定するため LIMIT 2 で打ち切る（仕様 §2.3）。
 * 集計は結果が 1 行でも計算に全対象行の取得が必要なため適用しない。
 * ユーザーが LIMIT を明示した場合はそれを尊重する。
 */
function withScalarProbeLimit(query: SelectStatement): { query: SelectStatement; probed: boolean } {
  const hasAgg =
    normalizeGroupingSpec(query).type !== "NONE" ||
    query.columns.some((c) => c.type === "AGGREGATE" || c.type === "ARITH_AGG_COL");
  if (hasAgg || query.distinct || query.limit !== null) return { query, probed: false };
  return { query: { ...query, limit: 2 }, probed: true };
}

/** ASSERT の算術式を評価する（葉は数値リテラルのみ — パーサで検証済み） */
function evalAssertArith(node: ArithNode): number {
  if (node.type === "VARIABLE") {
    throw new Error(
      `InternalError: unresolved arithmetic variable @${node.name} reached ASSERT evaluation.`
    );
  }
  if (node.type === "NUMBER") return node.value;
  if (node.type === "ARITH") {
    const left  = evalAssertArith(node.left);
    const right = evalAssertArith(node.right);
    switch (node.op) {
      case "+": return left + right;
      case "-": return left - right;
      case "*": return left * right;
      case "/": return left / right;
      case "%": return left % right;
    }
  }
  throw new Error(`ArgumentError: unsupported operand in ASSERT expression: ${node.type}`);
}

// ============================================================
// SELECT
// ============================================================

async function buildWhereFieldSemanticsResolver(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>,
  forcePhysicalMetadata = false
): Promise<WhereFieldSemanticsResolver> {
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  // $id はスキーマ不要の組み込み列。これだけの predicate で form API を増やさない。
  const physicalAppIds = forcePhysicalMetadata || whereNeedsFieldMetadata(stmt.where)
    ? [...new Set(tables.filter((table) => table.cteName === null).map((table) => table.appId))]
    : [];
  const infosByApp = new Map<number, Map<string, KintoneFieldInfo>>(
    await Promise.all(physicalAppIds.map(async (appId) => {
      const infos = await getFieldsCached(appId, client, cacheContext);
      return [appId, new Map(infos.map((info) => [info.code, info]))] as const;
    }))
  );
  const orderedFields = new Set<string>();
  const collectOrderedFields = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(collectOrderedFields);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (value["type"] === "SELECT") return;
    const operator = String(value["op"]);
    const right = value["right"] as Record<string, unknown> | undefined;
    const needsOptionExistence = ["=", "!=", "<>"].includes(operator)
      && right?.["type"] === "STRING"
      && right["value"] !== "";
    if (value["type"] === "BINARY"
      && ([">", "<", ">=", "<="].includes(operator) || needsOptionExistence)) {
      const left = value["left"] as Record<string, unknown> | undefined;
      if (left?.["type"] === "FIELD" && typeof left["field"] === "string") {
        orderedFields.add(left["field"] as string);
      }
    }
    Object.values(value).forEach(collectOrderedFields);
  };
  collectOrderedFields(stmt.where);
  collectOrderedFields(stmt.having);
  for (const column of stmt.columns) {
    if (column.type === "CASE_COL") collectOrderedFields(column.expr);
  }
  const statusOrdersByApp = new Map<number, ReadonlyMap<string, number>>();
  await Promise.all([...infosByApp].map(async ([appId, infos]) => {
    const needsStatus = [...orderedFields].some((field) => infos.get(field)?.fieldType === "STATUS");
    if (!needsStatus) return;
    const order = await loadProcessStatusOrder(appId, client, cacheContext);
    if (order) statusOrdersByApp.set(appId, order);
  }));

  const fromPhysical = (
    table: TableRef,
    field: string,
    allowSubtableSystemColumns: boolean
  ): ResolvedFieldSemantics | undefined => {
    if (field === "$id") return withFieldSemanticSource(
      resolveFieldSemantics({ fieldType: "__ID__" }), table.appId, "$id"
    );
    if (allowSubtableSystemColumns && table.subtableCode) {
      if (field === "_rid") return syntheticSemantics("string");
      if (field === "_idx" || field === "_pid") return syntheticSemantics("number");
    }
    const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field));
    if (!info) return undefined;
    const base = info.semantics ?? resolveFieldSemantics(info);
    const semantics = info.fieldType === "STATUS" && statusOrdersByApp.has(table.appId)
      ? { ...base, optionOrder: statusOrdersByApp.get(table.appId) }
      : base;
    return withFieldSemanticSource(
      semantics,
      table.appId,
      info.code
    );
  };

  return (field) => {
    if (field.tableAlias !== null) {
      if (field.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        return fromPhysical(stmt.from, field.field, false);
      }
      const table = tables.find((candidate) => effectiveTableAlias(candidate) === field.tableAlias);
      if (!table) return undefined;
      if (table.cteName !== null) {
        return materializedTables?.get(table.cteName)?.columnMeta?.get(field.field)?.semantics
          ?? syntheticSemantics("string");
      }
      return fromPhysical(table, field.field, true);
    }
    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) {
        return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(field.field)?.semantics
          ?? syntheticSemantics("string");
      }
      return fromPhysical(stmt.from, field.field, true);
    }
    const matches = tables.flatMap((table): ResolvedFieldSemantics[] => {
      const semantics = table.cteName !== null
        ? materializedTables?.get(table.cteName)?.columnMeta?.get(field.field)?.semantics
        : fromPhysical(table, field.field, true);
      return semantics ? [semantics] : [];
    });
    if (matches.length === 1) return matches[0];
    if (tables.some((table) => subtableSystemFieldType(table, field.field) !== undefined)) return undefined;
    // JOIN の非修飾同名列は既存契約どおりローカル値として評価する。
    return matches.length > 1 ? syntheticSemantics("string") : undefined;
  };
}

const choiceEqualityRewritesBySelect = new WeakMap<
  SelectStatement,
  readonly ChoiceEqualityRewrite[]
>();

async function normalizeSelectChoiceEquality(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>,
  forcePhysicalMetadata = false
): Promise<{
  resolver: WhereFieldSemanticsResolver;
  rewrites: readonly ChoiceEqualityRewrite[];
}> {
  const resolver = await buildWhereFieldSemanticsResolver(
    stmt, client, cacheContext, materializedTables, forcePhysicalMetadata
  );
  if (stmt.where === null) return { resolver, rewrites: [] };
  const normalization = normalizeChoiceEquality(stmt.where, resolver);
  stmt.where = normalization.normalizedWhere;
  if (normalization.rewrites.length > 0) {
    choiceEqualityRewritesBySelect.set(stmt, normalization.rewrites);
  }
  return { resolver, rewrites: normalization.rewrites };
}

type WindowWarningContext = "DIRECT" | "DERIVED";

function hasDefaultRangeAggregateWindow(stmt: SelectStatement): boolean {
  return stmt.columns.some((column) =>
    column.type === "WINDOW_COL"
    && column.windowKind === "AGGREGATE"
    && column.orderBy.length > 0
    && column.frame?.source === "DEFAULT"
  );
}

function hasWindowNeedingOrderProof(stmt: SelectStatement): boolean {
  return hasDefaultRangeAggregateWindow(stmt)
    || stmt.columns.some((column) => column.type === "WINDOW_COL" && column.windowKind === "VALUE");
}

function canProveTotalWindowOrder(
  stmt: SelectStatement,
  orderBy: readonly OrderByItem[],
  resolveField: WhereFieldSemanticsResolver,
  context: WindowWarningContext,
  generatedColumn?: string
): boolean {
  if (generatedColumn !== undefined && stmt.joins.length === 0 && stmt.from.cteName !== null) {
    return orderBy.some((item) => {
      if (item.key.type !== "FIELD_NAME") return false;
      const ref = aggregateFieldRef(item.key.name);
      if (ref.field !== generatedColumn) return false;
      return ref.tableAlias === null || ref.tableAlias === effectiveTableAlias(stmt.from);
    });
  }
  if (context !== "DIRECT" || stmt.joins.length > 0 || stmt.from.cteName !== null || stmt.from.subtableCode != null) return false;
  return orderBy.some((item) => {
    if (item.key.type !== "FIELD_NAME") return false;
    const ref = aggregateFieldRef(item.key.name);
    return ref.field === "$id" || resolveField(ref)?.fieldType === "RECORD_NUMBER";
  });
}

/**
 * タイブレークの助言（B140-C）。
 *
 * **実行できない助言を出さないための分岐。** CTE / 一時テーブルを読む SELECT には
 * `レコード番号` が存在しないため、従来の文言どおりに直すと
 * `unknown field code(s): レコード番号` で落ちる（実測・v3.51.0）。
 * 「読み飛ばされる」より悪く、**従うと壊れる**助言になっていた。
 */
function tieBreakAdvice(context: WindowWarningContext, kind: "RANGE" | "VALUE"): string {
  if (context !== "DIRECT") {
    // CTE / 一時テーブルを読む経路。その表に レコード番号 は無いので、案内を変える。
    // （`stmt.from.cteName` は実体化の過程でクリアされるため信号に使えない）
    //
    // 限界も併記する（依頼元の指摘・2026-08-06）。`GROUP BY` キーで並べている場合は
    // **すでに一意なのに証明できず警告が出る**ため、助言だけだと「従っても消せない」。
    // 一意性の証明そのものは B140 案 A（関係レベルの候補キー）で別途。
    // 「無視してよい条件」を書く（依頼元の提案・2026-08-07）。
    // 依頼元は「困っていたのは警告が出ることではなく、消し方が分からないこと」と回答し、
    // **消せないと分かれば運用に載る**。ここまで書けば C（もう読まない）へ落ちる理由が消える。
    //
    // 「すべて」が要る。`GROUP BY a, b` に対し `ORDER BY a` だけでは同順が生じる。
    //
    // この助言が成り立つことは実測で確かめた（2026-08-07）＝
    // グループ分けは格納文字列で行い、並べ替えは列の型で比べ方が変わるので、
    // 「表記は違うが数値として等しい」値があると同順になり得る。
    //   engine    '1' と '01'、'1' と '1.0' は同順になる（モックで確認）
    //   kintone   NUMBER は保存時に正規化する（'01' → '1'、'1e2' → '100'。実機で確認）
    //   空セルと 0  同順にならない（空は最小値として置かれる。実データとモックの両方）
    // つまり **kintone の NUMBER では表記違いを保持できない**ので、同順は生じない。
    return "ウィンドウの各パーティション内で、ORDER BY の値の組が入力行を一意に識別するとクエリ構造または保証済みのデータ制約から確認できる場合に限り、この警告は無視できます。"
      + "元の集約キーをすべて ORDER BY に含む形や、JOIN 後も同じ系列値が各パーティション内で高々1行と保証できる形が該当します。"
      + "生成列、再帰の深さ列、または $id に由来する列であるという理由だけでは無視できません。";
  }
  // 物理アプリを読む経路（JOIN を含む）。レコード番号 / $id が実在する。
  return kind === "RANGE"
    ? "ORDER BY にレコード番号などのタイブレークキーを足してください。"
    : "レコード番号等を ORDER BY に追加してください。";
}

function collectDefaultRangeWindowWarnings(
  stmt: SelectStatement,
  resolveField: WhereFieldSemanticsResolver,
  context: WindowWarningContext,
  generatedColumn?: string
): string[] {
  const warnings: string[] = [];

  for (const column of stmt.columns) {
    if (
      column.type !== "WINDOW_COL"
      || column.windowKind !== "AGGREGATE"
      || column.orderBy.length === 0
      || column.frame?.source !== "DEFAULT"
    ) continue;
    if (canProveTotalWindowOrder(stmt, column.orderBy, resolveField, context, generatedColumn)) continue;
    warnings.push(
      `${column.alias} は既定フレーム（RANGE）で評価されます。` +
      "ORDER BY の値が同じ行はすべて同じ値になります。" +
      "行ごとの値が必要なら ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示するか、" +
      tieBreakAdvice(context, "RANGE")
    );
  }
  for (const column of stmt.columns) {
    if (column.type !== "WINDOW_COL" || column.windowKind !== "VALUE") continue;
    if (canProveTotalWindowOrder(stmt, column.orderBy, resolveField, context, generatedColumn)) continue;
    warnings.push(
      `${column.alias} の ORDER BY は全順序でないため、同順内の前後関係は未規定です。` +
      tieBreakAdvice(context, "VALUE")
    );
  }
  return warnings;
}

function mergeSelectWarnings(result: SelectResult, additional: readonly string[]): SelectResult {
  if (additional.length === 0) return result;
  const merged = { ...result, warnings: [...new Set([...(result.warnings ?? []), ...additional])] };
  const meta = materializedMetaBySelectResult.get(result);
  if (meta) materializedMetaBySelectResult.set(merged, meta);
  return merged;
}

function selectCaseConditionsNeedFieldMetadata(stmt: SelectStatement): boolean {
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    const node = value as { type?: string; branches?: Array<{ condition: WhereExpr }> };
    if (node.type === "CASE_WHEN" && node.branches?.some((branch) => whereNeedsFieldMetadata(branch.condition))) return true;
    return Object.values(node).some(visit);
  };
  return stmt.columns.some(visit);
}

function buildHavingFieldSemanticsResolver(
  stmt: SelectStatement,
  rowResolver: FieldSemanticsResolver
): FieldSemanticsResolver {
  const aliases = new Map<string, ResolvedFieldSemantics>();
  for (const column of stmt.columns) {
    if (!("alias" in column) || !column.alias) continue;
    let semantics: ResolvedFieldSemantics | undefined;
    if (column.type === "FIELD") semantics = rowResolver(aggregateFieldRef(column.field));
    else if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL") {
      semantics = syntheticSemantics("number");
    } else if (column.type === "WINDOW_COL") {
      if (column.windowKind === undefined || column.windowKind === "RANKING"
        || (column.windowKind === "AGGREGATE"
          && (column.aggFunc === "COUNT" || column.aggFunc === "SUM" || column.aggFunc === "AVG"))) {
        semantics = syntheticSemantics("number");
      } else if ((column.windowKind === "AGGREGATE" || column.windowKind === "VALUE")
        && column.arg.type !== "WILDCARD") {
        semantics = inferAggregateArgMeta(column.arg, (ref) => {
          const resolved = rowResolver(ref);
          return resolved ? {
            sortKind: resolved.compareMode === "number" || resolved.compareMode === "recordNumber" ? "number" : "string",
            fieldType: resolved.fieldType,
            semantics: resolved,
          } : undefined;
        }).semantics;
      }
    } else if (column.type === "AGGREGATE") {
      if (column.func === "MIN" || column.func === "MAX" || column.func === "MODE") {
        if (column.arg.type !== "WILDCARD") {
          semantics = inferAggregateArgMeta(column.arg, (ref) => {
            const resolved = rowResolver(ref);
            if (!resolved) return undefined;
            return {
              sortKind: resolved.compareMode === "number" || resolved.compareMode === "recordNumber" ? "number" : "string",
              fieldType: resolved.fieldType,
              semantics: resolved,
            };
          }).semantics;
        }
      } else {
        semantics = column.func === "GROUP_CONCAT" ? syntheticSemantics("string") : syntheticSemantics("number");
      }
    } else if (column.type === "STRFUNC_COL") {
      semantics = stringFunctionColumnMeta(column.expr).semantics;
    } else if (column.type === "LITERAL_COL" || column.type === "SCALAR_SUBQUERY_COL" || column.type === "CASE_COL" || column.type === "SCALAR_VALUE_COL") {
      semantics = syntheticSemantics("string");
    }
    if (semantics) aliases.set(column.alias, semantics);
  }
  return (field) => field.tableAlias === null && aliases.has(field.field)
    ? aliases.get(field.field)
    : rowResolver(field);
}

async function resolveSelectWhereCapability(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<PredicateCapabilityResult> {
  if (stmt.where === null) return classifyWhereCapability(null, () => undefined);
  const resolver = await buildWhereFieldSemanticsResolver(stmt, client, cacheContext, materializedTables);
  return classifyWhereCapability(stmt.where, resolver);
}

function formatWhereCapabilityFailure(result: PredicateCapabilityResult): string {
  const reason = result.reasons.find((candidate) =>
    candidate.code === "WHERE_FIELD_UNRESOLVED" || candidate.code === "WHERE_OPERATOR_UNSUPPORTED" || candidate.code === "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE"
  ) ?? result.reasons[0];
  const details = [
    reason?.field ? `field=${reason.field}` : null,
    reason?.fieldType ? `type=${reason.fieldType}` : null,
    reason?.operator ? `operator=${reason.operator}` : null,
    reason?.code ? `reason=${reason.code}` : null,
  ].filter((value): value is string => value !== null).join(", ");
  return details || "reason=WHERE_UNSUPPORTED";
}

function hasCanonicalOrder(stmt: SelectStatement): boolean {
  return stmt.orderBy.length > 0 || stmt.columns.some(
    (column) => column.type === "WINDOW_COL" && column.orderBy.length > 0
  );
}

async function resolveDmlWhereCapability(
  stmt: UpdateStatement | DeleteStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<PredicateCapabilityResult> {
  // サブテーブルDMLは既存どおり親を取得してローカル評価する。B32はREST対象選択経路を扱う。
  // UPDATE ... FROM の WHERE はソースとの結合条件で、専用の照合器が対象を決める。
  if (stmt.subtableCode || (stmt.type === "UPDATE" && stmt.from != null)) {
    return {
      capability: "LOCAL_ONLY",
      reasons: [{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }],
    };
  }
  const fields = whereNeedsFieldMetadata(stmt.where)
    ? await getFieldsCached(stmt.appId, client, cacheContext)
    : [];
  const byCode = new Map(fields.map((field) => [field.code, field]));
  if (stmt.where.type === "BOOLEAN" && stmt.where.value === false) {
    return classifyWhereCapability(null, () => undefined);
  }
  return classifyWhereCapability(stmt.where, (field) => {
    // UPDATE/DELETE の対象は単一アプリ。パーサが保持する APP100. 修飾も同じ対象列を指す。
    if (field.field === "$id") return resolveFieldSemantics({ fieldType: "__ID__" });
    const info = byCode.get(field.field);
    return info?.semantics ?? (info ? resolveFieldSemantics(info) : undefined);
  });
}

async function assertDmlWhereCapability(
  stmt: UpdateStatement | DeleteStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<void> {
  // Existing local target-selection routes retain their established behavior.
  // B67 rejects relative-date use in these routes in the statement plan guard.
  if (stmt.subtableCode || (stmt.type === "UPDATE" && stmt.from != null)) return;
  const result = await resolveDmlWhereCapability(stmt, client, cacheContext);
  if (result.capability !== "EXACT_PUSHDOWN") {
    throw new DmlConvertError(
      `WHERE predicate cannot be represented by kintone REST (${formatWhereCapabilityFailure(result)})`
    );
  }
}

async function executeSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** CTE / 一時テーブルのキャッシュ。サブクエリ解決に引き継ぐ（トップレベルの
   *  FROM / JOIN 参照は executeQueryWithCte 側で処理済みの前提） */
  cteCache?: Map<string, MaterializedTable>,
  captureColumnMeta = false,
  forLibraryCapture = false,
  windowWarningContext: WindowWarningContext = "DIRECT"
): Promise<SelectResult> {
  let result: SelectResult;
  const subqueryWarnings = new Set<string>();
  await validateSelectGroupingPlanning(stmt, client, cacheContext, cteCache);
  if (isNoFromSelect(stmt)) {
    result = executeNoFromSelect(stmt, options);
    if (captureColumnMeta) {
      materializedMetaBySelectResult.set(
        result,
        await inferSelectColumnMeta(stmt, result.columns, client, cacheContext, cteCache, forLibraryCapture)
      );
    }
    return result;
  }
  const { resolver: fieldSemanticsResolver } = await normalizeSelectChoiceEquality(
    stmt,
    client,
    cacheContext,
    cteCache,
    hasWindowNeedingOrderProof(stmt)
  );
  const defaultRangeWarnings = collectDefaultRangeWindowWarnings(
    stmt,
    fieldSemanticsResolver,
    windowWarningContext
  );
  const plainGroupByPlan = await buildRuntimePlainGroupByPlan(
    stmt,
    client,
    cacheContext,
    cteCache
  );
  await resolveSelectCaseSubqueries(stmt, client, options, cacheContext, subqueryWarnings, cteCache);
  const whereCapability = rememberSelectWhereCapability(
    stmt,
    classifyWhereCapability(stmt.where, fieldSemanticsResolver)
  );
  if (whereCapability.capability === "UNSUPPORTED") {
    throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(whereCapability)}).`);
  }
  const staticMode = resolveSelectMode(stmt);
  let prefilterPlan: RelativeDatePrefilterPlan | undefined;
  let fullScanExactPlan: RelativeDateFullScanExactPlan | undefined;
  if (whereCapability.capability === "SUPERSET_PREFILTER") {
    const resolver = await buildWhereFieldSemanticsResolver(stmt, client, cacheContext, cteCache);
    const decomposition = decomposeRelativeDatePrefilter(stmt, resolver);
    if (
      decomposition.eligible
      && allowRelativeDatePrefilterPlan(stmt, decomposition)
    ) {
      prefilterPlan = decomposition.plan;
    }
  }
  if (
    prefilterPlan === undefined
    && whereCapability.capability === "EXACT_PUSHDOWN"
    && stmt.where !== null
  ) {
    let serializedWholeWhere: string | null = null;
    try {
      serializedWholeWhere = whereToKintone(stmt.where);
    } catch {
      serializedWholeWhere = null;
    }
    fullScanExactPlan = buildRelativeDateFullScanExactPlan({
      select: stmt,
      selectMode: staticMode,
      capability: whereCapability,
      context: { allowFullScanExact: true },
      serializedWholeWhere,
      relativeFunctionNames: serverOnlyFunctionOccurrencesInWhere(stmt.where),
    }) ?? undefined;
    if (fullScanExactPlan) prefilterPlan = fullScanExactPlan.prefilterPlan;
  }
  const mode: SelectMode = whereCapability.capability === "EXACT_PUSHDOWN"
    ? staticMode
    : "FULL_SCAN";
  const orderMeta = await buildOrderByMetaForSelect(stmt, client, cacheContext, cteCache);
  const orderPlan = hasCanonicalOrder(stmt)
    ? (stmt.orderMode === "KINTONE_NATIVE" ? planKorder : planCanonicalOrder)({
        stmt,
        staticMode: mode,
        whereCapability: whereCapability.capability,
        whereReasons: whereCapability.reasons,
        orderSemantics: orderMeta.semantics,
        maxRecords: options.maxRecords ?? 10_000,
        hasKlike: whereHasKlike(stmt.where),
      })
    : null;
  const subtableFieldWarnings = await validateSelectFieldCodes(
    stmt,
    orderPlan?.kind === "CANONICAL_LOCAL" ? "FULL_SCAN" : mode,
    client,
    cacheContext
  );
  // REST top-N がトップレベル ORDER BY を完全に担う場合だけ、B30 の完全入力要求から
  // その ORDER BY を除く。window / subquery ORDER BY の要求は残す。
  const completePolicy = buildCompleteInputPolicy(
    stmt,
    options,
    orderPlan
  );
  const failClosedForB72Local =
    fullScanExactPlan !== undefined
    && (
      staticMode === "FULL_SCAN"
      || orderPlan?.kind === "CANONICAL_LOCAL"
    );
  const executionClient = failClosedForB72Local
    ? wrapClientWithSearchAbort(client, { aborted: false }, true)
    : client;

  try {
    if (mode === "SIMPLE") {
      result = await executeSimpleSelect(
        stmt,
        executionClient,
        completePolicy.effectiveOptions,
        cacheContext,
        orderPlan,
        orderMeta
      );
    } else {
      result = await executeFullScanSelect(
        stmt,
        executionClient,
        completePolicy.effectiveOptions,
        cacheContext,
        cteCache,
        whereCapability.capability === "EXACT_PUSHDOWN"
          && prefilterPlan === undefined,
        orderMeta,
        prefilterPlan,
        plainGroupByPlan
      );
    }
  } catch (error) {
    throwCompleteInputError(completePolicy, error);
  }
  if (captureColumnMeta) {
    materializedMetaBySelectResult.set(
      result,
      await inferSelectColumnMeta(stmt, result.columns, client, cacheContext, cteCache, forLibraryCapture)
    );
  }
  return mergeSelectWarnings(result, [
    ...subqueryWarnings,
    ...defaultRangeWarnings,
    ...subtableFieldWarnings,
  ]);
}

/**
 * B71: source schema が揃った SELECT 単位で plain GROUP BY を解決する。
 * 確定した plan は fetch と pre-group 評価で共有する。
 */
/**
 * B145 親テーブルの GROUP BY に明細項目を書いたときの案内。
 *
 * plain `GROUP BY` と拡張 grouping（`ROLLUP` / `CUBE` / `GROUPING SETS` / `GROUPING()`）で
 * 同じ文面を出す。以前は 2 か所へ別々に書いており、片方だけ古くなる形だった。
 *
 * 書き換え先は「その項目を持つ APP」であって `FROM` 側の APP ではない
 * （実測: 別アプリを JOIN したとき `FROM` 側を案内し、従うと落ちた）。
 * 候補が 1 つに定まるときだけ名指しし、複数あるときは列挙にとどめる。
 */
function subtableGroupingAdvice(
  fieldName: string,
  owners: readonly { appId: number; owner: string }[]
): string {
  if (owners.length === 1) {
    const { appId, owner } = owners[0];
    return `ArgumentError: ${fieldName} はサブテーブル「${owner}」（APP${appId}）の中の項目です。`
      + "親テーブルの GROUP BY には指定できません。"
      + `APP${appId}$${owner} から集計してください`
      + "（親のレコード ID は _pid、親項目は _p.<フィールドコード> になります）。";
  }
  const list = owners.map(({ appId, owner }) => `APP${appId}$${owner}`).join(" / ");
  return `ArgumentError: ${fieldName} はサブテーブルの中の項目です（${list}）。`
    + "親テーブルの GROUP BY には指定できません。どのサブテーブルから集計するかを "
    + "FROM で指定してください。";
}

/** 同じ (appId, owner) の重複を落とす。JOIN で同じ APP が複数回現れる形に効く。 */
function dedupeSubtableOwners(
  owners: readonly { appId: number; owner: string }[]
): { appId: number; owner: string }[] {
  const seen = new Set<string>();
  const result: { appId: number; owner: string }[] = [];
  for (const entry of owners) {
    const key = `${entry.appId}\u0000${entry.owner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

async function buildRuntimePlainGroupByPlan(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<PlainGroupByResolutionPlan | undefined> {
  const normalized = normalizeGroupingSpec(stmt);
  if (!isAggregateQueryBlock(stmt) || normalized.type === "GROUPING_SETS") {
    return undefined;
  }
  // GROUP BY なし集計は identity が空なので AST-only で最終判断できる。
  // COUNT(*) 等の正当な query にフォーム定義取得を追加しない。
  if (normalized.type === "NONE") return undefined;
  const groupBy = normalized.allItems;

  const sources = [stmt.from, ...stmt.joins.map((join) => join.table)];
  // B145: 親テーブルの GROUP BY キーに明細項目を書くと UNKNOWN になる。
  // 「存在しない」ではなく「別の表にある」ので、名指しできるよう控えておく。
  //
  // どの APP のサブテーブルかまで持つ。フィールドコードだけで持つと、別アプリを
  // JOIN したときに「FROM 側の APP のサブテーブル」と誤って案内してしまう
  // （実測: APP4229 JOIN APP4233 で `APP4229$テーブル` と案内した。APP4229 に
  // サブテーブルは無く、従うと落ちる）。
  const subtableOwners = new Map<string, { appId: number; owner: string }[]>();
  const inputs = await Promise.all(sources.map(async (source): Promise<PlainGroupBySourceSchemaInput> => {
    if (source.cteName !== null) {
      const materialized = materializedTables?.get(source.cteName);
      if (!materialized) {
        throw new Error(`InternalError: materialized schema ${source.cteName} is not available for GROUP BY planning.`);
      }
      return { kind: "MATERIALIZED", columns: materialized.columns };
    }

    const fields = await getFieldsCached(source.appId, client, cacheContext);
    if (!source.subtableCode) {
      for (const field of fields) {
        if (field.inSubtable !== true || !field.subtableCode) continue;
        const entries = subtableOwners.get(field.code) ?? [];
        entries.push({ appId: source.appId, owner: field.subtableCode });
        subtableOwners.set(field.code, dedupeSubtableOwners(entries));
      }
      return {
        kind: "APP",
        fieldCodes: fields.filter((field) => !field.inSubtable).map((field) => field.code),
      };
    }

    const exactChildren = fields.filter((field) =>
      field.inSubtable && field.subtableCode === source.subtableCode
    );
    // 古い埋め込み client は subtableCode を省略することがあるため、
    // 対象表を一意に絞れない metadata では従来の全 child code を採る。
    const childFields = exactChildren.length > 0
      ? exactChildren
      : fields.filter((field) => field.inSubtable && field.subtableCode === undefined);
    return {
      kind: "SUBTABLE",
      childFieldCodes: childFields.map((field) => field.code),
      parentFieldCodes: fields.filter((field) => !field.inSubtable).map((field) => field.code),
    };
  }));

  const schemas = resolvePlainGroupBySourceSchemas(
    stmt,
    (_source, sourceIndex) => inputs[sourceIndex]
  );
  const plan = planPlainGroupByResolution(groupBy, stmt.columns, schemas);
  assertRuntimePlainGroupByPlan(stmt, groupBy, plan, subtableOwners);
  validateAggregateDependencies(stmt, buildOrdinaryDependencyPolicy(stmt, plan, schemas));
  return plan;
}

function assertRuntimePlainGroupByPlan(
  stmt: SelectStatement,
  groupBy: readonly GroupByKey[],
  plan: PlainGroupByResolutionPlan,
  subtableOwners: ReadonlyMap<string, { appId: number; owner: string }[]>
): void {
  const physicalAppIds = [
    stmt.from,
    ...stmt.joins.map((join) => join.table),
  ].flatMap((source) => source.cteName === null ? [source.appId] : []);
  const uniquePhysicalAppIds = [...new Set(physicalAppIds)];
  const primaryPhysicalAppId = uniquePhysicalAppIds.length === 1
    ? uniquePhysicalAppIds[0]
    : stmt.from.cteName === null
      ? stmt.from.appId
      : null;

  plan.items.forEach((item, index) => {
    if (
      item.kind === "EXPRESSION"
      || item.kind === "PHYSICAL"
      || item.kind === "ALIAS_SAFE"
    ) return;
    const key = groupBy[index];
    const name = key?.type === "FIELD_NAME" ? key.name : "(expression)";
    if (item.kind === "UNKNOWN") {
      const appSuffix = primaryPhysicalAppId === null ? "" : ` (APP${primaryPhysicalAppId})`;
      // B145: 明細項目は親テーブルの GROUP BY キーにできないが、存在はする。
      // 「unknown field code(s)」だと「そんな項目は無い」と読まれるので、
      // どの表にあるか・どう書き換えるかまで示す（SELECT 列の警告と同じ案内）。
      //
      // 書き換え先は「その項目を持つ APP」であって FROM 側の APP ではない。
      // 候補が 1 つに定まるときだけ名指しし、複数あるときは列挙にとどめる。
      // 別名で修飾した形（a.code）でも引けるよう、ドットの後ろでも探す。
      const dot = item.name.indexOf(".");
      const bare = dot >= 0 ? item.name.slice(dot + 1) : item.name;
      const owners = subtableOwners.get(item.name) ?? subtableOwners.get(bare) ?? [];
      if (owners.length > 0) {
        throw new Error(subtableGroupingAdvice(item.name, owners));
      }
      throw new Error(`ArgumentError: unknown field code(s): ${item.name}${appSuffix}`);
    }
    if (item.kind === "ALIAS_REJECT") {
      if (item.reason === "DUPLICATE") {
        throw new Error(
          `ArgumentError: GROUP BY alias ${name} is ambiguous across multiple SELECT columns ` +
          "(reason=GROUP_BY_ALIAS_AMBIGUOUS)."
        );
      }
      if (item.reason === "POST_GROUP_ONLY") {
        throw new Error(
          `ArgumentError: GROUP BY alias ${name} requires post-group evaluation ` +
          "(reason=GROUP_BY_ALIAS_POST_GROUP_ONLY)."
        );
      }
      throw new Error(
        `ArgumentError: GROUP BY alias ${name} depends on aggregate evaluation ` +
        "(reason=GROUP_BY_ALIAS_AGGREGATE)."
      );
    }
    throw new Error(
      `InternalError: deferred GROUP BY field ${item.name} reached runtime planning.`
    );
  });
}

const resolvedGroupingSpecs = new WeakMap<SelectStatement, ResolvedGroupingSpec>();

async function validateStatementGroupingPlanning(
  statement: unknown,
  client: KintoneClient,
  cacheContext: string
): Promise<void> {
  const seen = new Set<object>();
  const visit = async (node: unknown): Promise<void> => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) await visit(item);
      return;
    }
    const value = node as Record<string, unknown>;
    if (value["type"] === "SELECT") {
      // Query-block ordering: scalar/IN/EXISTS subqueries are checked before
      // their containing SELECT. Arrays and object properties retain parser
      // order, so UNION arms and WITH definitions remain left-to-right.
      for (const child of Object.values(value)) await visit(child);
      await validateSelectGroupingPlanning(node as SelectStatement, client, cacheContext);
      return;
    }
    for (const child of Object.values(value)) await visit(child);
  };
  await visit(statement);
}

async function buildGroupingFieldResolver(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<GroupingFieldResolver> {
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const physicalTables = tables.filter((table) => table.cteName === null);
  const infosByApp = new Map<number, Map<string, KintoneFieldInfo>>(
    await Promise.all([...new Set(physicalTables.map((table) => table.appId))].map(async (appId) => {
      const infos = await getFieldsCached(appId, client, cacheContext);
      return [appId, new Map(infos.map((info) => [info.code, info]))] as const;
    }))
  );

  // B145: 親テーブルから明細項目は参照できない。ここで「存在する」と扱うと
  // ROLLUP / CUBE / GROUPING SETS が常に空のキーで集計を通してしまい、
  // 全レコードが 1 グループへ畳まれた表が黙って返る（plain GROUP BY は
  // 別経路でエラーになるため、拡張 grouping だけが静かに間違っていた）。
  const subtableFieldOf = (table: TableRef, code: string): string | null => {
    if (table.subtableCode) return null;
    const info = infosByApp.get(table.appId)?.get(code);
    return info?.inSubtable === true ? (info.subtableCode ?? "") : null;
  };
  const physicalMatch = (table: TableRef, field: string): string | null => {
    if (field === "$id") return "$id";
    const code = fieldCodeForTypeLookup(table, field);
    if (subtableFieldOf(table, code) !== null) return null;
    return infosByApp.get(table.appId)?.has(code) ? code : null;
  };
  const materializedHas = (table: TableRef, field: string): boolean => {
    if (table.cteName === null) return false;
    const materialized = materializedTables?.get(table.cteName);
    // EXPLAIN cannot materialize CTE/temp rows. Conservatively require qualification
    // when an unqualified B65 field shares a statement with an unknown materialized source.
    return materialized ? materialized.columns.includes(field) : true;
  };
  const resolved = (
    table: TableRef,
    tableIndex: number,
    field: FieldRef,
    code: string
  ): ResolvedGroupingField => {
    const sameNamePhysical = tables.filter((candidate) =>
      candidate.cteName === null && physicalMatch(candidate, field.field) !== null
    ).length;
    const sameNameMaterialized = tables.some((candidate) => materializedHas(candidate, field.field));
    const alias = effectiveTableAlias(table);
    return {
      canonicalId: `source:${tableIndex}:APP${table.appId}:${code}`,
      directKey: field.tableAlias && alias ? `${field.tableAlias}.${field.field}` : field.field,
      unqualifiedBridgeKey:
        sameNamePhysical === 1 && !sameNameMaterialized ? field.field : null,
      physical: true,
    };
  };

  return (field): ResolvedGroupingField => {
    if (field.tableAlias !== null) {
      const tableIndex = tables.findIndex((table) => effectiveTableAlias(table) === field.tableAlias);
      if (tableIndex < 0) {
        throw new Error(`ArgumentError: field ${field.tableAlias}.${field.field} has an unknown table alias.`);
      }
      const table = tables[tableIndex];
      if (table.cteName !== null) {
        throw new Error(
          `ArgumentError: field ${field.tableAlias}.${field.field} resolves to materialized source ${table.cteName}; physical APP fields are required.`
        );
      }
      const code = physicalMatch(table, field.field);
      if (code === null) {
        // B145: 別名で修飾しても、明細項目なら「存在しない」ではなく別表を案内する。
        const owner = subtableFieldOf(table, fieldCodeForTypeLookup(table, field.field));
        if (owner !== null && owner !== "") {
          throw new Error(subtableGroupingAdvice(field.field, [{ appId: table.appId, owner }]));
        }
        throw new Error(`ArgumentError: field ${field.tableAlias}.${field.field} does not exist in APP${table.appId}.`);
      }
      return resolved(table, tableIndex, field, code);
    }

    const physicalMatches = tables.flatMap((table, tableIndex) => {
      if (table.cteName !== null) return [];
      const code = physicalMatch(table, field.field);
      return code === null ? [] : [{ table, tableIndex, code }];
    });
    const materializedMatches = tables.filter((table) => materializedHas(table, field.field));
    if (physicalMatches.length + materializedMatches.length > 1) {
      throw new Error(`ArgumentError: field ${field.field} is ambiguous across multiple sources.`);
    }
    if (physicalMatches.length === 1 && materializedMatches.length === 0) {
      const match = physicalMatches[0];
      return resolved(match.table, match.tableIndex, field, match.code);
    }
    if (materializedMatches.length === 1) {
      throw new Error(
        `ArgumentError: field ${field.field} resolves to a materialized CTE/temp column; physical APP fields are required.`
      );
    }
    // B145: 明細項目なら「存在しない」ではなく「別の表にある」ことを伝える。
    // plain GROUP BY と同じ案内に揃える。
    const owners = tables.flatMap((table) => {
      if (table.cteName !== null) return [];
      const owner = subtableFieldOf(table, fieldCodeForTypeLookup(table, field.field));
      return owner === null || owner === "" ? [] : [{ appId: table.appId, owner }];
    });
    const uniqueOwners = dedupeSubtableOwners(owners);
    if (uniqueOwners.length > 0) {
      throw new Error(subtableGroupingAdvice(field.field, uniqueOwners));
    }
    throw new Error(`ArgumentError: field ${field.field} does not exist in a physical APP source.`);
  };
}

async function validateSelectGroupingPlanning(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<void> {
  resolvedGroupingSpecs.delete(stmt);
  const normalized = normalizeGroupingSpec(stmt);
  const hasGroupingNodes = JSON.stringify(stmt.columns).includes('"GROUPING_')
    || JSON.stringify(stmt.orderBy).includes('"GROUPING_');
  if (normalized.type === "GROUPING_SETS" || hasGroupingNodes) {
    const resolver = await buildGroupingFieldResolver(stmt, client, cacheContext, materializedTables);
    const resolvedSpec = validateGroupingPlanning(
      stmt,
      resolver,
      enforceGroupingPlanningCandidateLimits
    );
    if (resolvedSpec) resolvedGroupingSpecs.set(stmt, resolvedSpec);
    return;
  }
  if (!isAggregateQueryBlock(stmt)) return;
  if (normalized.type === "NONE") {
    validateAggregateDependenciesStatic(stmt);
    return;
  }
  const sources = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const hasUnavailableMaterializedSource = sources.some((source) =>
    source.cteName !== null && !materializedTables?.has(source.cteName)
  );
  if (hasUnavailableMaterializedSource) return;
  await buildRuntimePlainGroupByPlan(stmt, client, cacheContext, materializedTables);
}

function completeInputErrorPrefix(reasons: ReadonlySet<CompleteInputReason>): string {
  const reasonList = [...reasons].join(", ");
  const aggregateSubjects: readonly [CompleteInputReason, string][] = [
    ["AGGREGATE_WINDOW", "集計ウィンドウの正しい結果"],
    ["GROUPING_SETS", "小計・総計の正しい結果"],
    ["STATISTICAL_AGGREGATE", "統計集約の正しい結果"],
    ["AGGREGATE", "集計の正しい結果"],
    ["GROUP_BY", "グループ集計の正しい結果"],
    ["DISTINCT", "DISTINCT の正しい結果"],
  ];
  const hasAggregateReason = aggregateSubjects.some(([reason]) => reasons.has(reason));
  const hasOrderReason = reasons.has("LOCAL_ORDER") || reasons.has("WINDOW_ORDER");
  const legacySubject = reasons.size === 1 && reasons.has("STATISTICAL_AGGREGATE")
    ? "統計集約の正しい結果"
    : reasons.size === 1 && reasons.has("GROUPING_SETS")
      ? "小計・総計の正しい結果"
      : reasons.size === 1 && reasons.has("AGGREGATE")
        ? "集計の正しい結果"
        : reasons.size === 1 && reasons.has("GROUP_BY")
          ? "グループ集計の正しい結果"
          : reasons.size === 1 && reasons.has("DISTINCT")
            ? "DISTINCT の正しい結果"
            : reasons.has("GROUPING_SETS")
              ? "クエリの正しい結果"
              : "ORDER BYの正しい結果";
  const subject = reasons.size === 1 && reasons.has("CROSS_JOIN")
    ? "CROSS JOIN の正しい結果"
    : reasons.has("DML") || reasons.has("VALIDATE")
    ? legacySubject
    : hasAggregateReason && hasOrderReason
      ? "クエリの正しい結果"
      : hasAggregateReason
        ? aggregateSubjects.find(([reason]) => reasons.has(reason))![1]
        : "ORDER BYの正しい結果";
  return `${subject}には完全な候補集合が必要です。complete input reason: ${reasonList}。`;
}

interface CompleteInputPolicy {
  reasons: ReadonlySet<CompleteInputReason>;
  effectiveOptions: ExecuteOptions;
  truncateWasDisabled: boolean;
}

function buildCompleteInputPolicy(
  stmt: SelectStatement | UnionStatement,
  options: ExecuteOptions,
  orderPlan: CanonicalOrderPlan | null
): CompleteInputPolicy {
  // A REST/KORDER plan consumes only the top-level order. Nested/window/B65
  // requirements remain visible through the existing recursive reason walker.
  const reasons = stmt.type === "SELECT" && (orderPlan?.kind === "CANONICAL_REST_TOP_N"
    || orderPlan?.kind === "KORDER_NATIVE"
    || orderPlan?.kind === "KORDER_CURSOR")
    ? completeInputReasons({ ...stmt, orderBy: [] })
    : completeInputReasons(stmt);
  const truncateWasDisabled = reasons.size > 0 && options.onLimitReached === "truncate";
  return {
    reasons,
    effectiveOptions: truncateWasDisabled
      ? { ...options, onLimitReached: "error" as const }
      : options,
    truncateWasDisabled,
  };
}

function throwCompleteInputError(policy: CompleteInputPolicy, error: unknown): never {
  if (policy.reasons.size > 0
    && error instanceof FetchAllLimitError
    && !error.completeInputWrapped) {
    throw new FetchAllLimitError(
      completeInputErrorPrefix(policy.reasons) +
      (policy.truncateWasDisabled ? "onLimit=truncateは使用できません。" : "") +
      error.message,
      true
    );
  }
  throw error;
}

async function withCompleteInputPolicy<T>(
  policy: CompleteInputPolicy,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throwCompleteInputError(policy, error);
  }
}

function isConstantFalseWhere(where: WhereExpr | null): boolean {
  return where?.type === "BOOLEAN" && where.value === false;
}

function isNoFromSelect(stmt: SelectStatement): boolean {
  return stmt.from.appId === 0 && stmt.from.cteName === NO_FROM_CTE_NAME;
}

function arithHasFieldRef(node: ArithNode): boolean {
  if (node.type === "VARIABLE") {
    throw new Error(
      `InternalError: unresolved arithmetic variable @${node.name} reached SELECT planning.`
    );
  }
  if (node.type === "FIELD_REF") return true;
  if (node.type === "ARITH") return arithHasFieldRef(node.left) || arithHasFieldRef(node.right);
  if (node.type === "STRING_FUNC") return stringFuncHasFieldRef(node);
  return false;
}

function stringFuncArgHasFieldRef(arg: StringFuncArg): boolean {
  if (arg.type === "AGG_GROUP_KEY") return true;
  if (arg.type === "VARIABLE") return false;
  if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
  return scalarValueHasFieldRef(arg);
}

function scalarValueHasFieldRef(expr: ScalarValueExpr): boolean {
  if (expr.type === "FIELD") return true;
  if (expr.type === "STRING_FUNC") return stringFuncHasFieldRef(expr);
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    return scalarValueHasFieldRef(expr.left) || scalarValueHasFieldRef(expr.right);
  }
  if (expr.type === "CASE_WHEN") {
    const results = [...expr.branches.map((branch) => branch.result), ...(expr.elseResult ? [expr.elseResult] : [])];
    return results.some((result) => result.type !== "ARRAY" && (
      result.type === "FIELD_REF" || result.type === "ARITH"
        ? arithHasFieldRef(result)
        : result.type === "AGG_REF" || result.type === "AGG_ARITH"
          ? true
        : scalarValueHasFieldRef(result)
    ));
  }
  return false;
}

function stringFuncHasFieldRef(expr: StringFuncExpr): boolean {
  return expr.args.some((arg) => stringFuncArgHasFieldRef(arg));
}

function validateNoFromColumns(stmt: SelectStatement): void {
  for (const col of stmt.columns) {
    switch (col.type) {
      case "VARIABLE_COL":
        throw new Error(`internal error: unresolved SELECT variable @${col.name}`);
      case "LITERAL_COL":
        break;
      case "ARITH_COL":
        if (arithHasFieldRef(col.expr)) {
          throw new Error("ArgumentError: field reference is not allowed without FROM.");
        }
        break;
      case "STRFUNC_COL":
        if (stringFuncHasFieldRef(col.expr)) {
          throw new Error("ArgumentError: field reference is not allowed without FROM.");
        }
        break;
      case "SCALAR_VALUE_COL":
        if (scalarValueHasFieldRef(col.expr)) {
          throw new Error("ArgumentError: field reference is not allowed without FROM.");
        }
        break;
      case "WINDOW_COL":
        if (col.partitionBy.length > 0 || col.orderBy.length > 0) {
          throw new Error("ArgumentError: field reference is not allowed without FROM.");
        }
        break;
      default:
        throw new Error(`ArgumentError: ${col.type} is not supported without FROM.`);
    }
  }
}

function executeNoFromSelect(stmt: SelectStatement, options: ExecuteOptions): SelectResult {
  if (stmt.joins.length > 0 || stmt.where || normalizeGroupingSpec(stmt).type !== "NONE"
    || stmt.having || stmt.orderBy.length > 0 || stmt.distinct) {
    throw new Error("ArgumentError: JOIN/WHERE/GROUP BY/HAVING/ORDER BY/DISTINCT are not supported without FROM.");
  }
  validateNoFromColumns(stmt);
  const windowed = applyWindow(
    [{}], stmt.columns, undefined, undefined, undefined, undefined, statementEvaluationContext(options)
  );
  const { rows: projected, columns } = project(
    windowed, stmt.columns, undefined, undefined, undefined, undefined, undefined,
    statementEvaluationContext(options)
  );
  const rows = applyLimit(projected, stmt.limit, stmt.offset);
  return { type: "SELECT", rows, columns, rowCount: rows.length, warnings: [] };
}

/** SIMPLE モード: kintone クエリに変換して GET → project */
async function executeSimpleSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  orderPlan: CanonicalOrderPlan | null,
  orderMeta: OrderByMeta
): Promise<SelectResult> {
  const restStmt = orderPlan?.kind === "CANONICAL_REST_TOP_N"
    ? withCanonicalRestTie(stmt)
    : stmt;
  const params = selectToKintoneParams(restStmt);
  const fetchFields = orderPlan?.kind === "CANONICAL_LOCAL"
    ? selectToFetchAllFields(stmt, stmt.from)
    : params.fields;
  // SELECT CASE は SIMPLE モードでも JS 側で射影されるため、CASE 条件内の
  // IN / NOT IN に限って型 resolver を用意する（フィールド定義キャッシュを再利用）。
  const typedInFieldTypes = await loadTypedInFieldTypes(stmt, client, cacheContext);
  const fieldTypeResolvers = buildSelectFieldTypeResolvers(stmt, typedInFieldTypes);
  const projectionSemanticsResolver = stmt.columns.some((column) => column.type === "CASE_COL")
    ? await buildWhereFieldSemanticsResolver(
        stmt, client, cacheContext, undefined, selectCaseConditionsNeedFieldMetadata(stmt)
      )
    : undefined;
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const onLimit = options.onLimitReached ?? "error";
  const parallel = options.fetchParallel ?? 1;
  const useRestWindow = stmt.orderBy.length > 0
    ? orderPlan?.kind === "CANONICAL_REST_TOP_N" || orderPlan?.kind === "KORDER_NATIVE" || orderPlan?.kind === "KORDER_CURSOR"
    : stmt.limit !== null && stmt.limit <= 500;
  const needed = stmt.limit === null ? null : (stmt.offset ?? 0) + stmt.limit;
  const stopAfter =
    stmt.orderBy.length === 0 &&
    needed !== null &&
    needed <= maxRecords &&
    !whereHasKlike(stmt.where)
      ? needed
      : undefined;

  // ORDER BY ありは schema-aware plan だけが REST 窓を許可する。
  // ORDER BY なしは順序契約がないため、従来どおり小さい LIMIT を単発取得できる。
  let records: KintoneRecord[];
  if ((orderPlan?.kind === "KORDER_NATIVE" || orderPlan?.kind === "KORDER_CURSOR") && stmt.limit === 0) {
    records = [];
  } else if (orderPlan?.kind === "KORDER_CURSOR") {
    const cursorResult = await executeKorderCursor({
      client,
      app: params.app,
      fields: params.fields,
      query: buildKorderCursorQuery(stmt),
      offset: stmt.offset ?? 0,
      limit: stmt.limit!,
    });
    records = cursorResult.records;
    if (cursorResult.cleanupWarning) warnings.add(cursorResult.cleanupWarning);
  } else if (useRestWindow) {
    const res: KintoneGetResponse = await client.getRecords({
      app: params.app,
      query: params.query,
      fields: params.fields,
    });
    records = res.records;
  } else {
    const baseQuery = stmt.where ? whereToKintone(stmt.where) : "";
    records = await fetchAll(
      client.getRecords,
      params.app,
      baseQuery,
      fetchFields,
      {
        parallel,
        maxRecords,
        stopAfter,
        onLimit,
        onTruncate: (max) => {
          warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
          markLimitReached(client, stmt.from.appId);
        },
      }
    );
  }

  let rows = records.map((r) => flatten(r, null));
  if (!useRestWindow) {
    rows = applyOrderBy(
      rows,
      stmt.orderBy,
      orderMeta.optionOrders,
      orderMeta.sortKinds,
      orderMeta.semantics,
      buildOrderByAliasEvaluator(
        stmt.columns,
        undefined,
        fieldTypeResolvers.row,
        projectionSemanticsResolver,
        statementEvaluationContext(options)
      ),
      statementEvaluationContext(options)
    );
    rows = applyLimit(rows, stmt.limit, stmt.offset);
  }
  const { rows: projected, columns: projectedColumns } = project(
    rows,
    stmt.columns,
    undefined,
    fieldTypeResolvers.row,
    undefined,
    projectionSemanticsResolver,
    undefined,
    statementEvaluationContext(options)
  );
  const columns = await restoreEmptyWildcardColumns(
    stmt,
    projected,
    projectedColumns,
    client,
    cacheContext
  );

  return { type: "SELECT", rows: projected, columns, rowCount: projected.length, warnings: [...warnings] };
}

async function validateSelectFieldCodes(
  stmt: SelectStatement,
  mode: SelectMode,
  client: KintoneClient,
  cacheContext: string
): Promise<string[]> {
  const warnings: string[] = [];
  const appToFields = new Map<number, Set<string>>();
  const addFields = (appId: number, fields: string[]) => {
    if (fields.length === 0) return;
    let target = appToFields.get(appId);
    if (!target) {
      target = new Set<string>();
      appToFields.set(appId, target);
    }
    for (const f of fields) target.add(f);
  };

  // B145: サブテーブルではない表が参照している列だけを、あとで「明細項目では
  // ないか」を見るために取っておく（サブテーブル仮想テーブルは明細項目を参照して
  // 当然なので対象外）。
  const parentTableFields = new Map<number, Set<string>>();
  const addParentFields = (appId: number, fields: string[]) => {
    let target = parentTableFields.get(appId);
    if (!target) {
      target = new Set<string>();
      parentTableFields.set(appId, target);
    }
    for (const f of fields) target.add(f);
  };

  if (mode === "SIMPLE") {
    const params = selectToKintoneParams(stmt);
    addFields(params.app, params.fields);
    if (!stmt.from.subtableCode) addParentFields(params.app, params.fields);
  } else {
    const tables = [stmt.from, ...stmt.joins.map((j) => j.table)].filter((t) => t.cteName === null);
    for (const table of tables) {
      // B71 の plan で解決済みの GROUP BY field を含む、取得対象列を検証する。
      const fields = selectToFetchAllFields(stmt, table);
      addFields(table.appId, fields);
      if (!table.subtableCode) addParentFields(table.appId, fields);
    }
  }

  for (const [appId, fields] of appToFields.entries()) {
    // システムフィールド（$id / _pid 等）は検証対象外のため、
    // ユーザーフィールドが 1 つもなければフィールド定義の取得自体を省く
    const userFields = [...fields].filter((f) => !isSystemLikeFieldCode(f));
    if (userFields.length === 0) continue;
    const defs = await getFieldsCached(appId, client, cacheContext);
    // フィールド定義が取得できない環境（モック等）では検証をスキップする。
    if (defs.length === 0) continue;
    const validCodes = new Set(defs.map((d) => d.code));
    const unknown = userFields.filter((f) => !validCodes.has(f));
    if (unknown.length > 0) {
      throw new Error(`ArgumentError: unknown field code(s): ${unknown.join(", ")} (APP${appId})`);
    }

    // B145: 親アプリから明細項目を参照しても、エラーにならず全行が空になる。
    // DESCRIBE は明細項目も返すため、読んで書いた SQL がそのまま静かに空を返す。
    // 値は変えず（既存の SQL を壊さない）、どの表から選ぶべきかを警告で示す。
    const referenced = parentTableFields.get(appId);
    if (referenced) {
      const subtableFields = defs.filter(
        (d) => d.inSubtable === true && referenced.has(d.code)
      );
      for (const field of subtableFields) {
        const owner = field.subtableCode ?? "";
        const source = owner ? `サブテーブル「${owner}」` : "サブテーブル";
        warnings.push(
          `${field.code} は${source}の中の項目です。`
          // 症状は書いた場所で変わる（射影は空列、集計は空、HAVING は 0 行）。
          // 「全行が空」とだけ書くと HAVING で 0 行を見た人が自分の話だと思わない。
          // 原因（値が取れない）を書き、代表的な現れ方を並べる。
          + `APP${appId} からは値が取れず、エラーにならないまま常に空になります`
          + "（列は空、集計は空、`HAVING` などの条件は空との比較になります）。"
          // FROM を差し替えるだけでは足りない。$id は仮想テーブルに無く、
          // そのまま書くと今度は $id が空になる（同じ静かな失敗を繰り返す）。
          + (owner
            ? `APP${appId}$${owner} から選んでください`
            + `（親のレコード ID は _pid、親項目は _p.<フィールドコード> になります）。`
            : "")
        );
      }
    }
  }
  return warnings;
}

interface B86SourceSchema {
  readonly table: TableRef;
  readonly label: string;
  readonly validCodes: ReadonlySet<string>;
  readonly authoritative: boolean;
  readonly schemaUnavailable: boolean;
}

function b86SourceLabel(table: TableRef): string {
  return table.cteName ?? `APP${table.appId}`;
}

function b86SourceAliases(table: TableRef): string[] {
  if (table.alias) return [table.alias];
  if (table.cteName !== null) return [table.cteName];
  return [`APP${table.appId}`, `app${table.appId}`];
}

function b86PhysicalFieldExists(schema: B86SourceSchema, field: string): boolean {
  return isSystemLikeFieldCode(field) || schema.validCodes.has(field);
}

function b86FieldExists(schema: B86SourceSchema, field: string): boolean {
  if (schema.table.cteName !== null) return schema.validCodes.has(field);
  return b86PhysicalFieldExists(schema, field);
}

function collectB86Subqueries(stmt: SelectStatement): SelectStatement[] {
  const queries: SelectStatement[] = [];
  const visitWhere = (where: WhereExpr | null): void => {
    if (where === null) return;
    switch (where.type) {
      case "BINARY":
        if (where.right.type === "SUBQUERY_IN_LIST" || where.right.type === "SCALAR_SUBQUERY") {
          queries.push(where.right.query);
        }
        return;
      case "EXISTS":
        queries.push(where.query);
        return;
      case "LOGICAL":
        visitWhere(where.left);
        visitWhere(where.right);
        return;
      case "NOT":
      case "GROUP":
        visitWhere(where.expr);
        return;
      case "NULL_CHECK":
      case "BOOLEAN":
        return;
    }
  };

  visitWhere(stmt.where);
  visitWhere(stmt.having);
  for (const column of stmt.columns) {
    if (column.type === "SCALAR_SUBQUERY_COL") {
      queries.push(column.query);
    } else if (column.type === "CASE_COL") {
      for (const branch of column.expr.branches) visitWhere(branch.condition);
    }
  }
  return queries;
}

async function validateB86SelectFieldCodes(
  stmt: SelectStatement,
  client: KintoneClient,
  cteCache: Map<string, MaterializedTable>,
  cacheContext: string
): Promise<void> {
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const materializedByTable = new Map<TableRef, MaterializedTable>();
  const effectiveAliases = new Set<string>();

  for (const table of tables) {
    const alias = effectiveTableAlias(table);
    if (alias === null) continue;
    if (effectiveAliases.has(alias)) {
      throw new Error(`ArgumentError: effective alias ${alias} is used by multiple tables.`);
    }
    effectiveAliases.add(alias);
  }

  for (const table of tables) {
    if (table.cteName === null || table.cteName === NO_FROM_CTE_NAME) continue;
    const materialized = cteCache.get(table.cteName);
    if (!materialized) {
      throw new Error(`ArgumentError: materialized source ${table.cteName} is not available.`);
    }
    if (materialized.rows.length > 0 && materialized.columns.length === 0) {
      throw new Error(
        `InternalError: materialized source ${table.cteName} has rows but no column schema.`
      );
    }
    if (stmt.joins.length > 0 && materialized.rows.length === 0 && materialized.columns.length === 0) {
      throw new Error(
        `ArgumentError: column schema is unavailable for materialized JOIN source ${table.cteName}.`
      );
    }
    materializedByTable.set(table, materialized);
  }

  const schemas = new Map<TableRef, B86SourceSchema>();
  await Promise.all(tables.map(async (table) => {
    const materialized = materializedByTable.get(table);
    if (materialized) {
      schemas.set(table, {
        table,
        label: b86SourceLabel(table),
        validCodes: new Set(materialized.columns),
        authoritative: true,
        schemaUnavailable: materialized.rows.length === 0 && materialized.columns.length === 0,
      });
      return;
    }
    if (table.cteName === NO_FROM_CTE_NAME) return;
    const defs = await getFieldsCached(table.appId, client, cacheContext);
    schemas.set(table, {
      table,
      label: b86SourceLabel(table),
      validCodes: new Set(defs.map((def) => def.code)),
      authoritative: defs.length > 0,
      schemaUnavailable: false,
    });
  }));

  const sourceByAlias = new Map<string, B86SourceSchema>();
  for (const schema of schemas.values()) {
    for (const alias of b86SourceAliases(schema.table)) sourceByAlias.set(alias, schema);
  }

  // B51 の既存 JOIN-key error 契約を、records GET より前へ移して維持する。
  for (const join of stmt.joins) {
    if (join.type === "CROSS") continue;
    for (const ref of [join.on.left, join.on.right]) {
      if (!ref.tableAlias) continue;
      const schema = sourceByAlias.get(ref.tableAlias);
      if (
        schema
        && schema.table.cteName !== null
        && !schema.schemaUnavailable
        && !b86FieldExists(schema, ref.field)
      ) {
        throw new Error(
          `ArgumentError: JOIN key ${ref.tableAlias}.${ref.field} is not available in the materialized table.`
        );
      }
    }
  }

  const references = collectSelectFieldReferencesBySource(stmt);
  for (const [table, fields] of references.bySource) {
    const schema = schemas.get(table);
    if (!schema || schema.schemaUnavailable || !schema.authoritative) continue;
    const unknown = [...fields].filter((field) => !b86FieldExists(schema, field));
    if (unknown.length > 0) {
      throw new Error(
        `ArgumentError: unknown field code(s): ${unknown.join(", ")} (${schema.label})`
      );
    }
  }

  for (const field of references.unqualified) {
    const candidates = [...schemas.values()].filter((schema) => !schema.schemaUnavailable);
    if (candidates.some((schema) => b86FieldExists(schema, field))) continue;
    if ([...schemas.values()].some((schema) => schema.schemaUnavailable)) continue;
    // 物理 defs=[] は従来の mock 互換 escape hatch。実体化 columns には適用しない。
    if (candidates.some((schema) => schema.table.cteName === null && !schema.authoritative)) continue;
    const labels = candidates.map((schema) => schema.label).join(", ");
    throw new Error(`ArgumentError: unknown field code(s): ${field} (${labels})`);
  }
}

async function preflightB86QueryWithCte(
  query: SelectStatement | UnionStatement,
  client: KintoneClient,
  cteCache: Map<string, MaterializedTable>,
  cacheContext: string,
  seen = new Set<object>()
): Promise<void> {
  if (seen.has(query)) return;
  seen.add(query);
  if (query.type === "UNION") {
    await preflightB86QueryWithCte(query.left, client, cteCache, cacheContext, seen);
    await preflightB86QueryWithCte(query.right, client, cteCache, cacheContext, seen);
    return;
  }
  await validateB86SelectFieldCodes(query, client, cteCache, cacheContext);
  for (const subquery of collectB86Subqueries(query)) {
    await preflightB86QueryWithCte(subquery, client, cteCache, cacheContext, seen);
  }
}

function extractMainTypedPushdownCandidate(stmt: SelectStatement): WhereExpr | null {
  if (stmt.where === null || stmt.from.subtableCode || stmt.from.cteName !== null) return null;

  if (stmt.joins.length === 0) {
    return extractTypedPushdownCandidates(stmt.where, {
      tableAlias: stmt.from.alias ?? undefined,
      allowUnqualifiedFields: true,
    });
  }

  if (!stmt.from.alias) return null;
  return extractTypedPushdownCandidates(stmt.where, { tableAlias: stmt.from.alias });
}

function hasPushdownPlaceholder(where: WhereExpr): boolean {
  if (where.type === "BINARY") {
    if (where.right.type === "STRING") return where.right.value.startsWith("@");
    if (where.right.type === "IN_LIST") {
      return where.right.values.some((value) =>
        value.type === "STRING" && value.value.startsWith("@"));
    }
    return false;
  }
  if (where.type === "LOGICAL") {
    return hasPushdownPlaceholder(where.left) || hasPushdownPlaceholder(where.right);
  }
  if (where.type === "GROUP" || where.type === "NOT") return hasPushdownPlaceholder(where.expr);
  return false;
}

type FieldOptionsMap = Map<string, ReadonlySet<string>>;

interface TypedPushdownMeta {
  fieldTypesByApp: Map<number, FieldTypeMap>;
  fieldOptionsByApp: Map<number, FieldOptionsMap>;
}

interface RuntimeJoinPushdownPlan extends KlikePushdownPlan {
  readonly joinPlan: JoinPushdownPlan;
  readonly queriesByAlias: ReadonlyMap<string, string>;
}

const boundJoinRuntimePlans = new WeakMap<SelectStatement, RuntimeJoinPushdownPlan>();

function buildRuntimeJoinPushdownPlan(
  stmt: SelectStatement,
  metadata: TypedPushdownMeta
): RuntimeJoinPushdownPlan | null {
  if (stmt.joins.length === 0
    || stmt.where === null
    || stmt.joins.some((join) => join.type !== "INNER" && join.type !== "CROSS")) {
    return null;
  }

  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  if (tables.some((table) =>
    table.alias === null || table.cteName !== null || Boolean(table.subtableCode)
  )) {
    return null;
  }

  const sources: JoinPushdownSource[] = tables.map((table) => ({
    alias: table.alias!,
    appId: table.appId,
    sourceKind: "APP",
    fieldTypes: new Map([
      ...(metadata.fieldTypesByApp.get(table.appId) ?? new Map()),
      ["$id", "__ID__"],
    ]),
    fieldOptions: metadata.fieldOptionsByApp.get(table.appId),
  }));
  const staticPlan = buildJoinPushdownPlan(stmt.where, sources);
  const plan = bindJoinServerFunctionFetches(staticPlan, sources);
  const conditionsByAlias = new Map<string, WhereExpr>();
  const queriesByAlias = new Map<string, string>();
  for (const [alias, query] of plan.fetchQueriesByAlias) {
    queriesByAlias.set(alias, query);
  }
  for (const item of plan.items) {
    // §6.2: alias を捨てる serializer の直前に ownership を fail-loud 再検査する。
    if (!queriesByAlias.has(item.targetAlias)) {
      queriesByAlias.set(item.targetAlias, serializeJoinPushdownItem(item, sources));
    }
    conditionsByAlias.set(item.targetAlias, item.predicate);
  }
  const mainAlias = stmt.from.alias!;
  const mainCondition = conditionsByAlias.get(mainAlias) ?? null;
  const joinConditions = new Map(conditionsByAlias);
  joinConditions.delete(mainAlias);
  const relationByAlias = new Map(plan.items.map((item) => [item.targetAlias, item.relation] as const));
  const mainRelation = relationByAlias.get(mainAlias) ?? null;
  relationByAlias.delete(mainAlias);
  return {
    joinPlan: plan,
    queriesByAlias,
    mainCondition,
    mainRelation,
    joinConditions,
    joinRelations: relationByAlias,
    appliedKlikes: plan.appliedKlikes,
    allKlikes: plan.allKlikes,
  };
}

async function loadTypedPushdownMeta(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<TypedPushdownMeta> {
  const candidatesByApp = new Map<number, WhereExpr[]>();
  const addCandidate = (appId: number, candidate: WhereExpr | null): void => {
    if (candidate === null) return;
    const existing = candidatesByApp.get(appId);
    if (existing) existing.push(candidate);
    else candidatesByApp.set(appId, [candidate]);
  };
  addCandidate(stmt.from.appId, extractMainTypedPushdownCandidate(stmt));

  // B76 Phase A: direct physical INNER JOIN は OR/GROUP を含む一つの plan で
  // ownership・型・選択肢実在を確定するため、各 APP の schema snapshot を揃える。
  const directInnerJoin = stmt.joins.length > 0
    && stmt.where !== null
    && stmt.joins.every((join) => join.type === "INNER" || join.type === "CROSS")
    && [stmt.from, ...stmt.joins.map((join) => join.table)].every((table) =>
      table.alias !== null && table.cteName === null && !table.subtableCode
    );
  if (directInnerJoin) {
    addCandidate(stmt.from.appId, stmt.where);
    for (const join of stmt.joins) addCandidate(join.table.appId, stmt.where);
  }

  if (stmt.where !== null) {
    for (const join of stmt.joins) {
      if (!join.table.alias || join.table.subtableCode || join.table.cteName !== null) continue;
      const candidate = extractTypedPushdownCandidates(stmt.where, {
        tableAlias: join.table.alias,
      });
      addCandidate(join.table.appId, candidate);
    }
  }

  const entries = await Promise.all([...candidatesByApp.entries()].map(async ([appId, candidates]) => {
    const [fieldTypes, fieldOptions] = await Promise.all([
      getFieldTypeMap(appId, client, cacheContext),
      getFieldOptionSetMapByApp(appId, client, cacheContext),
    ]);
    const statusFields = collectCandidateFieldCodes(candidates)
      .filter((fieldCode) => fieldTypes.get(fieldCode) === "STATUS");
    if (statusFields.length > 0) {
      const process = await getProcessStatusesCached(appId, client, cacheContext);
      if (process.enable && process.states && process.states.length > 0) {
        const states = new Set(process.states.map((state) => state.name));
        for (const fieldCode of statusFields) fieldOptions.set(fieldCode, states);
      }
    }
    return [appId, fieldTypes, fieldOptions] as const;
  }));
  return {
    fieldTypesByApp: new Map(entries.map(([appId, fieldTypes]) => [appId, fieldTypes])),
    fieldOptionsByApp: new Map(entries.map(([appId, , fieldOptions]) => [appId, fieldOptions])),
  };
}

function collectCandidateFieldCodes(candidates: readonly WhereExpr[]): string[] {
  const fields = new Set<string>();
  const visit = (expr: WhereExpr): void => {
    if (expr.type === "BINARY") {
      if (expr.left.type === "FIELD") fields.add(expr.left.field);
      return;
    }
    if (expr.type === "LOGICAL") {
      visit(expr.left);
      visit(expr.right);
      return;
    }
    if (expr.type === "GROUP" || expr.type === "NOT") visit(expr.expr);
  };
  for (const candidate of candidates) visit(candidate);
  return [...fields];
}

/** IN / NOT IN の左辺にある直接フィールド参照を、CASE 条件を含めて収集する。 */
function collectTypedInFieldRefs(
  expr: WhereExpr | null,
  out: FieldRef[]
): void {
  if (expr === null) return;
  switch (expr.type) {
    case "BINARY":
      if ((expr.op === "IN" || expr.op === "NOT_IN") && expr.left.type === "FIELD") {
        out.push(expr.left);
      }
      if (expr.left.type === "CASE_FIELD") collectCaseTypedInFieldRefs(expr.left.expr, out);
      if (expr.right.type === "CASE_VALUE") collectCaseTypedInFieldRefs(expr.right.expr, out);
      return;
    case "LOGICAL":
      collectTypedInFieldRefs(expr.left, out);
      collectTypedInFieldRefs(expr.right, out);
      return;
    case "NOT":
    case "GROUP":
      collectTypedInFieldRefs(expr.expr, out);
      return;
    case "NULL_CHECK":
    case "EXISTS":
    case "BOOLEAN":
      return;
  }
}

function collectCaseTypedInFieldRefs(expr: CaseWhenExpr, out: FieldRef[]): void {
  for (const branch of expr.branches) collectTypedInFieldRefs(branch.condition, out);
}

function collectSelectTypedInFieldRefs(stmt: SelectStatement): FieldRef[] {
  const refs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, refs);
  collectTypedInFieldRefs(stmt.having, refs);
  for (const column of stmt.columns) {
    if (column.type === "CASE_COL") collectCaseTypedInFieldRefs(column.expr, refs);
  }
  return refs;
}

function effectiveTableAlias(table: TableRef): string | null {
  return table.alias ?? table.cteName;
}

function findTableForAlias(stmt: SelectStatement, alias: string): TableRef | undefined {
  return [stmt.from, ...stmt.joins.map((join) => join.table)]
    .find((table) => effectiveTableAlias(table) === alias);
}

function physicalSelectTables(stmt: SelectStatement): TableRef[] {
  return [stmt.from, ...stmt.joins.map((join) => join.table)]
    .filter((table) => table.cteName === null);
}

/** 型付き IN 候補を持ち得る物理アプリだけ、既存キャッシュ経由で型を読む。 */
async function loadTypedInFieldTypes(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<Map<number, FieldTypeMap>> {
  const refs = collectSelectTypedInFieldRefs(stmt);
  if (refs.length === 0) return new Map();

  const appIds = new Set<number>();
  const physicalTables = physicalSelectTables(stmt);
  for (const ref of refs) {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        appIds.add(stmt.from.appId);
        continue;
      }
      const table = findTableForAlias(stmt, ref.tableAlias);
      if (table && table.cteName === null) appIds.add(table.appId);
      continue;
    }
    if (stmt.joins.length === 0) {
      if (stmt.from.cteName === null) appIds.add(stmt.from.appId);
      continue;
    }
    // JOIN の非修飾参照は衝突判定に全物理テーブルの定義が必要。
    for (const table of physicalTables) appIds.add(table.appId);
  }

  const entries = await Promise.all([...appIds].map(async (appId) => (
    [appId, await getFieldTypeMap(appId, client, cacheContext)] as const
  )));
  return new Map(entries);
}

function aggregateFieldRef(field: string): FieldRef {
  const dot = field.indexOf(".");
  return dot > 0
    ? { type: "FIELD", tableAlias: field.slice(0, dot), field: field.slice(dot + 1) }
    : { type: "FIELD", tableAlias: null, field };
}

function collectAggregateRef(
  func: string,
  arg: AggregateArgExpr | { type: "WILDCARD" },
  out: FieldRef[]
): void {
  if (func !== "MIN" && func !== "MAX" && func !== "MODE" || arg.type === "WILDCARD") return;
  collectAggregateArgFieldRefs(arg, out);
}

function collectAggregateArgFieldRefs(arg: AggregateArgExpr, out: FieldRef[]): void {
  if (arg.type === "FIELD_REF") { out.push(aggregateFieldRef(arg.field)); return; }
  if (arg.type === "FIELD") { out.push(arg); return; }
  if (arg.type === "ARITH") {
    collectAggregateArgFieldRefs(arg.left, out);
    collectAggregateArgFieldRefs(arg.right, out);
    return;
  }
  if (arg.type === "SCALAR_ARITH" || arg.type === "CONCAT_OP") {
    collectAggregateArgFieldRefs(arg.left, out);
    collectAggregateArgFieldRefs(arg.right, out);
    return;
  }
  if (arg.type === "STRING_FUNC") {
    for (const child of arg.args) {
      if (child.type === "AGG_GROUP_KEY") {
        out.push({ type: "FIELD", tableAlias: child.tableAlias ?? null, field: child.field });
      } else if (child.type !== "AGG_REF" && child.type !== "AGG_ARITH" && child.type !== "VARIABLE") {
        collectAggregateArgFieldRefs(child, out);
      }
    }
    return;
  }
  if (arg.type === "CASE_WHEN") {
    for (const result of [...arg.branches.map((branch) => branch.result), ...(arg.elseResult ? [arg.elseResult] : [])]) {
      if (result.type === "AGG_REF" || result.type === "AGG_ARITH") collectAggregateOperandRefs(result, out);
      else if (result.type !== "ARRAY") collectAggregateArgFieldRefs(result, out);
    }
  }
}

function collectAggregateOperandRefs(node: AggOperand, out: FieldRef[]): void {
  if (node.type === "AGG_REF") {
    collectAggregateRef(node.func, node.arg, out);
    return;
  }
  if (node.type === "AGG_ARITH") {
    collectAggregateOperandRefs(node.left, out);
    collectAggregateOperandRefs(node.right, out);
  }
  if (node.type === "AGG_GROUP_KEY") out.push({ type: "FIELD", tableAlias: node.tableAlias ?? null, field: node.field });
}

function collectStringFuncAggregateRefs(expr: StringFuncExpr, out: FieldRef[]): void {
  for (const arg of expr.args) {
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") {
      collectAggregateOperandRefs(arg, out);
    } else if (arg.type === "AGG_GROUP_KEY") {
      out.push({ type: "FIELD", tableAlias: arg.tableAlias ?? null, field: arg.field });
    } else if (arg.type === "VARIABLE") {
      continue;
    } else {
      collectScalarAggregateRefs(arg, out);
    }
  }
}

function collectScalarAggregateRefs(expr: ScalarValueExpr, out: FieldRef[]): void {
  if (expr.type === "STRING_FUNC") { collectStringFuncAggregateRefs(expr, out); return; }
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    collectScalarAggregateRefs(expr.left, out);
    collectScalarAggregateRefs(expr.right, out);
    return;
  }
  if (expr.type === "CASE_WHEN") {
    const results = [...expr.branches.map((branch) => branch.result), ...(expr.elseResult ? [expr.elseResult] : [])];
    for (const result of results) {
      if (result.type === "STRING_FUNC") collectStringFuncAggregateRefs(result, out);
      else if (result.type === "AGG_REF" || result.type === "AGG_ARITH") collectAggregateOperandRefs(result, out);
      else if (result.type !== "ARRAY" && result.type !== "FIELD_REF" && result.type !== "ARITH") collectScalarAggregateRefs(result, out);
    }
  }
}

function collectCaseAggregateRefs(expr: CaseWhenExpr, out: FieldRef[]): void {
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const value = node as Record<string, unknown>;
    if (value["type"] === "AGG_REF") {
      const aggregate = value as unknown as Extract<AggOperand, { type: "AGG_REF" }>;
      collectAggregateRef(aggregate.func, aggregate.arg, out);
      return;
    }
    if (value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY") return;
    Object.values(value).forEach(visit);
  };
  visit(expr);
}

function collectSelectAggregateSortRefs(columns: SelectColumn[]): FieldRef[] {
  const refs: FieldRef[] = [];
  for (const column of columns) {
    if (column.type === "AGGREGATE") {
      collectAggregateRef(column.func, column.arg, refs);
    } else if (column.type === "ARITH_AGG_COL") {
      collectAggregateOperandRefs(column.expr, refs);
    } else if (column.type === "STRFUNC_COL") {
      collectStringFuncAggregateRefs(column.expr, refs);
    } else if (column.type === "SCALAR_VALUE_COL") {
      collectScalarAggregateRefs(column.expr, refs);
    } else if (column.type === "CASE_COL") {
      collectCaseAggregateRefs(column.expr, refs);
    }
  }
  return refs;
}

const AGGREGATE_STRING_FIELD_TYPES = new Set([
  "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "RICH_TEXT", "LINK",
  "DROP_DOWN", "RADIO_BUTTON", "STATUS",
  "DATE", "TIME", "DATETIME", "CREATED_TIME", "UPDATED_TIME",
]);

function aggregateSortKind(info: KintoneFieldInfo): "number" | "string" | undefined {
  if (info.sortKind !== undefined) return info.sortKind;
  if (info.fieldType === "NUMBER" || info.fieldType === "RECORD_NUMBER") return "number";
  return AGGREGATE_STRING_FIELD_TYPES.has(info.fieldType) ? "string" : undefined;
}

/** MIN/MAX/MODE の直接フィールド参照だけに必要なフォーム定義を読み、集約専用resolverを返す。 */
async function loadAggregateSortKindResolver(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<AggregateSortKindResolver | undefined> {
  const refs = collectSelectAggregateSortRefs(stmt.columns);
  if (refs.length === 0) return undefined;

  const appIds = new Set<number>();
  const physicalTables = physicalSelectTables(stmt);
  for (const ref of refs) {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        appIds.add(stmt.from.appId);
        continue;
      }
      const table = findTableForAlias(stmt, ref.tableAlias);
      if (table && table.cteName === null) appIds.add(table.appId);
    } else if (stmt.joins.length === 0) {
      if (stmt.from.cteName === null) appIds.add(stmt.from.appId);
    } else {
      for (const table of physicalTables) appIds.add(table.appId);
    }
  }

  const fieldInfosByApp = new Map<number, Map<string, KintoneFieldInfo>>(
    await Promise.all([...appIds].map(async (appId) => {
      const infos = await getFieldsCached(appId, client, cacheContext);
      return [appId, new Map(infos.map((info) => [info.code, info]))] as const;
    }))
  );
  const statusOrdersByApp = new Map<number, ReadonlyMap<string, number>>();
  const aggregateFieldNames = new Set(refs.map((ref) => ref.field));
  await Promise.all([...fieldInfosByApp].map(async ([appId, infos]) => {
    if (![...aggregateFieldNames].some((field) => infos.get(field)?.fieldType === "STATUS")) return;
    const order = await loadProcessStatusOrder(appId, client, cacheContext);
    if (order) statusOrdersByApp.set(appId, order);
  }));
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];

  const semanticsForInfo = (info: KintoneFieldInfo, appId: number): ResolvedFieldSemantics => {
    const base = info.semantics ?? resolveFieldSemantics(info);
    return info.fieldType === "STATUS" && statusOrdersByApp.has(appId)
      ? { ...base, optionOrder: statusOrdersByApp.get(appId) }
      : base;
  };

  const resolveRef = (ref: FieldRef): ResolvedFieldSemantics | undefined => {
    let info: KintoneFieldInfo | undefined;
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        info = fieldInfosByApp.get(stmt.from.appId)?.get(ref.field);
      } else {
        const table = tables.find((candidate) => effectiveTableAlias(candidate) === ref.tableAlias);
        if (!table) return undefined;
        if (table.cteName !== null) {
          return materializedTables?.get(table.cteName)?.columnMeta?.get(ref.field)?.semantics
            ?? syntheticSemantics("string");
        }
        info = fieldInfosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      }
    } else if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) {
        return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(ref.field)?.semantics
          ?? syntheticSemantics("string");
      }
      info = fieldInfosByApp.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, ref.field));
    } else {
      const matches = tables.flatMap((table): Array<ResolvedFieldSemantics | undefined> => {
        if (table.cteName !== null) {
          const materialized = materializedTables?.get(table.cteName);
          return materialized?.columns.includes(ref.field)
            ? [materialized.columnMeta?.get(ref.field)?.semantics ?? syntheticSemantics("string")]
            : [];
        }
        const candidate = fieldInfosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
        return candidate ? [semanticsForInfo(candidate, table.appId)] : [];
      });
      if (matches.length !== 1) return undefined;
      return matches[0];
    }
    if (!info) return undefined;
    const sourceTable = ref.tableAlias !== null
      ? tables.find((table) => effectiveTableAlias(table) === ref.tableAlias)
      : stmt.joins.length === 0 ? stmt.from : undefined;
    return semanticsForInfo(info, sourceTable?.appId ?? stmt.from.appId);
  };

  return resolveRef;
}

function fieldCodeForTypeLookup(table: TableRef, field: string): string {
  if (table.subtableCode && field.startsWith("_p.")) return field.slice(3);
  return field;
}

function subtableSystemFieldType(table: TableRef, field: string): string | undefined {
  if (!table.subtableCode) return undefined;
  if (field === "_rid") return "SINGLE_LINE_TEXT";
  if (field === "_idx" || field === "_pid") return "NUMBER";
  return undefined;
}

function materializedMetaFromFieldInfo(
  info: KintoneFieldInfo,
  sourceAppId?: number
): MaterializedColumnMeta {
  const semantics = info.semantics ?? resolveFieldSemantics(info);
  return {
    sortKind: aggregateSortKind(info),
    fieldType: info.fieldType,
    semantics: sourceAppId === undefined
      ? semantics
      : withFieldSemanticSource(semantics, sourceAppId, info.code),
  };
}

/** REST top-N の同値群を FULL_SCAN の stable input ($id asc) と同じ順へ固定する。 */
function withCanonicalRestTie(stmt: SelectStatement): SelectStatement {
  const hasId = stmt.orderBy.some((item) =>
    item.key.type === "FIELD_NAME" && item.key.name === "$id"
  );
  return hasId
    ? stmt
    : {
        ...stmt,
        orderBy: [...stmt.orderBy, { key: { type: "FIELD_NAME", name: "$id" }, direction: "ASC" }],
      };
}

function syntheticColumnMeta(compareMode: "string" | "number"): MaterializedColumnMeta {
  return { sortKind: compareMode, semantics: syntheticSemantics(compareMode) };
}

/** 型が安全に合流しない式は v3 の既定で文字列とするが、Phase 2 では既存 sortKind を変えない。 */
function unknownStringColumnMeta(): MaterializedColumnMeta {
  return { semantics: syntheticSemantics("string", "KSQL_UNKNOWN") };
}

function unsupportedColumnMeta(fieldType = "KSQL_ARRAY"): MaterializedColumnMeta {
  return {
    semantics: { fieldType, compareMode: "unsupported", inSubtable: false, requiresCollectionOperators: false },
  };
}

function systemColumnMeta(field: string): MaterializedColumnMeta | undefined {
  if (field === "$id") {
    return {
      sortKind: "number",
      fieldType: "__ID__",
      semantics: resolveFieldSemantics({ fieldType: "__ID__" }),
    };
  }
  if (field === "_rid") return syntheticColumnMeta("string");
  if (field === "_pid" || field === "_idx") return syntheticColumnMeta("number");
  if (field === "$revision") return syntheticColumnMeta("number");
  return undefined;
}

const NUMBER_RETURNING_STRING_FUNCTIONS = new Set([
  "LENGTH", "LENGTH_CHAR", "INSTR", "ROUND", "FLOOR", "CEIL", "TRUNCATE",
  "YEAR", "MONTH", "DAY", "DATEDIFF", "ABS", "MOD", "POWER", "SQRT",
  "DAYOFWEEK", "QUARTER", "WEEK",
]);

function stringFunctionColumnMeta(expr: StringFuncExpr): MaterializedColumnMeta {
  if (expr.func === "CAST") {
    const target = expr.args[1];
    return target?.type === "STRING" && target.value === "NUMBER"
      ? syntheticColumnMeta("number")
      : syntheticColumnMeta("string");
  }
  return NUMBER_RETURNING_STRING_FUNCTIONS.has(expr.func)
    ? syntheticColumnMeta("number")
    : syntheticColumnMeta("string");
}

function caseResultColumnMeta(
  result: CaseResult,
  resolveField: (ref: FieldRef) => MaterializedColumnMeta | undefined
): MaterializedColumnMeta {
  if (result.type === "STRING") return syntheticColumnMeta("string");
  if (result.type === "ARRAY") return unsupportedColumnMeta();
  if (result.type === "AGG_REF") {
    if (result.func === "MIN" || result.func === "MAX" || result.func === "MODE") {
      return result.arg.type === "WILDCARD"
        ? unknownStringColumnMeta()
        : inferAggregateArgMeta(result.arg, resolveField);
    }
    return result.func === "GROUP_CONCAT" ? syntheticColumnMeta("string") : syntheticColumnMeta("number");
  }
  if (result.type === "AGG_ARITH") return syntheticColumnMeta("number");
  if (result.type === "NUMBER" || result.type === "ARITH" || result.type === "SCALAR_ARITH") return syntheticColumnMeta("number");
  if (result.type === "STRING_FUNC") return stringFunctionColumnMeta(result);
  if (result.type === "FIELD_REF") return resolveField(aggregateFieldRef(result.field)) ?? unknownStringColumnMeta();
  if (result.type === "FIELD") return resolveField(result) ?? unknownStringColumnMeta();
  return unknownStringColumnMeta();
}

function mergeExpressionColumnMeta(
  candidates: readonly MaterializedColumnMeta[]
): MaterializedColumnMeta {
  if (candidates.length === 0) return unknownStringColumnMeta();
  const first = candidates[0];
  const withoutSource = (semantics: ResolvedFieldSemantics | undefined): ResolvedFieldSemantics | undefined => {
    if (!semantics) return undefined;
    const { source: _source, ...rest } = semantics;
    return rest;
  };
  if (candidates.every((candidate) =>
    candidate.sortKind === first.sortKind
    && candidate.fieldType === first.fieldType
    && fieldSemanticsEqual(withoutSource(candidate.semantics), withoutSource(first.semantics))
  )) {
    const sameSource = candidates.every((candidate) =>
      fieldSemanticsEqual(candidate.semantics, first.semantics)
    );
    return sameSource ? first : { ...first, semantics: withoutSource(first.semantics) };
  }
  if (candidates.some((candidate) => candidate.semantics?.compareMode === "unsupported")) {
    return unsupportedColumnMeta("KSQL_MIXED_UNSUPPORTED");
  }
  return unknownStringColumnMeta();
}

function inferAggregateArgMeta(
  arg: AggregateArgExpr,
  resolveField: (ref: FieldRef) => MaterializedColumnMeta | undefined
): MaterializedColumnMeta {
  if (arg.type === "FIELD_REF") return resolveField(aggregateFieldRef(arg.field)) ?? unknownStringColumnMeta();
  if (arg.type === "FIELD") return resolveField(arg) ?? unknownStringColumnMeta();
  if (arg.type === "NUMBER" || arg.type === "ARITH" || arg.type === "SCALAR_ARITH") return syntheticColumnMeta("number");
  if (arg.type === "STRING" || arg.type === "CONCAT_OP" || arg.type === "VARIABLE") return syntheticColumnMeta("string");
  if (arg.type === "STRING_FUNC") return stringFunctionColumnMeta(arg);
  const results = arg.branches.map((branch) => caseResultColumnMeta(branch.result, resolveField));
  if (arg.elseResult) results.push(caseResultColumnMeta(arg.elseResult, resolveField));
  return mergeExpressionColumnMeta(results);
}

function inferWindowColumnMeta(
  column: WindowColumn,
  resolveField: (ref: FieldRef) => MaterializedColumnMeta | undefined
): MaterializedColumnMeta {
  if (column.windowKind === "VALUE") {
    return inferAggregateArgMeta(column.arg, resolveField);
  }
  if (column.windowKind === "AGGREGATE") {
    if (column.aggFunc === "COUNT" || column.aggFunc === "SUM" || column.aggFunc === "AVG") {
      return syntheticColumnMeta("number");
    }
    return column.arg.type === "WILDCARD"
      ? unknownStringColumnMeta()
      : inferAggregateArgMeta(column.arg, resolveField);
  }
  return syntheticColumnMeta("number");
}

function withDisplayName(
  meta: MaterializedColumnMeta | undefined,
  displayName: string
): MaterializedColumnMeta {
  return { ...(meta ?? {}), displayName };
}

function selectNeedsSourceColumnMeta(stmt: SelectStatement): boolean {
  return stmt.columns.some((column) =>
    column.type === "FIELD"
    || column.type === "WILDCARD"
    || column.type === "PARENT_WILDCARD"
    || column.type === "CASE_COL"
    || (column.type === "AGGREGATE"
      && (column.func === "MIN" || column.func === "MAX" || column.func === "MODE"))
    || (column.type === "WINDOW_COL" && (
      column.windowKind === "VALUE"
      || (column.windowKind === "AGGREGATE" && (column.aggFunc === "MIN" || column.aggFunc === "MAX"))
    ))
  );
}

async function inferSelectColumnMeta(
  stmt: SelectStatement,
  outputColumns: readonly string[],
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>,
  forLibraryCapture = false
): Promise<MaterializedColumnMetaMap> {
  const physicalInfos = new Map<number, Map<string, KintoneFieldInfo>>();
  if (selectNeedsSourceColumnMeta(stmt)) {
    await Promise.all(physicalSelectTables(stmt).map(async (table) => {
      if (physicalInfos.has(table.appId)) return;
      const infos = await getFieldsCached(table.appId, client, cacheContext);
      physicalInfos.set(table.appId, new Map(infos.map((info) => [info.code, info])));
    }));
  }

  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const canExposePublicSource = forLibraryCapture
    && materializedTables === undefined
    && tables.every((table) => table.cteName === null);
  const resolveField = (ref: FieldRef): MaterializedColumnMeta | undefined => {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        const info = physicalInfos.get(stmt.from.appId)?.get(ref.field);
        return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : undefined;
      }
      const table = tables.find((candidate) => effectiveTableAlias(candidate) === ref.tableAlias);
      if (!table) return undefined;
      if (table.cteName !== null) return materializedTables?.get(table.cteName)?.columnMeta?.get(ref.field);
      const info = physicalInfos.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      return info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
    }

    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(ref.field);
      const info = physicalInfos.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, ref.field));
      return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : systemColumnMeta(ref.field);
    }

    const matches = tables.flatMap((table): Array<MaterializedColumnMeta | undefined> => {
      if (table.cteName !== null) {
        const materialized = materializedTables?.get(table.cteName);
        if (!materialized?.columns.includes(ref.field)) return [];
        return [materialized.columnMeta?.get(ref.field)];
      }
      const info = physicalInfos.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      const meta = info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
      return meta ? [meta] : [];
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
  const resolvePublicSourceApp = (ref: FieldRef): number | undefined => {
    if (!canExposePublicSource) return undefined;
    const matches = tables.filter((table) => {
      if (ref.tableAlias !== null && effectiveTableAlias(table) !== ref.tableAlias) return false;
      const fieldCode = fieldCodeForTypeLookup(table, ref.field);
      return physicalInfos.get(table.appId)?.has(fieldCode) === true
        || systemColumnMeta(ref.field) !== undefined;
    });
    return matches.length === 1 ? matches[0].appId : undefined;
  };
  const withPublicSource = (
    meta: MaterializedColumnMeta | undefined,
    ref: FieldRef
  ): MaterializedColumnMeta | undefined => {
    const publicSourceApp = resolvePublicSourceApp(ref);
    return meta && publicSourceApp !== undefined ? { ...meta, publicSourceApp } : meta;
  };

  const inferred = new Map<string, MaterializedColumnMeta>();
  const hasWildcard = stmt.columns.some((column) => column.type === "WILDCARD" || column.type === "PARENT_WILDCARD");

  if (stmt.columns.length === 1
    && (stmt.columns[0].type === "WILDCARD" || stmt.columns[0].type === "PARENT_WILDCARD")) {
    for (const output of outputColumns) {
      const ref = aggregateFieldRef(output);
      const meta = withPublicSource(resolveField(ref), ref);
      inferred.set(output, withDisplayName(meta, meta?.displayName ?? output));
    }
    return inferred;
  }

  if (hasWildcard) {
    // ワイルドカード展開済みの実列名だけを解決する。別名・計算列は下の明示列処理で補う。
    for (const output of outputColumns) {
      const ref = aggregateFieldRef(output);
      const meta = withPublicSource(resolveField(ref), ref);
      inferred.set(output, withDisplayName(meta, meta?.displayName ?? output));
    }
  }

  const explicitColumns = stmt.columns.filter(
    (column) => column.type !== "WILDCARD" && column.type !== "PARENT_WILDCARD"
  );
  explicitColumns.forEach((column, index) => {
      const output = hasWildcard
        ? ("alias" in column && column.alias ? column.alias : undefined)
        : outputColumns[index];
      if (!output) return;
      let meta: MaterializedColumnMeta | undefined;
      if (column.type === "FIELD") {
        const ref = aggregateFieldRef(column.field);
        meta = withPublicSource(resolveField(ref), ref);
      } else if (column.type === "AGGREGATE") {
        if (column.func === "GROUP_CONCAT") {
          meta = syntheticColumnMeta("string");
        } else if (column.func === "COUNT" || column.func === "SUM" || column.func === "AVG"
          || column.func === "STDDEV_POP" || column.func === "STDDEV_SAMP"
          || column.func === "VAR_POP" || column.func === "VAR_SAMP" || column.func === "MEDIAN") {
          meta = syntheticColumnMeta("number");
        } else if ((column.func === "MIN" || column.func === "MAX" || column.func === "MODE") && column.arg.type !== "WILDCARD") {
          meta = inferAggregateArgMeta(column.arg, resolveField);
        }
      } else if (column.type === "ARITH_AGG_COL" || column.type === "ARITH_COL") {
        meta = syntheticColumnMeta("number");
      } else if (column.type === "GROUPING_COL") {
        meta = syntheticColumnMeta("number");
      } else if (column.type === "LITERAL_COL") {
        meta = syntheticColumnMeta("string");
      } else if (column.type === "SCALAR_VALUE_COL") {
        const expr = column.expr;
        if (expr.type === "STRING_FUNC") meta = stringFunctionColumnMeta(expr);
        else if (expr.type === "NUMBER" || expr.type === "SCALAR_ARITH") meta = syntheticColumnMeta("number");
        else if (expr.type === "FIELD") meta = resolveField(expr);
        else meta = syntheticColumnMeta("string");
      } else if (column.type === "STRFUNC_COL") {
        meta = stringFunctionColumnMeta(column.expr);
      } else if (column.type === "WINDOW_COL") {
        meta = inferWindowColumnMeta(column, resolveField);
      } else if (column.type === "CASE_COL") {
        const results = column.expr.branches.map((branch) => caseResultColumnMeta(branch.result, resolveField));
        if (column.expr.elseResult) results.push(caseResultColumnMeta(column.expr.elseResult, resolveField));
        meta = mergeExpressionColumnMeta(results);
      } else if (column.type === "SCALAR_SUBQUERY_COL") {
        // サブクエリの実行値は後段で解決される。安全に型を証明できないため既定の文字列意味型を付ける。
        meta = unknownStringColumnMeta();
      }
      inferred.set(output, withDisplayName(meta, column.aliasDisplay ?? output));
    });
  return inferred;
}

function mergeUnionColumnMeta(left: SelectResult, right: SelectResult): MaterializedColumnMetaMap {
  const leftMeta = materializedMetaBySelectResult.get(left);
  const rightMeta = materializedMetaBySelectResult.get(right);
  const merged = new Map<string, MaterializedColumnMeta>();
  left.columns.forEach((column, index) => {
    const a = leftMeta?.get(column);
    const rightColumn = right.columns[index];
    const b = rightColumn === undefined ? undefined : rightMeta?.get(rightColumn);
    let meta: MaterializedColumnMeta;
    if (a && b) {
      const combined = mergeExpressionColumnMeta([a, b]);
      const publicSourceApp = a.publicSourceApp === b.publicSourceApp
        ? a.publicSourceApp
        : undefined;
      const { publicSourceApp: _discarded, ...withoutPublicSource } = combined;
      meta = publicSourceApp === undefined
        ? withoutPublicSource
        : { ...withoutPublicSource, publicSourceApp };
    }
    else meta = unknownStringColumnMeta();
    merged.set(column, withDisplayName(meta, a?.displayName ?? column));
  });
  return merged;
}

interface SelectFieldTypeResolvers {
  row: FieldTypeResolver;
  having: FieldTypeResolver;
}

/** AST の FieldRef を物理テーブルへ安全に結び付ける resolver を構築する。 */
function buildSelectFieldTypeResolvers(
  stmt: SelectStatement,
  fieldTypesByApp: ReadonlyMap<number, FieldTypeMap>
): SelectFieldTypeResolvers {
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const physicalTables = tables.filter((table) => table.cteName === null);
  const outputAliases = new Set(
    stmt.columns
      .map((column) => ("alias" in column ? column.alias : null))
      .filter((alias): alias is string => alias !== null)
  );

  const row: FieldTypeResolver = (field) => {
    if (field.tableAlias !== null) {
      if (field.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        return fieldTypesByApp.get(stmt.from.appId)?.get(field.field);
      }
      const table = tables.find((candidate) => effectiveTableAlias(candidate) === field.tableAlias);
      if (!table || table.cteName !== null) return undefined;
      return subtableSystemFieldType(table, field.field)
        ?? fieldTypesByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field.field));
    }

    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) return undefined;
      return subtableSystemFieldType(stmt.from, field.field)
        ?? fieldTypesByApp.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, field.field));
    }

    // CTE は列型来歴を持たないため、混在 JOIN の非修飾参照は一意と証明できない。
    if (tables.some((table) => table.cteName !== null)) return undefined;
    const matches = physicalTables.flatMap((table): string[] => {
      const type = subtableSystemFieldType(table, field.field)
        ?? fieldTypesByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field.field));
      return type ? [type] : [];
    });
    return matches.length === 1 ? matches[0] : undefined;
  };

  const having: FieldTypeResolver = (field) => {
    if (field.tableAlias === null && outputAliases.has(field.field)) return undefined;
    return row(field);
  };
  return { row, having };
}

const countTotalCountRootSelects = new WeakSet<SelectStatement>();
const resolvedWhereCapabilities = new WeakMap<
  SelectStatement,
  PredicateCapabilityResult
>();

function markCountTotalCountRoot(stmt: SelectStatement): SelectStatement {
  countTotalCountRootSelects.add(stmt);
  return stmt;
}

function rememberSelectWhereCapability(
  stmt: SelectStatement,
  capability: PredicateCapabilityResult
): PredicateCapabilityResult {
  resolvedWhereCapabilities.set(stmt, capability);
  return capability;
}

function isCountStarTotalCountEligible(
  stmt: SelectStatement,
  whereCapability: PredicateCapabilityResult
): boolean {
  if (whereCapability.capability !== "EXACT_PUSHDOWN") return false;
  const countColumns = stmt.columns.filter(
    (column) => column.type === "AGGREGATE"
      && column.func === "COUNT"
      && !column.distinct
      && column.arg.type === "WILDCARD"
  );
  if (countColumns.length !== 1) return false;
  if (stmt.columns.some(
    (column) => column !== countColumns[0] && column.type !== "LITERAL_COL"
  )) return false;
  return (
    !stmt.distinct
    && normalizeGroupingSpec(stmt).type === "NONE"
    && stmt.having === null
    && stmt.joins.length === 0
    && stmt.from.cteName === null
    && !stmt.from.subtableCode
    && stmt.limit === null
    && stmt.offset === null
  );
}

function isValidTotalCount(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}

async function tryCountStarWithTotalCount(
  stmt: SelectStatement,
  client: KintoneClient
): Promise<SelectResult | null> {
  const countColumn = stmt.columns.find((column) => column.type === "AGGREGATE");
  if (countColumn?.type !== "AGGREGATE") return null;
  const baseQuery = stmt.where === null ? "" : whereToKintone(stmt.where);
  const response = await client.getRecords({
    app: stmt.from.appId,
    query: `${baseQuery}${baseQuery ? " " : ""}limit 1`,
    fields: ["$id"],
    totalCount: true,
  });
  if (response.searchAborted) throw new SearchAbortedError();
  if (!isValidTotalCount(response.totalCount)) return null;
  const countKey = countColumn.alias ?? "COUNT(*)";
  const projected = project(
    [{ [countKey]: response.totalCount }],
    stmt.columns
  );
  return {
    type: "SELECT",
    rows: projected.rows,
    columns: projected.columns,
    rowCount: 1,
    warnings: [],
  };
}

/** FULL_SCAN モード: 全テーブルを fetchAll → runFullScan パイプライン */
async function executeFullScanSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, MaterializedTable>,
  allowOriginalWherePushdown = true,
  preloadedOrderMeta?: OrderByMeta,
  prefilterPlan?: RelativeDatePrefilterPlan,
  plainGroupByPlan?: PlainGroupByResolutionPlan
): Promise<SelectResult> {
  const whereCapability = resolvedWhereCapabilities.get(stmt);
  if (
    countTotalCountRootSelects.has(stmt)
    && whereCapability !== undefined
    && isCountStarTotalCountEligible(stmt, whereCapability)
  ) {
    const totalCountResult = await tryCountStarWithTotalCount(stmt, client);
    if (totalCountResult !== null) return totalCountResult;
  }
  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const parallel = options.fetchParallel ?? 1;

  // サブクエリを事前実行（IN (SELECT ...) の値セットを解決）
  await Promise.all([
    resolveSubqueries(stmt.where,  client, options, cacheContext, warnings, cteCache),
    resolveSubqueries(stmt.having, client, options, cacheContext, warnings, cteCache),
  ]);

  // 一般 NUMBER 比較または選択系 IN 候補がある物理アプリだけ、押し下げ用メタを取得する。
  // typedInFieldTypes は最終 JS 評価用で役割が異なるため、統合しない。
  const [pushdownMeta, typedInFieldTypes, aggregateSortKindResolver] = await Promise.all([
    loadTypedPushdownMeta(stmt, client, cacheContext),
    loadTypedInFieldTypes(stmt, client, cacheContext),
    loadAggregateSortKindResolver(stmt, client, cacheContext, cteCache),
  ]);
  const fieldTypeResolvers = buildSelectFieldTypeResolvers(stmt, typedInFieldTypes);
  const fieldSemanticsResolver = await buildWhereFieldSemanticsResolver(
    stmt,
    client,
    cacheContext,
    cteCache,
    whereNeedsFieldMetadata(stmt.having) || selectCaseConditionsNeedFieldMetadata(stmt)
  );
  const havingFieldSemanticsResolver = buildHavingFieldSemanticsResolver(stmt, fieldSemanticsResolver);

  // 同じ計画を検証・fetch・JS 評価で共有する。
  const preboundJoinPlan = boundJoinRuntimePlans.get(stmt);
  if (
    preboundJoinPlan
    && !isJoinServerFunctionFetchPlan(preboundJoinPlan.joinPlan)
  ) {
    throw new Error("InternalError: JOIN server-function fetch binding changed before records API.");
  }
  const pushdownPlan = preboundJoinPlan
    ?? buildRuntimeJoinPushdownPlan(stmt, pushdownMeta)
    ?? buildKlikePushdownPlan(stmt, pushdownMeta);
  validateKlikePushdownPlan(pushdownPlan);
  const runtimeJoinPlan = "joinPlan" in pushdownPlan
    ? pushdownPlan as RuntimeJoinPushdownPlan
    : null;
  const boundServerFunctionPlan =
    runtimeJoinPlan
    && isJoinServerFunctionFetchPlan(runtimeJoinPlan.joinPlan)
      ? runtimeJoinPlan
      : null;
  // B76 §16: 検索打ち切りの fail-closed は撤回した。JOIN plan の有無で挙動が
  // 変わる非対称（B72 と同型）になり、しかも誤値を返す LEFT/RIGHT JOIN が警告のまま
  // という危険度の逆転を生むため。検索打ち切りの安全性は B79 で独立に扱った
  // （B79 実装済み: 外部結合のみ fail-closed。outerJoinSearchAbortGuard.ts）。
  const fetchClient = client;
  const mainPushDown = pushdownPlan.mainCondition;
  const tableConditions = pushdownPlan.joinConditions;
  if (prefilterPlan && allowOriginalWherePushdown) {
    throw new Error("internal error: relative-date prefilter must disable original WHERE pushdown.");
  }
  const mainFetchCondition = prefilterPlan
    ? prefilterPlan.prefilterWhere
    : (boundServerFunctionPlan ? null : mainPushDown);
  const mainBoundQuery = boundServerFunctionPlan?.queriesByAlias.get(
    stmt.from.alias!
  ) ?? "";

  // B71: scalar subquery 内の GROUP BY plan/rejection も外側 fetch より先に確定する。
  const scalarCache = await resolveScalarColumns(
    stmt.columns,
    client,
    options,
    cacheContext,
    warnings,
    cteCache
  );

  // メインテーブルのフェッチを開始（await しない）
  const constantFalse = isConstantFalseWhere(stmt.where);
  const mainFetch = constantFalse ? Promise.resolve([]) : fetchTableRecordsForFullScan(
    stmt,
    stmt.from,
    fetchClient,
    maxRecords,
    parallel,
    true,
    options.onLimitReached ?? "error",
    warnings,
    mainFetchCondition,
    boundServerFunctionPlan ? false : allowOriginalWherePushdown,
    plainGroupByPlan,
    mainBoundQuery
  );

  // JOIN テーブルを push-down の有無で振り分け
  //   push-down あり → 案1: ON 最適化スキップ、案2: メインと並列フェッチ開始
  //   push-down なし → メイン完了後に ON 最適化（従来通り）
  type JoinEntry = { join: (typeof stmt.joins)[number]; promise: Promise<KintoneRecord[]> };
  const parallelJoins: JoinEntry[] = [];
  const onOptJoins: (typeof stmt.joins) = [];

  for (const join of stmt.joins) {
    if (constantFalse) {
      parallelJoins.push({ join, promise: Promise.resolve([]) });
      continue;
    }
    const boundQuery = join.table.alias
      ? (boundServerFunctionPlan?.queriesByAlias.get(join.table.alias) ?? "")
      : "";
    const jCond = boundServerFunctionPlan
      ? null
      : (join.table.alias ? (tableConditions.get(join.table.alias) ?? null) : null);
    if (jCond !== null || boundQuery !== "") {
      parallelJoins.push({
        join,
        promise: fetchTableRecordsForFullScan(
          stmt,
          join.table,
          fetchClient,
          maxRecords,
          parallel,
          false,
          options.onLimitReached ?? "error",
          warnings,
          jCond,
          true,
          plainGroupByPlan,
          boundQuery
        ),
      });
    } else {
      onOptJoins.push(join);
    }
  }

  // ORDER BY メタ情報はレコード取得と並行して解決する。
  const orderByMetaPromise = preloadedOrderMeta
    ? Promise.resolve(preloadedOrderMeta)
    : buildOrderByMetaForSelect(stmt, client, cacheContext, cteCache);
  orderByMetaPromise.catch(() => { /* 同上 */ });

  // メインテーブルの完了を待つ
  const mainRecords = await mainFetch;
  const tables = new Map<string | null, KintoneRecord[]>();
  tables.set(stmt.from.alias, mainRecords);

  // 並列フェッチ済み JOIN テーブルを回収
  for (const { join, promise } of parallelJoins) {
    tables.set(join.table.alias, await promise);
  }

  // ON 最適化が必要な JOIN テーブルを処理（メイン取得後）
  await Promise.all(onOptJoins.map(async (join) => {
    const optimized = await tryFetchJoinRecordsBySourceKeys(
      stmt,
      join,
      tables,
      fetchClient,
      maxRecords,
      parallel,
      options.onLimitReached ?? "error",
      warnings,
      cacheContext,
      cteCache,
      null,
      plainGroupByPlan,
      ""
    );
    const joinRecords = optimized ?? await fetchTableRecordsForFullScan(
      stmt,
      join.table,
      fetchClient,
      maxRecords,
      parallel,
      false,
      options.onLimitReached ?? "error",
      warnings,
      null,
      true,
      plainGroupByPlan,
      ""
    );
    tables.set(join.table.alias, joinRecords);
  }));

  // 並行解決していた ORDER BY メタ情報を回収
  const { optionOrders, sortKinds, semantics } = await orderByMetaPromise;

  // JS 集計パイプライン
  const { rows, columns: projectedColumns } = runFullScan({
    tables,
    stmt,
    scalarCache,
    optionOrders,
    sortKinds,
    orderSemantics: semantics,
    fieldTypeResolver: fieldTypeResolvers.row,
    fieldSemanticsResolver,
    havingFieldTypeResolver: fieldTypeResolvers.having,
    havingFieldSemanticsResolver,
    aggregateSortKindResolver,
    appliedKlikes: prefilterPlan?.appliedKlikes ?? pushdownPlan.appliedKlikes,
    ...(prefilterPlan
      ? { residualWhere: prefilterPlan.residualWhere }
      : boundServerFunctionPlan
        ? { residualWhere: boundServerFunctionPlan.joinPlan.residualWhere }
        : {}),
    resolvedGroupingSpec: resolvedGroupingSpecs.get(stmt),
    plainGroupByPlan,
    warnings,
    evaluationContext: statementEvaluationContext(options),
  });
  const columns = await restoreEmptyWildcardColumns(
    stmt,
    rows,
    projectedColumns,
    client,
    cacheContext
  );

  return { type: "SELECT", rows, columns, rowCount: rows.length, warnings: [...warnings] };
}

// ============================================================
// UNION / UNION ALL
// ============================================================

function assertUnionColumnCount(
  leftColumns: readonly string[],
  rightColumns: readonly string[]
): void {
  if (leftColumns.length === rightColumns.length) return;
  throw new Error(
    `ArgumentError: UNION の左右で列数が一致しません（左 ${leftColumns.length} 列 / 右 ${rightColumns.length} 列）。\n` +
    "UNION は列を位置で対応させるため、両辺の列数を揃えてください"
  );
}

/** UNION と再帰 CTE が共有する、列位置による行・メタの対応付け。 */
function alignSelectResultByPosition(
  result: SelectResult,
  targetColumns: readonly string[],
  targetMeta?: MaterializedColumnMetaMap
): SelectResult {
  assertUnionColumnCount(targetColumns, result.columns);
  const rows = result.rows.map((row) => {
    const mapped: ProcessRow = {};
    targetColumns.forEach((column, index) => {
      mapped[column] = row[result.columns[index] ?? column] ?? "";
    });
    return mapped;
  });
  const aligned: SelectResult = {
    ...result,
    rows,
    columns: [...targetColumns],
    rowCount: rows.length,
  };
  const sourceMeta = materializedMetaBySelectResult.get(result);
  if (targetMeta || sourceMeta) {
    const meta = new Map<string, MaterializedColumnMeta>();
    targetColumns.forEach((column, index) => {
      const sourceColumn = result.columns[index];
      const inferred = targetMeta?.get(column)
        ?? (sourceColumn === undefined ? undefined : sourceMeta?.get(sourceColumn));
      if (inferred) meta.set(column, { ...inferred, displayName: column });
    });
    materializedMetaBySelectResult.set(aligned, meta);
  }
  return aligned;
}

function combineUnionResults(
  leftResult: SelectResult,
  rightResult: SelectResult,
  all: boolean,
  captureColumnMeta: boolean
): SelectResult {
  const alignedRight = alignSelectResultByPosition(rightResult, leftResult.columns);
  const combined = [...leftResult.rows, ...alignedRight.rows];
  const rows = all ? combined : deduplicateRows(combined, leftResult.columns);
  const warnings = [...new Set([
    ...(leftResult.warnings ?? []),
    ...(rightResult.warnings ?? []),
  ])];
  const result: SelectResult = {
    type: "SELECT",
    rows,
    columns: [...leftResult.columns],
    rowCount: rows.length,
    warnings,
  };
  if (captureColumnMeta) {
    materializedMetaBySelectResult.set(result, mergeUnionColumnMeta(leftResult, rightResult));
  }
  return result;
}

async function executeUnion(
  stmt: UnionStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  captureColumnMeta = false,
  forLibraryCapture = false
): Promise<SelectResult> {
  const completePolicy = buildCompleteInputPolicy(stmt, options, null);
  return withCompleteInputPolicy(completePolicy, async () => {
    const effectiveOptions = completePolicy.effectiveOptions;
    // 左辺（ネストした UNION 対応）と右辺を並列実行
    const [leftResult, rightResult] = await Promise.all([
      stmt.left.type === "UNION"
        ? executeUnion(
          stmt.left,
          client,
          effectiveOptions,
          cacheContext,
          captureColumnMeta,
          forLibraryCapture
        )
        : executeSelect(
          markCountTotalCountRoot(stmt.left),
          client,
          effectiveOptions,
          cacheContext,
          undefined,
          captureColumnMeta,
          forLibraryCapture,
          "DERIVED"
        ),
      executeSelect(
        markCountTotalCountRoot(stmt.right),
        client,
        effectiveOptions,
        cacheContext,
        undefined,
        captureColumnMeta,
        forLibraryCapture,
        "DERIVED"
      ),
    ]);

    return combineUnionResults(leftResult, rightResult, stmt.all, captureColumnMeta);
  });
}

/** 行の重複を取り除く（すべてのカラム値が等しい行を1件に） */
function deduplicateRows(rows: ProcessRow[], columns: string[]): ProcessRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    // JSON.stringify で結合し、値に区切り文字を含む場合の誤同一視を防ぐ
    const key = JSON.stringify(columns.map((c) => row[c] ?? ""));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================
// WITH 句（CTE）
// ============================================================

function recursiveSelectOutputName(column: SelectColumn): string | null {
  if ("alias" in column && typeof column.alias === "string") return column.alias;
  if (column.type === "FIELD") return column.field;
  return null;
}

function recursiveOutputColumns(cte: CteDefinition): string[] {
  const spec = cte.recursiveSpec!;
  if (cte.columnAliases) return [...cte.columnAliases];
  const names = spec.seed.columns.map(recursiveSelectOutputName);
  if (names.some((name) => name === null)) {
    throw new Error(
      `PlanningError: 再帰 CTE「${cte.name}」で列名リストを省略する場合、seed の式には AS 別名が必要です`
    );
  }
  const columns = names as string[];
  if (new Set(columns).size !== columns.length) {
    throw new Error(
      `PlanningError: 再帰 CTE「${cte.name}」で列名リストを省略する場合、seed の出力列名を重複させることはできません`
    );
  }
  return columns;
}

function recursivePlanningColumnNames(stmt: SelectStatement): string[] {
  return stmt.columns.map((column, index) => recursiveSelectOutputName(column) ?? `__b53_column_${index}`);
}

function recursiveMetaCompatible(left: MaterializedColumnMeta, right: MaterializedColumnMeta): boolean {
  const a = left.semantics;
  const b = right.semantics;
  if (!a || !b || a.compareMode === "unsupported" || b.compareMode === "unsupported") return false;
  if (a.compareMode !== b.compareMode) return false;
  if (left.sortKind && right.sortKind && left.sortKind !== right.sortKind) return false;
  if (a.inSubtable !== b.inSubtable || a.requiresCollectionOperators !== b.requiresCollectionOperators) return false;
  const synthetic = (fieldType: string | undefined): boolean => fieldType === undefined || fieldType.startsWith("KSQL_");
  if (!synthetic(left.fieldType) && !synthetic(right.fieldType) && left.fieldType !== right.fieldType) return false;
  return true;
}

async function buildRecursiveFieldResolver(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables: ReadonlyMap<string, MaterializedTable>
): Promise<(ref: FieldRef) => MaterializedColumnMeta | undefined> {
  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const physical = new Map<number, Map<string, KintoneFieldInfo>>();
  await Promise.all(tables.filter((table) => table.cteName === null).map(async (table) => {
    if (physical.has(table.appId)) return;
    const infos = await getFieldsCached(table.appId, client, cacheContext);
    physical.set(table.appId, new Map(infos.map((info) => [info.code, info])));
  }));
  const resolveInTable = (table: TableRef, field: string): MaterializedColumnMeta | undefined => {
    if (table.cteName !== null) return materializedTables.get(table.cteName)?.columnMeta?.get(field);
    const info = physical.get(table.appId)?.get(fieldCodeForTypeLookup(table, field));
    return info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(field);
  };
  return (ref) => {
    if (ref.tableAlias !== null) {
      const table = tables.find((candidate) => effectiveTableAlias(candidate) === ref.tableAlias);
      return table ? resolveInTable(table, ref.field) : undefined;
    }
    if (tables.length === 1) return resolveInTable(tables[0], ref.field);
    const matches = tables.map((table) => resolveInTable(table, ref.field)).filter(
      (meta): meta is MaterializedColumnMeta => meta !== undefined
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
}

function validateRecursiveProjectionNode(
  value: unknown,
  resolveField: (ref: FieldRef) => MaterializedColumnMeta | undefined,
  numeric = false
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => validateRecursiveProjectionNode(item, resolveField, numeric));
    return;
  }
  const node = value as { type?: string; field?: unknown; tableAlias?: unknown; left?: unknown; right?: unknown };
  if (node.type === "FIELD") {
    const ref = typeof node.tableAlias === "string" || node.tableAlias === null
      ? node as unknown as FieldRef
      : aggregateFieldRef(String(node.field ?? ""));
    const meta = resolveField(ref);
    if (!meta?.semantics || meta.semantics.compareMode === "unsupported") {
      throw new Error(`PlanningError: 再帰 CTE の射影列 ${ref.tableAlias ? `${ref.tableAlias}.` : ""}${ref.field} の型を証明できません`);
    }
    if (numeric && meta.semantics.compareMode !== "number" && meta.semantics.compareMode !== "recordNumber") {
      throw new Error(`PlanningError: 再帰 CTE の数値演算に数値でない列 ${ref.field} は使用できません`);
    }
    return;
  }
  if (node.type === "FIELD_REF" && typeof node.field === "string") {
    const ref = aggregateFieldRef(node.field);
    const meta = resolveField(ref);
    if (!meta?.semantics || meta.semantics.compareMode === "unsupported") {
      throw new Error(`PlanningError: 再帰 CTE の射影列 ${node.field} の型を証明できません`);
    }
    if (numeric && meta.semantics.compareMode !== "number" && meta.semantics.compareMode !== "recordNumber") {
      throw new Error(`PlanningError: 再帰 CTE の数値演算に数値でない列 ${node.field} は使用できません`);
    }
    return;
  }
  if (node.type === "ARITH" || node.type === "SCALAR_ARITH") {
    validateRecursiveProjectionNode(node.left, resolveField, true);
    validateRecursiveProjectionNode(node.right, resolveField, true);
    return;
  }
  for (const child of Object.values(node)) validateRecursiveProjectionNode(child, resolveField, numeric);
}

async function inferRecursiveProjectionMeta(
  stmt: SelectStatement,
  outputColumns: readonly string[],
  client: KintoneClient,
  cacheContext: string,
  materializedTables: ReadonlyMap<string, MaterializedTable>
): Promise<MaterializedColumnMetaMap> {
  const resolveField = await buildRecursiveFieldResolver(stmt, client, cacheContext, materializedTables);
  stmt.columns.forEach((column) => validateRecursiveProjectionNode(column, resolveField));
  const inferred = await inferSelectColumnMeta(
    stmt,
    recursivePlanningColumnNames(stmt),
    client,
    cacheContext,
    materializedTables
  );
  const sourceNames = recursivePlanningColumnNames(stmt);
  const aligned = new Map<string, MaterializedColumnMeta>();
  outputColumns.forEach((column, index) => {
    const meta = inferred.get(sourceNames[index]);
    if (!meta?.semantics || meta.semantics.fieldType === "KSQL_UNKNOWN" || meta.semantics.compareMode === "unsupported") {
      throw new Error(`PlanningError: 再帰 CTE の第 ${index + 1} 列の型を静的に証明できません`);
    }
    aligned.set(column, { ...meta, displayName: column });
  });
  return aligned;
}

interface RecursivePhysicalSource {
  readonly name: string;
  readonly table: MaterializedTable;
  readonly warnings: readonly string[];
}

function recursivePhysicalSourceKey(table: TableRef): string {
  return `${table.appId}:${table.subtableCode ?? ""}`;
}

function recursivePhysicalTables(...queries: readonly SelectStatement[]): TableRef[] {
  const byKey = new Map<string, TableRef>();
  for (const query of queries) {
    for (const table of [query.from, ...query.joins.map((join) => join.table)]) {
      if (table.cteName === null && !byKey.has(recursivePhysicalSourceKey(table))) {
        byKey.set(recursivePhysicalSourceKey(table), table);
      }
    }
  }
  return [...byKey.values()];
}

type RecursiveSourceFields = Set<string> | null;

function splitRecursiveFieldRef(field: string): { alias: string | null; field: string } {
  const dot = field.indexOf(".");
  return dot < 0
    ? { alias: null, field }
    : { alias: field.slice(0, dot), field: field.slice(dot + 1) };
}

/**
 * Collect the physical columns needed by a recursive seed/term. `null` means
 * fail-open: the reference could not be assigned safely, so every column must
 * be fetched for that source rather than risking a changed result.
 */
function collectRecursivePhysicalSourceFields(
  queries: readonly SelectStatement[]
): Map<string, RecursiveSourceFields> {
  const result = new Map<string, RecursiveSourceFields>();
  const markAll = (tables: readonly TableRef[]): void => {
    for (const table of tables) result.set(recursivePhysicalSourceKey(table), null);
  };
  for (const query of queries) {
    const physical = physicalSelectTables(query);
    for (const table of physical) {
      const key = recursivePhysicalSourceKey(table);
      if (!result.has(key)) result.set(key, new Set());
    }
    const addRef = (rawAlias: string | null, field: string): void => {
      const table = rawAlias === null
        ? (physical.length === 1 ? physical[0] : undefined)
        : [query.from, ...query.joins.map((join) => join.table)]
          .find((candidate) => effectiveTableAlias(candidate)?.toLowerCase() === rawAlias.toLowerCase());
      if (!table) {
        markAll(physical);
        return;
      }
      if (table.cteName !== null) return;
      const current = result.get(recursivePhysicalSourceKey(table));
      if (current !== null) current?.add(field);
    };
    const visit = (node: unknown): void => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const value = node as Record<string, unknown>;
      if (value.type === "WILDCARD" || value.type === "PARENT_WILDCARD") {
        markAll(physical);
        return;
      }
      if ((value.type === "FIELD" || value.type === "FIELD_REF") && typeof value.field === "string") {
        const encoded = splitRecursiveFieldRef(value.field);
        const alias = typeof value.tableAlias === "string"
          ? value.tableAlias
          : value.tableAlias === null
            ? null
            : encoded.alias;
        addRef(alias, encoded.field);
        return;
      }
      if ((value.type === "FIELD_NAME" || value.type === "GROUPING_REF") && typeof value.name === "string") {
        // FIELD_NAME may denote a projected alias. It is unsafe to guess which
        // physical source owns it, so retain correctness with the fail-open path.
        markAll(physical);
        return;
      }
      Object.values(value).forEach(visit);
    };
    visit(query.columns);
    visit(query.where);
    visit(normalizeGroupingSpec(query));
    visit(query.having);
    visit(query.orderBy);
    for (const join of query.joins) {
      if (join.on === null) {
        markAll(physical);
        continue;
      }
      addRef(join.on.left.tableAlias, join.on.left.field);
      addRef(join.on.right.tableAlias, join.on.right.field);
    }
  }
  return result;
}

function recursiveSourceSelect(table: TableRef, fields: RecursiveSourceFields): SelectStatement {
  const columns: SelectStatement["columns"] = fields !== null && fields.size > 0
    ? [...fields].map((field) => ({ type: "FIELD" as const, field, alias: null }))
    : [{ type: "WILDCARD" }];
  return {
    type: "SELECT",
    distinct: false,
    columns,
    from: { ...table, alias: null },
    joins: [],
    where: null,
    groupBy: [],
    having: null,
    orderMode: "CANONICAL",
    orderBy: [],
    limit: null,
    offset: null,
  };
}

async function materializeRecursivePhysicalSources(
  queries: readonly SelectStatement[],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<Map<string, RecursivePhysicalSource>> {
  const fieldsBySource = collectRecursivePhysicalSourceFields(queries);
  const entries = await Promise.all(recursivePhysicalTables(...queries).map(async (table, index) => {
    const result = await executeSelect(
      recursiveSourceSelect(table, fieldsBySource.get(recursivePhysicalSourceKey(table)) ?? null),
      client,
      { ...options, onLimitReached: "error" },
      cacheContext,
      undefined,
      true,
      false,
      "DERIVED"
    );
    const name = `__b53_source_${index}`;
    return [recursivePhysicalSourceKey(table), {
      name,
      warnings: result.warnings ?? [],
      table: {
        rows: result.rows,
        columns: result.columns,
        columnMeta: materializedMetaBySelectResult.get(result),
      },
    }] as const;
  }));
  return new Map(entries);
}

function rewriteRecursivePhysicalSources(
  stmt: SelectStatement,
  sources: ReadonlyMap<string, RecursivePhysicalSource>
): SelectStatement {
  const rewrite = (table: TableRef): TableRef => {
    if (table.cteName !== null) return table;
    const source = sources.get(recursivePhysicalSourceKey(table));
    if (!source) throw new Error("PlanningError: 再帰 CTE の完全実体化 source を解決できません");
    return { appId: 0, alias: table.alias, cteName: source.name, subtableCode: null };
  };
  return {
    ...stmt,
    from: rewrite(stmt.from),
    joins: stmt.joins.map((join) => ({ ...join, table: rewrite(join.table) })),
  };
}

function tableMetaForJoinKey(
  table: TableRef,
  field: string,
  cache: ReadonlyMap<string, MaterializedTable>
): MaterializedColumnMeta | undefined {
  return table.cteName === null ? undefined : cache.get(table.cteName)?.columnMeta?.get(field);
}

function recursiveJoinKey(value: string, semantics: ResolvedFieldSemantics): string {
  if (semantics.compareMode !== "number" && semantics.compareMode !== "recordNumber") return value;
  const decimal = parseExactDecimal(value);
  return decimal === null
    ? `invalid:${value}`
    : `${decimal.sign}:${decimal.coefficient}:${decimal.scale}`;
}

function recursiveJoinSides(
  cteName: string,
  term: SelectStatement
): { self: TableRef; source: TableRef; selfField: string; sourceField: string } {
  const join = term.joins[0];
  if (!join || join.type !== "INNER") throw new Error("PlanningError: 再帰項の INNER JOIN を解決できません");
  const self = term.from.cteName === cteName ? term.from : join.table;
  const source = self === term.from ? join.table : term.from;
  const selfAlias = effectiveTableAlias(self);
  const leftIsSelf = join.on.left.tableAlias === selfAlias;
  const rightIsSelf = join.on.right.tableAlias === selfAlias;
  if (leftIsSelf === rightIsSelf) throw new Error("PlanningError: 再帰項の自己参照 JOIN キーを一意に解決できません");
  return {
    self,
    source,
    selfField: leftIsSelf ? join.on.left.field : join.on.right.field,
    sourceField: leftIsSelf ? join.on.right.field : join.on.left.field,
  };
}

interface RecursiveFrontierRow {
  readonly row: ProcessRow;
  readonly path: readonly string[];
}

async function executeRecursiveCte(
  cte: CteDefinition,
  client: KintoneClient,
  options: ExecuteOptions,
  cteCache: Map<string, MaterializedTable>,
  cacheContext: string
): Promise<SelectResult> {
  const spec = cte.recursiveSpec!;
  const outputColumns = recursiveOutputColumns(cte);
  const seedMeta = await inferRecursiveProjectionMeta(
    spec.seed, outputColumns, client, cacheContext, cteCache
  );
  const planningCache = new Map(cteCache);
  planningCache.set(cte.name, { rows: [], columns: outputColumns, columnMeta: seedMeta });
  const termMeta = await inferRecursiveProjectionMeta(
    spec.recursiveTerm, outputColumns, client, cacheContext, planningCache
  );
  outputColumns.forEach((column, index) => {
    const left = seedMeta.get(column);
    const right = termMeta.get(column);
    if (!left || !right || !recursiveMetaCompatible(left, right)) {
      throw new Error(`PlanningError: 再帰 CTE「${cte.name}」の第 ${index + 1} 列で seed と再帰項の型が一致しません`);
    }
  });
  const planningSides = recursiveJoinSides(cte.name, spec.recursiveTerm);
  const termFieldResolver = await buildRecursiveFieldResolver(
    spec.recursiveTerm, client, cacheContext, planningCache
  );
  const selfJoinMeta = termFieldResolver({
    type: "FIELD",
    tableAlias: effectiveTableAlias(planningSides.self),
    field: planningSides.selfField,
  });
  const sourceJoinMeta = termFieldResolver({
    type: "FIELD",
    tableAlias: effectiveTableAlias(planningSides.source),
    field: planningSides.sourceField,
  });
  if (!selfJoinMeta || !sourceJoinMeta || !recursiveMetaCompatible(selfJoinMeta, sourceJoinMeta)) {
    throw new Error(`PlanningError: 再帰 CTE「${cte.name}」の自己参照 JOIN キーの型が一致しません`);
  }

  const sources = await materializeRecursivePhysicalSources(
    [spec.seed, spec.recursiveTerm], client, options, cacheContext
  );
  const runtimeCache = new Map(cteCache);
  for (const source of sources.values()) runtimeCache.set(source.name, source.table);
  const seedQuery = rewriteRecursivePhysicalSources(spec.seed, sources);
  const termQuery = rewriteRecursivePhysicalSources(spec.recursiveTerm, sources);
  const rawSeed = await executeQueryWithCte(seedQuery, client, options, runtimeCache, cacheContext, true, true);
  const seed = alignSelectResultByPosition(rawSeed, outputColumns, seedMeta);
  const cycle = spec.cycle;
  const cycleMeta = cycle ? seedMeta.get(cycle.column) : undefined;
  const resultMeta = new Map(seedMeta);
  if (cycle) resultMeta.set(cycle.markColumn, { ...syntheticColumnMeta("string"), displayName: cycle.markColumn });
  const resultColumns = cycle ? [...outputColumns, cycle.markColumn] : [...outputColumns];
  const rows: ProcessRow[] = [];
  let frontier: RecursiveFrontierRow[] = [];
  const warnings = new Set([
    ...(seed.warnings ?? []),
    ...[...sources.values()].flatMap((source) => source.warnings),
  ]);
  const limits = new RecursiveCteLimitCounter(cte.name, resolveRecursiveCteLimits(options));
  const append = (row: ProcessRow): void => {
    limits.addRow();
    rows.push(row);
  };
  for (const row of seed.rows) {
    const value = cycle ? String(row[cycle.column] ?? "") : "";
    const emitted = cycle ? { ...row, [cycle.markColumn]: cycle.defaultValue } : row;
    append(emitted);
    frontier.push({ row, path: cycle ? [value] : [] });
  }

  const sides = recursiveJoinSides(cte.name, termQuery);
  const sourceTable = sides.source.cteName === null ? undefined : runtimeCache.get(sides.source.cteName);
  if (!sourceTable) throw new Error("PlanningError: 再帰項の完全実体化 source がありません");
  const joinMeta = tableMetaForJoinKey(sides.self, sides.selfField, planningCache)
    ?? tableMetaForJoinKey(sides.source, sides.sourceField, runtimeCache);
  if (!joinMeta?.semantics || joinMeta.semantics.compareMode === "unsupported") {
    throw new Error(`PlanningError: 再帰項の JOIN キー ${sides.selfField} の型を証明できません`);
  }
  const sourceRowsByKey = new Map<string, ProcessRow[]>();
  for (const sourceRow of sourceTable.rows) {
    const value = String(sourceRow[sides.sourceField] ?? "");
    const key = recursiveJoinKey(value, joinMeta.semantics);
    const bucket = sourceRowsByKey.get(key);
    if (bucket) bucket.push(sourceRow);
    else sourceRowsByKey.set(key, [sourceRow]);
  }
  const sourceHasEmptyKey = sourceRowsByKey.has(recursiveJoinKey("", joinMeta.semantics));

  let depth = 0;
  let emptyKeyWarned = false;
  while (frontier.length > 0) {
    depth++;
    const next: RecursiveFrontierRow[] = [];
    for (const parent of frontier) {
      const parentKey = String(parent.row[sides.selfField] ?? "");
      if (!emptyKeyWarned && parentKey === "" && sourceHasEmptyKey) {
        warnings.add(
          `再帰 CTE「${cte.name}」の JOIN ${sides.selfField} = ${sides.sourceField} で第 ${depth} 反復に両側の空キーを検出しました。空キーどうしは一致し、ルート群を再展開し得ます。`
        );
        emptyKeyWarned = true;
      }
      const matchingSourceRows = sourceRowsByKey.get(recursiveJoinKey(parentKey, joinMeta.semantics)) ?? [];
      for (const sourceRow of matchingSourceRows) {
        const sourceKey = String(sourceRow[sides.sourceField] ?? "");
        if (!compareScalarValues("=", parentKey, sourceKey, joinMeta.semantics)) continue;
        limits.addExpansion();
      }
      if (matchingSourceRows.length === 0) continue;
      const iterationCache = new Map(runtimeCache);
      iterationCache.set(cte.name, {
        rows: [parent.row],
        columns: outputColumns,
        columnMeta: seedMeta,
      });
      const rawCandidates = await executeQueryWithCte(
        termQuery, client, options, iterationCache, cacheContext, true, true
      );
      for (const warning of rawCandidates.warnings ?? []) warnings.add(warning);
      const candidates = alignSelectResultByPosition(rawCandidates, outputColumns, seedMeta);
      if (candidates.rows.length > 0) limits.observeDepth(depth);
      for (const candidate of candidates.rows) {
        if (!cycle) {
          append(candidate);
          next.push({ row: candidate, path: [] });
          continue;
        }
        const value = String(candidate[cycle.column] ?? "");
        const isCycle = parent.path.some((seen) =>
          compareScalarValues("=", seen, value, cycleMeta!.semantics)
        );
        append({ ...candidate, [cycle.markColumn]: isCycle ? cycle.markValue : cycle.defaultValue });
        if (!isCycle) next.push({ row: candidate, path: [...parent.path, value] });
      }
    }
    frontier = next;
  }

  const result: SelectResult = {
    type: "SELECT",
    rows,
    columns: resultColumns,
    rowCount: rows.length,
    warnings: [...warnings],
  };
  materializedMetaBySelectResult.set(result, resultMeta);
  return result;
}

async function executeWith(
  stmt: WithStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** バッチ実行時の一時テーブルストア（#name → 行＋列）。CTE キャッシュの初期値として合流する */
  seed?: ReadonlyMap<string, MaterializedTable>,
  captureColumnMeta = false
): Promise<SelectResult> {
  // 単純 CTE のインライン化（WHERE プッシュダウン最適化）
  // CTE 本体が SIMPLE モードで最終クエリが単純 SELECT の場合、
  // CTE を展開して WHERE をまとめて REST API に渡す。
  // 一時テーブル注入時はインライン化しない（CTE 本体が #temp を参照し得るため）
  if ((seed == null || seed.size === 0) && canInlineSingleCte(stmt)) {
    return executeSelect(
      buildInlinedQuery(stmt), client, options, cacheContext, undefined,
      captureColumnMeta, false, "DERIVED"
    );
  }

  // CTE 名 → 実体化結果のキャッシュ（一時テーブル名は # 付きのため CTE 名と衝突しない）
  const cteCache = new Map<string, MaterializedTable>(seed ?? []);
  const warnings = new Set<string>();

  // 各 CTE を順番に実行し、結果をキャッシュ
  for (const cte of stmt.ctes) {
    let result: SelectResult;
    if (cte.recursiveSpec) {
      result = await executeRecursiveCte(cte, client, options, cteCache, cacheContext);
    } else if (cte.query.type === "SHOW_APPS") {
      result = await executeShowApps(client);
    } else if (cte.query.type === "DESCRIBE") {
      result = await executeDescribe(cte.query, client, cacheContext);
    } else if (cte.query.type === "GENERATE_SERIES") {
      result = executeGenerateSeries(cte.query);
    } else {
      result = await executeQueryWithCte(cte.query, client, options, cteCache, cacheContext, true);
    }
    for (const warning of result.warnings ?? []) warnings.add(warning);
    cteCache.set(cte.name, {
      rows: result.rows,
      columns: result.columns,
      columnMeta: materializedMetaBySelectResult.get(result),
      ...(cte.query.type === "GENERATE_SERIES" ? { uniqueGeneratedColumn: cte.query.columnAlias } : {}),
    });
  }

  // 最終クエリを CTE キャッシュ付きで実行
  const result = await executeQueryWithCte(
    stmt.query, client, options, cteCache, cacheContext, captureColumnMeta
  );
  return mergeSelectWarnings(result, [...warnings]);
}

function executeGenerateSeries(stmt: GenerateSeriesStatement): SelectResult {
  const series = resolveGenerateSeries(stmt);
  const result: SelectResult = {
    type: "SELECT",
    columns: [stmt.columnAlias],
    rows: series.values.map((value) => ({ [stmt.columnAlias]: value })),
    rowCount: series.rowCount,
    warnings: [],
  };
  const meta = series.kind === "INTEGER"
    ? {
        sortKind: "number" as const,
        fieldType: "NUMBER",
        semantics: resolveFieldSemantics({ fieldType: "NUMBER" }),
      }
    : {
        sortKind: "string" as const,
        fieldType: "DATE",
        semantics: resolveFieldSemantics({ fieldType: "DATE" }),
      };
  materializedMetaBySelectResult.set(result, new Map([[stmt.columnAlias, meta]]));
  return result;
}

/**
 * SelectStatement | UnionStatement を CTE キャッシュ付きで実行する。
 * FROM / JOIN が CTE 参照を含む場合は FULL_SCAN モードで CTE 行を注入する。
 */
async function executeQueryWithCte(
  query: SelectStatement | UnionStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cteCache: Map<string, MaterializedTable>,
  cacheContext: string,
  captureColumnMeta = false,
  b86PreflightComplete = false
): Promise<SelectResult> {
  if (!b86PreflightComplete) {
    await preflightB86QueryWithCte(query, client, cteCache, cacheContext);
  }
  if (query.type === "UNION") {
    const [leftResult, rightResult] = await Promise.all([
      executeQueryWithCte(query.left,  client, options, cteCache, cacheContext, captureColumnMeta, true),
      executeQueryWithCte(query.right, client, options, cteCache, cacheContext, captureColumnMeta, true),
    ]);
    return combineUnionResults(leftResult, rightResult, query.all, captureColumnMeta);
  }

  // CTE 参照が FROM か JOIN に含まれるか確認
  const hasCteRef =
    (
      query.from.cteName != null &&
      query.from.cteName !== NO_FROM_CTE_NAME
    ) ||
    query.joins.some((j) => j.table.cteName != null);

  if (!hasCteRef) {
    // トップレベルに CTE 参照なし → 通常の SELECT 実行。
    // ただしサブクエリ内の CTE / 一時テーブル参照があり得るため cteCache は引き継ぐ
    return executeSelect(
      query, client, options, cacheContext, cteCache, captureColumnMeta, false, "DERIVED"
    );
  }

  // CTE 参照あり → FULL_SCAN で CTE 行を注入
  const result = await executeFullScanWithCte(query, client, options, cteCache, cacheContext);
  if (captureColumnMeta) {
    materializedMetaBySelectResult.set(result, await inferSelectColumnMeta(query, result.columns, client, cacheContext, cteCache));
  }
  return result;
}

/**
 * FROM / JOIN に CTE 参照を含む SELECT を FULL_SCAN モードで実行する。
 * CTE 行は ProcessRow[] → KintoneRecord[] に変換して runFullScan に渡し、
 * JOIN なしの単一実体化ソースでは保存列も sourceColumns として渡す。
 */
async function executeFullScanWithCte(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cteCache: Map<string, MaterializedTable>,
  cacheContext: string
): Promise<SelectResult> {
  await validateSelectGroupingPlanning(stmt, client, cacheContext, cteCache);
  const resolvedGroupingSpec = resolvedGroupingSpecs.get(stmt);
  const plainGroupByPlan = await buildRuntimePlainGroupByPlan(
    stmt,
    client,
    cacheContext,
    cteCache
  );
  const hiddenQualifiedAliases = new Set<string>();
  const withEffectiveAlias = (table: TableRef): TableRef => {
    if (table.alias !== null || table.cteName === null) return table;
    const alias = effectiveTableAlias(table)!;
    hiddenQualifiedAliases.add(alias);
    return { ...table, alias };
  };
  stmt = {
    ...stmt,
    from: withEffectiveAlias(stmt.from),
    joins: stmt.joins.map((join) => ({ ...join, table: withEffectiveAlias(join.table) })),
  };

  const aliases = new Set<string>();
  for (const table of [stmt.from, ...stmt.joins.map((join) => join.table)]) {
    const alias = effectiveTableAlias(table);
    if (alias === null) continue;
    if (aliases.has(alias)) {
      throw new Error(`ArgumentError: effective alias ${alias} is used by multiple tables.`);
    }
    aliases.add(alias);
  }

  const requireMaterializedTable = (name: string): MaterializedTable => {
    const table = cteCache.get(name);
    if (!table) {
      throw new Error(`ArgumentError: materialized source ${name} is not available.`);
    }
    return table;
  };
  for (const table of [stmt.from, ...stmt.joins.map((join) => join.table)]) {
    if (table.cteName !== null) requireMaterializedTable(table.cteName);
  }

  const { resolver: choiceAndWindowResolver } = await normalizeSelectChoiceEquality(
    stmt,
    client,
    cacheContext,
    cteCache,
    hasWindowNeedingOrderProof(stmt)
  );
  const defaultRangeWarnings = collectDefaultRangeWindowWarnings(
    stmt,
    choiceAndWindowResolver,
    "DERIVED",
    stmt.joins.length === 0 && stmt.from.cteName !== null
      ? cteCache.get(stmt.from.cteName)?.uniqueGeneratedColumn
      : undefined
  );

  const maxRecords = options.maxRecords ?? 10_000;
  const warnings = new Set<string>();
  const parallel = options.fetchParallel ?? 1;

  // サブクエリを事前実行（サブクエリ内の CTE / 一時テーブル参照にも cteCache を引き継ぐ）
  await Promise.all([
    resolveSubqueries(stmt.where,  client, options, cacheContext, warnings, cteCache),
    resolveSubqueries(stmt.having, client, options, cacheContext, warnings, cteCache),
    resolveSelectCaseSubqueries(stmt, client, options, cacheContext, warnings, cteCache),
  ]);
  const whereCapability = classifyWhereCapability(stmt.where, choiceAndWindowResolver);
  if (whereCapability.capability === "UNSUPPORTED") {
    throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(whereCapability)}).`);
  }
  const orderMeta = await buildOrderByMetaForSelect(stmt, client, cacheContext, cteCache);
  const orderPlan = hasCanonicalOrder(stmt)
    ? (stmt.orderMode === "KINTONE_NATIVE" ? planKorder : planCanonicalOrder)({
      stmt,
      staticMode: "FULL_SCAN",
      whereCapability: whereCapability.capability,
      whereReasons: whereCapability.reasons,
      orderSemantics: orderMeta.semantics,
      maxRecords,
      hasKlike: whereHasKlike(stmt.where),
    })
    : null;
  const completePolicy = buildCompleteInputPolicy(stmt, options, orderPlan);
  const effectiveOptions = completePolicy.effectiveOptions;

  const [pushdownMeta, typedInFieldTypes, aggregateSortKindResolver] = await Promise.all([
    loadTypedPushdownMeta(stmt, client, cacheContext),
    loadTypedInFieldTypes(stmt, client, cacheContext),
    loadAggregateSortKindResolver(stmt, client, cacheContext, cteCache),
  ]);
  const fieldTypeResolvers = buildSelectFieldTypeResolvers(stmt, typedInFieldTypes);
  const fieldSemanticsResolver = await buildWhereFieldSemanticsResolver(
    stmt,
    client,
    cacheContext,
    cteCache,
    whereNeedsFieldMetadata(stmt.having) || selectCaseConditionsNeedFieldMetadata(stmt)
  );
  const havingFieldSemanticsResolver = buildHavingFieldSemanticsResolver(stmt, fieldSemanticsResolver);
  const pushdownPlan = buildRuntimeJoinPushdownPlan(stmt, pushdownMeta)
    ?? buildKlikePushdownPlan(stmt, pushdownMeta);
  validateKlikePushdownPlan(pushdownPlan);
  // B76 §16: 検索打ち切りの fail-closed は撤回した。JOIN plan の有無で挙動が
  // 変わる非対称（B72 と同型）になり、しかも誤値を返す LEFT/RIGHT JOIN が警告のまま
  // という危険度の逆転を生むため。検索打ち切りの安全性は B79 で独立に扱った
  // （B79 実装済み: 外部結合のみ fail-closed。outerJoinSearchAbortGuard.ts）。
  const fetchClient = client;

  // B71: scalar subquery 内の GROUP BY plan/rejection も外側 fetch より先に確定する。
  const scalarCache = await resolveScalarColumns(
    stmt.columns,
    client,
    effectiveOptions,
    cacheContext,
    warnings,
    cteCache
  );
  const orderByMetaPromise = Promise.resolve(orderMeta);
  orderByMetaPromise.catch(() => { /* 同上 */ });

  const tables = new Map<string | null, KintoneRecord[]>();
  const tableColumns = new Map<string | null, readonly string[]>();

  // メインテーブル取得
  if (stmt.from.cteName != null) {
    const table = requireMaterializedTable(stmt.from.cteName);
    tables.set(stmt.from.alias, table.rows.map(processRowToKintoneRecord));
    tableColumns.set(stmt.from.alias, table.columns);
  } else {
    const mainRecords = await withCompleteInputPolicy(completePolicy, () => fetchTableRecordsForFullScan(
      stmt,
      stmt.from,
      fetchClient,
      maxRecords,
      parallel,
      true,
      effectiveOptions.onLimitReached ?? "error",
      warnings,
      pushdownPlan.mainCondition,
      whereCapability.capability === "EXACT_PUSHDOWN",
      plainGroupByPlan
    ));
    tables.set(stmt.from.alias, mainRecords);
  }

  // JOIN テーブル取得
  const joinFetches = stmt.joins.map((join) => withCompleteInputPolicy(completePolicy, async () => {
    if (join.table.cteName != null) {
      const table = requireMaterializedTable(join.table.cteName);
      tables.set(join.table.alias, table.rows.map(processRowToKintoneRecord));
      tableColumns.set(join.table.alias, table.columns);
    } else {
      const pushDownCond = join.table.alias
        ? (pushdownPlan.joinConditions.get(join.table.alias) ?? null)
        : null;
      const optimized = await tryFetchJoinRecordsBySourceKeys(
        stmt,
        join,
        tables,
        fetchClient,
        maxRecords,
        parallel,
        effectiveOptions.onLimitReached ?? "error",
        warnings,
        cacheContext,
        cteCache,
        pushDownCond,
        plainGroupByPlan
      );
      const joinRecords = optimized ?? await fetchTableRecordsForFullScan(
        stmt,
        join.table,
        fetchClient,
        maxRecords,
        parallel,
        false,
        effectiveOptions.onLimitReached ?? "error",
        warnings,
        pushDownCond,
        true,
        plainGroupByPlan
      );
      tables.set(join.table.alias, joinRecords);
    }
  }));
  await Promise.all(joinFetches);

  const { optionOrders, sortKinds, semantics } = await orderByMetaPromise;
  const sourceColumns = stmt.joins.length === 0 && stmt.from.cteName != null
    ? requireMaterializedTable(stmt.from.cteName).columns
    : undefined;
  const { rows, columns: projectedColumns } = runFullScan({
    tables,
    stmt,
    scalarCache,
    optionOrders,
    sortKinds,
    orderSemantics: semantics,
    fieldTypeResolver: fieldTypeResolvers.row,
    fieldSemanticsResolver,
    havingFieldTypeResolver: fieldTypeResolvers.having,
    havingFieldSemanticsResolver,
    aggregateSortKindResolver,
    appliedKlikes: pushdownPlan.appliedKlikes,
    sourceColumns,
    tableColumns,
    hiddenQualifiedAliases,
    resolvedGroupingSpec,
    plainGroupByPlan,
    evaluationContext: statementEvaluationContext(options),
  });
  const columns = await restoreEmptyWildcardColumns(
    stmt,
    rows,
    projectedColumns,
    client,
    cacheContext
  );
  return mergeSelectWarnings(
    { type: "SELECT", rows, columns, rowCount: rows.length, warnings: [...warnings] },
    defaultRangeWarnings
  );
}

async function restoreEmptyWildcardColumns(
  stmt: SelectStatement,
  rows: readonly ProcessRow[],
  columns: readonly string[],
  client: KintoneClient,
  cacheContext: string
): Promise<string[]> {
  if (
    rows.length !== 0
    || columns.length !== 0
    || stmt.columns.length !== 1
    || stmt.columns[0].type !== "WILDCARD"
    || stmt.joins.length !== 0
    || stmt.from.cteName !== null
  ) {
    return [...columns];
  }
  const fields = await getFieldsCached(stmt.from.appId, client, cacheContext);
  return deriveEmptyWildcardColumns(
    fields,
    stmt.from.subtableCode,
    () => getProcessStatusesCached(stmt.from.appId, client, cacheContext)
  );
}

/** ProcessRow → KintoneRecord（すべての値を string として保持） */
function processRowToKintoneRecord(row: ProcessRow): KintoneRecord {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, { value: v ?? "" }])
  );
}

async function fetchTableRecordsForFullScan(
  stmt: SelectStatement,
  table: TableRef,
  client: KintoneClient,
  maxRecords: number,
  parallel: number,
  isMainTable: boolean,
  onLimit: "error" | "truncate",
  warnings: Set<string>,
  pushDownCond: WhereExpr | null = null,
  allowOriginalWherePushdown = true,
  plainGroupByPlan?: PlainGroupByResolutionPlan,
  additionalPushQuery = ""
): Promise<KintoneRecord[]> {
  const fields = selectToFetchAllFields(stmt, table, plainGroupByPlan);
  const onTruncate = (max: number): void => {
    warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
    markLimitReached(client, table.appId);
    if (isOuterJoinNonPreservedTable(stmt, table, isMainTable)) {
      throw new FetchAllLimitError(
        "外部結合の正しい結果には完全な候補集合が必要です。" +
        `complete input reason: OUTER_JOIN_NON_PRESERVED（APP${table.appId}）。` +
        "onLimit=truncateは使用できません。" +
        `取得件数が上限（${max} 件）を超えました。` +
        "WHERE 句で絞り込むか、maxRecords を引き上げてください。",
        true
      );
    }
  };
  if (!table.subtableCode) {
    const baseQuery = isMainTable && allowOriginalWherePushdown
      ? selectToFetchAllParams(stmt, table.appId).query
      : "";
    const pushQueries = [
      pushDownCond !== null ? whereToKintone(pushDownCond) : "",
      additionalPushQuery,
    ].filter((query) => query !== "");
    const pushQuery = pushQueries.length > 1
      ? pushQueries.map((query) => `(${query})`).join(" and ")
      : (pushQueries[0] ?? "");
    const query = baseQuery && pushQuery
      ? `(${baseQuery}) and (${pushQuery})`
      : baseQuery || pushQuery;
    const resolved = await fetchRecordsForSharedPlan(client.getRecords, table.appId, query, fields, {
      parallel,
      maxRecords,
      onLimit,
      onTruncate,
    });
    return resolved.records;
  }

  // サブテーブル仮想テーブルは親レコードを取得して展開する。
  //
  // B144: 以前はここが `isMainTable ? "" : ""`（両辺とも空文字）で、親クエリを一切
  // 組み立てていなかった。一方 EXPLAIN は WHERE 全体が exact に押し下げられる場合に
  // `kintone query:` を表示するため、「計画は EXACT・実行は全件取得」と食い違っていた。
  //
  // EXPLAIN と同じ条件（WHERE 全体が EXACT_PUSHDOWN）でだけ押し下げる。exact なら
  // 述語は親項目だけで構成されており、親を絞っても行は落ちない（`_pid` などの
  // サブテーブル側システム列や明細項目を含む WHERE は EXACT にならない）。
  // 取得後に元の WHERE をローカルで再評価する点は従来どおり。
  const parentQuery = isMainTable
    && allowOriginalWherePushdown
    && stmt.joins.length === 0
    && stmt.where !== null
    && resolvedWhereCapabilities.get(stmt)?.capability === "EXACT_PUSHDOWN"
    && !whereRequiresJsEval(stmt.where)
    ? whereToKintone(stmt.where)
    : "";
  const parentResolved = await fetchRecordsForSharedPlan(client.getRecords, table.appId, parentQuery, fields, {
    parallel,
    maxRecords,
    onLimit,
    onTruncate,
  });
  const parentRecords = parentResolved.records;
  return expandSubtableRecords(parentRecords, table.subtableCode);
}

// ============================================================
// UPSERT 既存判定の一括解決
//
// 従来は 1 行ごとに GET を発行していた（N+1）。キー値を in (...) で
// 50 件ずつまとめて取得し、「キー値 → 最大 $id」の索引を先に構築する。
// ============================================================

const UPSERT_IN_CHUNK_SIZE = 50;

interface UpsertTargetIndex {
  /** キー値そのまま → 最大 $id */
  raw: Map<string, number>;
  /** 数値正規化済みキー（"5.0" と "5" を同一視）→ 最大 $id */
  normalized: Map<string, number>;
  /** キー成分ごとに数値正規化を適用するか（NUMBER フィールドのみ true） */
  numericKey: boolean[];
}

/** 数値として解釈できるキー成分は正規形に揃える（数値フィールドの表記ゆれ対策） */
function normalizeKeyPart(v: string): string {
  const decimal = parseExactDecimal(v);
  if (decimal !== null) return JSON.stringify(decimal);
  return v;
}

// 複合キーは JSON.stringify で結合する（値に区切り文字を含む場合の衝突を防ぐ）
function upsertCompositeKey(parts: string[]): string {
  return JSON.stringify(parts);
}

function upsertNormalizedKey(parts: string[], numericKey: boolean[]): string {
  return JSON.stringify(parts.map((p, i) => (numericKey[i] ? normalizeKeyPart(p) : p)));
}

/**
 * 行キーに対応する既存レコード $id を索引から引く。
 * 完全一致を優先し、NUMBER フィールドのキーに限り数値正規化でフォールバックする
 * （テキストフィールドの "001" と "1" を誤同一視しないため）。
 */
function lookupUpsertTarget(index: UpsertTargetIndex, keyParts: string[]): number | undefined {
  const exact = index.raw.get(upsertCompositeKey(keyParts));
  if (exact !== undefined) return exact;
  if (!index.numericKey.some(Boolean)) return undefined;
  return index.normalized.get(upsertNormalizedKey(keyParts, index.numericKey));
}

/**
 * UPSERT 対象行のキー値をまとめて検索し、既存レコードの索引を構築する。
 *
 * - 第 1 キーを in (...) で 50 件ずつチャンク検索し、複合キーの残りは
 *   取得レコードの値で照合する（索引キーに全成分を含める）
 * - 空文字を含むキーは in (...) にまとめられないため従来どおり行ごとに検索
 * - キーが複数レコードにヒットした場合は最大 $id（最新）を採用
 * - 数値正規化フォールバックは fieldType が NUMBER のキーのみ有効
 */
async function resolveUpsertTargets(
  appId: number,
  keyFields: string[],
  rowKeyValues: string[][],
  client: KintoneClient,
  options: ExecuteOptions,
  fieldTypes: FieldTypeMap
): Promise<UpsertTargetIndex> {
  const maxRecords = options.maxRecords ?? 10_000;
  const parallel = options.fetchParallel ?? 1;
  const numericKey = keyFields.map((f) => fieldTypes.get(f) === "NUMBER");
  const index: UpsertTargetIndex = { raw: new Map(), normalized: new Map(), numericKey };

  const setMax = (map: Map<string, number>, key: string, id: number): void => {
    const cur = map.get(key);
    if (cur === undefined || id > cur) map.set(key, id);
  };
  const addRecordToIndex = (parts: string[], id: number): void => {
    setMax(index.raw, upsertCompositeKey(parts), id);
    if (numericKey.some(Boolean)) {
      setMax(index.normalized, upsertNormalizedKey(parts, numericKey), id);
    }
  };

  // ユニークなキー組を「in (...) でまとめられる行」と「行ごと検索の行」に振り分け
  const batchFirstKeys = new Set<string>();
  const perRowKeys: string[][] = [];
  const seen = new Set<string>();
  for (const parts of rowKeyValues) {
    const composite = upsertCompositeKey(parts);
    if (seen.has(composite)) continue;
    seen.add(composite);
    if (parts.some((p) => p === "")) perRowKeys.push(parts);
    else batchFirstKeys.add(parts[0]);
  }

  // 第 1 キーの in (...) チャンク検索
  const fields = ["$id", ...keyFields];
  for (const chunk of splitChunks([...batchFirstKeys], UPSERT_IN_CHUNK_SIZE)) {
    const query = `${keyFields[0]} in (${chunk.map(sqlQuote).join(",")})`;
    const records = await fetchAll(client.getRecords, appId, query, fields, { maxRecords, parallel });
    for (const rec of records) {
      const id = Number(rec["$id"]?.value);
      if (!Number.isFinite(id)) continue;
      addRecordToIndex(keyFields.map((f) => toScalarText(rec[f]?.value)), id);
    }
  }

  // 空文字キーを含む行は従来どおり行ごとに検索
  for (const parts of perRowKeys) {
    const query = keyFields.map((f, i) => `${f} = ${sqlQuote(parts[i])}`).join(" and ");
    const existing = await fetchAll(client.getRecords, appId, query, ["$id"], { maxRecords, parallel });
    if (existing.length === 0) continue;
    addRecordToIndex(parts, maxRecordId(existing));
  }

  return index;
}

/**
 * UPSERT の既存判定でキーが複数レコードにヒットした場合、最大 $id（最新レコード）を
 * 更新対象に選ぶ。fetchAll のページングが $id 昇順になっても挙動が変わらないよう
 * 明示的に選択する。
 */
function maxRecordId(records: KintoneRecord[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const r of records) {
    const n = Number(r["$id"]?.value);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (!Number.isFinite(max)) {
    throw new Error("レコードに数値の $id が含まれていません。");
  }
  return max;
}

function toScalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function sqlQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function splitChunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const JOIN_IN_MAX_CHUNKS = 6;
const JOIN_IN_MAX_KEYS = JOIN_KEY_IN_CHUNK_SIZE * JOIN_IN_MAX_CHUNKS;

async function tryFetchJoinRecordsBySourceKeys(
  stmt: SelectStatement,
  join: SelectStatement["joins"][number],
  tables: Map<string | null, KintoneRecord[]>,
  client: KintoneClient,
  maxRecords: number,
  parallel: number,
  onLimit: "error" | "truncate",
  warnings: Set<string>,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>,
  pushDownCond: WhereExpr | null = null,
  plainGroupByPlan?: PlainGroupByResolutionPlan,
  additionalPushQuery = ""
): Promise<KintoneRecord[] | null> {
  if (join.type !== "INNER") return null;
  if (!join.table.alias) return null;
  if (join.table.subtableCode) return null;

  const leftAlias = join.on.left.tableAlias;
  const rightAlias = join.on.right.tableAlias;
  if (!leftAlias || !rightAlias) return null;

  let sourceAlias: string;
  let sourceField: string;
  let joinField: string;
  if (leftAlias === join.table.alias && rightAlias !== join.table.alias) {
    sourceAlias = rightAlias;
    sourceField = join.on.right.field;
    joinField = join.on.left.field;
  } else if (rightAlias === join.table.alias && leftAlias !== join.table.alias) {
    sourceAlias = leftAlias;
    sourceField = join.on.left.field;
    joinField = join.on.right.field;
  } else {
    return null;
  }

  const sourceRows = tables.get(sourceAlias);
  if (!sourceRows) return null;

  const sourceTable = [stmt.from, ...stmt.joins.map((candidate) => candidate.table)]
    .find((table) => effectiveTableAlias(table) === sourceAlias);
  const targetInfo = (await getFieldsCached(join.table.appId, client, cacheContext))
    .find((info) => info.code === fieldCodeForTypeLookup(join.table, joinField));
  const targetMeta = targetInfo
    ? materializedMetaFromFieldInfo(targetInfo, join.table.appId)
    : systemColumnMeta(joinField);
  let sourceMeta: MaterializedColumnMeta | undefined;
  if (sourceTable?.cteName !== null && sourceTable?.cteName !== undefined) {
    sourceMeta = materializedTables?.get(sourceTable.cteName)?.columnMeta?.get(sourceField);
  } else if (sourceTable) {
    const sourceInfo = (await getFieldsCached(sourceTable.appId, client, cacheContext))
      .find((info) => info.code === fieldCodeForTypeLookup(sourceTable, sourceField));
    sourceMeta = sourceInfo
      ? materializedMetaFromFieldInfo(sourceInfo, sourceTable.appId)
      : systemColumnMeta(sourceField);
  }

  const keys: string[] = [];
  let hasEmptyValue = false;
  for (const row of sourceRows) {
    const raw = row[sourceField]?.value;
    const txt = toScalarText(raw);
    if (raw === null || raw === undefined || txt.length === 0) hasEmptyValue = true;
    keys.push(txt);
  }
  const keyPlan = planJoinKeyPrefilter({
    fieldType: targetMeta?.fieldType,
    sourceSemantics: sourceMeta?.semantics,
    sourceRowCount: sourceRows.length,
    values: keys,
    hasEmptyValue,
    maxInKeys: JOIN_IN_MAX_KEYS,
  });
  if (keyPlan.kind === "EMPTY_SOURCE") return [];
  if (keyPlan.kind === "FALLBACK") {
    if (keyPlan.reason === "JOIN_KEY_LIMIT_EXCEEDED") {
      const count = new Set(keys).size;
      warnings.add(
        `JOINキーが ${count} 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 ${JOIN_IN_MAX_KEYS} 件）。`
      );
    }
    return null;
  }
  if (keyPlan.kind === "RANGE_CANDIDATE") return null;

  const prefilterQueries = buildJoinKeyPrefilterQueries(keyPlan, joinField, sqlQuote);
  if (prefilterQueries.length === 0) {
    warnings.add(
      `JOINキーが 0 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 ${JOIN_IN_MAX_KEYS} 件）。`
    );
    return null;
  }

  const fields = selectToFetchAllFields(stmt, join.table, plainGroupByPlan);
  const onTruncate = (max: number): void => {
    warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
    markLimitReached(client, join.table.appId);
  };

  const merged: KintoneRecord[] = [];
  const seen = new Set<string>();

  for (const joinKeyQuery of prefilterQueries) {
    const pushQueries = [
      pushDownCond !== null ? whereToKintone(pushDownCond) : "",
      additionalPushQuery,
    ].filter((query) => query !== "");
    const query = pushQueries.reduce(
      (combined, pushQuery) => `(${combined}) and (${pushQuery})`,
      joinKeyQuery
    );
    const resolved = await fetchRecordsForSharedPlan(client.getRecords, join.table.appId, query, fields, {
      parallel,
      maxRecords,
      onLimit,
      onTruncate,
    });
    for (const rec of resolved.records) {
      const key = `${rec["$id"]?.value ?? ""}:${JSON.stringify(rec)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(rec);
    }
  }

  return merged;
}

// ============================================================
// フィールド型マップ（DESCRIBE キャッシュ）
// ============================================================

const fieldTypeCache = new Map<string, Map<number, FieldTypeMap>>();
const optionOrderCache = new Map<string, Map<number, Map<string, Map<string, number>>>>();
const sortKindCache = new Map<string, Map<number, Map<string, "number" | "string">>>();
const fieldInfoCache = new Map<string, Map<number, Promise<KintoneFieldInfo[]>>>();
const processStatusCache = new Map<string, Map<number, Promise<KintoneProcessStatuses>>>();
const numberPrecisionCache = new Map<string, Map<number, Promise<NumberPrecision>>>();

function releaseMetadataCacheScope(cacheContext: string): void {
  fieldTypeCache.delete(cacheContext);
  optionOrderCache.delete(cacheContext);
  sortKindCache.delete(cacheContext);
  fieldInfoCache.delete(cacheContext);
  processStatusCache.delete(cacheContext);
  numberPrecisionCache.delete(cacheContext);
}

/** @internal テストで実行スコープの解放を観測するための内部状態。 */
export function __metadataCacheScopeCountsForTest(): Readonly<Record<
  "fieldType" | "optionOrder" | "sortKind" | "fieldInfo" | "processStatus" | "numberPrecision",
  number
>> {
  return {
    fieldType: fieldTypeCache.size,
    optionOrder: optionOrderCache.size,
    sortKind: sortKindCache.size,
    fieldInfo: fieldInfoCache.size,
    processStatus: processStatusCache.size,
    numberPrecision: numberPrecisionCache.size,
  };
}

function getScopedCacheValue<T>(
  root: Map<string, Map<number, T>>,
  cacheContext: string,
  appId: number
): T | undefined {
  return root.get(cacheContext)?.get(appId);
}

function setScopedCacheValue<T>(
  root: Map<string, Map<number, T>>,
  cacheContext: string,
  appId: number,
  value: T
): void {
  let scoped = root.get(cacheContext);
  if (!scoped) {
    scoped = new Map<number, T>();
    root.set(cacheContext, scoped);
  }
  scoped.set(appId, value);
}

async function getFieldsCached(appId: number, client: KintoneClient, cacheContext: string): Promise<KintoneFieldInfo[]> {
  const cached = getScopedCacheValue(fieldInfoCache, cacheContext, appId);
  if (cached) return cached;
  const loading = client.getFields(appId);
  setScopedCacheValue(fieldInfoCache, cacheContext, appId, loading);
  return loading;
}

async function getNumberPrecisionCached(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<NumberPrecision> {
  const cached = getScopedCacheValue(numberPrecisionCache, cacheContext, appId);
  if (cached) return cached;
  const loading = client.getNumberPrecision(appId);
  setScopedCacheValue(numberPrecisionCache, cacheContext, appId, loading);
  return loading;
}

async function getProcessStatusesCached(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<KintoneProcessStatuses> {
  const cached = getScopedCacheValue(processStatusCache, cacheContext, appId);
  if (cached) return cached;
  const loading = client.getProcessStatuses(appId);
  setScopedCacheValue(processStatusCache, cacheContext, appId, loading);
  return loading;
}

async function loadProcessStatusOrder(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<ReadonlyMap<string, number> | undefined> {
  const process = await getProcessStatusesCached(appId, client, cacheContext);
  return process.enable && process.states !== null
    ? new Map(process.states.map((state) => [state.name, state.index]))
    : undefined;
}

async function getFieldTypeMap(appId: number, client: KintoneClient, cacheContext: string): Promise<FieldTypeMap> {
  const cached = getScopedCacheValue(fieldTypeCache, cacheContext, appId);
  if (cached) return cached;
  const fields = await getFieldsCached(appId, client, cacheContext);
  const map: FieldTypeMap = new Map(fields.map((f) => [f.code, f.fieldType]));
  setScopedCacheValue(fieldTypeCache, cacheContext, appId, map);
  return map;
}

async function getOptionOrderMapByApp(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<Map<string, Map<string, number>>> {
  const cached = getScopedCacheValue(optionOrderCache, cacheContext, appId);
  if (cached) return cached;
  const fields = await getFieldsCached(appId, client, cacheContext);
  const map = new Map<string, Map<string, number>>();
  for (const field of fields) {
    if (!field.optionOrder) continue;
    const entries = Object.entries(field.optionOrder);
    if (entries.length === 0) continue;
    map.set(field.code, new Map(entries));
  }
  setScopedCacheValue(optionOrderCache, cacheContext, appId, map);
  return map;
}

/** 押し下げ時の実在検証用に、選択肢順マップをキー集合へ射影する。 */
async function getFieldOptionSetMapByApp(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<FieldOptionsMap> {
  const optionOrders = await getOptionOrderMapByApp(appId, client, cacheContext);
  return new Map(
    [...optionOrders.entries()].map(([fieldCode, order]) => [
      fieldCode,
      new Set(order.keys()),
    ])
  );
}

async function getSortKindMapByApp(
  appId: number,
  client: KintoneClient,
  cacheContext: string
): Promise<Map<string, "number" | "string">> {
  const cached = getScopedCacheValue(sortKindCache, cacheContext, appId);
  if (cached) return cached;
  const fields = await getFieldsCached(appId, client, cacheContext);
  const map = new Map<string, "number" | "string">();
  for (const field of fields) {
    if (!field.sortKind) continue;
    map.set(field.code, field.sortKind);
  }
  setScopedCacheValue(sortKindCache, cacheContext, appId, map);
  return map;
}

interface OrderByMeta {
  optionOrders: OptionOrderMap;
  sortKinds: FieldSortKindMap;
  /** Phase 2 で収集する共有意味型。比較器への切替は Phase 4 で行う。 */
  semantics: ReadonlyMap<string, ResolvedFieldSemantics>;
}

function orderByFieldNames(stmt: SelectStatement): string[] {
  const items: OrderByItem[] = [
    ...stmt.orderBy,
    ...stmt.columns.flatMap((column) => column.type === "WINDOW_COL" ? column.orderBy : []),
  ];
  return [...new Set(items.flatMap((item) =>
    item.key.type === "FIELD_NAME" ? [item.key.name] : []
  ))];
}

async function buildOrderSemanticsForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<ReadonlyMap<string, ResolvedFieldSemantics>> {
  const names = orderByFieldNames(stmt);
  if (names.length === 0) return new Map();

  const tables = [stmt.from, ...stmt.joins.map((join) => join.table)];
  const ambiguousFields = new Set<string>();
  const infosByApp = new Map<number, Map<string, KintoneFieldInfo>>(
    await Promise.all([...new Set(
      tables.filter((table) => table.cteName === null).map((table) => table.appId)
    )].map(async (appId) => {
      const infos = await getFieldsCached(appId, client, cacheContext);
      return [appId, new Map(infos.map((info) => [info.code, info]))] as const;
    }))
  );

  const resolveField = (ref: FieldRef): MaterializedColumnMeta | undefined => {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias === "_p" && stmt.from.subtableCode && stmt.from.cteName === null) {
        const info = infosByApp.get(stmt.from.appId)?.get(ref.field);
        return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : undefined;
      }
      const table = tables.find((candidate) => effectiveTableAlias(candidate) === ref.tableAlias);
      if (!table) return undefined;
      if (table.cteName !== null) return materializedTables?.get(table.cteName)?.columnMeta?.get(ref.field);
      const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      return info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
    }
    if (stmt.joins.length === 0) {
      if (stmt.from.cteName !== null) return materializedTables?.get(stmt.from.cteName)?.columnMeta?.get(ref.field);
      const info = infosByApp.get(stmt.from.appId)?.get(fieldCodeForTypeLookup(stmt.from, ref.field));
      return info ? materializedMetaFromFieldInfo(info, stmt.from.appId) : systemColumnMeta(ref.field);
    }
    const matches = tables.flatMap((table): MaterializedColumnMeta[] => {
      if (table.cteName !== null) {
        const materialized = materializedTables?.get(table.cteName);
        const meta = materialized?.columns.includes(ref.field) ? materialized.columnMeta?.get(ref.field) : undefined;
        return meta ? [meta] : [];
      }
      const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, ref.field));
      const meta = info ? materializedMetaFromFieldInfo(info, table.appId) : systemColumnMeta(ref.field);
      return meta ? [meta] : [];
    });
    if (matches.length > 1) ambiguousFields.add(ref.field);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const aliasSemantics = new Map<string, ResolvedFieldSemantics>();
  for (const column of stmt.columns) {
    if (!("alias" in column) || !column.alias) continue;
    let meta: MaterializedColumnMeta | undefined;
    if (column.type === "FIELD") meta = resolveField(aggregateFieldRef(column.field));
    else if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL") {
      meta = syntheticColumnMeta("number");
    } else if (column.type === "WINDOW_COL") {
      meta = inferWindowColumnMeta(column, resolveField);
    } else if (column.type === "GROUPING_COL") {
      meta = syntheticColumnMeta("number");
    } else if (column.type === "LITERAL_COL" || column.type === "SCALAR_VALUE_COL") meta = syntheticColumnMeta("string");
    else if (column.type === "STRFUNC_COL") meta = stringFunctionColumnMeta(column.expr);
    else if (column.type === "SCALAR_SUBQUERY_COL") meta = unknownStringColumnMeta();
    else if (column.type === "CASE_COL") {
      const candidates = column.expr.branches.map((branch) => caseResultColumnMeta(branch.result, resolveField));
      if (column.expr.elseResult) candidates.push(caseResultColumnMeta(column.expr.elseResult, resolveField));
      meta = mergeExpressionColumnMeta(candidates);
    } else if (column.type === "AGGREGATE") {
      if (column.func === "MIN" || column.func === "MAX" || column.func === "MODE") {
        if (column.arg.type !== "WILDCARD") meta = inferAggregateArgMeta(column.arg, resolveField);
      } else {
        meta = column.func === "GROUP_CONCAT" ? syntheticColumnMeta("string") : syntheticColumnMeta("number");
      }
    }
    if (meta?.semantics) aliasSemantics.set(column.alias, meta.semantics);
  }

  const result = new Map<string, ResolvedFieldSemantics>();
  for (const name of names) {
    const base = aliasSemantics.get(name) ?? resolveField(aggregateFieldRef(name))?.semantics;
    if (!base) {
      const ref = aggregateFieldRef(name);
      if (ref.tableAlias === null && ambiguousFields.has(ref.field)) {
        result.set(name, resolveFieldSemantics({ fieldType: "KSQL_AMBIGUOUS" }));
      }
      continue;
    }
    let semantics = base;
    if (base.fieldType === "STATUS" && base.source && stmt.orderMode !== "KINTONE_NATIVE") {
      const process = await getProcessStatusesCached(base.source.appId, client, cacheContext);
      if (process.enable && process.states !== null) {
        semantics = {
          ...base,
          optionOrder: new Map(process.states.map((state) => [state.name, state.index])),
        };
      }
    }
    result.set(name, semantics);
  }
  return result;
}

/**
 * ORDER BY の比較に使う選択肢順・ソート種別マップを取得する。
 * ORDER BY がない場合は applyOrderBy が即 return するため、
 * フィールド定義の取得自体をスキップする。
 */
async function buildOrderByMetaForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string,
  materializedTables?: ReadonlyMap<string, MaterializedTable>
): Promise<OrderByMeta> {
  const hasWindowOrderBy = stmt.columns.some(
    (column) => column.type === "WINDOW_COL" && column.orderBy.length > 0
  );
  if (stmt.orderBy.length === 0 && !hasWindowOrderBy) {
    return { optionOrders: new Map(), sortKinds: new Map(), semantics: new Map() };
  }
  const [optionOrders, sortKinds, semantics] = await Promise.all([
    buildOptionOrdersForSelect(stmt, client, cacheContext),
    buildSortKindsForSelect(stmt, client, cacheContext),
    buildOrderSemanticsForSelect(stmt, client, cacheContext, materializedTables),
  ]);
  return { optionOrders, sortKinds, semantics };
}

async function buildOptionOrdersForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<OptionOrderMap> {
  const optionOrders: OptionOrderMap = new Map();
  const tables: TableRef[] = [stmt.from, ...stmt.joins.map((j) => j.table)];
  const appLoaded = new Set<number>();

  for (const table of tables) {
    if (table.cteName != null) continue;
    if (appLoaded.has(table.appId)) continue;
    appLoaded.add(table.appId);

    const appMap = await getOptionOrderMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, orderMap] of appMap.entries()) {
      if (!optionOrders.has(fieldCode)) {
        optionOrders.set(fieldCode, orderMap);
      }
    }
  }

  for (const table of tables) {
    if (table.cteName != null || !table.alias) continue;
    const appMap = await getOptionOrderMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, orderMap] of appMap.entries()) {
      optionOrders.set(`${table.alias}.${fieldCode}`, orderMap);
    }
  }

  return optionOrders;
}

async function buildSortKindsForSelect(
  stmt: SelectStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<FieldSortKindMap> {
  const sortKinds: FieldSortKindMap = new Map();
  const tables: TableRef[] = [stmt.from, ...stmt.joins.map((j) => j.table)];
  const appLoaded = new Set<number>();

  for (const table of tables) {
    if (table.cteName != null) continue;
    if (appLoaded.has(table.appId)) continue;
    appLoaded.add(table.appId);

    const appMap = await getSortKindMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, sortKind] of appMap.entries()) {
      if (!sortKinds.has(fieldCode)) {
        sortKinds.set(fieldCode, sortKind);
      }
    }
  }

  for (const table of tables) {
    if (table.cteName != null || !table.alias) continue;
    const appMap = await getSortKindMapByApp(table.appId, client, cacheContext);
    for (const [fieldCode, sortKind] of appMap.entries()) {
      sortKinds.set(`${table.alias}.${fieldCode}`, sortKind);
    }
  }

  return sortKinds;
}

/**
 * INSERT SELECT / UPSERT SELECT: ProcessRow の文字列値を転送先フィールド型に応じて変換する。
 * 同型フィールド（USER_SELECT→USER_SELECT 等）は JSON パースして API 形式に変換。
 * 型不明の場合は文字列のまま渡す。
 */
function convertProcessRowValue(
  raw: unknown,
  dstFieldType: string | undefined
): string | string[] | Array<{ code: string }> {
  if (typeof raw !== "string") return raw as string[] | Array<{ code: string }>;
  const USER_TYPES  = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]);
  const ARRAY_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT"]);

  if (USER_TYPES.has(dstFieldType ?? "")) {
    if (raw === "") return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "object" && "code" in v)) {
        return (parsed as { code: string; name?: string }[]).map((u) => ({ code: u.code }));
      }
    } catch { /* fall through */ }
    return raw.split(",").map((c) => ({ code: c.trim() }));
  }

  if (ARRAY_TYPES.has(dstFieldType ?? "")) {
    if (raw === "") return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return (parsed as unknown[]).map(String);
    } catch { /* fall through */ }
    return raw.split(",").map((v) => v.trim());
  }

  return raw;
}

// ============================================================
// INSERT
// ============================================================

type ValidationStatement = InsertStatement | InsertSelectStatement | UpsertStatement | UpsertSelectStatement | UpdateStatement;
const NON_WRITABLE_FIELD_TYPES = new Set([
  "CALC", "RECORD_NUMBER", "CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME", "STATUS", "STATUS_ASSIGNEE", "CATEGORY", "REFERENCE_TABLE",
]);

function assertWritableTopLevelDmlFields(
  appId: number,
  targetFields: readonly string[],
  fieldInfos: readonly KintoneFieldInfo[]
): void {
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  for (const code of targetFields) {
    const info = infoByCode.get(code);
    if (!info) {
      throw new Error(`ArgumentError: DML target field ${code} does not exist.`);
    }
    if (info.inSubtable) {
      throw new Error(
        `ArgumentError: DML target field ${code} is inside a subtable. ` +
        `Use subtable DML syntax (for example, APP${appId}$テーブル).`
      );
    }
    if (info.writable === false || NON_WRITABLE_FIELD_TYPES.has(info.fieldType)) {
      throw new Error(`ArgumentError: DML target field ${code} is not writable (${info.fieldType}).`);
    }
  }
}

async function loadWritableTopLevelDmlFields(
  appId: number,
  targetFields: readonly string[],
  client: KintoneClient,
  cacheContext: string
): Promise<KintoneFieldInfo[]> {
  const fieldInfos = await getFieldsCached(appId, client, cacheContext);
  assertWritableTopLevelDmlFields(appId, targetFields, fieldInfos);
  return fieldInfos;
}

async function loadNumberPrecisionForTargets(
  appId: number,
  targetFields: readonly string[],
  fieldInfos: readonly KintoneFieldInfo[],
  client: KintoneClient,
  cacheContext: string
): Promise<NumberPrecision | undefined> {
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  return targetFields.some((code) => infoByCode.get(code)?.fieldType === "NUMBER")
    ? getNumberPrecisionCached(appId, client, cacheContext)
    : undefined;
}

function assertValidDmlRecords(
  records: readonly KintoneRecord[],
  targetFields: readonly string[],
  fieldInfos: readonly KintoneFieldInfo[],
  numberPrecision: NumberPrecision | undefined
): void {
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  records.forEach((record, rowIndex) => {
    for (const code of targetFields) {
      const info = infoByCode.get(code)!;
      const original = record[code]?.value ?? "";
      const result = validateAndNormalizeDmlValue(original, info, numberPrecision);
      if (!result.ok) {
        throw new Error(`DmlValidationError: ${result.code} ${result.message} (row=${rowIndex + 1}, field=${code})`);
      }
      const preserveCodes = ["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"].includes(info.fieldType)
        && Array.isArray(original) && original.every((item) => typeof item === "object" && item !== null && "code" in item);
      record[code] = { value: preserveCodes ? original : result.value };
    }
  });
}

/** Phase 13b read-only create preflight. The prepared POST batches stay below the writer boundary. */
async function executeApplyInsertValidation(
  stmt: InsertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  statementNumber: number
): Promise<DmlValidationResult> {
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const prepared = await prepareApplyInsert({
    statement: stmt,
    fieldInfos,
    dmlMaxRows: resolveApplyGuardLimit(options.dmlMaxRows, "dmlMaxRows", DEFAULT_APPLY_MAX_ROWS),
    dmlMaxSubtableRows: resolveApplyGuardLimit(
      options.dmlMaxSubtableRows,
      "dmlMaxSubtableRows",
      DEFAULT_APPLY_MAX_SUBTABLE_ROWS
    ),
    statementNumber,
    loadNumberPrecision: () => getNumberPrecisionCached(stmt.appId, client, cacheContext),
  });
  return materializePreparedApplyInsertValidation(stmt, prepared, fieldInfos);
}

async function executeApplyUpsertValidation(
  stmt: UpsertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  statementNumber: number
): Promise<DmlValidationResult> {
  const { fieldInfos, prepared } = await prepareApplyUpsertForExecution(
    stmt, client, options, cacheContext, statementNumber
  );
  return materializePreparedApplyUpsertValidation(stmt, prepared, fieldInfos);
}

async function prepareApplyUpsertForExecution(
  stmt: UpsertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  statementNumber: number
): Promise<{ fieldInfos: readonly KintoneFieldInfo[]; prepared: PreparedApplyUpsert }> {
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const fieldTypes = new Map(fieldInfos.map((field) => [field.code, field.fieldType]));
  const rowKeyValues = buildUpsertRowKeyValues(stmt);
  const seenSourceKeys = new Set<string>();
  for (const parts of rowKeyValues) {
    const key = upsertNormalizedKey(parts, stmt.keyFields.map((field) => fieldTypes.get(field) === "NUMBER"));
    if (seenSourceKeys.has(key)) {
      throw new Error("ERR_KEY_DUP_SOURCE: UPSERT ソース内でキーが重複しています");
    }
    seenSourceKeys.add(key);
  }
  const targetIndex = await resolveUpsertTargets(
    stmt.appId, stmt.keyFields, rowKeyValues, client, options, fieldTypes
  );
  const targetIds = rowKeyValues.map((parts) => lookupUpsertTarget(targetIndex, parts));
  const snapshotsById = new Map<number, KintoneRecord>();
  const updateIds = [...new Set(targetIds.filter((id): id is number => id !== undefined))];
  const snapshotFields = ["$id", "$revision", ...fieldInfos
    .filter((field) => !field.inSubtable && field.fieldType !== "FILE")
    .map((field) => field.code)];
  for (const ids of splitChunks(updateIds, 100)) {
    const response = await client.getRecords({
      app: stmt.appId,
      query: `$id in (${ids.join(",")}) limit 500`,
      fields: [...new Set(snapshotFields)],
    });
    for (const snapshot of response.records) {
      const id = Number(snapshot["$id"]?.value);
      if (Number.isSafeInteger(id) && id > 0) snapshotsById.set(id, snapshot);
    }
  }
  const matches: ApplyUpsertMatch[] = targetIds.map((targetId, sourceRowIndex) => ({
    sourceRowIndex,
    ...(targetId === undefined ? {} : { targetId, snapshot: snapshotsById.get(targetId) }),
  }));
  const prepared = await prepareApplyUpsert({
    statement: stmt,
    matches,
    fieldInfos,
    dmlMaxRows: resolveApplyGuardLimit(options.dmlMaxRows, "dmlMaxRows", DEFAULT_APPLY_MAX_ROWS),
    dmlMaxSubtableRows: resolveApplyGuardLimit(
      options.dmlMaxSubtableRows,
      "dmlMaxSubtableRows",
      DEFAULT_APPLY_MAX_SUBTABLE_ROWS
    ),
    statementNumber,
    loadNumberPrecision: () => getNumberPrecisionCached(stmt.appId, client, cacheContext),
  });
  return { fieldInfos, prepared };
}

async function executeApplyInsert(
  stmt: InsertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<InsertResult> {
  if (options.allowApplyMutation !== true) {
    throw new Error("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  }
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const prepared = await prepareApplyInsert({
    statement: stmt,
    fieldInfos,
    dmlMaxRows: resolveApplyGuardLimit(options.dmlMaxRows, "dmlMaxRows", DEFAULT_APPLY_MAX_ROWS),
    dmlMaxSubtableRows: resolveApplyGuardLimit(
      options.dmlMaxSubtableRows,
      "dmlMaxSubtableRows",
      DEFAULT_APPLY_MAX_SUBTABLE_ROWS
    ),
    loadNumberPrecision: () => getNumberPrecisionCached(stmt.appId, client, cacheContext),
  });
  const diagnostic = buildPreparedApplyInsertDiagnostic(prepared);

  if (options.confirm) {
    const ok = await options.confirm(prepared.guards.parentRows, "INSERT", {
      statementIndex: 0,
      statementCount: 1,
      statementType: "INSERT",
      targetAppId: stmt.appId,
      applyDetail: buildApplyConfirmDetailFromDiagnostic(diagnostic),
      applyDiagnostic: diagnostic,
    });
    if (!ok) throw new OperationCancelledError("INSERT", prepared.guards.parentRows);
  }

  const result = await executePreparedApplyInsert(prepared, client, diagnostic);
  return {
    ...result,
    diagnostic: withApplyDiagnosticProgress(diagnostic, result),
  };
}

async function executeApplyUpsert(
  stmt: UpsertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<UpsertResult> {
  if (options.allowApplyMutation !== true) {
    throw new Error("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  }
  const { prepared } = await prepareApplyUpsertForExecution(stmt, client, options, cacheContext, 1);
  const diagnostic = buildPreparedApplyUpsertDiagnostic(prepared);

  if (options.confirm) {
    const applyDetail = buildApplyConfirmDetailFromDiagnostic(diagnostic);
    const ok = await options.confirm(prepared.guards.parentRows, "UPDATE", {
      statementIndex: 0,
      statementCount: 1,
      statementType: "UPSERT",
      targetAppId: stmt.appId,
      applyDetail,
      applyDiagnostic: diagnostic,
    });
    if (!ok) throw new OperationCancelledError("UPDATE", prepared.guards.parentRows);
  }

  const result = await executePreparedApplyUpsert(prepared, client, diagnostic);
  return {
    type: "UPSERT",
    insertedCount: result.insertedCount,
    updatedCount: result.updatedCount,
    successfulChunks: result.successfulChunks,
    successfulParents: result.successfulParents,
    successfulInsertChunks: result.successfulInsertChunks,
    successfulUpdateChunks: result.successfulUpdateChunks,
    nonTransactional: result.nonTransactional,
    diagnostic: withApplyDiagnosticProgress(diagnostic, result),
  };
}

function mergeApplyConfirmTables(
  left: ApplyConfirmDetail["tables"],
  right: ApplyConfirmDetail["tables"]
): ApplyConfirmDetail["tables"] {
  const merged = new Map<string, ApplyConfirmDetail["tables"][number]>();
  for (const table of [...left, ...right]) {
    const current = merged.get(table.table);
    merged.set(table.table, current ? {
      table: table.table,
      patchRows: current.patchRows + table.patchRows,
      appendRows: current.appendRows + table.appendRows,
      removeRows: current.removeRows + table.removeRows,
    } : { ...table });
  }
  return [...merged.values()];
}

function buildApplyConfirmDetailFromDiagnostic(
  diagnostic: ApplyDiagnostic,
  chunked = true
): ApplyConfirmDetail {
  const insert = diagnostic.branches.find((branch) => branch.branch === "insert");
  const update = diagnostic.branches.find((branch) => branch.branch === "update");
  const allTargets = diagnostic.branches.flatMap((branch) => branch.targets);
  const tables = mergeApplyConfirmTables(
    insert ? applyDiagnosticTables(insert) : [],
    update ? applyDiagnosticTables(update) : []
  );
  const multiValues = mergeApplyDiagnosticMultiValues(allTargets);
  const parentRows = diagnostic.branches.reduce((sum, branch) => sum + (branch.parentRows ?? 0), 0);
  const changedSubtableRows = allTargets
    .filter((target) => target.targetKind === "SUBTABLE")
    .reduce((sum, target) => sum + (target.changedCount ?? 0), 0);
  const addedSubtableRows = tables.reduce((sum, table) => sum + table.appendRows, 0);
  const deletedRows = tables.reduce((sum, table) => sum + table.removeRows, 0);
  const result: ApplyConfirmDetail = {
    kind: diagnostic.statementKind === "UPDATE" ? "APPLY_PATCH"
      : diagnostic.statementKind === "INSERT" ? "APPLY_INSERT" : "APPLY_UPSERT",
    parentRows,
    changedSubtableRows,
    addedSubtableRows,
    tables,
    ...(multiValues.length > 0 ? { multiValues } : {}),
    deletedRows,
    deletedParentRows: diagnostic.branches.reduce((sum, branch) => sum + (branch.deletedParentRows ?? 0), 0),
    revisionRequired: diagnostic.branches.some((branch) => branch.guards.revisionRequired),
    irreversible: true,
    retryOnRevisionConflict: false,
    ...(chunked ? { nonTransactional: true as const, partialSuccessPossible: true as const } : {}),
  };
  if (diagnostic.statementKind === "INSERT" && insert) {
    return {
      ...result,
      insertedParentRows: insert.parentRows ?? 0,
      initialSubtableRows: insert.targets.filter((target) => target.targetKind === "SUBTABLE")
        .reduce((sum, target) => sum + (target.changedCount ?? 0), 0),
    };
  }
  if (diagnostic.statementKind === "UPSERT" && insert && update) {
    const insertTables = applyDiagnosticTables(insert);
    const updateTables = applyDiagnosticTables(update);
    return {
      ...result,
      insertedParentRows: insert.parentRows ?? 0,
      initialSubtableRows: insert.targets.filter((target) => target.targetKind === "SUBTABLE")
        .reduce((sum, target) => sum + (target.changedCount ?? 0), 0),
      updatedParentRows: update.parentRows ?? 0,
      applyBranches: {
        insert: {
          parentRows: insert.parentRows ?? 0,
          initialSubtableRows: insertTables.reduce((sum, table) => sum + table.appendRows, 0),
          tables: insertTables,
        },
        update: {
          parentRows: update.parentRows ?? 0,
          changedSubtableRows: update.targets.filter((target) => target.targetKind === "SUBTABLE")
            .reduce((sum, target) => sum + (target.changedCount ?? 0), 0),
          addedSubtableRows: updateTables.reduce((sum, table) => sum + table.appendRows, 0),
          tables: updateTables,
          deletedRows: updateTables.reduce((sum, table) => sum + table.removeRows, 0),
          deletedParentRows: update.deletedParentRows ?? 0,
        },
      },
    };
  }
  return result;
}

function applyDiagnosticTables(branch: ApplyDiagnosticBranch): ApplyConfirmDetail["tables"] {
  return branch.targets.filter((target) => target.targetKind === "SUBTABLE").map((target) => {
    const appendRows = operationCount(target, "APPEND");
    const removeRows = operationCount(target, "REMOVE");
    return {
      table: target.field,
      patchRows: (target.changedCount ?? 0) - appendRows - removeRows,
      appendRows,
      removeRows,
    };
  });
}

function operationCount(target: ApplyDiagnosticTarget, kind: ApplyDiagnostic["branches"][number]["targets"][number]["operations"][number]["kind"]): number {
  return target.operations.filter((operation) => operation.kind === kind)
    .reduce((sum, operation) => sum + (operation.count ?? 0), 0);
}

function mergeApplyDiagnosticMultiValues(
  targets: readonly ApplyDiagnosticTarget[]
): NonNullable<ApplyConfirmDetail["multiValues"]> {
  type Detail = NonNullable<ApplyConfirmDetail["multiValues"]>[number];
  const details = new Map<string, Detail>();
  for (const target of targets.filter((item) => item.targetKind === "MULTI_VALUE")) {
    const incoming: Detail = {
      field: target.field,
      fieldType: target.fieldType ?? "UNKNOWN",
      addedValues: operationCount(target, "ADD"),
      removedValues: operationCount(target, "REMOVE_VALUE"),
      changedValues: target.changedCount ?? 0,
      parents: (target.postImages ?? []).map((item) => ({ parentId: item.parentId, postImage: item.value })),
    };
    const current = details.get(target.field);
    details.set(target.field, current ? {
      ...current,
      addedValues: current.addedValues + incoming.addedValues,
      removedValues: current.removedValues + incoming.removedValues,
      changedValues: current.changedValues + incoming.changedValues,
      parents: [...current.parents, ...incoming.parents],
    } : incoming);
  }
  return [...details.values()];
}

async function executeDmlValidation(
  stmt: ValidationStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable> | undefined,
  statementNumber: number
): Promise<DmlValidationResult> {
  if (stmt.type === "INSERT" && stmt.applyBlocks?.length) {
    return executeApplyInsertValidation(stmt, client, options, cacheContext, statementNumber);
  }
  if (stmt.type === "UPSERT" && (stmt.onInsertApplyBlocks?.length || stmt.onUpdateApplyBlocks?.length)) {
    return executeApplyUpsertValidation(stmt, client, options, cacheContext, statementNumber);
  }
  if (stmt.type === "UPDATE" && stmt.applyBlocks?.length) {
    const result = await executeApplyPatchUpdate(
      stmt, client, options, cacheContext, statementNumber
    );
    if (result.type !== "VALIDATION") {
      throw new Error("InternalError: APPLY VALIDATE ONLY returned a mutation result.");
    }
    return result;
  }
  return (await prepareDmlValidation(stmt, client, options, cacheContext, tempTables, statementNumber)).result;
}

/** REJECT LIMIT 超過。診断結果を batch envelope へ残したまま fail-fast する。 */
export class RejectLimitExceededError extends Error {
  constructor(
    message: string,
    readonly diagnostic: DmlValidationResult
  ) {
    super(`RejectLimitExceededError: ${message}`);
    this.name = "RejectLimitExceededError";
  }
}

interface PreparedDmlValidation {
  result: DmlValidationResult;
  candidates: DmlValidationCandidate[];
  invalidRowNumbers: Set<number>;
  columnMeta: MaterializedColumnMetaMap;
}

async function prepareDmlValidation(
  stmt: ValidationStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable> | undefined,
  statementNumber: number,
  validateMissingCreateFields = true,
  includePreErrors = true
): Promise<PreparedDmlValidation> {
  const operation: ValidationOperation = stmt.type === "UPDATE" ? "UPDATE" : stmt.type.startsWith("UPSERT") ? "UPSERT" : "INSERT";
  const payloadFields = stmt.type === "UPDATE" ? ["$id", ...stmt.assignments.map((a) => a.field)] : [...stmt.fields];
  if (new Set(payloadFields).size !== payloadFields.length) {
    throw new Error("ArgumentError: DML target fields contain duplicates.");
  }
  const targetFields = stmt.type === "UPDATE" ? stmt.assignments.map((a) => a.field) : stmt.fields;
  const fieldInfos = await loadWritableTopLevelDmlFields(
    stmt.appId, targetFields, client, cacheContext
  );
  if (stmt.type === "UPDATE") {
    await assertDmlWhereCapability(stmt, client, cacheContext);
  }
  const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
  let numberPrecision = await loadNumberPrecisionForTargets(
    stmt.appId, targetFields, fieldInfos, client, cacheContext
  );

  const fieldIndex = buildPostImageFieldIndex(fieldInfos, payloadFields);
  const snapshotFields = collectDmlPrevalidationSnapshotFields(fieldIndex);
  const candidates = (await materializeValidationCandidates(
    stmt, operation, client, options, cacheContext, tempTables, infoByCode,
    stmt.type === "UPDATE" ? snapshotFields : undefined
  )).sort((left, right) => left.rowNumber - right.rowNumber);
  const updateCandidates = candidates.filter((candidate) => candidate.mode === "update");
  const productionUpdateLoader = stmt.type === "UPDATE"
    ? loadMaterializedUpdateSnapshots
    : stmt.type.startsWith("UPSERT")
      ? (input: DmlUpdateModeSnapshotLoadInput) => loadUpsertValidationSnapshots(
        input, client, options.maxRecords ?? 10_000
      )
      : undefined;
  const updateSnapshotLoader = options.loadUpdateModeSnapshots ?? productionUpdateLoader;
  const usePreparedPostImages = updateCandidates.length > 0 && updateSnapshotLoader !== undefined;
  const preparedPostImages = new Map<number, ReturnType<typeof validatePostImage>>();
  if (usePreparedPostImages) {
    materializeDmlUpdateModeSparseRecords(updateCandidates, targetFields, fieldInfos);
    const snapshots = await updateSnapshotLoader!({
      appId: stmt.appId,
      candidates: updateCandidates,
      fields: snapshotFields,
    });
    const postImages = new Map<number, KintoneRecord>();
    for (const candidate of updateCandidates) {
      if (candidate.targetId === undefined) {
        throw new Error(`InternalError: update-mode validation candidate has no targetId (row=${candidate.rowNumber}).`);
      }
      const snapshot = snapshots.get(candidate.targetId);
      if (!snapshot) {
        throw new Error(`InternalError: update-mode snapshot is missing for record ${candidate.targetId}.`);
      }
      const postImage = buildDmlValidationPostImage(snapshot, candidate.record ?? {});
      postImages.set(candidate.rowNumber, postImage);
    }
    if (numberPrecision === undefined && [...postImages.values()].some((record) =>
      postImageNeedsNumberPrecision(record, fieldIndex)
    )) {
      numberPrecision = await getNumberPrecisionCached(stmt.appId, client, cacheContext);
    }
    for (const candidate of updateCandidates) {
      const postImage = postImages.get(candidate.rowNumber);
      if (!postImage) throw new Error(`InternalError: validation post-image is missing for row ${candidate.rowNumber}.`);
      preparedPostImages.set(candidate.rowNumber, validatePostImage(
        postImage, fieldIndex, numberPrecision, statementNumber, candidate.rowNumber, operation
      ));
    }
  }
  const candidateValidation = validateDmlCandidates(
    candidates, operation, payloadFields, targetFields, fieldInfos, statementNumber, numberPrecision,
    stmt.checkGroups ?? [], validateMissingCreateFields, includePreErrors,
    { validateUpdateBuiltIns: !usePreparedPostImages }
  );
  let { errors, invalidRows, invalidRowNumbers } = candidateValidation;
  if (usePreparedPostImages) {
    const detailsByRow = new Map(candidateValidation.candidateResults.map((detail) => [detail.rowNumber, detail]));
    errors = [];
    invalidRowNumbers = new Set<number>();
    for (const candidate of candidates) {
      const detail = detailsByRow.get(candidate.rowNumber);
      if (!detail) throw new Error(`InternalError: validation detail is missing for row ${candidate.rowNumber}.`);
      if (candidate.mode === "create") {
        const candidateErrors = [...detail.preErrors, ...detail.builtInErrors, ...detail.checkErrors];
        errors.push(...candidateErrors);
        if (candidateErrors.length > 0) invalidRowNumbers.add(candidate.rowNumber);
        continue;
      }
      const postImageValidation = preparedPostImages.get(candidate.rowNumber);
      if (!postImageValidation) {
        throw new Error(`InternalError: prepared post-image validation is missing for row ${candidate.rowNumber}.`);
      }
      const merged = mergeDmlCandidateValidation({
        rowNumber: candidate.rowNumber,
        setFields: targetFields,
        normalizedPostImage: postImageValidation.normalizedRecord,
        preErrors: detail.preErrors,
        postImageErrors: postImageValidation.errors,
        checkErrors: detail.checkErrors,
      });
      candidate.record = merged.writeRecord;
      errors.push(...merged.errors);
      for (const rowNumber of merged.invalidRowNumbers) invalidRowNumbers.add(rowNumber);
    }
    invalidRows = invalidRowNumbers.size;
  }
  const columns = [...payloadFields, ...VALIDATION_META_COLUMNS];
  const result: DmlValidationResult = {
    type: "VALIDATION",
    operation,
    validatedRows: candidates.length,
    validRows: candidates.length - invalidRows,
    invalidRows,
    errorCount: errors.length,
    columns,
    errors,
    ...(stmt.validationErrorTable
      ? { errTable: stmt.validationErrorTable }
      : stmt.onErrorSkip && stmt.errorTable ? { errTable: stmt.errorTable } : {}),
  };
  const columnMeta = new Map<string, MaterializedColumnMeta>();
  for (const column of payloadFields) {
    if (column === "$id") {
      columnMeta.set(column, {
        sortKind: "number",
        fieldType: "RECORD_NUMBER",
        semantics: resolveFieldSemantics({ fieldType: "RECORD_NUMBER" }),
      });
      continue;
    }
    const info = infoByCode.get(column);
    if (info) columnMeta.set(column, materializedMetaFromFieldInfo(info, stmt.appId));
  }
  const numericValidationMeta = new Set<string>(["$err_statement", "$err_row"]);
  for (const column of VALIDATION_META_COLUMNS) {
    columnMeta.set(column, syntheticColumnMeta(numericValidationMeta.has(column) ? "number" : "string"));
  }
  materializedMetaByValidationResult.set(result, columnMeta);
  return { result, candidates, invalidRowNumbers, columnMeta };
}

async function executeOnErrorSkip(
  stmt: ValidationStatement & { onErrorSkip?: boolean; errorTable?: string; rejectLimit?: number | null },
  client: KintoneClient,
  options: BatchExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable>,
  statementNumber: number
): Promise<InsertResult | UpdateResult | UpsertResult> {
  const prepared = await prepareDmlValidation(
    stmt, client, options, cacheContext, tempTables, statementNumber
  );
  const errTable = stmt.errorTable;
  if (!errTable) throw new Error("ArgumentError: ON ERROR SKIP requires INTO #error_table.");

  appendValidationErrors(
    tempTables,
    errTable,
    prepared.result.columns,
    prepared.result.errors,
    options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
    prepared.columnMeta
  );

  const rejectLimit = stmt.rejectLimit ?? null;
  if (rejectLimit !== null && prepared.result.invalidRows > rejectLimit) {
    throw new RejectLimitExceededError(
      `rejected rows (${prepared.result.invalidRows}) exceed REJECT LIMIT (${rejectLimit}).`,
      prepared.result
    );
  }

  const valid = prepared.candidates.filter((candidate) => !prepared.invalidRowNumbers.has(candidate.rowNumber));
  if (options.confirm) {
    const operation = stmt.type.startsWith("INSERT") ? "INSERT" : "UPDATE";
    const ok = await options.confirm(valid.length, operation);
    if (!ok) throw new OperationCancelledError(operation, valid.length);
  }

  const common = {
    affectedRows: valid.length,
    skippedRows: prepared.result.invalidRows,
    rejectLimit,
    errTable,
  };

  if (stmt.type === "INSERT" || stmt.type === "INSERT_SELECT") {
    const createdIds: string[][] = [];
    for (let i = 0; i < valid.length; i += 100) {
      const response = await client.postRecords({ app: stmt.appId, records: valid.slice(i, i + 100).map((c) => c.record!) });
      createdIds.push(response.ids);
    }
    return { type: "INSERT", createdIds, insertedCount: createdIds.flat().length, ...common };
  }

  if (stmt.type === "UPDATE") {
    const updates = valid.map((candidate) => {
      if (candidate.targetId === undefined) throw new Error("InternalError: prepared UPDATE candidate has no targetId.");
      return { id: candidate.targetId, record: candidate.record! };
    });
    for (let i = 0; i < updates.length; i += 100) {
      await client.putRecords({ app: stmt.appId, records: updates.slice(i, i + 100) });
    }
    return { type: "UPDATE", updatedCount: updates.length, ...common };
  }

  const inserts = valid.filter((candidate) => candidate.mode === "create");
  const updates = valid.filter((candidate) => candidate.mode === "update").map((candidate) => {
    if (candidate.targetId === undefined) throw new Error("InternalError: prepared UPSERT candidate has no targetId.");
    return { id: candidate.targetId, record: candidate.record! };
  });
  let insertedCount = 0;
  for (let i = 0; i < inserts.length; i += 100) {
    const response = await client.postRecords({ app: stmt.appId, records: inserts.slice(i, i + 100).map((c) => c.record!) });
    insertedCount += response.ids.length;
  }
  for (let i = 0; i < updates.length; i += 100) {
    await client.putRecords({ app: stmt.appId, records: updates.slice(i, i + 100) });
  }
  return { type: "UPSERT", insertedCount, updatedCount: updates.length, ...common };
}

async function materializeValidationCandidates(
  stmt: ValidationStatement,
  operation: ValidationOperation,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables: Map<string, MaterializedTable> | undefined,
  infoByCode: Map<string, KintoneFieldInfo>,
  updateSnapshotFields?: readonly string[]
): Promise<DmlValidationCandidate[]> {
  if (stmt.type === "UPDATE") {
    return materializeUpdateValidationCandidates(
      stmt, client, options, cacheContext, tempTables, updateSnapshotFields
    );
  }

  let rows: unknown[][];
  let sourceRows: ProcessRow[] | undefined;
  let sourcePresence: readonly ReadonlySet<string>[] | undefined;
  let sourceRowErrors: MaterializedTable["importRowErrors"];
  let evaluationTypes: ReadonlyMap<string, string> | undefined;
  if (stmt.type === "INSERT" || stmt.type === "UPSERT") {
    assertInsertCheckRefs(stmt, stmt.fields);
    evaluationTypes = new Map(stmt.fields.map((field) => [field, infoByCode.get(field)?.fieldType ?? ""]));
    assertCheckComparisonTypes(stmt, evaluationTypes);
    rows = stmt.values.map((row) => row.map((value, i) =>
      value.type === "CASE_VALUE"
        ? evalCaseWhenValue(
          value.expr,
          {},
          infoByCode.get(stmt.fields[i])?.fieldType,
          statementEvaluationContext(options)
        )
        : value
    ));
  } else {
    const selectResult = await dmlSourceMaterializer.materialize(stmt, client, options, cacheContext, tempTables, [...infoByCode.values()]);
    const hasChecks = (stmt.checkGroups?.length ?? 0) > 0;
    if (selectResult.columns.length < stmt.fields.length || (!hasChecks && selectResult.columns.length !== stmt.fields.length)) {
      throw new Error(`SELECT の列数（${selectResult.columns.length}）と DML のフィールド数（${stmt.fields.length}）が一致しません`);
    }
    if (hasChecks && new Set(selectResult.columns).size !== selectResult.columns.length) {
      throw customCheckParseError("CHECK 付き DML ソース SELECT の出力名は一意である必要があります");
    }
    assertInsertCheckRefs(stmt, selectResult.columns);
    sourceRows = selectResult.rows;
    sourcePresence = selectResult.importPresence;
    sourceRowErrors = selectResult.importRowErrors;
    const meta = selectResult.columnMeta;
    evaluationTypes = new Map(selectResult.columns.map((column) => {
      const columnMeta = meta?.get(column);
      const type = columnMeta?.fieldType
        ?? (columnMeta?.semantics?.compareMode === "number" || columnMeta?.sortKind === "number" ? "NUMBER" : "SINGLE_LINE_TEXT");
      return [column, type];
    }));
    assertCheckComparisonTypes(stmt, evaluationTypes);
    rows = selectResult.rows.map((row) => selectResult.columns.map((column) => row[column] ?? ""));
  }

  const candidates = rows.map((values, index): DmlValidationCandidate => ({
    rowNumber: index + 1,
    operation,
    mode: "create",
    payload: new Map(stmt.fields.flatMap((field, i) =>
      sourcePresence && !sourcePresence[index]?.has(field) ? [] : [[field, values[i]]]
    )),
    preErrors: [...(sourceRowErrors?.[index] ?? [])],
    record: {},
    evaluationRow: sourceRows?.[index] ?? Object.fromEntries(
      stmt.fields.map((field, i) => [field, renderValidationValue(values[i])])
    ),
    evaluationFieldTypes: evaluationTypes,
  }));
  if (stmt.type !== "UPSERT" && stmt.type !== "UPSERT_SELECT") return candidates;

  for (const key of stmt.keyFields) {
    if (!stmt.fields.includes(key)) throw new Error(`ON DUPLICATE のキー「${key}」が UPSERT フィールドに含まれていません`);
  }
  const fieldTypes = new Map([...infoByCode].map(([code, info]) => [code, info.fieldType]));
  const rowKeys = candidates.map((candidate) => stmt.keyFields.map((key) => renderValidationValue(candidate.payload.get(key))));
  const numeric = stmt.keyFields.map((key) => fieldTypes.get(key) === "NUMBER");
  const keyCounts = new Map<string, number>();
  for (const parts of rowKeys) {
    const key = upsertNormalizedKey(parts, numeric);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const isImport = importSourceByDmlStatement.has(stmt);
  if (isImport && [...keyCounts.values()].some((count) => count > 1)) {
    throw new Error("ERR_KEY_DUP_SOURCE: UPSERT ソース内でキーが重複しています");
  }
  const targets = await resolveUpsertTargets(stmt.appId, stmt.keyFields, rowKeys, client, options, fieldTypes);
  candidates.forEach((candidate, index) => {
    const parts = rowKeys[index];
    const targetId = lookupUpsertTarget(targets, parts);
    candidate.mode = targetId === undefined ? "create" : "update";
    if (targetId !== undefined) candidate.targetId = targetId;
    stmt.keyFields.forEach((key, keyIndex) => {
      if (parts[keyIndex] === "") candidate.preErrors.push({ field: key, code: "ERR_KEY_EMPTY", message: `UPSERT キー ${key} は空にできません` });
    });
    if (!isImport && (keyCounts.get(upsertNormalizedKey(parts, numeric)) ?? 0) > 1) {
      candidate.preErrors.push({ field: stmt.keyFields[0], code: "ERR_KEY_DUP_SOURCE", message: "UPSERT ソース内でキーが重複しています" });
    }
  });
  return candidates;
}

function checkRefs(stmt: { checkGroups?: CheckGroup[] }): CheckFieldRef[] {
  return stmt.checkGroups ? collectCheckFieldRefs(stmt.checkGroups) : [];
}

function assertInsertCheckRefs(
  stmt: InsertStatement | InsertSelectStatement | UpsertStatement | UpsertSelectStatement,
  available: readonly string[]
): void {
  const names = new Set(available);
  for (const ref of checkRefs(stmt)) {
    if (ref.tableAlias !== null) {
      throw customCheckParseError(`CHECK のフィールド ${ref.tableAlias}.${ref.field} はこの評価行では修飾できません`);
    }
    if (!names.has(ref.field)) {
      throw customCheckParseError(`CHECK のフィールド ${ref.field} は評価行に存在しません`);
    }
  }
}

const CHECK_UNSUPPORTED_COMPARISON_TYPES = new Set([
  "CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "FILE",
  "KSQL_ARRAY",
]);

function assertCheckComparisonTypes(stmt: { checkGroups?: CheckGroup[] }, types: ReadonlyMap<string, string>): void {
  if (!stmt.checkGroups) return;
  for (const ref of collectCheckComparisonFieldRefs(stmt.checkGroups)) {
    const key = ref.tableAlias ? `${ref.tableAlias}.${ref.field}` : ref.field;
    const type = types.get(key) ?? types.get(ref.field);
    if (CHECK_UNSUPPORTED_COMPARISON_TYPES.has(type ?? "")) {
      throw customCheckParseError(`CHECK の比較では ${type} フィールド ${key} を使用できません`);
    }
  }
}

async function materializeUpdateValidationCandidates(
  stmt: UpdateStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>,
  snapshotFields?: readonly string[]
): Promise<DmlValidationCandidate[]> {
  if (stmt.from) {
    return materializeUpdateFromValidationCandidates(
      stmt, stmt.from, client, options, cacheContext, tempTables, snapshotFields
    );
  }
  await resolveSetSubqueries(stmt.assignments, client, options, cacheContext);
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  const checkTargetFields = assertUpdateCheckRefs(stmt, fieldTypes);
  assertCheckComparisonTypes(stmt, updateEvaluationTypes(fieldTypes, stmt.appId));
  let records: Array<{ id: number; record: KintoneRecord }>;
  let evaluationById = new Map<number, KintoneRecord>();
  let snapshotsById = new Map<number, KintoneRecord>();
  if (hasRowDependentAssignment(stmt)) {
    const getParams = updateToGetQueryForArith(stmt);
    const fields = [...new Set([...getParams.fields, ...checkTargetFields, ...(snapshotFields ?? [])])];
    const resolved = await fetchRecordsForSharedPlan(client.getRecords, getParams.app, getParams.query, fields, {
      maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1, onLimit: "error",
    });
    snapshotsById = indexDmlUpdateSnapshots(resolved.records);
    evaluationById = snapshotsById;
    records = updateToPutBatchesArith(
      stmt, resolved.records, fieldTypes, statementEvaluationContext(options)
    ).flatMap((batch) => batch.records);
  } else {
    const getParams = updateToGetQuery(stmt);
    if (checkTargetFields.length > 0) {
      const fields = [...new Set(["$id", ...checkTargetFields, ...(snapshotFields ?? [])])];
      const resolved = await fetchRecordsForSharedPlan(client.getRecords, getParams.app, getParams.query, fields, {
        maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1, onLimit: "error",
      });
      snapshotsById = indexDmlUpdateSnapshots(resolved.records);
      evaluationById = snapshotsById;
      records = updateToPutBatches(stmt, [...evaluationById.keys()], fieldTypes).flatMap((batch) => batch.records);
    } else {
      if (snapshotFields) {
        const resolved = await fetchRecordsForSharedPlan(
          client.getRecords, getParams.app, getParams.query, [...snapshotFields], {
            maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1, onLimit: "error",
          }
        );
        snapshotsById = indexDmlUpdateSnapshots(resolved.records);
        records = updateToPutBatches(stmt, [...snapshotsById.keys()], fieldTypes).flatMap((batch) => batch.records);
      } else {
        const resolved = await resolveDmlTargetIds(client.getRecords, getParams.app, getParams.query, {
          maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1,
        });
        records = updateToPutBatches(stmt, resolved.ids, fieldTypes).flatMap((batch) => batch.records);
      }
    }
  }
  return records.sort((a, b) => a.id - b.id).map((entry, index) => ({
    rowNumber: index + 1,
    operation: "UPDATE",
    mode: "update",
    payload: new Map<string, unknown>([["$id", String(entry.id)], ...stmt.assignments.map((a) => [a.field, entry.record[a.field]?.value ?? ""] as [string, unknown])]),
    preErrors: [],
    record: entry.record,
    targetId: entry.id,
    validationSnapshot: snapshotsById.get(entry.id),
    evaluationRow: updateEvaluationRow(evaluationById.get(entry.id), stmt.appId),
    evaluationFieldTypes: updateEvaluationTypes(fieldTypes, stmt.appId),
  }));
}

function indexDmlUpdateSnapshots(records: readonly KintoneRecord[]): Map<number, KintoneRecord> {
  const snapshots = new Map<number, KintoneRecord>();
  for (const record of records) {
    const rawId = record["$id"]?.value;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`InternalError: invalid $id in UPDATE validation snapshot: ${String(rawId)}.`);
    }
    if (snapshots.has(id)) {
      throw new Error(`InternalError: duplicate $id in UPDATE validation snapshot: ${id}.`);
    }
    snapshots.set(id, record);
  }
  return snapshots;
}

async function loadMaterializedUpdateSnapshots(
  input: DmlUpdateModeSnapshotLoadInput
): Promise<ReadonlyMap<number, KintoneRecord>> {
  const snapshots = new Map<number, KintoneRecord>();
  for (const candidate of input.candidates) {
    if (candidate.targetId === undefined || !candidate.validationSnapshot) {
      throw new Error(
        `InternalError: update-mode snapshot is missing for record ${String(candidate.targetId)}.`
      );
    }
    if (snapshots.has(candidate.targetId)) {
      throw new Error(`InternalError: duplicate UPDATE validation candidate target: ${candidate.targetId}.`);
    }
    snapshots.set(candidate.targetId, candidate.validationSnapshot);
  }
  return snapshots;
}

async function loadUpsertValidationSnapshots(
  input: DmlUpdateModeSnapshotLoadInput,
  client: KintoneClient,
  maxRecords: number
): Promise<ReadonlyMap<number, KintoneRecord>> {
  const updateIds = [...new Set(input.candidates.map((candidate) => {
    const id = candidate.targetId;
    if (!Number.isSafeInteger(id) || id === undefined || id <= 0) {
      throw new Error(
        `InternalError: invalid targetId in UPSERT validation candidate: ${String(id)}.`
      );
    }
    return id;
  }))];
  if (updateIds.length > maxRecords) {
    throw new FetchAllLimitError(
      `取得件数が上限（${maxRecords} 件）を超えました。WHERE 句で絞り込むか、maxRecords を引き上げてください。`
    );
  }

  const requestedIds = new Set(updateIds);
  const snapshots = new Map<number, KintoneRecord>();
  for (const ids of splitChunks(updateIds, 100)) {
    const response = await client.getRecords({
      app: input.appId,
      query: `$id in (${ids.join(",")}) limit 500`,
      fields: [...new Set(input.fields)],
    });
    for (const snapshot of response.records) {
      const rawId = snapshot["$id"]?.value;
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`InternalError: invalid $id in UPSERT validation snapshot: ${String(rawId)}.`);
      }
      if (!requestedIds.has(id)) {
        throw new Error(`InternalError: unexpected $id in UPSERT validation snapshot: ${id}.`);
      }
      if (snapshots.has(id)) {
        throw new Error(`InternalError: duplicate $id in UPSERT validation snapshot: ${id}.`);
      }
      snapshots.set(id, snapshot);
    }
  }
  for (const id of updateIds) {
    if (!snapshots.has(id)) {
      throw new Error(`InternalError: update-mode snapshot is missing for record ${id}.`);
    }
  }
  return snapshots;
}

function assertUpdateCheckRefs(stmt: UpdateStatement, targetTypes: ReadonlyMap<string, string>): string[] {
  if (stmt.from) return [];
  const fields = new Set<string>();
  for (const ref of checkRefs(stmt)) {
    if (ref.tableAlias !== null && ref.tableAlias.toLowerCase() !== `app${stmt.appId}`.toLowerCase()) {
      throw customCheckParseError(`CHECK の修飾子 ${ref.tableAlias} は更新先 APP${stmt.appId} ではありません`);
    }
    if (ref.field !== "$id" && !targetTypes.has(ref.field)) {
      throw customCheckParseError(`CHECK のターゲットフィールド ${ref.field} は存在しません`);
    }
    fields.add(ref.field);
  }
  return [...fields];
}

function updateEvaluationRow(record: KintoneRecord | undefined, appId: number): ProcessRow {
  if (!record) return {};
  const plain = flatten(record, null);
  return Object.fromEntries([
    ...Object.entries(plain),
    ...Object.entries(plain).map(([field, value]) => [`APP${appId}.${field}`, value] as const),
  ]);
}

function updateEvaluationTypes(types: ReadonlyMap<string, string>, appId: number): ReadonlyMap<string, string> {
  return new Map([
    ...types,
    ...[...types].map(([field, type]) => [`APP${appId}.${field}`, type] as const),
    ["$id", "RECORD_NUMBER"],
    [`APP${appId}.$id`, "RECORD_NUMBER"],
  ]);
}

async function materializeUpdateFromValidationCandidates(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>,
  snapshotFields?: readonly string[]
): Promise<DmlValidationCandidate[]> {
  const scope = await resolveUpdateFromCheckScope(stmt, from, client, cacheContext, tempTables);
  assertCheckComparisonTypes(stmt, scope.evaluationTypes);
  const matched = await resolveUpdateFromMatchedRecords(
    stmt, from, client, options, cacheContext, tempTables, snapshotFields
  );
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  const records = updateFromToPutBatches(
    stmt, matched, fieldTypes, statementEvaluationContext(options)
  ).flatMap((batch) => batch.records);
  const matchedById = new Map(matched.map((pair) => [Number(pair.target["$id"]?.value), pair]));
  const snapshotsById = snapshotFields
    ? indexDmlUpdateSnapshots(matched.map((pair) => pair.target))
    : new Map<number, KintoneRecord>();
  return records.sort((a, b) => a.id - b.id).map((entry, index) => ({
    rowNumber: index + 1, operation: "UPDATE", mode: "update",
    payload: new Map<string, unknown>([["$id", String(entry.id)], ...stmt.assignments.map((a) => [a.field, entry.record[a.field]?.value ?? ""] as [string, unknown])]),
    preErrors: [],
    record: entry.record,
    targetId: entry.id,
    validationSnapshot: snapshotsById.get(entry.id),
    evaluationRow: updateFromEvaluationRow(matchedById.get(entry.id), stmt.appId, from.alias),
    evaluationFieldTypes: scope.evaluationTypes,
  }));
}

const UPDATE_FROM_KEY_CHUNK_SIZE = UPSERT_IN_CHUNK_SIZE;
const UPDATE_FROM_UNSUPPORTED_SOURCE_TYPES = new Set([
  "CHECK_BOX",
  "MULTI_SELECT",
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT",
  "FILE",
]);

type UpdateFromJoinKeyKind = "id" | "string" | "number";

async function resolveUpdateFromMatchedRecords(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>,
  snapshotFields?: readonly string[]
): Promise<Array<{ target: KintoneRecord; source: ProcessRow }>> {
  const joinKind = await resolveUpdateFromTargetJoinKind(stmt, from, client, cacheContext);
  const checkScope = await resolveUpdateFromCheckScope(stmt, from, client, cacheContext, tempTables);
  const sourceFields = [...new Set(stmt.assignments
    .filter((a) => a.value.type === "SOURCE_FIELD")
    .map((a) => a.value.type === "SOURCE_FIELD" ? a.value.field : "").concat(checkScope.sourceFields))];
  const requiredSourceFields = [...new Set([from.joinKeyField, ...sourceFields])];
  const sourceRows = await loadUpdateFromSourceRows(
    from,
    requiredSourceFields,
    sourceFields,
    client,
    options,
    cacheContext,
    tempTables
  );

  const sourceByKey = new Map<string, ProcessRow>();
  const sourceQueryByKey = new Map<string, string>();
  for (const row of sourceRows) {
    if (!Object.prototype.hasOwnProperty.call(row, from.joinKeyField)) {
      throw new Error(`ArgumentError: UPDATE ... FROM source column ${from.joinKeyField} does not exist.`);
    }
    const key = normalizeUpdateFromJoinKey(row[from.joinKeyField], joinKind, "source");
    if (sourceByKey.has(key)) {
      throw new Error(`ArgumentError: UPDATE ... FROM source has multiple rows for normalized key ${key}.`);
    }
    sourceByKey.set(key, row);
    sourceQueryByKey.set(key, String(row[from.joinKeyField]).trim());
  }

  if (sourceByKey.size === 0) return [];

  const maxRecords = options.maxRecords ?? 10_000;
  const targetFields = [...new Set([
    ...collectUpdateFromTargetFields(stmt),
    ...checkScope.targetFields,
    ...(snapshotFields ?? []),
  ])];
  const filterQuery = from.targetFilter === null
    ? ""
    : updateToGetQuery({ ...stmt, from: null, where: from.targetFilter, checkGroups: undefined }).query;
  const targetRecords: KintoneRecord[] = [];
  const seenTargetIds = new Set<string>();
  let fetchedTargetCount = 0;
  for (const keys of splitChunks([...sourceQueryByKey.values()], UPDATE_FROM_KEY_CHUNK_SIZE)) {
    const keyQuery = `${from.targetJoinField} in (${keys.map(sqlQuote).join(",")})`;
    const query = filterQuery ? `(${keyQuery}) and (${filterQuery})` : keyQuery;
    const resolved = await fetchRecordsForSharedPlan(
      client.getRecords,
      stmt.appId,
      query,
      targetFields,
      { maxRecords, parallel: options.fetchParallel ?? 1, onLimit: "error" }
    );
    fetchedTargetCount += resolved.records.length;
    if (fetchedTargetCount > maxRecords) {
      throw new FetchAllLimitError(
        `取得件数が上限（${maxRecords} 件）を超えました。WHERE 句で絞り込むか、maxRecords を引き上げてください。`
      );
    }
    for (const record of resolved.records) {
      const id = record["$id"]?.value;
      if (typeof id !== "string" || id === "") {
        throw new Error("ArgumentError: UPDATE ... FROM target record does not contain a valid $id.");
      }
      // 64文字前方一致の過剰取得で同じ行が複数チャンクに現れても、PUT対象は1回にする。
      if (seenTargetIds.has(id)) continue;
      seenTargetIds.add(id);
      targetRecords.push(record);
    }
  }

  const matched: Array<{ target: KintoneRecord; source: ProcessRow }> = [];
  for (const target of targetRecords) {
    const raw = target[from.targetJoinField]?.value;
    const key = normalizeUpdateFromJoinKey(raw, joinKind, "target");
    if (key === null) continue;
    const source = sourceByKey.get(key);
    // SINGLE_LINE_TEXT の in は先頭64文字で過剰取得し得るため、全文一致しない行を除外する。
    if (source !== undefined) matched.push({ target, source });
  }
  return matched;
}

async function resolveUpdateFromTargetJoinKind(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  cacheContext: string
): Promise<UpdateFromJoinKeyKind> {
  if (from.targetJoinField === "$id") return "id";
  const info = (await getFieldsCached(stmt.appId, client, cacheContext))
    .find((field) => field.code === from.targetJoinField);
  if (!info) {
    throw new Error(`ArgumentError: UPDATE ... FROM target column ${from.targetJoinField} does not exist.`);
  }
  if (info.inSubtable || info.writable === false ||
      (info.fieldType !== "SINGLE_LINE_TEXT" && info.fieldType !== "NUMBER")) {
    throw new Error(
      `ArgumentError: UPDATE ... FROM does not support target join field type ${info.fieldType} (${from.targetJoinField}).`
    );
  }
  return info.fieldType === "NUMBER" ? "number" : "string";
}

async function loadUpdateFromSourceRows(
  from: NonNullable<UpdateStatement["from"]>,
  requiredSourceFields: string[],
  sourceValueFields: string[],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<ProcessRow[]> {
  if (from.cteName !== null) {
    const table = tempTables?.get(from.cteName);
    if (!table) throw new Error(`ArgumentError: temp table ${from.cteName} is not available.`);
    for (const field of requiredSourceFields) {
      if (!table.columns.includes(field)) {
        throw new Error(`ArgumentError: UPDATE ... FROM source column ${field} does not exist.`);
      }
    }
    return table.rows;
  }

  const sourceTypes = await getFieldTypeMap(from.appId, client, cacheContext);
  const joinType = from.joinKeyField === "$id" ? "RECORD_NUMBER" : sourceTypes.get(from.joinKeyField);
  if (joinType === undefined) {
    throw new Error(`ArgumentError: UPDATE ... FROM source column ${from.joinKeyField} does not exist.`);
  }
  if (from.joinKeyField !== "$id" && joinType !== "SINGLE_LINE_TEXT" && joinType !== "NUMBER") {
    throw new Error(
      `ArgumentError: UPDATE ... FROM does not support source join field type ${joinType} (${from.joinKeyField}).`
    );
  }
  for (const field of sourceValueFields) {
    if (field !== "$id" && !sourceTypes.has(field)) {
      throw new Error(`ArgumentError: UPDATE ... FROM source column ${field} does not exist.`);
    }
    const type = field === "$id" ? "RECORD_NUMBER" : sourceTypes.get(field);
    if (UPDATE_FROM_UNSUPPORTED_SOURCE_TYPES.has(type ?? "")) {
      throw new Error(`ArgumentError: UPDATE ... FROM does not support source field type ${type} (${field}).`);
    }
  }
  const resolved = await fetchRecordsForSharedPlan(
    client.getRecords,
    from.appId,
    "",
    requiredSourceFields,
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1, onLimit: "error" }
  );
  return resolved.records.map((record) => flatten(record, null));
}

function normalizeUpdateFromJoinKey(
  raw: unknown,
  kind: UpdateFromJoinKeyKind,
  side: "source"
): string;
function normalizeUpdateFromJoinKey(
  raw: unknown,
  kind: UpdateFromJoinKeyKind,
  side: "target"
): string | null;
function normalizeUpdateFromJoinKey(
  raw: unknown,
  kind: UpdateFromJoinKeyKind,
  side: "source" | "target"
): string | null {
  if (typeof raw !== "string") {
    throw new Error(`ArgumentError: UPDATE ... FROM ${side} key must be a scalar string: ${String(raw)}`);
  }
  if (kind === "string") {
    if (raw === "") {
      if (side === "target") return null;
      throw new Error("ArgumentError: UPDATE ... FROM source key must not be empty.");
    }
    return raw;
  }
  if (kind === "number" && side === "target" && raw === "") return null;
  if (kind === "id") {
    const text = raw.trim();
    const id = Number(text);
    if (text === "" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`ArgumentError: UPDATE ... FROM ${side} key must be a positive safe integer: ${raw}`);
    }
    return String(id);
  }
  const decimal = parseExactDecimal(raw);
  if (decimal === null) {
    throw new Error(`ArgumentError: UPDATE ... FROM ${side} key must be a finite decimal: ${raw}`);
  }
  return JSON.stringify(decimal);
}

async function executeCheckedPlainDml(
  stmt: InsertStatement | InsertSelectStatement,
  client: KintoneClient, options: ExecuteOptions, cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<InsertResult>;
async function executeCheckedPlainDml(
  stmt: UpdateStatement,
  client: KintoneClient, options: ExecuteOptions, cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateResult>;
async function executeCheckedPlainDml(
  stmt: UpsertStatement | UpsertSelectStatement,
  client: KintoneClient, options: ExecuteOptions, cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpsertResult>;
async function executeCheckedPlainDml(
  stmt: ValidationStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<InsertResult | UpdateResult | UpsertResult> {
  const prepared = await prepareDmlValidation(
    stmt, client, options, cacheContext, tempTables, 1, false, false
  );
  if (prepared.result.errors.length > 0) {
    const first = prepared.result.errors[0];
    throw new Error(
      `DmlValidationError: ${first["$err_code"]} ${first["$err_message"]} ` +
      `(row=${first["$err_row"]}, field=${first["$err_field"]})`
    );
  }
  const candidates = prepared.candidates;
  const confirmOperation = stmt.type.startsWith("INSERT") ? "INSERT" : "UPDATE";
  if (options.confirm && candidates.length > 0) {
    const ok = await options.confirm(candidates.length, confirmOperation);
    if (!ok) throw new OperationCancelledError(confirmOperation, candidates.length);
  }
  if (stmt.type === "INSERT" || stmt.type === "INSERT_SELECT") {
    const createdIds: string[][] = [];
    for (let i = 0; i < candidates.length; i += 100) {
      const response = await client.postRecords({ app: stmt.appId, records: candidates.slice(i, i + 100).map((c) => c.record!) });
      createdIds.push(response.ids);
    }
    return { type: "INSERT", createdIds, insertedCount: createdIds.flat().length };
  }
  if (stmt.type === "UPDATE") {
    const updates = candidates.map((candidate) => ({ id: candidate.targetId!, record: candidate.record! }));
    for (let i = 0; i < updates.length; i += 100) await client.putRecords({ app: stmt.appId, records: updates.slice(i, i + 100) });
    return { type: "UPDATE", updatedCount: updates.length };
  }
  const inserts = candidates.filter((candidate) => candidate.mode === "create");
  const updates = candidates.filter((candidate) => candidate.mode === "update").map((candidate) => ({ id: candidate.targetId!, record: candidate.record! }));
  let insertedCount = 0;
  for (let i = 0; i < inserts.length; i += 100) {
    const response = await client.postRecords({ app: stmt.appId, records: inserts.slice(i, i + 100).map((c) => c.record!) });
    insertedCount += response.ids.length;
  }
  for (let i = 0; i < updates.length; i += 100) await client.putRecords({ app: stmt.appId, records: updates.slice(i, i + 100) });
  return { type: "UPSERT", insertedCount, updatedCount: updates.length };
}

async function executeInsert(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "INSERT" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<InsertResult> {
  if (stmt.applyBlocks?.length) return executeApplyInsert(stmt, client, options, cacheContext);
  if (stmt.checkGroups?.length) return executeCheckedPlainDml(stmt, client, options, cacheContext);
  if (stmt.subtableCode) {
    return executeInsertSubtable(stmt, client, options, cacheContext);
  }
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const numberPrecision = await loadNumberPrecisionForTargets(stmt.appId, stmt.fields, fieldInfos, client, cacheContext);
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  const batches = insertToPostBatches(stmt, fieldTypes, statementEvaluationContext(options));
  assertValidDmlRecords(batches.flatMap((batch) => batch.records), stmt.fields, fieldInfos, numberPrecision);
  const createdIds: string[][] = [];

  for (const batch of batches) {
    const res = await client.postRecords(batch);
    createdIds.push(res.ids);
  }

  return {
    type: "INSERT",
    createdIds,
    insertedCount: createdIds.flat().length,
  };
}

// ============================================================
// INSERT INTO ... SELECT
// ============================================================

function importPlaceholderSelect(): SelectStatement {
  return {
    type: "SELECT", distinct: false, columns: [],
    from: { appId: 0, alias: null, cteName: NO_FROM_CTE_NAME }, joins: [], where: null,
    groupBy: [], having: null, orderMode: "CANONICAL", orderBy: [], limit: null, offset: null,
  };
}

async function executeImport(
  stmt: ImportStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<ExecuteResult> {
  // Capability/source existence is synchronous and deliberately precedes form API reads.
  if (!options.enableImport) throw new Error("UnsupportedError: IMPORT capability is disabled.");
  const handle = resolveImportSource(stmt.source.sourceName, options.importSource);
  if (stmt.targets?.some((target) => target.kind === "SUBTABLE")) {
    if (!stmt.validateOnly && !options.supportsImportConfirmDetail) {
      throw new Error("UnsupportedError: IMPORT subtable mutation requires a surface that displays parent/table replacement and deletion detail; use VALIDATE ONLY/EXPLAIN.");
    }
    if (stmt.source.kind === "CSV") {
      if (stmt.writeMode !== "UPDATE_RECORD_NUMBER" || !stmt.recordNumberSourceHeader) throw new Error("ArgumentError: CSV subtable replacement requires IMPORT UPDATE and MATCH RECORD NUMBER SOURCE.");
      if (!stmt.replaceSubtables?.length) throw new Error("ArgumentError: CSV subtable replacement requires REPLACE SUBTABLES (...).");
      const declared = new Set(stmt.targets.filter((target) => target.kind === "SUBTABLE").map((target) => target.subtableCode));
      if (stmt.replaceSubtables.some((table) => !declared.has(table))) throw new Error("ArgumentError: REPLACE SUBTABLES contains a table not declared in INTO.");
      for (const target of stmt.targets.filter((target) => target.kind === "SUBTABLE")) {
        if (!target.rowIdSourceHeader || !stmt.replaceSubtables.includes(target.subtableCode)) throw new Error(`ArgumentError: CSV subtable ${target.subtableCode} requires ROW ID SOURCE and REPLACE SUBTABLES declaration.`);
      }
    }
    if (stmt.validationErrorTable && !tempTables) throw new Error("ArgumentError: VALIDATE ONLY INTO requires a batch.");
    const targets = stmt.targets;
    const fieldInfos = await getFieldsCached(stmt.appId, client, cacheContext);
    const targetCodes = targets.flatMap((target) => target.kind === "FIELD" ? [target.field] : target.children);
    const numberPrecision = fieldInfos.some((info) => targetCodes.includes(info.code) && info.fieldType === "NUMBER")
      ? await getNumberPrecisionCached(stmt.appId, client, cacheContext)
      : undefined;
    const payload = await loadImportSource(handle, new Map());
    const materialized = stmt.source.kind === "JSON"
      ? materializeJsonImportRecords(stmt.source, payload, targets, options.maxRecords ?? 10_000)
      : materializeCliKintoneCsvImportRecords(stmt.source, payload, targets, stmt.replaceSubtables ?? [], options.maxRecords ?? 10_000, stmt.recordNumberSourceHeader);
    const operation = stmt.source.kind === "CSV" ? "UPDATE" : stmt.keyFields ? "UPSERT" : "INSERT";
    const prepared = prepareImportRecords(materialized, targets, fieldInfos, numberPrecision, operation);
    if (stmt.source.kind === "CSV") return executeCsvSubtableReplacement(stmt, materialized, prepared, fieldInfos, client, options, tempTables);
    assertImportRejectLimit(prepared, stmt.rejectLimit);
    const payloadFields = [...new Set(targets.flatMap((target) => target.kind === "FIELD" ? [target.field] : target.children))];
    const errors = materializeImportValidationErrors(prepared.errors, payloadFields);
    const columns = [...payloadFields, ...IMPORT_VALIDATION_META_COLUMNS];
    const invalidRows = prepared.invalidParentRows.size;
    const detail: ImportValidationDetail = {
      preflight: "ACTUAL_DATA",
      parents: { total: prepared.parents.length, valid: prepared.parents.length - invalidRows, invalid: invalidRows, mutationCandidates: prepared.parents.filter((parent) => parent.valid).length },
      tables: Object.fromEntries(prepared.tableCounts), writesKintone: false,
    };
    const result: DmlValidationResult = {
      type: "VALIDATION", operation, validatedRows: prepared.parents.length,
      validRows: prepared.parents.length - invalidRows, invalidRows, errorCount: errors.length,
      columns, errors, importDetail: detail,
      ...(stmt.validationErrorTable ? { errTable: stmt.validationErrorTable } : {}),
    };
    if (stmt.validationErrorTable && tempTables) appendValidationErrors(
      tempTables, stmt.validationErrorTable, columns, errors,
      (options as BatchExecuteOptions).tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS, new Map()
    );
    if (stmt.validateOnly) return result;

    assertJsonImportHasNoRowIds(materialized);
    if (prepared.errors.length > 0 && !stmt.onErrorSkip) {
      const first = prepared.errors[0];
      throw new Error(`DmlValidationError: ${first.code} ${first.message} (row=${first.parentRow}, field=${first.field})`);
    }
    if (stmt.onErrorSkip) {
      if (!tempTables || !stmt.errorTable) throw new Error("ArgumentError: ON ERROR SKIP requires a batch and INTO error table.");
      appendValidationErrors(
        tempTables, stmt.errorTable, columns, errors,
        (options as BatchExecuteOptions).tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS, new Map()
      );
    }
    const validParents = prepared.parents.filter((parent) => parent.valid);
    const fieldTypes = new Map(fieldInfos.map((info) => [info.code, info.fieldType]));
    const targetIds: Array<number | undefined> = validParents.map(() => undefined);
    if (stmt.keyFields) {
      for (const key of stmt.keyFields) if (!stmt.fields.includes(key)) {
        throw new Error(`ON DUPLICATE のキー「${key}」が UPSERT フィールドに含まれていません`);
      }
      const numeric = stmt.keyFields.map((key) => fieldTypes.get(key) === "NUMBER");
      const sourceKeys = new Set<string>();
      const rowKeys = validParents.map((parent) => stmt.keyFields!.map((key) => String(parent.top[key]?.value ?? "")));
      for (const parts of rowKeys) {
        const normalized = upsertNormalizedKey(parts, numeric);
        if (sourceKeys.has(normalized)) throw new Error("ERR_KEY_DUP_SOURCE: UPSERT ソース内でキーが重複しています");
        sourceKeys.add(normalized);
      }
      const targetsIndex = await resolveUpsertTargets(stmt.appId, stmt.keyFields, rowKeys, client, options, fieldTypes);
      rowKeys.forEach((parts, index) => { targetIds[index] = lookupUpsertTarget(targetsIndex, parts); });
    }
    const tableCodes = targets.filter((target) => target.kind === "SUBTABLE").map((target) => (target as { subtableCode: string }).subtableCode);
    const existingById = new Map<number, { id: number; revision?: number; record: Record<string, { value?: unknown }> }>();
    const updateIds = targetIds.filter((id): id is number => id !== undefined);
    for (const chunk of splitChunks([...new Set(updateIds)], 100)) {
      const response = await client.getRecords({ app: stmt.appId, query: `$id in (${chunk.join(",")}) limit 500`, fields: ["$id", "$revision", ...tableCodes] });
      for (const record of response.records) {
        const id = Number(record["$id"]?.value);
        const revision = Number(record["$revision"]?.value);
        if (Number.isFinite(id)) existingById.set(id, { id, ...(Number.isFinite(revision) ? { revision } : {}), record: record as Record<string, { value?: unknown }> });
      }
    }
    const writePlan = buildJsonSubtableWritePlan(validParents, targetIds, existingById);
    const importDetail: ImportConfirmDetail = {
      kind: "IMPORT_JSON_SUBTABLE", rowIdPolicy: "DROP_AND_RENUMBER_ALL",
      parentsToWrite: writePlan.length,
      insertedParents: writePlan.filter((parent) => parent.mode === "INSERT").length,
      updatedParents: writePlan.filter((parent) => parent.mode === "UPDATE").length,
      hasDeletes: writePlan.some((parent) => parent.tables.some((table) => table.deleteRows > 0)),
      parents: writePlan.map((parent) => ({ parentRow: parent.parentRow, mode: parent.mode, ...(parent.targetId === undefined ? {} : { targetId: parent.targetId }), tables: parent.tables })),
    };
    if (writePlan.length > 0) {
      if (!options.confirm) throw new Error("UnsupportedError: JSON IMPORT subtable mutation requires explicit confirmation detail approval.");
      const ok = await options.confirm(writePlan.length, stmt.keyFields ? "UPDATE" : "INSERT", { statementIndex: 0, statementCount: 1, statementType: "IMPORT", targetAppId: stmt.appId, importDetail });
      if (!ok) throw new OperationCancelledError(stmt.keyFields ? "UPDATE" : "INSERT", writePlan.length);
    }
    const toScalarMap = (record: KintoneRecord): Map<string, ImportScalarPayloadValue> => new Map(
      Object.entries(record).map(([code, field]) => [code, field.value as ImportScalarPayloadValue])
    );
    const payloadFor = (parent: typeof writePlan[number]) => buildJsonImportRecordPayload(
      toScalarMap(parent.top),
      new Map([...parent.subtables].map(([table, rows]) => [table, rows.map((row) => ({ values: toScalarMap(row) }))]))
    ) as unknown as KintoneRecord;
    const inserts = writePlan.filter((parent) => parent.mode === "INSERT");
    const updates = writePlan.filter((parent) => parent.mode === "UPDATE");
    const createdIds: string[][] = [];
    for (let i = 0; i < inserts.length; i += 100) {
      const response = await client.postRecords({ app: stmt.appId, records: inserts.slice(i, i + 100).map(payloadFor) });
      createdIds.push(response.ids);
    }
    for (let i = 0; i < updates.length; i += 100) await client.putRecords({
      app: stmt.appId,
      records: updates.slice(i, i + 100).map((parent) => ({ id: parent.targetId!, ...(parent.revision === undefined ? {} : { revision: parent.revision }), record: payloadFor(parent) })),
    });
    return stmt.keyFields
      ? { type: "UPSERT", insertedCount: createdIds.flat().length, updatedCount: updates.length, affectedRows: writePlan.length, skippedRows: prepared.invalidParentRows.size, rejectLimit: stmt.rejectLimit, ...(stmt.errorTable ? { errTable: stmt.errorTable } : {}), importDetail }
      : { type: "INSERT", createdIds, insertedCount: createdIds.flat().length, affectedRows: writePlan.length, skippedRows: prepared.invalidParentRows.size, rejectLimit: stmt.rejectLimit, ...(stmt.errorTable ? { errTable: stmt.errorTable } : {}), importDetail };
  }
  if (stmt.writeMode === "UPDATE_RECORD_NUMBER") {
    return executeImportRecordNumberUpdate(
      stmt as ImportStatement & { writeMode: "UPDATE_RECORD_NUMBER" },
      handle, client, options, cacheContext, tempTables
    );
  }
  const common = {
    appId: stmt.appId, fields: stmt.fields, select: importPlaceholderSelect(),
    validateOnly: stmt.validateOnly, validationErrorTable: stmt.validationErrorTable,
    onErrorSkip: stmt.onErrorSkip, errorTable: stmt.errorTable, rejectLimit: stmt.rejectLimit,
    checkGroups: stmt.checkGroups,
  };
  const generated: InsertSelectStatement | UpsertSelectStatement = stmt.keyFields
    ? { type: "UPSERT_SELECT", ...common, keyFields: stmt.keyFields }
    : { type: "INSERT_SELECT", ...common };
  const executionSource: ImportExecutionSource = { source: stmt.source, handle, cache: new Map() };
  importSourceByDmlStatement.set(generated, executionSource);
  const withAudit = <T extends ExecuteResult>(result: T): T => {
    if (executionSource.audit) Object.assign(result, { importAudit: executionSource.audit });
    return result;
  };
  if (generated.validateOnly) {
    if (generated.validationErrorTable && !tempTables) throw new Error("ArgumentError: VALIDATE ONLY INTO requires a batch.");
    const result = await executeDmlValidation(generated, client, { ...options, onLimitReached: "error" }, cacheContext, tempTables, 1);
    if (generated.validationErrorTable && tempTables) {
      appendValidationErrors(
        tempTables, generated.validationErrorTable, result.columns, result.errors,
        (options as BatchExecuteOptions).tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
        materializedMetaByValidationResult.get(result) ?? new Map()
      );
    }
    return withAudit(result);
  }
  if (generated.onErrorSkip) {
    if (!tempTables) throw new Error("ArgumentError: ON ERROR SKIP requires a batch.");
    const result = await (generated.type === "UPSERT_SELECT"
      ? executeOnErrorSkip(generated, client, options, cacheContext, tempTables, 1)
      : executeOnErrorSkip(generated, client, options, cacheContext, tempTables, 1));
    return withAudit(result);
  }
  const result = await (generated.type === "UPSERT_SELECT"
    ? executeUpsertSelect(generated, client, options, cacheContext, tempTables)
    : executeInsertSelect(generated, client, options, cacheContext, tempTables));
  return withAudit(result);
}


async function executeCsvSubtableReplacement(
  stmt: ImportStatement,
  materialized: MaterializedImportRecords,
  preparedBase: PreparedImportRecords,
  fieldInfos: readonly KintoneFieldInfo[],
  client: KintoneClient,
  options: ExecuteOptions,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateResult | DmlValidationResult> {
  if (!stmt.recordNumberSourceHeader || !stmt.replaceSubtables?.length) throw new Error("InternalError: incomplete CSV subtable replacement AST.");
  assertNoDuplicateCsvSubtableRowIds(materialized.records);
  const rawKeys = materialized.records.map((record) => record.recordNumberSourceValue ?? "");
  const keyPlan = preflightImportRecordNumbers(rawKeys, stmt.recordNumberSourceHeader);
  const tableCodes = [...stmt.replaceSubtables];
  const ownershipTableCodes = [...new Set(fieldInfos.filter((info) => !info.inSubtable && info.fieldType === "SUBTABLE").map((info) => info.code))];
  const allRecords = await fetchAll(client.getRecords, stmt.appId, "", ["$id", "$revision", ...ownershipTableCodes], {
    maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1, onLimit: "error",
  });
  const existingById = new Map<number, { id: number; revision?: number; record: KintoneRecord }>();
  const ownership = new Map<string, Array<{ parentId: number; table: string }>>();
  for (const record of allRecords) {
    const id = Number(record["$id"]?.value);
    const revision = Number(record["$revision"]?.value);
    if (!Number.isFinite(id)) continue;
    existingById.set(id, { id, ...(Number.isFinite(revision) ? { revision } : {}), record });
    for (const table of ownershipTableCodes) {
      const rows = record[table]?.value;
      if (!Array.isArray(rows)) continue;
      for (const row of rows as Array<{ id?: string }>) if (row.id) {
        const owners = ownership.get(row.id) ?? [];
        owners.push({ parentId: id, table }); ownership.set(row.id, owners);
      }
    }
  }
  const targetIds = keyPlan.normalized.map((key) => key === null ? undefined : Number(key));
  const parents = preparedBase.parents.map((parent, index) => {
    const errors: ImportValidationError[] = [...parent.errors];
    for (const error of keyPlan.errors[index]) errors.push({
      operation: "UPDATE", parentRow: parent.parentRow, field: error.field, code: error.code,
      message: error.message, sourceValues: materialized.records[index].top,
    });
    const targetId = targetIds[index];
    if (targetId !== undefined && !existingById.has(targetId)) errors.push({
      operation: "UPDATE", parentRow: parent.parentRow, field: stmt.recordNumberSourceHeader!,
      code: "ERR_RECORD_NUMBER_NOT_FOUND", message: `record number ${targetId} does not exist in APP${stmt.appId}`,
      sourceValues: materialized.records[index].top,
    });
    return { ...parent, valid: errors.length === 0, errors };
  });
  const initialPlan = buildCsvSubtableReplacementPlan(materialized.records, parents, targetIds, existingById, ownership);
  const planErrors = initialPlan.flatMap((parent) => [...parent.errors]);
  const invalidParentRows = new Set(initialPlan.filter((parent) => !parent.valid).map((parent) => parent.parentRow));
  const prepared: PreparedImportRecords = { ...preparedBase, parents, errors: planErrors, invalidParentRows };
  assertImportRejectLimit(prepared, stmt.rejectLimit);
  const validPlan = initialPlan.filter((parent) => parent.valid);
  const allTables = initialPlan.flatMap((parent) => parent.tables);
  const sum = (table: string, key: keyof CsvImportTableWriteDetail) => allTables.filter((item) => item.table === table).reduce((n, item) => n + Number(item[key]), 0);
  const tableDetail = Object.fromEntries(tableCodes.map((table) => [table, {
    existingRows: sum(table, "existingRows"), inputRows: sum(table, "inputRows"), updateRows: sum(table, "updateRows"),
    addRows: sum(table, "addRows"), deleteRows: sum(table, "deleteRows"), rowIdNotFound: sum(table, "rowIdNotFound"),
  }]));
  const importDetail: CsvImportConfirmDetail = {
    kind: "IMPORT_CSV_SUBTABLE_REPLACE", rowIdPolicy: "PRESERVE_EXISTING", parentsToWrite: validPlan.length,
    insertedParents: 0, updatedParents: validPlan.length,
    hasDeletes: validPlan.some((parent) => parent.tables.some((table) => table.deleteRows > 0)),
    totalDeleteRows: validPlan.flatMap((parent) => parent.tables).reduce((n, table) => n + table.deleteRows, 0),
    rowIdNotFound: validPlan.flatMap((parent) => parent.tables).reduce((n, table) => n + table.rowIdNotFound, 0),
    invalidParents: invalidParentRows.size,
    parents: validPlan.map((parent) => ({ parentRow: parent.parentRow, mode: "UPDATE", targetId: parent.targetId, tables: parent.tables })),
  };
  const payloadFields = [...new Set(stmt.targets!.flatMap((target) => target.kind === "FIELD" ? [target.field] : target.children))];
  const errors = materializeImportValidationErrors(planErrors, payloadFields);
  const columns = [...payloadFields, ...IMPORT_VALIDATION_META_COLUMNS];
  if (stmt.validateOnly) {
    if (stmt.validationErrorTable && !tempTables) throw new Error("ArgumentError: VALIDATE ONLY INTO requires a batch.");
    if (stmt.validationErrorTable && tempTables) appendValidationErrors(tempTables, stmt.validationErrorTable, columns, errors, (options as BatchExecuteOptions).tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS, new Map());
    return {
    type: "VALIDATION", operation: "UPDATE", validatedRows: parents.length, validRows: parents.length - invalidParentRows.size,
    invalidRows: invalidParentRows.size, errorCount: errors.length, columns, errors,
    ...(stmt.validationErrorTable ? { errTable: stmt.validationErrorTable } : {}),
    importDetail: { preflight: "ACTUAL_DATA", parents: { total: parents.length, valid: validPlan.length, invalid: invalidParentRows.size, mutationCandidates: validPlan.length }, tables: tableDetail, rowIdPolicy: "PRESERVE_EXISTING", rowIdNotFound: importDetail.rowIdNotFound, writesKintone: false },
    };
  }
  if (planErrors.length && !stmt.onErrorSkip) {
    const first = planErrors[0]; throw new Error(`DmlValidationError: ${first.code} ${first.message} (row=${first.parentRow}, field=${first.field})`);
  }
  if (stmt.onErrorSkip) {
    if (!tempTables || !stmt.errorTable) throw new Error("ArgumentError: ON ERROR SKIP requires a batch and INTO error table.");
    appendValidationErrors(tempTables, stmt.errorTable, columns, errors, (options as BatchExecuteOptions).tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS, new Map());
  }
  if (validPlan.length) {
    if (!options.supportsImportConfirmDetail || !options.confirm) throw new Error("UnsupportedError: CSV subtable replacement requires explicit rendered detail approval.");
    const ok = await options.confirm(validPlan.length, "UPDATE", { statementIndex: 0, statementCount: 1, statementType: "IMPORT", targetAppId: stmt.appId, importDetail });
    if (!ok) throw new OperationCancelledError("UPDATE", validPlan.length);
  }
  const scalarMap = (record: KintoneRecord): Map<string, ImportScalarPayloadValue> => new Map(Object.entries(record).map(([code, field]) => [code, field.value as ImportScalarPayloadValue]));
  for (const parent of validPlan) {
    const record = buildImportRecordPayload(scalarMap(parent.top), new Map([...parent.subtables].map(([table, rows]) => [table, rows.map((row) => ({ ...(row.rowId ? { rowId: row.rowId } : {}), values: scalarMap(row.record) }))])), "PRESERVE") as unknown as KintoneRecord;
    await client.putRecords({ app: stmt.appId, records: [{ id: parent.targetId, ...(parent.revision === undefined ? {} : { revision: parent.revision }), record }] });
  }
  return { type: "UPDATE", updatedCount: validPlan.length, affectedRows: validPlan.length, skippedRows: invalidParentRows.size, rejectLimit: stmt.rejectLimit, ...(stmt.errorTable ? { errTable: stmt.errorTable } : {}), importDetail };
}

async function executeImportRecordNumberUpdate(
  stmt: ImportStatement & { writeMode: "UPDATE_RECORD_NUMBER" },
  handle: ImportSourceHandle,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateResult | DmlValidationResult> {
  if (stmt.source.kind !== "CSV" || stmt.source.mappingMode !== "BY_NAME" || !stmt.recordNumberSourceHeader) {
    throw new Error("InternalError: invalid IMPORT UPDATE AST.");
  }
  if (new Set(stmt.fields).size !== stmt.fields.length) throw new Error("ArgumentError: DML target fields contain duplicates.");
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const numberPrecision = await loadNumberPrecisionForTargets(stmt.appId, stmt.fields, fieldInfos, client, cacheContext);
  const payload = await loadImportSource(handle, new Map());
  const sourceTable = materializeCsvDmlSource(
    stmt.source, payload, options.maxRecords ?? 10_000, stmt.fields, fieldInfos, stmt.recordNumberSourceHeader
  );
  const keyValues = sourceTable.recordNumberSourceValues;
  if (!keyValues) throw new Error("InternalError: record-number source values were not materialized.");
  // Global duplicate preflight deliberately precedes every record lookup and mutation.
  const keyPlan = preflightImportRecordNumbers(keyValues, stmt.recordNumberSourceHeader);

  const matchedIds = new Set<string>();
  const lookupKeys = [...new Set(keyPlan.normalized.filter((key): key is string => key !== null))];
  for (let i = 0; i < lookupKeys.length; i += 100) {
    const chunk = lookupKeys.slice(i, i + 100);
    const response = await client.getRecords({
      app: stmt.appId,
      query: `$id in (${chunk.join(",")}) limit 500`,
      fields: ["$id"],
    });
    for (const record of response.records) {
      const id = record["$id"]?.value;
      if (typeof id === "string" && id !== "") matchedIds.add(id.replace(/^0+(?=\d)/, ""));
    }
  }

  const infoByCode = new Map(fieldInfos.map((info) => [info.code, info]));
  const evaluationTypes = new Map(stmt.fields.map((field) => [field, infoByCode.get(field)?.fieldType ?? "SINGLE_LINE_TEXT"]));
  const candidates = sourceTable.rows.map((row, index): DmlValidationCandidate => {
    const key = keyPlan.normalized[index];
    const preErrors = [
      ...(sourceTable.importRowErrors?.[index] ?? []),
      ...keyPlan.errors[index],
    ];
    if (key !== null && !matchedIds.has(key)) preErrors.push({
      field: stmt.recordNumberSourceHeader!,
      code: "ERR_RECORD_NUMBER_NOT_FOUND",
      message: `record number ${key} does not exist in APP${stmt.appId}`,
    });
    return {
      rowNumber: index + 1,
      operation: "UPDATE",
      mode: "update",
      ...(key !== null && matchedIds.has(key) ? { targetId: Number(key) } : {}),
      payload: new Map([
        [stmt.recordNumberSourceHeader!, keyValues[index]],
        ...stmt.fields.map((field): [string, unknown] => [field, row[field] ?? ""]),
      ]),
      preErrors,
      record: {},
      evaluationRow: row,
      evaluationFieldTypes: evaluationTypes,
    };
  });
  const diagnosticFields = [stmt.recordNumberSourceHeader, ...stmt.fields];
  const validation = validateDmlCandidates(
    candidates, "UPDATE", diagnosticFields, stmt.fields, fieldInfos, 1, numberPrecision, stmt.checkGroups ?? [], false
  );
  const columns = [...diagnosticFields, ...VALIDATION_META_COLUMNS];
  const validationResult: DmlValidationResult = {
    type: "VALIDATION", operation: "UPDATE", validatedRows: candidates.length,
    validRows: candidates.length - validation.invalidRows,
    invalidRows: validation.invalidRows, errorCount: validation.errors.length,
    columns, errors: validation.errors,
    ...((stmt.validationErrorTable ?? stmt.errorTable) ? { errTable: (stmt.validationErrorTable ?? stmt.errorTable)! } : {}),
  };
  Object.assign(validationResult, { importAudit: sourceTable.importAudit });
  if (stmt.validateOnly) {
    if (stmt.validationErrorTable && !tempTables) throw new Error("ArgumentError: VALIDATE ONLY INTO requires a batch.");
    if (stmt.validationErrorTable && tempTables) appendValidationErrors(
      tempTables, stmt.validationErrorTable, columns, validation.errors,
      (options as BatchExecuteOptions).tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS, new Map()
    );
    return validationResult;
  }
  if (!stmt.onErrorSkip && validation.invalidRows > 0) {
    const first = validation.errors[0];
    throw new Error(`DmlValidationError: ${first.$err_code} ${first.$err_message} (row=${first.$err_row}, field=${first.$err_field})`);
  }
  if (stmt.onErrorSkip) {
    if (!tempTables || !stmt.errorTable) throw new Error("ArgumentError: ON ERROR SKIP requires a batch.");
    appendValidationErrors(
      tempTables, stmt.errorTable, columns, validation.errors,
      (options as BatchExecuteOptions).tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS, new Map()
    );
    if (stmt.rejectLimit != null && validation.invalidRows > stmt.rejectLimit) {
      throw new RejectLimitExceededError(
        `rejected rows (${validation.invalidRows}) exceed REJECT LIMIT (${stmt.rejectLimit}).`, validationResult
      );
    }
  }
  const valid = candidates.filter((candidate) => !validation.invalidRowNumbers.has(candidate.rowNumber));
  if (options.confirm) {
    const ok = await options.confirm(valid.length, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", valid.length);
  }
  const updates = valid.map((candidate) => ({ id: candidate.targetId!, record: candidate.record! }));
  for (let i = 0; i < updates.length; i += 100) {
    await client.putRecords({ app: stmt.appId, records: updates.slice(i, i + 100) });
  }
  const result: UpdateResult = {
    type: "UPDATE", updatedCount: updates.length,
    ...(stmt.onErrorSkip ? {
      affectedRows: updates.length, skippedRows: validation.invalidRows,
      rejectLimit: stmt.rejectLimit ?? null, errTable: stmt.errorTable,
    } : {}),
  };
  Object.assign(result, { insertedCount: 0, importAudit: sourceTable.importAudit });
  return result;
}

async function materializeDmlSource(
  stmt: InsertSelectStatement | UpsertSelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>,
  targetFields?: readonly KintoneFieldInfo[]
): Promise<MaterializedTable> {
  const imported = importSourceByDmlStatement.get(stmt);
  if (!imported) {
    const selected = tempTables && tempTables.size > 0
      ? await executeQueryWithCte(stmt.select, client, options, tempTables, cacheContext, true)
      : await executeSelect(stmt.select, client, options, cacheContext, undefined, true);
    return { rows: selected.rows, columns: selected.columns, columnMeta: materializedMetaBySelectResult.get(selected) };
  }
  const payload = await loadImportSource(imported.handle, imported.cache);
  const rowLimit = options.maxRecords ?? 10_000;
  // JSON は INTO 名対応。呼び出し元が渡す field infos はアプリ全体を含み得るため、
  // ここで stmt.fields（INTO 順）へ絞って materializer の列を確定する。
  const targetByCode = new Map((targetFields ?? []).map((info) => [info.code, info]));
  const jsonTargets = stmt.fields.map((code) => ({ code, fieldType: targetByCode.get(code)?.fieldType ?? "SINGLE_LINE_TEXT" }));
  const raw = imported.source.kind === "JSON"
    ? materializeJsonDmlSource(imported.source, payload, jsonTargets, rowLimit)
    : materializeCsvDmlSource(imported.source, payload, rowLimit, stmt.fields, targetFields);
  imported.audit = raw.importAudit;
  if (imported.source.kind === "JSON") return raw;
  if (!imported.source.projection) return raw;
  const projection = bindImportProjection(imported.source.projection);
  const tables = new Map(tempTables ?? []);
  tables.set(IMPORT_PROJECTION_SOURCE, raw);
  const selected = await executeQueryWithCte(projection, client, { ...options, onLimitReached: "error" }, tables, cacheContext, true);
  return { rows: selected.rows, columns: selected.columns, columnMeta: materializedMetaBySelectResult.get(selected) };
}

/** Shared INSERT/UPSERT/validation source boundary; exported to make route conformance observable. */
export const dmlSourceMaterializer = { materialize: materializeDmlSource };

function assertNoImportRowErrors(table: MaterializedTable): void {
  for (let rowIndex = 0; rowIndex < (table.importRowErrors?.length ?? 0); rowIndex++) {
    const first = table.importRowErrors?.[rowIndex]?.[0];
    if (first) {
      throw new Error(`DmlValidationError: ${first.code} ${first.message} (row=${rowIndex + 1}, field=${first.field})`);
    }
  }
}

async function executeInsertSelect(
  stmt: InsertSelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** バッチ実行時の一時テーブルストア（#name → 行＋列）。SELECT ソースの解決に使う */
  cteCache?: Map<string, MaterializedTable>
): Promise<InsertResult> {
  if (stmt.checkGroups?.length) return executeCheckedPlainDml(stmt, client, options, cacheContext, cteCache);
  // 1. 転送先フィールドを、ソース SELECT や confirm より前に検査する。
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const numberPrecision = await loadNumberPrecisionForTargets(stmt.appId, stmt.fields, fieldInfos, client, cacheContext);

  // 2. SELECT を実行して結果行を取得（一時テーブル参照があれば注入経路で解決）
  const sourceTable = await dmlSourceMaterializer.materialize(stmt, client, options, cacheContext, cteCache, fieldInfos);
  const { rows, columns } = sourceTable;
  assertNoImportRowErrors(sourceTable);

  // 3. 列数チェック
  if (columns.length !== stmt.fields.length) {
    const emptySourceHint = columns.length === 0 && rows.length === 0
      ? "。結果が 0 行のため列を特定できませんでした（SELECT * を空ソースに使うと列を決定できません。明示列で指定してください）"
      : "";
    throw new Error(
      `SELECT の列数（${columns.length}）と INSERT のフィールド数（${stmt.fields.length}）が一致しません${emptySourceHint}`
    );
  }

  // 4. 書き込み前に件数が確定するため、確認コールバック（dmlMaxRows ガード等）を通す
  if (options.confirm) {
    const ok = await options.confirm(rows.length, "INSERT");
    if (!ok) throw new OperationCancelledError("INSERT", rows.length);
  }

  // 5. 転送先フィールド型を取得（同型自動変換）
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  // 6. ProcessRow[] → KintoneRecord[]（列の位置で対応付け）
  const allRecords = rows.map((row, rowIndex) => {
    const record: KintoneRecord = {};
    stmt.fields.forEach((field, i) => {
      if (sourceTable.importPresence && !sourceTable.importPresence[rowIndex]?.has(field)) return;
      const raw = row[columns[i]] ?? "";
      record[field] = { value: convertProcessRowValue(raw, fieldTypes.get(field)) };
    });
    return record;
  });
  allRecords.forEach((record) => assertValidDmlRecords([record], stmt.fields.filter((field) => field in record), fieldInfos, numberPrecision));

  // 7. 100 件ごとに POST
  const createdIds: string[][] = [];
  for (let i = 0; i < allRecords.length; i += 100) {
    const batch = allRecords.slice(i, i + 100);
    const res = await client.postRecords({ app: stmt.appId, records: batch });
    createdIds.push(res.ids);
  }

  return {
    type: "INSERT",
    createdIds,
    insertedCount: createdIds.flat().length,
  };
}

// ============================================================
// UPDATE
// ============================================================

async function executeUpdate(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "UPDATE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateResult> {
  if (stmt.applyBlocks?.length) {
    return executeApplyPatchUpdate(stmt, client, options, cacheContext) as Promise<UpdateResult>;
  }
  if (stmt.checkGroups?.length && isConstantFalseWhere(stmt.where)) {
    const fieldInfos = await loadWritableTopLevelDmlFields(
      stmt.appId, stmt.assignments.map((assignment) => assignment.field), client, cacheContext
    );
    await loadNumberPrecisionForTargets(
      stmt.appId, stmt.assignments.map((assignment) => assignment.field), fieldInfos, client, cacheContext
    );
    const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
    assertUpdateCheckRefs(stmt, fieldTypes);
    assertCheckComparisonTypes(stmt, updateEvaluationTypes(fieldTypes, stmt.appId));
    await assertDmlWhereCapability(stmt, client, cacheContext);
    return { type: "UPDATE", updatedCount: 0 };
  }
  if (stmt.checkGroups?.length) return executeCheckedPlainDml(stmt, client, options, cacheContext, tempTables);
  if (stmt.subtableCode) {
    await assertDmlWhereCapability(stmt, client, cacheContext);
    return executeUpdateSubtable(stmt, client, options, cacheContext);
  }
  const fieldInfos = await loadWritableTopLevelDmlFields(
    stmt.appId, stmt.assignments.map((assignment) => assignment.field), client, cacheContext
  );
  const targetFields = stmt.assignments.map((assignment) => assignment.field);
  const numberPrecision = await loadNumberPrecisionForTargets(
    stmt.appId, targetFields, fieldInfos, client, cacheContext
  );
  await assertDmlWhereCapability(stmt, client, cacheContext);
  if (isConstantFalseWhere(stmt.where)) return { type: "UPDATE", updatedCount: 0 };
  if (stmt.from != null) {
    return executeUpdateFrom(stmt, stmt.from, client, options, cacheContext, tempTables);
  }
  const maxRecords = options.maxRecords ?? 10_000;

  // SET のスカラーサブクエリを事前実行して StringLiteral に差し替え
  await resolveSetSubqueries(stmt.assignments, client, options, cacheContext);

  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  if (hasRowDependentAssignment(stmt)) {
    // ── 算術式あり: 現在値を取得してから計算 → PUT ──
    // 1. $id + 参照フィールドを取得
    const getParams = updateToGetQueryForArith(stmt);
    const resolved = await fetchRecordsForSharedPlan(
      client.getRecords,
      getParams.app,
      getParams.query,
      [...getParams.fields],
      { maxRecords, parallel: options.fetchParallel ?? 1 }
    );
    const records = resolved.records;

    const batches = updateToPutBatchesArith(
      stmt, records, fieldTypes, statementEvaluationContext(options)
    );
    assertValidDmlRecords(batches.flatMap((batch) => batch.records.map((entry) => entry.record)), targetFields, fieldInfos, numberPrecision);

    // 2. 実行前確認
    if (options.confirm) {
      const ok = await options.confirm(records.length, "UPDATE");
      if (!ok) throw new OperationCancelledError("UPDATE", records.length);
    }

    // 3. レコードごとに算術計算して PUT
    for (const batch of batches) {
      await client.putRecords(batch);
    }

    return { type: "UPDATE", updatedCount: records.length };
  }

  // ── 通常パス: $id のみ取得 → 同一値で一括 PUT ──
  // 1. 対象レコードの $id を取得
  const getParams = updateToGetQuery(stmt);
  const resolved = await resolveDmlTargetIds(
    client.getRecords,
    getParams.app,
    getParams.query,
    { maxRecords, parallel: options.fetchParallel ?? 1 }
  );
  const ids = resolved.ids;

  const batches = updateToPutBatches(stmt, ids, fieldTypes);
  assertValidDmlRecords(batches.flatMap((batch) => batch.records.map((entry) => entry.record)), targetFields, fieldInfos, numberPrecision);

  // 2. 実行前確認
  if (options.confirm) {
    const ok = await options.confirm(ids.length, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", ids.length);
  }

  // 3. PUT バッチ実行
  for (const batch of batches) {
    await client.putRecords(batch);
  }

  return { type: "UPDATE", updatedCount: ids.length };
}

async function executeApplyPatchUpdate(
  stmt: UpdateStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  statementNumber = 1
): Promise<UpdateResult | DmlValidationResult> {
  if (!stmt.validateOnly && options.allowApplyMutation !== true) {
    throw new Error("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  }
  if (!isSinglePositiveRecordIdWhere(stmt.where)) {
    return executeMultipleParentApplyPreflight(stmt, client, options, cacheContext, statementNumber);
  }
  const fieldInfos = await getFieldsCached(stmt.appId, client, cacheContext);
  const metadata = resolveApplyPatchMetadata(stmt, fieldInfos);
  const fields = collectApplySnapshotFields(stmt, fieldInfos);
  const requestedId = getApplyParentId(stmt);
  const response = await client.getRecords({
    app: stmt.appId,
    query: `$id = ${requestedId} limit 2`,
    fields: [...fields],
  });
  if (response.records.length === 0) {
    throw new Error(`ArgumentError: APPLY parent $id ${requestedId} does not exist.`);
  }
  if (response.records.length !== 1) {
    throw new Error(`ArgumentError: APPLY parent $id ${requestedId} returned multiple records.`);
  }
  const actualId = Number(response.records[0]["$id"]?.value);
  if (actualId !== requestedId) {
    throw new Error(`ArgumentError: APPLY snapshot $id ${actualId} does not match requested $id ${requestedId}.`);
  }
  requireRevision(response.records[0]);
  const plan = buildApplyPatchPlan({
    statement: stmt,
    snapshot: response.records[0],
    fieldInfos,
    metadata,
    evaluationContext: statementEvaluationContext(options),
  });
  const fieldIndex = buildPostImageFieldIndex(
    fieldInfos,
    stmt.assignments.map((assignment) => assignment.field)
  );
  const numberPrecision = postImageNeedsNumberPrecision(plan.postImage, fieldIndex)
    ? await getNumberPrecisionCached(stmt.appId, client, cacheContext)
    : undefined;
  const validation = validatePostImage(plan.postImage, fieldIndex, numberPrecision, statementNumber);
  if (!stmt.validateOnly && validation.errorCount > 0) {
    throw new Error(`ArgumentError: APPLY post-image validation failed: ${JSON.stringify({
      columns: validation.columns,
      errors: validation.errors,
    })}`);
  }

  const dmlMaxRows = resolveApplyGuardLimit(options.dmlMaxRows, "dmlMaxRows", DEFAULT_APPLY_MAX_ROWS);
  const dmlMaxSubtableRows = resolveApplyGuardLimit(options.dmlMaxSubtableRows, "dmlMaxSubtableRows", DEFAULT_APPLY_MAX_SUBTABLE_ROWS);
  const wouldExceed = plan.parentRows > dmlMaxRows
    || plan.changedSubtableRows > dmlMaxSubtableRows;
  if (stmt.validateOnly) {
    const diagnostic = buildPreparedApplyUpdateDiagnostic({
      plans: [plan],
      records: applyPatchPlanToKintone(plan).records,
      validations: [],
      guards: {
        revisionRequired: true,
        parentRows: plan.parentRows,
        dmlMaxRows,
        subtableRows: plan.changedSubtableRows,
        dmlMaxSubtableRows,
        wouldExceed,
      },
    });
    const result: DmlValidationResult = {
      type: "VALIDATION",
      operation: "UPDATE",
      validatedRows: 1,
      validRows: validation.invalidRows === 0 ? 1 : 0,
      invalidRows: validation.invalidRows === 0 ? 0 : 1,
      errorCount: validation.errorCount,
      columns: [...validation.columns],
      errors: validation.errors,
      ...(stmt.validationErrorTable ? { errTable: stmt.validationErrorTable } : {}),
      apply: applyValidationDetailsFromBranch(diagnostic.branches[0]),
      guards: applyGuardFromDiagnosticBranch(diagnostic.branches[0]),
      deletedRows: {
        total: plan.tables.reduce((sum, table) => sum + table.deletedRows, 0),
        parentRows: plan.tables.some((table) => table.deletedRows > 0) ? 1 : 0,
      },
      diagnostic,
    };
    materializedMetaByValidationResult.set(
      result,
      applyValidationColumnMeta(validation.columns, fieldInfos, stmt.appId)
    );
    return result;
  }
  if (plan.parentRows > dmlMaxRows) {
    throw new Error(`ArgumentError: APPLY parent rows (${plan.parentRows}) exceed dmlMaxRows (${dmlMaxRows}).`);
  }
  if (plan.changedSubtableRows > dmlMaxSubtableRows) {
    throw new Error(
      `ArgumentError: APPLY changed subtable rows (${plan.changedSubtableRows}) exceed dmlMaxSubtableRows (${dmlMaxSubtableRows}).`
    );
  }

  const normalizedPlan = normalizeApplyPatchPlan(plan, validation.normalizedRecord);
  const putParams = applyPatchPlanToKintone(normalizedPlan);
  const diagnostic = buildPreparedApplyUpdateDiagnostic({
    plans: [normalizedPlan],
    records: putParams.records,
    validations: [],
    guards: {
      revisionRequired: true,
      parentRows: plan.parentRows,
      dmlMaxRows,
      subtableRows: plan.changedSubtableRows,
      dmlMaxSubtableRows,
      wouldExceed,
    },
  });
  if (options.confirm) {
    const applyDetail = buildApplyConfirmDetailFromDiagnostic(diagnostic, false);
    const ok = await options.confirm(plan.parentRows, "UPDATE", {
      statementIndex: 0,
      statementCount: 1,
      statementType: "UPDATE",
      targetAppId: stmt.appId,
      applyDetail,
      applyDiagnostic: diagnostic,
    });
    if (!ok) throw new OperationCancelledError("UPDATE", plan.parentRows);
  }

  await client.putRecords(putParams);
  return {
    type: "UPDATE",
    updatedCount: plan.parentRows,
    diagnostic: withApplyDiagnosticProgress(diagnostic, {
      successfulChunks: 1,
      successfulParents: plan.parentRows,
    }),
  };
}

async function executeMultipleParentApplyPreflight(
  stmt: UpdateStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  statementNumber: number
): Promise<UpdateResult | DmlValidationResult> {
  const dmlMaxRows = resolveApplyGuardLimit(options.dmlMaxRows, "dmlMaxRows", DEFAULT_APPLY_MAX_ROWS);
  const dmlMaxSubtableRows = resolveApplyGuardLimit(
    options.dmlMaxSubtableRows,
    "dmlMaxSubtableRows",
    DEFAULT_APPLY_MAX_SUBTABLE_ROWS
  );
  const fieldInfos = await getFieldsCached(stmt.appId, client, cacheContext);
  const metadata = resolveApplyPatchMetadata(stmt, fieldInfos);
  let snapshots: KintoneRecord[];
  if (usesApplyParentResidualSelection(stmt)) {
    snapshots = await selectApplyParentSnapshots(stmt, client, options, fieldInfos, cacheContext);
  } else {
    // B47 carve-out 外は従来の exact DML converter と dmlMaxRows+1 早期停止を維持する。
    const fields = collectApplySnapshotFields(stmt, fieldInfos);
    const baseQuery = updateToGetQuery(stmt).query;
    const detectionLimit = dmlMaxRows + 1;
    snapshots = await fetchAll(client.getRecords, stmt.appId, baseQuery, [...fields], {
      pageSize: Math.min(500, detectionLimit),
      parallel: options.fetchParallel ?? 1,
      maxRecords: detectionLimit,
      stopAfter: detectionLimit,
      onLimit: "error",
    });
  }
  if (!stmt.validateOnly && snapshots.length > dmlMaxRows) {
    throw new Error(`ArgumentError: APPLY parent rows (${snapshots.length}) exceed dmlMaxRows (${dmlMaxRows}).`);
  }

  const prepared = await prepareApplyPatchWrite({
    statement: stmt,
    snapshots,
    fieldInfos,
    metadata,
    dmlMaxRows,
    dmlMaxSubtableRows,
    statementNumber,
    loadNumberPrecision: () => getNumberPrecisionCached(stmt.appId, client, cacheContext),
  });
  if (stmt.validateOnly) return materializePreparedApplyValidation(stmt, prepared, fieldInfos);

  assertApplyPublicWriteScope("phase15b", stmt);
  const diagnostic = buildPreparedApplyUpdateDiagnostic(prepared);
  if (options.confirm) {
    const applyDetail = buildApplyConfirmDetailFromDiagnostic(diagnostic);
    const ok = await options.confirm(prepared.guards.parentRows, "UPDATE", {
      statementIndex: 0,
      statementCount: 1,
      statementType: "UPDATE",
      targetAppId: stmt.appId,
      applyDetail,
      applyDiagnostic: diagnostic,
    });
    if (!ok) throw new OperationCancelledError("UPDATE", prepared.guards.parentRows);
  }
  const result = await executePreparedApplyWrite(prepared, client, diagnostic);
  return { ...result, diagnostic: withApplyDiagnosticProgress(diagnostic, result) };
}

/** B47 carve-out: APPLY 複数親 UPDATE の親 WHERE に LIKE / KLIKE がある場合だけ。 */
function usesApplyParentResidualSelection(stmt: UpdateStatement): boolean {
  return (stmt.applyBlocks?.length ?? 0) > 0
    && !isSinglePositiveRecordIdWhere(stmt.where)
    && (whereHasLike(stmt.where) || whereHasKlike(stmt.where));
}

function isApplyParentKlikeStatement(stmt: Statement): boolean {
  const target = stmt.type === "EXPLAIN" ? stmt.query : stmt;
  return target.type === "UPDATE"
    && usesApplyParentResidualSelection(target)
    && whereHasKlike(target.where);
}

const APPLY_PARENT_UNAPPLIED_KLIKE_ERROR =
  "APPLY 複数親 UPDATE の親 WHERE に、安全に押し下げられない KLIKE / NOT KLIKE があります。\n" +
  "OR / NOT 配下など native query へ完全に適用できない KLIKE は使用できません。\n" +
  "WHERE を AND の安全な KLIKE 条件へ書き換えるか、SELECT で確認した $id IN (...) を使用してください。";

function assertApplyParentKlikesFullyApplied(plan: ApplyParentSelectionPlan): void {
  if (plan.unappliedKlikes.length > 0) throw new Error(`UnsupportedError: ${APPLY_PARENT_UNAPPLIED_KLIKE_ERROR}`);
}

async function selectApplyParentSnapshots(
  stmt: UpdateStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  fieldInfos: readonly KintoneFieldInfo[],
  cacheContext: string
): Promise<KintoneRecord[]> {
  const topLevelInfos = fieldInfos.filter((field) => !field.inSubtable);
  const infoByCode = new Map(topLevelInfos.map((field) => [field.code, field]));
  const fieldTypes = new Map(topLevelInfos.map((field) => [field.code, field.fieldType]));
  const fieldOptions = new Map(topLevelInfos.flatMap((field) => field.optionOrder
    ? [[field.code, new Set(Object.keys(field.optionOrder))] as const]
    : []));
  const selectionPlan = buildApplyParentSelectionPlan(stmt.where, { fieldTypes, fieldOptions });
  // native 適用集合の完全性を records API より前に確定する。一部適用での継続は禁止。
  assertApplyParentKlikesFullyApplied(selectionPlan);
  const prefilterQuery = selectionPlan.prefilter === null
    ? ""
    : whereToKintone(selectionPlan.prefilter);

  // updateToGetQuery は LIKE を拒否する通常 DML 用 converter のため、この route では呼ばない。
  // APPLY/SET 用 snapshot に加え、元 WHERE の残余評価に必要な親フィールドを必ず取得する。
  const fields = new Set(collectApplySnapshotFields(stmt, fieldInfos));
  for (const field of collectApplyParentWhereFields(stmt.where)) fields.add(field);
  const resolvers = await buildApplyParentFieldResolvers(
    stmt.appId,
    stmt.where,
    infoByCode,
    client,
    cacheContext
  );
  const candidates = await fetchAll(
    client.getRecords,
    stmt.appId,
    prefilterQuery,
    [...fields],
    {
      maxRecords: options.maxRecords ?? 10_000,
      parallel: options.fetchParallel ?? 1,
      onLimit: "error",
      // prefilter は target の超集合なので stopAfter を設定せず最後まで取得する。
    }
  );

  return candidates
    .map((snapshot) => ({ snapshot, row: flatten(snapshot, null) }))
    .filter(({ row }) => evalWhere(
      stmt.where,
      row,
      resolvers.fieldTypeResolver,
      selectionPlan.appliedKlikes,
      resolvers.fieldSemanticsResolver,
      statementEvaluationContext(options)
    ))
    .map(({ snapshot }) => snapshot);
}

function collectApplyParentWhereFields(where: WhereExpr): string[] {
  return collectValidateWhereFields(where);
}

interface ApplyParentFieldResolvers {
  readonly fieldTypeResolver: FieldTypeResolver;
  readonly fieldSemanticsResolver: FieldSemanticsResolver;
}

/** SELECT と同じ field type / field semantics primitive を単一の親物理 app に結ぶ。 */
async function buildApplyParentFieldResolvers(
  appId: number,
  where: WhereExpr,
  infoByCode: ReadonlyMap<string, KintoneFieldInfo>,
  client: KintoneClient,
  cacheContext: string
): Promise<ApplyParentFieldResolvers> {
  const orderedFields = collectOrderedWhereFields(where);
  const needsStatusOrder = [...orderedFields].some((field) => infoByCode.get(field)?.fieldType === "STATUS");
  const statusOrder = needsStatusOrder
    ? await loadProcessStatusOrder(appId, client, cacheContext)
    : undefined;

  const fieldTypeResolver: FieldTypeResolver = (field) => field.field === "$id"
    ? "NUMBER"
    : infoByCode.get(field.field)?.fieldType;
  const fieldSemanticsResolver: FieldSemanticsResolver = (field) => {
    if (field.field === "$id") {
      return withFieldSemanticSource(resolveFieldSemantics({ fieldType: "__ID__" }), appId, "$id");
    }
    const info = infoByCode.get(field.field);
    if (!info) return undefined;
    const base = info.semantics ?? resolveFieldSemantics(info);
    const semantics = info.fieldType === "STATUS" && statusOrder
      ? { ...base, optionOrder: statusOrder }
      : base;
    return withFieldSemanticSource(semantics, appId, info.code);
  };
  return { fieldTypeResolver, fieldSemanticsResolver };
}

function collectOrderedWhereFields(where: WhereExpr): ReadonlySet<string> {
  const fields = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (value["type"] === "SELECT") return;
    if (value["type"] === "BINARY" && [">", "<", ">=", "<="].includes(String(value["op"]))) {
      const left = value["left"] as Record<string, unknown> | undefined;
      if (left?.["type"] === "FIELD" && typeof left["field"] === "string") {
        fields.add(left["field"] as string);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(where);
  return fields;
}

function materializePreparedApplyInsertValidation(
  stmt: InsertStatement,
  prepared: PreparedApplyInsert,
  fieldInfos: readonly KintoneFieldInfo[]
): DmlValidationResult {
  const errors = prepared.validations.flatMap((validation) => validation.errors);
  const invalidRows = prepared.validations.reduce(
    (sum, validation) => sum + (validation.invalidRows > 0 ? 1 : 0),
    0
  );
  const columns = prepared.validations[0]?.columns
    ? [...prepared.validations[0].columns]
    : [
      ...buildPostImageFieldIndex(fieldInfos, stmt.fields).payloadFields,
      ...POST_IMAGE_VALIDATION_SUFFIX_COLUMNS,
    ];
  const parentRows = prepared.guards.parentRows;
  const diagnostic = buildPreparedApplyInsertDiagnostic(prepared);
  const branch = diagnostic.branches[0];
  const result: DmlValidationResult = {
    type: "VALIDATION",
    operation: "INSERT",
    validatedRows: parentRows,
    validRows: parentRows - invalidRows,
    invalidRows,
    errorCount: errors.length,
    columns,
    errors,
    ...(stmt.validationErrorTable ? { errTable: stmt.validationErrorTable } : {}),
    apply: applyValidationDetailsFromBranch(branch),
    guards: applyGuardFromDiagnosticBranch(branch),
    deletedRows: { total: 0, parentRows: 0 },
    diagnostic,
  };
  materializedMetaByValidationResult.set(result, applyValidationColumnMeta(columns, fieldInfos, stmt.appId));
  return result;
}

function materializePreparedApplyValidation(
  stmt: UpdateStatement,
  prepared: PreparedApplyWrite,
  fieldInfos: readonly KintoneFieldInfo[]
): DmlValidationResult {
  const validations = prepared.validations;
  const errors = validations.flatMap((validation) => validation.errors);
  const invalidRows = validations.reduce((sum, validation) => sum + (validation.invalidRows > 0 ? 1 : 0), 0);
  const columns = validations[0]?.columns
    ? [...validations[0].columns]
    : [
      ...buildPostImageFieldIndex(fieldInfos, stmt.assignments.map((assignment) => assignment.field)).payloadFields,
      ...POST_IMAGE_VALIDATION_SUFFIX_COLUMNS,
    ];
  const diagnostic = buildPreparedApplyUpdateDiagnostic(prepared);
  const result: DmlValidationResult = {
    type: "VALIDATION",
    operation: "UPDATE",
    validatedRows: prepared.guards.parentRows,
    validRows: prepared.guards.parentRows - invalidRows,
    invalidRows,
    errorCount: errors.length,
    columns,
    errors,
    ...(stmt.validationErrorTable ? { errTable: stmt.validationErrorTable } : {}),
    apply: applyValidationDetailsFromBranch(diagnostic.branches[0]),
    guards: applyGuardFromDiagnosticBranch(diagnostic.branches[0]),
    deletedRows: {
      total: prepared.plans.reduce(
        (sum, plan) => sum + plan.tables.reduce((tableSum, table) => tableSum + table.deletedRows, 0),
        0
      ),
      parentRows: prepared.plans.filter((plan) => plan.tables.some((table) => table.deletedRows > 0)).length,
    },
    diagnostic,
  };
  materializedMetaByValidationResult.set(result, applyValidationColumnMeta(columns, fieldInfos, stmt.appId));
  return result;
}

function materializePreparedApplyUpsertValidation(
  stmt: UpsertStatement,
  prepared: PreparedApplyUpsert,
  fieldInfos: readonly KintoneFieldInfo[]
): DmlValidationResult {
  const createErrors = prepared.create.validations.flatMap((validation) => validation.errors);
  const updateErrors = prepared.update.validations.flatMap((validation) => validation.errors);
  const errors: ProcessRow[] = [...createErrors, ...updateErrors].map((error): ProcessRow => ({
    ...error,
    $err_operation: "UPSERT",
  }));
  const invalidRows = new Set(errors.map((error) => error.$err_row)).size;
  const columns = prepared.create.validations[0]?.columns
    ?? prepared.update.validations[0]?.columns
    ?? [
      ...buildPostImageFieldIndex(fieldInfos, stmt.fields).payloadFields,
      ...POST_IMAGE_VALIDATION_SUFFIX_COLUMNS,
    ];
  const diagnostic = buildPreparedApplyUpsertDiagnostic(prepared);
  const insertBranch = diagnostic.branches.find((branch) => branch.branch === "insert")!;
  const updateBranch = diagnostic.branches.find((branch) => branch.branch === "update")!;
  const createApply = applyValidationDetailsFromBranch(insertBranch);
  const updateApply = applyValidationDetailsFromBranch(updateBranch);
  const result: DmlValidationResult = {
    type: "VALIDATION",
    operation: "UPSERT",
    validatedRows: prepared.guards.parentRows,
    validRows: prepared.guards.parentRows - invalidRows,
    invalidRows,
    errorCount: errors.length,
    columns: [...columns],
    errors,
    ...(stmt.validationErrorTable ? { errTable: stmt.validationErrorTable } : {}),
    apply: [...createApply, ...updateApply],
    guards: {
      revisionRequired: prepared.guards.revisionRequired,
      parentRows: prepared.guards.parentRows,
      dmlMaxRows: prepared.guards.dmlMaxRows,
      subtableRows: prepared.guards.subtableRows,
      dmlMaxSubtableRows: prepared.guards.dmlMaxSubtableRows,
      wouldExceed: prepared.guards.wouldExceed,
    },
    applyBranches: {
      create: { apply: createApply, guards: applyGuardFromDiagnosticBranch(insertBranch) },
      update: { apply: updateApply, guards: applyGuardFromDiagnosticBranch(updateBranch) },
    },
    deletedRows: {
      total: prepared.update.plans.reduce(
        (sum, plan) => sum + plan.tables.reduce((tableSum, table) => tableSum + table.deletedRows, 0), 0
      ),
      parentRows: prepared.update.plans.filter((plan) => plan.tables.some((table) => table.deletedRows > 0)).length,
    },
    diagnostic,
  };
  materializedMetaByValidationResult.set(result, applyValidationColumnMeta([...columns], fieldInfos, stmt.appId));
  return result;
}

function applyValidationDetailsFromBranch(branch: ApplyDiagnosticBranch): ApplyValidationDetail[] {
  return branch.targets.map((target): ApplyValidationDetail => {
    const operations = target.operations.map((operation) => ({
      kind: operation.kind,
      ...(operation.matchedRows !== undefined ? { matchedRows: operation.matchedRows ?? undefined } : {}),
      ...(operation.changedRows !== undefined ? { changedRows: operation.changedRows ?? undefined } : {}),
      ...(operation.addedRows !== undefined ? { addedRows: operation.addedRows ?? undefined } : {}),
      ...(operation.removedRows !== undefined ? { removedRows: operation.removedRows ?? undefined } : {}),
      ...(operation.value !== undefined ? { value: operation.value } : {}),
      ...(operation.changed !== undefined ? { changed: operation.changed } : {}),
    }));
    if (target.targetKind === "SUBTABLE") {
      return {
        field: target.field,
        operations,
        changedSubtableRows: target.changedCount ?? 0,
        deletedRows: operationCount(target, "REMOVE"),
      };
    }
    return {
      field: target.field,
      operations,
      changedSubtableRows: 0,
      deletedRows: 0,
      multiValue: {
        fieldType: target.fieldType ?? "UNKNOWN",
        addedValues: operationCount(target, "ADD"),
        removedValues: operationCount(target, "REMOVE_VALUE"),
        changedValues: target.changedCount ?? 0,
        postImages: target.postImages ?? [],
      },
    };
  });
}

function applyGuardFromDiagnosticBranch(branch: ApplyDiagnosticBranch): ApplyGuardDetail {
  if (branch.guards.parentRows === null || branch.guards.subtableRows === null
      || branch.guards.wouldExceed === null) {
    throw new Error("InternalError: runtime APPLY diagnostic guard contains unknown counts.");
  }
  return {
    revisionRequired: branch.guards.revisionRequired,
    parentRows: branch.guards.parentRows,
    dmlMaxRows: branch.guards.dmlMaxRows,
    subtableRows: branch.guards.subtableRows,
    dmlMaxSubtableRows: branch.guards.dmlMaxSubtableRows,
    wouldExceed: branch.guards.wouldExceed,
  };
}

/** APPLY 二重ガードの既定値。親は最大100件、子は1年分の日次データ（366行）を
 *  1文で扱えるよう 500 とする（kintone 制約由来ではなく、修復用途を賄う保守的既定）。 */
export const DEFAULT_APPLY_MAX_ROWS = 100;
export const DEFAULT_APPLY_MAX_SUBTABLE_ROWS = 500;

function resolveApplyGuardLimit(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`ArgumentError: ${name} must be a positive safe integer.`);
  }
  return resolved;
}

function applyValidationColumnMeta(
  columns: readonly string[],
  fieldInfos: readonly KintoneFieldInfo[],
  appId: number
): MaterializedColumnMetaMap {
  const fields = new Map(fieldInfos.filter((field) => !field.inSubtable).map((field) => [field.code, field]));
  const numericMeta = new Set(["$id", "$err_statement", "$err_row"]);
  const meta = new Map<string, MaterializedColumnMeta>();
  for (const column of columns) {
    if (column === "$id") {
      meta.set(column, {
        sortKind: "number",
        fieldType: "RECORD_NUMBER",
        semantics: resolveFieldSemantics({ fieldType: "RECORD_NUMBER" }),
      });
      continue;
    }
    const field = fields.get(column);
    if (field) {
      meta.set(column, materializedMetaFromFieldInfo(field, appId));
      continue;
    }
    meta.set(column, syntheticColumnMeta(numericMeta.has(column) ? "number" : "string"));
  }
  return meta;
}

async function executeUpdateFrom(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateResult> {
  const matched = await resolveUpdateFromMatchedRecords(stmt, from, client, options, cacheContext, tempTables);
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  // 全件を先に構築・検証し、ローカル変換エラーによる部分書き込みを防止する。
  const batches = updateFromToPutBatches(
    stmt, matched, fieldTypes, statementEvaluationContext(options)
  );
  const targetFields = stmt.assignments.map((assignment) => assignment.field);
  const fieldInfos = await getFieldsCached(stmt.appId, client, cacheContext);
  const numberPrecision = await loadNumberPrecisionForTargets(stmt.appId, targetFields, fieldInfos, client, cacheContext);
  assertValidDmlRecords(batches.flatMap((batch) => batch.records.map((entry) => entry.record)), targetFields, fieldInfos, numberPrecision);

  if (options.confirm) {
    const ok = await options.confirm(matched.length, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", matched.length);
  }

  for (const batch of batches) await client.putRecords(batch);
  return { type: "UPDATE", updatedCount: matched.length };
}

function collectUpdateFromTargetFields(stmt: UpdateStatement): string[] {
  const fields = new Set<string>(["$id"]);
  if (stmt.from) fields.add(stmt.from.targetJoinField);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "FIELD_REF" && typeof obj["field"] === "string") fields.add(obj["field"]);
    for (const value of Object.values(obj)) visit(value);
  };
  for (const assignment of stmt.assignments) {
    if (assignment.value.type !== "SOURCE_FIELD") visit(assignment.value);
  }
  return [...fields];
}

// ============================================================
// DELETE
// ============================================================

async function executeDelete(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "DELETE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<DeleteResult> {
  await assertDmlWhereCapability(stmt, client, cacheContext);
  if (isConstantFalseWhere(stmt.where)) return { type: "DELETE", deletedCount: 0 };
  if (stmt.subtableCode) {
    return executeDeleteSubtable(stmt, client, options, cacheContext);
  }
  // 1. 対象レコードの $id を取得
  const getParams = deleteToGetQuery(stmt);
  const resolved = await resolveDmlTargetIds(
    client.getRecords,
    getParams.app,
    getParams.query,
    {
      maxRecords: options.maxRecords ?? 10_000,
      parallel: options.fetchParallel ?? 1,
    }
  );
  const ids = resolved.ids;

  // 2. 実行前確認
  if (options.confirm) {
    const ok = await options.confirm(ids.length, "DELETE");
    if (!ok) throw new OperationCancelledError("DELETE", ids.length);
  }

  // 3. DELETE バッチ実行
  const batches = deleteToDeleteBatches(stmt.appId, ids);
  for (const batch of batches) {
    await client.deleteRecords(batch);
  }

  return { type: "DELETE", deletedCount: ids.length };
}

// ============================================================
// UPSERT
// ============================================================

/**
 * UPSERT INTO APP100 (f1, f2) VALUES (v1, v2) ON DUPLICATE (f1)
 *
 * 処理フロー（行ごと）:
 *   1. keyFields の値で GET（件数チェック）
 *   2. ヒットあり → PUT（UPDATE）
 *   3. ヒットなし → POST（INSERT）
 *
 * 確認ダイアログは INSERT/UPDATE 件数をまとめて1回表示。
 */
async function executeUpsert(
  stmt: UpsertStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<UpsertResult> {
  if (stmt.onInsertApplyBlocks?.length || stmt.onUpdateApplyBlocks?.length) {
    return executeApplyUpsert(stmt, client, options, cacheContext);
  }
  if (stmt.checkGroups?.length) return executeCheckedPlainDml(stmt, client, options, cacheContext);
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const numberPrecision = await loadNumberPrecisionForTargets(stmt.appId, stmt.fields, fieldInfos, client, cacheContext);

  // 1. 各行のキー値を評価し、既存レコードを一括検索（in (...) チャンク）
  const toInsert: KintoneRecord[] = [];
  const toUpdate: { id: number; record: KintoneRecord }[] = [];
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  const rowKeyValues = buildUpsertRowKeyValues(stmt);
  const targetIndex = await resolveUpsertTargets(stmt.appId, stmt.keyFields, rowKeyValues, client, options, fieldTypes);

  stmt.values.forEach((row, rowIdx) => {
    // レコード全体を組み立て
    const record: KintoneRecord = {};
    stmt.fields.forEach((field, i) => {
      const val = row[i];
      if (val.type === "CASE_VALUE") {
        record[field] = { value: evalCaseWhenValue(
          val.expr, {}, fieldTypes.get(field), statementEvaluationContext(options)
        ) };
      } else {
        record[field] = { value: toKintoneValue(val, fieldTypes.get(field)) };
      }
    });

    const id = lookupUpsertTarget(targetIndex, rowKeyValues[rowIdx]);
    if (id !== undefined) {
      toUpdate.push({ id, record });
    } else {
      toInsert.push(record);
    }
  });
  assertValidDmlRecords(
    [...toInsert, ...toUpdate.map((entry) => entry.record)], stmt.fields, fieldInfos, numberPrecision
  );

  // 2. 確認ダイアログ（INSERT + UPDATE の合計）
  if (options.confirm && (toInsert.length + toUpdate.length) > 0) {
    const total = toInsert.length + toUpdate.length;
    const ok = await options.confirm(total, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", total);
  }

  // 3. POST（INSERT 対象）
  const createdIds: string[][] = [];
  for (let i = 0; i < toInsert.length; i += 100) {
    const res = await client.postRecords({ app: stmt.appId, records: toInsert.slice(i, i + 100) });
    createdIds.push(res.ids);
  }

  // 4. PUT（UPDATE 対象）
  for (let i = 0; i < toUpdate.length; i += 100) {
    await client.putRecords({ app: stmt.appId, records: toUpdate.slice(i, i + 100) });
  }

  return {
    type:          "UPSERT",
    insertedCount: createdIds.flat().length,
    updatedCount:  toUpdate.length,
  };
}

function buildUpsertRowKeyValues(stmt: UpsertStatement): string[][] {
  return stmt.values.map((row) => stmt.keyFields.map((key) => {
    const idx = stmt.fields.indexOf(key);
    if (idx === -1) throw new Error(`ON DUPLICATE のキー「${key}」が INSERT フィールドに含まれていません`);
    const val = row[idx];
    return val.type === "STRING" ? val.value
      : val.type === "NUMBER" ? numberLiteralText(val)
      : val.type === "CASE_VALUE" ? evalCaseWhen(val.expr, {})
      : val.elements.map((element) => element.value).join(",");
  }));
}

// ============================================================
// サブテーブル DML
// ============================================================

type MutableTableRow = {
  id?: string;
  value: Record<string, { value: unknown }>;
};

interface ExpandedSubtableRow {
  parent: KintoneRecord;
  parentId: string;
  parentRevision: number;
  rowIndex: number;
  rowId: string;
  row: MutableTableRow;
  flat: ProcessRow;
}

async function buildSubtableFieldTypeResolver(
  appId: number,
  typedInRefs: readonly FieldRef[],
  client: KintoneClient,
  cacheContext: string
): Promise<FieldTypeResolver | undefined> {
  if (typedInRefs.length === 0) return undefined;
  const fieldTypes = await getFieldTypeMap(appId, client, cacheContext);
  return (field) => {
    if (field.tableAlias !== null && field.tableAlias !== "_p") return undefined;
    if (field.tableAlias === "_p") return fieldTypes.get(field.field);
    const code = field.field.startsWith("_p.") ? field.field.slice(3) : field.field;
    return fieldTypes.get(code);
  };
}

async function executeInsertSubtable(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "INSERT" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  _cacheContext: string
): Promise<InsertResult> {
  const subtableCode = stmt.subtableCode!;
  const pidIndex = stmt.fields.indexOf("_pid");
  if (pidIndex < 0) {
    throw new Error("サブテーブル INSERT には _pid が必須です");
  }

  const parents = await fetchAll(client.getRecords, stmt.appId, "", [], {
    maxRecords: options.maxRecords ?? 10_000,
    parallel: options.fetchParallel ?? 1,
  });
  const parentMap = buildParentIdMap(parents);

  // 親IDごとに追加行を集約
  const insertsByParent = new Map<string, MutableTableRow[]>();
  for (const rowValues of stmt.values) {
    const pid = valueToString(rowValues[pidIndex]);
    const parent = parentMap.get(pid);
    if (!parent) throw new Error(`_pid=${pid} の親レコードが見つかりません`);

    const newRow: MutableTableRow = { value: {} };
    stmt.fields.forEach((field, i) => {
      if (field === "_pid") return;
      if (field.startsWith("_")) {
        throw new Error(`サブテーブル INSERT でシステム列「${field}」は指定できません`);
      }
      newRow.value[field] = { value: valueToString(rowValues[i]) };
    });
    const bucket = insertsByParent.get(pid);
    if (bucket) bucket.push(newRow);
    else insertsByParent.set(pid, [newRow]);
  }

  const putCalls: KintonePutParams[] = [];
  for (const [pid, rowsToInsert] of insertsByParent.entries()) {
    const parent = parentMap.get(pid)!;
    const currentRows = getMutableTableRows(parent, subtableCode);
    const nextRows = [...currentRows, ...rowsToInsert];
    putCalls.push(buildSubtablePutParams(stmt.appId, pid, getRevision(parent), subtableCode, nextRows));
  }

  for (const p of putCalls) {
    await client.putRecords(p);
  }

  return { type: "INSERT", createdIds: [], insertedCount: stmt.values.length };
}

async function executeUpdateSubtable(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "UPDATE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<UpdateResult> {
  const subtableCode = stmt.subtableCode!;
  if (!hasRidCondition(stmt.where)) {
    throw new Error("サブテーブル UPDATE には _rid 条件が必須です");
  }

  const typedInRefs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, typedInRefs);
  for (const assignment of stmt.assignments) {
    if (assignment.value.type === "CASE_VALUE") {
      collectCaseTypedInFieldRefs(assignment.value.expr, typedInRefs);
    }
  }
  const resolveFieldType = await buildSubtableFieldTypeResolver(
    stmt.appId,
    typedInRefs,
    client,
    cacheContext
  );

  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, subtableCode);
  const targets = expanded.filter((r) => evalWhere(
    stmt.where, r.flat, resolveFieldType, undefined, undefined, statementEvaluationContext(options)
  ));

  if (options.confirm) {
    const ok = await options.confirm(targets.length, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", targets.length);
  }

  const updatesByParent = new Map<string, Map<string, Record<string, { value: unknown }>>>();
  for (const t of targets) {
    if (!t.rowId) {
      throw new Error("サブテーブル UPDATE 対象に id 未採番の行が含まれています");
    }
    let byRid = updatesByParent.get(t.parentId);
    if (!byRid) {
      byRid = new Map<string, Record<string, { value: unknown }>>();
      updatesByParent.set(t.parentId, byRid);
    }
    const updates: Record<string, { value: unknown }> = {};
    for (const a of stmt.assignments) {
      if (a.field.startsWith("_")) {
        throw new Error(`サブテーブル UPDATE でシステム列「${a.field}」は更新できません`);
      }
      updates[a.field] = { value: evaluateSubtableAssignmentValue(
        a.value, t.flat, resolveFieldType, statementEvaluationContext(options)
      ) };
    }
    byRid.set(t.rowId, updates);
  }

  const parentById = buildParentIdMap(parents);
  for (const [pid, updateMap] of updatesByParent.entries()) {
    const parent = parentById.get(pid);
    if (!parent) continue;
    const currentRows = getMutableTableRows(parent, subtableCode);
    const payloadRows = currentRows.map((row) => {
      const rid = row.id ?? "";
      if (!rid) return row as unknown as { id: string; value?: Record<string, { value: unknown }> };
      const updates = updateMap.get(rid);
      if (!updates) {
        return { id: rid };
      }
      return { id: rid, value: updates };
    });
    await client.putRecords(buildSubtablePatchPutParams(stmt.appId, pid, getRevision(parent), subtableCode, payloadRows));
  }

  return { type: "UPDATE", updatedCount: targets.length };
}

async function executeDeleteSubtable(
  stmt: Extract<Awaited<ReturnType<typeof parseSql>>, { type: "DELETE" }>,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<DeleteResult> {
  const subtableCode = stmt.subtableCode!;
  if (!hasRidCondition(stmt.where)) {
    throw new Error("サブテーブル DELETE には _rid 条件が必須です");
  }

  const typedInRefs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, typedInRefs);
  const resolveFieldType = await buildSubtableFieldTypeResolver(
    stmt.appId,
    typedInRefs,
    client,
    cacheContext
  );

  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, subtableCode);
  const targets = expanded.filter((r) => evalWhere(
    stmt.where, r.flat, resolveFieldType, undefined, undefined, statementEvaluationContext(options)
  ));

  if (options.confirm) {
    const ok = await options.confirm(targets.length, "DELETE");
    if (!ok) throw new OperationCancelledError("DELETE", targets.length);
  }

  const byParent = new Map<string, number[]>();
  for (const t of targets) {
    const bucket = byParent.get(t.parentId);
    if (bucket) bucket.push(t.rowIndex);
    else byParent.set(t.parentId, [t.rowIndex]);
  }

  const parentById = buildParentIdMap(parents);
  for (const [pid, idxs] of byParent.entries()) {
    const parent = parentById.get(pid);
    if (!parent) continue;
    const rows = getMutableTableRows(parent, subtableCode);
    const rm = new Set(idxs);
    const nextRows = rows.filter((_, i) => !rm.has(i));
    await client.putRecords(buildSubtablePutParams(stmt.appId, pid, getRevision(parent), subtableCode, nextRows));
  }

  return { type: "DELETE", deletedCount: targets.length };
}

/** 親レコードの $id → レコードの索引（ループ内線形検索の回避） */
function buildParentIdMap(parents: KintoneRecord[]): Map<string, KintoneRecord> {
  const map = new Map<string, KintoneRecord>();
  for (const p of parents) {
    const pid = String(p["$id"]?.value ?? "");
    if (pid) map.set(pid, p);
  }
  return map;
}

function expandRowsForSubtableDml(parents: KintoneRecord[], subtableCode: string): ExpandedSubtableRow[] {
  const out: ExpandedSubtableRow[] = [];
  for (const parent of parents) {
    const parentId = String(parent["$id"]?.value ?? "");
    const parentRevision = getRevision(parent);
    const tableRows = getMutableTableRows(parent, subtableCode);
    for (let i = 0; i < tableRows.length; i++) {
      const row = tableRows[i];
      const flat: ProcessRow = {
        ...flattenSubtableSnapshotRow(row, i),
        _pid: parentId,
      };
      for (const [k, v] of Object.entries(parent)) {
        if (k === subtableCode) continue;
        flat[`_p.${k}`] = normalizeUnknownToString(v?.value);
      }
      out.push({ parent, parentId, parentRevision, rowIndex: i, rowId: row.id ?? "", row, flat });
    }
  }
  return out;
}

function getMutableTableRows(parent: KintoneRecord, subtableCode: string): MutableTableRow[] {
  const raw = parent[subtableCode]?.value;
  if (!Array.isArray(raw)) return [];
  return raw as unknown as MutableTableRow[];
}

function getRevision(parent: KintoneRecord): number {
  const n = Number(parent["$revision"]?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function buildSubtablePutParams(
  appId: number,
  parentId: string,
  revision: number,
  subtableCode: string,
  rows: MutableTableRow[]
): KintonePutParams {
  return {
    app: appId,
    records: [
      {
        id: Number(parentId),
        revision,
        record: {
          [subtableCode]: {
            value: rows as unknown as string,
          },
        },
      },
    ],
  };
}

function buildSubtablePatchPutParams(
  appId: number,
  parentId: string,
  revision: number,
  subtableCode: string,
  rows: Array<{ id: string; value?: Record<string, { value: unknown }> }>
): KintonePutParams {
  return {
    app: appId,
    records: [
      {
        id: Number(parentId),
        revision,
        record: {
          [subtableCode]: {
            value: rows as unknown as string,
          },
        },
      },
    ],
  };
}

function buildSubtableReorderPutParams(
  appId: number,
  parentId: string,
  revision: number,
  subtableCode: string,
  rowIds: string[]
): KintonePutParams {
  if (rowIds.some((id) => !id)) {
    throw new Error("REORDER 対象に id 未採番の行が含まれています");
  }
  return {
    app: appId,
    records: [
      {
        id: Number(parentId),
        revision,
        record: {
          [subtableCode]: {
            value: rowIds.map((id) => ({ id })) as unknown as string,
          },
        },
      },
    ],
  };
}

function valueToString(value: { type: "STRING"; value: string } | { type: "NUMBER"; value: number; raw?: string } | { type: "ARRAY"; elements: { value: string }[] } | { type: "CASE_VALUE"; expr: CaseWhenExpr }): string {
  if (value.type === "STRING") return value.value;
  if (value.type === "NUMBER") return numberLiteralText(value);
  if (value.type === "CASE_VALUE") return evalCaseWhen(value.expr, {});
  return value.elements.map((e) => e.value).join(",");
}

function normalizeUnknownToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasRidCondition(where: WhereExpr): boolean {
  switch (where.type) {
    case "BINARY":
      return where.left.type === "FIELD" && where.left.tableAlias === null && where.left.field === "_rid";
    case "LOGICAL":
      return hasRidCondition(where.left) || hasRidCondition(where.right);
    case "NOT":
    case "GROUP":
      return hasRidCondition(where.expr);
    default:
      return false;
  }
}

async function executeReorder(
  stmt: ReorderStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<ReorderResult> {
  const typedInRefs: FieldRef[] = [];
  collectTypedInFieldRefs(stmt.where, typedInRefs);
  const resolveFieldType = await buildSubtableFieldTypeResolver(
    stmt.appId,
    typedInRefs,
    client,
    cacheContext
  );
  const reorderFields = await getFieldsCached(stmt.appId, client, cacheContext);
  if (isConstantFalseWhere(stmt.where)) return { type: "REORDER", reorderedParentCount: 0 };
  const reorderSemanticsByCode = new Map(reorderFields.map((field) => [
    field.code,
    field.semantics ?? resolveFieldSemantics(field),
  ]));
  const resolveReorderSemantics: FieldSemanticsResolver = (field) => {
    if (field.field === "_idx" || field.field === "_pid" || field.field === "_rid") {
      return syntheticSemantics("number");
    }
    const code = field.field.startsWith("_p.") ? field.field.slice(3) : field.field;
    return reorderSemanticsByCode.get(code) ?? syntheticSemantics("string");
  };
  const parents = await fetchAll(
    client.getRecords,
    stmt.appId,
    "",
    [],
    { maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1 }
  );
  const expanded = expandRowsForSubtableDml(parents, stmt.subtableCode);

  // WHERE に一致する行を1件でも持つ親を対象とする
  const targetParentIds = stmt.all
    ? new Set(parents.map((p) => String(p["$id"]?.value ?? "")).filter((id) => id !== ""))
    : new Set(expanded.filter((r) => stmt.where && evalWhere(
        stmt.where,
        r.flat,
        resolveFieldType,
        undefined,
        resolveReorderSemantics,
        statementEvaluationContext(options)
      )).map((r) => r.parentId));

  if (options.confirm) {
    const ok = await options.confirm(targetParentIds.size, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", targetParentIds.size);
  }

  const parentById = buildParentIdMap(parents);
  for (const pid of targetParentIds) {
    const parent = parentById.get(pid);
    if (!parent) continue;

    const rows = getMutableTableRows(parent, stmt.subtableCode);
    const sortable = rows.map((row, i) => ({ row, i, flat: buildFlatRowForSort(parent, stmt.subtableCode, row, i) }));
    sortable.sort((a, b) => compareByOrder(
      a.flat,
      b.flat,
      stmt.by,
      resolveReorderSemantics,
      statementEvaluationContext(options)
    ));
    const orderedRowIds = sortable.map((x) => x.row.id ?? "");
    await client.putRecords(buildSubtableReorderPutParams(stmt.appId, pid, getRevision(parent), stmt.subtableCode, orderedRowIds));
  }

  return { type: "REORDER", reorderedParentCount: targetParentIds.size };
}

function buildFlatRowForSort(
  parent: KintoneRecord,
  subtableCode: string,
  row: MutableTableRow,
  idx: number
): ProcessRow {
  const flat: ProcessRow = {
    _pid: String(parent["$id"]?.value ?? ""),
    _rid: row.id ?? "",
    _idx: String(idx),
  };
  for (const [k, v] of Object.entries(parent)) {
    if (k === subtableCode) continue;
    flat[`_p.${k}`] = normalizeUnknownToString(v?.value);
  }
  for (const [k, v] of Object.entries(row.value ?? {})) {
    flat[k] = normalizeUnknownToString(v?.value);
  }
  return flat;
}

function compareByOrder(
  a: ProcessRow,
  b: ProcessRow,
  orderBy: ReorderStatement["by"],
  resolveSemantics: FieldSemanticsResolver,
  evaluationContext: EvaluationContext = {}
): number {
  for (const item of orderBy) {
    const av = evalOrderKeyForRow(item.key, a, evaluationContext);
    const bv = evalOrderKeyForRow(item.key, b, evaluationContext);
    const semantics = item.key.type === "FIELD_NAME"
      ? resolveSemantics(aggregateFieldRef(item.key.name))
      : item.key.type === "ARITH_KEY"
        ? syntheticSemantics("number")
        : item.key.type === "FUNC_KEY"
          ? stringFunctionColumnMeta(item.key.expr).semantics ?? syntheticSemantics("string")
          : syntheticSemantics("number");
    const cmp = compareCanonicalValues(av, bv, semantics ?? syntheticSemantics("string"));
    if (cmp !== 0) return item.direction === "ASC" ? cmp : -cmp;
  }
  return 0;
}

function evalOrderKeyForRow(
  key: OrderByKey,
  row: ProcessRow,
  evaluationContext: EvaluationContext = {}
): string {
  switch (key.type) {
    case "FIELD_NAME":
      return row[key.name] ?? "";
    case "ARITH_KEY":
      return String(evalArithExpr(key.expr, row, evaluationContext));
    case "FUNC_KEY":
      return evalStringFunc(key.expr, row, undefined, undefined, evaluationContext);
    case "GROUPING_KEY":
      throw new Error("ArgumentError: GROUPING() is not supported in REORDER BY.");
  }
}

// ============================================================
// UPSERT INTO ... SELECT
// ============================================================

async function executeUpsertSelect(
  stmt: UpsertSelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  /** バッチ実行時の一時テーブルストア（#name → 行＋列）。SELECT ソースの解決に使う */
  cteCache?: Map<string, MaterializedTable>
): Promise<UpsertResult> {
  if (stmt.checkGroups?.length) return executeCheckedPlainDml(stmt, client, options, cacheContext, cteCache);
  // 1. 転送先フィールドを、ソース SELECT や照合 read、confirm より前に検査する。
  const fieldInfos = await loadWritableTopLevelDmlFields(stmt.appId, stmt.fields, client, cacheContext);
  const numberPrecision = await loadNumberPrecisionForTargets(stmt.appId, stmt.fields, fieldInfos, client, cacheContext);

  // 2. SELECT を実行して結果行を取得（一時テーブル参照があれば注入経路で解決）
  const sourceTable = await dmlSourceMaterializer.materialize(stmt, client, options, cacheContext, cteCache, fieldInfos);
  const { rows, columns } = sourceTable;
  assertNoImportRowErrors(sourceTable);

  if (columns.length !== stmt.fields.length) {
    const emptySourceHint = columns.length === 0 && rows.length === 0
      ? "。結果が 0 行のため列を特定できませんでした（SELECT * を空ソースに使うと列を決定できません。明示列で指定してください）"
      : "";
    throw new Error(
      `SELECT の列数（${columns.length}）と UPSERT のフィールド数（${stmt.fields.length}）が一致しません${emptySourceHint}`
    );
  }

  // 2. キーフィールドが UPSERT フィールドに含まれているか確認
  for (const key of stmt.keyFields) {
    if (!stmt.fields.includes(key)) {
      throw new Error(`ON DUPLICATE のキー「${key}」が UPSERT フィールドに含まれていません`);
    }
  }

  const toInsert: KintoneRecord[] = [];
  const toUpdate: { id: number; record: KintoneRecord }[] = [];
  const fieldTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);

  // レコードを組み立て（SELECT 列 → UPSERT フィールドに位置対応でマップ）
  const records: KintoneRecord[] = rows.map((row, rowIndex) => {
    const record: KintoneRecord = {};
    stmt.fields.forEach((field, i) => {
      if (sourceTable.importPresence && !sourceTable.importPresence[rowIndex]?.has(field)) return;
      const raw = row[columns[i]] ?? "";
      record[field] = { value: convertProcessRowValue(raw, fieldTypes.get(field)) };
    });
    return record;
  });
  records.forEach((record) => assertValidDmlRecords([record], stmt.fields.filter((field) => field in record), fieldInfos, numberPrecision));

  // キー値で既存レコードを一括検索（in (...) チャンク）
  const rowKeyValues: string[][] = records.map((record) =>
    stmt.keyFields.map((key) => String(record[key]?.value ?? ""))
  );
  if (importSourceByDmlStatement.has(stmt)) {
    const numericKey = stmt.keyFields.map((key) => fieldTypes.get(key) === "NUMBER");
    const sourceKeys = new Set<string>();
    for (const parts of rowKeyValues) {
      const normalized = upsertNormalizedKey(parts, numericKey);
      if (sourceKeys.has(normalized)) throw new Error("ERR_KEY_DUP_SOURCE: UPSERT ソース内でキーが重複しています");
      sourceKeys.add(normalized);
    }
  }
  const targetIndex = await resolveUpsertTargets(stmt.appId, stmt.keyFields, rowKeyValues, client, options, fieldTypes);

  records.forEach((record, rowIdx) => {
    const id = lookupUpsertTarget(targetIndex, rowKeyValues[rowIdx]);
    if (id !== undefined) {
      toUpdate.push({ id, record });
    } else {
      toInsert.push(record);
    }
  });

  // 3. 確認ダイアログ
  if (options.confirm && (toInsert.length + toUpdate.length) > 0) {
    const total = toInsert.length + toUpdate.length;
    const ok = await options.confirm(total, "UPDATE");
    if (!ok) throw new OperationCancelledError("UPDATE", total);
  }

  // 4. POST（INSERT 対象）
  const createdIds: string[][] = [];
  for (let i = 0; i < toInsert.length; i += 100) {
    const res = await client.postRecords({ app: stmt.appId, records: toInsert.slice(i, i + 100) });
    createdIds.push(res.ids);
  }

  // 5. PUT（UPDATE 対象）
  for (let i = 0; i < toUpdate.length; i += 100) {
    await client.putRecords({ app: stmt.appId, records: toUpdate.slice(i, i + 100) });
  }

  return {
    type:          "UPSERT",
    insertedCount: createdIds.flat().length,
    updatedCount:  toUpdate.length,
  };
}

// ============================================================
// SHOW APPS
// ============================================================

/**
 * `SHOW APPS` が返す列（B136）。
 * **言語リファレンス §14 の表と突き合わせるテストがある**ので、変えるときは文書も直すこと。
 */
export const SHOW_APPS_COLUMNS: readonly string[] = Object.freeze([
  "アプリID", "アプリ名", "説明",
]);

/**
 * `DESCRIBE` / `DESC` が返す列（B130 で 3 列から 7 列へ・B136）。
 * **言語リファレンス §14 の表と突き合わせるテストがある**ので、変えるときは文書も直すこと。
 */
export const DESCRIBE_COLUMNS: readonly string[] = Object.freeze([
  // B145: サブテーブル列は「その項目がどの表にあるか」を示す。無いと明細項目を
  // 親項目と取り違え、親から SELECT して全行空という結果になる（エラーも警告も出ない）。
  "フィールドコード", "ラベル", "タイプ", "サブテーブル",
  "ルックアップ", "コピー元", "重複禁止", "計算式",
]);

async function executeShowApps(client: KintoneClient): Promise<SelectResult> {
  const apps = await client.getApps();
  const columns = [...SHOW_APPS_COLUMNS];
  const rows: ProcessRow[] = apps.map((a) => ({
    "アプリID": String(a.appId),
    "アプリ名":  a.name,
    "説明":      a.description,
  }));
  return { type: "SELECT", rows, columns, rowCount: rows.length };
}

// ============================================================
// DESCRIBE
// ============================================================

async function executeDescribe(
  stmt: DescribeStatement,
  client: KintoneClient,
  cacheContext: string
): Promise<SelectResult> {
  const fields = await getFieldsCached(stmt.appId, client, cacheContext);
  const columns = [...DESCRIBE_COLUMNS];
  const rows: ProcessRow[] = fields.map((f) => ({
    "フィールドコード": f.code,
    "ラベル":           f.label,
    "タイプ":           f.fieldType,
    // 明細項目はサブテーブルのフィールドコード、親項目は空文字。
    "サブテーブル":     f.inSubtable === true ? (f.subtableCode ?? "") : "",
    "ルックアップ":     f.hasLookup === true ? "YES" : "",
    "コピー元":         f.isLookupCopyTarget === true ? "YES" : "",
    "重複禁止":         f.isUnique === true ? "YES" : "",
    "計算式":           f.isCalculated === true ? "YES" : "",
  }));
  return { type: "SELECT", rows, columns, rowCount: rows.length };
}

// ============================================================
// ヘルパー
// ============================================================

function parseSql(sql: string, enableImport = false) {
  try {
    const tokens = new Lexer(sql).tokenize();
    const stmt = new Parser(tokens, { import: enableImport }).parse();
    assertApplyScope("phase15b", stmt);
    validateStatementStatic(stmt);
    return stmt;
  } catch (e) {
    if (e instanceof LexError || e instanceof ParseError) {
      throw e; // 日本語エラーメッセージをそのまま伝播
    }
    throw e;
  }
}

/**
 * WhereExpr を再帰的に走査し、SUBQUERY_IN_LIST / SCALAR_SUBQUERY / EXISTS の
 * サブクエリを実行して resolved を埋める（破壊的変更）。
 * 複数のサブクエリは収集後に並列実行する。
 */
async function resolveSubqueries(
  where: WhereExpr | null,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  warnings: Set<string>,
  cteCache?: Map<string, MaterializedTable>
): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  collectSubqueryTasks(where, client, options, cacheContext, tasks, warnings, cteCache);
  await Promise.all(tasks);
}

/** SELECT 列 CASE WHEN 内のサブクエリも、射影前に一度だけ解決する。 */
async function resolveSelectCaseSubqueries(
  stmt: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  warnings: Set<string>,
  cteCache?: Map<string, MaterializedTable>
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const column of stmt.columns) {
    if (column.type !== "CASE_COL") continue;
    for (const branch of column.expr.branches) {
      tasks.push(resolveSubqueries(branch.condition, client, options, cacheContext, warnings, cteCache));
    }
  }
  await Promise.all(tasks);
}

/**
 * サブクエリ1個を実行する。cteCache がある場合は executeQueryWithCte 経由にし、
 * サブクエリの FROM / JOIN にある CTE / 一時テーブル参照（#name）を解決する。
 */
function runSubquery(
  query: SelectStatement,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  cteCache?: Map<string, MaterializedTable>
): Promise<SelectResult> {
  if (cteCache !== undefined && cteCache.size > 0) {
    return executeQueryWithCte(query, client, options, cteCache, cacheContext);
  }
  return executeSelect(query, client, options, cacheContext);
}

function collectSubqueryTasks(
  where: WhereExpr | null,
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  tasks: Array<Promise<void>>,
  warnings: Set<string>,
  cteCache?: Map<string, MaterializedTable>
): void {
  if (where === null) return;
  switch (where.type) {
    case "BINARY": {
      const right = where.right;
      if (right.type === "SUBQUERY_IN_LIST") {
        tasks.push(runSubquery(right.query, client, options, cacheContext, cteCache).then((result) => {
          for (const warning of result.warnings ?? []) warnings.add(warning);
          const col = right.column ?? (result.columns[0] ?? "");
          (right as ResolvedSubqueryInList).resolved = new Set(result.rows.map((r) => r[col] ?? ""));
        }));
      }
      if (right.type === "SCALAR_SUBQUERY") {
        tasks.push(runSubquery(right.query, client, options, cacheContext, cteCache).then((result) => {
          for (const warning of result.warnings ?? []) warnings.add(warning);
          if (result.rowCount === 0) throw new Error("スカラーサブクエリが値を返しませんでした");
          if (result.rowCount > 1)  throw new Error("スカラーサブクエリが複数行を返しました（1行のみ許可）");
          const col = result.columns[0] ?? "";
          (right as ResolvedScalarSubquery).resolved = result.rows[0]?.[col] ?? "";
        }));
      }
      break;
    }
    case "LOGICAL":
      collectSubqueryTasks(where.left,  client, options, cacheContext, tasks, warnings, cteCache);
      collectSubqueryTasks(where.right, client, options, cacheContext, tasks, warnings, cteCache);
      break;
    case "NOT":
    case "GROUP":
      collectSubqueryTasks(where.expr, client, options, cacheContext, tasks, warnings, cteCache);
      break;
    case "EXISTS": {
      const node = where;
      tasks.push(runSubquery(node.query, client, options, cacheContext, cteCache).then((result) => {
        for (const warning of result.warnings ?? []) warnings.add(warning);
        (node as ResolvedExistsExpr).resolved = result.rowCount > 0;
      }));
      break;
    }
    case "BOOLEAN":
      break;
  }
}

/**
 * UPDATE SET の各 Assignment を走査し、SCALAR_SUBQUERY 型の value を事前実行して
 * StringLiteral に差し替える（破壊的変更）。
 * 非相関のため 1 回だけ実行され、全対象レコードに同じ値が設定される。
 */
async function resolveSetSubqueries(
  assignments: UpdateStatement["assignments"],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string
): Promise<void> {
  for (const a of assignments) {
    if (a.value.type !== "SCALAR_SUBQUERY") continue;
    const result = await executeSelect(a.value.query, client, options, cacheContext);
    if (result.rowCount === 0) throw new Error(`SET サブクエリが値を返しませんでした（フィールド: ${a.field}）`);
    if (result.rowCount > 1)  throw new Error(`SET サブクエリが複数行を返しました（フィールド: ${a.field}）`);
    const col = result.columns[0] ?? "";
    const resolved = result.rows[0]?.[col] ?? "";
    // StringLiteral に差し替え → dmlToKintone.ts の変更不要
    a.value = { type: "STRING", value: resolved };
  }
}

/**
 * SELECT 列のスカラーサブクエリを事前実行し、列インデックス → 値のマップを返す。
 * 同一クエリ（AST が一致）は 1 回だけ実行し、異なるクエリは並列実行する。
 * （非相関のため全行同一値）
 */
async function resolveScalarColumns(
  columns: SelectStatement["columns"],
  client: KintoneClient,
  options: ExecuteOptions,
  cacheContext: string,
  warnings: Set<string>,
  cteCache?: Map<string, MaterializedTable>
): Promise<Map<number, string>> {
  const byQuery = new Map<string, Promise<string>>();
  const pending: Array<[number, Promise<string>]> = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col.type !== "SCALAR_SUBQUERY_COL") continue;
    const key = JSON.stringify(col.query);
    let promise = byQuery.get(key);
    if (!promise) {
      promise = runSubquery(col.query, client, options, cacheContext, cteCache).then((result) => {
        for (const warning of result.warnings ?? []) warnings.add(warning);
        if (result.rowCount === 0) throw new Error("スカラーサブクエリが値を返しませんでした");
        if (result.rowCount > 1)  throw new Error("スカラーサブクエリが複数行を返しました（1行のみ許可）");
        const firstCol = result.columns[0] ?? "";
        return result.rows[0]?.[firstCol] ?? "";
      });
      byQuery.set(key, promise);
    }
    pending.push([i, promise]);
  }
  const values = await Promise.all(pending.map(([, promise]) => promise));
  const cache = new Map<number, string>();
  pending.forEach(([i], idx) => cache.set(i, values[idx]));
  return cache;
}

// ============================================================
// EXPLAIN
// ============================================================

interface ExplainWhereAnalysis {
  capabilities: Map<SelectStatement, PredicateCapabilityResult>;
  orderPlans: Map<SelectStatement, CanonicalOrderPlan>;
  plainGroupByPlans: Map<SelectStatement, PlainGroupByResolutionPlan>;
  fieldApps: Set<number>;
  processStatusApps: Set<number>;
  numberPrecisionApps: Set<number>;
  relativeDatePlan: RelativeDatePushdownPlan;
}

// EXPLAIN renderer は schema-aware analysis が一度だけ生成した runtime plan object を参照する。
// renderer 側で JOIN predicate を再抽出・再分類しない。
const explainJoinPushdownPlans = new WeakMap<SelectStatement, RuntimeJoinPushdownPlan>();
const explainPushdownPlans = new WeakMap<SelectStatement, KlikePushdownPlan>();
interface ExplainJoinKeyPrefilter {
  readonly plan: ReturnType<typeof planJoinKeyPrefilter>;
  readonly queries: readonly string[];
  readonly additionalQuery?: string;
  readonly additionalRelation?: "exact" | "superset";
}
const explainJoinKeyPrefilters = new WeakMap<
  SelectStatement,
  ReadonlyMap<string, ExplainJoinKeyPrefilter>
>();
const explainChoiceEqualityRewrites = new WeakMap<
  SelectStatement,
  readonly ChoiceEqualityRewrite[]
>();

interface ExplainCrossJoinStep {
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftRows: number | null;
  readonly rightRows: number | null;
  readonly plan: CrossJoinRowPlan | null;
  readonly rightRuntimeLabel: string;
}

const explainCrossJoinSteps = new WeakMap<SelectStatement, readonly ExplainCrossJoinStep[]>();

interface ValidateExplainInfo {
  targetFields: string[];
  fetchFields: string[];
  subtables: Map<string, number>;
  capability: PredicateCapabilityResult;
  prefilter: WhereExpr | null;
  numberPrecision: boolean;
}

const validateExplainInfo = new WeakMap<ValidateStatement, ValidateExplainInfo>();
const applyParentExplainPlan = new WeakMap<UpdateStatement, ApplyParentSelectionPlan>();

async function buildExplainWhereAnalysis(
  query: unknown,
  client: KintoneClient,
  cacheContext: string,
  maxRecords = 10_000,
  relativeDatePlan?: RelativeDatePushdownPlan,
  initialRelations?: ReadonlyMap<string, MaterializedTable>
): Promise<ExplainWhereAnalysis> {
  const fieldApps = new Set<number>();
  const processStatusApps = new Set<number>();
  const numberPrecisionApps = new Set<number>();
  const tracedClient: KintoneClient = {
    ...client,
    getFields: async (appId) => {
      fieldApps.add(appId);
      return client.getFields(appId);
    },
    getProcessStatuses: async (appId) => {
      processStatusApps.add(appId);
      return client.getProcessStatuses(appId);
    },
    getNumberPrecision: async (appId) => {
      numberPrecisionApps.add(appId);
      return client.getNumberPrecision(appId);
    },
  };
  const capabilities = new Map<SelectStatement, PredicateCapabilityResult>();
  const orderPlans = new Map<SelectStatement, CanonicalOrderPlan>();
  const plainGroupByPlans = new Map<SelectStatement, PlainGroupByResolutionPlan>();
  const seen = new Set<object>();
  const sharedRelativeDatePlan = relativeDatePlan
    ?? await resolveRelativeDateExecutionPlan(query as Statement, tracedClient, cacheContext);
  const relativeNodeFor = (source: object) => sharedRelativeDatePlan.nodes.find((node) =>
    node.source === source
    || JSON.stringify(node.source) === JSON.stringify(source)
  );

  const explainRelations = new Map<string, MaterializedTable>(initialRelations ?? []);
  const staticExplainRelations = new Set<string>(initialRelations?.keys() ?? []);
  const exactRelationRows = new Map<string, number>(
    [...(initialRelations ?? new Map<string, MaterializedTable>())]
      .map(([name, relation]) => [name, relation.rows.length] as const)
  );
  const staticSelectRows = new WeakMap<SelectStatement, number>();
  const tableLabel = (table: TableRef): string =>
    effectiveTableAlias(table) ?? (table.appId > 0 ? `APP${table.appId}` : "source");
  const tableExactRows = (table: TableRef): number | null => {
    if (table.cteName === NO_FROM_CTE_NAME) return 1;
    if (table.cteName !== null) return exactRelationRows.get(table.cteName) ?? null;
    return null;
  };
  const analyzeStaticSelectRows = (select: SelectStatement): void => {
    let currentRows = tableExactRows(select.from);
    let leftLabel = tableLabel(select.from);
    const steps: ExplainCrossJoinStep[] = [];
    for (const join of select.joins) {
      const rightRows = tableExactRows(join.table);
      const rightLabel = tableLabel(join.table);
      if (join.type === "CROSS") {
        const plan = currentRows !== null && rightRows !== null
          ? planCrossJoinRows(currentRows, rightRows)
          : null;
        steps.push({
          leftLabel,
          rightLabel,
          leftRows: currentRows,
          rightRows,
          plan,
          rightRuntimeLabel: join.table.cteName === null
            ? `APP${join.table.appId} fetched rows`
            : `${rightLabel} materialized rows`,
        });
        currentRows = plan?.outputRows ?? null;
        leftLabel = `${leftLabel} × ${rightLabel}`;
      } else {
        currentRows = null;
        leftLabel = `${leftLabel} ${join.type} JOIN ${rightLabel}`;
      }
    }
    if (steps.length > 0) explainCrossJoinSteps.set(select, steps);
    if (isConstantFalseWhere(select.where)) currentRows = 0;
    else if (select.where !== null) currentRows = null;
    const grouping = normalizeGroupingSpec(select);
    if (grouping.type !== "NONE"
      || select.distinct
      || select.having !== null
      || isAggregateQueryBlock(select)
      || select.columns.some((column) => column.type === "WINDOW_COL")) {
      currentRows = null;
    }
    if (currentRows !== null) {
      const offset = select.offset ?? 0;
      currentRows = Math.max(0, currentRows - offset);
      if (select.limit !== null) currentRows = Math.min(currentRows, select.limit);
      staticSelectRows.set(select, currentRows);
    }
  };
  const explainSourceColumns = async (select: SelectStatement): Promise<string[]> => {
    const tables = [select.from, ...select.joins.map((join) => join.table)];
    if (tables.length > 1 && select.columns.some((column) =>
      column.type === "WILDCARD" || column.type === "PARENT_WILDCARD"
    )) {
      throw new Error(
        "ArgumentError: EXPLAIN could not determine the relation output schema for a multi-source wildcard SELECT."
      );
    }
    const columns: string[] = [];
    for (const table of tables) {
      if (table.cteName !== null) {
        if (table.cteName === NO_FROM_CTE_NAME) continue;
        const relation = explainRelations.get(table.cteName);
        if (!relation) {
          throw new Error(
            `ArgumentError: EXPLAIN could not determine the relation output schema for ${table.cteName}.`
          );
        }
        columns.push(...relation.columns);
        continue;
      }
      const fields = await getFieldsCached(table.appId, tracedClient, cacheContext);
      if (table.subtableCode) {
        columns.push(...fields.filter((field) =>
          field.inSubtable && (field.subtableCode === table.subtableCode || field.subtableCode === undefined)
        ).map((field) => field.code));
        columns.push("_pid", "_rid", "_idx");
        columns.push(...fields.filter((field) => !field.inSubtable).map((field) => `_p.${field.code}`));
      } else {
        columns.push(...fields.filter((field) => !field.inSubtable).map((field) => field.code));
        columns.push(...APP_SYSTEM_FIELD_CODES);
      }
    }
    return [...new Set(columns)];
  };
  const inferExplainRelationColumns = async (node: unknown): Promise<string[]> => {
    if (node === null || typeof node !== "object") {
      throw new Error("ArgumentError: EXPLAIN could not determine the relation output schema.");
    }
    const typed = node as Record<string, unknown>;
    if (typed["type"] === "SELECT") {
      const select = node as SelectStatement;
      const sourceColumns = await explainSourceColumns(select);
      if (select.columns.length === 1 && select.columns[0].type === "WILDCARD") {
        return sourceColumns;
      }
      const output: string[] = [];
      for (const column of select.columns) {
        if (column.type === "WILDCARD") output.push(...sourceColumns);
        else if (column.type === "PARENT_WILDCARD") {
          output.push(...sourceColumns.filter((name) => name.startsWith("_p.")));
        } else {
          output.push(...project([], [column]).columns);
        }
      }
      return output;
    }
    if (typed["type"] === "UNION") {
      return inferExplainRelationColumns(typed["left"]);
    }
    if (typed["type"] === "SHOW_APPS") return [...SHOW_APPS_COLUMNS];
    if (typed["type"] === "DESCRIBE") return [...DESCRIBE_COLUMNS];
    if (typed["type"] === "GENERATE_SERIES") {
      return [(node as GenerateSeriesStatement).columnAlias];
    }
    throw new Error("ArgumentError: EXPLAIN could not determine the relation output schema.");
  };
  const preflightExplainRelations = async (node: unknown): Promise<void> => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) await preflightExplainRelations(child);
      return;
    }
    const typed = node as Record<string, unknown>;
    if (typed["type"] === "WITH") {
      const withStatement = node as WithStatement;
      for (const cte of withStatement.ctes) {
        await preflightExplainRelations(cte.query);
        if (cte.query.type === "GENERATE_SERIES") {
          if (cte.query.args.some((arg) => arg.type === "VARIABLE")) {
            explainRelations.set(cte.name, { rows: [], columns: [cte.query.columnAlias] });
            continue;
          }
          const generated = executeGenerateSeries(cte.query);
          explainRelations.set(cte.name, {
            rows: generated.rows,
            columns: generated.columns,
            columnMeta: materializedMetaBySelectResult.get(generated),
            uniqueGeneratedColumn: cte.query.columnAlias,
          });
          staticExplainRelations.add(cte.name);
          exactRelationRows.set(cte.name, generated.rows.length);
          continue;
        }
        const columns = await inferExplainRelationColumns(cte.query);
        explainRelations.set(cte.name, { rows: [], columns });
        if (cte.query.type === "SELECT") {
          const rowCount = staticSelectRows.get(cte.query);
          if (rowCount !== undefined) exactRelationRows.set(cte.name, rowCount);
        }
      }
      await preflightExplainRelations(withStatement.query);
      return;
    }
    if (typed["type"] === "UNION") {
      await preflightExplainRelations(typed["left"]);
      await preflightExplainRelations(typed["right"]);
      return;
    }
    if (typed["type"] === "SELECT") {
      const select = node as SelectStatement;
      analyzeStaticSelectRows(select);
      for (const column of select.columns) {
        if (column.type === "SCALAR_SUBQUERY_COL") await preflightExplainRelations(column.query);
      }
      await preflightExplainRelations(select.where);
      await preflightExplainRelations(select.having);
      await validateSelectGroupingPlanning(
        select,
        tracedClient,
        cacheContext,
        explainRelations
      );
      const sources = [select.from, ...select.joins.map((join) => join.table)];
      const hasUnavailableMaterializedSource = sources.some((source) =>
        source.cteName !== null && !explainRelations.has(source.cteName)
      );
      if (!hasUnavailableMaterializedSource) {
        const plainPlan = await buildRuntimePlainGroupByPlan(
          select,
          tracedClient,
          cacheContext,
          explainRelations
        );
        if (plainPlan) plainGroupByPlans.set(select, plainPlan);
      }
      return;
    }
    for (const child of Object.values(typed)) await preflightExplainRelations(child);
  };

  await preflightExplainRelations(query);

  const visit = async (node: unknown): Promise<void> => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      await Promise.all(node.map(visit));
      return;
    }
    const typed = node as Record<string, unknown>;
    if (typed["type"] === "SELECT") {
      const select = node as SelectStatement;
      await validateSelectGroupingPlanning(select, tracedClient, cacheContext);
      const hasUnmaterializedSource = [select.from, ...select.joins.map((join) => join.table)]
        .some((table) => table.cteName !== null);
      if (normalizeGroupingSpec(select).type === "PLAIN" && !hasUnmaterializedSource) {
        const plainPlan = await buildRuntimePlainGroupByPlan(
          select,
          tracedClient,
          cacheContext
        );
        if (plainPlan) plainGroupByPlans.set(select, plainPlan);
      }
      const physicalApps = [select.from, ...select.joins.map((join) => join.table)]
        .filter((table) => table.cteName === null)
        .map((table) => table.appId);
      const needsWhereSchema = whereNeedsFieldMetadata(select.where);
      if (needsWhereSchema || select.orderBy.length > 0
        || select.columns.some((column) => column.type === "WINDOW_COL" && column.orderBy.length > 0)) {
        physicalApps.forEach((appId) => fieldApps.add(appId));
      }
      const { resolver, rewrites } = await normalizeSelectChoiceEquality(
        select, tracedClient, cacheContext
      );
      if (rewrites.length > 0) explainChoiceEqualityRewrites.set(select, rewrites);
      const capability = classifyWhereCapability(select.where, resolver);
      const relativeNode = relativeNodeFor(select);
      if (capability.capability === "UNSUPPORTED" && !relativeNode) {
        throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(capability)}).`);
      }
      capabilities.set(select, capability);
      const pushdownMetadata = await loadTypedPushdownMeta(select, tracedClient, cacheContext);
      const preboundJoinPushdownPlan = boundJoinRuntimePlans.get(select);
      const joinPushdownPlan = preboundJoinPushdownPlan
        ?? buildRuntimeJoinPushdownPlan(select, pushdownMetadata);
      if (joinPushdownPlan) explainJoinPushdownPlans.set(select, joinPushdownPlan);
      const resolvedPushdownPlan = joinPushdownPlan
        ?? buildKlikePushdownPlan(select, pushdownMetadata);
      explainPushdownPlans.set(select, resolvedPushdownPlan);
      const joinKeyPlans = new Map<string, ExplainJoinKeyPrefilter>();
      for (const join of select.joins) {
        const joinAlias = join.table.alias;
        if (join.type !== "INNER" || !joinAlias || join.table.subtableCode) continue;
        const leftAlias = join.on.left.tableAlias;
        const rightAlias = join.on.right.tableAlias;
        if (!leftAlias || !rightAlias) continue;
        const sourceAlias = leftAlias === joinAlias && rightAlias !== joinAlias
          ? rightAlias
          : rightAlias === joinAlias && leftAlias !== joinAlias
            ? leftAlias
            : undefined;
        const sourceField = leftAlias === joinAlias ? join.on.right.field : join.on.left.field;
        const joinField = leftAlias === joinAlias ? join.on.left.field : join.on.right.field;
        if (!sourceAlias) continue;
        const sourceTable = [select.from, ...select.joins.map((candidate) => candidate.table)]
          .find((table) => effectiveTableAlias(table) === sourceAlias);
        let targetMeta: MaterializedColumnMeta | undefined;
        if (join.table.cteName !== null) {
          targetMeta = explainRelations.get(join.table.cteName)?.columnMeta?.get(joinField);
        } else {
          const targetInfo = (await getFieldsCached(join.table.appId, tracedClient, cacheContext))
            .find((info) => info.code === fieldCodeForTypeLookup(join.table, joinField));
          targetMeta = targetInfo
            ? materializedMetaFromFieldInfo(targetInfo, join.table.appId)
            : systemColumnMeta(joinField);
        }
        let sourceMeta: MaterializedColumnMeta | undefined;
        let values: string[] | undefined;
        let sourceRowCount: number | undefined;
        let hasEmptyValue: boolean | undefined;
        if (sourceTable?.cteName !== null && sourceTable?.cteName !== undefined) {
          const relation = explainRelations.get(sourceTable.cteName);
          sourceMeta = relation?.columnMeta?.get(sourceField);
          if (staticExplainRelations.has(sourceTable.cteName) && relation) {
            sourceRowCount = relation.rows.length;
            values = relation.rows.map((row) => toScalarText(row[sourceField]));
            hasEmptyValue = values.some((value) => value.length === 0);
          }
        } else if (sourceTable) {
          const info = (await getFieldsCached(sourceTable.appId, tracedClient, cacheContext))
            .find((candidate) => candidate.code === fieldCodeForTypeLookup(sourceTable, sourceField));
          sourceMeta = info
            ? materializedMetaFromFieldInfo(info, sourceTable.appId)
            : systemColumnMeta(sourceField);
        }
        const plan = planJoinKeyPrefilter({
          fieldType: targetMeta?.fieldType,
          sourceSemantics: sourceMeta?.semantics,
          sourceRowCount,
          values,
          hasEmptyValue,
          maxInKeys: JOIN_IN_MAX_KEYS,
        });
        if (plan.kind === "FALLBACK" && plan.reason === "JOIN_KEY_VALUES_RUNTIME") {
          const runtimePlanConsumesJoin = joinPushdownPlan?.joinPlan.items.some((item) =>
            item.targetAlias === joinAlias
          ) || joinPushdownPlan?.joinPlan.serverFunctionConsumptions.some((consumption) =>
            consumption.targetAlias === joinAlias
          );
          if (runtimePlanConsumesJoin) continue;
        }
        const queries = buildJoinKeyPrefilterQueries(plan, joinField, sqlQuote);
        const additionalCondition = resolvedPushdownPlan.joinConditions.get(joinAlias);
        const additionalQuery = additionalCondition
          ? whereToKintone(additionalCondition)
          : undefined;
        const additionalRelation = resolvedPushdownPlan.joinRelations.get(joinAlias);
        joinKeyPlans.set(joinAlias, { plan, queries, additionalQuery, additionalRelation });
      }
      if (joinKeyPlans.size > 0) explainJoinKeyPrefilters.set(select, joinKeyPlans);
      // EXPLAIN は実行 planner と同じ ORDER 意味型も解決する。STATUS なら status.json 依存も記録される。
      if (select.orderBy.length > 0
        || select.columns.some((column) => column.type === "WINDOW_COL" && column.orderBy.length > 0)) {
        const meta = await buildOrderByMetaForSelect(select, tracedClient, cacheContext);
        if (select.orderMode !== "KINTONE_NATIVE") {
          for (const semantics of meta.semantics.values()) {
            if (semantics.fieldType === "STATUS" && semantics.source) {
              processStatusApps.add(semantics.source.appId);
            }
          }
        }
        // batch EXPLAIN は temp/CTE の実体化前には列意味型を確定できない。
        // 実行時 planner は materialized metadata を受けて同じ検査を行う。
        if (hasCanonicalOrder(select) && !hasUnmaterializedSource && relativeNode?.allowed !== false) {
          const mode = capability.capability === "EXACT_PUSHDOWN"
            ? resolveSelectMode(select)
            : "FULL_SCAN";
          orderPlans.set(select, (select.orderMode === "KINTONE_NATIVE" ? planKorder : planCanonicalOrder)({
            stmt: select,
            staticMode: mode,
            whereCapability: capability.capability,
            whereReasons: capability.reasons,
            orderSemantics: meta.semantics,
            maxRecords,
            hasKlike: whereHasKlike(select.where),
          }));
        }
      }
    } else if (typed["type"] === "VALIDATE") {
      const validate = node as ValidateStatement;
      fieldApps.add(validate.appId);
      const fields = await getFieldsCached(validate.appId, tracedClient, cacheContext);
      const infoByCode = new Map(fields.filter((field) => !field.inSubtable).map((field) => [field.code, field]));
      const childCodes = new Set(fields.filter((field) => field.inSubtable).map((field) => field.code));
      const targets = resolveExistingValidationTargets(validate, fields);
      const checks = collectCheckFieldRefs(validate.checkGroups ?? []);
      const whereFields = collectValidateWhereFields(validate.where);
      for (const ref of checks) {
        if (ref.field !== "$id" && !infoByCode.has(ref.field) && !childCodes.has(ref.field)) {
          throw customCheckParseError(`CHECK のフィールド ${ref.field} は APP${validate.appId} に存在しません`);
        }
        if (ref.field !== "$id" && !infoByCode.has(ref.field) && childCodes.has(ref.field)) {
          throw new Error(`ArgumentError: VALIDATE の CHECK ではサブテーブル子フィールド ${ref.field} を参照できません。`);
        }
      }
      for (const field of whereFields) {
        if (field !== "$id" && !infoByCode.has(field) && !childCodes.has(field)) {
          throw new Error(`ArgumentError: WHERE field ${field} does not exist in APP${validate.appId}.`);
        }
        if (field !== "$id" && !infoByCode.has(field) && childCodes.has(field)) {
          throw new Error(`ArgumentError: VALIDATE の WHERE ではサブテーブル子フィールド ${field} を参照できません。`);
        }
      }
      const types = new Map([...infoByCode].map(([code, field]) => [code, field.fieldType]));
      types.set("$id", "RECORD_NUMBER");
      assertCheckComparisonTypes(validate, types);
      const capability = classifyWhereCapability(validate.where, (field) => field.field === "$id"
        ? resolveFieldSemantics({ fieldType: "__ID__" })
        : infoByCode.get(field.field)?.semantics ?? (infoByCode.has(field.field)
          ? resolveFieldSemantics(infoByCode.get(field.field)!)
          : undefined));
      if (capability.capability === "UNSUPPORTED") {
        throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(capability)}).`);
      }
      const fieldTypes = new Map([...infoByCode].map(([code, field]) => [code, field.fieldType]));
      const fieldOptions = new Map([...infoByCode.values()].flatMap((field) => field.optionOrder
        ? [[field.code, new Set(Object.keys(field.optionOrder))] as const]
        : []));
      const prefilter = validate.where === null
        ? null
        : capability.capability === "EXACT_PUSHDOWN"
          ? validate.where
          : extractSafePushdownLeaves(validate.where, {
              allowUnqualifiedFields: true,
              fieldTypes,
              fieldOptions,
              allowKlike: false,
            });
      const needsPrecision = targets.some((target) => target.field.fieldType === "NUMBER");
      if (needsPrecision) {
        numberPrecisionApps.add(validate.appId);
        await getNumberPrecisionCached(validate.appId, tracedClient, cacheContext);
      }
      validateExplainInfo.set(validate, {
        targetFields: targets.map((target) => target.subtableCode ? `${target.subtableCode}(${target.field.code})` : target.field.code),
        fetchFields: [...new Set(["$id", ...targets.map((target) => target.subtableCode ?? target.field.code), ...whereFields, ...checks.map((ref) => ref.field)])],
        subtables: new Map([...new Set(targets.flatMap((target) => target.subtableCode ? [target.subtableCode] : []))]
          .map((table) => [table, targets.filter((target) => target.subtableCode === table).length])),
        capability,
        prefilter,
        numberPrecision: needsPrecision,
      });
    } else if (typed["type"] === "UPDATE" || typed["type"] === "DELETE") {
      fieldApps.add((node as UpdateStatement | DeleteStatement).appId);
      if (typed["type"] === "UPDATE" && (node as UpdateStatement).applyBlocks?.length) {
        const update = node as UpdateStatement;
        const fields = await getFieldsCached(update.appId, tracedClient, cacheContext);
        resolveApplyPatchMetadata(update, fields);
        if (usesApplyParentResidualSelection(update)) {
          const topLevel = fields.filter((field) => !field.inSubtable);
          const selectionPlan = buildApplyParentSelectionPlan(update.where, {
            fieldTypes: new Map(topLevel.map((field) => [field.code, field.fieldType])),
            fieldOptions: new Map(topLevel.flatMap((field) => field.optionOrder
              ? [[field.code, new Set(Object.keys(field.optionOrder))] as const]
              : [])),
          });
          applyParentExplainPlan.set(update, selectionPlan);
        }
      }
      const dml = node as UpdateStatement | DeleteStatement;
      if ((dml.type !== "UPDATE" || !usesApplyParentResidualSelection(dml))
        && relativeNodeFor(dml)?.allowed !== false) {
        await assertDmlWhereCapability(dml, tracedClient, cacheContext);
      }
    }
    await Promise.all(Object.values(typed).map(visit));
  };

  await visit(query);
  if (typeof query === "object" && query !== null && (query as { type?: string }).type === "WITH"
    && canInlineSingleCte(query as WithStatement)) {
    const inlined = buildInlinedQuery(query as WithStatement);
    const { resolver, rewrites } = await normalizeSelectChoiceEquality(
      inlined, tracedClient, cacheContext
    );
    if (rewrites.length > 0) explainChoiceEqualityRewrites.set(inlined, rewrites);
    const capability = classifyWhereCapability(inlined.where, resolver);
    const relativeNode = relativeNodeFor(inlined);
    if (capability.capability === "UNSUPPORTED" && !relativeNode) {
      throw new Error(`ArgumentError: WHERE predicate is unsupported (${formatWhereCapabilityFailure(capability)}).`);
    }
    capabilities.set(inlined, capability);
    if (hasCanonicalOrder(inlined) && relativeNode?.allowed !== false) {
      const meta = await buildOrderByMetaForSelect(inlined, tracedClient, cacheContext);
      orderPlans.set(inlined, (inlined.orderMode === "KINTONE_NATIVE" ? planKorder : planCanonicalOrder)({
        stmt: inlined,
        staticMode: capability.capability === "EXACT_PUSHDOWN" ? resolveSelectMode(inlined) : "FULL_SCAN",
        whereCapability: capability.capability,
        whereReasons: capability.reasons,
        orderSemantics: meta.semantics,
        maxRecords,
        hasKlike: whereHasKlike(inlined.where),
      }));
    }
  }
  return {
    capabilities,
    orderPlans,
    plainGroupByPlans,
    fieldApps,
    processStatusApps,
    numberPrecisionApps,
    relativeDatePlan: sharedRelativeDatePlan,
  };
}

function explainMetadataLines(analysis: ExplainWhereAnalysis): string[] {
  return [
    ...[...analysis.fieldApps].sort((a, b) => a - b)
      .map((appId) => `  metadata API: form definition APP${appId}`),
    ...[...analysis.processStatusApps].sort((a, b) => a - b)
      .map((appId) => `  metadata API: process status APP${appId}`),
    ...[...analysis.numberPrecisionApps].sort((a, b) => a - b)
      .map((appId) => `  metadata API: number precision APP${appId}`),
  ];
}

function renderResidualOperator(op: unknown): string {
  switch (op) {
    case "NOT_LIKE": return "NOT LIKE";
    case "NOT_KLIKE": return "NOT KLIKE";
    case "NOT_IN": return "NOT IN";
    case "LIKE":
    case "KLIKE":
    case "IN":
    case "=":
    case "!=":
    case "<>":
    case ">":
    case "<":
    case ">=":
    case "<=":
      return op;
    default:
      return "<op>";
  }
}

function relativeReasonOperator(op: string): string {
  return op === "<>" ? "!=" : op;
}

function renderResidualValue(node: unknown): string {
  if (node === null || typeof node !== "object") return "<expr>";
  const value = node as Record<string, unknown>;
  switch (value["type"]) {
    case "FIELD":
      return typeof value["field"] === "string"
        ? `${typeof value["tableAlias"] === "string" ? `${value["tableAlias"]}.` : ""}${value["field"]}`
        : "<expr>";
    case "FIELD_REF":
      return typeof value["field"] === "string" ? value["field"] : "<expr>";
    case "NUMBER":
      return typeof value["raw"] === "string"
        ? value["raw"]
        : typeof value["value"] === "number" ? String(value["value"]) : "<expr>";
    case "STRING":
      return typeof value["value"] === "string"
        ? `'${value["value"].replace(/'/g, "''")}'`
        : "<expr>";
    case "VARIABLE":
      return typeof value["name"] === "string" ? `@${value["name"]}` : "<expr>";
    case "VARIABLE_IN_LIST":
      return typeof value["name"] === "string" ? `@${value["name"]}` : "<expr>";
    case "STRING_FUNC": {
      if (typeof value["func"] !== "string" || !Array.isArray(value["args"])) return "<expr>";
      return `${value["func"]}(${value["args"].map(renderResidualValue).join(", ")})`;
    }
    case "FUNC_FIELD":
    case "ARITH_FIELD":
    case "CASE_FIELD":
    case "ARITH_VALUE":
    case "CASE_VALUE":
      return renderResidualValue(value["expr"]);
    case "GROUPING_FIELD":
      return `GROUPING(${renderResidualValue(value["ref"])})`;
    case "GROUPING_REF":
      return renderResidualValue(value["field"]);
    case "ARITH":
    case "SCALAR_ARITH":
    case "CONCAT_OP":
      return `(${renderResidualValue(value["left"])} ${
        typeof value["op"] === "string"
          ? value["op"]
          : value["type"] === "CONCAT_OP" ? "||" : "<op>"
      } ${renderResidualValue(value["right"])})`;
    case "KINTONE_FUNC":
      return typeof value["name"] === "string"
        ? value["name"] === "LOGINUSER" ? "LOGINUSER()" : `${value["name"]}(...)`
        : "<expr>";
    case "IN_LIST":
      return Array.isArray(value["values"])
        ? `(${value["values"].map(renderResidualValue).join(", ")})`
        : "<expr>";
    case "ARRAY":
      return Array.isArray(value["elements"])
        ? `[${value["elements"].map(renderResidualValue).join(", ")}]`
        : "<expr>";
    case "CASE":
    case "CASE_WHEN":
      return "CASE ... END";
    default:
      return "<expr>";
  }
}

/**
 * Phase2 EXPLAIN 専用の診断 renderer。
 * REST query の生成には使わず、未知の AST shape でも必ず安全な表示へ退避する。
 */
export function renderRelativeDateResidualWhere(where: WhereExpr): string {
  try {
    const node = where as unknown as Record<string, unknown>;
    switch (node["type"]) {
      case "BINARY":
        return `${renderResidualValue(node["left"])} ${renderResidualOperator(node["op"])} ${
          renderResidualValue(node["right"])
        }`;
      case "NULL_CHECK":
        return `${renderResidualValue(node["field"])} IS ${
          node["not"] === true ? "NOT " : ""
        }NULL`;
      case "LOGICAL":
        return `(${renderRelativeDateResidualWhere(node["left"] as WhereExpr)} ${
          node["op"] === "AND" || node["op"] === "OR" ? node["op"] : "<op>"
        } ${renderRelativeDateResidualWhere(node["right"] as WhereExpr)})`;
      case "NOT":
        return `NOT (${renderRelativeDateResidualWhere(node["expr"] as WhereExpr)})`;
      case "GROUP":
        return `(${renderRelativeDateResidualWhere(node["expr"] as WhereExpr)})`;
      case "BOOLEAN":
        return node["value"] === true ? "TRUE" : node["value"] === false ? "FALSE" : "<expr>";
      default:
        return "<expr>";
    }
  } catch {
    return "<expr>";
  }
}

function relativeDateExplainLines(plan: RelativeDatePushdownPlan): string[] {
  if (!plan.hasServerOnlyWhereFunction) return [];
  if (!plan.allowed && plan.rejection) {
    const label = isRelativeDateFunctionName(plan.rejection.functionName)
      ? "relative date function"
      : "kintone function";
    const rejectedNode = plan.nodes[plan.nodes.length - 1];
    const detail = rejectedNode?.capability?.reasons.find((reason) =>
      reason.functionName === plan.rejection!.functionName
    );
    const target = rejectedNode
      ? findServerFunctionExplainTarget(rejectedNode.source, plan.rejection.functionName)
      : null;
    return [
      `  ${label}: ${plan.rejection.functionName}`,
      "  plan status: rejected",
      `  target alias / field: ${target?.alias ?? "(unknown)"} / ${
        detail?.field ?? target?.field ?? "(unknown)"
      }`,
      `  reason: ${plan.rejection.reasonCodes.join(", ")}`,
      "  client evaluation: forbidden",
      "  records/cursor/mutation API during EXPLAIN: none",
    ];
  }

  const lines: string[] = [];
  for (const node of plan.nodes) {
    const joinServerFunctionPlan = node.joinServerFunctionPlan;
    if (
      node.allowed
      && node.allowForm === "JOIN_SERVER_FUNCTION_EXACT"
      && joinServerFunctionPlan
    ) {
      const variant = node.joinServerFunctionVariant === "WHOLE_WHERE_EXACT"
        ? "whole-WHERE"
        : "leaf";
      lines.push(
        `  allow form: JOIN_SERVER_FUNCTION_EXACT (${variant})`
      );
      for (const consumption of joinServerFunctionPlan.serverFunctionConsumptions) {
        for (const leaf of consumption.functionLeaves) {
          const functionName = serverFunctionNameOfExplainLeaf(leaf);
          const field = leaf.left.type === "FIELD" ? leaf.left.field : "(unknown)";
          lines.push(
            `  ${serverFunctionLabel(functionName)}: ${functionName}`,
            `  ${serverFunctionEvaluationLabel(functionName)}: kintone server exact JOIN prefilter`,
            `  target alias / APP: ${consumption.targetAlias} / APP${consumption.appId}`,
            `  field: ${field}`,
            `  function leaf relation: ${consumption.relation}`,
            `  consumption: ${consumption.consumption}`
          );
        }
      }
      lines.push(
        `  client residual: ${
          joinServerFunctionPlan.residualWhere === null
            ? "(none)"
            : renderRelativeDateResidualWhere(joinServerFunctionPlan.residualWhere)
        }`
      );
      if (joinServerFunctionPlan.adoptedServerFunctionOccurrences.some(
        isRelativeDateFunctionName
      )) {
        lines.push("  relative date client evaluations: 0");
      }
      if (joinServerFunctionPlan.adoptedServerFunctionOccurrences.some(
        (name) => !isRelativeDateFunctionName(name)
      )) {
        lines.push("  kintone function client evaluations: 0");
      }
      continue;
    }
    const fullScanExactPlan = node.fullScanExactPlan;
    if (
      node.allowed
      && node.allowForm === "FULL_SCAN_EXACT"
      && fullScanExactPlan
    ) {
      for (const leaf of fullScanExactPlan.prefilterPlan.exactRelativeLeaves) {
        const functionName = serverFunctionNameOfExplainLeaf(leaf);
        const field = leaf.left.type === "FIELD" ? leaf.left.field : undefined;
        const operator = relativeReasonOperator(leaf.op);
        const detail = node.capability?.reasons.find((reason) =>
          reason.functionName === functionName
          && (field === undefined || reason.field === field)
          && reason.operator === operator
        );
        lines.push(
          `  ${serverFunctionLabel(functionName)}: ${functionName}`,
          `  ${serverFunctionEvaluationLabel(functionName)}: kintone server whole-WHERE exact`,
          `  field: ${detail?.field ?? field ?? "(unknown)"} (${detail?.fieldType ?? "unknown"})`,
          `  operator: ${detail?.operator ?? operator}`
        );
      }
      // 実行時に node へ確定済みの plan をそのまま表示し、EXPLAIN 側では再計画しない。
      const wholeWhereQuery = fullScanExactPlan.serializedWholeWhere;
      lines.push(
        "  where capability: EXACT_PUSHDOWN",
        `  server predicate: ${wholeWhereQuery}`,
        "  client residual: (none)",
        `  ${serverFunctionClientEvaluationLabel(
          fullScanExactPlan.prefilterPlan.exactRelativeLeaves
        )}: 0`,
        `  kintone query: ${wholeWhereQuery}`
      );
      continue;
    }
    const prefilterPlan = node.prefilterPlan;
    if (
      node.allowed
      && prefilterPlan?.prefilterWhere
      && prefilterPlan.residualWhere
    ) {
      for (const leaf of prefilterPlan.exactRelativeLeaves) {
        const functionName = serverFunctionNameOfExplainLeaf(leaf);
        const field = leaf.left.type === "FIELD" ? leaf.left.field : undefined;
        const operator = relativeReasonOperator(leaf.op);
        const detail = node.capability?.reasons.find((reason) =>
          reason.functionName === functionName
          && (field === undefined || reason.field === field)
          && reason.operator === operator
        );
        lines.push(
          `  ${serverFunctionLabel(functionName)}: ${functionName}`,
          `  ${serverFunctionEvaluationLabel(functionName)}: kintone server exact prefilter`,
          `  field: ${detail?.field ?? field ?? "(unknown)"} (${detail?.fieldType ?? "unknown"})`,
          `  operator: ${detail?.operator ?? operator}`
        );
      }
      const serverPrefilter = whereToKintone(prefilterPlan.prefilterWhere);
      lines.push(
        "  where capability: SUPERSET_PREFILTER",
        `  server prefilter: ${serverPrefilter}`,
        `  client residual: ${renderRelativeDateResidualWhere(prefilterPlan.residualWhere)}`,
        `  ${serverFunctionClientEvaluationLabel(prefilterPlan.exactRelativeLeaves)}: 0`,
        `  kintone query: ${serverPrefilter}`
      );
      continue;
    }
    for (const functionName of node.functionNames) {
      const detail = node.capability?.reasons.find((reason) =>
        reason.functionName === functionName
      );
      if (!isRelativeDateFunctionName(functionName)) {
        lines.push(
          `  kintone function: ${functionName}`,
          "  kintone function evaluation: kintone server",
          `  field: ${detail?.field ?? "(unknown)"} (${detail?.fieldType ?? "unknown"})`,
          `  operator: ${detail?.operator ?? "(unknown)"}`,
          `  where capability: ${node.capability?.capability ?? "(unknown)"}`,
          "  client residual: (none)",
          "  kintone function client evaluations: 0",
          `  kintone query: ${node.restQuery || "(なし)"}`
        );
        continue;
      }
      lines.push(
        `  relative date function: ${functionName}`,
        "  evaluation: kintone server",
        `  field: ${detail?.field ?? "(unknown)"} (${detail?.fieldType ?? "unknown"})`,
        `  operator: ${detail?.operator ?? "(unknown)"}`,
        `  where capability: ${node.capability?.capability ?? "(unknown)"}`,
        "  client evaluation: forbidden",
        `  kintone query: ${node.restQuery || "(なし)"}`
      );
    }
  }
  return lines;
}

function findServerFunctionExplainTarget(
  source: RelativeDatePlanNode["source"],
  functionName: string
): { readonly alias: string | null; readonly field: string } | null {
  const where = "where" in source ? source.where : null;
  let found: { readonly alias: string | null; readonly field: string } | null = null;
  const visit = (value: unknown): void => {
    if (found || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node["type"] === "BINARY") {
      const left = node["left"] as Record<string, unknown> | undefined;
      const right = node["right"] as Record<string, unknown> | undefined;
      const directlyMatches = right?.["type"] === "KINTONE_FUNC"
        && right["name"] === functionName;
      const listMatches = right?.["type"] === "IN_LIST"
        && Array.isArray(right["values"])
        && right["values"].some((entry) =>
          entry !== null
          && typeof entry === "object"
          && (entry as Record<string, unknown>)["type"] === "KINTONE_FUNC"
          && (entry as Record<string, unknown>)["name"] === functionName
        );
      if (
        (directlyMatches || listMatches)
        && left?.["type"] === "FIELD"
        && typeof left["field"] === "string"
      ) {
        found = {
          alias: typeof left["tableAlias"] === "string" ? left["tableAlias"] : null,
          field: left["field"],
        };
        return;
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(where);
  return found;
}

function serverFunctionLabel(functionName: string): string {
  return isRelativeDateFunctionName(functionName)
    ? "relative date function"
    : "kintone function";
}

function serverFunctionNameOfExplainLeaf(leaf: BinaryExpr): string {
  if (leaf.right.type === "KINTONE_FUNC") return leaf.right.name;
  if (
    leaf.right.type === "IN_LIST"
    && leaf.right.values.length === 1
    && leaf.right.values[0].type === "KINTONE_FUNC"
  ) {
    return leaf.right.values[0].name;
  }
  return "(unknown)";
}

function serverFunctionEvaluationLabel(functionName: string): string {
  return isRelativeDateFunctionName(functionName)
    ? "relative date evaluation"
    : "kintone function evaluation";
}

function serverFunctionClientEvaluationLabel(
  leaves: readonly BinaryExpr[]
): string {
  return leaves.every((leaf) =>
    leaf.right.type === "KINTONE_FUNC"
    && isRelativeDateFunctionName(leaf.right.name)
  )
    ? "relative date client evaluations"
    : "kintone function client evaluations";
}

// ------------------------------------------------------------
// バッチ EXPLAIN（フェーズ2 M3）
// 全文のプランを配列で返す（dry-run 用途。schema-aware 形は metadata API のみ使用）。
// 一時テーブル参照文は既存の buildSelectPlan に通さず temp-aware に組む
// （resolveSelectMode が cteName 参照を SIMPLE と誤判定し APP0 表示になるため）。
// ------------------------------------------------------------

export interface BatchStatementPlan {
  index: number;
  type: string;
  plan: string[];
}

type ExplainFetchValue = "none" | "count_only" | "exact" | "prefiltered" | "all";
type ExplainFetchRole = "main" | "join" | "union" | "cte" | "subquery";

interface ExplainFetchSourcePlan {
  app: number;
  alias: string | null;
  role: ExplainFetchRole;
  fetch: ExplainFetchValue;
  pending: boolean;
  kintoneQuery: string | null;
  limit: number | null;
}

interface ExplainFetchStatementPlan {
  index: number;
  fetch: ExplainFetchValue;
  sources: ExplainFetchSourcePlan[];
}

interface ExplainFetchPlan {
  statements: ExplainFetchStatementPlan[];
}

interface ExplainFetchCollector {
  sources: ExplainFetchSourcePlan[];
}

interface ExplainSeriesBinding {
  readonly variableNames: ReadonlyMap<number, string>;
  readonly defaultBoundIndexes: ReadonlySet<number>;
}

const explainSeriesBindings = new WeakMap<GenerateSeriesStatement, ExplainSeriesBinding>();

type ExplainTempSchemaEntry =
  | {
      readonly status: "STATIC";
      readonly columns: readonly string[];
      readonly relation: MaterializedTable;
      readonly producerStatement: number;
    }
  | {
      readonly status: "DEFERRED";
      readonly producerStatement: number;
      readonly reason: "EXPLAIN_TEMP_SCHEMA_UNAVAILABLE";
    };

type ExplainStaticSchema =
  | { readonly status: "STATIC"; readonly columns: readonly string[] }
  | { readonly status: "DEFERRED" };

/**
 * 通常の EXPLAIN 変数解決後に、系列引数だけを条件付き既定値へ差し替える。
 * 既定値を使えない引数は VARIABLE に戻し、値依存検査を deferred に保つ。
 */
function resolveExplainGenerateSeriesDefaults<T>(
  node: T,
  literalDefaults: ReadonlyMap<string, string>
): T {
  if (Array.isArray(node)) {
    return node.map((value) => resolveExplainGenerateSeriesDefaults(value, literalDefaults)) as T;
  }
  if (node === null || typeof node !== "object") return node;
  const object = node as Record<string, unknown>;
  if (object["type"] === "GENERATE_SERIES") {
    const variableNames = new Map<number, string>();
    const defaultBoundIndexes = new Set<number>();
    const args = (object["args"] as GenerateSeriesStatement["args"]).map((arg, index) => {
      if (arg.type !== "STRING" || arg.fromVariable !== true || !arg.value.startsWith("@")) return arg;
      const name = arg.value.slice(1);
      variableNames.set(index, name);
      const defaultValue = literalDefaults.get(name);
      if (defaultValue === undefined) return { type: "VARIABLE", name } as const;
      defaultBoundIndexes.add(index);
      return { type: "STRING", value: defaultValue, fromVariable: true } as const;
    });
    const resolved = { ...object, args } as unknown as GenerateSeriesStatement;
    explainSeriesBindings.set(resolved, { variableNames, defaultBoundIndexes });
    return resolved as T;
  }
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [
    key,
    resolveExplainGenerateSeriesDefaults(value, literalDefaults),
  ])) as T;
}

function inferStaticExplainSchema(
  node: SelectStatement | UnionStatement | WithStatement | GenerateSeriesStatement
    | ShowAppsStatement | DescribeStatement,
  relations: ReadonlyMap<string, ExplainStaticSchema>
): ExplainStaticSchema {
  if (node.type === "SHOW_APPS") return { status: "STATIC", columns: [...SHOW_APPS_COLUMNS] };
  if (node.type === "DESCRIBE") return { status: "STATIC", columns: [...DESCRIBE_COLUMNS] };
  if (node.type === "GENERATE_SERIES") {
    return { status: "STATIC", columns: [node.columnAlias] };
  }
  if (node.type === "WITH") {
    const local = new Map(relations);
    for (const cte of node.ctes) {
      const schema = inferStaticExplainSchema(cte.query, local);
      local.set(cte.name, schema);
    }
    return inferStaticExplainSchema(node.query, local);
  }
  if (node.type === "UNION") {
    const left = inferStaticExplainSchema(node.left, relations);
    const right = inferStaticExplainSchema(node.right, relations);
    return left.status === "STATIC" && right.status === "STATIC"
      ? { status: "STATIC", columns: left.columns }
      : { status: "DEFERRED" };
  }

  const sources = [node.from, ...node.joins.map((join) => join.table)];
  const relationSources = sources.filter((source) => source.cteName !== null && source.cteName !== NO_FROM_CTE_NAME);
  if (relationSources.some((source) => relations.get(source.cteName!)?.status !== "STATIC")) {
    return { status: "DEFERRED" };
  }
  const hasWildcard = node.columns.some((column) =>
    column.type === "WILDCARD" || column.type === "PARENT_WILDCARD"
  );
  if (hasWildcard) {
    if (sources.length !== 1 || sources[0].cteName === null) return { status: "DEFERRED" };
  }
  const sourceColumns = relationSources.flatMap((source) => {
    const schema = relations.get(source.cteName!);
    return schema?.status === "STATIC" ? [...schema.columns] : [];
  });
  const columns: string[] = [];
  for (const column of node.columns) {
    if (column.type === "WILDCARD") columns.push(...sourceColumns);
    else if (column.type === "PARENT_WILDCARD") {
      columns.push(...sourceColumns.filter((name) => name.startsWith("_p.")));
    } else {
      columns.push(...project([], [column]).columns);
    }
  }
  return { status: "STATIC", columns };
}

function staticSchemaRelations(
  ledger: ReadonlyMap<string, ExplainTempSchemaEntry>
): Map<string, MaterializedTable> {
  return new Map([...ledger].flatMap(([name, entry]) =>
    entry.status === "STATIC" ? [[name, entry.relation] as const] : []
  ));
}

async function buildStaticTempPlainGroupByPlans(
  node: unknown,
  client: KintoneClient,
  cacheContext: string,
  relations: ReadonlyMap<string, MaterializedTable>
): Promise<Map<SelectStatement, PlainGroupByResolutionPlan>> {
  const plans = new Map<SelectStatement, PlainGroupByResolutionPlan>();
  const visit = async (value: unknown): Promise<void> => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) await visit(child);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object["type"] === "SELECT") {
      const select = value as SelectStatement;
      const sources = [select.from, ...select.joins.map((join) => join.table)];
      if (sources.some((source) => source.cteName !== null)
        && sources.every((source) => source.cteName === NO_FROM_CTE_NAME
          || (source.cteName !== null && relations.has(source.cteName)))) {
        const plan = await buildRuntimePlainGroupByPlan(select, client, cacheContext, relations);
        if (plan) plans.set(select, plan);
      }
    }
    for (const child of Object.values(object)) await visit(child);
  };
  await visit(node);
  return plans;
}

const EXPLAIN_FETCH_PLAN = Symbol("ksql.explainFetchPlan");
type ExplainFetchPlanCarrier = {
  [EXPLAIN_FETCH_PLAN]?: ExplainFetchPlan;
};

/** engine ライブラリ境界だけが読む。既存の CLI / MCP payload には追加しない。 */
export function getExplainFetchPlan(result: object): ExplainFetchPlan | undefined {
  return (result as ExplainFetchPlanCarrier)[EXPLAIN_FETCH_PLAN];
}

function setExplainFetchPlan(result: object, plan: ExplainFetchPlan): void {
  (result as ExplainFetchPlanCarrier)[EXPLAIN_FETCH_PLAN] = plan;
}

type BatchExplainResult = {
  statementCount: number;
  statements: BatchStatementPlan[];
};

/** schema-aware planner 形。metadata API 以外の実行 API は呼ばない。 */
export async function buildBatchExplainPlans(
  sql: string,
  client: KintoneClient,
  injectedVariables?: Readonly<Record<string, string>>,
  cacheContext = "batch-explain",
  maxRecords = 10_000,
  cursorMaxActive = 2,
  enableImport = false,
  dmlMaxRows = 100,
  dmlMaxSubtableRows = DEFAULT_APPLY_MAX_SUBTABLE_ROWS,
  resolveMetadata = true,
  recursiveCteMaxDepth?: number,
  recursiveCteMaxRows?: number,
  recursiveCteMaxExpansions?: number
): Promise<BatchExplainResult> {
  const recursiveLimits = resolveRecursiveCteLimits({
    recursiveCteMaxDepth, recursiveCteMaxRows, recursiveCteMaxExpansions,
  });
  const invocationCacheContext = createInvocationCacheContext(cacheContext);
  try {
    const { statements } = parseSqlStatementsForScript(sql, { import: enableImport });
    const analysis = analyzeBatch(statements); // 未定義参照等はここで拒否
    const normalizedInjectedVariables = validateDeclaredBatchVariables(statements, injectedVariables);
    const relativeDateVariables = prepareRelativeDateVariables(statements, normalizedInjectedVariables);
    const variables = new Map<string, VarValue>();
    const literalDeclareDefaults = new Map<string, string>();
    const tempSchemaLedger = new Map<string, ExplainTempSchemaEntry>();
    const plans: BatchStatementPlan[] = [];
    const fetchStatements: ExplainFetchStatementPlan[] = [];
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const placeholderResolvedStmt = stmt.type === "SET_VARIABLE"
        ? (stmt.expr.type === "SCALAR_SUBQUERY"
          ? { ...stmt, expr: resolveBatchVariableReferences(stmt.expr, variables) }
          : stmt)
        : resolveBatchVariableReferences(stmt, variables);
      const planStmt = resolveExplainGenerateSeriesDefaults(
        placeholderResolvedStmt,
        literalDeclareDefaults
      );
      validateStatementStatic(planStmt);
      const relativeDatePlan = await resolveRelativeDateExecutionPlan(planStmt, client, invocationCacheContext);
      const initialRelations = staticSchemaRelations(tempSchemaLedger);
      const whereAnalysis = resolveMetadata
        ? await buildExplainWhereAnalysis(
            planStmt,
            client,
            invocationCacheContext,
            maxRecords,
            relativeDatePlan,
            initialRelations
          )
        : {
            capabilities: new Map<SelectStatement, PredicateCapabilityResult>(),
            orderPlans: new Map<SelectStatement, CanonicalOrderPlan>(),
            plainGroupByPlans: new Map<SelectStatement, PlainGroupByResolutionPlan>(),
            fieldApps: new Set<number>(),
            processStatusApps: new Set<number>(),
            numberPrecisionApps: new Set<number>(),
            relativeDatePlan,
          };
      if (!resolveMetadata) {
        const staticPlans = await buildStaticTempPlainGroupByPlans(
          planStmt,
          client,
          invocationCacheContext,
          initialRelations
        );
        for (const [select, plan] of staticPlans) whereAnalysis.plainGroupByPlans.set(select, plan);
      }
      let createdSchema: ExplainTempSchemaEntry | undefined;
      if (planStmt.type === "CREATE_TEMP_TABLE") {
        const relationSchemas = new Map<string, ExplainStaticSchema>([...tempSchemaLedger].map(([name, entry]) => [
          name,
          entry.status === "STATIC"
            ? { status: "STATIC", columns: entry.columns }
            : { status: "DEFERRED" },
        ]));
        const inferred = inferStaticExplainSchema(planStmt.query, relationSchemas);
        createdSchema = inferred.status === "STATIC"
          ? {
              status: "STATIC",
              columns: inferred.columns,
              relation: { rows: [], columns: [...inferred.columns] },
              producerStatement: i + 1,
            }
          : {
              status: "DEFERRED",
              producerStatement: i + 1,
              reason: "EXPLAIN_TEMP_SCHEMA_UNAVAILABLE",
            };
        tempSchemaLedger.set(planStmt.name, createdSchema);
      }
      const fetchCollector: ExplainFetchCollector = { sources: [] };
      const statementPlan =
        relativeDatePlan.hasServerOnlyWhereFunction && !relativeDatePlan.allowed
        ? relativeDateExplainLines(relativeDatePlan)
        : [
            ...relativeDateExplainLines(relativeDatePlan),
            ...addCursorConcurrency(buildBatchStatementPlan(
              planStmt,
              analysis.statements[i],
               whereAnalysis.capabilities,
               whereAnalysis.orderPlans,
               whereAnalysis.plainGroupByPlans,
               dmlMaxRows,
               dmlMaxSubtableRows,
               fetchCollector,
               tempSchemaLedger,
                createdSchema,
                { maxRecords, recursiveLimits }
             ), cursorMaxActive),
          ];
      const metadataPlan = explainMetadataLines(whereAnalysis);
      plans.push({
        index: i,
        type: analysis.statements[i].statementType,
        plan: statementPlan.length === 0
          ? metadataPlan
          : [statementPlan[0], ...metadataPlan, ...statementPlan.slice(1)],
      });
      fetchStatements.push({
        index: i,
        fetch: worstExplainFetch(fetchCollector.sources),
        sources: fetchCollector.sources,
      });
      if (planStmt.type === "DROP_TEMP_TABLE") tempSchemaLedger.delete(planStmt.name);
      if (stmt.type === "SET_VARIABLE" || stmt.type === "DECLARE_VARIABLE") {
        // EXPLAIN は関数を評価しない。後続プランでは名前を値プレースホルダーとして使う。
        variables.set(stmt.name, stmt.type === "DECLARE_VARIABLE" && stmt.annotation === "RELATIVE_DATE"
          ? { type: "relative-date", value: relativeDateVariables.get(stmt.name)! }
          : stmt.type === "SET_VARIABLE" && stmt.expr.type === "ARRAY"
          ? { type: "array", elements: stmt.expr.elements.map((element) => ({ type: "string", value: element.value })) }
           : { type: "string", value: `@${stmt.name}`, placeholder: true });
        if (stmt.type === "DECLARE_VARIABLE" && stmt.annotation === undefined
          && (stmt.default.type === "STRING" || stmt.default.type === "NUMBER")) {
          literalDeclareDefaults.set(
            stmt.name,
            stmt.default.type === "STRING" ? stmt.default.value : numberLiteralText(stmt.default)
          );
        }
      }
    }
    const result = { statementCount: statements.length, statements: plans };
    setExplainFetchPlan(result, { statements: fetchStatements });
    return result;
  } finally {
    releaseMetadataCacheScope(invocationCacheContext);
  }
}

function buildBatchStatementPlan(
  stmt: Statement,
  info: BatchAnalysis["statements"][number],
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>,
  dmlMaxRows = 100,
  dmlMaxSubtableRows = DEFAULT_APPLY_MAX_SUBTABLE_ROWS,
  collector: ExplainFetchCollector = { sources: [] },
  tempSchemaLedger: ReadonlyMap<string, ExplainTempSchemaEntry> = new Map(),
  createdSchema?: ExplainTempSchemaEntry,
  explainContext: RecursiveExplainContext = defaultRecursiveExplainContext()
): string[] {
  if (stmt.type === "CREATE_TEMP_TABLE") {
    return [
      `CREATE TEMP TABLE ${stmt.name}`,
      `  scope:         batch（バッチ終了時に自動破棄）`,
      ...(createdSchema?.status === "STATIC" ? [
        `  schema:        ${createdSchema.columns.join(", ")}`,
        `  schema source: SELECT output of statement ${createdSchema.producerStatement}`,
      ] : createdSchema ? [
        "  schema:        deferred (could not be derived statically)",
        `  plan status:   deferred (temp table schema; reason=${createdSchema.reason})`,
      ] : []),
      `  rows:          実体化前のため不明（既定上限 ${TEMP_TABLE_MAX_ROWS} 行、tempTableMaxRows で変更可、超過はエラー）`,
      ...buildPlanForBatchQuery(
        stmt.query, info, capabilities, orderPlans, plainGroupByPlans, collector, "main",
        tempSchemaLedger, explainContext
      ).map((l) => `  ${l}`),
    ];
  }
  if (stmt.type === "DROP_TEMP_TABLE") {
    return [
      `DROP TEMP TABLE ${stmt.name}`,
      "  一時テーブルストアの解放のみ（kintone アクセスなし）",
    ];
  }
  if (stmt.type === "SET_VARIABLE") {
    if (stmt.expr.type === "SCALAR_SUBQUERY") {
      const subInfo = hasTempTableRef(stmt.expr.query)
        ? info
        : { ...info, tempTablesReferenced: [] };
      return [
        `SET @${stmt.name} = (SELECT ...)`,
        "  value:         サブクエリを実行時に1回評価（1行1列・バッチ内定数・結果メタデータには非公開）",
        "  subquery:",
        ...buildPlanForBatchQuery(
          stmt.expr.query, subInfo, capabilities, orderPlans, plainGroupByPlans, collector,
          "main", tempSchemaLedger, explainContext
        ).map((l) => `  ${l}`),
      ];
    }
    return [
      `SET @${stmt.name} = <scalar expression>`,
      "  value:         実行時に1回評価（バッチ内定数・結果メタデータには非公開）",
    ];
  }
  if (stmt.type === "DECLARE_VARIABLE") {
    if (stmt.annotation === "RELATIVE_DATE") {
      return [
        `DECLARE @${stmt.name} RELATIVE_DATE = <relative-date token>`,
        "  value:         外部注入があれば採用、なければ既定トークンを使用（値は非公開）",
      ];
    }
    return [
      `DECLARE @${stmt.name} = <default scalar expression>`,
      "  value:         外部注入があれば採用、なければ既定値を実行時に1回評価（値は非公開）",
    ];
  }
  if (stmt.type === "SHOW_APPS") return ["SHOW APPS（アプリ一覧の取得）"];
  if (stmt.type === "DESCRIBE") return [`DESCRIBE APP${stmt.appId}（フィールド定義の取得）`];
  if (stmt.type === "EXPLAIN") {
    return buildPlanForBatchQuery(
      stmt.query, info, capabilities, orderPlans, plainGroupByPlans, collector,
      "main", tempSchemaLedger, explainContext
    );
  }
  if (stmt.type === "ASSERT") {
    const lines: string[] = [
      `ASSERT${stmt.warn === true ? " WARN" : ""} ${stmt.text}${stmt.message !== undefined ? `, '${stmt.message.replace(/'/g, "''")}'` : ""}`,
      stmt.warn === true
        ? "  check:         実行時に条件評価（不成立は警告として記録し、後続文を続行）"
        : "  check:         実行時に条件評価（不成立は AssertError でバッチ停止、以降の文は skipped）",
    ];
    const subqueries = [stmt.left, stmt.right, stmt.low, stmt.high].filter(
      (o): o is ScalarSubquery => o !== null && o.type === "SCALAR_SUBQUERY"
    );
    subqueries.forEach((sq, i) => {
      lines.push(subqueries.length > 1 ? `  subquery[${i + 1}]:` : "  subquery:");
      // 参照先で経路が変わるため per-subquery に判定する
      //（temp 参照なしの側を FULL_SCAN 表示にしない）
      const subInfo = hasTempTableRef(sq.query) ? info : { ...info, tempTablesReferenced: [] };
      lines.push(...buildPlanForBatchQuery(
        sq.query, subInfo, capabilities, orderPlans, plainGroupByPlans, collector,
        "main", tempSchemaLedger, explainContext
      ).map((l) => `  ${l}`));
    });
    return lines;
  }
  if (stmt.type === "EXIT") {
    const lines: string[] = [
      `EXIT SUCCESS IF ${stmt.text}, '${stmt.message.replace(/'/g, "''")}'`,
      "  check:         実行時に条件評価（成立時は正常終了し、以降の文は skippedReason: exit）",
    ];
    const subqueries = [stmt.left, stmt.right, stmt.low, stmt.high].filter(
      (o): o is ScalarSubquery => o !== null && o.type === "SCALAR_SUBQUERY"
    );
    subqueries.forEach((sq, i) => {
      lines.push(subqueries.length > 1 ? `  subquery[${i + 1}]:` : "  subquery:");
      const subInfo = hasTempTableRef(sq.query) ? info : { ...info, tempTablesReferenced: [] };
      lines.push(...buildPlanForBatchQuery(
        sq.query, subInfo, capabilities, orderPlans, plainGroupByPlans, collector,
        "main", tempSchemaLedger, explainContext
      ).map((line) => `  ${line}`));
    });
    return lines;
  }
  if (stmt.type === "UPDATE" && (stmt.applyBlocks?.length ?? 0) > 0) {
    return buildExplainPlan(
      stmt, undefined, capabilities, orderPlans, dmlMaxRows, dmlMaxSubtableRows,
      10_000, plainGroupByPlans
    );
  }
  return buildPlanForBatchQuery(
    stmt, info, capabilities, orderPlans, plainGroupByPlans, collector, "main", tempSchemaLedger,
    explainContext
  );
}

/** AST 内に一時テーブル参照（cteName が "#" 始まり）が含まれるか */
function hasTempTableRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasTempTableRef);
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const cte = obj["cteName"];
    if (typeof cte === "string" && cte.startsWith("#")) return true;
    return Object.values(obj).some(hasTempTableRef);
  }
  return false;
}

function buildPlanForBatchQuery(
  query: Statement | ExplainStatement["query"],
  info: BatchAnalysis["statements"][number],
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>,
  collector: ExplainFetchCollector = { sources: [] },
  sourceRole: ExplainFetchRole = "main",
  tempSchemaLedger: ReadonlyMap<string, ExplainTempSchemaEntry> = new Map(),
  explainContext: RecursiveExplainContext = defaultRecursiveExplainContext()
): string[] {
  // 一時テーブル参照なし → 既存の単文プラン生成をそのまま使う
  if (info.tempTablesReferenced.length === 0) {
    return buildExplainPlan(
      query as ExplainStatement["query"], undefined, capabilities, orderPlans,
      100, DEFAULT_APPLY_MAX_SUBTABLE_ROWS, explainContext.maxRecords, plainGroupByPlans, true, collector,
      sourceRole, explainContext.recursiveLimits
    );
  }
  // 一時テーブル参照あり → FULL_SCAN（インメモリ）であることを明示する
  const lines: string[] = [];
  if (query.type === "INSERT_SELECT") {
    lines.push(
      `INSERT INTO APP${query.appId} ... SELECT（一時テーブルソース。実行時に件数確定 → dmlMaxRows 適用）`
    );
  } else if (query.type === "UPSERT_SELECT") {
    lines.push(
      `UPSERT INTO APP${query.appId} ... SELECT（一時テーブルソース。照合後に insert + update 合計確定 → dmlMaxRows 適用）`
    );
  }
  lines.push("  mode:          FULL_SCAN（一時テーブル参照）");
  lines.push(
    `  temp:          ${info.tempTablesReferenced.join(", ")}（インメモリ走査。実体化前のため行数不明）`
  );
  const entries = info.tempTablesReferenced.map((name) => [name, tempSchemaLedger.get(name)] as const);
  for (const [name, entry] of entries) {
    if (entry?.status === "STATIC") {
      lines.push(`  source:        temp table ${name} (schema from statement ${entry.producerStatement})`);
    } else {
      lines.push(`  source:        temp table ${name}`);
      lines.push("  schema:        deferred (could not be derived statically)");
    }
  }
  lines.push("  rows:          runtime (not materialized by EXPLAIN)");
  const directSelect = query.type === "SELECT"
    ? query
    : query.type === "EXPLAIN" && query.query.type === "SELECT"
      ? query.query
      : undefined;
  if (directSelect) {
    lines.push(...renderPlainGroupByExplainLines(
      directSelect,
      plainGroupByPlans?.get(directSelect),
      entries.some(([, entry]) => entry?.status !== "STATIC")
    ));
  }
  lines.push(entries.every(([, entry]) => entry?.status === "STATIC")
    ? "  plan status:   static schema / runtime rows"
    : "  plan status:   deferred (temp table schema)");
  lines.push("  records API:   none");
  const apps = info.appIds.filter(
    (a) => (query.type !== "INSERT_SELECT" && query.type !== "UPSERT_SELECT") || a !== query.appId
  );
  if (apps.length > 0) {
    lines.push(`  app:           ${apps.map((a) => `APP${a}`).join(", ")}`);
  }
  lines.push("  note:          一時テーブルへの WHERE プッシュダウンは行われない");
  return lines;
}

const explainMaterializedTables = new WeakMap<ExplainStatement, ReadonlyMap<string, MaterializedTable>>();

interface RecursiveExplainContext {
  readonly maxRecords: number;
  readonly recursiveLimits: RecursiveCteLimits;
}

function defaultRecursiveExplainContext(): RecursiveExplainContext {
  return { maxRecords: 10_000, recursiveLimits: resolveRecursiveCteLimits({}) };
}

async function executeExplain(
  stmt: ExplainStatement,
  client: KintoneClient,
  cacheContext: string,
  maxRecords: number,
  cursorMaxActive: number,
  dmlMaxRows = 100,
  dmlMaxSubtableRows = DEFAULT_APPLY_MAX_SUBTABLE_ROWS,
  /** Step 5 の execution と同じ walk 結果。Step 6 の表示拡張はこの値を消費する。 */
  relativeDatePlan?: RelativeDatePushdownPlan,
  recursiveCteMaxDepth?: number,
  recursiveCteMaxRows?: number,
  recursiveCteMaxExpansions?: number
): Promise<SelectResult> {
  const recursiveLimits = resolveRecursiveCteLimits({
    recursiveCteMaxDepth, recursiveCteMaxRows, recursiveCteMaxExpansions,
  });
  const sharedPlan = relativeDatePlan
    ?? await resolveRelativeDateExecutionPlan(stmt.query, client, cacheContext);
  const analysis = await buildExplainWhereAnalysis(
    stmt.query,
    client,
    cacheContext,
    maxRecords,
    sharedPlan,
    explainMaterializedTables.get(stmt)
  );
  const fetchCollector: ExplainFetchCollector = { sources: [] };
  const relativeLines = relativeDateExplainLines(sharedPlan);
  const planLines = sharedPlan.hasServerOnlyWhereFunction && !sharedPlan.allowed
    ? [...explainMetadataLines(analysis), ...relativeLines]
    : [
        ...explainMetadataLines(analysis),
        ...relativeLines,
        ...addCursorConcurrency(
          buildExplainPlan(
            stmt.query, undefined, analysis.capabilities, analysis.orderPlans,
            dmlMaxRows, dmlMaxSubtableRows, maxRecords, analysis.plainGroupByPlans,
            true, fetchCollector, "main", recursiveLimits
          ),
          cursorMaxActive
        ),
      ];
  const lines = addFetchSummary(planLines, fetchCollector.sources);
  const result: SelectResult = {
    type: "SELECT",
    columns: ["plan"],
    rows: lines.map((line) => ({ plan: line })),
    rowCount: lines.length,
  };
  setExplainFetchPlan(result, {
    statements: [{
      index: 0,
      fetch: worstExplainFetch(fetchCollector.sources),
      sources: fetchCollector.sources,
    }],
  });
  return result;
}

function addCursorConcurrency(lines: string[], cursorMaxActive: number): string[] {
  const result: string[] = [];
  for (const line of lines) {
    result.push(line);
    if (line.trim() === "cursor page size: 500") {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      result.push(`${indent}cursor concurrency: ${cursorMaxActive} per domain (process-local)`);
    }
  }
  return result;
}

function buildExplainPlan(
  query: ExplainStatement["query"],
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  dmlMaxRows = 100,
  dmlMaxSubtableRows = DEFAULT_APPLY_MAX_SUBTABLE_ROWS,
  maxRecords = 10_000,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>,
  includeFetchSummary = true,
  collector?: ExplainFetchCollector,
  sourceRole: ExplainFetchRole = "main",
  recursiveLimits: RecursiveCteLimits = resolveRecursiveCteLimits({})
): string[] {
  const fetchCollector = collector ?? { sources: [] };
  if (query.type === "UNION") {
    const lines = buildUnionPlan(
      query, capabilities, orderPlans, plainGroupByPlans, fetchCollector
    );
    return includeFetchSummary ? addFetchSummary(lines, fetchCollector.sources) : lines;
  }
  if (query.type === "WITH") {
    const lines = buildWithPlan(
      query, capabilities, orderPlans, plainGroupByPlans, fetchCollector,
      maxRecords, recursiveLimits
    );
    return includeFetchSummary ? addFetchSummary(lines, fetchCollector.sources) : lines;
  }
  if (query.type === "INSERT")        return buildInsertPlan(query, label, dmlMaxRows, dmlMaxSubtableRows);
  if (query.type === "INSERT_SELECT") return buildInsertSelectPlan(query, label, capabilities, orderPlans, plainGroupByPlans);
  if (query.type === "UPSERT")        return buildUpsertPlan(query, label, dmlMaxRows, dmlMaxSubtableRows);
  if (query.type === "UPSERT_SELECT") return buildUpsertSelectPlan(query, label, capabilities, orderPlans, plainGroupByPlans);
  if (query.type === "UPDATE")        return buildUpdatePlan(
    query, label, capabilities, orderPlans, dmlMaxRows, dmlMaxSubtableRows, maxRecords
  );
  if (query.type === "DELETE")        return buildDeletePlan(query, label);
  if (query.type === "REORDER")       return buildReorderPlan(query, label);
  if (query.type === "VALIDATE")      return buildValidatePlan(query, label);
  if (query.type === "IMPORT") {
    if (query.writeMode === "UPDATE_RECORD_NUMBER") {
      const csvTables = query.targets?.filter((target) => target.kind === "SUBTABLE") ?? [];
      return [
        ...(label ? [label] : []),
        `IMPORT UPDATE INTO APP${query.appId}`,
        `  writeMode:     UPDATE_RECORD_NUMBER`,
        `  source:        CSV ${query.source.sourceName}`,
        `  keyHeader:     ${query.recordNumberSourceHeader}`,
        `  mapping:       BY_NAME`,
        `  parentRows:    requires source load`,
        `  duplicate:     preflight before lookup/write`,
        `  matched:       requires lookup`,
        `  unmatched:     requires lookup`,
        `  invalid:       requires source load`,
        `  requiresLookup:true`,
        `  inserted:      0`,
        `  keyInPayload:  false`,
        ...(csvTables.length ? [
          `  replaceSubtables: ${query.replaceSubtables?.join(", ") ?? "ERROR: required"}`,
          `  subtableRowIdPolicy: PRESERVE existing; empty/unknown add without id`,
          `  rowIdOwnership: owned elsewhere invalidates the parent`,
          `  replacementDiff: existing/input/update/add/delete/rowIdNotFound requires actual-data preflight`,
          `  confirmPolicy: highest warning "サブテーブル全置換・N行削除" plus per-table detail (including delete=0)`,
        ] : []),
        `  disposition:   ${query.validateOnly ? "VALIDATE ONLY" : query.onErrorSkip ? `ON ERROR SKIP INTO ${query.errorTable}` : "fail-fast"}`,
        `  gate:          enabled for this parse`,
        `  writesKintone: ${query.validateOnly ? "false" : "true"}`,
      ];
    }
    const mode = query.keyFields ? "UPSERT" : "INSERT";
    const hasSubtables = query.targets?.some((target) => target.kind === "SUBTABLE") === true;
    return [
      ...(label ? [label] : []),
      `IMPORT ${mode} INTO APP${query.appId}`,
      `  source:        ${query.source.kind} ${query.source.sourceName}`,
      `  sourceFormat:  ${query.source.kind}`,
      `  encoding:      ${query.source.kind === "JSON" ? "UTF8 only" : query.source.encoding ?? "UTF8 (or loader metadata)"}`,
      `  mapping:       ${query.source.kind === "JSON" ? "BY NAME (INTO order)" : query.source.projection ? "SELECT expressions" : query.source.mappingMode}`,
      ...(query.source.kind === "JSON" ? [
        `  duplicateKeyPolicy: reject`,
        `  numberLexemePolicy: preserve; JSON number accepts safe integer only`,
        `  precisionTargetsRequireString: true`,
        `  unknownKeyPolicy: reject`,
        `  presenceAware: true`,
        ...(hasSubtables ? [
          `  subtableRowIdPolicy: reject _rid/id; DROP IDs and renumber every input row`,
          `  subtableUpdatePolicy: present table replaces all rows; missing table is preserved; [] deletes all rows`,
          `  confirmPolicy: parent/table existing/input/add/delete detail required; delete is highest warning`,
        ] : []),
      ] : [
        `  header:        ${query.source.hasHeader ? "HEADER" : "NO HEADER"}`,
        ...(query.source.mappingMode === "BY_NAME" ? [
          `  writtenColumns: ${query.fields.join(", ")}`,
          `  knownExportColumns: audit and ignore with reason/non-empty count`,
          `  unknownColumnPolicy: ${query.source.ignoreUnknownColumns ? "ignore with audit/non-empty count" : "ERR_IMPORT_UNKNOWN_COLUMN"}`,
          `  multipleValueDelimiter: LF (CRLF or LF)`,
          `  sourceValueMode: string-preserving`,
          `  roundTripNumericGuarantee: exact CSV lexeme passes strict decimal validation`,
          `  FILE: audit-ignore unless named in INTO (analyze error)`,
        ] : []),
      ]),
      `  sourceLimit:   10485760 bytes / ${query.fields.length} target columns`,
      `  key:           ${query.keyFields?.join(", ") ?? "none"}`,
      `  checks:        ${query.checkGroups?.length ?? 0}`,
      `  disposition:   ${query.validateOnly ? "VALIDATE ONLY" : query.onErrorSkip ? `ON ERROR SKIP INTO ${query.errorTable}` : "fail-fast"}`,
      `  gate:          enabled for this parse`,
      `  preflight:     ${query.validateOnly && hasSubtables ? "requires actual source load at execution; this EXPLAIN is static" : "requires load"}`,
      ...(hasSubtables ? [query.source.kind === "JSON"
        ? `  Phase5C:       JSON mutation requires detail-capable confirmation surface`
        : `  Phase5D:       CSV mutation requires detail-capable confirmation surface`] : []),
      `  writesKintone: ${query.validateOnly ? "false" : "true"}`,
      `  duplicateKey:  preflight before lookup/write (requires load)`,
    ];
  }
  const lines = buildSelectPlan(
    query, label, capabilities, orderPlans, plainGroupByPlans,
    true, true, fetchCollector, sourceRole
  );
  return includeFetchSummary ? addFetchSummary(lines, fetchCollector.sources) : lines;
}

type ExplainFetchScope = "NONE" | "COUNT_ONLY" | "EXACT" | "PREFILTERED" | "ALL";

const EXPLAIN_FETCH_VALUE_RANK: Readonly<Record<ExplainFetchValue, number>> = {
  none: 0,
  count_only: 1,
  exact: 2,
  prefiltered: 3,
  all: 4,
};

function worstExplainFetch(sources: readonly ExplainFetchSourcePlan[]): ExplainFetchValue {
  return sources.reduce<ExplainFetchValue>((worst, source) =>
    EXPLAIN_FETCH_VALUE_RANK[worst] >= EXPLAIN_FETCH_VALUE_RANK[source.fetch]
      ? worst
      : source.fetch
  , "none");
}

function addFetchSummary(
  lines: string[],
  sources: readonly ExplainFetchSourcePlan[]
): string[] {
  const detailLines = lines.filter((line) => !line.startsWith("fetch summary:"));
  if (sources.length === 0) return detailLines;
  return [`fetch summary: ${worstExplainFetch(sources).toUpperCase()}`, ...detailLines];
}

function pushedQueryLimit(query: string): number | null {
  const match = /(?:^|\s)limit\s+(\d+)(?:\s|$)/i.exec(query);
  return match ? Number(match[1]) : null;
}

function createExplainFetchSource(
  collector: ExplainFetchCollector,
  app: number,
  alias: string | null,
  role: ExplainFetchRole,
  scope: ExplainFetchScope,
  query: string,
  pending = false
): ExplainFetchSourcePlan {
  const source: ExplainFetchSourcePlan = {
    app,
    alias,
    role,
    fetch: scope.toLowerCase() as ExplainFetchValue,
    pending,
    kintoneQuery: query === "(全件取得)" || query === "(なし)" || query === ""
      ? null
      : query,
    limit: pushedQueryLimit(query),
  };
  collector.sources.push(source);
  return source;
}

function formatFetchScope(source: ExplainFetchSourcePlan): string {
  return [
    source.fetch.toUpperCase(),
    ...(source.limit === null ? [] : [`(limit ${source.limit})`]),
    ...(source.pending ? ["(未確定)"] : []),
  ].join(" ");
}

function renderFetchScope(source: ExplainFetchSourcePlan): string {
  return `  fetch:         ${formatFetchScope(source)}`;
}

function buildValidatePlan(stmt: ValidateStatement, label?: string): string[] {
  const info = validateExplainInfo.get(stmt);
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`VALIDATE APP${stmt.appId}`);
  lines.push("  operation:     read-only existing-record constraint audit (writesKintone=false)");
  lines.push("  fetch API:     GET records via offset + $id keyset paging (Cursor API unused)");
  lines.push("  complete input: required (onLimit=truncate disabled)");
  if (!info) {
    lines.push("  metadata:      form definition required; number precision required for NUMBER targets");
    return lines;
  }
  lines.push(`  WHERE capability: ${info.capability.capability}`);
  lines.push(`  kintone query: ${info.prefilter === null ? "(全件取得)" : whereToKintone(info.prefilter)}`);
  lines.push(`  audit fields:  ${info.targetFields.length === 0 ? "(なし)" : info.targetFields.join(", ")}`);
  lines.push(`  fetch fields:  ${info.fetchFields.join(", ")}`);
  lines.push(`  mode:          ${stmt.summary ? "SUMMARY" : "DETAIL"}`);
  if (info.subtables.size > 0) lines.push(`  subtable audit: ${[...info.subtables].map(([table, count]) => `${table}(${count} fields)`).join(", ")}`);
  lines.push(`  output schema: ${(stmt.summary ? EXISTING_VALIDATION_SUMMARY_COLUMNS : EXISTING_VALIDATION_COLUMNS).join(", ")}`);
  lines.push(stmt.summary
    ? "  aggregation:   record/subtable/field/code; row locator=none"
    : "  row locator:   grouped by message; $err_subrow / $err_subrow_id list all matching rows (first-occurrence order)");
  lines.push(`  number precision: ${info.numberPrecision ? "required" : "not required"}`);
  lines.push("  local checks:  original WHERE re-evaluation + built-in constraints + CHECK groups");
  lines.push("  records/mutation API during EXPLAIN: none; violation count unavailable");
  return lines;
}

function formatChoiceEqualityRewrite(rewrite: ChoiceEqualityRewrite): string {
  const field = rewrite.field.tableAlias
    ? `${rewrite.field.tableAlias}.${rewrite.field.field}`
    : rewrite.field.field;
  const originalValue = rewrite.value.replace(/'/g, "''");
  const normalizedValue = rewrite.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const normalizedOperator = rewrite.normalizedOperator === "IN" ? "in" : "not in";
  return `  pushdown normalized: ${field} ${rewrite.originalOperator} '${originalValue}' -> ` +
    `${field} ${normalizedOperator} ("${normalizedValue}")`;
}

function renderPlainGroupByExplainLines(
  stmt: SelectStatement,
  plainGroupByPlan: PlainGroupByResolutionPlan | undefined,
  schemaDeferred: boolean
): string[] {
  const normalizedGrouping = normalizeGroupingSpec(stmt);
  if (normalizedGrouping.type !== "PLAIN") return [];
  const lines: string[] = [];
  if (plainGroupByPlan) {
    plainGroupByPlan.items.forEach((item, index) => {
      const key = normalizedGrouping.allItems[index];
      if (key?.type !== "FIELD_NAME") return;
      if (item.kind === "PHYSICAL") {
        lines.push(
          `  group key ${key.name}: PHYSICAL (source=${item.sourceIndex}, field=${item.fieldCode})`
        );
      } else if (item.kind === "ALIAS_SAFE") {
        lines.push(`  group key ${key.name}: ALIAS_SAFE (column=${item.columnIndex})`);
      } else if (item.kind === "EXPRESSION") {
        lines.push(`  group key ${key.name}: EXPRESSION`);
      }
    });
  } else if (schemaDeferred) {
    for (const key of normalizedGrouping.allItems) {
      if (key.type === "FIELD_NAME") {
        lines.push(`  group key ${key.name}: DEFERRED (temp table schema unavailable)`);
      }
    }
  }
  return lines;
}

function buildSelectPlan(
  stmt: SelectStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>,
  allowTotalCountPlan = true,
  emitFetch = true,
  collector: ExplainFetchCollector = { sources: [] },
  sourceRole: ExplainFetchRole = "main"
): string[] {
  const whereCapability = capabilities?.get(stmt) ?? (capabilities
    ? [...capabilities].find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(stmt))?.[1]
    : undefined);
  const orderPlan = orderPlans?.get(stmt) ?? (orderPlans
    ? [...orderPlans].find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(stmt))?.[1]
    : undefined);
  const plainGroupByPlan = plainGroupByPlans?.get(stmt) ?? (plainGroupByPlans
    ? [...plainGroupByPlans].find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(stmt))?.[1]
    : undefined);
  const totalCountPlan = allowTotalCountPlan && whereCapability !== undefined
    && isCountStarTotalCountEligible(stmt, whereCapability);
  const mode = totalCountPlan
    ? "COUNT_TOTAL_COUNT"
    : orderPlan?.kind === "CANONICAL_LOCAL"
    ? "FULL_SCAN"
    : whereCapability && whereCapability.capability !== "EXACT_PUSHDOWN"
      ? "FULL_SCAN"
      : resolveSelectMode(stmt);
  const reasons = collectFullScanReasons(stmt);
  if (whereCapability && whereCapability.capability !== "EXACT_PUSHDOWN") {
    reasons.push(...whereCapability.reasons.map((reason) => reason.code));
  }
  const lines: string[] = [];
  const groupingMetadata = buildGroupingExplainMetadata(
    stmt,
    resolvedGroupingSpecs.get(stmt)?.allItems.length
  );

  if (label) lines.push(label);
  lines.push(`  mode:          ${mode}`);
  for (const step of explainCrossJoinSteps.get(stmt) ?? []) {
    lines.push(`  cross join:    ${step.leftLabel} × ${step.rightLabel}`);
    lines.push(`  left rows:     ${step.leftRows ?? "runtime (left intermediate rows)"}`);
    lines.push(`  right rows:    ${step.rightRows ?? `runtime (${step.rightRuntimeLabel})`}`);
    if (step.plan) {
      lines.push(`  rows:          ${step.plan.outputRows}`);
      lines.push(`  row guard:     ${step.plan.outputRows} / ${step.plan.limit}`);
      lines.push("  guard timing:  before row materialization");
    } else {
      const left = step.leftRows === null ? "left rows" : String(step.leftRows);
      const right = step.rightRows === null ? "right rows" : String(step.rightRows);
      lines.push(`  rows:          runtime (${left} × ${right})`);
      lines.push(`  row guard:     runtime checked / ${CROSS_JOIN_MAX_ROWS}`);
      lines.push("  guard timing:  after complete source fetch, before row materialization");
    }
    lines.push("  records API:   none");
  }
  for (const rewrite of explainChoiceEqualityRewrites.get(stmt)
    ?? choiceEqualityRewritesBySelect.get(stmt)
    ?? []) {
    lines.push(formatChoiceEqualityRewrite(rewrite));
  }
  if (groupingMetadata) {
    lines.push(`  grouping source: ${groupingMetadata.source}`);
    lines.push(
      `  grouping sets: ${groupingMetadata.expandedSetCount} ` +
      `(limit: ${groupingMetadata.setLimit})`
    );
    lines.push(
      `  grouping items: ${groupingMetadata.groupingItemCount} ` +
      `(limit: ${groupingMetadata.itemLimit})`
    );
    lines.push(
      `  grouping output rows: runtime checked (limit: ${groupingMetadata.outputRowLimit}, ` +
      "before HAVING/DISTINCT/LIMIT)"
    );
  }
  lines.push(...renderPlainGroupByExplainLines(
    stmt,
    plainGroupByPlan,
    [stmt.from, ...stmt.joins.map((join) => join.table)].some((table) => table.cteName !== null)
  ));
  for (const column of stmt.columns) {
    if (column.type !== "WINDOW_COL" || column.windowKind === undefined || column.windowKind === "RANKING") continue;
    const clauses: string[] = [];
    if (column.partitionBy.length > 0) {
      clauses.push(`PARTITION BY ${column.partitionBy.map((ref) =>
        ref.tableAlias ? `${ref.tableAlias}.${ref.field}` : ref.field
      ).join(", ")}`);
    }
    if (column.orderBy.length > 0) {
      clauses.push(`ORDER BY ${column.orderBy.map(formatOrderByItem).join(", ")}`);
    }
    if (column.windowKind === "VALUE") {
      lines.push(`  window ${column.alias}: ${column.valueFunc}(offset=${column.offset}) OVER (${clauses.join(" ")})`);
    } else if (column.windowKind === "AGGREGATE") {
      lines.push(`  window ${column.alias}: ${column.aggFunc} OVER (${clauses.join(" ")})`);
      lines.push(column.frame === null
        ? "    frame: PARTITION ENTIRE"
        : `    frame: ${column.frame.unit} UNBOUNDED PRECEDING AND CURRENT ROW${
          column.frame.source === "DEFAULT" ? " (既定)" : ""
        }`);
    }
  }
  if (totalCountPlan) {
    const baseQuery = stmt.where === null ? "" : whereToKintone(stmt.where);
    lines.push(`  app:           APP${stmt.from.appId} (${stmt.from.appId})`);
    lines.push(
      `  kintone query: ${baseQuery}${baseQuery ? " " : ""}limit 1`
    );
    if (emitFetch) {
      const source = createExplainFetchSource(
        collector,
        stmt.from.appId,
        stmt.from.alias,
        sourceRole,
        "COUNT_ONLY",
        `${baseQuery}${baseQuery ? " " : ""}limit 1`
      );
      lines.push(renderFetchScope(source));
    }
    lines.push("  fields:        $id");
    lines.push("  fetch API:     GET records.json (totalCount=true)");
    lines.push("  REST execution: single GET");
    lines.push("  record limit:  maxRecords/onLimitReached not applied");
    lines.push("  fallback:      full record scan when totalCount is missing or invalid");
    lines.push("  search abort:  fail-closed (SearchAbortedError)");
    return lines;
  }
  if (orderPlan) {
    lines.push(`  order plan:    ${orderPlan.kind}`);
    if (orderPlan.reasonCodes.length > 0) lines.push(`  order reason:  ${orderPlan.reasonCodes.join(", ")}`);
    if (orderPlan.kind === "KORDER_NATIVE") {
      lines.push("  order semantics: kintone native (not kSQL canonical)");
      lines.push("  REST execution: single GET");
    } else if (orderPlan.kind === "KORDER_CURSOR") {
      lines.push("  order semantics: kintone native (not kSQL canonical)");
      lines.push("  fetch API: POST/GET/DELETE records/cursor.json");
      lines.push("  cursor page size: 500");
      lines.push(`  scan rows:     ${orderPlan.scanRows}`);
    }
  } else if (groupingMetadata) {
    lines.push("  order plan:    CANONICAL_LOCAL");
  }
  const explainedStmt = orderPlan && !orderPlan.requiresCompleteInput
    ? { ...stmt, orderBy: [] }
    : stmt;
  const completeReasons = completeInputReasons(explainedStmt);
  if (orderPlan?.requiresCompleteInput) completeReasons.add("LOCAL_ORDER");
  const constantFalse = isConstantFalseWhere(stmt.where);
  if (completeReasons.size > 0 && (!constantFalse || groupingMetadata !== null)) {
    lines.push("  complete input: required (onLimit=truncate disabled)");
    lines.push(`  complete input reason: ${[...completeReasons].join(", ")}`);
    lines.push("  onLimit=truncate: disabled");
  }
  if (constantFalse) {
    lines.push("  predicate:     constant false");
    lines.push("  records API access: none");
    lines.push(`  app:           APP${stmt.from.appId} (${stmt.from.appId})`);
    return lines;
  }
  if (mode === "FULL_SCAN" && reasons.length > 0) {
    lines.push(`  reason:        ${reasons.join(", ")}`);
  }

  if (mode === "SIMPLE") {
    const params = selectToKintoneParams(orderPlan?.kind === "CANONICAL_REST_TOP_N"
      ? withCanonicalRestTie(stmt)
      : stmt);
    lines.push(`  app:           APP${stmt.from.appId} (${stmt.from.appId})`);
    const displayedQuery = orderPlan?.kind === "KORDER_CURSOR"
      ? buildKorderCursorQuery(stmt)
      : params.query;
    lines.push(`  kintone query: ${displayedQuery || "(なし)"}`);
    if (emitFetch && stmt.from.cteName === null) {
      const fetchScope: ExplainFetchScope = displayedQuery ? "EXACT" : "ALL";
      lines.push(renderFetchScope(createExplainFetchSource(
        collector,
        stmt.from.appId,
        stmt.from.alias,
        sourceRole,
        fetchScope,
        displayedQuery
      )));
    }
    lines.push(`  fields:        ${params.fields.length === 0 ? "(全フィールド)" : params.fields.join(", ")}`);
  } else {
    const runtimeJoinPlan = explainJoinPushdownPlans.get(stmt);
    const metadataAwarePushdownPlan = explainPushdownPlans.get(stmt);
    const pushdownPlan = metadataAwarePushdownPlan ?? buildKlikePushdownPlan(stmt);
    if (stmt.joins.length > 0) {
      if (runtimeJoinPlan) {
        lines.push("  join pushdown plan: applied (runtime metadata resolved)");
        lines.push("  runtime plan timing: variables/subqueries resolved -> metadata resolved -> immutable plan");
        lines.push("  EXPLAIN unresolved subqueries: not applied (records API is not called)");
        if (runtimeJoinPlan.joinPlan.serverFunctionCandidate) {
          lines.push(
            `  allow form: JOIN_SERVER_FUNCTION_EXACT (${
              runtimeJoinPlan.joinPlan.serverFunctionCandidate.variant === "WHOLE_WHERE_EXACT"
                ? "whole-WHERE"
                : "leaf"
            })`
          );
        }
        lines.push(
          `  client residual: ${
            runtimeJoinPlan.joinPlan.residualWhere === null
              ? "(none)"
              : renderRelativeDateResidualWhere(runtimeJoinPlan.joinPlan.residualWhere)
          }`
        );
        lines.push(`  KLIKE applied nodes: ${runtimeJoinPlan.joinPlan.appliedKlikes.size}`);
        lines.push(
          `  KLIKE unapplied nodes: ${
            runtimeJoinPlan.joinPlan.allKlikes.length
              - runtimeJoinPlan.joinPlan.appliedKlikes.size
          }`
        );
        if (runtimeJoinPlan.joinPlan.residualWhere !== null) {
          for (const rejection of runtimeJoinPlan.joinPlan.rejections) {
            lines.push(`  join pushdown not applied: ${rejection.reason}`);
          }
        }
      } else {
        const reason = stmt.joins.some((join) => join.type !== "INNER" && join.type !== "CROSS")
          ? "OUTER_JOIN"
          : [stmt.from, ...stmt.joins.map((join) => join.table)].some((table) =>
              table.cteName !== null || Boolean(table.subtableCode)
            )
            ? "SOURCE_KIND"
            : "PLAN_NOT_APPLICABLE";
        lines.push("  join pushdown plan: not applied (join key/WHERE prefilters are reported per source below)");
        lines.push(`  join pushdown not applied: ${reason}`);
      }
    }
    // メインテーブル
    const mainFields = selectToFetchAllFields(stmt, stmt.from, plainGroupByPlan);
    const mainAliasStr = stmt.from.alias ? ` AS ${stmt.from.alias}` : "";
    const mainPushDown = pushdownPlan.mainCondition;
    const mainCandidate = extractMainTypedPushdownCandidate(stmt);
    const exactOriginalWhere = stmt.joins.length === 0
      && whereCapability?.capability === "EXACT_PUSHDOWN"
      && stmt.where !== null
      && !whereRequiresJsEval(stmt.where)
      ? whereToKintone(stmt.where)
      : "";
    const mainBoundQuery = stmt.from.alias
      ? runtimeJoinPlan?.queriesByAlias.get(stmt.from.alias)
      : undefined;
    const mainQ = mainBoundQuery
      || (mainPushDown !== null
        ? whereToKintone(mainPushDown)
        : exactOriginalWhere || "(全件取得)");
    lines.push(`  app:           APP${stmt.from.appId}${mainAliasStr} (${stmt.from.appId})`);
    lines.push(`  kintone query: ${mainQ}`);
    const mainJoinItem = runtimeJoinPlan?.joinPlan.items.find((item) =>
      item.targetAlias === stmt.from.alias
    );
    const mainFunctionConsumption = runtimeJoinPlan?.joinPlan.serverFunctionConsumptions.find(
      (consumption) => consumption.targetAlias === stmt.from.alias
    );
    if (emitFetch && stmt.from.cteName === null) {
      const mainPending = !metadataAwarePushdownPlan && mainCandidate !== null;
      const mainFetchScope: ExplainFetchScope = mainQ === "(全件取得)"
        ? "ALL"
        : mainPending
          ? "PREFILTERED"
          : mainJoinItem?.relation === "exact" || mainFunctionConsumption || exactOriginalWhere !== ""
          ? "EXACT"
          : "PREFILTERED";
      lines.push(renderFetchScope(createExplainFetchSource(
        collector,
        stmt.from.appId,
        stmt.from.alias,
        sourceRole,
        mainFetchScope,
        mainQ,
        mainPending
      )));
    }
    if (mainJoinItem || mainFunctionConsumption) {
      lines.push(`  pushdown applied: ${mainBoundQuery}`);
      lines.push(`  relation: ${mainJoinItem?.relation ?? "exact"}`);
    } else if (metadataAwarePushdownPlan && mainPushDown !== null) {
      lines.push(`  pushdown applied: ${mainQ}`);
      lines.push(`  relation: ${pushdownPlan.mainRelation ?? "exact"}`);
    } else if (mainCandidate !== null
      && (!metadataAwarePushdownPlan || hasPushdownPlaceholder(mainCandidate))) {
      lines.push(`  pushdown candidate: ${whereToKintone(mainCandidate)}（実行時の型・実在確認待ち）`);
    }
    lines.push(`  fields:        ${mainFields.length === 0 ? "(全フィールド)" : mainFields.join(", ")}`);
    // JOIN テーブル
    for (const join of stmt.joins) {
      const joinFields = selectToFetchAllFields(stmt, join.table, plainGroupByPlan);
      const joinAliasStr = join.table.alias ? ` AS ${join.table.alias}` : "";
      const joinType  = join.type === "INNER" ? "JOIN" : `${join.type} JOIN`;
      const joinPushDown = join.table.alias
        ? (pushdownPlan.joinConditions.get(join.table.alias) ?? null)
        : null;
      const joinCandidate = join.table.alias && !join.table.subtableCode && join.table.cteName === null && stmt.where
        ? extractTypedPushdownCandidates(stmt.where, { tableAlias: join.table.alias }) : null;
      const joinBoundQuery = join.table.alias
        ? runtimeJoinPlan?.queriesByAlias.get(join.table.alias)
        : undefined;
      const joinKey = join.table.alias
        ? explainJoinKeyPrefilters.get(stmt)?.get(join.table.alias)
        : undefined;
      const offlineJoinKeyCandidate = !metadataAwarePushdownPlan
        && join.type === "INNER"
        && join.table.cteName === null
        && !join.table.subtableCode
        && [stmt.from, ...stmt.joins.map((candidate) => candidate.table)]
          .some((table) => table.cteName !== null);
      const baseJoinQ = joinBoundQuery
        || (joinPushDown !== null
            ? whereToKintone(joinPushDown)
            : joinKey?.additionalQuery
              ? joinKey.additionalQuery
            : "(全件取得)");
      const runtimeJoinKeyCandidate = offlineJoinKeyCandidate
        || joinKey?.plan.kind === "RANGE_CANDIDATE"
        || (joinKey?.plan.kind === "FALLBACK"
          && joinKey.plan.reason === "JOIN_KEY_VALUES_RUNTIME");
      const joinQueries = joinKey && joinKey.queries.length > 0
        ? joinKey.queries.map((query) => baseJoinQ !== "(全件取得)"
          ? `(${query}) and (${baseJoinQ})`
          : query)
        : [runtimeJoinKeyCandidate ? "(runtime source keys)" : baseJoinQ];
      const joinQ = joinQueries.join(" | ");
      lines.push(`  ${joinType}:        APP${join.table.appId}${joinAliasStr} (${join.table.appId})`);
      for (const query of joinQueries) lines.push(`  kintone query: ${query}`);
      const joinPlanItem = runtimeJoinPlan?.joinPlan.items.find((item) =>
        item.targetAlias === join.table.alias
      );
      const joinFunctionConsumption =
        runtimeJoinPlan?.joinPlan.serverFunctionConsumptions.find(
          (consumption) => consumption.targetAlias === join.table.alias
        );
      if (emitFetch && join.table.cteName === null) {
        const joinPending = runtimeJoinKeyCandidate
          || (!joinKey && !metadataAwarePushdownPlan && joinCandidate !== null);
        const joinFetchScope: ExplainFetchScope = joinQ === "(全件取得)"
          ? "ALL"
          : joinPending
            ? "PREFILTERED"
            : joinKey?.plan.kind === "IN"
              && joinPlanItem?.relation !== "superset"
              && joinKey.additionalRelation !== "superset"
            ? "EXACT"
            : joinPlanItem?.relation === "exact" || joinFunctionConsumption
            ? "EXACT"
            : "PREFILTERED";
        lines.push(renderFetchScope(createExplainFetchSource(
          collector,
          join.table.appId,
          join.table.alias,
          "join",
          joinFetchScope,
          joinQ,
          joinPending
        )));
      }
      if (joinKey) {
        if (joinKey.plan.kind === "RANGE") {
          lines.push("  join key prefilter: range");
          for (const query of joinQueries) lines.push(`  pushdown applied: ${query}`);
          lines.push("  relation: superset");
        } else if (joinKey.plan.kind === "IN") {
          const relation = joinPlanItem?.relation === "superset" || joinKey.additionalRelation === "superset"
            ? "superset"
            : "exact";
          lines.push("  join key prefilter: in");
          for (const query of joinQueries) lines.push(`  pushdown applied: ${query}`);
          lines.push(`  relation: ${relation}`);
        } else if (joinKey.plan.kind === "RANGE_CANDIDATE") {
          lines.push("  join key prefilter: range candidate");
          lines.push("  relation: superset");
          lines.push(`  join key prefilter reason: ${joinKey.plan.reason}`);
        } else if (joinKey.plan.kind === "FALLBACK") {
          lines.push(joinKey.plan.reason === "JOIN_KEY_VALUES_RUNTIME"
            ? "  join key prefilter: runtime candidate"
            : "  join key prefilter: not applied");
          lines.push(`  join key prefilter reason: ${joinKey.plan.reason}`);
        }
      } else if (offlineJoinKeyCandidate) {
        lines.push("  join key prefilter: runtime candidate");
        lines.push("  join key prefilter reason: JOIN_KEY_VALUES_RUNTIME");
        if (joinCandidate !== null) {
          lines.push(`  pushdown candidate: ${whereToKintone(joinCandidate)}（実行時の型・実在確認待ち）`);
        }
      } else if (joinPlanItem || joinFunctionConsumption) {
        lines.push(`  pushdown applied: ${joinBoundQuery}`);
        lines.push(`  relation: ${joinPlanItem?.relation ?? "exact"}`);
      } else if (metadataAwarePushdownPlan && joinPushDown !== null) {
        lines.push(`  pushdown applied: ${baseJoinQ}`);
        lines.push(`  relation: ${pushdownPlan.joinRelations.get(join.table.alias!) ?? "exact"}`);
      } else if (joinCandidate !== null
        && (!metadataAwarePushdownPlan || hasPushdownPlaceholder(joinCandidate))) {
        lines.push(`  pushdown candidate: ${whereToKintone(joinCandidate)}（実行時の型・実在確認待ち）`);
      }
      lines.push(`  fields:        ${joinFields.length === 0 ? "(全フィールド)" : joinFields.join(", ")}`);
    }
  }

  lines.push(...collectSubqueryPlans(
    stmt, capabilities, orderPlans, plainGroupByPlans, collector
  ));
  return lines;
}

function buildUnionPlan(
  stmt: UnionStatement,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>,
  collector: ExplainFetchCollector = { sources: [] }
): string[] {
  // UnionStatement は left / right の二分木 — 左辺を再帰的に展開して全 SELECT を収集
  const selects: SelectStatement[] = [];
  const collect = (u: SelectStatement | UnionStatement): void => {
    if (u.type === "SELECT") { selects.push(u); return; }
    collect(u.left);
    selects.push(u.right);
  };
  collect(stmt);

  const lines: string[] = [];
  selects.forEach((sel, i) => {
    if (i > 0) lines.push("");
    lines.push(...buildSelectPlan(
      sel, `[union:${i + 1}]`, capabilities, orderPlans, plainGroupByPlans,
      true, true, collector, "union"
    ));
  });
  return lines;
}

/** metadata API を使わない CLI dry-run でも literal 系列の CROSS 計画を表示する。 */
function populateWithCrossJoinExplain(stmt: WithStatement): void {
  const exactRows = new Map<string, number>();
  const labelFor = (table: TableRef): string =>
    effectiveTableAlias(table) ?? (table.appId > 0 ? `APP${table.appId}` : "source");
  const rowsFor = (table: TableRef): number | null => {
    if (table.cteName === NO_FROM_CTE_NAME) return 1;
    return table.cteName === null ? null : (exactRows.get(table.cteName) ?? null);
  };
  const analyze = (select: SelectStatement): number | null => {
    let current = rowsFor(select.from);
    let leftLabel = labelFor(select.from);
    const steps: ExplainCrossJoinStep[] = [];
    for (const join of select.joins) {
      const right = rowsFor(join.table);
      const rightLabel = labelFor(join.table);
      if (join.type === "CROSS") {
        const plan = current !== null && right !== null
          ? planCrossJoinRows(current, right)
          : null;
        steps.push({
          leftLabel,
          rightLabel,
          leftRows: current,
          rightRows: right,
          plan,
          rightRuntimeLabel: join.table.cteName === null
            ? `APP${join.table.appId} fetched rows`
            : `${rightLabel} materialized rows`,
        });
        current = plan?.outputRows ?? null;
        leftLabel = `${leftLabel} × ${rightLabel}`;
      } else {
        current = null;
        leftLabel = `${leftLabel} ${join.type} JOIN ${rightLabel}`;
      }
    }
    if (steps.length > 0) explainCrossJoinSteps.set(select, steps);
    if (isConstantFalseWhere(select.where)) current = 0;
    else if (select.where !== null) current = null;
    if (normalizeGroupingSpec(select).type !== "NONE"
      || select.distinct
      || select.having !== null
      || isAggregateQueryBlock(select)
      || select.columns.some((column) => column.type === "WINDOW_COL")) return null;
    if (current === null) return null;
    current = Math.max(0, current - (select.offset ?? 0));
    return select.limit === null ? current : Math.min(current, select.limit);
  };
  const analyzeQuery = (query: SelectStatement | UnionStatement): void => {
    if (query.type === "SELECT") {
      analyze(query);
      return;
    }
    analyzeQuery(query.left);
    analyze(query.right);
  };

  for (const cte of stmt.ctes) {
    if (cte.query.type === "GENERATE_SERIES") {
      if (!cte.query.args.some((arg) => arg.type === "VARIABLE")) {
        exactRows.set(cte.name, resolveGenerateSeries(cte.query).rowCount);
      }
    } else if (cte.query.type === "SELECT") {
      const rows = analyze(cte.query);
      if (rows !== null) exactRows.set(cte.name, rows);
    } else if (cte.query.type === "UNION") {
      analyzeQuery(cte.query);
    }
  }
  analyzeQuery(stmt.query);
}

function buildWithPlan(
  stmt: WithStatement,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>,
  collector: ExplainFetchCollector = { sources: [] },
  maxRecords = 10_000,
  recursiveLimits: RecursiveCteLimits = resolveRecursiveCteLimits({})
): string[] {
  populateWithCrossJoinExplain(stmt);
  const lines: string[] = [];
  for (const cte of stmt.ctes) {
    if (cte.recursiveSpec) {
      const cycle = cte.recursiveSpec.cycle;
      lines.push(
        `recursive cte: ${cte.name}`,
        "  strategy: B (materialize each source once, iterate in memory)",
        "  union: UNION ALL",
        "  self reference: once",
        cycle
          ? `  cycle: path-scoped on ${cycle.column}, mark ${cycle.markColumn} ('${cycle.markValue}'/'${cycle.defaultValue}'), cycle row emitted, expansion stopped`
          : "  cycle: none (absolute limits still enforced)",
        `  limits: depth=${recursiveLimits.depth}, rows=${recursiveLimits.rows}, expansions=${recursiveLimits.expansions} (always fail-closed)`,
        "  complete input: required (onLimit=truncate disabled)",
        "  empty-key recursive join: runtime checked"
      );
      for (const source of recursivePhysicalTables(cte.recursiveSpec.seed, cte.recursiveSpec.recursiveTerm)) {
        const sourceName = `APP${source.appId}${source.subtableCode ? `$${source.subtableCode}` : ""}`;
        lines.push(
          `  source ${sourceName}: R unknown, pageSize=500, estimated calls=ceil(R/500), maxRecords=${maxRecords}`
        );
      }
      lines.push("  iteration rows: unknown until execution", "  records API: none", "");
    } else if (cte.query.type === "SELECT") {
      lines.push(...buildSelectPlan(
        cte.query, `[cte: ${cte.name}]`, capabilities, orderPlans, plainGroupByPlans,
        false, true, collector, "cte"
      ));
      lines.push("");
    } else if (cte.query.type === "GENERATE_SERIES") {
      const seriesStatement = cte.query;
      const binding = explainSeriesBindings.get(seriesStatement);
      const unresolved = seriesStatement.args.some((arg) => arg.type === "VARIABLE");
      if (unresolved) {
        const argumentLabel = (index: number): string => {
          const arg = seriesStatement.args[index];
          if (!arg) return index === 2 ? "runtime" : "deferred";
          if (arg.type === "VARIABLE") return `@${arg.name} (runtime)`;
          if (index < 2) return "literal";
          return arg.type === "NUMBER" ? numberLiteralText(arg) : arg.value;
        };
        lines.push(
          `[cte: ${cte.name}]`,
          "  source:        GENERATE_SERIES",
          `  column:        ${seriesStatement.columnAlias}`,
          "  series type:   deferred (variable)",
          `  start:         ${argumentLabel(0)}`,
          `  stop:          ${argumentLabel(1)}`,
          `  step:          ${argumentLabel(2)}`,
          "  rows:          runtime",
          `  row guard:     runtime / ${GENERATE_SERIES_MAX_ROWS}`,
          "  records API:   none",
          ""
        );
        continue;
      }
      const series = resolveGenerateSeries(seriesStatement);
      const step = series.kind === "DATE"
        ? `${series.step} ${String(series.dateUnit ?? "DAY").toLowerCase()}${Math.abs(series.step) === 1 ? "" : "s"}`
        : String(series.step);
      lines.push(
        `[cte: ${cte.name}]`,
        "  source:        GENERATE_SERIES",
        `  column:        ${seriesStatement.columnAlias}`,
        `  series type:   ${series.kind}${binding?.defaultBoundIndexes.size ? " (DECLARE default)" : ""}`,
        `  start:         ${binding?.variableNames.has(0) ? `@${binding.variableNames.get(0)} (DECLARE default; value hidden)` : series.start}`,
        `  stop:          ${binding?.variableNames.has(1) ? `@${binding.variableNames.get(1)} (DECLARE default; value hidden)` : series.stop}`,
        `  step:          ${step}`,
        `  rows:          ${series.rowCount}${binding?.defaultBoundIndexes.size ? " (DECLARE default estimate)" : ""}`,
        `  row guard:     ${series.rowCount} / ${GENERATE_SERIES_MAX_ROWS}`,
        ...(binding?.defaultBoundIndexes.size
          ? ["  binding:       DECLARE defaults; runtime injection may change this plan"]
          : []),
        "  records API:   none",
        ""
      );
    }
  }
  if (stmt.query.type === "SELECT" || stmt.query.type === "UNION") {
    lines.push(...buildExplainPlan(
      stmt.query,
      "[main]",
      capabilities,
      orderPlans,
      100,
      DEFAULT_APPLY_MAX_SUBTABLE_ROWS,
      maxRecords,
      plainGroupByPlans,
      false,
      collector,
      "main",
      recursiveLimits
    ));
  }
  if (canInlineSingleCte(stmt)) {
    lines.push("");
    const inlined = buildInlinedQuery(stmt);
    lines.push(...buildSelectPlan(
      inlined, "[effective: inlined CTE]", capabilities, orderPlans, plainGroupByPlans,
      false, true, collector, "cte"
    ));
  }
  return lines;
}

function collectFullScanReasons(stmt: SelectStatement): string[] {
  const r: string[] = [];
  if (stmt.from.subtableCode || stmt.joins.some((j) => j.table.subtableCode))
    r.push("サブテーブル仮想テーブル");
  if (stmt.joins.some((join) => join.type === "CROSS"))
    r.push("CROSS JOIN あり");
  if (stmt.joins.some((join) => join.type !== "CROSS"))
    r.push("JOIN あり");
  const grouping = normalizeGroupingSpec(stmt);
  if (grouping.type === "PLAIN")
    r.push("GROUP BY あり");
  else if (grouping.type === "GROUPING_SETS")
    r.push(
      grouping.source === "ROLLUP"
        ? "ROLLUP あり"
        : grouping.source === "CUBE"
          ? "CUBE あり"
          : "GROUPING SETS あり"
    );
  if (stmt.distinct)
    r.push("DISTINCT あり");
  if (stmt.columns.some((c) => c.type === "AGGREGATE" || c.type === "ARITH_AGG_COL"))
    r.push("集計関数（COUNT / SUM 等）あり");
  if (stmt.columns.some((c) => c.type === "WINDOW_COL"))
    r.push("ウィンドウ関数あり");
  if (stmt.columns.some((c) => c.type === "SCALAR_SUBQUERY_COL"))
    r.push("SELECT 列にスカラーサブクエリ");
  if (whereRequiresJsEval(stmt.where))
    r.push("WHERE 句に JS 評価が必要な式");
  if (whereHasLike(stmt.where))
    r.push("LIKE は常に JS 評価のため全件取得");
  if (stmt.orderBy.some((o) => o.key.type !== "FIELD_NAME"))
    r.push("ORDER BY に式");
  return r;
}

function collectSubqueryPlans(
  stmt: SelectStatement,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>,
  collector: ExplainFetchCollector = { sources: [] }
): string[] {
  const lines: string[] = [];
  let idx = 1;

  const visitWhere = (w: WhereExpr | null): void => {
    if (!w) return;
    switch (w.type) {
      case "BINARY":
        if (w.right.type === "SCALAR_SUBQUERY") {
          lines.push(""); lines.push(...buildSelectPlan(w.right.query, `[subquery:${idx++}]`, capabilities, orderPlans, plainGroupByPlans, false, true, collector, "subquery"));
        }
        if (w.right.type === "SUBQUERY_IN_LIST") {
          lines.push(""); lines.push(...buildSelectPlan(w.right.query, `[subquery:${idx++}]`, capabilities, orderPlans, plainGroupByPlans, false, true, collector, "subquery"));
        }
        break;
      case "EXISTS":
        lines.push(""); lines.push(...buildSelectPlan(w.query, `[subquery:${idx++}]`, capabilities, orderPlans, plainGroupByPlans, false, true, collector, "subquery"));
        break;
      case "LOGICAL":  visitWhere(w.left); visitWhere(w.right); break;
      case "NOT":
      case "GROUP":    visitWhere(w.expr); break;
      case "NULL_CHECK": break;
      case "BOOLEAN": break;
    }
  };

  visitWhere(stmt.where);

  for (const col of stmt.columns) {
    if (col.type === "SCALAR_SUBQUERY_COL") {
      lines.push(""); lines.push(...buildSelectPlan(col.query, `[subquery:${idx++}]`, capabilities, orderPlans, plainGroupByPlans, false, true, collector, "subquery"));
    }
  }

  if (stmt.having) visitWhere(stmt.having);

  return lines;
}

// ============================================================
// EXPLAIN — DML プラン
// ============================================================

function buildInsertPlan(
  stmt: InsertStatement,
  label?: string,
  dmlMaxRows = DEFAULT_APPLY_MAX_ROWS,
  dmlMaxSubtableRows = DEFAULT_APPLY_MAX_SUBTABLE_ROWS
): string[] {
  const totalRows   = stmt.values.length;
  const batchCount  = Math.ceil(totalRows / 100);
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [INSERT]`);
  lines.push(`  target:  APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  records: ${totalRows} 件（バッチ ${batchCount} 回 × 最大 100 件）`);
  lines.push(`  api:     POST /k/v1/records.json × ${batchCount}`);
  lines.push(`  fields:  ${stmt.fields.join(", ")}`);
  return stmt.applyBlocks?.length
    ? [...lines, ...formatStaticApplyDiagnostic(buildStaticApplyDiagnostic(stmt, dmlMaxRows, dmlMaxSubtableRows))]
    : lines;
}

function buildInsertSelectPlan(
  stmt: InsertSelectStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>
): string[] {
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [INSERT SELECT]`);
  lines.push(`  target:  APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  fields:  ${stmt.fields.join(", ")}`);
  lines.push(`  api:     POST /k/v1/records.json（件数は SELECT 結果に依存、100 件ごとにバッチ）`);
  lines.push("");
  lines.push(...buildSelectPlan(
    stmt.select, "[source SELECT]", capabilities, orderPlans, plainGroupByPlans, false, false
  ));
  return lines;
}

function buildUpdatePlan(
  stmt: UpdateStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  dmlMaxRows = 100,
  dmlMaxSubtableRows = DEFAULT_APPLY_MAX_SUBTABLE_ROWS,
  maxRecords = 10_000
): string[] {
  if (stmt.applyBlocks?.length) {
    return buildUpdateApplyPlan(stmt, label, dmlMaxRows, dmlMaxSubtableRows, maxRecords);
  }
  const isArith  = hasArithAssignment(stmt);
  const isStringFunc = stmt.assignments.some((a) => a.value.type === "STRING_FUNC");
  const isRowDependent = hasRowDependentAssignment(stmt);
  const isSubq   = stmt.assignments.some((a) => a.value.type === "SCALAR_SUBQUERY");
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(stmt.from ? `  [UPDATE FROM]` : `  [UPDATE]`);
  lines.push(`  target:        APP${stmt.appId} (${stmt.appId})`);
  if (stmt.from) {
    const source = stmt.from.cteName ?? `APP${stmt.from.appId}`;
    lines.push(`  source:        ${source} AS ${stmt.from.alias}`);
    lines.push(`  join:          APP${stmt.appId}.${stmt.from.targetJoinField} = ${stmt.from.alias}.${stmt.from.joinKeyField}`);
    lines.push(`  target filter: ${stmt.from.targetFilter ? safeWhereToKintone(stmt.from.targetFilter) : "(none)"}`);
  } else {
    lines.push(`  kintone query: ${safeWhereToKintone(stmt.where)}`);
  }
  if (!stmt.subtableCode) {
    lines.push("  selection: exact native pushdown; JS residual none");
    lines.push("  search abort: DML fail-closed (SearchAbortedError; mutation 0)");
  }
  lines.push(isConstantFalseWhere(stmt.where)
    ? "  api:           metadata validation only (records API access: none)"
    : `  api:           GET /k/v1/records.json → PUT /k/v1/records.json`);

  const setTypes: string[] = [];
  if (isArith)  setTypes.push("算術 SET（現在値を取得して計算）");
  if (isStringFunc) setTypes.push("文字列関数 SET（現在値を取得して評価）");
  if (isSubq)   setTypes.push("スカラーサブクエリ SET");
  if (!isRowDependent && !isSubq) setTypes.push("単純 SET");
  lines.push(`  set type:      ${setTypes.join(", ")}`);

  if (isRowDependent) {
    const refFields = collectArithRefFields(stmt);
    if (refFields.length > 0) {
      lines.push(`  ref fields:    ${refFields.join(", ")}（GET に含める）`);
    }
  }
  lines.push(`  set fields:`);
  for (const a of stmt.assignments) {
    lines.push(`    ${formatAssignment(a)}`);
  }

  // サブクエリセクション
  for (const a of stmt.assignments) {
    if (a.value.type === "SCALAR_SUBQUERY") {
      lines.push("");
      lines.push(...buildSelectPlan(
        a.value.query, `[subquery: ${a.field}]`, capabilities, orderPlans, undefined, false, false
      ));
    }
  }

  return lines;
}

function buildUpdateApplyPlan(
  stmt: UpdateStatement,
  label: string | undefined,
  dmlMaxRows: number,
  dmlMaxSubtableRows: number,
  maxRecords: number
): string[] {
  const diagnostic = buildStaticApplyDiagnostic(stmt, dmlMaxRows, dmlMaxSubtableRows);
  const branch = diagnostic.branches[0];
  const blocks = stmt.applyBlocks!;
  const operations: ApplyOperation[] = blocks.flatMap((block) => [...block.operations] as ApplyOperation[]);
  const selectorKinds = operations.map((operation) => {
    if (operation.kind === "APPEND") return "APPEND";
    if (operation.kind === "ADD" || operation.kind === "REMOVE_VALUE") return "VALUE_LITERAL";
    if (operation.selector.kind === "ALL_ROWS") return "ALL_ROWS";
    const where = operation.selector.where;
    return where.type === "BINARY" && where.op === "=" && where.left.type === "FIELD"
      && where.left.tableAlias === null && where.left.field === "_rid"
      ? "_rid"
      : "SAFE_PREDICATE";
  });
  const operationKinds = [...new Set(branch.targets.flatMap((target) => target.operations.map((operation) => operation.kind)))];
  const hasRemove = operationKinds.includes("REMOVE");
  const selectionPlan = applyParentExplainPlan.get(stmt);
  const selectionLines = selectionPlan ? [
    "parent selection:       safe prefilter + JS residual evaluation",
    `kintone prefilter:      ${selectionPlan.prefilter === null ? "(none; empty query)" : whereToKintone(selectionPlan.prefilter)}`,
    "JS residual:            original parent WHERE",
    `applied KLIKE:          ${selectionPlan.appliedKlikes.size}`,
    `unapplied KLIKE:        ${selectionPlan.unappliedKlikes.length}${selectionPlan.unappliedKlikes.length > 0
      ? " (unsupported: cannot be fully applied to native query)" : ""}`,
    `candidate limit:        maxRecords=${maxRecords}, onLimit=error, stopAfter=none`,
    `target guard:           dmlMaxRows=${dmlMaxRows} after JS residual evaluation`,
    "search abort:           DML fail-closed (B7-P3; all surfaces, no surface gate)",
  ] : [];
  return [
    ...(label ? [label] : []),
    "statement:              UPDATE APPLY",
    `target app:             APP${stmt.appId}`,
    `parent selector:        ${safeWhereToKintone(stmt.where)}`,
    `parent cardinality:     ${isSinglePositiveRecordIdWhere(stmt.where) ? "single" : "multiple"}`,
    ...selectionLines,
    `apply target:           ${branch.targets.map((target) => `${target.field} (${target.targetKind})`).join(" | ")}`,
    `operations:             ${operationKinds.join(" | ")}`,
    `selector:               ${selectorKinds.join(" | ")}`,
    "snapshot evaluation:    yes",
    "inserted rows visible:  no",
    "revision guard:         required",
    "revision:               unknown (records API not called)",
    `payload preservation:   row ids=yes, row order=yes, unpatched cells=yes, remove tables=${hasRemove ? "FULL_SURVIVORS" : "none"}`,
    "post-image validation:  required (B43 equivalent)",
    "parent rows:            unknown (records API not called)",
    "matched subtable rows:  unknown (records API not called)",
    "validation errors:      unknown (records API not called)",
    `deleted rows:           ${hasRemove ? "unknown (records API not called)" : "0 (static without REMOVE)"}`,
    `dmlMaxRows:             ${dmlMaxRows}`,
    `dmlMaxSubtableRows:     ${dmlMaxSubtableRows}`,
    "MCP mutation:           disabled in v1",
    ...formatStaticApplyDiagnostic(diagnostic),
  ];
}

function buildDeletePlan(stmt: DeleteStatement, label?: string): string[] {
  const lines: string[] = [];
  if (label) lines.push(label);
  lines.push(`  [DELETE]`);
  lines.push(`  target:        APP${stmt.appId} (${stmt.appId})`);
  lines.push(`  kintone query: ${safeWhereToKintone(stmt.where)}`);
  if (!stmt.subtableCode) {
    lines.push("  selection: exact native pushdown; JS residual none");
    lines.push("  search abort: DML fail-closed (SearchAbortedError; mutation 0)");
  }
  lines.push(isConstantFalseWhere(stmt.where)
    ? "  api:           metadata validation only (records API access: none)"
    : `  api:           GET /k/v1/records.json → DELETE /k/v1/records.json`);
  return lines;
}

function buildUpsertPlan(
  stmt: UpsertStatement,
  label?: string,
  dmlMaxRows = DEFAULT_APPLY_MAX_ROWS,
  dmlMaxSubtableRows = DEFAULT_APPLY_MAX_SUBTABLE_ROWS
): string[] {
  const totalRows  = stmt.values.length;
  const batchCount = Math.ceil(totalRows / 100);
  const lines = [
    ...(label ? [label] : []),
    `  [UPSERT]`,
    `  target:     APP${stmt.appId} (${stmt.appId})`,
    `  records:    ${totalRows} 件（バッチ ${batchCount} 回 × 最大 100 件）`,
    `  key fields: ${stmt.keyFields.join(", ")}`,
    `  fields:     ${stmt.fields.join(", ")}`,
    `  api:        GET /k/v1/records.json（重複判定）→ POST または PUT /k/v1/records.json × ${batchCount}`,
  ];
  return stmt.onInsertApplyBlocks?.length || stmt.onUpdateApplyBlocks?.length
    ? [...lines, ...formatStaticApplyDiagnostic(buildStaticApplyDiagnostic(stmt, dmlMaxRows, dmlMaxSubtableRows))]
    : lines;
}

function formatStaticApplyDiagnostic(diagnostic: ApplyDiagnostic): string[] {
  const lines = [
    `apply diagnostic:       ${diagnostic.statementKind}`,
    `non-transactional:      ${diagnostic.nonTransactional}`,
    `partial success:        ${diagnostic.partialSuccess.possible ? "possible" : "none"}`,
  ];
  for (const branch of diagnostic.branches) {
    lines.push(
      `apply branch:           ${branch.branch}`,
      `  parent rows:          ${branch.parentRows === null ? "unknown (records API not called)" : branch.parentRows}`,
      `  chunks:               ${branch.chunk.plannedChunks === null ? "unknown" : branch.chunk.plannedChunks} × max ${branch.chunk.size}`,
      `  revision guard:       ${branch.guards.revisionRequired ? "required" : "not required"}`
    );
    for (const target of branch.targets) {
      lines.push(
        `  target:               ${target.field} (${target.targetKind})`,
        `    operations:         ${target.operations.map((operation) => `${operation.kind}=${operation.count === null ? "unknown" : operation.count}`).join(" | ")}`,
        `    changed count:      ${target.changedCount === null ? "unknown" : target.changedCount}`
      );
    }
  }
  lines.push("records API:            0", "mutation API:           0");
  return lines;
}

function buildUpsertSelectPlan(
  stmt: UpsertSelectStatement,
  label?: string,
  capabilities?: ReadonlyMap<SelectStatement, PredicateCapabilityResult>,
  orderPlans?: ReadonlyMap<SelectStatement, CanonicalOrderPlan>,
  plainGroupByPlans?: ReadonlyMap<SelectStatement, PlainGroupByResolutionPlan>
): string[] {
  const lines: string[] = [
    ...(label ? [label] : []),
    `  [UPSERT SELECT]`,
    `  target:     APP${stmt.appId} (${stmt.appId})`,
    `  key fields: ${stmt.keyFields.join(", ")}`,
    `  fields:     ${stmt.fields.join(", ")}`,
    `  api:        GET /k/v1/records.json（重複判定）→ POST または PUT /k/v1/records.json（100 件ごとにバッチ）`,
    ``,
  ];
  lines.push(...buildSelectPlan(
    stmt.select, "[source SELECT]", capabilities, orderPlans, plainGroupByPlans, false, false
  ));
  return lines;
}

function buildReorderPlan(stmt: ReorderStatement, label?: string): string[] {
  const target = `APP${stmt.appId}$${stmt.subtableCode}`;
  const scope   = stmt.all ? "全親レコード対象" : "WHERE 条件に一致する親レコード対象";
  const byStr   = stmt.by.map(formatOrderByItem).join(", ");
  const lines: string[] = [
    ...(label ? [label] : []),
    `  [REORDER]`,
    `  target: APP${stmt.appId} (${stmt.appId})`,
    `  table:  ${target}`,
    `  scope:  ${scope}`,
    `  by:     ${byStr}`,
    isConstantFalseWhere(stmt.where)
      ? `  api:    metadata validation only (records API access: none)`
      : `  api:    GET /k/v1/records.json（行 ID 取得）→ PUT /k/v1/records.json（id 配列のみ送信）`,
  ];
  if (!stmt.all && stmt.where) {
    lines.splice(5, 0, `  where:  ${safeWhereToKintone(stmt.where)}`);
  }
  return lines;
}

function formatOrderByItem(item: OrderByItem): string {
  const key = item.key.type === "FIELD_NAME" ? item.key.name : "(式)";
  return `${key} ${item.direction}`;
}

/** whereToKintone が例外を投げる場合（JS 関数含む等）は "(JS 評価)" を返す */
function safeWhereToKintone(where: WhereExpr): string {
  if (where.type === "BOOLEAN") return where.value ? "TRUE" : "FALSE (constant)";
  try {
    return whereToKintone(where);
  } catch {
    return "(JS 評価が必要なため kintone クエリに変換不可)";
  }
}

/** UPDATE の行評価 SET で参照されるフィールド名を収集する */
function collectArithRefFields(stmt: UpdateStatement): string[] {
  const refs = new Set<string>();
  for (const { value } of stmt.assignments) {
    if (value.type === "ARITH") collectArithNodeRefs(value, refs);
    if (value.type === "STRING_FUNC") collectArithNodeRefs(value, refs);
    if (value.type === "SCALAR_ARITH" || value.type === "CONCAT_OP") collectScalarNodeRefs(value, refs);
  }
  return [...refs];
}

function collectArithNodeRefs(node: LegacyArithExpr | ArithNode, out: Set<string>): void {
  if (node.type === "VARIABLE") {
    throw new Error(
      `InternalError: unresolved arithmetic variable @${node.name} reached CHECK field collection.`
    );
  }
  if (node.type === "FIELD_REF") { out.add(node.field); return; }
  if (node.type === "ARITH") {
    collectArithNodeRefs(node.left, out);
    collectArithNodeRefs(node.right, out);
  }
  if (node.type === "STRING_FUNC") {
    for (const arg of node.args) {
      if (arg.type === "AGG_GROUP_KEY") out.add(arg.tableAlias ? `${arg.tableAlias}.${arg.field}` : arg.field);
      else if (arg.type !== "AGG_REF" && arg.type !== "AGG_ARITH" && arg.type !== "VARIABLE") collectScalarNodeRefs(arg, out);
    }
  }
}

interface UpdateFromCheckScope {
  targetFields: string[];
  sourceFields: string[];
  evaluationTypes: ReadonlyMap<string, string>;
}

async function resolveUpdateFromCheckScope(
  stmt: UpdateStatement,
  from: NonNullable<UpdateStatement["from"]>,
  client: KintoneClient,
  cacheContext: string,
  tempTables?: Map<string, MaterializedTable>
): Promise<UpdateFromCheckScope> {
  const refs = checkRefs(stmt);
  const targetTypes = await getFieldTypeMap(stmt.appId, client, cacheContext);
  const sourceTableName = from.cteName;
  const sourceTypes: ReadonlyMap<string, string> = sourceTableName !== null
    ? new Map((tempTables?.get(sourceTableName)?.columns ?? []).map((column) => [
        column,
        tempTables?.get(sourceTableName)?.columnMeta?.get(column)?.fieldType
          ?? (tempTables?.get(sourceTableName)?.columnMeta?.get(column)?.semantics?.compareMode === "number" ? "NUMBER" : "SINGLE_LINE_TEXT"),
      ]))
    : await getFieldTypeMap(from.appId, client, cacheContext);
  const targetFields = new Set<string>();
  const sourceFields = new Set<string>();
  for (const ref of refs) {
    if (ref.tableAlias !== null) {
      if (ref.tableAlias.toLowerCase() === `app${stmt.appId}`.toLowerCase()) {
        if (ref.field !== "$id" && !targetTypes.has(ref.field)) throw customCheckParseError(`CHECK のターゲットフィールド ${ref.field} は存在しません`);
        targetFields.add(ref.field);
      } else if (ref.tableAlias.toLowerCase() === from.alias.toLowerCase()) {
        if (ref.field !== "$id" && !sourceTypes.has(ref.field)) throw customCheckParseError(`CHECK のソースフィールド ${ref.field} は存在しません`);
        sourceFields.add(ref.field);
      } else {
        throw customCheckParseError(`CHECK の修飾子 ${ref.tableAlias} は更新先または FROM alias ではありません`);
      }
      continue;
    }
    const inTarget = ref.field === "$id" || targetTypes.has(ref.field);
    const inSource = ref.field === "$id" || sourceTypes.has(ref.field);
    if (!inTarget) {
      throw customCheckParseError(`UPDATE FROM の CHECK ではソース列 ${ref.field} を修飾してください`);
    }
    if (inSource) {
      throw customCheckParseError(`UPDATE FROM の CHECK の非修飾フィールド ${ref.field} は曖昧です`);
    }
    targetFields.add(ref.field);
  }
  const evaluationTypes = new Map<string, string>();
  for (const [field, type] of targetTypes) {
    evaluationTypes.set(field, type);
    evaluationTypes.set(`APP${stmt.appId}.${field}`, type);
  }
  evaluationTypes.set("$id", "RECORD_NUMBER");
  evaluationTypes.set(`APP${stmt.appId}.$id`, "RECORD_NUMBER");
  for (const [field, type] of sourceTypes) evaluationTypes.set(`${from.alias}.${field}`, type);
  return { targetFields: [...targetFields], sourceFields: [...sourceFields], evaluationTypes };
}

function updateFromEvaluationRow(
  pair: { target: KintoneRecord; source: ProcessRow } | undefined,
  appId: number,
  sourceAlias: string
): ProcessRow {
  if (!pair) return {};
  const target = flatten(pair.target, null);
  return Object.fromEntries([
    ...Object.entries(target),
    ...Object.entries(target).map(([field, value]) => [`APP${appId}.${field}`, value] as const),
    ...Object.entries(pair.source).map(([field, value]) => [`${sourceAlias}.${field}`, value] as const),
  ]);
}

function collectScalarNodeRefs(node: ScalarValueExpr, out: Set<string>): void {
  if (node.type === "FIELD") { out.add(node.tableAlias ? `${node.tableAlias}.${node.field}` : node.field); return; }
  if (node.type === "STRING_FUNC") {
    for (const arg of node.args) {
      if (arg.type === "AGG_GROUP_KEY") out.add(arg.tableAlias ? `${arg.tableAlias}.${arg.field}` : arg.field);
      else if (arg.type !== "AGG_REF" && arg.type !== "AGG_ARITH" && arg.type !== "VARIABLE") collectScalarNodeRefs(arg, out);
    }
    return;
  }
  if (node.type === "SCALAR_ARITH" || node.type === "CONCAT_OP") {
    collectScalarNodeRefs(node.left, out);
    collectScalarNodeRefs(node.right, out);
  }
}

/** Assignment を人が読める形式にフォーマットする */
function formatAssignment(a: Assignment): string {
  const v = a.value;
  if (v.type === "STRING")          return `${a.field} = '${v.value}'`;
  if (v.type === "NUMBER")          return `${a.field} = ${v.value}`;
  if (v.type === "ARITH")           return `${a.field} = ${formatArithExprStr(v)}`;
  if (v.type === "CASE_VALUE")      return `${a.field} = CASE WHEN ...`;
  if (v.type === "STRING_FUNC")     return `${a.field} = ${v.func}(...)`;
  if (v.type === "SCALAR_SUBQUERY") return `${a.field} = (SELECT ...)`;
  if (v.type === "SOURCE_FIELD")    return `${a.field} = ${v.alias}.${v.field}`;
  return `${a.field} = (${v.type})`;
}

function formatArithExprStr(expr: LegacyArithExpr): string {
  return `${formatArithNodeStr(expr.left)} ${expr.op} ${formatArithNodeStr(expr.right)}`;
}

function formatArithNodeStr(node: ArithNode): string {
  if (node.type === "VARIABLE") {
    throw new Error(
      `InternalError: unresolved arithmetic variable @${node.name} reached arithmetic formatting.`
    );
  }
  if (node.type === "FIELD_REF") return node.field;
  if (node.type === "NUMBER")    return numberLiteralText(node);
  if (node.type === "ARITH")     return `(${formatArithExprStr(node)})`;
  return "...";
}

// ============================================================
// エラー
// ============================================================

export class OperationCancelledError extends Error {
  constructor(
    public readonly operation: "UPDATE" | "DELETE" | "INSERT",
    public readonly affectedCount: number
  ) {
    super(
      `${operation} をキャンセルしました（対象: ${affectedCount} 件）`
    );
    this.name = "OperationCancelledError";
  }
}

export const __testOnlyMetricsPropagation = {
  createEmptyMetrics,
  markLimitReached,
  wrapClientWithCursorScope,
  wrapClientWithMetrics,
  wrapClientWithSearchAbort,
};
