import {
  executeBatch,
  type BatchStatementResult,
} from "../execute";
import { normalizeEngineError, searchAborted } from "./errors";
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

function isSearchAbortedStatement(statement: BatchStatementResult): boolean {
  return statement.status === "error"
    && statement.error?.message.startsWith("SearchAbortedError:") === true;
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

    if (batchResult.statements.some(isSearchAbortedStatement)) {
      throw searchAborted();
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
      ok: batchResult.ok,
      statementCount: batchResult.statementCount,
      statements,
      results,
      warnings: [],
    };
  } catch (error) {
    throw normalizeEngineError(error);
  }
}
