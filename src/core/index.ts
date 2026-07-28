// ============================================================
// core index — UI/CLI から利用する公開API
// ============================================================

export { execute, executeBatch, buildBatchExplainPlans, TEMP_TABLE_MAX_ROWS, OperationCancelledError, AssertError, RejectLimitExceededError, SearchAbortedError } from "../execute";
export { parseSqlStatement, parseSqlStatements } from "./sql";
export { validateKlikeStatement, KlikeValidationError } from "./klikeValidation";
export { analyzeBatch, BatchAnalysisError, MAX_TEMP_TABLES, MAX_BATCH_VARIABLES } from "./batch";
export { normalizeBatchVariableName, normalizeBatchVariables, validateDeclaredBatchVariables } from "./batchVariables";
export {
  getInsertValuesCount,
  getStatementType,
  isDmlType,
  writesKintone,
  isReadOnlyStatement,
  isRowReturningReadOnlyStatement,
  requiresCompleteInput,
} from "./dmlGuard";
export { statementHasApplyBlocks } from "./applyGuard";
export type { BatchAnalysis, StatementAnalysis, BatchVariableAnalysis } from "./batch";
export { formatDisplayText } from "./displayFormat";
export { resolveFieldSemantics, syntheticSemantics, withFieldSemanticSource } from "./fieldSemantics";
export { explainNeedsAppMetadata, whereNeedsFieldMetadata } from "./explainMetadata";
export type { CompareMode, ResolvedFieldSemantics } from "./fieldSemantics";
export type { ProcessStatusState } from "./processStatus";
export { parseNumberPrecisionSettings, exactDecimalDigitCounts } from "./numberPrecision";
export { ApplyWritePartialFailureError } from "./applyPatchExecutePrepared";
export type { ApplyWriteProgress, ApplyWriteFailureDetail } from "./applyPatchExecutePrepared";
export type {
  ApplyDiagnostic,
  ApplyDiagnosticBranch,
  ApplyDiagnosticTarget,
  ApplyDiagnosticOperation,
  ApplyDiagnosticGuard,
  ApplyDiagnosticChunk,
} from "./applyDiagnostic";
export { executePreparedApplyUpsert } from "./applyUpsertExecutePrepared";
export type { PreparedApplyUpsertResult } from "./applyUpsertExecutePrepared";
export type { NumberPrecision, NumberRoundingMode, RawNumberPrecisionSettings } from "./numberPrecision";

export type {
  DmlConfirmContext,
  ApplyConfirmDetail,
  ImportConfirmDetail,
  ExecuteOptions,
  ExecuteResult,
  ExecuteMetrics,
  SelectResult,
  UpdateResult,
  UpsertResult,
  AssertResult,
  DmlValidationResult,
  KintoneClient,
  KintoneAppInfo,
  KintoneFieldInfo,
  KintoneProcessStatuses,
  BatchExecuteOptions,
  BatchExecuteResult,
  BatchStatementResult,
  BatchStatementError,
  BatchStatementPlan,
} from "../execute";

export type { ProcessRow } from "../engine/process";

export type {
  KintonePostParams,
  KintonePutParams,
  KintoneDeleteParams,
} from "../converter/dmlToKintone";

export type { PageFetchParams } from "../api/fetchAll";
export type { KintoneCursorHandle, KintoneCursorOpenParams } from "../api/kintoneCursor";
export type { Statement, ImportStatement, DmlSource, CsvDmlSource, JsonDmlSource, ImportEncoding } from "../types/ast";
export type { ImportSourceHandle, ImportSourcePayload, ImportSourceResolver } from "../import/types";
export type { DisplayOptions } from "./displayFormat";
