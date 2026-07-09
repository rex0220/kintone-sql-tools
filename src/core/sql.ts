import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";
import type { Statement } from "../types/ast";

export function parseSqlStatement(sql: string): Statement {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parse();
}

/** 複文（`;` 区切りバッチ）をパースする。単文入力でも要素1の配列を返す */
export function parseSqlStatements(sql: string): Statement[] {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parseStatements();
}
