import { Lexer, LexError } from "../lexer";
import { TokenKind } from "../tokens";

// ヘルパー: トークン種別の配列だけ返す
function kinds(sql: string): TokenKind[] {
  return new Lexer(sql).tokenize().map((t) => t.kind);
}
// ヘルパー: (kind, value) ペアを返す
function tokens(sql: string) {
  return new Lexer(sql).tokenize().map((t) => ({ k: t.kind, v: t.value }));
}

// ----------------------------------------------------------------
// キーワード・識別子
// ----------------------------------------------------------------

test("ASCII キーワードは大文字小文字を区別しない", () => {
  expect(kinds("select FROM Where")).toEqual([
    TokenKind.SELECT,
    TokenKind.FROM,
    TokenKind.WHERE,
    TokenKind.EOF,
  ]);
});

test("日本語識別子をそのまま読める", () => {
  const toks = tokens("SELECT 担当者, 金額 FROM APP100");
  expect(toks).toEqual([
    { k: TokenKind.SELECT,  v: "SELECT" },
    { k: TokenKind.IDENT,   v: "担当者" },
    { k: TokenKind.COMMA,   v: "," },
    { k: TokenKind.IDENT,   v: "金額" },
    { k: TokenKind.FROM,    v: "FROM" },
    { k: TokenKind.IDENT,   v: "APP100" },
    { k: TokenKind.EOF,     v: "" },
  ]);
});

test("バッククォート識別子", () => {
  const toks = tokens("SELECT `担当者 名前`");
  expect(toks[1]).toEqual({ k: TokenKind.BIDENT, v: "担当者 名前" });
});

// ----------------------------------------------------------------
// リテラル
// ----------------------------------------------------------------

test("文字列リテラル（シングルクォート）", () => {
  const toks = tokens("'完了'");
  expect(toks[0]).toEqual({ k: TokenKind.STRING, v: "完了" });
});

test("文字列内の '' エスケープ", () => {
  const toks = tokens("'it''s'");
  expect(toks[0]).toEqual({ k: TokenKind.STRING, v: "it's" });
});

test("整数リテラル", () => {
  const toks = tokens("42");
  expect(toks[0]).toEqual({ k: TokenKind.NUMBER, v: "42" });
});

test("小数リテラル", () => {
  const toks = tokens("3.14");
  expect(toks[0]).toEqual({ k: TokenKind.NUMBER, v: "3.14" });
});

// ----------------------------------------------------------------
// 演算子
// ----------------------------------------------------------------

test("2文字演算子", () => {
  expect(kinds("!= <> >= <=")).toEqual([
    TokenKind.NEQ,
    TokenKind.LT_GT,
    TokenKind.GTE,
    TokenKind.LTE,
    TokenKind.EOF,
  ]);
});

test("1文字演算子", () => {
  expect(kinds("= > < * ( ) , .")).toEqual([
    TokenKind.EQ,
    TokenKind.GT,
    TokenKind.LT,
    TokenKind.STAR,
    TokenKind.LPAREN,
    TokenKind.RPAREN,
    TokenKind.COMMA,
    TokenKind.DOT,
    TokenKind.EOF,
  ]);
});

// ----------------------------------------------------------------
// コメント
// ----------------------------------------------------------------

test("行コメント (--) をスキップ", () => {
  expect(kinds("SELECT -- コメント\nFROM")).toEqual([
    TokenKind.SELECT,
    TokenKind.FROM,
    TokenKind.EOF,
  ]);
});

test("ブロックコメント (/* */) をスキップ", () => {
  expect(kinds("SELECT /* コメント */ FROM")).toEqual([
    TokenKind.SELECT,
    TokenKind.FROM,
    TokenKind.EOF,
  ]);
});

// ----------------------------------------------------------------
// kintone 専用関数
// ----------------------------------------------------------------

test("kintone 専用関数キーワード", () => {
  expect(kinds("TODAY() NOW() LOGINUSER()")).toEqual([
    TokenKind.TODAY,   TokenKind.LPAREN, TokenKind.RPAREN,
    TokenKind.NOW,     TokenKind.LPAREN, TokenKind.RPAREN,
    TokenKind.LOGINUSER, TokenKind.LPAREN, TokenKind.RPAREN,
    TokenKind.EOF,
  ]);
});

// ----------------------------------------------------------------
// 複合ケース
// ----------------------------------------------------------------

test("SELECT 全体", () => {
  const sql =
    "SELECT 担当者, 金額 FROM APP100 WHERE ステータス = '完了' ORDER BY 金額 DESC LIMIT 10";
  expect(kinds(sql)).toEqual([
    TokenKind.SELECT,
    TokenKind.IDENT,   // 担当者
    TokenKind.COMMA,
    TokenKind.IDENT,   // 金額
    TokenKind.FROM,
    TokenKind.IDENT,   // APP100
    TokenKind.WHERE,
    TokenKind.IDENT,   // ステータス
    TokenKind.EQ,
    TokenKind.STRING,  // '完了'
    TokenKind.ORDER,
    TokenKind.BY,
    TokenKind.IDENT,   // 金額
    TokenKind.DESC,
    TokenKind.LIMIT,
    TokenKind.NUMBER,  // 10
    TokenKind.EOF,
  ]);
});

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

test("未閉じ文字列リテラルはエラー", () => {
  expect(() => new Lexer("'未閉じ").tokenize()).toThrow(LexError);
});

test("未閉じバッククォートはエラー", () => {
  expect(() => new Lexer("`未閉じ").tokenize()).toThrow(LexError);
});

test("未知の文字はエラー", () => {
  expect(() => new Lexer("@").tokenize()).toThrow(LexError);
});
