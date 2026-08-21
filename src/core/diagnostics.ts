export const DiagnosticCodes = {
  HEADER_UNKNOWN_KEY: "KSQL1001",
  HEADER_DUPLICATE_KEY: "KSQL1002",
  HEADER_INVALID_NAME: "KSQL1003",
  HEADER_INVALID_DEPENDS_ON: "KSQL1004",
  HEADER_INVALID_TIMEOUT: "KSQL1005",
  HEADER_INVALID_DIALECT: "KSQL1006",
  LOGICAL_APP_UNRESOLVED: "KSQL1101",
  LEX_ERROR: "KSQL1201",
  PARSE_ERROR: "KSQL1202",
} as const;

/** Structured diagnostics use an independent KSQL-prefixed number space. */
export type DiagnosticCode = typeof DiagnosticCodes[keyof typeof DiagnosticCodes];

export interface Diagnostic {
  severity: "error" | "warning";
  code: DiagnosticCode;
  message: string;
  line: number;
  column: number;
  statementIndex?: number;
}

export interface SourceLocation {
  line: number;
  column: number;
}

/** Convert a UTF-16 character offset in the original source to a 1-based line/column. */
export function sourceLocationAt(source: string, offset: number): SourceLocation {
  const target = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < target; i++) {
    const ch = source[i];
    if (ch === "\r") {
      if (source[i + 1] === "\n" && i + 1 < target) i++;
      line++;
      column = 1;
    } else if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

export function diagnosticAt(
  source: string,
  offset: number,
  diagnostic: Omit<Diagnostic, "line" | "column">
): Diagnostic {
  return { ...diagnostic, ...sourceLocationAt(source, offset) };
}
