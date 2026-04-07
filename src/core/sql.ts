import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";
import type { Statement } from "../types/ast";

export function parseSqlStatement(sql: string): Statement {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parse();
}
