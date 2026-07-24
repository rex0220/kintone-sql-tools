import { FetchAllLimitError } from "../api/fetchAll";
import { SearchAbortedError } from "../execute";
import { LexError } from "../lexer/lexer";
import { ParseError } from "../parser/parser";

export class KsqlEngineError extends Error {
  readonly code:
    | "PARSE_ERROR"
    | "READ_ONLY_VIOLATION"
    | "SEARCH_ABORTED"
    | "FETCH_LIMIT_EXCEEDED"
    | "CLIENT_ERROR"
    | "EXECUTION_ERROR";
  readonly cause?: unknown;

  constructor(code: KsqlEngineError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "KsqlEngineError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function readOnlyViolation(message: string): KsqlEngineError {
  return new KsqlEngineError("READ_ONLY_VIOLATION", message);
}

export function parseError(message: string, cause?: unknown): KsqlEngineError {
  return new KsqlEngineError("PARSE_ERROR", message, cause);
}

export function searchAborted(): KsqlEngineError {
  const cause = new SearchAbortedError();
  return new KsqlEngineError("SEARCH_ABORTED", cause.message, cause);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

function hasClientErrorShape(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const shaped = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  return (
    typeof shaped.status === "number" ||
    typeof shaped.response?.status === "number" ||
    (typeof shaped.code === "string" && shaped.code.trim() !== "")
  );
}

export function normalizeEngineError(error: unknown): KsqlEngineError {
  if (error instanceof KsqlEngineError) return error;
  if (error instanceof LexError || error instanceof ParseError) {
    return new KsqlEngineError("PARSE_ERROR", errorMessage(error), error);
  }
  if (error instanceof SearchAbortedError || (error as { name?: unknown })?.name === "SearchAbortedError") {
    return new KsqlEngineError("SEARCH_ABORTED", errorMessage(error), error);
  }
  if (error instanceof FetchAllLimitError || (error as { name?: unknown })?.name === "FetchAllLimitError") {
    return new KsqlEngineError("FETCH_LIMIT_EXCEEDED", errorMessage(error), error);
  }
  if (
    error instanceof Error &&
    error.name === "ClientOperationError" &&
    "cause" in error
  ) {
    return new KsqlEngineError("CLIENT_ERROR", error.message, error.cause);
  }
  if (hasClientErrorShape(error)) {
    return new KsqlEngineError("CLIENT_ERROR", errorMessage(error), error);
  }
  return new KsqlEngineError("EXECUTION_ERROR", errorMessage(error), error);
}
