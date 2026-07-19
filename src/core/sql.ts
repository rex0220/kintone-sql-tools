import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";
import type { Statement } from "../types/ast";
import { validateKlikeStatement } from "./klikeValidation";

export function parseSqlStatement(sql: string, capabilities: { import?: boolean } = {}): Statement {
  const tokens = new Lexer(sql).tokenize();
  const stmt = new Parser(tokens, capabilities).parse();
  validateKlikeStatement(stmt);
  return stmt;
}

/** 複文（`;` 区切りバッチ）をパースする。単文入力でも要素1の配列を返す */
export function parseSqlStatements(sql: string, capabilities: { import?: boolean } = {}): Statement[] {
  const tokens = new Lexer(sql).tokenize();
  const statements = new Parser(tokens, capabilities).parseStatements();
  statements.forEach(validateKlikeStatement);
  return statements;
}
