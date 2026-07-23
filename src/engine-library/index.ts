import { KsqlEngineError } from "./errors";
import { explainQuery, runQuery } from "./query";

declare const __KSQL_ENGINE_VERSION__: string;

export const version: string =
  typeof __KSQL_ENGINE_VERSION__ === "string"
    ? __KSQL_ENGINE_VERSION__
    : "0.0.0-dev";

export { explainQuery, KsqlEngineError, runQuery };

export type {
  CreateReadonlyKintoneClientOptions,
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
  RunQueryOptions,
} from "./publicTypes";
