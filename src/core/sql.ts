import { Lexer } from "../lexer/lexer";
import { Parser, type ParserCapabilities } from "../parser/parser";
import type { Statement } from "../types/ast";
import { parseScriptHeader, type ScriptHeaderMeta } from "./scriptHeader";
import { validateStatementStatic } from "./statementValidation";

export interface ScriptSqlParseResult {
  statements: Statement[];
  meta: ScriptHeaderMeta;
}

export function parseSqlStatement(sql: string, capabilities: ParserCapabilities = {}): Statement {
  const tokens = new Lexer(sql).tokenize();
  const stmt = new Parser(tokens, capabilities).parse();
  validateStatementStatic(stmt);
  return stmt;
}

/** 複文（`;` 区切りバッチ）をパースする。単文入力でも要素1の配列を返す */
export function parseSqlStatements(sql: string, capabilities: ParserCapabilities = {}): Statement[] {
  const tokens = new Lexer(sql).tokenize();
  const statements = new Parser(tokens, capabilities).parseStatements();
  statements.forEach(validateStatementStatic);
  return statements;
}

/**
 * スクリプトヘッダを解釈して複文をパースする出荷面向け事前解析。
 * ヘッダなし入力では parseSqlStatements と同じ capabilities をそのまま使用する。
 */
export function parseSqlStatementsForScript(
  sql: string,
  capabilities: ParserCapabilities = {}
): ScriptSqlParseResult {
  const header = parseScriptHeader(sql);
  const headerError = header.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (header.hasDirectives && headerError) {
    throw new Error(`${headerError.code}: ${headerError.message} (${headerError.line}:${headerError.column})`);
  }
  const scriptSql = header.hasDirectives ? sql.slice(header.headerEnd) : sql;
  const scriptCapabilities = header.hasDirectives
    ? { ...capabilities, dialect1: header.meta.dialect === 1 }
    : capabilities;
  return {
    statements: parseSqlStatements(scriptSql, scriptCapabilities),
    meta: header.meta,
  };
}
