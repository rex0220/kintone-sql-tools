// ============================================================
// console 入力の判定ロジック（フェーズ1 S7、仕様 §8.2）
//
// console の状態機械のうち「1行入力を受けて何をするか」の判定だけを
// 純関数として切り出す。I/O・履歴・実行は呼び出し側（runConsole）が担う。
//
// 判定順序:
//   1. `:` 始まりはメタコマンド（バッファ状態に関わらず）
//   2. バッチ構築モード（先頭コメントを除き CREATE TEMP TABLE で始まる、
//      または完結バッファに CREATE/DROP TEMP TABLE を含む）→ :run まで蓄積
//   3. 行末が `;` でなければ蓄積（従来互換: 複数行入力）
//   4. 行末が `;` でパース完結 → 1文なら単文実行、2文以上ならバッチ実行
//   5. 継続可能なパース失敗（未終端文字列/コメント = LexError.unterminated、
//      句の途中 = ParseError が EOF を指す）→ 蓄積を継続
//      （文字列リテラル内の `;` での誤実行を防ぐ — 従来挙動より安全）
//   6. それ以外のパース失敗（typo 等）→ 即エラー + バッファ破棄
// ============================================================

import { Lexer, LexError } from "../lexer/lexer";
import { Parser, ParseError } from "../parser/parser";
import { TokenKind } from "../lexer/tokens";
import { normalizeSqlAppProfiles } from "../node/appProfiles";

export type ConsoleInputDecision =
  | { kind: "meta" }
  | { kind: "ignore" }
  | { kind: "continue"; buffer: string }
  | { kind: "execute-single"; sql: string }
  | { kind: "execute-batch"; sql: string }
  | { kind: "error"; message: string };

export function decideConsoleInput(buffer: string, line: string): ConsoleInputDecision {
  const t = line.trim();
  // メタコマンドはバッファ非空でも解釈する（SQL としてバッファに混入させない）
  if (t.startsWith(":")) return { kind: "meta" };

  const newBuffer = buffer.length > 0 ? `${buffer}\n${line}` : line;
  if (newBuffer.trim().length === 0) return { kind: "ignore" };

  // バッチ構築モード: 行末 `;` では実行せず :run まで蓄積する
  //（単文の CREATE TEMP TABLE は実行しても拒否されるため、即実行は常に誤り）
  if (isBatchConstruction(newBuffer)) return { kind: "continue", buffer: newBuffer };

  // 従来互換: `;` で終端するまでは複数行入力として蓄積
  if (!t.endsWith(";")) return { kind: "continue", buffer: newBuffer };

  const parsed = tryParseStatements(newBuffer);
  if (parsed.kind === "ok") {
    if (parsed.count === 0) return { kind: "ignore" }; // `;` のみ
    // 完結入力に CREATE/DROP TEMP TABLE を含む場合もバッチ構築モード
    //（コメント付き貼り付けや SELECT 開始のバッチへの対策）
    if (parsed.hasTempTable) return { kind: "continue", buffer: newBuffer };
    return parsed.count === 1
      ? { kind: "execute-single", sql: newBuffer }
      : { kind: "execute-batch", sql: newBuffer };
  }
  if (parsed.continuable) return { kind: "continue", buffer: newBuffer };
  return { kind: "error", message: parsed.message };
}

/** `:run` の判定。エラー時はバッファを破棄せず呼び出し側で保持する（:edit / :clear で修正可能） */
export function decideRun(
  buffer: string
): { kind: "execute-batch"; sql: string } | { kind: "error"; message: string } {
  if (buffer.trim().length === 0) {
    return { kind: "error", message: "ArgumentError: input buffer is empty (nothing to :run)" };
  }
  const parsed = tryParseStatements(buffer);
  if (parsed.kind === "fail") return { kind: "error", message: parsed.message };
  return { kind: "execute-batch", sql: buffer };
}

/** 先頭の空白・コメントを除いた先頭が CREATE TEMP TABLE か（入力途中でも判定可能） */
export function isBatchConstruction(buffer: string): boolean {
  return /^create\s+temp\s+table\b/i.test(stripLeadingCommentsAndWs(buffer));
}

function stripLeadingCommentsAndWs(sql: string): string {
  let s = sql;
  while (true) {
    const before = s;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^--[^\n]*(\n|$)/, "");
    s = s.replace(/^\/\*[\s\S]*?\*\//, "");
    if (s === before) return s;
  }
}

type ParseAttempt =
  | { kind: "ok"; count: number; hasTempTable: boolean }
  | { kind: "fail"; continuable: boolean; message: string };

/** 判定用パースの前処理: `APP100@profile` 構文はレキサが読めないため正規化する。
 *  （プロファイル名は形だけの判定なので何でもよい。実行に渡す SQL は生のまま） */
function toParseInput(sql: string): string {
  try {
    return normalizeSqlAppProfiles(sql, "console").normalizedSql;
  } catch {
    return sql; // 正規化エラーはパース側のエラーとしてそのまま表面化させる
  }
}

function tryParseStatements(sql: string): ParseAttempt {
  try {
    const stmts = new Parser(new Lexer(toParseInput(sql)).tokenize()).parseStatements();
    return {
      kind: "ok",
      count: stmts.length,
      hasTempTable: stmts.some(
        (s) => s.type === "CREATE_TEMP_TABLE" || s.type === "DROP_TEMP_TABLE"
      ),
    };
  } catch (e) {
    if (e instanceof LexError) {
      return { kind: "fail", continuable: e.unterminated, message: e.message };
    }
    if (e instanceof ParseError) {
      return { kind: "fail", continuable: e.token.kind === TokenKind.EOF, message: e.message };
    }
    throw e;
  }
}
