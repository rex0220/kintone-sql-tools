// ============================================================
// Lexer（字句解析器）
//
// 入力: SQL 文字列
// 出力: Token[]
//
// 識別子ルール（仕様書 §5）:
//   クォートなし → ASCII英数字・_・$・日本語 Unicode (U+3040-U+9FFF)
//   バッククォート → 任意の文字（スペース・括弧等を含む場合）
// ============================================================

import { Token, TokenKind, KEYWORDS } from "./tokens";

// ------------------------------------------------------------
// エラー
// ------------------------------------------------------------

export class LexError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
    public readonly input: string,
    /** 入力が途中で終わったことによるエラー（未終端の文字列・バッククォート・ブロックコメント）。
     *  pos は開始位置を指すため、「入力の続きがあれば解消し得るか」の判定にはこのフラグを使う */
    public readonly unterminated: boolean = false
  ) {
    const around = input.slice(Math.max(0, pos - 10), pos + 10);
    super(`${message}（位置 ${pos}、前後: 「${around}」）`);
    this.name = "LexError";
  }
}

// ------------------------------------------------------------
// Lexer クラス
// ------------------------------------------------------------

export class Lexer {
  private pos = 0;

  constructor(private readonly input: string) {}

  // ----------------------------------------------------------
  // 公開 API: 全トークンを返す
  // ----------------------------------------------------------

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (true) {
      const tok = this.nextToken();
      tokens.push(tok);
      if (tok.kind === TokenKind.EOF) break;
    }
    return tokens;
  }

  // ----------------------------------------------------------
  // 次のトークンを読み取る
  // ----------------------------------------------------------

  private nextToken(): Token {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.input.length) {
      return this.makeToken(TokenKind.EOF, "", this.pos);
    }

    const start = this.pos;
    const ch = this.input[this.pos];

    // 文字列リテラル: 'value'
    if (ch === "'") return this.readString(start);

    // バッククォート識別子: `field name`
    if (ch === "`") return this.readBacktickIdent(start);

    // 数値
    if (isDigit(ch)) return this.readNumber(start);

    // 演算子・記号
    const opTok = this.tryReadOperator(start);
    if (opTok) return opTok;

    // 識別子 / キーワード（日本語含む）
    if (isIdentStart(ch)) return this.readIdentOrKeyword(start);

    // 一時テーブル識別子: #temp（# は先頭のみ有効）
    if (ch === "#") return this.readHashIdent(start);

    throw new LexError(
      `予期しない文字 「${ch}」 です`,
      this.pos,
      this.input
    );
  }

  // ----------------------------------------------------------
  // 文字列リテラル: 'value'
  // シングルクォート内の '' はエスケープとして扱う
  // ----------------------------------------------------------

  private readString(start: number): Token {
    this.pos++; // 開き '
    let value = "";
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === "'") {
        this.pos++;
        // '' → ' (エスケープ)
        if (this.pos < this.input.length && this.input[this.pos] === "'") {
          value += "'";
          this.pos++;
        } else {
          // 閉じクォート
          return this.makeToken(TokenKind.STRING, value, start);
        }
      } else {
        value += ch;
        this.pos++;
      }
    }
    throw new LexError("文字列リテラルが閉じられていません", start, this.input, true);
  }

  // ----------------------------------------------------------
  // バッククォート識別子: `field name`
  // ----------------------------------------------------------

  private readBacktickIdent(start: number): Token {
    this.pos++; // 開き `
    let value = "";
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === "`") {
        this.pos++;
        return this.makeToken(TokenKind.BIDENT, value, start);
      }
      value += ch;
      this.pos++;
    }
    throw new LexError(
      "バッククォート識別子が閉じられていません",
      start,
      this.input,
      true
    );
  }

  // ----------------------------------------------------------
  // 数値: 整数 or 小数（123 / 3.14）
  // ----------------------------------------------------------

  private readNumber(start: number): Token {
    while (this.pos < this.input.length && isDigit(this.input[this.pos])) {
      this.pos++;
    }
    // 小数点
    if (
      this.pos < this.input.length &&
      this.input[this.pos] === "." &&
      this.pos + 1 < this.input.length &&
      isDigit(this.input[this.pos + 1])
    ) {
      this.pos++; // .
      while (this.pos < this.input.length && isDigit(this.input[this.pos])) {
        this.pos++;
      }
    }
    return this.makeToken(
      TokenKind.NUMBER,
      this.input.slice(start, this.pos),
      start
    );
  }

  // ----------------------------------------------------------
  // 演算子・記号
  // ----------------------------------------------------------

  private tryReadOperator(start: number): Token | null {
    const ch = this.input[this.pos];
    const ch2 = this.input[this.pos + 1] ?? "";

    // 2文字演算子を先にチェック
    if (ch === "!" && ch2 === "=") { this.pos += 2; return this.makeToken(TokenKind.NEQ,   "!=", start); }
    if (ch === "<" && ch2 === ">") { this.pos += 2; return this.makeToken(TokenKind.LT_GT, "<>", start); }
    if (ch === ">" && ch2 === "=") { this.pos += 2; return this.makeToken(TokenKind.GTE,   ">=", start); }
    if (ch === "<" && ch2 === "=") { this.pos += 2; return this.makeToken(TokenKind.LTE,   "<=", start); }

    // 1文字
    switch (ch) {
      case "=": this.pos++; return this.makeToken(TokenKind.EQ,        "=",  start);
      case ">": this.pos++; return this.makeToken(TokenKind.GT,        ">",  start);
      case "<": this.pos++; return this.makeToken(TokenKind.LT,        "<",  start);
      case "*": this.pos++; return this.makeToken(TokenKind.STAR,      "*",  start);
      case "+": this.pos++; return this.makeToken(TokenKind.PLUS,      "+",  start);
      case "-": this.pos++; return this.makeToken(TokenKind.MINUS,     "-",  start);
      case "/": this.pos++; return this.makeToken(TokenKind.SLASH,     "/",  start);
      case "%": this.pos++; return this.makeToken(TokenKind.PERCENT,   "%",  start);
      case "(": this.pos++; return this.makeToken(TokenKind.LPAREN,    "(",  start);
      case ")": this.pos++; return this.makeToken(TokenKind.RPAREN,    ")",  start);
      case "[": this.pos++; return this.makeToken(TokenKind.LBRACKET,  "[",  start);
      case "]": this.pos++; return this.makeToken(TokenKind.RBRACKET,  "]",  start);
      case ",": this.pos++; return this.makeToken(TokenKind.COMMA,     ",",  start);
      case ".": this.pos++; return this.makeToken(TokenKind.DOT,       ".",  start);
      case ";": this.pos++; return this.makeToken(TokenKind.SEMICOLON, ";",  start);
    }

    return null;
  }

  // ----------------------------------------------------------
  // 識別子 / キーワード
  // ----------------------------------------------------------

  private readIdentOrKeyword(start: number): Token {
    while (
      this.pos < this.input.length &&
      isIdentContinue(this.input[this.pos])
    ) {
      this.pos++;
    }
    const raw = this.input.slice(start, this.pos);
    const upper = raw.toUpperCase();
    const kind = KEYWORDS.get(upper) ?? TokenKind.IDENT;
    // キーワードは正規化（大文字）、識別子は元のテキストをそのまま保持
    const value = kind === TokenKind.IDENT ? raw : upper;
    return this.makeToken(kind, value, start);
  }

  // ----------------------------------------------------------
  // 一時テーブル識別子: #temp
  // # は先頭のみ有効。isIdentStart に # を加えると isIdentContinue 経由で
  // 識別子の途中（APP#x 等）にも許容されてしまうため、専用分岐で読む。
  // ----------------------------------------------------------

  private readHashIdent(start: number): Token {
    this.pos++; // #
    const next = this.input[this.pos] ?? "";
    if (!isIdentStart(next)) {
      throw new LexError("「#」 の直後には識別子が必要です", start, this.input);
    }
    while (
      this.pos < this.input.length &&
      isIdentContinue(this.input[this.pos])
    ) {
      this.pos++;
    }
    const value = this.input.slice(start, this.pos);
    // 一時テーブル名に @profile は付与できない（APP@profile の正規化は
    // APP<数字> のみが対象で、#t@dev はここまで素通しされる）
    if (this.input[this.pos] === "@") {
      throw new LexError(
        `@profile is not allowed on temp table ${value}.`,
        this.pos,
        this.input
      );
    }
    return this.makeToken(TokenKind.IDENT, value, start);
  }

  // ----------------------------------------------------------
  // 空白・コメントをスキップ
  // ----------------------------------------------------------

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];

      // 空白
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.pos++;
        continue;
      }

      // 行コメント: --
      if (ch === "-" && this.input[this.pos + 1] === "-") {
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
          this.pos++;
        }
        continue;
      }

      // ブロックコメント: /* ... */
      if (ch === "/" && this.input[this.pos + 1] === "*") {
        const commentStart = this.pos;
        this.pos += 2;
        let closed = false;
        while (this.pos < this.input.length) {
          if (
            this.input[this.pos] === "*" &&
            this.input[this.pos + 1] === "/"
          ) {
            this.pos += 2;
            closed = true;
            break;
          }
          this.pos++;
        }
        if (!closed) {
          throw new LexError(
            "ブロックコメントが閉じられていません",
            commentStart,
            this.input,
            true
          );
        }
        continue;
      }

      break;
    }
  }

  // ----------------------------------------------------------
  // ヘルパー
  // ----------------------------------------------------------

  private makeToken(kind: TokenKind, value: string, pos: number): Token {
    return { kind, value, pos };
  }
}

// ------------------------------------------------------------
// 文字分類
// ------------------------------------------------------------

/** 識別子の先頭文字: ASCII英字・_・$・日本語 Unicode */
function isIdentStart(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x41 && cp <= 0x5a) ||  // A-Z
    (cp >= 0x61 && cp <= 0x7a) ||  // a-z
    cp === 0x5f ||                  // _
    cp === 0x24 ||                  // $
    isJapanese(cp)
  );
}

/** 識別子の継続文字: 先頭文字 + 数字 */
function isIdentContinue(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return isIdentStart(ch) || (cp >= 0x30 && cp <= 0x39); // 0-9
}

function isDigit(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x30 && cp <= 0x39;
}

/**
 * 日本語 Unicode 範囲
 *   U+3040-U+30FF  ひらがな・カタカナ
 *   U+3400-U+9FFF  CJK 統合漢字（拡張含む）
 *   U+F900-U+FAFF  CJK 互換漢字
 *   U+FF01-U+FF60  全角英数字・記号
 */
function isJapanese(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff01 && cp <= 0xff60)
  );
}
