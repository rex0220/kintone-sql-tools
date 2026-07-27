import {
  executeBatch,
  type BatchStatementResult,
} from "../execute";
import {
  KsqlEngineError,
  normalizeEngineError,
  withStatementDiagnostic,
} from "./errors";
import { withCursorScope } from "./cursorScope";
import { validateBatchOptions } from "./options";
import { projectReadonlyClient } from "./readonlyClient";
import { toQueryResult } from "./resultMapping";
import { guardRunBatchSql } from "./statementGuard";
import type {
  BatchResult,
  BatchStatementInfo,
  QueryResult,
  ReadonlyKintoneClient,
  RunBatchOptions,
} from "./publicTypes";

function toStatementFailure(statement: BatchStatementResult): KsqlEngineError {
  const error = statement.error;
  const normalized = error?.cause !== undefined
    ? normalizeEngineError(error.cause)
    : new KsqlEngineError(
      "EXECUTION_ERROR",
      error?.message ?? `Statement ${statement.index} failed`
    );
  return withStatementDiagnostic(normalized, statement.index, statement.type);
}

export async function runBatch(
  sql: string,
  options: RunBatchOptions
): Promise<BatchResult> {
  try {
    const invocation = validateBatchOptions(options);
    guardRunBatchSql(sql);
    const batchResult = await withCursorScope(
      invocation.client,
      (scopedClient) => executeBatch(
        sql,
        projectReadonlyClient(scopedClient),
        { ...invocation.executeOptions, captureColumnMeta: true }
      )
    );

    const failedStatement = batchResult.statements.find(
      (statement) => statement.status === "error"
    );
    if (failedStatement !== undefined) {
      throw toStatementFailure(failedStatement);
    }

    const results: QueryResult[] = [];
    const statements: BatchStatementInfo[] = batchResult.statements.map((statement) => {
      const entry: {
        index: number;
        type: string;
        status: BatchStatementInfo["status"];
        tempTable?: string;
        rowCount?: number;
        resultIndex?: number;
        error?: { code: string; message: string };
        skippedReason?: string;
      } = {
        index: statement.index,
        type: statement.type,
        status: statement.status,
      };
      if (statement.tempTable !== undefined) entry.tempTable = statement.tempTable;
      if (statement.rowCount !== undefined) entry.rowCount = statement.rowCount;
      if (statement.error !== undefined) {
        entry.error = {
          code: statement.error.code,
          message: statement.error.message,
        };
      }
      if (statement.skippedReason !== undefined) {
        entry.skippedReason = statement.skippedReason;
      }
      if (statement.status === "success" && statement.result?.type === "SELECT") {
        entry.resultIndex = results.length;
        results.push(toQueryResult(statement.result, batchResult.metrics));
      }
      return entry;
    });

    return {
      type: "batch",
      batch: true,
      statementCount: batchResult.statementCount,
      statements,
      results,
      warnings: [],
    };
  } catch (error) {
    throw normalizeEngineError(error);
  }
}
