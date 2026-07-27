import { parseSqlStatement } from "../core/sql";
import { statementHasApplyBlocks } from "../core/applyGuard";
import {
  getStatementType,
  isExplainableReadOnlyStatement,
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
    throw normalizeParseBoundaryError(error);
  }
}

function classifiedStatement(statement: unknown): Statement {
  const type = getStatementType(statement);
  if (type === "UNKNOWN") {
    throw readOnlyViolation("Unclassifiable statement is not allowed");
  }
  return statement as Statement;
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
      `${type} does not return rows; this API accepts only a single read-only query that returns rows`
    );
  }
}

/** Parse one complete statement and enforce the runQuery read-only/result-shape contract. */
export function guardRunQuerySql(sql: string): void {
  assertRunQueryStatement(parseSingleStatement(sql));
}

/** Parse, guard, and normalize the SQL passed to the engine EXPLAIN path. */
export function guardExplainQuerySql(sql: string): string {
  const trimmed = sql.trim();
  const statement = parseSingleStatement(trimmed);
  const target = statement.type === "EXPLAIN" ? statement.query : statement;
  if (!isExplainableReadOnlyStatement(target)) {
    throw readOnlyViolation(`${target.type} statements are not allowed in explain queries`);
  }
  return statement.type === "EXPLAIN" ? trimmed : `EXPLAIN ${trimmed}`;
}
