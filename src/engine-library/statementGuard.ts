import { parseSqlStatement, parseSqlStatements } from "../core/sql";
import { statementHasApplyBlocks } from "../core/applyGuard";
import {
  getStatementType,
  isDmlType,
  isReadOnlyStatement,
  isRowReturningReadOnlyStatement,
} from "../core/dmlGuard";
import { KlikeValidationError } from "../core/klikeValidation";
import type { Statement } from "../types/ast";
import {
  normalizeEngineError,
  parseError,
  readOnlyViolation,
} from "./errors";

/** Internal test seam for the parse-boundary error allowlist. */
export function normalizeParseBoundaryError(error: unknown) {
  if (error instanceof KlikeValidationError) {
    return parseError(error.message, error);
  }
  const normalized = normalizeEngineError(error);
  if (normalized.code === "PARSE_ERROR") return normalized;
  return parseError("SQL statement could not be parsed", error);
}

function parseSingleStatement(sql: string): Statement {
  if (sql.trim() === "") throw parseError("SQL statement is empty");
  try {
    return parseSqlStatement(sql, { import: true });
  } catch (error) {
    const normalized = normalizeParseBoundaryError(error);
    if (normalized.message.includes("複文はバッチ実行 API を使用してください")) {
      throw parseError(
        "This API accepts one statement; use runBatch for multiple statements",
        error
      );
    }
    throw normalized;
  }
}

function classifiedStatement(statement: unknown): Statement {
  const type = getStatementType(statement);
  if (type === "UNKNOWN") {
    throw readOnlyViolation("Unclassifiable statement is not allowed");
  }
  return statement as Statement;
}

function parseBatchStatements(sql: string): Statement[] {
  if (sql.trim() === "") throw parseError("SQL statement is empty");
  try {
    return parseSqlStatements(sql, { import: true });
  } catch (error) {
    throw normalizeParseBoundaryError(error);
  }
}

/** Internal test seam for the shared read-only classifier plus runQuery surface gates. */
export function assertRunQueryStatement(statement: unknown): void {
  const classified = classifiedStatement(statement);
  const type = classified.type;
  if (type === "IMPORT") {
    throw readOnlyViolation("IMPORT is disabled by default in engine library queries");
  }
  if (!isReadOnlyStatement(classified)) {
    throw readOnlyViolation(`${type} statements are not read-only`);
  }
  if (statementHasApplyBlocks(classified)) {
    throw readOnlyViolation("APPLY statements are not allowed in engine library queries");
  }
  if (!isRowReturningReadOnlyStatement(classified)) {
    throw readOnlyViolation(
      `${type} does not return rows; use runBatch for batch-scoped or non-row-returning read-only statements`
    );
  }
}

/** Internal test seam for the shared read-only classifier plus runBatch surface gates. */
export function assertRunBatchStatement(statement: unknown): void {
  const classified = classifiedStatement(statement);
  const target = classified.type === "EXPLAIN" ? classified.query : classified;
  if (target.type === "IMPORT") {
    throw readOnlyViolation("IMPORT is disabled by default in engine library batches");
  }
  if (!isReadOnlyStatement(target)) {
    throw readOnlyViolation(`${target.type} statements are not read-only`);
  }
  if (statementHasApplyBlocks(target)) {
    throw readOnlyViolation("APPLY statements are not allowed in engine library batches");
  }
  if (isDmlType(target.type)) {
    throw readOnlyViolation(
      "DML VALIDATE ONLY statements are not supported by runBatch"
    );
  }
}

/** Parse one complete statement and enforce the runQuery read-only/result-shape contract. */
export function guardRunQuerySql(sql: string): Statement {
  const statement = parseSingleStatement(sql);
  assertRunQueryStatement(statement);
  return statement;
}

/** Parse the complete batch and enforce every statement before executeBatch can make an API call. */
export function guardRunBatchSql(sql: string): Statement[] {
  const statements = parseBatchStatements(sql);
  statements.forEach(assertRunBatchStatement);
  return statements;
}

export interface ExplainQueryGuard {
  readonly statements: readonly Statement[];
  readonly legacySql?: string;
}

/**
 * Parse and guard explainQuery input using the runBatch acceptance boundary.
 * legacySql is present only for the pre-B89 single-query execute(EXPLAIN) path.
 */
export function prepareExplainQuerySql(sql: string): ExplainQueryGuard {
  const trimmed = sql.trim();
  const statements = parseBatchStatements(trimmed);
  statements.forEach(assertRunBatchStatement);
  const statement = statements[0];
  const target = statement.type === "EXPLAIN" ? statement.query : statement;
  if (
    statements.length === 1
    && (target.type === "SELECT" || target.type === "WITH" || target.type === "UNION")
  ) {
    return {
      statements,
      legacySql: statement.type === "EXPLAIN" ? trimmed : `EXPLAIN ${trimmed}`,
    };
  }
  return { statements };
}

/** Internal compatibility seam returning the SQL selected by the guard. */
export function guardExplainQuerySql(sql: string): string {
  const prepared = prepareExplainQuerySql(sql);
  return prepared.legacySql ?? sql.trim();
}
