import { LexError, Lexer } from "../lexer/lexer";
import { TokenKind } from "../lexer/tokens";
import { ParseError, Parser, type StatementRange } from "../parser/parser";
import type { Statement } from "../types/ast";
import {
  canonicalizeLogicalAppName,
  collectAppProfileTokens,
  normalizeSqlAppProfiles,
  type SqlRewriteSegment,
} from "./logicalApps";
import { validateStatementStatic } from "./statementValidation";
import { DiagnosticCodes, diagnosticAt, type Diagnostic } from "./diagnostics";
import { parseScriptHeader, type ScriptHeaderMeta } from "./scriptHeader";

export interface ParseScriptOptions {
  /** Logical application name to physical kintone application ID. */
  apps?: Readonly<Record<string, number>>;
}

export interface ParseScriptResult {
  meta: ScriptHeaderMeta;
  statements: Statement[];
  statementRanges: StatementRange[];
  diagnostics: Diagnostic[];
}

export function parseScript(source: string, opts: ParseScriptOptions = {}): ParseScriptResult {
  const header = parseScriptHeader(source);
  const diagnostics = [...header.diagnostics];
  let sql = source;
  let rewriteSegments: readonly SqlRewriteSegment[] = [];

  const logicalTokens = collectAppProfileTokens(source)
    .filter((token) => token.source === "logical");
  const apps = normalizeApps(opts.apps);
  for (const token of logicalTokens) {
    if (apps?.has(token.logicalName)) continue;
    diagnostics.push(diagnosticAt(source, token.start, {
      severity: "error",
      code: DiagnosticCodes.LOGICAL_APP_UNRESOLVED,
      message: opts.apps === undefined
        ? `Logical app LAPP_${token.logicalName} requires parseScript option apps.`
        : `Logical app LAPP_${token.logicalName} is not defined in parseScript option apps.`,
    }));
  }
  if (logicalTokens.length > 0 && !diagnostics.some((item) =>
    item.code === DiagnosticCodes.LOGICAL_APP_UNRESOLVED
  )) {
    const normalized = normalizeSqlAppProfiles(source, "flow", {
      resolveLogicalApp(name) {
        return apps!.get(name)!;
      },
    });
    sql = normalized.normalizedSql;
    rewriteSegments = normalized.rewriteSegments;
  }

  if (logicalTokens.length > 0 && diagnostics.some((item) =>
    item.code === DiagnosticCodes.LOGICAL_APP_UNRESOLVED
  )) {
    return { meta: header.meta, statements: [], statementRanges: [], diagnostics };
  }

  try {
    const parsed = new Parser(new Lexer(sql).tokenize(), {
      dialect1: header.meta.dialect === 1,
    }).parseStatementsWithRanges();
    const statementRanges = parsed.statementRanges.map((range) => ({
      start: sourceOffsetForNormalizedOffset(range.start, rewriteSegments, "start"),
      end: sourceOffsetForNormalizedOffset(range.end, rewriteSegments, "end"),
    }));
    parsed.statements.forEach((statement, statementIndex) => {
      try {
        validateStatementStatic(statement);
      } catch (error) {
        diagnostics.push(diagnosticAt(source, statementRanges[statementIndex]?.start ?? 0, {
          severity: "error",
          code: DiagnosticCodes.PARSE_ERROR,
          message: errorMessage(error),
          statementIndex,
        }));
      }
    });
    return { meta: header.meta, statements: parsed.statements, statementRanges, diagnostics };
  } catch (error) {
    const normalizedOffset = error instanceof ParseError
      ? error.token.pos
      : error instanceof LexError
        ? error.pos
        : 0;
    const offset = sourceOffsetForNormalizedOffset(normalizedOffset, rewriteSegments, "start");
    diagnostics.push(diagnosticAt(source, offset, {
      severity: "error",
      code: error instanceof LexError ? DiagnosticCodes.LEX_ERROR : DiagnosticCodes.PARSE_ERROR,
      message: error instanceof ParseError ? error.rawMessage : errorMessage(error),
      statementIndex: statementIndexAt(source, offset),
    }));
    return { meta: header.meta, statements: [], statementRanges: [], diagnostics };
  }
}

function normalizeApps(apps: ParseScriptOptions["apps"]): ReadonlyMap<string, number> | undefined {
  if (apps === undefined) return undefined;
  const normalized = new Map<string, number>();
  for (const [name, appId] of Object.entries(apps)) {
    try {
      normalized.set(canonicalizeLogicalAppName(name), appId);
    } catch {
      // Invalid keys cannot match a token accepted by the existing LAPP scanner.
    }
  }
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statementIndexAt(source: string, offset: number): number {
  try {
    const tokens = new Lexer(source.slice(0, offset)).tokenize();
    let statementIndex = 0;
    let hasToken = false;
    for (const token of tokens) {
      if (token.kind === TokenKind.EOF) break;
      if (token.kind === TokenKind.SEMICOLON) {
        if (hasToken) statementIndex++;
        hasToken = false;
      } else {
        hasToken = true;
      }
    }
    return statementIndex;
  } catch {
    return 0;
  }
}

function sourceOffsetForNormalizedOffset(
  offset: number,
  segments: readonly SqlRewriteSegment[],
  edge: "start" | "end"
): number {
  if (segments.length === 0) return offset;
  for (const segment of segments) {
    if (offset < segment.normalizedStart || offset > segment.normalizedEnd) continue;
    const normalizedLength = segment.normalizedEnd - segment.normalizedStart;
    const sourceLength = segment.sourceEnd - segment.sourceStart;
    if (normalizedLength === sourceLength) {
      return segment.sourceStart + Math.min(offset - segment.normalizedStart, sourceLength);
    }
    if (offset === segment.normalizedStart) return segment.sourceStart;
    if (offset === segment.normalizedEnd) return segment.sourceEnd;
    return edge === "start" ? segment.sourceStart : segment.sourceEnd;
  }
  return segments[segments.length - 1].sourceEnd;
}
