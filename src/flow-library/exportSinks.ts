import {
  getSelectColumnMeta,
  type ManagedStatementExecutionContext,
  type SelectResult,
} from "../execute";
import {
  serializeCsvExport as serializeCsvExportInternal,
  ExportSerializerError,
} from "../export/csvSerializer";
import { KsqlFlowError } from "./errors";
import { getManagedExportSinkContext } from "./exportSinkContext";
import type {
  ExecutionContext,
  FlowCsvExportInput,
  FlowCsvExportOptions,
  FlowCsvExportResult,
  FlowExportSinkStatus,
  StatementResult,
} from "./publicTypes";

function exportError(code: string, message: string, cause?: unknown): KsqlFlowError {
  return new KsqlFlowError(code, `${code}: ${message}`, cause);
}

function managedContext(context: ExecutionContext): ManagedStatementExecutionContext {
  const managed = getManagedExportSinkContext(context);
  if (!managed || managed.disposed) {
    throw exportError(
      "ExecutionContextDisposedError",
      "execution context is disposed or invalid."
    );
  }
  return managed;
}

function declaredTempName(managed: ManagedStatementExecutionContext, name: string): string {
  const tempName = `#${name}`;
  if (!managed.exportSinks.has(tempName)) {
    throw exportError("ExportSinkNotFoundError", "the export sink is not declared.");
  }
  return tempName;
}

function normalizeSerializerError(error: unknown): never {
  if (error instanceof KsqlFlowError) throw error;
  if (error instanceof ExportSerializerError) {
    throw new KsqlFlowError(error.code, error.message, error);
  }
  throw exportError("FLOW_ERROR", "CSV export failed.", error);
}

export function serializeCsvExport(
  input: FlowCsvExportInput,
  options: FlowCsvExportOptions = {}
): FlowCsvExportResult {
  try {
    return serializeCsvExportInternal(input, options);
  } catch (error) {
    return normalizeSerializerError(error);
  }
}

export function serializeSelectResultAsCsv(
  statement: StatementResult,
  options: FlowCsvExportOptions = {}
): FlowCsvExportResult {
  if (
    statement.status !== "success"
    || statement.result === null
    || typeof statement.result !== "object"
    || (statement.result as { type?: unknown }).type !== "SELECT"
  ) {
    throw exportError(
      "ExportSinkInvalidTargetError",
      "serializeSelectResultAsCsv requires a successful SELECT StatementResult."
    );
  }
  const result = statement.result as SelectResult;
  const columnMeta = getSelectColumnMeta(result);
  if (columnMeta === undefined) {
    throw exportError(
      "ExportSinkInvalidTargetError",
      "the SELECT result is not associated with engine column metadata."
    );
  }
  return serializeCsvExport({ columns: result.columns, rows: result.rows, columnMeta }, options);
}

export function exportSinkStatus(
  context: ExecutionContext,
  name: string
): FlowExportSinkStatus {
  const managed = managedContext(context);
  const tempName = declaredTempName(managed, name);
  if (managed.failed.size > 0 || (managed.aborted !== null && managed.aborted !== "exit")) {
    return "failed";
  }
  if (managed.busy || managed.nextIndex < managed.statements.length) return "incomplete";
  return managed.tempTables.has(tempName) ? "materialized" : "not-created";
}

export function serializeExportSink(
  context: ExecutionContext,
  name: string,
  options: FlowCsvExportOptions = {}
): FlowCsvExportResult {
  const status = exportSinkStatus(context, name);
  if (status !== "materialized") {
    const code = status === "not-created"
      ? "ExportSinkNotMaterializedError"
      : status === "incomplete"
      ? "ExportSinkExecutionIncompleteError"
      : "ExportSinkExecutionFailedError";
    throw exportError(code, `the export sink status is ${status}.`);
  }
  const managed = managedContext(context);
  const table = managed.tempTables.get(declaredTempName(managed, name));
  if (!table) {
    throw exportError("ExportSinkNotMaterializedError", "the export sink was not materialized.");
  }
  return serializeCsvExport({
    columns: table.columns,
    rows: table.rows,
    columnMeta: table.columnMeta,
  }, options);
}
