// ============================================================
// core index — UI/CLI から利用する公開API
// ============================================================

export { execute, executeBatch, buildBatchExplainPlans, TEMP_TABLE_MAX_ROWS, OperationCancelledError, AssertError, RejectLimitExceededError, SearchAbortedError } from "../execute";
export { parseSqlStatement, parseSqlStatements } from "./sql";
export { validateKlikeStatement, KlikeValidationError } from "./klikeValidation";
export { analyzeBatch, BatchAnalysisError, MAX_TEMP_TABLES, MAX_BATCH_VARIABLES } from "./batch";
export { normalizeBatchVariableName, normalizeBatchVariables, validateDeclaredBatchVariables } from "./batchVariables";
export { getInsertValuesCount, getStatementType, isDmlType, writesKintone, isReadOnlyStatement, requiresCompleteInput } from "./dmlGuard";
export type { BatchAnalysis, StatementAnalysis, BatchVariableAnalysis } from "./batch";
export { formatDisplayText } from "./displayFormat";
export { resolveFieldSemantics, syntheticSemantics, withFieldSemanticSource } from "./fieldSemantics";
export { explainNeedsAppMetadata, whereNeedsFieldMetadata } from "./explainMetadata";
export type { CompareMode, ResolvedFieldSemantics } from "./fieldSemantics";
export type { ProcessStatusState } from "./processStatus";

export type {
  DmlConfirmContext,
  ExecuteOptions,
  ExecuteResult,
  ExecuteMetrics,
  SelectResult,
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
export type { Statement } from "../types/ast";
export type { DisplayOptions } from "./displayFormat";
