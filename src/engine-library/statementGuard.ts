import { parseSqlStatement } from "../core/sql";
import type { Statement } from "../types/ast";
import {
  normalizeEngineError,
  parseError,
  readOnlyViolation,
} from "./errors";

type GuardMode = "run" | "explain";

type StatementNode = {
  readonly type?: unknown;
  readonly ctes?: unknown;
  readonly query?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
};

function parseSingleStatement(sql: string): Statement {
  if (sql.trim() === "") throw parseError("SQL statement is empty");
  try {
    return parseSqlStatement(sql, { import: true });
  } catch (error) {
    const normalized = normalizeEngineError(error);
    if (normalized.code === "PARSE_ERROR") throw normalized;
    throw parseError("SQL statement could not be parsed", error);
  }
}

function statementType(node: unknown): string {
  if (
    node === null ||
    typeof node !== "object" ||
    typeof (node as StatementNode).type !== "string"
  ) {
    throw readOnlyViolation("Unclassifiable statement branch is not allowed");
  }
  return (node as { readonly type: string }).type;
}

function assertReadStatement(node: unknown, mode: GuardMode): void {
  const type = statementType(node);
  switch (type) {
    case "SELECT":
      return;
    case "SHOW_APPS":
    case "DESCRIBE":
      if (mode === "run") return;
      break;
    case "WITH": {
      const withNode = node as StatementNode;
      if (!Array.isArray(withNode.ctes)) {
        throw readOnlyViolation("WITH contains an unclassifiable CTE list");
      }
      for (const cte of withNode.ctes) {
        if (cte === null || typeof cte !== "object" || !("query" in cte)) {
          throw readOnlyViolation("WITH contains an unclassifiable CTE body");
        }
        assertReadStatement((cte as { readonly query: unknown }).query, mode);
      }
      assertReadStatement(withNode.query, mode);
      return;
    }
    case "UNION": {
      const unionNode = node as StatementNode;
      assertReadStatement(unionNode.left, mode);
      assertReadStatement(unionNode.right, mode);
      return;
    }
    default:
      break;
  }
  throw readOnlyViolation(`${type} statements are not allowed in ${mode} queries`);
}

/** Internal test seam for fail-closed recursive classification. */
export function assertRunQueryStatement(statement: unknown): void {
  assertReadStatement(statement, "run");
}

/** Parse one complete statement and enforce the runQuery recursive allowlist. */
export function guardRunQuerySql(sql: string): void {
  assertRunQueryStatement(parseSingleStatement(sql));
}

/** Parse, recursively guard, and normalize the SQL passed to the engine EXPLAIN path. */
export function guardExplainQuerySql(sql: string): string {
  const trimmed = sql.trim();
  const statement = parseSingleStatement(trimmed);
  if (statement.type === "EXPLAIN") {
    assertReadStatement(statement.query, "explain");
    return trimmed;
  }
  assertReadStatement(statement, "explain");
  return `EXPLAIN ${trimmed}`;
}
