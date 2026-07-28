import { KsqlEngineError } from "./errors";
import { createReadonlyKintoneClient } from "./browserClient";
import { runBatch } from "./batch";
import { explainQuery, runQuery } from "./query";

declare const __KSQL_ENGINE_VERSION__: string;

export const version: string =
  typeof __KSQL_ENGINE_VERSION__ === "string"
    ? __KSQL_ENGINE_VERSION__
    : "0.0.0-dev";

export {
  createReadonlyKintoneClient,
  explainQuery,
  KsqlEngineError,
  runBatch,
  runQuery,
};

export type {
  CreateReadonlyKintoneClientOptions,
  BatchResult,
  BatchResultItem,
  BatchStatementInfo,
  ExplainResult,
  QueryColumn,
  QueryMetrics,
  QueryResult,
  ReadonlyAppInfo,
  ReadonlyCursorHandle,
  ReadonlyCursorOpenParams,
  ReadonlyCursorPage,
  ReadonlyFieldInfo,
  ReadonlyGetRecordsParams,
  ReadonlyGetRecordsResult,
  ReadonlyKintoneClient,
  ReadonlyKintoneFieldValue,
  ReadonlyKintoneRecord,
  ReadonlyNumberPrecision,
  ReadonlyNumberRoundingMode,
  ReadonlyProcessStatuses,
  ReadonlyProcessStatusState,
  RunBatchOptions,
  RunQueryOptions,
  ValidateConstraintCategory,
  ValidateConstraintMetadata,
} from "./publicTypes";
