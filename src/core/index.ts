// ============================================================
// core index — UI/CLI から利用する公開API
// ============================================================

export { execute, OperationCancelledError } from "../execute";
export { parseSqlStatement, parseSqlStatements } from "./sql";
export { analyzeBatch, BatchAnalysisError, MAX_TEMP_TABLES } from "./batch";
export type { BatchAnalysis, StatementAnalysis } from "./batch";
export { formatDisplayText } from "./displayFormat";

export type {
  ExecuteOptions,
  ExecuteResult,
  ExecuteMetrics,
  SelectResult,
  UpsertResult,
  KintoneClient,
  KintoneAppInfo,
  KintoneFieldInfo,
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
