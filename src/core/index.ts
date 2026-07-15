// ============================================================
// core index — UI/CLI から利用する公開API
// ============================================================

export { execute, executeBatch, buildBatchExplainPlans, TEMP_TABLE_MAX_ROWS, OperationCancelledError, AssertError } from "../execute";
export { parseSqlStatement, parseSqlStatements } from "./sql";
export { analyzeBatch, BatchAnalysisError, MAX_TEMP_TABLES, MAX_BATCH_VARIABLES } from "./batch";
export { normalizeBatchVariableName, normalizeBatchVariables, validateDeclaredBatchVariables } from "./batchVariables";
export { getInsertValuesCount, getStatementType, isDmlType } from "./dmlGuard";
export type { BatchAnalysis, StatementAnalysis, BatchVariableAnalysis } from "./batch";
export { formatDisplayText } from "./displayFormat";

export type {
  DmlConfirmContext,
  ExecuteOptions,
  ExecuteResult,
  ExecuteMetrics,
  SelectResult,
  UpsertResult,
  AssertResult,
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
export type { Statement } from "../types/ast";
export type { DisplayOptions } from "./displayFormat";
