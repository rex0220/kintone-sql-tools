"use strict";
(() => {
  // src/lexer/tokens.ts
  var KEYWORDS = /* @__PURE__ */ new Map([
    ["SELECT", "SELECT" /* SELECT */],
    ["DISTINCT", "DISTINCT" /* DISTINCT */],
    ["FROM", "FROM" /* FROM */],
    ["AS", "AS" /* AS */],
    ["WHERE", "WHERE" /* WHERE */],
    ["INSERT", "INSERT" /* INSERT */],
    ["INTO", "INTO" /* INTO */],
    ["VALUES", "VALUES" /* VALUES */],
    ["UPDATE", "UPDATE" /* UPDATE */],
    ["SET", "SET" /* SET */],
    ["DELETE", "DELETE" /* DELETE */],
    ["INNER", "INNER" /* INNER */],
    ["LEFT", "LEFT" /* LEFT */],
    ["JOIN", "JOIN" /* JOIN */],
    ["ON", "ON" /* ON */],
    ["GROUP", "GROUP" /* GROUP */],
    ["BY", "BY" /* BY */],
    ["HAVING", "HAVING" /* HAVING */],
    ["ORDER", "ORDER" /* ORDER */],
    ["ASC", "ASC" /* ASC */],
    ["DESC", "DESC" /* DESC */],
    ["LIMIT", "LIMIT" /* LIMIT */],
    ["OFFSET", "OFFSET" /* OFFSET */],
    ["COUNT", "COUNT" /* COUNT */],
    ["SUM", "SUM" /* SUM */],
    ["AVG", "AVG" /* AVG */],
    ["MAX", "MAX" /* MAX */],
    ["MIN", "MIN" /* MIN */],
    ["AND", "AND" /* AND */],
    ["OR", "OR" /* OR */],
    ["NOT", "NOT" /* NOT */],
    ["IS", "IS" /* IS */],
    ["NULL", "NULL" /* NULL */],
    ["LIKE", "LIKE" /* LIKE */],
    ["IN", "IN" /* IN */],
    ["BETWEEN", "BETWEEN" /* BETWEEN */],
    ["TODAY", "TODAY" /* TODAY */],
    ["NOW", "NOW" /* NOW */],
    ["LOGINUSER", "LOGINUSER" /* LOGINUSER */]
  ]);

  // src/lexer/lexer.ts
  var LexError = class extends Error {
    constructor(message, pos, input) {
      const around = input.slice(Math.max(0, pos - 10), pos + 10);
      super(`${message}\uFF08\u4F4D\u7F6E ${pos}\u3001\u524D\u5F8C: \u300C${around}\u300D\uFF09`);
      this.pos = pos;
      this.input = input;
      this.name = "LexError";
    }
  };
  var Lexer = class {
    constructor(input) {
      this.input = input;
      this.pos = 0;
    }
    // ----------------------------------------------------------
    // 公開 API: 全トークンを返す
    // ----------------------------------------------------------
    tokenize() {
      const tokens = [];
      while (true) {
        const tok = this.nextToken();
        tokens.push(tok);
        if (tok.kind === "EOF" /* EOF */) break;
      }
      return tokens;
    }
    // ----------------------------------------------------------
    // 次のトークンを読み取る
    // ----------------------------------------------------------
    nextToken() {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.input.length) {
        return this.makeToken("EOF" /* EOF */, "", this.pos);
      }
      const start = this.pos;
      const ch = this.input[this.pos];
      if (ch === "'") return this.readString(start);
      if (ch === "`") return this.readBacktickIdent(start);
      if (isDigit(ch)) return this.readNumber(start);
      const opTok = this.tryReadOperator(start);
      if (opTok) return opTok;
      if (isIdentStart(ch)) return this.readIdentOrKeyword(start);
      throw new LexError(
        `\u4E88\u671F\u3057\u306A\u3044\u6587\u5B57 \u300C${ch}\u300D \u3067\u3059`,
        this.pos,
        this.input
      );
    }
    // ----------------------------------------------------------
    // 文字列リテラル: 'value'
    // シングルクォート内の '' はエスケープとして扱う
    // ----------------------------------------------------------
    readString(start) {
      this.pos++;
      let value = "";
      while (this.pos < this.input.length) {
        const ch = this.input[this.pos];
        if (ch === "'") {
          this.pos++;
          if (this.pos < this.input.length && this.input[this.pos] === "'") {
            value += "'";
            this.pos++;
          } else {
            return this.makeToken("STRING" /* STRING */, value, start);
          }
        } else {
          value += ch;
          this.pos++;
        }
      }
      throw new LexError("\u6587\u5B57\u5217\u30EA\u30C6\u30E9\u30EB\u304C\u9589\u3058\u3089\u308C\u3066\u3044\u307E\u305B\u3093", start, this.input);
    }
    // ----------------------------------------------------------
    // バッククォート識別子: `field name`
    // ----------------------------------------------------------
    readBacktickIdent(start) {
      this.pos++;
      let value = "";
      while (this.pos < this.input.length) {
        const ch = this.input[this.pos];
        if (ch === "`") {
          this.pos++;
          return this.makeToken("BIDENT" /* BIDENT */, value, start);
        }
        value += ch;
        this.pos++;
      }
      throw new LexError(
        "\u30D0\u30C3\u30AF\u30AF\u30A9\u30FC\u30C8\u8B58\u5225\u5B50\u304C\u9589\u3058\u3089\u308C\u3066\u3044\u307E\u305B\u3093",
        start,
        this.input
      );
    }
    // ----------------------------------------------------------
    // 数値: 整数 or 小数（123 / 3.14）
    // ----------------------------------------------------------
    readNumber(start) {
      while (this.pos < this.input.length && isDigit(this.input[this.pos])) {
        this.pos++;
      }
      if (this.pos < this.input.length && this.input[this.pos] === "." && this.pos + 1 < this.input.length && isDigit(this.input[this.pos + 1])) {
        this.pos++;
        while (this.pos < this.input.length && isDigit(this.input[this.pos])) {
          this.pos++;
        }
      }
      return this.makeToken(
        "NUMBER" /* NUMBER */,
        this.input.slice(start, this.pos),
        start
      );
    }
    // ----------------------------------------------------------
    // 演算子・記号
    // ----------------------------------------------------------
    tryReadOperator(start) {
      const ch = this.input[this.pos];
      const ch2 = this.input[this.pos + 1] ?? "";
      if (ch === "!" && ch2 === "=") {
        this.pos += 2;
        return this.makeToken("!=" /* NEQ */, "!=", start);
      }
      if (ch === "<" && ch2 === ">") {
        this.pos += 2;
        return this.makeToken("<>" /* LT_GT */, "<>", start);
      }
      if (ch === ">" && ch2 === "=") {
        this.pos += 2;
        return this.makeToken(">=" /* GTE */, ">=", start);
      }
      if (ch === "<" && ch2 === "=") {
        this.pos += 2;
        return this.makeToken("<=" /* LTE */, "<=", start);
      }
      switch (ch) {
        case "=":
          this.pos++;
          return this.makeToken("=" /* EQ */, "=", start);
        case ">":
          this.pos++;
          return this.makeToken(">" /* GT */, ">", start);
        case "<":
          this.pos++;
          return this.makeToken("<" /* LT */, "<", start);
        case "*":
          this.pos++;
          return this.makeToken("*" /* STAR */, "*", start);
        case "+":
          this.pos++;
          return this.makeToken("+" /* PLUS */, "+", start);
        case "-":
          this.pos++;
          return this.makeToken("-" /* MINUS */, "-", start);
        case "/":
          this.pos++;
          return this.makeToken("/" /* SLASH */, "/", start);
        case "(":
          this.pos++;
          return this.makeToken("(" /* LPAREN */, "(", start);
        case ")":
          this.pos++;
          return this.makeToken(")" /* RPAREN */, ")", start);
        case ",":
          this.pos++;
          return this.makeToken("," /* COMMA */, ",", start);
        case ".":
          this.pos++;
          return this.makeToken("." /* DOT */, ".", start);
        case ";":
          this.pos++;
          return this.makeToken(";" /* SEMICOLON */, ";", start);
      }
      return null;
    }
    // ----------------------------------------------------------
    // 識別子 / キーワード
    // ----------------------------------------------------------
    readIdentOrKeyword(start) {
      while (this.pos < this.input.length && isIdentContinue(this.input[this.pos])) {
        this.pos++;
      }
      const raw = this.input.slice(start, this.pos);
      const upper = raw.toUpperCase();
      const kind = KEYWORDS.get(upper) ?? "IDENT" /* IDENT */;
      const value = kind === "IDENT" /* IDENT */ ? raw : upper;
      return this.makeToken(kind, value, start);
    }
    // ----------------------------------------------------------
    // 空白・コメントをスキップ
    // ----------------------------------------------------------
    skipWhitespaceAndComments() {
      while (this.pos < this.input.length) {
        const ch = this.input[this.pos];
        if (ch === " " || ch === "	" || ch === "\r" || ch === "\n") {
          this.pos++;
          continue;
        }
        if (ch === "-" && this.input[this.pos + 1] === "-") {
          while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
            this.pos++;
          }
          continue;
        }
        if (ch === "/" && this.input[this.pos + 1] === "*") {
          this.pos += 2;
          while (this.pos < this.input.length) {
            if (this.input[this.pos] === "*" && this.input[this.pos + 1] === "/") {
              this.pos += 2;
              break;
            }
            this.pos++;
          }
          continue;
        }
        break;
      }
    }
    // ----------------------------------------------------------
    // ヘルパー
    // ----------------------------------------------------------
    makeToken(kind, value, pos) {
      return { kind, value, pos };
    }
  };
  function isIdentStart(ch) {
    const cp = ch.codePointAt(0);
    return cp >= 65 && cp <= 90 || // A-Z
    cp >= 97 && cp <= 122 || // a-z
    cp === 95 || // _
    cp === 36 || // $
    isJapanese(cp);
  }
  function isIdentContinue(ch) {
    const cp = ch.codePointAt(0);
    return isIdentStart(ch) || cp >= 48 && cp <= 57;
  }
  function isDigit(ch) {
    const cp = ch.codePointAt(0);
    return cp >= 48 && cp <= 57;
  }
  function isJapanese(cp) {
    return cp >= 12352 && cp <= 12543 || cp >= 13312 && cp <= 40959 || cp >= 63744 && cp <= 64255 || cp >= 65281 && cp <= 65376;
  }

  // src/parser/parser.ts
  var ParseError = class extends Error {
    constructor(message, token) {
      super(`${message}\uFF08\u4F4D\u7F6E ${token.pos}\u3001\u30C8\u30FC\u30AF\u30F3: \u300C${token.value}\u300D\uFF09`);
      this.token = token;
      this.name = "ParseError";
    }
  };
  var Parser = class {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
    }
    // ----------------------------------------------------------
    // 公開 API
    // ----------------------------------------------------------
    parse() {
      const stmt = this.parseStatement();
      if (this.peek().kind === ";" /* SEMICOLON */) this.advance();
      this.expect("EOF" /* EOF */);
      return stmt;
    }
    // ----------------------------------------------------------
    // Statement ディスパッチ
    // ----------------------------------------------------------
    parseStatement() {
      const tok = this.peek();
      switch (tok.kind) {
        case "SELECT" /* SELECT */:
          return this.parseSelect();
        case "INSERT" /* INSERT */:
          return this.parseInsert();
        case "UPDATE" /* UPDATE */:
          return this.parseUpdate();
        case "DELETE" /* DELETE */:
          return this.parseDelete();
        default:
          throw new ParseError(
            "SELECT / INSERT / UPDATE / DELETE \u306E\u3044\u305A\u308C\u304B\u3067\u59CB\u307E\u308B SQL \u6587\u304C\u5FC5\u8981\u3067\u3059",
            tok
          );
      }
    }
    // ----------------------------------------------------------
    // SELECT
    // ----------------------------------------------------------
    parseSelect() {
      this.expect("SELECT" /* SELECT */);
      const distinct = this.consume("DISTINCT" /* DISTINCT */);
      const columns = this.parseSelectColumns();
      this.expectKeyword("FROM" /* FROM */, "\u300CFROM\u300D\u306E\u5F8C\u306B\u30C6\u30FC\u30D6\u30EB\u540D\u304C\u5FC5\u8981\u3067\u3059\uFF08\u4F8B: FROM APP100\uFF09");
      const from = this.parseTableRef();
      const joins = this.parseJoins();
      const where = this.consume("WHERE" /* WHERE */) ? this.parseWhereExpr() : null;
      let groupBy = [];
      let having = null;
      if (this.consume("GROUP" /* GROUP */)) {
        this.expect("BY" /* BY */);
        groupBy = this.parseIdentList();
        if (this.consume("HAVING" /* HAVING */)) {
          having = this.parseWhereExpr();
        }
      }
      const orderBy = this.consume("ORDER" /* ORDER */) ? (this.expect("BY" /* BY */), this.parseOrderBy()) : [];
      const limit = this.consume("LIMIT" /* LIMIT */) ? this.parseUnsignedInt() : null;
      const offset = this.consume("OFFSET" /* OFFSET */) ? this.parseUnsignedInt() : null;
      return {
        type: "SELECT",
        distinct,
        columns,
        from,
        joins,
        where,
        groupBy,
        having,
        orderBy,
        limit,
        offset
      };
    }
    // SELECT 句のカラムリスト
    parseSelectColumns() {
      const cols = [];
      do {
        cols.push(this.parseSelectColumn());
      } while (this.consume("," /* COMMA */));
      return cols;
    }
    parseSelectColumn() {
      if (this.consume("*" /* STAR */)) {
        return { type: "WILDCARD" };
      }
      const aggFunc = this.tryAggregateFunc();
      if (aggFunc !== null) {
        return this.parseAggregateColumn(aggFunc);
      }
      const first = this.parseIdentifier();
      let field;
      if (this.peek().kind === "." /* DOT */) {
        this.advance();
        const fieldName = this.parseIdentifier();
        field = `${first}.${fieldName}`;
      } else {
        field = first;
      }
      const alias = this.consume("AS" /* AS */) ? this.parseAliasName() : null;
      return { type: "FIELD", field, alias };
    }
    tryAggregateFunc() {
      const map = {
        ["COUNT" /* COUNT */]: "COUNT",
        ["SUM" /* SUM */]: "SUM",
        ["AVG" /* AVG */]: "AVG",
        ["MAX" /* MAX */]: "MAX",
        ["MIN" /* MIN */]: "MIN"
      };
      const kind = this.peek().kind;
      return map[kind] ?? null;
    }
    parseAggregateColumn(func) {
      this.advance();
      this.expect("(" /* LPAREN */);
      const distinct = this.consume("DISTINCT" /* DISTINCT */);
      let arg;
      if (this.consume("*" /* STAR */)) {
        arg = { type: "WILDCARD" };
      } else {
        arg = this.parseIdentifier();
      }
      this.expect(")" /* RPAREN */);
      const alias = this.consume("AS" /* AS */) ? this.parseAliasName() : null;
      return { type: "AGGREGATE", func, distinct, arg, alias };
    }
    // ----------------------------------------------------------
    // FROM / JOIN
    // ----------------------------------------------------------
    parseTableRef() {
      const name = this.parseIdentifier();
      const appId = extractAppId(name, this.prev());
      const alias = this.consume("AS" /* AS */) ? this.parseIdentifier() : null;
      return { appId, alias };
    }
    parseJoins() {
      const joins = [];
      while (true) {
        const joinType = this.tryJoinType();
        if (joinType === null) break;
        const table = this.parseTableRef();
        this.expect("ON" /* ON */);
        const on = this.parseJoinCondition();
        joins.push({ type: joinType, table, on });
      }
      return joins;
    }
    tryJoinType() {
      if (this.consume("INNER" /* INNER */)) {
        this.expect("JOIN" /* JOIN */);
        return "INNER";
      }
      if (this.consume("LEFT" /* LEFT */)) {
        this.expect("JOIN" /* JOIN */);
        return "LEFT";
      }
      if (this.consume("JOIN" /* JOIN */)) {
        return "INNER";
      }
      return null;
    }
    // ON a.field = b.field
    parseJoinCondition() {
      const left = this.parseQualifiedIdent();
      this.expect("=" /* EQ */);
      const right = this.parseQualifiedIdent();
      return { left, right };
    }
    // alias.field または field
    parseQualifiedIdent() {
      const first = this.parseIdentifier();
      if (this.consume("." /* DOT */)) {
        const field = this.parseIdentifier();
        return { tableAlias: first, field };
      }
      return { tableAlias: null, field: first };
    }
    // ----------------------------------------------------------
    // WHERE 式（再帰下降・優先順位付き）
    // ----------------------------------------------------------
    parseWhereExpr() {
      return this.parseOrExpr();
    }
    // OR（最低優先度）
    parseOrExpr() {
      let left = this.parseAndExpr();
      while (this.consume("OR" /* OR */)) {
        const right = this.parseAndExpr();
        left = { type: "LOGICAL", op: "OR", left, right };
      }
      return left;
    }
    // AND
    parseAndExpr() {
      let left = this.parseNotExpr();
      while (this.consume("AND" /* AND */)) {
        const right = this.parseNotExpr();
        left = { type: "LOGICAL", op: "AND", left, right };
      }
      return left;
    }
    // NOT
    parseNotExpr() {
      if (this.consume("NOT" /* NOT */)) {
        const expr = this.parseNotExpr();
        return { type: "NOT", expr };
      }
      return this.parseCompareExpr();
    }
    // 比較演算子: =, !=, <>, >, <, >=, <=, LIKE, IN, IS NULL
    parseCompareExpr() {
      if (this.peek().kind === "(" /* LPAREN */) {
        this.advance();
        const expr = this.parseWhereExpr();
        this.expect(")" /* RPAREN */);
        return { type: "GROUP", expr };
      }
      const field = this.parseFieldValue();
      if (this.consume("IS" /* IS */)) {
        const not = this.consume("NOT" /* NOT */);
        this.expect("NULL" /* NULL */);
        return { type: "NULL_CHECK", field, not };
      }
      if (this.consume("BETWEEN" /* BETWEEN */)) {
        const low = this.parseSqlValue();
        this.expect("AND" /* AND */);
        const high = this.parseSqlValue();
        return {
          type: "LOGICAL",
          op: "AND",
          left: { type: "BINARY", op: ">=", left: field, right: low },
          right: { type: "BINARY", op: "<=", left: field, right: high }
        };
      }
      if (this.consume("NOT" /* NOT */)) {
        if (this.consume("IN" /* IN */)) {
          this.expect("(" /* LPAREN */);
          const values = this.parseInValues();
          this.expect(")" /* RPAREN */);
          return { type: "BINARY", op: "NOT_IN", left: field, right: { type: "IN_LIST", values } };
        }
        if (this.consume("LIKE" /* LIKE */)) {
          const pattern = this.parseSqlValue();
          return { type: "BINARY", op: "NOT_LIKE", left: field, right: pattern };
        }
        throw new ParseError(
          "NOT \u306E\u5F8C\u306B\u306F IN \u307E\u305F\u306F LIKE \u304C\u5FC5\u8981\u3067\u3059",
          this.peek()
        );
      }
      if (this.consume("IN" /* IN */)) {
        this.expect("(" /* LPAREN */);
        const values = this.parseInValues();
        this.expect(")" /* RPAREN */);
        const right2 = { type: "IN_LIST", values };
        return { type: "BINARY", op: "IN", left: field, right: right2 };
      }
      const op = this.parseCompareOp();
      const right = this.parseSqlValue();
      return { type: "BINARY", op, left: field, right };
    }
    parseCompareOp() {
      const tok = this.advance();
      switch (tok.kind) {
        case "=" /* EQ */:
          return "=";
        case "!=" /* NEQ */:
          return "!=";
        case "<>" /* LT_GT */:
          return "<>";
        case ">" /* GT */:
          return ">";
        case "<" /* LT */:
          return "<";
        case ">=" /* GTE */:
          return ">=";
        case "<=" /* LTE */:
          return "<=";
        case "LIKE" /* LIKE */:
          return "LIKE";
        default:
          throw new ParseError(
            "\u6BD4\u8F03\u6F14\u7B97\u5B50\uFF08=, !=, >, <, >=, <=, LIKE, IN, IS\uFF09\u304C\u5FC5\u8981\u3067\u3059",
            tok
          );
      }
    }
    // フィールド参照: [alias.]field
    // HAVING 句では COUNT(*) / SUM(f) 等の集計関数も左辺に使える。
    // 集計関数は "COUNT(*)" のような合成名として FieldValue に格納する（JS 側で評価）。
    parseFieldValue() {
      const aggFunc = this.tryAggregateFunc();
      if (aggFunc !== null) {
        this.advance();
        this.expect("(" /* LPAREN */);
        const distinct = this.consume("DISTINCT" /* DISTINCT */);
        let argStr;
        if (this.consume("*" /* STAR */)) {
          argStr = "*";
        } else {
          argStr = this.parseIdentifier();
        }
        this.expect(")" /* RPAREN */);
        const syntheticName = distinct ? `${aggFunc}(DISTINCT ${argStr})` : `${aggFunc}(${argStr})`;
        return { type: "FIELD", tableAlias: null, field: syntheticName };
      }
      const qi = this.parseQualifiedIdent();
      return { type: "FIELD", tableAlias: qi.tableAlias, field: qi.field };
    }
    // 右辺の値
    parseSqlValue() {
      const tok = this.peek();
      switch (tok.kind) {
        case "STRING" /* STRING */: {
          this.advance();
          return { type: "STRING", value: tok.value };
        }
        case "NUMBER" /* NUMBER */: {
          this.advance();
          return { type: "NUMBER", value: Number(tok.value) };
        }
        case "TODAY" /* TODAY */:
        case "NOW" /* NOW */:
        case "LOGINUSER" /* LOGINUSER */: {
          this.advance();
          this.expect("(" /* LPAREN */);
          this.expect(")" /* RPAREN */);
          return {
            type: "KINTONE_FUNC",
            name: tok.value
          };
        }
        default:
          throw new ParseError(
            "\u5024\uFF08\u6587\u5B57\u5217\u30FB\u6570\u5024\u30FBTODAY()\u30FBNOW()\u30FBLOGINUSER()\uFF09\u304C\u5FC5\u8981\u3067\u3059",
            tok
          );
      }
    }
    // IN リストの値
    parseInValues() {
      const values = [];
      do {
        const tok = this.advance();
        if (tok.kind === "STRING" /* STRING */) {
          values.push({ type: "STRING", value: tok.value });
        } else if (tok.kind === "NUMBER" /* NUMBER */) {
          values.push({ type: "NUMBER", value: Number(tok.value) });
        } else {
          throw new ParseError("IN \u30EA\u30B9\u30C8\u306B\u306F\u6587\u5B57\u5217\u307E\u305F\u306F\u6570\u5024\u304C\u5FC5\u8981\u3067\u3059", tok);
        }
      } while (this.consume("," /* COMMA */));
      return values;
    }
    // ----------------------------------------------------------
    // GROUP BY / ORDER BY
    // ----------------------------------------------------------
    parseIdentList() {
      const idents = [];
      do {
        idents.push(this.parseIdentifier());
      } while (this.consume("," /* COMMA */));
      return idents;
    }
    parseOrderBy() {
      const items = [];
      do {
        const field = this.parseIdentifier();
        let direction = "ASC";
        if (this.consume("DESC" /* DESC */)) direction = "DESC";
        else this.consume("ASC" /* ASC */);
        items.push({ field, direction });
      } while (this.consume("," /* COMMA */));
      return items;
    }
    // ----------------------------------------------------------
    // INSERT
    // ----------------------------------------------------------
    parseInsert() {
      this.expect("INSERT" /* INSERT */);
      this.expect("INTO" /* INTO */);
      const name = this.parseIdentifier();
      const appId = extractAppId(name, this.prev());
      this.expect("(" /* LPAREN */);
      const fields = this.parseIdentList();
      this.expect(")" /* RPAREN */);
      this.expect("VALUES" /* VALUES */);
      const values = [];
      do {
        this.expect("(" /* LPAREN */);
        const row = this.parseInsertRow(fields.length);
        this.expect(")" /* RPAREN */);
        values.push(row);
      } while (this.consume("," /* COMMA */));
      return { type: "INSERT", appId, fields, values };
    }
    parseInsertRow(expectedLen) {
      const row = [];
      do {
        const tok = this.advance();
        if (tok.kind === "STRING" /* STRING */) {
          row.push({ type: "STRING", value: tok.value });
        } else if (tok.kind === "NUMBER" /* NUMBER */) {
          row.push({ type: "NUMBER", value: Number(tok.value) });
        } else {
          throw new ParseError("INSERT \u306E\u5024\u306B\u306F\u6587\u5B57\u5217\u307E\u305F\u306F\u6570\u5024\u304C\u5FC5\u8981\u3067\u3059", tok);
        }
      } while (this.consume("," /* COMMA */));
      if (row.length !== expectedLen) {
        throw new ParseError(
          `\u30AB\u30E9\u30E0\u6570\uFF08${expectedLen}\uFF09\u3068\u5024\u306E\u6570\uFF08${row.length}\uFF09\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093`,
          this.prev()
        );
      }
      return row;
    }
    // ----------------------------------------------------------
    // UPDATE
    // ----------------------------------------------------------
    parseUpdate() {
      this.expect("UPDATE" /* UPDATE */);
      const name = this.parseIdentifier();
      const appId = extractAppId(name, this.prev());
      this.expect("SET" /* SET */);
      const assignments = this.parseAssignments();
      const whereTok = this.peek();
      if (!this.consume("WHERE" /* WHERE */)) {
        throw new ParseError(
          "UPDATE \u6587\u306B\u306F WHERE \u53E5\u304C\u5FC5\u8981\u3067\u3059\uFF08\u5168\u4EF6\u66F4\u65B0\u3092\u9632\u3050\u305F\u3081\uFF09",
          whereTok
        );
      }
      const where = this.parseWhereExpr();
      return { type: "UPDATE", appId, assignments, where };
    }
    parseAssignments() {
      const assignments = [];
      do {
        const field = this.parseIdentifier();
        this.expect("=" /* EQ */);
        const value = this.parseAssignmentValue();
        assignments.push({ field, value });
      } while (this.consume("," /* COMMA */));
      return assignments;
    }
    /**
     * SET の右辺を解析する。
     * 算術式（field op num / num op field / field op field）を優先的に検出し、
     * それ以外は通常の SqlValue として解析する。
     *
     * 算術式のパターン（2トークン先読みで判定）:
     *   IDENT  arithOp NUMBER  → ArithExpr
     *   IDENT  arithOp IDENT   → ArithExpr
     *   NUMBER arithOp IDENT   → ArithExpr
     */
    parseAssignmentValue() {
      const tok0 = this.peek();
      const tok1 = this.peekAt(1);
      const tok2 = this.peekAt(2);
      const isArithOp = (k) => k === "+" /* PLUS */ || k === "-" /* MINUS */ || k === "*" /* STAR */ || k === "/" /* SLASH */;
      const isOperand = (k) => k === "IDENT" /* IDENT */ || k === "BIDENT" /* BIDENT */ || k === "NUMBER" /* NUMBER */;
      if (isOperand(tok0.kind) && isArithOp(tok1.kind) && isOperand(tok2.kind)) {
        const left = this.parseArithOperand();
        const op = this.parseArithOp();
        const right = this.parseArithOperand();
        return { type: "ARITH", left, op, right };
      }
      return this.parseSqlValue();
    }
    parseArithOperand() {
      const tok = this.peek();
      if (tok.kind === "NUMBER" /* NUMBER */) {
        this.advance();
        return { type: "NUMBER", value: Number(tok.value) };
      }
      if (tok.kind === "IDENT" /* IDENT */ || tok.kind === "BIDENT" /* BIDENT */) {
        this.advance();
        return { type: "FIELD_REF", field: tok.value };
      }
      throw new ParseError("\u7B97\u8853\u5F0F\u306E\u30AA\u30DA\u30E9\u30F3\u30C9\u306B\u306F\u8B58\u5225\u5B50\u307E\u305F\u306F\u6570\u5024\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044", tok);
    }
    parseArithOp() {
      const tok = this.advance();
      switch (tok.kind) {
        case "+" /* PLUS */:
          return "+";
        case "-" /* MINUS */:
          return "-";
        case "*" /* STAR */:
          return "*";
        case "/" /* SLASH */:
          return "/";
        default:
          throw new ParseError("\u7B97\u8853\u6F14\u7B97\u5B50\uFF08+ - * /\uFF09\u304C\u5FC5\u8981\u3067\u3059", tok);
      }
    }
    // ----------------------------------------------------------
    // DELETE
    // ----------------------------------------------------------
    parseDelete() {
      this.expect("DELETE" /* DELETE */);
      this.expect("FROM" /* FROM */);
      const name = this.parseIdentifier();
      const appId = extractAppId(name, this.prev());
      const whereTok = this.peek();
      if (!this.consume("WHERE" /* WHERE */)) {
        throw new ParseError(
          "DELETE \u6587\u306B\u306F WHERE \u53E5\u304C\u5FC5\u9808\u3067\u3059\uFF08\u5168\u4EF6\u524A\u9664\u3092\u9632\u3050\u305F\u3081\uFF09",
          whereTok
        );
      }
      const where = this.parseWhereExpr();
      return { type: "DELETE", appId, where };
    }
    // ----------------------------------------------------------
    // トークン操作ヘルパー
    // ----------------------------------------------------------
    peek() {
      return this.tokens[this.pos] ?? { kind: "EOF" /* EOF */, value: "", pos: -1 };
    }
    /** n 先のトークンを読み取る（消費しない） */
    peekAt(n) {
      return this.tokens[this.pos + n] ?? { kind: "EOF" /* EOF */, value: "", pos: -1 };
    }
    prev() {
      return this.tokens[this.pos - 1] ?? { kind: "EOF" /* EOF */, value: "", pos: -1 };
    }
    advance() {
      const tok = this.peek();
      if (tok.kind !== "EOF" /* EOF */) this.pos++;
      return tok;
    }
    /** 指定 kind なら消費して true を返す */
    consume(kind) {
      if (this.peek().kind === kind) {
        this.advance();
        return true;
      }
      return false;
    }
    /** 指定 kind でなければエラー */
    expect(kind, msg) {
      const tok = this.peek();
      if (tok.kind !== kind) {
        throw new ParseError(
          msg ?? `\u300C${kind}\u300D\u304C\u5FC5\u8981\u3067\u3059`,
          tok
        );
      }
      return this.advance();
    }
    /** FROM / GROUP BY など文脈付きエラーメッセージ */
    expectKeyword(kind, msg) {
      return this.expect(kind, msg);
    }
    /** 符号なし整数を読む */
    parseUnsignedInt() {
      const tok = this.expect("NUMBER" /* NUMBER */, "\u6574\u6570\u304C\u5FC5\u8981\u3067\u3059");
      const n = Number(tok.value);
      if (!Number.isInteger(n) || n < 0) {
        throw new ParseError("\u6B63\u306E\u6574\u6570\u304C\u5FC5\u8981\u3067\u3059", tok);
      }
      return n;
    }
    // 識別子（IDENT / BIDENT）を読む
    parseIdentifier() {
      const tok = this.peek();
      if (tok.kind === "IDENT" /* IDENT */ || tok.kind === "BIDENT" /* BIDENT */) {
        this.advance();
        return tok.value;
      }
      throw new ParseError(
        "\u30D5\u30A3\u30FC\u30EB\u30C9\u540D\u307E\u305F\u306F\u30C6\u30FC\u30D6\u30EB\u540D\u304C\u5FC5\u8981\u3067\u3059",
        tok
      );
    }
    // エイリアス名: IDENT / BIDENT に加え、キーワードも許容する
    // 例: SELECT SUM(金額) AS avg → "avg" は AVG キーワードだが alias として有効
    parseAliasName() {
      const tok = this.peek();
      if (tok.kind === "IDENT" /* IDENT */ || tok.kind === "BIDENT" /* BIDENT */ || KEYWORDS.has(tok.value.toUpperCase())) {
        this.advance();
        return tok.value.toLowerCase();
      }
      throw new ParseError("\u30A8\u30A4\u30EA\u30A2\u30B9\u540D\u304C\u5FC5\u8981\u3067\u3059", tok);
    }
  };
  function extractAppId(name, tok) {
    const m = name.match(/^[Aa][Pp][Pp](\d+)$/);
    if (!m) {
      throw new ParseError(
        `\u30C6\u30FC\u30D6\u30EB\u540D\u306F APP + \u6570\u5B57\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\uFF08\u4F8B: APP100\uFF09\u3002\u300C${name}\u300D\u306F\u7121\u52B9\u3067\u3059`,
        tok
      );
    }
    return Number(m[1]);
  }

  // src/engine/pushDownNot.ts
  function pushDownNot(expr) {
    switch (expr.type) {
      case "BINARY": {
        const negated = negateOp(expr.op);
        if (negated === null) {
          throw new KintoneQueryError(
            `NOT ${expr.op} \u306F\u30B5\u30DD\u30FC\u30C8\u5BFE\u8C61\u5916\u3067\u3059`
          );
        }
        return { ...expr, op: negated };
      }
      case "NULL_CHECK":
        return { ...expr, not: !expr.not };
      case "LOGICAL":
        return {
          type: "LOGICAL",
          op: expr.op === "AND" ? "OR" : "AND",
          left: pushDownNot(expr.left),
          right: pushDownNot(expr.right)
        };
      case "NOT":
        return expr.expr;
      // 二重否定
      case "GROUP":
        return { type: "GROUP", expr: pushDownNot(expr.expr) };
    }
  }
  function negateOp(op) {
    switch (op) {
      case "=":
        return "!=";
      case "!=":
      case "<>":
        return "=";
      case ">":
        return "<=";
      case "<":
        return ">=";
      case ">=":
        return "<";
      case "<=":
        return ">";
      case "LIKE":
        return "NOT_LIKE";
      case "NOT_LIKE":
        return "LIKE";
      case "IN":
        return "NOT_IN";
      case "NOT_IN":
        return "IN";
    }
  }

  // src/converter/whereToKintone.ts
  function whereToKintone(expr) {
    switch (expr.type) {
      case "BINARY":
        return convertBinary(expr);
      case "NULL_CHECK":
        return convertNullCheck(expr);
      case "LOGICAL":
        return convertLogical(expr);
      case "NOT":
        return convertNot(expr);
      case "GROUP":
        return convertGroup(expr);
    }
  }
  function convertBinary(expr) {
    const left = convertField(expr.left);
    const op = convertOp(expr.op);
    const right = convertValue(expr.right, expr.op);
    return `${left} ${op} ${right}`;
  }
  function convertOp(op) {
    switch (op) {
      case "=":
        return "=";
      case "!=":
      case "<>":
        return "!=";
      case ">":
        return ">";
      case "<":
        return "<";
      case ">=":
        return ">=";
      case "<=":
        return "<=";
      case "LIKE":
        return "like";
      case "NOT_LIKE":
        return "not like";
      case "IN":
        return "in";
      case "NOT_IN":
        return "not in";
    }
  }
  function convertNullCheck(expr) {
    const field = convertField(expr.field);
    return expr.not ? `${field} != ""` : `${field} = ""`;
  }
  function convertLogical(expr) {
    const left = whereToKintone(expr.left);
    const right = whereToKintone(expr.right);
    const op = expr.op === "AND" ? "and" : "or";
    const leftStr = needsParens(expr.left) ? `(${left})` : left;
    const rightStr = needsParens(expr.right) ? `(${right})` : right;
    return `${leftStr} ${op} ${rightStr}`;
  }
  function convertNot(expr) {
    return whereToKintone(pushDownNot(expr.expr));
  }
  function convertGroup(expr) {
    return `(${whereToKintone(expr.expr)})`;
  }
  function convertField(field) {
    return quoteIdentifier(field.field);
  }
  function convertValue(value, op) {
    switch (value.type) {
      case "STRING":
        return convertString(value);
      case "NUMBER":
        return String(value.value);
      case "KINTONE_FUNC":
        return convertKintoneFunc(value);
      case "IN_LIST":
        return convertInList(value, op);
    }
  }
  function convertString(v) {
    return `"${v.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  function convertKintoneFunc(v) {
    return `${v.name}()`;
  }
  function convertInList(v, op) {
    if (op !== "IN" && op !== "NOT_IN") {
      throw new KintoneQueryError("IN_LIST \u306F IN / NOT IN \u6F14\u7B97\u5B50\u3067\u306E\u307F\u4F7F\u7528\u3067\u304D\u307E\u3059");
    }
    const values = v.values.map(
      (item) => item.type === "STRING" ? convertString(item) : String(item.value)
    ).join(",");
    return `(${values})`;
  }
  function quoteIdentifier(name) {
    if (/^[\w$\u3000-\u9FFF]+$/u.test(name)) {
      return name;
    }
    return `"${name.replace(/"/g, '\\"')}"`;
  }
  function needsParens(expr) {
    return expr.type === "LOGICAL";
  }
  var KintoneQueryError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "KintoneQueryError";
    }
  };

  // src/converter/selectToKintone.ts
  function resolveSelectMode(stmt) {
    if (stmt.joins.length > 0) return "FULL_SCAN";
    if (stmt.groupBy.length > 0) return "FULL_SCAN";
    if (stmt.distinct) return "FULL_SCAN";
    if (stmt.columns.some((c) => c.type === "AGGREGATE")) return "FULL_SCAN";
    return "SIMPLE";
  }
  function selectToKintoneParams(stmt) {
    const queryParts = [];
    if (stmt.where !== null) {
      queryParts.push(whereToKintone(stmt.where));
    }
    if (stmt.orderBy.length > 0) {
      const orderStr = stmt.orderBy.map(convertOrderBy).join(", ");
      queryParts.push(`order by ${orderStr}`);
    }
    if (stmt.limit !== null) {
      queryParts.push(`limit ${stmt.limit}`);
    }
    if (stmt.offset !== null) {
      queryParts.push(`offset ${stmt.offset}`);
    }
    return {
      app: stmt.from.appId,
      query: queryParts.join(" "),
      fields: extractFields(stmt.columns),
      totalCount: false
    };
  }
  function selectToFetchAllParams(stmt, appId) {
    const queryParts = [];
    if (stmt.where !== null) {
      queryParts.push(whereToKintone(stmt.where));
    }
    return {
      app: appId,
      query: queryParts.join(" "),
      fields: []
      // 全件取得なので全フィールドを取得する
    };
  }
  function convertOrderBy(item) {
    const dir = item.direction === "ASC" ? "asc" : "desc";
    return `${item.field} ${dir}`;
  }
  function extractFields(columns) {
    const hasWildcard = columns.some(
      (c) => c.type === "WILDCARD" || c.type === "AGGREGATE"
    );
    if (hasWildcard) return [];
    return columns.filter(
      (c) => c.type === "FIELD"
    ).map((c) => c.field);
  }

  // src/converter/dmlToKintone.ts
  function insertToPostBatches(stmt) {
    const allRecords = stmt.values.map(
      (row) => buildInsertRecord(stmt.fields, row)
    );
    return chunk(allRecords, 100).map((records) => ({
      app: stmt.appId,
      records
    }));
  }
  function buildInsertRecord(fields, row) {
    const record = {};
    fields.forEach((field, i) => {
      record[field] = { value: toKintoneValue(row[i]) };
    });
    return record;
  }
  function updateToGetQuery(stmt) {
    return {
      app: stmt.appId,
      query: whereToKintone(stmt.where),
      fields: ["$id"],
      totalCount: false
    };
  }
  function updateToPutBatches(stmt, ids) {
    const record = buildUpdateRecord(stmt.assignments);
    return chunk(ids, 100).map((batch) => ({
      app: stmt.appId,
      records: batch.map((id) => ({ id, record }))
    }));
  }
  function buildUpdateRecord(assignments) {
    const record = {};
    for (const { field, value } of assignments) {
      if (value.type === "ARITH") continue;
      record[field] = { value: toKintoneValue(value) };
    }
    return record;
  }
  function hasArithAssignment(stmt) {
    return stmt.assignments.some((a) => a.value.type === "ARITH");
  }
  function updateToGetQueryForArith(stmt) {
    const refFields = /* @__PURE__ */ new Set();
    for (const { value } of stmt.assignments) {
      if (value.type === "ARITH") {
        collectArithFields(value, refFields);
      }
    }
    return {
      app: stmt.appId,
      query: whereToKintone(stmt.where),
      fields: ["$id", ...refFields],
      totalCount: false
    };
  }
  function collectArithFields(expr, out) {
    if (expr.left.type === "FIELD_REF") out.add(expr.left.field);
    if (expr.right.type === "FIELD_REF") out.add(expr.right.field);
  }
  function updateToPutBatchesArith(stmt, records) {
    const updateRecords = records.map((raw) => {
      const id = Number(raw["$id"].value);
      const record = {};
      for (const { field, value } of stmt.assignments) {
        if (value.type === "ARITH") {
          record[field] = { value: String(evalArith(value, raw)) };
        } else {
          record[field] = { value: toKintoneValue(value) };
        }
      }
      return { id, record };
    });
    return chunk(updateRecords, 100).map((batch) => ({
      app: stmt.appId,
      records: batch
    }));
  }
  function evalArith(expr, raw) {
    const l = resolveArithOperand(expr.left, raw);
    const r = resolveArithOperand(expr.right, raw);
    switch (expr.op) {
      case "+":
        return l + r;
      case "-":
        return l - r;
      case "*":
        return l * r;
      case "/":
        if (r === 0) throw new DmlConvertError("\u7B97\u8853\u5F0F\u3067\u30BC\u30ED\u9664\u7B97\u304C\u767A\u751F\u3057\u307E\u3057\u305F");
        return l / r;
    }
  }
  function resolveArithOperand(operand, raw) {
    if (operand.type === "NUMBER") return operand.value;
    const fieldVal = raw[operand.field]?.value ?? "";
    const n = Number(fieldVal);
    if (Number.isNaN(n)) {
      throw new DmlConvertError(
        `\u7B97\u8853\u5F0F\u306E\u30D5\u30A3\u30FC\u30EB\u30C9 "${operand.field}" \u306E\u5024 "${fieldVal}" \u306F\u6570\u5024\u3067\u306F\u3042\u308A\u307E\u305B\u3093`
      );
    }
    return n;
  }
  function deleteToGetQuery(stmt) {
    return {
      app: stmt.appId,
      query: whereToKintone(stmt.where),
      fields: ["$id"],
      totalCount: false
    };
  }
  function deleteToDeleteBatches(appId, ids) {
    return chunk(ids, 100).map((batch) => ({ app: appId, ids: batch }));
  }
  function toKintoneValue(value) {
    switch (value.type) {
      case "STRING":
        return value.value;
      case "NUMBER":
        return String(value.value);
      case "KINTONE_FUNC":
        throw new DmlConvertError(
          `${value.name}() \u306F INSERT / UPDATE \u306E\u5024\u3068\u3057\u3066\u4F7F\u7528\u3067\u304D\u307E\u305B\u3093`
        );
      case "IN_LIST":
        throw new DmlConvertError(
          "IN_LIST \u306F INSERT / UPDATE \u306E\u5024\u3068\u3057\u3066\u4F7F\u7528\u3067\u304D\u307E\u305B\u3093"
        );
    }
  }
  function chunk(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }
  var DmlConvertError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "DmlConvertError";
    }
  };

  // src/api/fetchAll.ts
  async function fetchAll(fetcher, app, query, fields, options = {}) {
    const pageSize = options.pageSize ?? PAGE_SIZE_DEFAULT;
    const maxRecords = options.maxRecords ?? MAX_RECORDS_DEFAULT;
    const allRecords = [];
    let offset = 0;
    while (true) {
      const pageQuery = buildPageQuery(query, pageSize, offset);
      const response = await fetcher({ app, query: pageQuery, fields });
      const records = response.records;
      allRecords.push(...records);
      if (allRecords.length > maxRecords) {
        throw new FetchAllLimitError(
          `\u53D6\u5F97\u4EF6\u6570\u304C\u4E0A\u9650\uFF08${maxRecords} \u4EF6\uFF09\u3092\u8D85\u3048\u307E\u3057\u305F\u3002WHERE \u53E5\u3067\u7D5E\u308A\u8FBC\u3080\u304B\u3001maxRecords \u3092\u5F15\u304D\u4E0A\u3052\u3066\u304F\u3060\u3055\u3044\u3002`
        );
      }
      if (records.length < pageSize) break;
      offset += pageSize;
    }
    return allRecords;
  }
  function extractIds(records) {
    return records.map((r) => {
      const raw = r["$id"]?.value;
      if (raw === void 0) {
        throw new Error(
          '\u30EC\u30B3\u30FC\u30C9\u306B $id \u30D5\u30A3\u30FC\u30EB\u30C9\u304C\u542B\u307E\u308C\u3066\u3044\u307E\u305B\u3093\u3002fields \u306B "$id" \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002'
        );
      }
      const id = Number(raw);
      if (!Number.isFinite(id)) {
        throw new Error(`$id \u306E\u5024\u304C\u6570\u5024\u3067\u306F\u3042\u308A\u307E\u305B\u3093: ${raw}`);
      }
      return id;
    });
  }
  var PAGE_SIZE_DEFAULT = 500;
  var MAX_RECORDS_DEFAULT = 1e4;
  function buildPageQuery(query, pageSize, offset) {
    const base = query.trimEnd();
    const suffix = `limit ${pageSize} offset ${offset}`;
    return base ? `${base} ${suffix}` : suffix;
  }
  var FetchAllLimitError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "FetchAllLimitError";
    }
  };

  // src/engine/evalWhere.ts
  function evalWhere(expr, row) {
    switch (expr.type) {
      case "BINARY":
        return evalBinary(expr, row);
      case "NULL_CHECK":
        return evalNullCheck(expr, row);
      case "LOGICAL":
        return evalLogical(expr, row);
      case "NOT":
        return !evalWhere(expr.expr, row);
      case "GROUP":
        return evalWhere(expr.expr, row);
    }
  }
  function evalBinary(expr, row) {
    const left = resolveField(expr.left, row);
    return evalOp(expr.op, left, expr.right, row);
  }
  function evalOp(op, leftStr, right, _row) {
    if (op === "IN") {
      if (right.type !== "IN_LIST") return false;
      return right.values.some((v) => leftStr === String(v.value));
    }
    if (op === "NOT_IN") {
      if (right.type !== "IN_LIST") return true;
      return right.values.every((v) => leftStr !== String(v.value));
    }
    if (op === "LIKE") {
      const pattern = resolveValue(right);
      return matchLike(leftStr, pattern);
    }
    if (op === "NOT_LIKE") {
      const pattern = resolveValue(right);
      return !matchLike(leftStr, pattern);
    }
    const rightStr = resolveValue(right);
    const leftNum = Number(leftStr);
    const rightNum = Number(rightStr);
    const numeric = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
    switch (op) {
      case "=":
        return leftStr === rightStr;
      case "!=":
      case "<>":
        return leftStr !== rightStr;
      case ">":
        return numeric ? leftNum > rightNum : leftStr > rightStr;
      case "<":
        return numeric ? leftNum < rightNum : leftStr < rightStr;
      case ">=":
        return numeric ? leftNum >= rightNum : leftStr >= rightStr;
      case "<=":
        return numeric ? leftNum <= rightNum : leftStr <= rightStr;
    }
  }
  function evalNullCheck(expr, row) {
    const val = resolveField(expr.field, row);
    return expr.not ? val !== "" : val === "";
  }
  function evalLogical(expr, row) {
    if (expr.op === "AND") {
      return evalWhere(expr.left, row) && evalWhere(expr.right, row);
    }
    return evalWhere(expr.left, row) || evalWhere(expr.right, row);
  }
  function resolveField(field, row) {
    const key = field.tableAlias ? `${field.tableAlias}.${field.field}` : field.field;
    return row[key] ?? "";
  }
  function resolveValue(value) {
    switch (value.type) {
      case "STRING":
        return value.value;
      case "NUMBER":
        return String(value.value);
      case "KINTONE_FUNC":
        return resolveKintoneFunc(value.name);
      case "IN_LIST":
        return "";
    }
  }
  function resolveKintoneFunc(name) {
    const now = /* @__PURE__ */ new Date();
    switch (name) {
      case "TODAY": {
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
      case "NOW":
        return now.toISOString();
      case "LOGINUSER":
        return "";
    }
  }
  function matchLike(value, pattern) {
    let regexStr = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "%") {
        regexStr += ".*";
      } else if (ch === "_") {
        regexStr += ".";
      } else {
        regexStr += ch.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
      }
    }
    regexStr += "$";
    return new RegExp(regexStr, "u").test(value);
  }

  // src/engine/process.ts
  function flatten(record, alias) {
    const row = {};
    for (const [field, fv] of Object.entries(record)) {
      const key = alias ? `${alias}.${field}` : field;
      const val = fv.value;
      row[key] = typeof val === "string" ? val : JSON.stringify(val ?? "");
    }
    return row;
  }
  function applyJoin(leftRows, rightRows, join) {
    const { on, type: joinType } = join;
    const leftKey = on.left.tableAlias ? `${on.left.tableAlias}.${on.left.field}` : on.left.field;
    const rightKey = on.right.tableAlias ? `${on.right.tableAlias}.${on.right.field}` : on.right.field;
    const rightIndex = /* @__PURE__ */ new Map();
    for (const rRow of rightRows) {
      const k = rRow[rightKey] ?? "";
      const bucket = rightIndex.get(k);
      if (bucket) bucket.push(rRow);
      else rightIndex.set(k, [rRow]);
    }
    const result = [];
    for (const lRow of leftRows) {
      const k = lRow[leftKey] ?? "";
      const matched = rightIndex.get(k) ?? [];
      if (matched.length > 0) {
        for (const rRow of matched) {
          result.push({ ...lRow, ...rRow });
        }
      } else if (joinType === "LEFT") {
        const emptyRight = {};
        for (const key of Object.keys(rightRows[0] ?? {})) {
          emptyRight[key] = "";
        }
        result.push({ ...lRow, ...emptyRight });
      }
    }
    return result;
  }
  function applyFilter(rows, where) {
    if (where === null) return rows;
    return rows.filter((row) => evalWhere(where, row));
  }
  function applyGroupBy(rows, groupByFields, columns) {
    const groups = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const key = groupByFields.map((f) => row[f] ?? "").join("\0");
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    const result = [];
    for (const groupRows of groups.values()) {
      const outRow = {};
      for (const f of groupByFields) {
        outRow[f] = groupRows[0][f] ?? "";
      }
      for (const col of columns) {
        if (col.type !== "AGGREGATE") continue;
        const outputKey = col.alias ?? aggregateSyntheticName(col.func, col.distinct, col.arg);
        outRow[outputKey] = String(evalAggregate(col.func, col.distinct, col.arg, groupRows));
      }
      result.push(outRow);
    }
    return result;
  }
  function evalAggregate(func, distinct, arg, rows) {
    const isWildcard = typeof arg !== "string";
    const rawValues = [];
    for (const row of rows) {
      if (isWildcard) {
        rawValues.push("");
      } else {
        const raw = row[arg];
        if (raw === void 0 || raw === "") continue;
        rawValues.push(raw);
      }
    }
    const effectiveRaw = distinct ? [...new Set(rawValues)] : rawValues;
    if (func === "COUNT") {
      return isWildcard ? rows.length : effectiveRaw.length;
    }
    const nums = effectiveRaw.map(Number);
    switch (func) {
      case "SUM":
        return nums.reduce((a, b) => a + b, 0);
      case "AVG":
        return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
      case "MAX":
        return nums.length === 0 ? 0 : Math.max(...nums);
      case "MIN":
        return nums.length === 0 ? 0 : Math.min(...nums);
    }
  }
  function aggregateSyntheticName(func, distinct, arg) {
    const argStr = typeof arg === "string" ? arg : "*";
    return distinct ? `${func}(DISTINCT ${argStr})` : `${func}(${argStr})`;
  }
  function applyHaving(rows, having) {
    if (having === null) return rows;
    return rows.filter((row) => evalWhere(having, row));
  }
  function applyDistinct(rows, columns) {
    const seen = /* @__PURE__ */ new Set();
    return rows.filter((row) => {
      const key = buildDistinctKey(row, columns);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function buildDistinctKey(row, columns) {
    if (columns.some((c) => c.type === "WILDCARD")) {
      return JSON.stringify(Object.entries(row).sort());
    }
    return columns.filter((c) => c.type === "FIELD").map((c) => row[c.field] ?? "").join("\0");
  }
  function applyOrderBy(rows, orderBy) {
    if (orderBy.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const { field, direction } of orderBy) {
        const av = a[field] ?? "";
        const bv = b[field] ?? "";
        const an = Number(av);
        const bn = Number(bv);
        const numeric = !Number.isNaN(an) && !Number.isNaN(bn);
        const cmp = numeric ? an - bn : av.localeCompare(bv, "ja");
        if (cmp !== 0) return direction === "ASC" ? cmp : -cmp;
      }
      return 0;
    });
  }
  function applyLimit(rows, limit, offset) {
    const start = offset ?? 0;
    if (limit === null) return rows.slice(start);
    return rows.slice(start, start + limit);
  }
  function project(rows, columns) {
    if (columns.length === 1 && columns[0].type === "WILDCARD") {
      return rows;
    }
    return rows.map((row) => {
      const out = {};
      for (const col of columns) {
        switch (col.type) {
          case "WILDCARD":
            Object.assign(out, row);
            break;
          case "FIELD": {
            const key = col.alias ?? col.field;
            out[key] = row[col.field] ?? "";
            break;
          }
          case "AGGREGATE": {
            const srcKey = aggregateSyntheticName(col.func, col.distinct, col.arg);
            const dstKey = col.alias ?? srcKey;
            out[dstKey] = row[col.alias ?? srcKey] ?? row[srcKey] ?? "0";
            break;
          }
        }
      }
      return out;
    });
  }
  function runFullScan(input) {
    const { stmt, tables } = input;
    let rows = [];
    const mainAlias = stmt.from.alias;
    const mainRecords = tables.get(mainAlias) ?? tables.get(null) ?? [];
    rows = mainRecords.map((r) => flatten(r, mainAlias));
    for (const join of stmt.joins) {
      const rightAlias = join.table.alias;
      const rightRecords = tables.get(rightAlias) ?? [];
      const rightRows = rightRecords.map((r) => flatten(r, rightAlias));
      rows = applyJoin(rows, rightRows, join);
    }
    if (stmt.joins.length > 0) {
      rows = applyFilter(rows, stmt.where);
    }
    if (stmt.groupBy.length > 0) {
      rows = applyGroupBy(rows, stmt.groupBy, stmt.columns);
    }
    rows = applyHaving(rows, stmt.having);
    if (stmt.distinct) {
      rows = applyDistinct(rows, stmt.columns);
    }
    rows = applyOrderBy(rows, stmt.orderBy);
    rows = applyLimit(rows, stmt.limit, stmt.offset);
    rows = project(rows, stmt.columns);
    return rows;
  }

  // src/execute.ts
  async function execute(sql, client, options = {}) {
    const stmt = parseSql(sql);
    switch (stmt.type) {
      case "SELECT":
        return executeSelect(stmt, client, options);
      case "INSERT":
        return executeInsert(stmt, client);
      case "UPDATE":
        return executeUpdate(stmt, client, options);
      case "DELETE":
        return executeDelete(stmt, client, options);
    }
  }
  async function executeSelect(stmt, client, options) {
    const mode = resolveSelectMode(stmt);
    if (mode === "SIMPLE") {
      return executeSimpleSelect(stmt, client);
    } else {
      return executeFullScanSelect(stmt, client, options);
    }
  }
  async function executeSimpleSelect(stmt, client) {
    const params = selectToKintoneParams(stmt);
    let records;
    if (params.query.includes("limit") || stmt.limit !== null && stmt.limit <= 500) {
      const res = await client.getRecords({
        app: params.app,
        query: params.query,
        fields: params.fields
      });
      records = res.records;
    } else {
      records = await fetchAll(
        client.getRecords,
        params.app,
        buildBaseQuery(params.query),
        params.fields,
        { maxRecords: 1e4 }
      );
    }
    const rows = records.map((r) => flatten(r, null));
    const projected = project(rows, stmt.columns);
    return { type: "SELECT", rows: projected, rowCount: projected.length };
  }
  async function executeFullScanSelect(stmt, client, options) {
    const maxRecords = options.maxRecords ?? 1e4;
    const mainParams = selectToFetchAllParams(stmt, stmt.from.appId);
    const mainRecords = await fetchAll(
      client.getRecords,
      mainParams.app,
      mainParams.query,
      mainParams.fields,
      { maxRecords }
    );
    const tables = /* @__PURE__ */ new Map();
    tables.set(stmt.from.alias, mainRecords);
    const joinFetches = stmt.joins.map(async (join) => {
      const joinParams = selectToFetchAllParams(stmt, join.table.appId);
      const joinRecords = await fetchAll(
        client.getRecords,
        join.table.appId,
        "",
        // JOIN テーブルは WHERE なしで全件取得
        [],
        { maxRecords }
      );
      tables.set(join.table.alias, joinRecords);
    });
    await Promise.all(joinFetches);
    const rows = runFullScan({ tables, stmt });
    return { type: "SELECT", rows, rowCount: rows.length };
  }
  async function executeInsert(stmt, client) {
    const batches = insertToPostBatches(stmt);
    const createdIds = [];
    for (const batch of batches) {
      const res = await client.postRecords(batch);
      createdIds.push(res.ids);
    }
    return {
      type: "INSERT",
      createdIds,
      insertedCount: createdIds.flat().length
    };
  }
  async function executeUpdate(stmt, client, options) {
    const maxRecords = options.maxRecords ?? 1e4;
    if (hasArithAssignment(stmt)) {
      const getParams2 = updateToGetQueryForArith(stmt);
      const records2 = await fetchAll(
        client.getRecords,
        getParams2.app,
        getParams2.query,
        [...getParams2.fields],
        { maxRecords }
      );
      if (options.confirm) {
        const ok = await options.confirm(records2.length, "UPDATE");
        if (!ok) throw new OperationCancelledError("UPDATE", records2.length);
      }
      const batches2 = updateToPutBatchesArith(stmt, records2);
      for (const batch of batches2) {
        await client.putRecords(batch);
      }
      return { type: "UPDATE", updatedCount: records2.length };
    }
    const getParams = updateToGetQuery(stmt);
    const records = await fetchAll(
      client.getRecords,
      getParams.app,
      getParams.query,
      [...getParams.fields],
      { maxRecords }
    );
    const ids = extractIds(records);
    if (options.confirm) {
      const ok = await options.confirm(ids.length, "UPDATE");
      if (!ok) throw new OperationCancelledError("UPDATE", ids.length);
    }
    const batches = updateToPutBatches(stmt, ids);
    for (const batch of batches) {
      await client.putRecords(batch);
    }
    return { type: "UPDATE", updatedCount: ids.length };
  }
  async function executeDelete(stmt, client, options) {
    const getParams = deleteToGetQuery(stmt);
    const records = await fetchAll(
      client.getRecords,
      getParams.app,
      getParams.query,
      [...getParams.fields],
      { maxRecords: options.maxRecords ?? 1e4 }
    );
    const ids = extractIds(records);
    if (options.confirm) {
      const ok = await options.confirm(ids.length, "DELETE");
      if (!ok) throw new OperationCancelledError("DELETE", ids.length);
    }
    const batches = deleteToDeleteBatches(stmt.appId, ids);
    for (const batch of batches) {
      await client.deleteRecords(batch);
    }
    return { type: "DELETE", deletedCount: ids.length };
  }
  function parseSql(sql) {
    try {
      const tokens = new Lexer(sql).tokenize();
      return new Parser(tokens).parse();
    } catch (e) {
      if (e instanceof LexError || e instanceof ParseError) {
        throw e;
      }
      throw e;
    }
  }
  function buildBaseQuery(query) {
    const idx = query.toLowerCase().indexOf(" order by");
    if (idx !== -1) return query.slice(0, idx).trimEnd();
    const limIdx = query.toLowerCase().indexOf(" limit");
    if (limIdx !== -1) return query.slice(0, limIdx).trimEnd();
    return query;
  }
  var OperationCancelledError = class extends Error {
    constructor(operation, affectedCount) {
      super(
        `${operation} \u3092\u30AD\u30E3\u30F3\u30BB\u30EB\u3057\u307E\u3057\u305F\uFF08\u5BFE\u8C61: ${affectedCount} \u4EF6\uFF09`
      );
      this.operation = operation;
      this.affectedCount = affectedCount;
      this.name = "OperationCancelledError";
    }
  };

  // src/ui/kintoneClient.ts
  var RECORDS_URL = "/k/v1/records.json";
  function createKintoneClient() {
    return {
      async getRecords(params) {
        const res = await kintone.api(RECORDS_URL, "GET", {
          app: params.app,
          query: params.query,
          fields: params.fields.length > 0 ? params.fields : void 0
        });
        return { records: res.records };
      },
      async postRecords(params) {
        const res = await kintone.api(RECORDS_URL, "POST", {
          app: params.app,
          records: params.records
        });
        return { ids: res.ids };
      },
      async putRecords(params) {
        await kintone.api(RECORDS_URL, "PUT", {
          app: params.app,
          records: params.records
        });
      },
      async deleteRecords(params) {
        await kintone.api(RECORDS_URL, "DELETE", {
          app: params.app,
          ids: params.ids
        });
      }
    };
  }

  // src/ui/renderResult.ts
  function renderResult(result) {
    switch (result.type) {
      case "SELECT":
        return renderSelect(result);
      case "INSERT":
        return renderSuccess(`${result.insertedCount} \u4EF6\u306E\u30EC\u30B3\u30FC\u30C9\u3092\u767B\u9332\u3057\u307E\u3057\u305F\u3002`);
      case "UPDATE":
        return renderSuccess(`${result.updatedCount} \u4EF6\u306E\u30EC\u30B3\u30FC\u30C9\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F\u3002`);
      case "DELETE":
        return renderSuccess(`${result.deletedCount} \u4EF6\u306E\u30EC\u30B3\u30FC\u30C9\u3092\u524A\u9664\u3057\u307E\u3057\u305F\u3002`);
    }
  }
  function renderError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `<div class="ksql-error"><span class="ksql-error-icon">\u26A0</span>${escHtml(msg)}</div>`;
  }
  function renderLoading() {
    return `<div class="ksql-loading">\u5B9F\u884C\u4E2D...</div>`;
  }
  function renderSelect(result) {
    if (result.rows.length === 0) {
      return renderInfo("0 \u4EF6\u3067\u3057\u305F\u3002");
    }
    const headers = Object.keys(result.rows[0]);
    const headerHtml = headers.map((h) => `<th>${escHtml(h)}</th>`).join("");
    const bodyHtml = result.rows.map((row) => renderRow(row, headers)).join("");
    return `
<div class="ksql-result-meta">${result.rowCount} \u4EF6</div>
<div class="ksql-table-wrapper">
  <table class="ksql-table">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</div>`.trim();
  }
  function renderRow(row, headers) {
    const cells = headers.map((h) => `<td>${escHtml(row[h] ?? "")}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }
  function renderSuccess(msg) {
    return `<div class="ksql-success"><span class="ksql-success-icon">\u2713</span>${escHtml(msg)}</div>`;
  }
  function renderInfo(msg) {
    return `<div class="ksql-info">${escHtml(msg)}</div>`;
  }
  function escHtml(str) {
    return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // src/ui/desktop.ts
  var fieldCache = /* @__PURE__ */ new Map();
  async function fetchFields(appId) {
    if (fieldCache.has(appId)) return fieldCache.get(appId);
    const res = await kintone.api(
      "/k/v1/app/form/fields.json",
      "GET",
      { app: appId }
    );
    const fields = Object.values(res.properties).map((f) => ({
      code: f.code,
      label: f.label,
      fieldType: f.type
    }));
    fieldCache.set(appId, fields);
    return fields;
  }
  var PLUGIN_ID = "development";
  var HISTORY_KEY = `ksql_history_${PLUGIN_ID}`;
  var HISTORY_MAX = 30;
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    } catch {
      return [];
    }
  }
  function saveHistory(sql) {
    const list = loadHistory().filter((s) => s !== sql);
    list.unshift(sql);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  }
  kintone.events.on(
    ["app.record.index.show"],
    (event) => {
      if (document.getElementById("ksql-panel")) return event;
      mountPanel();
      return event;
    }
  );
  function mountPanel() {
    const panel = buildPanel();
    const header = kintone.app.getHeaderSpaceElement();
    if (!header) return;
    header.appendChild(panel);
  }
  function buildPanel() {
    const panel = el("div", "ksql-panel", { id: "ksql-panel" });
    const header = el("div", "ksql-panel-header");
    const title = el("span", "ksql-panel-title");
    title.textContent = "kSQL \u2014 SQL \u30AF\u30A8\u30EA\u5B9F\u884C";
    const toggle = el("button", "ksql-toggle-btn");
    toggle.textContent = "\u25B2 \u6298\u308A\u305F\u305F\u3080";
    toggle.addEventListener("click", () => toggleBody(body, toggle));
    header.append(title, toggle);
    const body = el("div", "ksql-panel-body", { id: "ksql-panel-body" });
    const editorRow = el("div", "ksql-editor-row");
    const editorCol = el("div", "ksql-editor-col");
    const editor = el("textarea", "ksql-editor", {
      id: "ksql-editor",
      placeholder: "SELECT * FROM APP100 WHERE \u30B9\u30C6\u30FC\u30BF\u30B9 = '\u5B8C\u4E86'",
      spellcheck: "false",
      autocomplete: "off"
    });
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void runSql(editor.value.trim(), resultArea);
      }
    });
    const buttonRow = el("div", "ksql-button-row");
    const runBtn = el("button", "ksql-run-btn", { id: "ksql-run-btn" });
    runBtn.textContent = "\u5B9F\u884C\uFF08Ctrl+Enter\uFF09";
    runBtn.addEventListener("click", () => void runSql(editor.value.trim(), resultArea));
    const clearBtn = el("button", "ksql-clear-btn");
    clearBtn.textContent = "\u30AF\u30EA\u30A2";
    clearBtn.addEventListener("click", () => {
      editor.value = "";
      resultArea.innerHTML = "";
      editor.focus();
    });
    const histBtn = el("button", "ksql-hist-btn", { id: "ksql-hist-btn" });
    histBtn.textContent = "\u5C65\u6B74 \u25BC";
    histBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleHistoryDropdown(editor, histBtn);
    });
    buttonRow.append(runBtn, clearBtn, histBtn);
    const histDropdown = el("div", "ksql-hist-dropdown", { id: "ksql-hist-dropdown" });
    histDropdown.style.display = "none";
    editorCol.append(editor, buttonRow, histDropdown);
    const sidebar = buildFieldSidebar(editor);
    editorRow.append(editorCol, sidebar);
    const resultArea = el("div", "ksql-result", { id: "ksql-result" });
    body.append(editorRow, resultArea);
    panel.append(header, body);
    document.addEventListener("click", () => closeHistoryDropdown());
    return panel;
  }
  function buildFieldSidebar(editor) {
    const sidebar = el("div", "ksql-field-sidebar");
    const sidebarHeader = el("div", "ksql-field-sidebar-header");
    const sidebarTitle = el("span", "ksql-field-sidebar-title");
    sidebarTitle.textContent = "\u30D5\u30A3\u30FC\u30EB\u30C9\u4E00\u89A7";
    sidebarHeader.appendChild(sidebarTitle);
    const inputRow = el("div", "ksql-field-input-row");
    const appInput = el("input", "ksql-field-app-input", {
      type: "number",
      placeholder: "\u30A2\u30D7\u30EAID",
      id: "ksql-field-app-input",
      min: "1"
    });
    const fetchBtn = el("button", "ksql-field-fetch-btn");
    fetchBtn.textContent = "\u53D6\u5F97";
    inputRow.append(appInput, fetchBtn);
    const listArea = el("div", "ksql-field-list-area", { id: "ksql-field-list-area" });
    listArea.textContent = "\u30A2\u30D7\u30EAID\u3092\u5165\u529B\u3057\u3066\u53D6\u5F97";
    const doFetch = () => {
      const appId = parseInt(appInput.value.trim(), 10);
      if (isNaN(appId) || appId <= 0) {
        listArea.textContent = "\u30A2\u30D7\u30EAID\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044";
        return;
      }
      listArea.textContent = "\u53D6\u5F97\u4E2D...";
      fetchBtn.disabled = true;
      fetchFields(appId).then((fields) => {
        renderFieldList(listArea, fields, editor);
      }).catch((err) => {
        listArea.textContent = err instanceof Error ? err.message : String(err);
      }).finally(() => {
        fetchBtn.disabled = false;
      });
    };
    fetchBtn.addEventListener("click", doFetch);
    appInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doFetch();
    });
    sidebar.append(sidebarHeader, inputRow, listArea);
    return sidebar;
  }
  function renderFieldList(listArea, fields, editor) {
    listArea.innerHTML = "";
    if (fields.length === 0) {
      listArea.textContent = "\u30D5\u30A3\u30FC\u30EB\u30C9\u304C\u3042\u308A\u307E\u305B\u3093";
      return;
    }
    const searchInput = el("input", "ksql-field-search", {
      type: "text",
      placeholder: "\u30D5\u30A3\u30EB\u30BF..."
    });
    const list = el("ul", "ksql-field-list");
    const buildItems = (filter) => {
      list.innerHTML = "";
      const lower = filter.toLowerCase();
      const filtered = filter ? fields.filter(
        (f) => f.code.toLowerCase().includes(lower) || f.label.toLowerCase().includes(lower)
      ) : fields;
      for (const f of filtered) {
        const li = el("li", "ksql-field-item");
        li.title = `${f.label} (${f.fieldType})`;
        const codeSpan = el("span", "ksql-field-code");
        codeSpan.textContent = f.code;
        const labelSpan = el("span", "ksql-field-label");
        labelSpan.textContent = f.label !== f.code ? f.label : "";
        li.append(codeSpan, labelSpan);
        li.addEventListener("click", () => insertAtCursor(editor, f.code));
        list.appendChild(li);
      }
      if (list.children.length === 0) {
        const empty = el("li", "ksql-field-empty");
        empty.textContent = "\u8A72\u5F53\u306A\u3057";
        list.appendChild(empty);
      }
    };
    searchInput.addEventListener("input", () => buildItems(searchInput.value));
    buildItems("");
    listArea.append(searchInput, list);
  }
  function insertAtCursor(ta, text) {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
  }
  function toggleHistoryDropdown(editor, btn) {
    const dropdown = document.getElementById("ksql-hist-dropdown");
    if (!dropdown) return;
    if (dropdown.style.display !== "none") {
      closeHistoryDropdown();
      return;
    }
    const history = loadHistory();
    if (history.length === 0) {
      dropdown.innerHTML = `<div class="ksql-hist-empty">\u5C65\u6B74\u304C\u3042\u308A\u307E\u305B\u3093</div>`;
    } else {
      dropdown.innerHTML = `
      <div class="ksql-hist-header">
        <span>\u5C65\u6B74\uFF08\u6700\u65B0 ${history.length} \u4EF6\uFF09</span>
        <button class="ksql-hist-clear-all" id="ksql-hist-clear-all">\u3059\u3079\u3066\u524A\u9664</button>
      </div>
      <ul class="ksql-hist-list" id="ksql-hist-list"></ul>
    `;
      const ul = dropdown.querySelector("#ksql-hist-list");
      history.forEach((sql, i) => {
        const li = document.createElement("li");
        li.className = "ksql-hist-item";
        li.title = sql;
        const preview = el("span", "ksql-hist-preview");
        preview.textContent = sql.length > 80 ? sql.slice(0, 80) + "\u2026" : sql;
        const runHistBtn = el("button", "ksql-hist-run");
        runHistBtn.textContent = "\u5B9F\u884C";
        runHistBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          editor.value = sql;
          closeHistoryDropdown();
          const resultArea = document.getElementById("ksql-result");
          if (resultArea) void runSql(sql, resultArea);
        });
        li.addEventListener("click", () => {
          editor.value = sql;
          closeHistoryDropdown();
          editor.focus();
        });
        li.append(preview, runHistBtn);
        ul.appendChild(li);
      });
      document.getElementById("ksql-hist-clear-all")?.addEventListener("click", (e) => {
        e.stopPropagation();
        void showConfirmDialog("\u5C65\u6B74\u3092\u3059\u3079\u3066\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F").then((ok) => {
          if (ok) {
            localStorage.removeItem(HISTORY_KEY);
            closeHistoryDropdown();
          }
        });
      });
    }
    dropdown.style.display = "";
    btn.textContent = "\u5C65\u6B74 \u25B2";
  }
  function closeHistoryDropdown() {
    const dropdown = document.getElementById("ksql-hist-dropdown");
    const btn = document.getElementById("ksql-hist-btn");
    if (dropdown) dropdown.style.display = "none";
    if (btn) btn.textContent = "\u5C65\u6B74 \u25BC";
  }
  async function runSql(sql, resultArea) {
    if (!sql) return;
    const runBtn = document.getElementById("ksql-run-btn");
    try {
      if (runBtn) runBtn.disabled = true;
      resultArea.innerHTML = renderLoading();
      const client = createKintoneClient();
      const result = await execute(sql, client, {
        confirm: confirmDialog,
        maxRecords: 1e4
      });
      saveHistory(sql);
      resultArea.innerHTML = renderResult(result);
    } catch (e) {
      if (e instanceof OperationCancelledError) {
        resultArea.innerHTML = `<div class="ksql-info">\u30AD\u30E3\u30F3\u30BB\u30EB\u3057\u307E\u3057\u305F\uFF08\u5BFE\u8C61: ${e.affectedCount} \u4EF6\uFF09</div>`;
      } else {
        resultArea.innerHTML = renderError(e);
      }
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }
  function showConfirmDialog(message, danger = false) {
    return new Promise((resolve) => {
      const overlay = el("div", "ksql-dialog-overlay");
      const dialog = el("div", "ksql-dialog");
      const msgEl = el("div", "ksql-dialog-message");
      msgEl.textContent = message;
      const btnRow = el("div", "ksql-dialog-btn-row");
      const okBtn = el("button", danger ? "ksql-dialog-ok ksql-dialog-ok--danger" : "ksql-dialog-ok");
      okBtn.textContent = "OK";
      const cancelBtn = el("button", "ksql-dialog-cancel");
      cancelBtn.textContent = "\u30AD\u30E3\u30F3\u30BB\u30EB";
      const close = (result) => {
        document.body.removeChild(overlay);
        resolve(result);
      };
      okBtn.addEventListener("click", () => close(true));
      cancelBtn.addEventListener("click", () => close(false));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(false);
      });
      btnRow.append(cancelBtn, okBtn);
      dialog.append(msgEl, btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }
  async function confirmDialog(count, operation) {
    const label = operation === "UPDATE" ? "\u66F4\u65B0" : "\u524A\u9664";
    return showConfirmDialog(
      `${count} \u4EF6\u306E\u30EC\u30B3\u30FC\u30C9\u3092${label}\u3057\u307E\u3059\u3002\u3088\u308D\u3057\u3044\u3067\u3059\u304B\uFF1F
\u3053\u306E\u64CD\u4F5C\u306F\u5143\u306B\u623B\u305B\u307E\u305B\u3093\u3002`,
      true
    );
  }
  function toggleBody(body, btn) {
    const collapsed = body.style.display === "none";
    body.style.display = collapsed ? "" : "none";
    btn.textContent = collapsed ? "\u25B2 \u6298\u308A\u305F\u305F\u3080" : "\u25BC \u5C55\u958B";
  }
  function el(tag, className, attrs) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        e.setAttribute(k, v);
      }
    }
    return e;
  }
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2xleGVyL3Rva2Vucy50cyIsICIuLi8uLi9zcmMvbGV4ZXIvbGV4ZXIudHMiLCAiLi4vLi4vc3JjL3BhcnNlci9wYXJzZXIudHMiLCAiLi4vLi4vc3JjL2VuZ2luZS9wdXNoRG93bk5vdC50cyIsICIuLi8uLi9zcmMvY29udmVydGVyL3doZXJlVG9LaW50b25lLnRzIiwgIi4uLy4uL3NyYy9jb252ZXJ0ZXIvc2VsZWN0VG9LaW50b25lLnRzIiwgIi4uLy4uL3NyYy9jb252ZXJ0ZXIvZG1sVG9LaW50b25lLnRzIiwgIi4uLy4uL3NyYy9hcGkvZmV0Y2hBbGwudHMiLCAiLi4vLi4vc3JjL2VuZ2luZS9ldmFsV2hlcmUudHMiLCAiLi4vLi4vc3JjL2VuZ2luZS9wcm9jZXNzLnRzIiwgIi4uLy4uL3NyYy9leGVjdXRlLnRzIiwgIi4uLy4uL3NyYy91aS9raW50b25lQ2xpZW50LnRzIiwgIi4uLy4uL3NyYy91aS9yZW5kZXJSZXN1bHQudHMiLCAiLi4vLi4vc3JjL3VpL2Rlc2t0b3AudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHUzMEM4XHUzMEZDXHUzMEFGXHUzMEYzXHU1QjlBXHU3RkE5XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBcdTMwQzhcdTMwRkNcdTMwQUZcdTMwRjNcdTdBMkVcdTUyMjVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY29uc3QgZW51bSBUb2tlbktpbmQge1xuICAvLyBcdTMwRUFcdTMwQzZcdTMwRTlcdTMwRUJcbiAgU1RSSU5HICA9IFwiU1RSSU5HXCIsICAgLy8gJ3ZhbHVlJ1xuICBOVU1CRVIgID0gXCJOVU1CRVJcIiwgICAvLyAxMjMgLyAzLjE0XG5cbiAgLy8gXHU4QjU4XHU1MjI1XHU1QjUwXG4gIElERU5UICAgPSBcIklERU5UXCIsICAgLy8gXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHU1NDBEXHUzMEZCXHUzMEM2XHUzMEZDXHUzMEQ2XHUzMEVCXHU1NDBEXHVGRjA4XHU2NUU1XHU2NzJDXHU4QTlFXHU1NDJCXHUzMDgwXHVGRjA5XG4gIEJJREVOVCAgPSBcIkJJREVOVFwiLCAgLy8gYFx1MzBEMFx1MzBDM1x1MzBBRlx1MzBBRlx1MzBBOVx1MzBGQ1x1MzBDOFx1OEI1OFx1NTIyNVx1NUI1MGBcblxuICAvLyBcdTMwQURcdTMwRkNcdTMwRUZcdTMwRkNcdTMwQzkgXHUyMDE1IERNTFxuICBTRUxFQ1QgICA9IFwiU0VMRUNUXCIsXG4gIERJU1RJTkNUID0gXCJESVNUSU5DVFwiLFxuICBGUk9NICAgICA9IFwiRlJPTVwiLFxuICBBUyAgICAgICA9IFwiQVNcIixcbiAgV0hFUkUgICAgPSBcIldIRVJFXCIsXG4gIElOU0VSVCAgID0gXCJJTlNFUlRcIixcbiAgSU5UTyAgICAgPSBcIklOVE9cIixcbiAgVkFMVUVTICAgPSBcIlZBTFVFU1wiLFxuICBVUERBVEUgICA9IFwiVVBEQVRFXCIsXG4gIFNFVCAgICAgID0gXCJTRVRcIixcbiAgREVMRVRFICAgPSBcIkRFTEVURVwiLFxuXG4gIC8vIFx1MzBBRFx1MzBGQ1x1MzBFRlx1MzBGQ1x1MzBDOSBcdTIwMTUgSk9JTlxuICBJTk5FUiA9IFwiSU5ORVJcIixcbiAgTEVGVCAgPSBcIkxFRlRcIixcbiAgSk9JTiAgPSBcIkpPSU5cIixcbiAgT04gICAgPSBcIk9OXCIsXG5cbiAgLy8gXHUzMEFEXHUzMEZDXHUzMEVGXHUzMEZDXHUzMEM5IFx1MjAxNSBcdTk2QzZcdThBMDhcdTMwRkJcdTMwQjBcdTMwRUJcdTMwRkNcdTMwRDdcbiAgR1JPVVAgID0gXCJHUk9VUFwiLFxuICBCWSAgICAgPSBcIkJZXCIsXG4gIEhBVklORyA9IFwiSEFWSU5HXCIsXG4gIE9SREVSICA9IFwiT1JERVJcIixcbiAgQVNDICAgID0gXCJBU0NcIixcbiAgREVTQyAgID0gXCJERVNDXCIsXG4gIExJTUlUICA9IFwiTElNSVRcIixcbiAgT0ZGU0VUID0gXCJPRkZTRVRcIixcblxuICAvLyBcdTMwQURcdTMwRkNcdTMwRUZcdTMwRkNcdTMwQzkgXHUyMDE1IFx1OTZDNlx1OEEwOFx1OTVBMlx1NjU3MFxuICBDT1VOVCA9IFwiQ09VTlRcIixcbiAgU1VNICAgPSBcIlNVTVwiLFxuICBBVkcgICA9IFwiQVZHXCIsXG4gIE1BWCAgID0gXCJNQVhcIixcbiAgTUlOICAgPSBcIk1JTlwiLFxuXG4gIC8vIFx1MzBBRFx1MzBGQ1x1MzBFRlx1MzBGQ1x1MzBDOSBcdTIwMTUgXHU2NzYxXHU0RUY2XG4gIEFORCAgICAgPSBcIkFORFwiLFxuICBPUiAgICAgID0gXCJPUlwiLFxuICBOT1QgICAgID0gXCJOT1RcIixcbiAgSVMgICAgICA9IFwiSVNcIixcbiAgTlVMTCAgICA9IFwiTlVMTFwiLFxuICBMSUtFICAgID0gXCJMSUtFXCIsXG4gIElOICAgICAgPSBcIklOXCIsXG4gIEJFVFdFRU4gPSBcIkJFVFdFRU5cIixcblxuICAvLyBraW50b25lIFx1NUMwMlx1NzUyOFx1OTVBMlx1NjU3MFxuICBUT0RBWSAgICAgID0gXCJUT0RBWVwiLFxuICBOT1cgICAgICAgID0gXCJOT1dcIixcbiAgTE9HSU5VU0VSICA9IFwiTE9HSU5VU0VSXCIsXG5cbiAgLy8gXHU2RjE0XHU3Qjk3XHU1QjUwXG4gIEVRICAgID0gXCI9XCIsXG4gIE5FUSAgID0gXCIhPVwiLFxuICBMVF9HVCA9IFwiPD5cIixcbiAgR1QgICAgPSBcIj5cIixcbiAgTFQgICAgPSBcIjxcIixcbiAgR1RFICAgPSBcIj49XCIsXG4gIExURSAgID0gXCI8PVwiLFxuXG4gIC8vIFx1N0I5N1x1ODg1M1x1NkYxNFx1N0I5N1x1NUI1MFxuICBQTFVTICA9IFwiK1wiLFxuICBNSU5VUyA9IFwiLVwiLFxuICBTTEFTSCA9IFwiL1wiLFxuXG4gIC8vIFx1OEExOFx1NTNGN1xuICBTVEFSICAgICAgPSBcIipcIixcbiAgTFBBUkVOICAgID0gXCIoXCIsXG4gIFJQQVJFTiAgICA9IFwiKVwiLFxuICBDT01NQSAgICAgPSBcIixcIixcbiAgRE9UICAgICAgID0gXCIuXCIsXG4gIFNFTUlDT0xPTiA9IFwiO1wiLFxuXG4gIC8vIFx1N0Q0Mlx1N0FFRlxuICBFT0YgPSBcIkVPRlwiLFxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBBRFx1MzBGQ1x1MzBFRlx1MzBGQ1x1MzBDOVx1MzBERVx1MzBDM1x1MzBEN1x1RkYwOFx1NTkyN1x1NjU4N1x1NUI1N1x1NUMwRlx1NjU4N1x1NUI1N1x1MzA5Mlx1NkI2M1x1ODk4Rlx1NTMxNlx1RkYwOVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjb25zdCBLRVlXT1JEUzogUmVhZG9ubHlNYXA8c3RyaW5nLCBUb2tlbktpbmQ+ID0gbmV3IE1hcChbXG4gIFtcIlNFTEVDVFwiLCAgICBUb2tlbktpbmQuU0VMRUNUXSxcbiAgW1wiRElTVElOQ1RcIiwgIFRva2VuS2luZC5ESVNUSU5DVF0sXG4gIFtcIkZST01cIiwgICAgICBUb2tlbktpbmQuRlJPTV0sXG4gIFtcIkFTXCIsICAgICAgICBUb2tlbktpbmQuQVNdLFxuICBbXCJXSEVSRVwiLCAgICAgVG9rZW5LaW5kLldIRVJFXSxcbiAgW1wiSU5TRVJUXCIsICAgIFRva2VuS2luZC5JTlNFUlRdLFxuICBbXCJJTlRPXCIsICAgICAgVG9rZW5LaW5kLklOVE9dLFxuICBbXCJWQUxVRVNcIiwgICAgVG9rZW5LaW5kLlZBTFVFU10sXG4gIFtcIlVQREFURVwiLCAgICBUb2tlbktpbmQuVVBEQVRFXSxcbiAgW1wiU0VUXCIsICAgICAgIFRva2VuS2luZC5TRVRdLFxuICBbXCJERUxFVEVcIiwgICAgVG9rZW5LaW5kLkRFTEVURV0sXG4gIFtcIklOTkVSXCIsICAgICBUb2tlbktpbmQuSU5ORVJdLFxuICBbXCJMRUZUXCIsICAgICAgVG9rZW5LaW5kLkxFRlRdLFxuICBbXCJKT0lOXCIsICAgICAgVG9rZW5LaW5kLkpPSU5dLFxuICBbXCJPTlwiLCAgICAgICAgVG9rZW5LaW5kLk9OXSxcbiAgW1wiR1JPVVBcIiwgICAgIFRva2VuS2luZC5HUk9VUF0sXG4gIFtcIkJZXCIsICAgICAgICBUb2tlbktpbmQuQlldLFxuICBbXCJIQVZJTkdcIiwgICAgVG9rZW5LaW5kLkhBVklOR10sXG4gIFtcIk9SREVSXCIsICAgICBUb2tlbktpbmQuT1JERVJdLFxuICBbXCJBU0NcIiwgICAgICAgVG9rZW5LaW5kLkFTQ10sXG4gIFtcIkRFU0NcIiwgICAgICBUb2tlbktpbmQuREVTQ10sXG4gIFtcIkxJTUlUXCIsICAgICBUb2tlbktpbmQuTElNSVRdLFxuICBbXCJPRkZTRVRcIiwgICAgVG9rZW5LaW5kLk9GRlNFVF0sXG4gIFtcIkNPVU5UXCIsICAgICBUb2tlbktpbmQuQ09VTlRdLFxuICBbXCJTVU1cIiwgICAgICAgVG9rZW5LaW5kLlNVTV0sXG4gIFtcIkFWR1wiLCAgICAgICBUb2tlbktpbmQuQVZHXSxcbiAgW1wiTUFYXCIsICAgICAgIFRva2VuS2luZC5NQVhdLFxuICBbXCJNSU5cIiwgICAgICAgVG9rZW5LaW5kLk1JTl0sXG4gIFtcIkFORFwiLCAgICAgICBUb2tlbktpbmQuQU5EXSxcbiAgW1wiT1JcIiwgICAgICAgIFRva2VuS2luZC5PUl0sXG4gIFtcIk5PVFwiLCAgICAgICBUb2tlbktpbmQuTk9UXSxcbiAgW1wiSVNcIiwgICAgICAgIFRva2VuS2luZC5JU10sXG4gIFtcIk5VTExcIiwgICAgICBUb2tlbktpbmQuTlVMTF0sXG4gIFtcIkxJS0VcIiwgICAgICBUb2tlbktpbmQuTElLRV0sXG4gIFtcIklOXCIsICAgICAgICBUb2tlbktpbmQuSU5dLFxuICBbXCJCRVRXRUVOXCIsICAgVG9rZW5LaW5kLkJFVFdFRU5dLFxuICBbXCJUT0RBWVwiLCAgICAgVG9rZW5LaW5kLlRPREFZXSxcbiAgW1wiTk9XXCIsICAgICAgIFRva2VuS2luZC5OT1ddLFxuICBbXCJMT0dJTlVTRVJcIiwgVG9rZW5LaW5kLkxPR0lOVVNFUl0sXG5dKTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUb2tlbiBcdTMwQUFcdTMwRDZcdTMwQjhcdTMwQTdcdTMwQUZcdTMwQzhcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIFRva2VuIHtcbiAga2luZDogIFRva2VuS2luZDtcbiAgdmFsdWU6IHN0cmluZzsgICAvLyBcdTUxNDNcdTMwNkVcdTMwQzZcdTMwQURcdTMwQjlcdTMwQzhcdUZGMDhcdTMwRUFcdTMwQzZcdTMwRTlcdTMwRUJcdTMwNkZcdTUyQTBcdTVERTVcdTZFMDhcdTMwN0ZcdUZGMDlcbiAgcG9zOiAgIG51bWJlcjsgICAvLyBcdTUxNjVcdTUyOUJcdTY1ODdcdTVCNTdcdTUyMTdcdTRFMEFcdTMwNkVcdTk1OEJcdTU5Q0JcdTRGNERcdTdGNkVcdUZGMDgwLWluZGV4ZWRcdUZGMDlcbn1cbiIsICIvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIExleGVyXHVGRjA4XHU1QjU3XHU1M0U1XHU4OUUzXHU2NzkwXHU1NjY4XHVGRjA5XG4vL1xuLy8gXHU1MTY1XHU1MjlCOiBTUUwgXHU2NTg3XHU1QjU3XHU1MjE3XG4vLyBcdTUxRkFcdTUyOUI6IFRva2VuW11cbi8vXG4vLyBcdThCNThcdTUyMjVcdTVCNTBcdTMwRUJcdTMwRkNcdTMwRUJcdUZGMDhcdTRFRDVcdTY5RDhcdTY2RjggXHUwMEE3NVx1RkYwOTpcbi8vICAgXHUzMEFGXHUzMEE5XHUzMEZDXHUzMEM4XHUzMDZBXHUzMDU3IFx1MjE5MiBBU0NJSVx1ODJGMVx1NjU3MFx1NUI1N1x1MzBGQl9cdTMwRkIkXHUzMEZCXHU2NUU1XHU2NzJDXHU4QTlFIFVuaWNvZGUgKFUrMzA0MC1VKzlGRkYpXG4vLyAgIFx1MzBEMFx1MzBDM1x1MzBBRlx1MzBBRlx1MzBBOVx1MzBGQ1x1MzBDOCBcdTIxOTIgXHU0RUZCXHU2MTBGXHUzMDZFXHU2NTg3XHU1QjU3XHVGRjA4XHUzMEI5XHUzMERBXHUzMEZDXHUzMEI5XHUzMEZCXHU2MkVDXHU1RjI3XHU3QjQ5XHUzMDkyXHU1NDJCXHUzMDgwXHU1ODM0XHU1NDA4XHVGRjA5XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW1wb3J0IHsgVG9rZW4sIFRva2VuS2luZCwgS0VZV09SRFMgfSBmcm9tIFwiLi90b2tlbnNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBcdTMwQThcdTMwRTlcdTMwRkNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY2xhc3MgTGV4RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICBwdWJsaWMgcmVhZG9ubHkgcG9zOiBudW1iZXIsXG4gICAgcHVibGljIHJlYWRvbmx5IGlucHV0OiBzdHJpbmdcbiAgKSB7XG4gICAgY29uc3QgYXJvdW5kID0gaW5wdXQuc2xpY2UoTWF0aC5tYXgoMCwgcG9zIC0gMTApLCBwb3MgKyAxMCk7XG4gICAgc3VwZXIoYCR7bWVzc2FnZX1cdUZGMDhcdTRGNERcdTdGNkUgJHtwb3N9XHUzMDAxXHU1MjREXHU1RjhDOiBcdTMwMEMke2Fyb3VuZH1cdTMwMERcdUZGMDlgKTtcbiAgICB0aGlzLm5hbWUgPSBcIkxleEVycm9yXCI7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBMZXhlciBcdTMwQUZcdTMwRTlcdTMwQjlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY2xhc3MgTGV4ZXIge1xuICBwcml2YXRlIHBvcyA9IDA7XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBpbnB1dDogc3RyaW5nKSB7fVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gXHU1MTZDXHU5NThCIEFQSTogXHU1MTY4XHUzMEM4XHUzMEZDXHUzMEFGXHUzMEYzXHUzMDkyXHU4RkQ0XHUzMDU5XG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICB0b2tlbml6ZSgpOiBUb2tlbltdIHtcbiAgICBjb25zdCB0b2tlbnM6IFRva2VuW10gPSBbXTtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgY29uc3QgdG9rID0gdGhpcy5uZXh0VG9rZW4oKTtcbiAgICAgIHRva2Vucy5wdXNoKHRvayk7XG4gICAgICBpZiAodG9rLmtpbmQgPT09IFRva2VuS2luZC5FT0YpIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4gdG9rZW5zO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBcdTZCMjFcdTMwNkVcdTMwQzhcdTMwRkNcdTMwQUZcdTMwRjNcdTMwOTJcdThBQURcdTMwN0ZcdTUzRDZcdTMwOEJcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgbmV4dFRva2VuKCk6IFRva2VuIHtcbiAgICB0aGlzLnNraXBXaGl0ZXNwYWNlQW5kQ29tbWVudHMoKTtcblxuICAgIGlmICh0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aCkge1xuICAgICAgcmV0dXJuIHRoaXMubWFrZVRva2VuKFRva2VuS2luZC5FT0YsIFwiXCIsIHRoaXMucG9zKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFydCA9IHRoaXMucG9zO1xuICAgIGNvbnN0IGNoID0gdGhpcy5pbnB1dFt0aGlzLnBvc107XG5cbiAgICAvLyBcdTY1ODdcdTVCNTdcdTUyMTdcdTMwRUFcdTMwQzZcdTMwRTlcdTMwRUI6ICd2YWx1ZSdcbiAgICBpZiAoY2ggPT09IFwiJ1wiKSByZXR1cm4gdGhpcy5yZWFkU3RyaW5nKHN0YXJ0KTtcblxuICAgIC8vIFx1MzBEMFx1MzBDM1x1MzBBRlx1MzBBRlx1MzBBOVx1MzBGQ1x1MzBDOFx1OEI1OFx1NTIyNVx1NUI1MDogYGZpZWxkIG5hbWVgXG4gICAgaWYgKGNoID09PSBcImBcIikgcmV0dXJuIHRoaXMucmVhZEJhY2t0aWNrSWRlbnQoc3RhcnQpO1xuXG4gICAgLy8gXHU2NTcwXHU1MDI0XG4gICAgaWYgKGlzRGlnaXQoY2gpKSByZXR1cm4gdGhpcy5yZWFkTnVtYmVyKHN0YXJ0KTtcblxuICAgIC8vIFx1NkYxNFx1N0I5N1x1NUI1MFx1MzBGQlx1OEExOFx1NTNGN1xuICAgIGNvbnN0IG9wVG9rID0gdGhpcy50cnlSZWFkT3BlcmF0b3Ioc3RhcnQpO1xuICAgIGlmIChvcFRvaykgcmV0dXJuIG9wVG9rO1xuXG4gICAgLy8gXHU4QjU4XHU1MjI1XHU1QjUwIC8gXHUzMEFEXHUzMEZDXHUzMEVGXHUzMEZDXHUzMEM5XHVGRjA4XHU2NUU1XHU2NzJDXHU4QTlFXHU1NDJCXHUzMDgwXHVGRjA5XG4gICAgaWYgKGlzSWRlbnRTdGFydChjaCkpIHJldHVybiB0aGlzLnJlYWRJZGVudE9yS2V5d29yZChzdGFydCk7XG5cbiAgICB0aHJvdyBuZXcgTGV4RXJyb3IoXG4gICAgICBgXHU0RTg4XHU2NzFGXHUzMDU3XHUzMDZBXHUzMDQ0XHU2NTg3XHU1QjU3IFx1MzAwQyR7Y2h9XHUzMDBEIFx1MzA2N1x1MzA1OWAsXG4gICAgICB0aGlzLnBvcyxcbiAgICAgIHRoaXMuaW5wdXRcbiAgICApO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBcdTY1ODdcdTVCNTdcdTUyMTdcdTMwRUFcdTMwQzZcdTMwRTlcdTMwRUI6ICd2YWx1ZSdcbiAgLy8gXHUzMEI3XHUzMEYzXHUzMEIwXHUzMEVCXHUzMEFGXHUzMEE5XHUzMEZDXHUzMEM4XHU1MTg1XHUzMDZFICcnIFx1MzA2Rlx1MzBBOFx1MzBCOVx1MzBCMVx1MzBGQ1x1MzBEN1x1MzA2OFx1MzA1N1x1MzA2Nlx1NjI3MVx1MzA0NlxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSByZWFkU3RyaW5nKHN0YXJ0OiBudW1iZXIpOiBUb2tlbiB7XG4gICAgdGhpcy5wb3MrKzsgLy8gXHU5NThCXHUzMDREICdcbiAgICBsZXQgdmFsdWUgPSBcIlwiO1xuICAgIHdoaWxlICh0aGlzLnBvcyA8IHRoaXMuaW5wdXQubGVuZ3RoKSB7XG4gICAgICBjb25zdCBjaCA9IHRoaXMuaW5wdXRbdGhpcy5wb3NdO1xuICAgICAgaWYgKGNoID09PSBcIidcIikge1xuICAgICAgICB0aGlzLnBvcysrO1xuICAgICAgICAvLyAnJyBcdTIxOTIgJyAoXHUzMEE4XHUzMEI5XHUzMEIxXHUzMEZDXHUzMEQ3KVxuICAgICAgICBpZiAodGhpcy5wb3MgPCB0aGlzLmlucHV0Lmxlbmd0aCAmJiB0aGlzLmlucHV0W3RoaXMucG9zXSA9PT0gXCInXCIpIHtcbiAgICAgICAgICB2YWx1ZSArPSBcIidcIjtcbiAgICAgICAgICB0aGlzLnBvcysrO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFx1OTU4OVx1MzA1OFx1MzBBRlx1MzBBOVx1MzBGQ1x1MzBDOFxuICAgICAgICAgIHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuU1RSSU5HLCB2YWx1ZSwgc3RhcnQpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YWx1ZSArPSBjaDtcbiAgICAgICAgdGhpcy5wb3MrKztcbiAgICAgIH1cbiAgICB9XG4gICAgdGhyb3cgbmV3IExleEVycm9yKFwiXHU2NTg3XHU1QjU3XHU1MjE3XHUzMEVBXHUzMEM2XHUzMEU5XHUzMEVCXHUzMDRDXHU5NTg5XHUzMDU4XHUzMDg5XHUzMDhDXHUzMDY2XHUzMDQ0XHUzMDdFXHUzMDVCXHUzMDkzXCIsIHN0YXJ0LCB0aGlzLmlucHV0KTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gXHUzMEQwXHUzMEMzXHUzMEFGXHUzMEFGXHUzMEE5XHUzMEZDXHUzMEM4XHU4QjU4XHU1MjI1XHU1QjUwOiBgZmllbGQgbmFtZWBcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgcmVhZEJhY2t0aWNrSWRlbnQoc3RhcnQ6IG51bWJlcik6IFRva2VuIHtcbiAgICB0aGlzLnBvcysrOyAvLyBcdTk1OEJcdTMwNEQgYFxuICAgIGxldCB2YWx1ZSA9IFwiXCI7XG4gICAgd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IGNoID0gdGhpcy5pbnB1dFt0aGlzLnBvc107XG4gICAgICBpZiAoY2ggPT09IFwiYFwiKSB7XG4gICAgICAgIHRoaXMucG9zKys7XG4gICAgICAgIHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuQklERU5ULCB2YWx1ZSwgc3RhcnQpO1xuICAgICAgfVxuICAgICAgdmFsdWUgKz0gY2g7XG4gICAgICB0aGlzLnBvcysrO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgTGV4RXJyb3IoXG4gICAgICBcIlx1MzBEMFx1MzBDM1x1MzBBRlx1MzBBRlx1MzBBOVx1MzBGQ1x1MzBDOFx1OEI1OFx1NTIyNVx1NUI1MFx1MzA0Q1x1OTU4OVx1MzA1OFx1MzA4OVx1MzA4Q1x1MzA2Nlx1MzA0NFx1MzA3RVx1MzA1Qlx1MzA5M1wiLFxuICAgICAgc3RhcnQsXG4gICAgICB0aGlzLmlucHV0XG4gICAgKTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gXHU2NTcwXHU1MDI0OiBcdTY1NzRcdTY1NzAgb3IgXHU1QzBGXHU2NTcwXHVGRjA4MTIzIC8gMy4xNFx1RkYwOVxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSByZWFkTnVtYmVyKHN0YXJ0OiBudW1iZXIpOiBUb2tlbiB7XG4gICAgd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiYgaXNEaWdpdCh0aGlzLmlucHV0W3RoaXMucG9zXSkpIHtcbiAgICAgIHRoaXMucG9zKys7XG4gICAgfVxuICAgIC8vIFx1NUMwRlx1NjU3MFx1NzBCOVxuICAgIGlmIChcbiAgICAgIHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiZcbiAgICAgIHRoaXMuaW5wdXRbdGhpcy5wb3NdID09PSBcIi5cIiAmJlxuICAgICAgdGhpcy5wb3MgKyAxIDwgdGhpcy5pbnB1dC5sZW5ndGggJiZcbiAgICAgIGlzRGlnaXQodGhpcy5pbnB1dFt0aGlzLnBvcyArIDFdKVxuICAgICkge1xuICAgICAgdGhpcy5wb3MrKzsgLy8gLlxuICAgICAgd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiYgaXNEaWdpdCh0aGlzLmlucHV0W3RoaXMucG9zXSkpIHtcbiAgICAgICAgdGhpcy5wb3MrKztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRoaXMubWFrZVRva2VuKFxuICAgICAgVG9rZW5LaW5kLk5VTUJFUixcbiAgICAgIHRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQsIHRoaXMucG9zKSxcbiAgICAgIHN0YXJ0XG4gICAgKTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gXHU2RjE0XHU3Qjk3XHU1QjUwXHUzMEZCXHU4QTE4XHU1M0Y3XG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHRyeVJlYWRPcGVyYXRvcihzdGFydDogbnVtYmVyKTogVG9rZW4gfCBudWxsIHtcbiAgICBjb25zdCBjaCA9IHRoaXMuaW5wdXRbdGhpcy5wb3NdO1xuICAgIGNvbnN0IGNoMiA9IHRoaXMuaW5wdXRbdGhpcy5wb3MgKyAxXSA/PyBcIlwiO1xuXG4gICAgLy8gMlx1NjU4N1x1NUI1N1x1NkYxNFx1N0I5N1x1NUI1MFx1MzA5Mlx1NTE0OFx1MzA2Qlx1MzBDMVx1MzBBN1x1MzBDM1x1MzBBRlxuICAgIGlmIChjaCA9PT0gXCIhXCIgJiYgY2gyID09PSBcIj1cIikgeyB0aGlzLnBvcyArPSAyOyByZXR1cm4gdGhpcy5tYWtlVG9rZW4oVG9rZW5LaW5kLk5FUSwgICBcIiE9XCIsIHN0YXJ0KTsgfVxuICAgIGlmIChjaCA9PT0gXCI8XCIgJiYgY2gyID09PSBcIj5cIikgeyB0aGlzLnBvcyArPSAyOyByZXR1cm4gdGhpcy5tYWtlVG9rZW4oVG9rZW5LaW5kLkxUX0dULCBcIjw+XCIsIHN0YXJ0KTsgfVxuICAgIGlmIChjaCA9PT0gXCI+XCIgJiYgY2gyID09PSBcIj1cIikgeyB0aGlzLnBvcyArPSAyOyByZXR1cm4gdGhpcy5tYWtlVG9rZW4oVG9rZW5LaW5kLkdURSwgICBcIj49XCIsIHN0YXJ0KTsgfVxuICAgIGlmIChjaCA9PT0gXCI8XCIgJiYgY2gyID09PSBcIj1cIikgeyB0aGlzLnBvcyArPSAyOyByZXR1cm4gdGhpcy5tYWtlVG9rZW4oVG9rZW5LaW5kLkxURSwgICBcIjw9XCIsIHN0YXJ0KTsgfVxuXG4gICAgLy8gMVx1NjU4N1x1NUI1N1xuICAgIHN3aXRjaCAoY2gpIHtcbiAgICAgIGNhc2UgXCI9XCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuRVEsICAgICAgICBcIj1cIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCI+XCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuR1QsICAgICAgICBcIj5cIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCI8XCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuTFQsICAgICAgICBcIjxcIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCIqXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuU1RBUiwgICAgICBcIipcIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCIrXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuUExVUywgICAgICBcIitcIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCItXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuTUlOVVMsICAgICBcIi1cIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCIvXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuU0xBU0gsICAgICBcIi9cIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCIoXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuTFBBUkVOLCAgICBcIihcIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCIpXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuUlBBUkVOLCAgICBcIilcIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCIsXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuQ09NTUEsICAgICBcIixcIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCIuXCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuRE9ULCAgICAgICBcIi5cIiwgIHN0YXJ0KTtcbiAgICAgIGNhc2UgXCI7XCI6IHRoaXMucG9zKys7IHJldHVybiB0aGlzLm1ha2VUb2tlbihUb2tlbktpbmQuU0VNSUNPTE9OLCBcIjtcIiwgIHN0YXJ0KTtcbiAgICB9XG5cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gXHU4QjU4XHU1MjI1XHU1QjUwIC8gXHUzMEFEXHUzMEZDXHUzMEVGXHUzMEZDXHUzMEM5XG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHJlYWRJZGVudE9yS2V5d29yZChzdGFydDogbnVtYmVyKTogVG9rZW4ge1xuICAgIHdoaWxlIChcbiAgICAgIHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiZcbiAgICAgIGlzSWRlbnRDb250aW51ZSh0aGlzLmlucHV0W3RoaXMucG9zXSlcbiAgICApIHtcbiAgICAgIHRoaXMucG9zKys7XG4gICAgfVxuICAgIGNvbnN0IHJhdyA9IHRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQsIHRoaXMucG9zKTtcbiAgICBjb25zdCB1cHBlciA9IHJhdy50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IGtpbmQgPSBLRVlXT1JEUy5nZXQodXBwZXIpID8/IFRva2VuS2luZC5JREVOVDtcbiAgICAvLyBcdTMwQURcdTMwRkNcdTMwRUZcdTMwRkNcdTMwQzlcdTMwNkZcdTZCNjNcdTg5OEZcdTUzMTZcdUZGMDhcdTU5MjdcdTY1ODdcdTVCNTdcdUZGMDlcdTMwMDFcdThCNThcdTUyMjVcdTVCNTBcdTMwNkZcdTUxNDNcdTMwNkVcdTMwQzZcdTMwQURcdTMwQjlcdTMwQzhcdTMwOTJcdTMwNURcdTMwNkVcdTMwN0VcdTMwN0VcdTRGRERcdTYzMDFcbiAgICBjb25zdCB2YWx1ZSA9IGtpbmQgPT09IFRva2VuS2luZC5JREVOVCA/IHJhdyA6IHVwcGVyO1xuICAgIHJldHVybiB0aGlzLm1ha2VUb2tlbihraW5kLCB2YWx1ZSwgc3RhcnQpO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBcdTdBN0FcdTc2N0RcdTMwRkJcdTMwQjNcdTMwRTFcdTMwRjNcdTMwQzhcdTMwOTJcdTMwQjlcdTMwQURcdTMwQzNcdTMwRDdcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgc2tpcFdoaXRlc3BhY2VBbmRDb21tZW50cygpOiB2b2lkIHtcbiAgICB3aGlsZSAodGhpcy5wb3MgPCB0aGlzLmlucHV0Lmxlbmd0aCkge1xuICAgICAgY29uc3QgY2ggPSB0aGlzLmlucHV0W3RoaXMucG9zXTtcblxuICAgICAgLy8gXHU3QTdBXHU3NjdEXG4gICAgICBpZiAoY2ggPT09IFwiIFwiIHx8IGNoID09PSBcIlxcdFwiIHx8IGNoID09PSBcIlxcclwiIHx8IGNoID09PSBcIlxcblwiKSB7XG4gICAgICAgIHRoaXMucG9zKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTg4NENcdTMwQjNcdTMwRTFcdTMwRjNcdTMwQzg6IC0tXG4gICAgICBpZiAoY2ggPT09IFwiLVwiICYmIHRoaXMuaW5wdXRbdGhpcy5wb3MgKyAxXSA9PT0gXCItXCIpIHtcbiAgICAgICAgd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiYgdGhpcy5pbnB1dFt0aGlzLnBvc10gIT09IFwiXFxuXCIpIHtcbiAgICAgICAgICB0aGlzLnBvcysrO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTMwRDZcdTMwRURcdTMwQzNcdTMwQUZcdTMwQjNcdTMwRTFcdTMwRjNcdTMwQzg6IC8qIC4uLiAqL1xuICAgICAgaWYgKGNoID09PSBcIi9cIiAmJiB0aGlzLmlucHV0W3RoaXMucG9zICsgMV0gPT09IFwiKlwiKSB7XG4gICAgICAgIHRoaXMucG9zICs9IDI7XG4gICAgICAgIHdoaWxlICh0aGlzLnBvcyA8IHRoaXMuaW5wdXQubGVuZ3RoKSB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgdGhpcy5pbnB1dFt0aGlzLnBvc10gPT09IFwiKlwiICYmXG4gICAgICAgICAgICB0aGlzLmlucHV0W3RoaXMucG9zICsgMV0gPT09IFwiL1wiXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aGlzLnBvcyArPSAyO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMucG9zKys7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gXHUzMEQ4XHUzMEVCXHUzMEQxXHUzMEZDXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIG1ha2VUb2tlbihraW5kOiBUb2tlbktpbmQsIHZhbHVlOiBzdHJpbmcsIHBvczogbnVtYmVyKTogVG9rZW4ge1xuICAgIHJldHVybiB7IGtpbmQsIHZhbHVlLCBwb3MgfTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1NjU4N1x1NUI1N1x1NTIwNlx1OTg1RVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBcdThCNThcdTUyMjVcdTVCNTBcdTMwNkVcdTUxNDhcdTk4MkRcdTY1ODdcdTVCNTc6IEFTQ0lJXHU4MkYxXHU1QjU3XHUzMEZCX1x1MzBGQiRcdTMwRkJcdTY1RTVcdTY3MkNcdThBOUUgVW5pY29kZSAqL1xuZnVuY3Rpb24gaXNJZGVudFN0YXJ0KGNoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgY3AgPSBjaC5jb2RlUG9pbnRBdCgwKSE7XG4gIHJldHVybiAoXG4gICAgKGNwID49IDB4NDEgJiYgY3AgPD0gMHg1YSkgfHwgIC8vIEEtWlxuICAgIChjcCA+PSAweDYxICYmIGNwIDw9IDB4N2EpIHx8ICAvLyBhLXpcbiAgICBjcCA9PT0gMHg1ZiB8fCAgICAgICAgICAgICAgICAgIC8vIF9cbiAgICBjcCA9PT0gMHgyNCB8fCAgICAgICAgICAgICAgICAgIC8vICRcbiAgICBpc0phcGFuZXNlKGNwKVxuICApO1xufVxuXG4vKiogXHU4QjU4XHU1MjI1XHU1QjUwXHUzMDZFXHU3RDk5XHU3RDlBXHU2NTg3XHU1QjU3OiBcdTUxNDhcdTk4MkRcdTY1ODdcdTVCNTcgKyBcdTY1NzBcdTVCNTcgKi9cbmZ1bmN0aW9uIGlzSWRlbnRDb250aW51ZShjaDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGNwID0gY2guY29kZVBvaW50QXQoMCkhO1xuICByZXR1cm4gaXNJZGVudFN0YXJ0KGNoKSB8fCAoY3AgPj0gMHgzMCAmJiBjcCA8PSAweDM5KTsgLy8gMC05XG59XG5cbmZ1bmN0aW9uIGlzRGlnaXQoY2g6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBjcCA9IGNoLmNvZGVQb2ludEF0KDApITtcbiAgcmV0dXJuIGNwID49IDB4MzAgJiYgY3AgPD0gMHgzOTtcbn1cblxuLyoqXG4gKiBcdTY1RTVcdTY3MkNcdThBOUUgVW5pY29kZSBcdTdCQzRcdTU2RjJcbiAqICAgVSszMDQwLVUrMzBGRiAgXHUzMDcyXHUzMDg5XHUzMDRDXHUzMDZBXHUzMEZCXHUzMEFCXHUzMEJGXHUzMEFCXHUzMENBXG4gKiAgIFUrMzQwMC1VKzlGRkYgIENKSyBcdTdENzFcdTU0MDhcdTZGMjJcdTVCNTdcdUZGMDhcdTYyRTFcdTVGMzVcdTU0MkJcdTMwODBcdUZGMDlcbiAqICAgVStGOTAwLVUrRkFGRiAgQ0pLIFx1NEU5Mlx1NjNEQlx1NkYyMlx1NUI1N1xuICogICBVK0ZGMDEtVStGRjYwICBcdTUxNjhcdTg5RDJcdTgyRjFcdTY1NzBcdTVCNTdcdTMwRkJcdThBMThcdTUzRjdcbiAqL1xuZnVuY3Rpb24gaXNKYXBhbmVzZShjcDogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgKGNwID49IDB4MzA0MCAmJiBjcCA8PSAweDMwZmYpIHx8XG4gICAgKGNwID49IDB4MzQwMCAmJiBjcCA8PSAweDlmZmYpIHx8XG4gICAgKGNwID49IDB4ZjkwMCAmJiBjcCA8PSAweGZhZmYpIHx8XG4gICAgKGNwID49IDB4ZmYwMSAmJiBjcCA8PSAweGZmNjApXG4gICk7XG59XG4iLCAiLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBQYXJzZXJcdUZGMDhcdTY5Q0JcdTY1ODdcdTg5RTNcdTY3OTBcdTU2NjhcdUZGMDlcbi8vXG4vLyBcdTUxNjVcdTUyOUI6IFRva2VuW11cdUZGMDhMZXhlciBcdTMwNkVcdTUxRkFcdTUyOUJcdUZGMDlcbi8vIFx1NTFGQVx1NTI5QjogU3RhdGVtZW50IEFTVFxuLy9cbi8vIFx1NTE4RFx1NUUzMFx1NEUwQlx1OTY0RFx1NkNENVx1MzA2N1x1NUI5Rlx1ODhDNVx1MzAwMlxuLy8gXHU2RjE0XHU3Qjk3XHU1QjUwXHUzMDZFXHU1MTJBXHU1MTQ4XHU5ODA2XHU0RjREOlxuLy8gICBPUiA8IEFORCA8IE5PVCA8IFx1NkJENFx1OEYwM1x1NkYxNFx1N0I5N1x1NUI1MCA8IFx1NEUwMFx1NkIyMVx1NUYwRlxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmltcG9ydCB7IFRva2VuLCBUb2tlbktpbmQsIEtFWVdPUkRTIH0gZnJvbSBcIi4uL2xleGVyL3Rva2Vuc1wiO1xuaW1wb3J0IHR5cGUge1xuICBTdGF0ZW1lbnQsXG4gIFNlbGVjdFN0YXRlbWVudCxcbiAgU2VsZWN0Q29sdW1uLFxuICBXaWxkY2FyZENvbHVtbixcbiAgRmllbGRDb2x1bW4sXG4gIEFnZ3JlZ2F0ZUNvbHVtbixcbiAgQWdncmVnYXRlRnVuYyxcbiAgVGFibGVSZWYsXG4gIEpvaW5DbGF1c2UsXG4gIEpvaW5UeXBlLFxuICBKb2luQ29uZGl0aW9uLFxuICBRdWFsaWZpZWRJZGVudGlmaWVyLFxuICBXaGVyZUV4cHIsXG4gIEJpbmFyeUV4cHIsXG4gIE51bGxDaGVja0V4cHIsXG4gIExvZ2ljYWxFeHByLFxuICBOb3RFeHByLFxuICBHcm91cEV4cHIsXG4gIEZpZWxkVmFsdWUsXG4gIFNxbFZhbHVlLFxuICBTdHJpbmdMaXRlcmFsLFxuICBOdW1iZXJMaXRlcmFsLFxuICBLaW50b25lRnVuY3Rpb24sXG4gIEluTGlzdCxcbiAgQ29tcGFyZU9wLFxuICBPcmRlckJ5SXRlbSxcbiAgSW5zZXJ0U3RhdGVtZW50LFxuICBJbnNlcnRSb3csXG4gIFVwZGF0ZVN0YXRlbWVudCxcbiAgQXNzaWdubWVudCxcbiAgRGVsZXRlU3RhdGVtZW50LFxuICBBcml0aEV4cHIsXG4gIEFyaXRoT3AsXG4gIEFyaXRoT3BlcmFuZCxcbn0gZnJvbSBcIi4uL3R5cGVzL2FzdFwiO1xuXG4vLyBCRVRXRUVOIFx1NUM1NVx1OTU4Qlx1NzUyOFx1MzA2RVx1NTc4Qlx1MzBBOFx1MzBBNFx1MzBFQVx1MzBBMlx1MzBCOVx1RkYwOFx1MzBFRFx1MzBGQ1x1MzBBQlx1MzBFQlx1RkYwOVxudHlwZSBFeHBhbmRlZEJldHdlZW4gPSBMb2dpY2FsRXhwcjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBcdTMwQThcdTMwRTlcdTMwRkNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY2xhc3MgUGFyc2VFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBwdWJsaWMgcmVhZG9ubHkgdG9rZW46IFRva2VuKSB7XG4gICAgc3VwZXIoYCR7bWVzc2FnZX1cdUZGMDhcdTRGNERcdTdGNkUgJHt0b2tlbi5wb3N9XHUzMDAxXHUzMEM4XHUzMEZDXHUzMEFGXHUzMEYzOiBcdTMwMEMke3Rva2VuLnZhbHVlfVx1MzAwRFx1RkYwOWApO1xuICAgIHRoaXMubmFtZSA9IFwiUGFyc2VFcnJvclwiO1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUGFyc2VyIFx1MzBBRlx1MzBFOVx1MzBCOVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjbGFzcyBQYXJzZXIge1xuICBwcml2YXRlIHBvcyA9IDA7XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSB0b2tlbnM6IFRva2VuW10pIHt9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBcdTUxNkNcdTk1OEIgQVBJXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwYXJzZSgpOiBTdGF0ZW1lbnQge1xuICAgIGNvbnN0IHN0bXQgPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gICAgLy8gXHUzMEJCXHUzMERGXHUzMEIzXHUzMEVEXHUzMEYzXHUzMDZGXHU0RUZCXHU2MTBGXG4gICAgaWYgKHRoaXMucGVlaygpLmtpbmQgPT09IFRva2VuS2luZC5TRU1JQ09MT04pIHRoaXMuYWR2YW5jZSgpO1xuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5FT0YpO1xuICAgIHJldHVybiBzdG10O1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBTdGF0ZW1lbnQgXHUzMEM3XHUzMEEzXHUzMEI5XHUzMEQxXHUzMEMzXHUzMEMxXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHBhcnNlU3RhdGVtZW50KCk6IFN0YXRlbWVudCB7XG4gICAgY29uc3QgdG9rID0gdGhpcy5wZWVrKCk7XG4gICAgc3dpdGNoICh0b2sua2luZCkge1xuICAgICAgY2FzZSBUb2tlbktpbmQuU0VMRUNUOiByZXR1cm4gdGhpcy5wYXJzZVNlbGVjdCgpO1xuICAgICAgY2FzZSBUb2tlbktpbmQuSU5TRVJUOiByZXR1cm4gdGhpcy5wYXJzZUluc2VydCgpO1xuICAgICAgY2FzZSBUb2tlbktpbmQuVVBEQVRFOiByZXR1cm4gdGhpcy5wYXJzZVVwZGF0ZSgpO1xuICAgICAgY2FzZSBUb2tlbktpbmQuREVMRVRFOiByZXR1cm4gdGhpcy5wYXJzZURlbGV0ZSgpO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlRXJyb3IoXG4gICAgICAgICAgXCJTRUxFQ1QgLyBJTlNFUlQgLyBVUERBVEUgLyBERUxFVEUgXHUzMDZFXHUzMDQ0XHUzMDVBXHUzMDhDXHUzMDRCXHUzMDY3XHU1OUNCXHUzMDdFXHUzMDhCIFNRTCBcdTY1ODdcdTMwNENcdTVGQzVcdTg5ODFcdTMwNjdcdTMwNTlcIixcbiAgICAgICAgICB0b2tcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIFNFTEVDVFxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBwYXJzZVNlbGVjdCgpOiBTZWxlY3RTdGF0ZW1lbnQge1xuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5TRUxFQ1QpO1xuXG4gICAgY29uc3QgZGlzdGluY3QgPSB0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkRJU1RJTkNUKTtcbiAgICBjb25zdCBjb2x1bW5zID0gdGhpcy5wYXJzZVNlbGVjdENvbHVtbnMoKTtcblxuICAgIHRoaXMuZXhwZWN0S2V5d29yZChUb2tlbktpbmQuRlJPTSwgXCJcdTMwMENGUk9NXHUzMDBEXHUzMDZFXHU1RjhDXHUzMDZCXHUzMEM2XHUzMEZDXHUzMEQ2XHUzMEVCXHU1NDBEXHUzMDRDXHU1RkM1XHU4OTgxXHUzMDY3XHUzMDU5XHVGRjA4XHU0RjhCOiBGUk9NIEFQUDEwMFx1RkYwOVwiKTtcbiAgICBjb25zdCBmcm9tID0gdGhpcy5wYXJzZVRhYmxlUmVmKCk7XG5cbiAgICBjb25zdCBqb2lucyA9IHRoaXMucGFyc2VKb2lucygpO1xuXG4gICAgY29uc3Qgd2hlcmUgPSB0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLldIRVJFKSA/IHRoaXMucGFyc2VXaGVyZUV4cHIoKSA6IG51bGw7XG5cbiAgICBsZXQgZ3JvdXBCeTogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgaGF2aW5nOiBXaGVyZUV4cHIgfCBudWxsID0gbnVsbDtcbiAgICBpZiAodGhpcy5jb25zdW1lKFRva2VuS2luZC5HUk9VUCkpIHtcbiAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5CWSk7XG4gICAgICBncm91cEJ5ID0gdGhpcy5wYXJzZUlkZW50TGlzdCgpO1xuICAgICAgaWYgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuSEFWSU5HKSkge1xuICAgICAgICBoYXZpbmcgPSB0aGlzLnBhcnNlV2hlcmVFeHByKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgb3JkZXJCeSA9IHRoaXMuY29uc3VtZShUb2tlbktpbmQuT1JERVIpXG4gICAgICA/ICh0aGlzLmV4cGVjdChUb2tlbktpbmQuQlkpLCB0aGlzLnBhcnNlT3JkZXJCeSgpKVxuICAgICAgOiBbXTtcblxuICAgIGNvbnN0IGxpbWl0ID0gdGhpcy5jb25zdW1lKFRva2VuS2luZC5MSU1JVClcbiAgICAgID8gdGhpcy5wYXJzZVVuc2lnbmVkSW50KClcbiAgICAgIDogbnVsbDtcblxuICAgIGNvbnN0IG9mZnNldCA9IHRoaXMuY29uc3VtZShUb2tlbktpbmQuT0ZGU0VUKVxuICAgICAgPyB0aGlzLnBhcnNlVW5zaWduZWRJbnQoKVxuICAgICAgOiBudWxsO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHR5cGU6IFwiU0VMRUNUXCIsXG4gICAgICBkaXN0aW5jdCxcbiAgICAgIGNvbHVtbnMsXG4gICAgICBmcm9tLFxuICAgICAgam9pbnMsXG4gICAgICB3aGVyZSxcbiAgICAgIGdyb3VwQnksXG4gICAgICBoYXZpbmcsXG4gICAgICBvcmRlckJ5LFxuICAgICAgbGltaXQsXG4gICAgICBvZmZzZXQsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFNFTEVDVCBcdTUzRTVcdTMwNkVcdTMwQUJcdTMwRTlcdTMwRTBcdTMwRUFcdTMwQjlcdTMwQzhcbiAgcHJpdmF0ZSBwYXJzZVNlbGVjdENvbHVtbnMoKTogU2VsZWN0Q29sdW1uW10ge1xuICAgIGNvbnN0IGNvbHM6IFNlbGVjdENvbHVtbltdID0gW107XG4gICAgZG8ge1xuICAgICAgY29scy5wdXNoKHRoaXMucGFyc2VTZWxlY3RDb2x1bW4oKSk7XG4gICAgfSB3aGlsZSAodGhpcy5jb25zdW1lKFRva2VuS2luZC5DT01NQSkpO1xuICAgIHJldHVybiBjb2xzO1xuICB9XG5cbiAgcHJpdmF0ZSBwYXJzZVNlbGVjdENvbHVtbigpOiBTZWxlY3RDb2x1bW4ge1xuICAgIC8vICpcbiAgICBpZiAodGhpcy5jb25zdW1lKFRva2VuS2luZC5TVEFSKSkge1xuICAgICAgcmV0dXJuIHsgdHlwZTogXCJXSUxEQ0FSRFwiIH07XG4gICAgfVxuXG4gICAgLy8gXHU5NkM2XHU4QTA4XHU5NUEyXHU2NTcwOiBDT1VOVCAvIFNVTSAvIEFWRyAvIE1BWCAvIE1JTlxuICAgIGNvbnN0IGFnZ0Z1bmMgPSB0aGlzLnRyeUFnZ3JlZ2F0ZUZ1bmMoKTtcbiAgICBpZiAoYWdnRnVuYyAhPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VBZ2dyZWdhdGVDb2x1bW4oYWdnRnVuYyk7XG4gICAgfVxuXG4gICAgLy8gXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5IFtBUyBhbGlhc11cbiAgICAvLyBhbGlhcy5maWVsZCBcdTVGNjJcdTVGMEZcdUZGMDhKT0lOIFx1MzA2RVx1NEZFRVx1OThGRVx1OEI1OFx1NTIyNVx1NUI1MFx1RkYwOVx1MzA4Mlx1NTFFNlx1NzQwNlx1MzA1OVx1MzA4QlxuICAgIGNvbnN0IGZpcnN0ID0gdGhpcy5wYXJzZUlkZW50aWZpZXIoKTtcbiAgICBsZXQgZmllbGQ6IHN0cmluZztcbiAgICBpZiAodGhpcy5wZWVrKCkua2luZCA9PT0gVG9rZW5LaW5kLkRPVCkge1xuICAgICAgdGhpcy5hZHZhbmNlKCk7IC8vIC4gXHUzMDkyXHU2RDg4XHU4Q0JCXG4gICAgICBjb25zdCBmaWVsZE5hbWUgPSB0aGlzLnBhcnNlSWRlbnRpZmllcigpO1xuICAgICAgZmllbGQgPSBgJHtmaXJzdH0uJHtmaWVsZE5hbWV9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgZmllbGQgPSBmaXJzdDtcbiAgICB9XG4gICAgY29uc3QgYWxpYXMgPSB0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkFTKSA/IHRoaXMucGFyc2VBbGlhc05hbWUoKSA6IG51bGw7XG4gICAgcmV0dXJuIHsgdHlwZTogXCJGSUVMRFwiLCBmaWVsZCwgYWxpYXMgfTtcbiAgfVxuXG4gIHByaXZhdGUgdHJ5QWdncmVnYXRlRnVuYygpOiBBZ2dyZWdhdGVGdW5jIHwgbnVsbCB7XG4gICAgY29uc3QgbWFwOiBQYXJ0aWFsPFJlY29yZDxUb2tlbktpbmQsIEFnZ3JlZ2F0ZUZ1bmM+PiA9IHtcbiAgICAgIFtUb2tlbktpbmQuQ09VTlRdOiBcIkNPVU5UXCIsXG4gICAgICBbVG9rZW5LaW5kLlNVTV06ICAgXCJTVU1cIixcbiAgICAgIFtUb2tlbktpbmQuQVZHXTogICBcIkFWR1wiLFxuICAgICAgW1Rva2VuS2luZC5NQVhdOiAgIFwiTUFYXCIsXG4gICAgICBbVG9rZW5LaW5kLk1JTl06ICAgXCJNSU5cIixcbiAgICB9O1xuICAgIGNvbnN0IGtpbmQgPSB0aGlzLnBlZWsoKS5raW5kO1xuICAgIHJldHVybiBtYXBba2luZF0gPz8gbnVsbDtcbiAgfVxuXG4gIHByaXZhdGUgcGFyc2VBZ2dyZWdhdGVDb2x1bW4oZnVuYzogQWdncmVnYXRlRnVuYyk6IEFnZ3JlZ2F0ZUNvbHVtbiB7XG4gICAgdGhpcy5hZHZhbmNlKCk7IC8vIFx1OTVBMlx1NjU3MFx1NTQwRFx1MzBDOFx1MzBGQ1x1MzBBRlx1MzBGM1x1MzA5Mlx1NkQ4OFx1OENCQlxuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5MUEFSRU4pO1xuXG4gICAgY29uc3QgZGlzdGluY3QgPSB0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkRJU1RJTkNUKTtcblxuICAgIGxldCBhcmc6IEFnZ3JlZ2F0ZUNvbHVtbltcImFyZ1wiXTtcbiAgICBpZiAodGhpcy5jb25zdW1lKFRva2VuS2luZC5TVEFSKSkge1xuICAgICAgYXJnID0geyB0eXBlOiBcIldJTERDQVJEXCIgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgYXJnID0gdGhpcy5wYXJzZUlkZW50aWZpZXIoKTtcbiAgICB9XG5cbiAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuUlBBUkVOKTtcbiAgICBjb25zdCBhbGlhcyA9IHRoaXMuY29uc3VtZShUb2tlbktpbmQuQVMpID8gdGhpcy5wYXJzZUFsaWFzTmFtZSgpIDogbnVsbDtcblxuICAgIHJldHVybiB7IHR5cGU6IFwiQUdHUkVHQVRFXCIsIGZ1bmMsIGRpc3RpbmN0LCBhcmcsIGFsaWFzIH07XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIEZST00gLyBKT0lOXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHBhcnNlVGFibGVSZWYoKTogVGFibGVSZWYge1xuICAgIGNvbnN0IG5hbWUgPSB0aGlzLnBhcnNlSWRlbnRpZmllcigpO1xuICAgIGNvbnN0IGFwcElkID0gZXh0cmFjdEFwcElkKG5hbWUsIHRoaXMucHJldigpKTtcbiAgICBjb25zdCBhbGlhcyA9IHRoaXMuY29uc3VtZShUb2tlbktpbmQuQVMpID8gdGhpcy5wYXJzZUlkZW50aWZpZXIoKSA6IG51bGw7XG4gICAgcmV0dXJuIHsgYXBwSWQsIGFsaWFzIH07XG4gIH1cblxuICBwcml2YXRlIHBhcnNlSm9pbnMoKTogSm9pbkNsYXVzZVtdIHtcbiAgICBjb25zdCBqb2luczogSm9pbkNsYXVzZVtdID0gW107XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGNvbnN0IGpvaW5UeXBlID0gdGhpcy50cnlKb2luVHlwZSgpO1xuICAgICAgaWYgKGpvaW5UeXBlID09PSBudWxsKSBicmVhaztcblxuICAgICAgY29uc3QgdGFibGUgPSB0aGlzLnBhcnNlVGFibGVSZWYoKTtcbiAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5PTik7XG4gICAgICBjb25zdCBvbiA9IHRoaXMucGFyc2VKb2luQ29uZGl0aW9uKCk7XG4gICAgICBqb2lucy5wdXNoKHsgdHlwZTogam9pblR5cGUsIHRhYmxlLCBvbiB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGpvaW5zO1xuICB9XG5cbiAgcHJpdmF0ZSB0cnlKb2luVHlwZSgpOiBKb2luVHlwZSB8IG51bGwge1xuICAgIGlmICh0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLklOTkVSKSkge1xuICAgICAgdGhpcy5leHBlY3QoVG9rZW5LaW5kLkpPSU4pO1xuICAgICAgcmV0dXJuIFwiSU5ORVJcIjtcbiAgICB9XG4gICAgaWYgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuTEVGVCkpIHtcbiAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5KT0lOKTtcbiAgICAgIHJldHVybiBcIkxFRlRcIjtcbiAgICB9XG4gICAgaWYgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuSk9JTikpIHtcbiAgICAgIHJldHVybiBcIklOTkVSXCI7IC8vIEpPSU4gXHU1MzU4XHU0RjUzXHUzMDZGIElOTkVSIFx1NjI3MVx1MzA0NFxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIE9OIGEuZmllbGQgPSBiLmZpZWxkXG4gIHByaXZhdGUgcGFyc2VKb2luQ29uZGl0aW9uKCk6IEpvaW5Db25kaXRpb24ge1xuICAgIGNvbnN0IGxlZnQgPSB0aGlzLnBhcnNlUXVhbGlmaWVkSWRlbnQoKTtcbiAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuRVEpO1xuICAgIGNvbnN0IHJpZ2h0ID0gdGhpcy5wYXJzZVF1YWxpZmllZElkZW50KCk7XG4gICAgcmV0dXJuIHsgbGVmdCwgcmlnaHQgfTtcbiAgfVxuXG4gIC8vIGFsaWFzLmZpZWxkIFx1MzA3RVx1MzA1Rlx1MzA2RiBmaWVsZFxuICBwcml2YXRlIHBhcnNlUXVhbGlmaWVkSWRlbnQoKTogUXVhbGlmaWVkSWRlbnRpZmllciB7XG4gICAgY29uc3QgZmlyc3QgPSB0aGlzLnBhcnNlSWRlbnRpZmllcigpO1xuICAgIGlmICh0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkRPVCkpIHtcbiAgICAgIGNvbnN0IGZpZWxkID0gdGhpcy5wYXJzZUlkZW50aWZpZXIoKTtcbiAgICAgIHJldHVybiB7IHRhYmxlQWxpYXM6IGZpcnN0LCBmaWVsZCB9O1xuICAgIH1cbiAgICByZXR1cm4geyB0YWJsZUFsaWFzOiBudWxsLCBmaWVsZDogZmlyc3QgfTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gV0hFUkUgXHU1RjBGXHVGRjA4XHU1MThEXHU1RTMwXHU0RTBCXHU5NjREXHUzMEZCXHU1MTJBXHU1MTQ4XHU5ODA2XHU0RjREXHU0RUQ4XHUzMDREXHVGRjA5XG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHBhcnNlV2hlcmVFeHByKCk6IFdoZXJlRXhwciB7XG4gICAgcmV0dXJuIHRoaXMucGFyc2VPckV4cHIoKTtcbiAgfVxuXG4gIC8vIE9SXHVGRjA4XHU2NzAwXHU0RjRFXHU1MTJBXHU1MTQ4XHU1RUE2XHVGRjA5XG4gIHByaXZhdGUgcGFyc2VPckV4cHIoKTogV2hlcmVFeHByIHtcbiAgICBsZXQgbGVmdCA9IHRoaXMucGFyc2VBbmRFeHByKCk7XG4gICAgd2hpbGUgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuT1IpKSB7XG4gICAgICBjb25zdCByaWdodCA9IHRoaXMucGFyc2VBbmRFeHByKCk7XG4gICAgICBsZWZ0ID0geyB0eXBlOiBcIkxPR0lDQUxcIiwgb3A6IFwiT1JcIiwgbGVmdCwgcmlnaHQgfSBzYXRpc2ZpZXMgTG9naWNhbEV4cHI7XG4gICAgfVxuICAgIHJldHVybiBsZWZ0O1xuICB9XG5cbiAgLy8gQU5EXG4gIHByaXZhdGUgcGFyc2VBbmRFeHByKCk6IFdoZXJlRXhwciB7XG4gICAgbGV0IGxlZnQgPSB0aGlzLnBhcnNlTm90RXhwcigpO1xuICAgIHdoaWxlICh0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkFORCkpIHtcbiAgICAgIGNvbnN0IHJpZ2h0ID0gdGhpcy5wYXJzZU5vdEV4cHIoKTtcbiAgICAgIGxlZnQgPSB7IHR5cGU6IFwiTE9HSUNBTFwiLCBvcDogXCJBTkRcIiwgbGVmdCwgcmlnaHQgfSBzYXRpc2ZpZXMgTG9naWNhbEV4cHI7XG4gICAgfVxuICAgIHJldHVybiBsZWZ0O1xuICB9XG5cbiAgLy8gTk9UXG4gIHByaXZhdGUgcGFyc2VOb3RFeHByKCk6IFdoZXJlRXhwciB7XG4gICAgaWYgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuTk9UKSkge1xuICAgICAgY29uc3QgZXhwciA9IHRoaXMucGFyc2VOb3RFeHByKCk7XG4gICAgICByZXR1cm4geyB0eXBlOiBcIk5PVFwiLCBleHByIH0gc2F0aXNmaWVzIE5vdEV4cHI7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnBhcnNlQ29tcGFyZUV4cHIoKTtcbiAgfVxuXG4gIC8vIFx1NkJENFx1OEYwM1x1NkYxNFx1N0I5N1x1NUI1MDogPSwgIT0sIDw+LCA+LCA8LCA+PSwgPD0sIExJS0UsIElOLCBJUyBOVUxMXG4gIHByaXZhdGUgcGFyc2VDb21wYXJlRXhwcigpOiBXaGVyZUV4cHIge1xuICAgIC8vICggZXhwciApIFx1MzBCMFx1MzBFQlx1MzBGQ1x1MzBEN1xuICAgIGlmICh0aGlzLnBlZWsoKS5raW5kID09PSBUb2tlbktpbmQuTFBBUkVOKSB7XG4gICAgICB0aGlzLmFkdmFuY2UoKTtcbiAgICAgIGNvbnN0IGV4cHIgPSB0aGlzLnBhcnNlV2hlcmVFeHByKCk7XG4gICAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuUlBBUkVOKTtcbiAgICAgIHJldHVybiB7IHR5cGU6IFwiR1JPVVBcIiwgZXhwciB9IHNhdGlzZmllcyBHcm91cEV4cHI7XG4gICAgfVxuXG4gICAgY29uc3QgZmllbGQgPSB0aGlzLnBhcnNlRmllbGRWYWx1ZSgpO1xuXG4gICAgLy8gSVMgTlVMTCAvIElTIE5PVCBOVUxMXG4gICAgaWYgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuSVMpKSB7XG4gICAgICBjb25zdCBub3QgPSB0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLk5PVCk7XG4gICAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuTlVMTCk7XG4gICAgICByZXR1cm4geyB0eXBlOiBcIk5VTExfQ0hFQ0tcIiwgZmllbGQsIG5vdCB9IHNhdGlzZmllcyBOdWxsQ2hlY2tFeHByO1xuICAgIH1cblxuICAgIC8vIEJFVFdFRU4gbG93IEFORCBoaWdoIFx1MjE5MiBmaWVsZCA+PSBsb3cgQU5EIGZpZWxkIDw9IGhpZ2ggXHUzMDZCXHU1QzU1XHU5NThCXG4gICAgaWYgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuQkVUV0VFTikpIHtcbiAgICAgIGNvbnN0IGxvdyAgPSB0aGlzLnBhcnNlU3FsVmFsdWUoKTtcbiAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5BTkQpO1xuICAgICAgY29uc3QgaGlnaCA9IHRoaXMucGFyc2VTcWxWYWx1ZSgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJMT0dJQ0FMXCIsXG4gICAgICAgIG9wOiBcIkFORFwiLFxuICAgICAgICBsZWZ0OiAgeyB0eXBlOiBcIkJJTkFSWVwiLCBvcDogXCI+PVwiLCBsZWZ0OiBmaWVsZCwgcmlnaHQ6IGxvdyAgfSxcbiAgICAgICAgcmlnaHQ6IHsgdHlwZTogXCJCSU5BUllcIiwgb3A6IFwiPD1cIiwgbGVmdDogZmllbGQsIHJpZ2h0OiBoaWdoIH0sXG4gICAgICB9IHNhdGlzZmllcyBFeHBhbmRlZEJldHdlZW47XG4gICAgfVxuXG4gICAgLy8gTk9UIElOIC8gTk9UIExJS0VcbiAgICBpZiAodGhpcy5jb25zdW1lKFRva2VuS2luZC5OT1QpKSB7XG4gICAgICBpZiAodGhpcy5jb25zdW1lKFRva2VuS2luZC5JTikpIHtcbiAgICAgICAgdGhpcy5leHBlY3QoVG9rZW5LaW5kLkxQQVJFTik7XG4gICAgICAgIGNvbnN0IHZhbHVlcyA9IHRoaXMucGFyc2VJblZhbHVlcygpO1xuICAgICAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuUlBBUkVOKTtcbiAgICAgICAgcmV0dXJuIHsgdHlwZTogXCJCSU5BUllcIiwgb3A6IFwiTk9UX0lOXCIsIGxlZnQ6IGZpZWxkLCByaWdodDogeyB0eXBlOiBcIklOX0xJU1RcIiwgdmFsdWVzIH0gfSBzYXRpc2ZpZXMgQmluYXJ5RXhwcjtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkxJS0UpKSB7XG4gICAgICAgIGNvbnN0IHBhdHRlcm4gPSB0aGlzLnBhcnNlU3FsVmFsdWUoKTtcbiAgICAgICAgcmV0dXJuIHsgdHlwZTogXCJCSU5BUllcIiwgb3A6IFwiTk9UX0xJS0VcIiwgbGVmdDogZmllbGQsIHJpZ2h0OiBwYXR0ZXJuIH0gc2F0aXNmaWVzIEJpbmFyeUV4cHI7XG4gICAgICB9XG4gICAgICB0aHJvdyBuZXcgUGFyc2VFcnJvcihcbiAgICAgICAgXCJOT1QgXHUzMDZFXHU1RjhDXHUzMDZCXHUzMDZGIElOIFx1MzA3RVx1MzA1Rlx1MzA2RiBMSUtFIFx1MzA0Q1x1NUZDNVx1ODk4MVx1MzA2N1x1MzA1OVwiLFxuICAgICAgICB0aGlzLnBlZWsoKVxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBJTiAoLi4uKVxuICAgIGlmICh0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLklOKSkge1xuICAgICAgdGhpcy5leHBlY3QoVG9rZW5LaW5kLkxQQVJFTik7XG4gICAgICBjb25zdCB2YWx1ZXMgPSB0aGlzLnBhcnNlSW5WYWx1ZXMoKTtcbiAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5SUEFSRU4pO1xuICAgICAgY29uc3QgcmlnaHQ6IEluTGlzdCA9IHsgdHlwZTogXCJJTl9MSVNUXCIsIHZhbHVlcyB9O1xuICAgICAgcmV0dXJuIHsgdHlwZTogXCJCSU5BUllcIiwgb3A6IFwiSU5cIiwgbGVmdDogZmllbGQsIHJpZ2h0IH0gc2F0aXNmaWVzIEJpbmFyeUV4cHI7XG4gICAgfVxuXG4gICAgLy8gXHU2QkQ0XHU4RjAzXHU2RjE0XHU3Qjk3XHU1QjUwXG4gICAgY29uc3Qgb3AgPSB0aGlzLnBhcnNlQ29tcGFyZU9wKCk7XG4gICAgY29uc3QgcmlnaHQgPSB0aGlzLnBhcnNlU3FsVmFsdWUoKTtcbiAgICByZXR1cm4geyB0eXBlOiBcIkJJTkFSWVwiLCBvcCwgbGVmdDogZmllbGQsIHJpZ2h0IH0gc2F0aXNmaWVzIEJpbmFyeUV4cHI7XG4gIH1cblxuICBwcml2YXRlIHBhcnNlQ29tcGFyZU9wKCk6IENvbXBhcmVPcCB7XG4gICAgY29uc3QgdG9rID0gdGhpcy5hZHZhbmNlKCk7XG4gICAgc3dpdGNoICh0b2sua2luZCkge1xuICAgICAgY2FzZSBUb2tlbktpbmQuRVE6ICAgIHJldHVybiBcIj1cIjtcbiAgICAgIGNhc2UgVG9rZW5LaW5kLk5FUTogICByZXR1cm4gXCIhPVwiO1xuICAgICAgY2FzZSBUb2tlbktpbmQuTFRfR1Q6IHJldHVybiBcIjw+XCI7XG4gICAgICBjYXNlIFRva2VuS2luZC5HVDogICAgcmV0dXJuIFwiPlwiO1xuICAgICAgY2FzZSBUb2tlbktpbmQuTFQ6ICAgIHJldHVybiBcIjxcIjtcbiAgICAgIGNhc2UgVG9rZW5LaW5kLkdURTogICByZXR1cm4gXCI+PVwiO1xuICAgICAgY2FzZSBUb2tlbktpbmQuTFRFOiAgIHJldHVybiBcIjw9XCI7XG4gICAgICBjYXNlIFRva2VuS2luZC5MSUtFOiAgcmV0dXJuIFwiTElLRVwiO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlRXJyb3IoXG4gICAgICAgICAgXCJcdTZCRDRcdThGMDNcdTZGMTRcdTdCOTdcdTVCNTBcdUZGMDg9LCAhPSwgPiwgPCwgPj0sIDw9LCBMSUtFLCBJTiwgSVNcdUZGMDlcdTMwNENcdTVGQzVcdTg5ODFcdTMwNjdcdTMwNTlcIixcbiAgICAgICAgICB0b2tcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTUzQzJcdTcxNjc6IFthbGlhcy5dZmllbGRcbiAgLy8gSEFWSU5HIFx1NTNFNVx1MzA2N1x1MzA2RiBDT1VOVCgqKSAvIFNVTShmKSBcdTdCNDlcdTMwNkVcdTk2QzZcdThBMDhcdTk1QTJcdTY1NzBcdTMwODJcdTVERTZcdThGQkFcdTMwNkJcdTRGN0ZcdTMwNDhcdTMwOEJcdTMwMDJcbiAgLy8gXHU5NkM2XHU4QTA4XHU5NUEyXHU2NTcwXHUzMDZGIFwiQ09VTlQoKilcIiBcdTMwNkVcdTMwODhcdTMwNDZcdTMwNkFcdTU0MDhcdTYyMTBcdTU0MERcdTMwNjhcdTMwNTdcdTMwNjYgRmllbGRWYWx1ZSBcdTMwNkJcdTY4M0NcdTdEMERcdTMwNTlcdTMwOEJcdUZGMDhKUyBcdTUwNzRcdTMwNjdcdThBNTVcdTRGQTFcdUZGMDlcdTMwMDJcbiAgcHJpdmF0ZSBwYXJzZUZpZWxkVmFsdWUoKTogRmllbGRWYWx1ZSB7XG4gICAgY29uc3QgYWdnRnVuYyA9IHRoaXMudHJ5QWdncmVnYXRlRnVuYygpO1xuICAgIGlmIChhZ2dGdW5jICE9PSBudWxsKSB7XG4gICAgICB0aGlzLmFkdmFuY2UoKTsgLy8gXHU5NUEyXHU2NTcwXHU1NDBEXHUzMEM4XHUzMEZDXHUzMEFGXHUzMEYzXHUzMDkyXHU2RDg4XHU4Q0JCXG4gICAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuTFBBUkVOKTtcbiAgICAgIGNvbnN0IGRpc3RpbmN0ID0gdGhpcy5jb25zdW1lKFRva2VuS2luZC5ESVNUSU5DVCk7XG4gICAgICBsZXQgYXJnU3RyOiBzdHJpbmc7XG4gICAgICBpZiAodGhpcy5jb25zdW1lKFRva2VuS2luZC5TVEFSKSkge1xuICAgICAgICBhcmdTdHIgPSBcIipcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFyZ1N0ciA9IHRoaXMucGFyc2VJZGVudGlmaWVyKCk7XG4gICAgICB9XG4gICAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuUlBBUkVOKTtcbiAgICAgIC8vIFwiQ09VTlQoKilcIiAvIFwiU1VNKFx1OTFEMVx1OTg0RClcIiAvIFwiQ09VTlQoRElTVElOQ1QgXHU3QTJFXHU1MjI1KVwiIFx1MzA2RVx1MzA4OFx1MzA0Nlx1MzA2QVx1NTQwOFx1NjIxMFx1NTQwRFxuICAgICAgY29uc3Qgc3ludGhldGljTmFtZSA9IGRpc3RpbmN0XG4gICAgICAgID8gYCR7YWdnRnVuY30oRElTVElOQ1QgJHthcmdTdHJ9KWBcbiAgICAgICAgOiBgJHthZ2dGdW5jfSgke2FyZ1N0cn0pYDtcbiAgICAgIHJldHVybiB7IHR5cGU6IFwiRklFTERcIiwgdGFibGVBbGlhczogbnVsbCwgZmllbGQ6IHN5bnRoZXRpY05hbWUgfTtcbiAgICB9XG5cbiAgICBjb25zdCBxaSA9IHRoaXMucGFyc2VRdWFsaWZpZWRJZGVudCgpO1xuICAgIHJldHVybiB7IHR5cGU6IFwiRklFTERcIiwgdGFibGVBbGlhczogcWkudGFibGVBbGlhcywgZmllbGQ6IHFpLmZpZWxkIH07XG4gIH1cblxuICAvLyBcdTUzRjNcdThGQkFcdTMwNkVcdTUwMjRcbiAgcHJpdmF0ZSBwYXJzZVNxbFZhbHVlKCk6IFNxbFZhbHVlIHtcbiAgICBjb25zdCB0b2sgPSB0aGlzLnBlZWsoKTtcbiAgICBzd2l0Y2ggKHRvay5raW5kKSB7XG4gICAgICBjYXNlIFRva2VuS2luZC5TVFJJTkc6IHtcbiAgICAgICAgdGhpcy5hZHZhbmNlKCk7XG4gICAgICAgIHJldHVybiB7IHR5cGU6IFwiU1RSSU5HXCIsIHZhbHVlOiB0b2sudmFsdWUgfSBzYXRpc2ZpZXMgU3RyaW5nTGl0ZXJhbDtcbiAgICAgIH1cbiAgICAgIGNhc2UgVG9rZW5LaW5kLk5VTUJFUjoge1xuICAgICAgICB0aGlzLmFkdmFuY2UoKTtcbiAgICAgICAgcmV0dXJuIHsgdHlwZTogXCJOVU1CRVJcIiwgdmFsdWU6IE51bWJlcih0b2sudmFsdWUpIH0gc2F0aXNmaWVzIE51bWJlckxpdGVyYWw7XG4gICAgICB9XG4gICAgICBjYXNlIFRva2VuS2luZC5UT0RBWTpcbiAgICAgIGNhc2UgVG9rZW5LaW5kLk5PVzpcbiAgICAgIGNhc2UgVG9rZW5LaW5kLkxPR0lOVVNFUjoge1xuICAgICAgICB0aGlzLmFkdmFuY2UoKTtcbiAgICAgICAgdGhpcy5leHBlY3QoVG9rZW5LaW5kLkxQQVJFTik7XG4gICAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5SUEFSRU4pO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwiS0lOVE9ORV9GVU5DXCIsXG4gICAgICAgICAgbmFtZTogdG9rLnZhbHVlIGFzIEtpbnRvbmVGdW5jdGlvbltcIm5hbWVcIl0sXG4gICAgICAgIH0gc2F0aXNmaWVzIEtpbnRvbmVGdW5jdGlvbjtcbiAgICAgIH1cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZUVycm9yKFxuICAgICAgICAgIFwiXHU1MDI0XHVGRjA4XHU2NTg3XHU1QjU3XHU1MjE3XHUzMEZCXHU2NTcwXHU1MDI0XHUzMEZCVE9EQVkoKVx1MzBGQk5PVygpXHUzMEZCTE9HSU5VU0VSKClcdUZGMDlcdTMwNENcdTVGQzVcdTg5ODFcdTMwNjdcdTMwNTlcIixcbiAgICAgICAgICB0b2tcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBJTiBcdTMwRUFcdTMwQjlcdTMwQzhcdTMwNkVcdTUwMjRcbiAgcHJpdmF0ZSBwYXJzZUluVmFsdWVzKCk6IEluTGlzdFtcInZhbHVlc1wiXSB7XG4gICAgY29uc3QgdmFsdWVzOiBJbkxpc3RbXCJ2YWx1ZXNcIl0gPSBbXTtcbiAgICBkbyB7XG4gICAgICBjb25zdCB0b2sgPSB0aGlzLmFkdmFuY2UoKTtcbiAgICAgIGlmICh0b2sua2luZCA9PT0gVG9rZW5LaW5kLlNUUklORykge1xuICAgICAgICB2YWx1ZXMucHVzaCh7IHR5cGU6IFwiU1RSSU5HXCIsIHZhbHVlOiB0b2sudmFsdWUgfSk7XG4gICAgICB9IGVsc2UgaWYgKHRvay5raW5kID09PSBUb2tlbktpbmQuTlVNQkVSKSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKHsgdHlwZTogXCJOVU1CRVJcIiwgdmFsdWU6IE51bWJlcih0b2sudmFsdWUpIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlRXJyb3IoXCJJTiBcdTMwRUFcdTMwQjlcdTMwQzhcdTMwNkJcdTMwNkZcdTY1ODdcdTVCNTdcdTUyMTdcdTMwN0VcdTMwNUZcdTMwNkZcdTY1NzBcdTUwMjRcdTMwNENcdTVGQzVcdTg5ODFcdTMwNjdcdTMwNTlcIiwgdG9rKTtcbiAgICAgIH1cbiAgICB9IHdoaWxlICh0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkNPTU1BKSk7XG4gICAgcmV0dXJuIHZhbHVlcztcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gR1JPVVAgQlkgLyBPUkRFUiBCWVxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBwYXJzZUlkZW50TGlzdCgpOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgaWRlbnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGRvIHtcbiAgICAgIGlkZW50cy5wdXNoKHRoaXMucGFyc2VJZGVudGlmaWVyKCkpO1xuICAgIH0gd2hpbGUgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuQ09NTUEpKTtcbiAgICByZXR1cm4gaWRlbnRzO1xuICB9XG5cbiAgcHJpdmF0ZSBwYXJzZU9yZGVyQnkoKTogT3JkZXJCeUl0ZW1bXSB7XG4gICAgY29uc3QgaXRlbXM6IE9yZGVyQnlJdGVtW10gPSBbXTtcbiAgICBkbyB7XG4gICAgICBjb25zdCBmaWVsZCA9IHRoaXMucGFyc2VJZGVudGlmaWVyKCk7XG4gICAgICBsZXQgZGlyZWN0aW9uOiBcIkFTQ1wiIHwgXCJERVNDXCIgPSBcIkFTQ1wiO1xuICAgICAgaWYgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuREVTQykpICAgICAgIGRpcmVjdGlvbiA9IFwiREVTQ1wiO1xuICAgICAgZWxzZSB0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkFTQyk7ICAgICAgIC8vIEFTQyBcdTMwNkZcdTc3MDFcdTc1NjVcdTUzRUZcbiAgICAgIGl0ZW1zLnB1c2goeyBmaWVsZCwgZGlyZWN0aW9uIH0pO1xuICAgIH0gd2hpbGUgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuQ09NTUEpKTtcbiAgICByZXR1cm4gaXRlbXM7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIElOU0VSVFxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBwYXJzZUluc2VydCgpOiBJbnNlcnRTdGF0ZW1lbnQge1xuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5JTlNFUlQpO1xuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5JTlRPKTtcblxuICAgIGNvbnN0IG5hbWUgPSB0aGlzLnBhcnNlSWRlbnRpZmllcigpO1xuICAgIGNvbnN0IGFwcElkID0gZXh0cmFjdEFwcElkKG5hbWUsIHRoaXMucHJldigpKTtcblxuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5MUEFSRU4pO1xuICAgIGNvbnN0IGZpZWxkcyA9IHRoaXMucGFyc2VJZGVudExpc3QoKTtcbiAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuUlBBUkVOKTtcblxuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5WQUxVRVMpO1xuXG4gICAgY29uc3QgdmFsdWVzOiBJbnNlcnRSb3dbXSA9IFtdO1xuICAgIGRvIHtcbiAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5MUEFSRU4pO1xuICAgICAgY29uc3Qgcm93ID0gdGhpcy5wYXJzZUluc2VydFJvdyhmaWVsZHMubGVuZ3RoKTtcbiAgICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5SUEFSRU4pO1xuICAgICAgdmFsdWVzLnB1c2gocm93KTtcbiAgICB9IHdoaWxlICh0aGlzLmNvbnN1bWUoVG9rZW5LaW5kLkNPTU1BKSk7XG5cbiAgICByZXR1cm4geyB0eXBlOiBcIklOU0VSVFwiLCBhcHBJZCwgZmllbGRzLCB2YWx1ZXMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcGFyc2VJbnNlcnRSb3coZXhwZWN0ZWRMZW46IG51bWJlcik6IEluc2VydFJvdyB7XG4gICAgY29uc3Qgcm93OiBJbnNlcnRSb3cgPSBbXTtcbiAgICBkbyB7XG4gICAgICBjb25zdCB0b2sgPSB0aGlzLmFkdmFuY2UoKTtcbiAgICAgIGlmICh0b2sua2luZCA9PT0gVG9rZW5LaW5kLlNUUklORykge1xuICAgICAgICByb3cucHVzaCh7IHR5cGU6IFwiU1RSSU5HXCIsIHZhbHVlOiB0b2sudmFsdWUgfSk7XG4gICAgICB9IGVsc2UgaWYgKHRvay5raW5kID09PSBUb2tlbktpbmQuTlVNQkVSKSB7XG4gICAgICAgIHJvdy5wdXNoKHsgdHlwZTogXCJOVU1CRVJcIiwgdmFsdWU6IE51bWJlcih0b2sudmFsdWUpIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlRXJyb3IoXCJJTlNFUlQgXHUzMDZFXHU1MDI0XHUzMDZCXHUzMDZGXHU2NTg3XHU1QjU3XHU1MjE3XHUzMDdFXHUzMDVGXHUzMDZGXHU2NTcwXHU1MDI0XHUzMDRDXHU1RkM1XHU4OTgxXHUzMDY3XHUzMDU5XCIsIHRvayk7XG4gICAgICB9XG4gICAgfSB3aGlsZSAodGhpcy5jb25zdW1lKFRva2VuS2luZC5DT01NQSkpO1xuXG4gICAgaWYgKHJvdy5sZW5ndGggIT09IGV4cGVjdGVkTGVuKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2VFcnJvcihcbiAgICAgICAgYFx1MzBBQlx1MzBFOVx1MzBFMFx1NjU3MFx1RkYwOCR7ZXhwZWN0ZWRMZW59XHVGRjA5XHUzMDY4XHU1MDI0XHUzMDZFXHU2NTcwXHVGRjA4JHtyb3cubGVuZ3RofVx1RkYwOVx1MzA0Q1x1NEUwMFx1ODFGNFx1MzA1N1x1MzA3RVx1MzA1Qlx1MzA5M2AsXG4gICAgICAgIHRoaXMucHJldigpXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gcm93O1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBVUERBVEVcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgcGFyc2VVcGRhdGUoKTogVXBkYXRlU3RhdGVtZW50IHtcbiAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuVVBEQVRFKTtcblxuICAgIGNvbnN0IG5hbWUgPSB0aGlzLnBhcnNlSWRlbnRpZmllcigpO1xuICAgIGNvbnN0IGFwcElkID0gZXh0cmFjdEFwcElkKG5hbWUsIHRoaXMucHJldigpKTtcblxuICAgIHRoaXMuZXhwZWN0KFRva2VuS2luZC5TRVQpO1xuICAgIGNvbnN0IGFzc2lnbm1lbnRzID0gdGhpcy5wYXJzZUFzc2lnbm1lbnRzKCk7XG5cbiAgICBjb25zdCB3aGVyZVRvayA9IHRoaXMucGVlaygpO1xuICAgIGlmICghdGhpcy5jb25zdW1lKFRva2VuS2luZC5XSEVSRSkpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZUVycm9yKFxuICAgICAgICBcIlVQREFURSBcdTY1ODdcdTMwNkJcdTMwNkYgV0hFUkUgXHU1M0U1XHUzMDRDXHU1RkM1XHU4OTgxXHUzMDY3XHUzMDU5XHVGRjA4XHU1MTY4XHU0RUY2XHU2NkY0XHU2NUIwXHUzMDkyXHU5NjMyXHUzMDUwXHUzMDVGXHUzMDgxXHVGRjA5XCIsXG4gICAgICAgIHdoZXJlVG9rXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCB3aGVyZSA9IHRoaXMucGFyc2VXaGVyZUV4cHIoKTtcblxuICAgIHJldHVybiB7IHR5cGU6IFwiVVBEQVRFXCIsIGFwcElkLCBhc3NpZ25tZW50cywgd2hlcmUgfTtcbiAgfVxuXG4gIHByaXZhdGUgcGFyc2VBc3NpZ25tZW50cygpOiBBc3NpZ25tZW50W10ge1xuICAgIGNvbnN0IGFzc2lnbm1lbnRzOiBBc3NpZ25tZW50W10gPSBbXTtcbiAgICBkbyB7XG4gICAgICBjb25zdCBmaWVsZCA9IHRoaXMucGFyc2VJZGVudGlmaWVyKCk7XG4gICAgICB0aGlzLmV4cGVjdChUb2tlbktpbmQuRVEpO1xuICAgICAgY29uc3QgdmFsdWUgPSB0aGlzLnBhcnNlQXNzaWdubWVudFZhbHVlKCk7XG4gICAgICBhc3NpZ25tZW50cy5wdXNoKHsgZmllbGQsIHZhbHVlIH0pO1xuICAgIH0gd2hpbGUgKHRoaXMuY29uc3VtZShUb2tlbktpbmQuQ09NTUEpKTtcbiAgICByZXR1cm4gYXNzaWdubWVudHM7XG4gIH1cblxuICAvKipcbiAgICogU0VUIFx1MzA2RVx1NTNGM1x1OEZCQVx1MzA5Mlx1ODlFM1x1Njc5MFx1MzA1OVx1MzA4Qlx1MzAwMlxuICAgKiBcdTdCOTdcdTg4NTNcdTVGMEZcdUZGMDhmaWVsZCBvcCBudW0gLyBudW0gb3AgZmllbGQgLyBmaWVsZCBvcCBmaWVsZFx1RkYwOVx1MzA5Mlx1NTEyQVx1NTE0OFx1NzY4NFx1MzA2Qlx1NjkxQ1x1NTFGQVx1MzA1N1x1MzAwMVxuICAgKiBcdTMwNURcdTMwOENcdTRFRTVcdTU5MTZcdTMwNkZcdTkwMUFcdTVFMzhcdTMwNkUgU3FsVmFsdWUgXHUzMDY4XHUzMDU3XHUzMDY2XHU4OUUzXHU2NzkwXHUzMDU5XHUzMDhCXHUzMDAyXG4gICAqXG4gICAqIFx1N0I5N1x1ODg1M1x1NUYwRlx1MzA2RVx1MzBEMVx1MzBCRlx1MzBGQ1x1MzBGM1x1RkYwODJcdTMwQzhcdTMwRkNcdTMwQUZcdTMwRjNcdTUxNDhcdThBQURcdTMwN0ZcdTMwNjdcdTUyMjRcdTVCOUFcdUZGMDk6XG4gICAqICAgSURFTlQgIGFyaXRoT3AgTlVNQkVSICBcdTIxOTIgQXJpdGhFeHByXG4gICAqICAgSURFTlQgIGFyaXRoT3AgSURFTlQgICBcdTIxOTIgQXJpdGhFeHByXG4gICAqICAgTlVNQkVSIGFyaXRoT3AgSURFTlQgICBcdTIxOTIgQXJpdGhFeHByXG4gICAqL1xuICBwcml2YXRlIHBhcnNlQXNzaWdubWVudFZhbHVlKCk6IFNxbFZhbHVlIHwgQXJpdGhFeHByIHtcbiAgICBjb25zdCB0b2swID0gdGhpcy5wZWVrKCk7XG4gICAgY29uc3QgdG9rMSA9IHRoaXMucGVla0F0KDEpO1xuICAgIGNvbnN0IHRvazIgPSB0aGlzLnBlZWtBdCgyKTtcblxuICAgIGNvbnN0IGlzQXJpdGhPcCA9IChrOiBUb2tlbktpbmQpOiBrIGlzIFRva2VuS2luZCA9PlxuICAgICAgayA9PT0gVG9rZW5LaW5kLlBMVVMgIHx8XG4gICAgICBrID09PSBUb2tlbktpbmQuTUlOVVMgfHxcbiAgICAgIGsgPT09IFRva2VuS2luZC5TVEFSICB8fFxuICAgICAgayA9PT0gVG9rZW5LaW5kLlNMQVNIO1xuXG4gICAgY29uc3QgaXNPcGVyYW5kID0gKGs6IFRva2VuS2luZCkgPT5cbiAgICAgIGsgPT09IFRva2VuS2luZC5JREVOVCB8fCBrID09PSBUb2tlbktpbmQuQklERU5UIHx8IGsgPT09IFRva2VuS2luZC5OVU1CRVI7XG5cbiAgICBpZiAoaXNPcGVyYW5kKHRvazAua2luZCkgJiYgaXNBcml0aE9wKHRvazEua2luZCkgJiYgaXNPcGVyYW5kKHRvazIua2luZCkpIHtcbiAgICAgIGNvbnN0IGxlZnQgID0gdGhpcy5wYXJzZUFyaXRoT3BlcmFuZCgpO1xuICAgICAgY29uc3Qgb3AgICAgPSB0aGlzLnBhcnNlQXJpdGhPcCgpO1xuICAgICAgY29uc3QgcmlnaHQgPSB0aGlzLnBhcnNlQXJpdGhPcGVyYW5kKCk7XG4gICAgICByZXR1cm4geyB0eXBlOiBcIkFSSVRIXCIsIGxlZnQsIG9wLCByaWdodCB9IHNhdGlzZmllcyBBcml0aEV4cHI7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMucGFyc2VTcWxWYWx1ZSgpO1xuICB9XG5cbiAgcHJpdmF0ZSBwYXJzZUFyaXRoT3BlcmFuZCgpOiBBcml0aE9wZXJhbmQge1xuICAgIGNvbnN0IHRvayA9IHRoaXMucGVlaygpO1xuICAgIGlmICh0b2sua2luZCA9PT0gVG9rZW5LaW5kLk5VTUJFUikge1xuICAgICAgdGhpcy5hZHZhbmNlKCk7XG4gICAgICByZXR1cm4geyB0eXBlOiBcIk5VTUJFUlwiLCB2YWx1ZTogTnVtYmVyKHRvay52YWx1ZSkgfTtcbiAgICB9XG4gICAgaWYgKHRvay5raW5kID09PSBUb2tlbktpbmQuSURFTlQgfHwgdG9rLmtpbmQgPT09IFRva2VuS2luZC5CSURFTlQpIHtcbiAgICAgIHRoaXMuYWR2YW5jZSgpO1xuICAgICAgcmV0dXJuIHsgdHlwZTogXCJGSUVMRF9SRUZcIiwgZmllbGQ6IHRvay52YWx1ZSB9O1xuICAgIH1cbiAgICB0aHJvdyBuZXcgUGFyc2VFcnJvcihcIlx1N0I5N1x1ODg1M1x1NUYwRlx1MzA2RVx1MzBBQVx1MzBEQVx1MzBFOVx1MzBGM1x1MzBDOVx1MzA2Qlx1MzA2Rlx1OEI1OFx1NTIyNVx1NUI1MFx1MzA3RVx1MzA1Rlx1MzA2Rlx1NjU3MFx1NTAyNFx1MzA5Mlx1NjMwN1x1NUI5QVx1MzA1N1x1MzA2Nlx1MzA0Rlx1MzA2MFx1MzA1NVx1MzA0NFwiLCB0b2spO1xuICB9XG5cbiAgcHJpdmF0ZSBwYXJzZUFyaXRoT3AoKTogQXJpdGhPcCB7XG4gICAgY29uc3QgdG9rID0gdGhpcy5hZHZhbmNlKCk7XG4gICAgc3dpdGNoICh0b2sua2luZCkge1xuICAgICAgY2FzZSBUb2tlbktpbmQuUExVUzogIHJldHVybiBcIitcIjtcbiAgICAgIGNhc2UgVG9rZW5LaW5kLk1JTlVTOiByZXR1cm4gXCItXCI7XG4gICAgICBjYXNlIFRva2VuS2luZC5TVEFSOiAgcmV0dXJuIFwiKlwiO1xuICAgICAgY2FzZSBUb2tlbktpbmQuU0xBU0g6IHJldHVybiBcIi9cIjtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZUVycm9yKFwiXHU3Qjk3XHU4ODUzXHU2RjE0XHU3Qjk3XHU1QjUwXHVGRjA4KyAtICogL1x1RkYwOVx1MzA0Q1x1NUZDNVx1ODk4MVx1MzA2N1x1MzA1OVwiLCB0b2spO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gREVMRVRFXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHBhcnNlRGVsZXRlKCk6IERlbGV0ZVN0YXRlbWVudCB7XG4gICAgdGhpcy5leHBlY3QoVG9rZW5LaW5kLkRFTEVURSk7XG4gICAgdGhpcy5leHBlY3QoVG9rZW5LaW5kLkZST00pO1xuXG4gICAgY29uc3QgbmFtZSA9IHRoaXMucGFyc2VJZGVudGlmaWVyKCk7XG4gICAgY29uc3QgYXBwSWQgPSBleHRyYWN0QXBwSWQobmFtZSwgdGhpcy5wcmV2KCkpO1xuXG4gICAgY29uc3Qgd2hlcmVUb2sgPSB0aGlzLnBlZWsoKTtcbiAgICBpZiAoIXRoaXMuY29uc3VtZShUb2tlbktpbmQuV0hFUkUpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2VFcnJvcihcbiAgICAgICAgXCJERUxFVEUgXHU2NTg3XHUzMDZCXHUzMDZGIFdIRVJFIFx1NTNFNVx1MzA0Q1x1NUZDNVx1OTgwOFx1MzA2N1x1MzA1OVx1RkYwOFx1NTE2OFx1NEVGNlx1NTI0QVx1OTY2NFx1MzA5Mlx1OTYzMlx1MzA1MFx1MzA1Rlx1MzA4MVx1RkYwOVwiLFxuICAgICAgICB3aGVyZVRva1xuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3Qgd2hlcmUgPSB0aGlzLnBhcnNlV2hlcmVFeHByKCk7XG5cbiAgICByZXR1cm4geyB0eXBlOiBcIkRFTEVURVwiLCBhcHBJZCwgd2hlcmUgfTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gXHUzMEM4XHUzMEZDXHUzMEFGXHUzMEYzXHU2NENEXHU0RjVDXHUzMEQ4XHUzMEVCXHUzMEQxXHUzMEZDXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHBlZWsoKTogVG9rZW4ge1xuICAgIHJldHVybiB0aGlzLnRva2Vuc1t0aGlzLnBvc10gPz8geyBraW5kOiBUb2tlbktpbmQuRU9GLCB2YWx1ZTogXCJcIiwgcG9zOiAtMSB9O1xuICB9XG5cbiAgLyoqIG4gXHU1MTQ4XHUzMDZFXHUzMEM4XHUzMEZDXHUzMEFGXHUzMEYzXHUzMDkyXHU4QUFEXHUzMDdGXHU1M0Q2XHUzMDhCXHVGRjA4XHU2RDg4XHU4Q0JCXHUzMDU3XHUzMDZBXHUzMDQ0XHVGRjA5ICovXG4gIHByaXZhdGUgcGVla0F0KG46IG51bWJlcik6IFRva2VuIHtcbiAgICByZXR1cm4gdGhpcy50b2tlbnNbdGhpcy5wb3MgKyBuXSA/PyB7IGtpbmQ6IFRva2VuS2luZC5FT0YsIHZhbHVlOiBcIlwiLCBwb3M6IC0xIH07XG4gIH1cblxuICBwcml2YXRlIHByZXYoKTogVG9rZW4ge1xuICAgIHJldHVybiB0aGlzLnRva2Vuc1t0aGlzLnBvcyAtIDFdID8/IHsga2luZDogVG9rZW5LaW5kLkVPRiwgdmFsdWU6IFwiXCIsIHBvczogLTEgfTtcbiAgfVxuXG4gIHByaXZhdGUgYWR2YW5jZSgpOiBUb2tlbiB7XG4gICAgY29uc3QgdG9rID0gdGhpcy5wZWVrKCk7XG4gICAgaWYgKHRvay5raW5kICE9PSBUb2tlbktpbmQuRU9GKSB0aGlzLnBvcysrO1xuICAgIHJldHVybiB0b2s7XG4gIH1cblxuICAvKiogXHU2MzA3XHU1QjlBIGtpbmQgXHUzMDZBXHUzMDg5XHU2RDg4XHU4Q0JCXHUzMDU3XHUzMDY2IHRydWUgXHUzMDkyXHU4RkQ0XHUzMDU5ICovXG4gIHByaXZhdGUgY29uc3VtZShraW5kOiBUb2tlbktpbmQpOiBib29sZWFuIHtcbiAgICBpZiAodGhpcy5wZWVrKCkua2luZCA9PT0ga2luZCkge1xuICAgICAgdGhpcy5hZHZhbmNlKCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLyoqIFx1NjMwN1x1NUI5QSBraW5kIFx1MzA2N1x1MzA2QVx1MzA1MVx1MzA4Q1x1MzA3MFx1MzBBOFx1MzBFOVx1MzBGQyAqL1xuICBwcml2YXRlIGV4cGVjdChraW5kOiBUb2tlbktpbmQsIG1zZz86IHN0cmluZyk6IFRva2VuIHtcbiAgICBjb25zdCB0b2sgPSB0aGlzLnBlZWsoKTtcbiAgICBpZiAodG9rLmtpbmQgIT09IGtpbmQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZUVycm9yKFxuICAgICAgICBtc2cgPz8gYFx1MzAwQyR7a2luZH1cdTMwMERcdTMwNENcdTVGQzVcdTg5ODFcdTMwNjdcdTMwNTlgLFxuICAgICAgICB0b2tcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmFkdmFuY2UoKTtcbiAgfVxuXG4gIC8qKiBGUk9NIC8gR1JPVVAgQlkgXHUzMDZBXHUzMDY5XHU2NTg3XHU4MTA4XHU0RUQ4XHUzMDREXHUzMEE4XHUzMEU5XHUzMEZDXHUzMEUxXHUzMEMzXHUzMEJCXHUzMEZDXHUzMEI4ICovXG4gIHByaXZhdGUgZXhwZWN0S2V5d29yZChraW5kOiBUb2tlbktpbmQsIG1zZzogc3RyaW5nKTogVG9rZW4ge1xuICAgIHJldHVybiB0aGlzLmV4cGVjdChraW5kLCBtc2cpO1xuICB9XG5cbiAgLyoqIFx1N0IyNlx1NTNGN1x1MzA2QVx1MzA1N1x1NjU3NFx1NjU3MFx1MzA5Mlx1OEFBRFx1MzA4MCAqL1xuICBwcml2YXRlIHBhcnNlVW5zaWduZWRJbnQoKTogbnVtYmVyIHtcbiAgICBjb25zdCB0b2sgPSB0aGlzLmV4cGVjdChUb2tlbktpbmQuTlVNQkVSLCBcIlx1NjU3NFx1NjU3MFx1MzA0Q1x1NUZDNVx1ODk4MVx1MzA2N1x1MzA1OVwiKTtcbiAgICBjb25zdCBuID0gTnVtYmVyKHRvay52YWx1ZSk7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKG4pIHx8IG4gPCAwKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2VFcnJvcihcIlx1NkI2M1x1MzA2RVx1NjU3NFx1NjU3MFx1MzA0Q1x1NUZDNVx1ODk4MVx1MzA2N1x1MzA1OVwiLCB0b2spO1xuICAgIH1cbiAgICByZXR1cm4gbjtcbiAgfVxuXG4gIC8vIFx1OEI1OFx1NTIyNVx1NUI1MFx1RkYwOElERU5UIC8gQklERU5UXHVGRjA5XHUzMDkyXHU4QUFEXHUzMDgwXG4gIHByaXZhdGUgcGFyc2VJZGVudGlmaWVyKCk6IHN0cmluZyB7XG4gICAgY29uc3QgdG9rID0gdGhpcy5wZWVrKCk7XG4gICAgaWYgKHRvay5raW5kID09PSBUb2tlbktpbmQuSURFTlQgfHwgdG9rLmtpbmQgPT09IFRva2VuS2luZC5CSURFTlQpIHtcbiAgICAgIHRoaXMuYWR2YW5jZSgpO1xuICAgICAgcmV0dXJuIHRvay52YWx1ZTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IFBhcnNlRXJyb3IoXG4gICAgICBcIlx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1NTQwRFx1MzA3RVx1MzA1Rlx1MzA2Rlx1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlx1NTQwRFx1MzA0Q1x1NUZDNVx1ODk4MVx1MzA2N1x1MzA1OVwiLFxuICAgICAgdG9rXG4gICAgKTtcbiAgfVxuXG4gIC8vIFx1MzBBOFx1MzBBNFx1MzBFQVx1MzBBMlx1MzBCOVx1NTQwRDogSURFTlQgLyBCSURFTlQgXHUzMDZCXHU1MkEwXHUzMDQ4XHUzMDAxXHUzMEFEXHUzMEZDXHUzMEVGXHUzMEZDXHUzMEM5XHUzMDgyXHU4QTMxXHU1QkI5XHUzMDU5XHUzMDhCXG4gIC8vIFx1NEY4QjogU0VMRUNUIFNVTShcdTkxRDFcdTk4NEQpIEFTIGF2ZyBcdTIxOTIgXCJhdmdcIiBcdTMwNkYgQVZHIFx1MzBBRFx1MzBGQ1x1MzBFRlx1MzBGQ1x1MzBDOVx1MzA2MFx1MzA0QyBhbGlhcyBcdTMwNjhcdTMwNTdcdTMwNjZcdTY3MDlcdTUyQjlcbiAgcHJpdmF0ZSBwYXJzZUFsaWFzTmFtZSgpOiBzdHJpbmcge1xuICAgIGNvbnN0IHRvayA9IHRoaXMucGVlaygpO1xuICAgIGlmIChcbiAgICAgIHRvay5raW5kID09PSBUb2tlbktpbmQuSURFTlQgfHxcbiAgICAgIHRvay5raW5kID09PSBUb2tlbktpbmQuQklERU5UIHx8XG4gICAgICBLRVlXT1JEUy5oYXModG9rLnZhbHVlLnRvVXBwZXJDYXNlKCkpXG4gICAgKSB7XG4gICAgICB0aGlzLmFkdmFuY2UoKTtcbiAgICAgIHJldHVybiB0b2sudmFsdWUudG9Mb3dlckNhc2UoKTsgLy8gYWxpYXMgXHUzMDZGXHU1QzBGXHU2NTg3XHU1QjU3XHUzMDY3XHU3RDcxXHU0RTAwXG4gICAgfVxuICAgIHRocm93IG5ldyBQYXJzZUVycm9yKFwiXHUzMEE4XHUzMEE0XHUzMEVBXHUzMEEyXHUzMEI5XHU1NDBEXHUzMDRDXHU1RkM1XHU4OTgxXHUzMDY3XHUzMDU5XCIsIHRvayk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gXHUzMEQ4XHUzMEVCXHUzMEQxXHUzMEZDOiBBUFAxMDAgXHUyMTkyIGFwcElkOiAxMDBcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gZXh0cmFjdEFwcElkKG5hbWU6IHN0cmluZywgdG9rOiBUb2tlbik6IG51bWJlciB7XG4gIGNvbnN0IG0gPSBuYW1lLm1hdGNoKC9eW0FhXVtQcF1bUHBdKFxcZCspJC8pO1xuICBpZiAoIW0pIHtcbiAgICB0aHJvdyBuZXcgUGFyc2VFcnJvcihcbiAgICAgIGBcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUJcdTU0MERcdTMwNkYgQVBQICsgXHU2NTcwXHU1QjU3XHUzMDY3XHU2MzA3XHU1QjlBXHUzMDU3XHUzMDY2XHUzMDRGXHUzMDYwXHUzMDU1XHUzMDQ0XHVGRjA4XHU0RjhCOiBBUFAxMDBcdUZGMDlcdTMwMDJcdTMwMEMke25hbWV9XHUzMDBEXHUzMDZGXHU3MTIxXHU1MkI5XHUzMDY3XHUzMDU5YCxcbiAgICAgIHRva1xuICAgICk7XG4gIH1cbiAgcmV0dXJuIE51bWJlcihtWzFdKTtcbn1cbiIsICIvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIHB1c2hEb3duTm90IFx1MjAxNCBOT1QgXHUzMDkyXHUzMEVBXHUzMEZDXHUzMEQ1XHUzMDdFXHUzMDY3XHU2MkJDXHUzMDU3XHU0RTBCXHUzMDUyXHUzMDhCXHVGRjA4XHUzMEM5XHUzMEZCXHUzMEUyXHUzMEVCXHUzMEFDXHUzMEYzXHVGRjA5XG4vLyB3aGVyZVRvS2ludG9uZS50cyBcdTMwNjggZXZhbFdoZXJlLnRzIFx1MzA2RVx1NEUyMVx1NjVCOVx1MzA0Qlx1MzA4OVx1NEY3Rlx1NzUyOFx1MzA1OVx1MzA4Qlx1NTE3MVx1OTAxQVx1MzBFRFx1MzBCOFx1MzBDM1x1MzBBRlxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmltcG9ydCB0eXBlIHsgV2hlcmVFeHByLCBDb21wYXJlT3AgfSBmcm9tIFwiLi4vdHlwZXMvYXN0XCI7XG5pbXBvcnQgeyBLaW50b25lUXVlcnlFcnJvciB9IGZyb20gXCIuLi9jb252ZXJ0ZXIvd2hlcmVUb0tpbnRvbmVcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHB1c2hEb3duTm90KGV4cHI6IFdoZXJlRXhwcik6IFdoZXJlRXhwciB7XG4gIHN3aXRjaCAoZXhwci50eXBlKSB7XG4gICAgY2FzZSBcIkJJTkFSWVwiOiB7XG4gICAgICBjb25zdCBuZWdhdGVkID0gbmVnYXRlT3AoZXhwci5vcCk7XG4gICAgICBpZiAobmVnYXRlZCA9PT0gbnVsbCkge1xuICAgICAgICB0aHJvdyBuZXcgS2ludG9uZVF1ZXJ5RXJyb3IoXG4gICAgICAgICAgYE5PVCAke2V4cHIub3B9IFx1MzA2Rlx1MzBCNVx1MzBERFx1MzBGQ1x1MzBDOFx1NUJGRVx1OEM2MVx1NTkxNlx1MzA2N1x1MzA1OWBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IC4uLmV4cHIsIG9wOiBuZWdhdGVkIH07XG4gICAgfVxuICAgIGNhc2UgXCJOVUxMX0NIRUNLXCI6XG4gICAgICByZXR1cm4geyAuLi5leHByLCBub3Q6ICFleHByLm5vdCB9O1xuICAgIGNhc2UgXCJMT0dJQ0FMXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcIkxPR0lDQUxcIixcbiAgICAgICAgb3A6IGV4cHIub3AgPT09IFwiQU5EXCIgPyBcIk9SXCIgOiBcIkFORFwiLFxuICAgICAgICBsZWZ0OiBwdXNoRG93bk5vdChleHByLmxlZnQpLFxuICAgICAgICByaWdodDogcHVzaERvd25Ob3QoZXhwci5yaWdodCksXG4gICAgICB9O1xuICAgIGNhc2UgXCJOT1RcIjpcbiAgICAgIHJldHVybiBleHByLmV4cHI7IC8vIFx1NEU4Q1x1OTFDRFx1NTQyNlx1NUI5QVxuICAgIGNhc2UgXCJHUk9VUFwiOlxuICAgICAgcmV0dXJuIHsgdHlwZTogXCJHUk9VUFwiLCBleHByOiBwdXNoRG93bk5vdChleHByLmV4cHIpIH07XG4gIH1cbn1cblxuZnVuY3Rpb24gbmVnYXRlT3Aob3A6IENvbXBhcmVPcCk6IENvbXBhcmVPcCB8IG51bGwge1xuICBzd2l0Y2ggKG9wKSB7XG4gICAgY2FzZSBcIj1cIjogICAgcmV0dXJuIFwiIT1cIjtcbiAgICBjYXNlIFwiIT1cIjpcbiAgICBjYXNlIFwiPD5cIjogICByZXR1cm4gXCI9XCI7XG4gICAgY2FzZSBcIj5cIjogICAgcmV0dXJuIFwiPD1cIjtcbiAgICBjYXNlIFwiPFwiOiAgICByZXR1cm4gXCI+PVwiO1xuICAgIGNhc2UgXCI+PVwiOiAgIHJldHVybiBcIjxcIjtcbiAgICBjYXNlIFwiPD1cIjogICByZXR1cm4gXCI+XCI7XG4gICAgY2FzZSBcIkxJS0VcIjogICAgIHJldHVybiBcIk5PVF9MSUtFXCI7XG4gICAgY2FzZSBcIk5PVF9MSUtFXCI6IHJldHVybiBcIkxJS0VcIjtcbiAgICBjYXNlIFwiSU5cIjogICAgICAgcmV0dXJuIFwiTk9UX0lOXCI7XG4gICAgY2FzZSBcIk5PVF9JTlwiOiAgIHJldHVybiBcIklOXCI7XG4gIH1cbn1cbiIsICIvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFdIRVJFIEFTVCBcdTIxOTIga2ludG9uZSBcdTMwQUZcdTMwQThcdTMwRUFcdTY1ODdcdTVCNTdcdTUyMTcgXHU1OTA5XHU2M0RCXG4vL1xuLy8ga2ludG9uZSBcdTMwQUZcdTMwQThcdTMwRUFcdTY5Q0JcdTY1ODdcdTMwRUFcdTMwRDVcdTMwQTFcdTMwRUNcdTMwRjNcdTMwQjk6XG4vLyAgIGZpZWxkID0gXCJ2YWx1ZVwiXG4vLyAgIGZpZWxkICE9IFwidmFsdWVcIlxuLy8gICBmaWVsZCA+IDEwMFxuLy8gICBmaWVsZCBsaWtlIFwia2V5d29yZFwiXG4vLyAgIGZpZWxkIGluIChcInYxXCIsXCJ2MlwiKVxuLy8gICBmaWVsZCA9IFwiXCIgICAgICAgICAgXHUyMTkwIElTIE5VTEwgXHUzMDZCXHU3NkY4XHU1RjUzXG4vLyAgIGZpZWxkICE9IFwiXCIgICAgICAgICBcdTIxOTAgSVMgTk9UIE5VTEwgXHUzMDZCXHU3NkY4XHU1RjUzXG4vLyAgIChleHByKSBhbmQgKGV4cHIpXG4vLyAgIChleHByKSBvciAoZXhwcilcbi8vICAgVE9EQVkoKSAvIE5PVygpIC8gTE9HSU5VU0VSKCkgIFx1MjE5MCBraW50b25lIFx1NUMwMlx1NzUyOFx1OTVBMlx1NjU3MFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmltcG9ydCB7IHB1c2hEb3duTm90IH0gZnJvbSBcIi4uL2VuZ2luZS9wdXNoRG93bk5vdFwiO1xuaW1wb3J0IHR5cGUge1xuICBXaGVyZUV4cHIsXG4gIEJpbmFyeUV4cHIsXG4gIE51bGxDaGVja0V4cHIsXG4gIExvZ2ljYWxFeHByLFxuICBOb3RFeHByLFxuICBHcm91cEV4cHIsXG4gIFNxbFZhbHVlLFxuICBGaWVsZFZhbHVlLFxuICBTdHJpbmdMaXRlcmFsLFxuICBLaW50b25lRnVuY3Rpb24sXG4gIEluTGlzdCxcbiAgQ29tcGFyZU9wLFxufSBmcm9tIFwiLi4vdHlwZXMvYXN0XCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gXHUzMEE4XHUzMEYzXHUzMEM4XHUzMEVBXHUzMEREXHUzMEE0XHUzMEYzXHUzMEM4XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBXaGVyZUV4cHIgXHUzMDkyIGtpbnRvbmUgXHUzMEFGXHUzMEE4XHUzMEVBXHU2NTg3XHU1QjU3XHU1MjE3XHUzMDZCXHU1OTA5XHU2M0RCXHUzMDU5XHUzMDhCXHUzMDAyXG4gKiBcdTRGOEI6IHsgdHlwZTogXCJCSU5BUllcIiwgb3A6IFwiPVwiLCBsZWZ0OiB7ZmllbGQ6XCJcdTMwQjlcdTMwQzZcdTMwRkNcdTMwQkZcdTMwQjlcIn0sIHJpZ2h0OiB7dmFsdWU6XCJcdTVCOENcdTRFODZcIn0gfVxuICogICBcdTIxOTIgJ1x1MzBCOVx1MzBDNlx1MzBGQ1x1MzBCRlx1MzBCOSA9IFwiXHU1QjhDXHU0RTg2XCInXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aGVyZVRvS2ludG9uZShleHByOiBXaGVyZUV4cHIpOiBzdHJpbmcge1xuICBzd2l0Y2ggKGV4cHIudHlwZSkge1xuICAgIGNhc2UgXCJCSU5BUllcIjogICAgcmV0dXJuIGNvbnZlcnRCaW5hcnkoZXhwcik7XG4gICAgY2FzZSBcIk5VTExfQ0hFQ0tcIjogcmV0dXJuIGNvbnZlcnROdWxsQ2hlY2soZXhwcik7XG4gICAgY2FzZSBcIkxPR0lDQUxcIjogICByZXR1cm4gY29udmVydExvZ2ljYWwoZXhwcik7XG4gICAgY2FzZSBcIk5PVFwiOiAgICAgICByZXR1cm4gY29udmVydE5vdChleHByKTtcbiAgICBjYXNlIFwiR1JPVVBcIjogICAgIHJldHVybiBjb252ZXJ0R3JvdXAoZXhwcik7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBCaW5hcnlFeHByOiBmaWVsZCBvcCB2YWx1ZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGNvbnZlcnRCaW5hcnkoZXhwcjogQmluYXJ5RXhwcik6IHN0cmluZyB7XG4gIGNvbnN0IGxlZnQgPSBjb252ZXJ0RmllbGQoZXhwci5sZWZ0KTtcbiAgY29uc3Qgb3AgPSBjb252ZXJ0T3AoZXhwci5vcCk7XG4gIGNvbnN0IHJpZ2h0ID0gY29udmVydFZhbHVlKGV4cHIucmlnaHQsIGV4cHIub3ApO1xuICByZXR1cm4gYCR7bGVmdH0gJHtvcH0gJHtyaWdodH1gO1xufVxuXG4vKipcbiAqIFNRTCBcdTZGMTRcdTdCOTdcdTVCNTAgXHUyMTkyIGtpbnRvbmUgXHU2RjE0XHU3Qjk3XHU1QjUwXG4gKlxuICogfCBTUUwgICAgICAgIHwga2ludG9uZSAgfFxuICogfC0tLS0tLS0tLS0tLXwtLS0tLS0tLS0tfFxuICogfCA9ICAgICAgICAgIHwgPSAgICAgICAgfFxuICogfCAhPSAvIDw+ICAgIHwgIT0gICAgICAgfFxuICogfCA+IC8gPCAvID49IC8gPD0gfCBcdTMwNURcdTMwNkVcdTMwN0VcdTMwN0UgfFxuICogfCBMSUtFICAgICAgIHwgbGlrZSAgICAgfFxuICogfCBJTiAgICAgICAgIHwgaW4gICAgICAgfFxuICovXG5mdW5jdGlvbiBjb252ZXJ0T3Aob3A6IENvbXBhcmVPcCk6IHN0cmluZyB7XG4gIHN3aXRjaCAob3ApIHtcbiAgICBjYXNlIFwiPVwiOiAgICByZXR1cm4gXCI9XCI7XG4gICAgY2FzZSBcIiE9XCI6XG4gICAgY2FzZSBcIjw+XCI6ICAgcmV0dXJuIFwiIT1cIjtcbiAgICBjYXNlIFwiPlwiOiAgICByZXR1cm4gXCI+XCI7XG4gICAgY2FzZSBcIjxcIjogICAgcmV0dXJuIFwiPFwiO1xuICAgIGNhc2UgXCI+PVwiOiAgIHJldHVybiBcIj49XCI7XG4gICAgY2FzZSBcIjw9XCI6ICAgcmV0dXJuIFwiPD1cIjtcbiAgICBjYXNlIFwiTElLRVwiOiAgICAgcmV0dXJuIFwibGlrZVwiO1xuICAgIGNhc2UgXCJOT1RfTElLRVwiOiByZXR1cm4gXCJub3QgbGlrZVwiO1xuICAgIGNhc2UgXCJJTlwiOiAgICAgICByZXR1cm4gXCJpblwiO1xuICAgIGNhc2UgXCJOT1RfSU5cIjogICByZXR1cm4gXCJub3QgaW5cIjtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE51bGxDaGVja0V4cHI6IElTIE5VTEwgLyBJUyBOT1QgTlVMTFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogSVMgTlVMTCAgICAgXHUyMTkyIGZpZWxkID0gXCJcIlxuICogSVMgTk9UIE5VTEwgXHUyMTkyIGZpZWxkICE9IFwiXCJcbiAqL1xuZnVuY3Rpb24gY29udmVydE51bGxDaGVjayhleHByOiBOdWxsQ2hlY2tFeHByKTogc3RyaW5nIHtcbiAgY29uc3QgZmllbGQgPSBjb252ZXJ0RmllbGQoZXhwci5maWVsZCk7XG4gIHJldHVybiBleHByLm5vdCA/IGAke2ZpZWxkfSAhPSBcIlwiYCA6IGAke2ZpZWxkfSA9IFwiXCJgO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIExvZ2ljYWxFeHByOiBBTkQgLyBPUlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGNvbnZlcnRMb2dpY2FsKGV4cHI6IExvZ2ljYWxFeHByKTogc3RyaW5nIHtcbiAgY29uc3QgbGVmdCA9IHdoZXJlVG9LaW50b25lKGV4cHIubGVmdCk7XG4gIGNvbnN0IHJpZ2h0ID0gd2hlcmVUb0tpbnRvbmUoZXhwci5yaWdodCk7XG4gIGNvbnN0IG9wID0gZXhwci5vcCA9PT0gXCJBTkRcIiA/IFwiYW5kXCIgOiBcIm9yXCI7XG5cbiAgLy8gQU5EL09SIFx1MzA0Q1x1NkRGN1x1NTcyOFx1MzA1OVx1MzA4Qlx1MzA2OFx1MzA0RFx1MzA2RVx1NjJFQ1x1NUYyN1x1NEVEOFx1NEUwRVxuICAvLyBcdTVCNTBcdTMwNEMgTG9naWNhbEV4cHIgXHUzMDZFXHU1ODM0XHU1NDA4XHUzMDAxXHU1MTJBXHU1MTQ4XHU1RUE2XHUzMDRDXHU1OTA5XHUzMDhGXHUzMDhCXHU1M0VGXHU4MEZEXHU2MDI3XHUzMDRDXHUzMDQyXHUzMDhCXHUzMDVGXHUzMDgxXHU2MkVDXHU1RjI3XHUzMDY3XHU1MzA1XHUzMDgwXG4gIGNvbnN0IGxlZnRTdHIgPSBuZWVkc1BhcmVucyhleHByLmxlZnQpID8gYCgke2xlZnR9KWAgOiBsZWZ0O1xuICBjb25zdCByaWdodFN0ciA9IG5lZWRzUGFyZW5zKGV4cHIucmlnaHQpID8gYCgke3JpZ2h0fSlgIDogcmlnaHQ7XG5cbiAgcmV0dXJuIGAke2xlZnRTdHJ9ICR7b3B9ICR7cmlnaHRTdHJ9YDtcbn1cblxuLyoqXG4gKiBraW50b25lIFx1MzA2RiBOT1QgXHU2RjE0XHU3Qjk3XHU1QjUwXHUzMDkyXHU1MjREXHU3RjZFXHU1RjYyXHU1RjBGXHUzMDY3XHUzMEI1XHUzMEREXHUzMEZDXHUzMEM4XHUzMDU3XHUzMDZBXHUzMDQ0XHUzMDAyXG4gKiBcdTUzRUZcdTgwRkRcdTMwNkFcdTk2NTBcdTMwOEFcdTUxODVcdTUwNzRcdTMwNkVcdTZGMTRcdTdCOTdcdTVCNTBcdTMwOTJcdTU0MjZcdTVCOUFcdTVGNjJcdTMwNkJcdTU5MDlcdTYzREJcdTMwNTlcdTMwOEJcdUZGMDhcdTMwRDdcdTMwQzNcdTMwQjdcdTMwRTVcdTMwQzBcdTMwQTZcdTMwRjNcdUZGMDlcdTMwMDJcbiAqXG4gKiBOT1QgKGEgPSBiKSAgICAgIFx1MjE5MiBhICE9IGJcbiAqIE5PVCAoYSAhPSBiKSAgICAgXHUyMTkyIGEgPSBiXG4gKiBOT1QgKGEgbGlrZSBiKSAgIFx1MjE5MiBcdTMwQThcdTMwRTlcdTMwRkNcdUZGMDhQaGFzZSAxIFx1MzBCOVx1MzBCM1x1MzBGQ1x1MzBEN1x1NTkxNjogTk9UIExJS0UgXHUzMDZGIFx1RDgzRFx1REQzNlx1RkYwOVxuICogTk9UIChJUyBOVUxMKSAgICBcdTIxOTIgSVMgTk9UIE5VTExcbiAqIE5PVCAoSVMgTk9UIE5VTEwpXHUyMTkyIElTIE5VTExcbiAqIE5PVCAoQSBBTkQgQikgICAgXHUyMTkyIChOT1QgQSkgT1IgKE5PVCBCKSAgIFx1MjE5MCBcdTMwQzlcdTMwRkJcdTMwRTJcdTMwRUJcdTMwQUNcdTMwRjNcbiAqIE5PVCAoQSBPUiBCKSAgICAgXHUyMTkyIChOT1QgQSkgQU5EIChOT1QgQikgIFx1MjE5MCBcdTMwQzlcdTMwRkJcdTMwRTJcdTMwRUJcdTMwQUNcdTMwRjNcbiAqL1xuZnVuY3Rpb24gY29udmVydE5vdChleHByOiBOb3RFeHByKTogc3RyaW5nIHtcbiAgcmV0dXJuIHdoZXJlVG9LaW50b25lKHB1c2hEb3duTm90KGV4cHIuZXhwcikpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEdyb3VwRXhwcjogKC4uLilcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBjb252ZXJ0R3JvdXAoZXhwcjogR3JvdXBFeHByKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAoJHt3aGVyZVRvS2ludG9uZShleHByLmV4cHIpfSlgO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1NTNDMlx1NzE2N1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogSk9JTiBcdTMwNDJcdTMwOEFcdUZGMDhcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUJcdTMwQThcdTMwQTRcdTMwRUFcdTMwQTJcdTMwQjlcdTRFRDhcdTMwNERcdUZGMDlcdTMwNkVcdTU4MzRcdTU0MDhcdTMwMDFcdTMwQThcdTMwQTRcdTMwRUFcdTMwQTJcdTMwQjlcdTMwNkZcdTk2NjRcdTUzQkJcdTMwNTdcdTMwNjZcbiAqIFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1MzBCM1x1MzBGQ1x1MzBDOVx1MzA2MFx1MzA1MVx1MzA5MiBraW50b25lIFx1MzBBRlx1MzBBOFx1MzBFQVx1MzA2Qlx1NTFGQVx1NTI5Qlx1MzA1OVx1MzA4Qlx1MzAwMlxuICoga2ludG9uZSBBUEkgXHUzMDZGXHUzMEM2XHUzMEZDXHUzMEQ2XHUzMEVCXHU1NDBEXHUzMDkyXHU2MzAxXHUzMDVGXHUzMDZBXHUzMDQ0XHUzMDVGXHUzMDgxXHUzMDAyXG4gKi9cbmZ1bmN0aW9uIGNvbnZlcnRGaWVsZChmaWVsZDogRmllbGRWYWx1ZSk6IHN0cmluZyB7XG4gIHJldHVybiBxdW90ZUlkZW50aWZpZXIoZmllbGQuZmllbGQpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1NTAyNFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGNvbnZlcnRWYWx1ZSh2YWx1ZTogU3FsVmFsdWUsIG9wOiBDb21wYXJlT3ApOiBzdHJpbmcge1xuICBzd2l0Y2ggKHZhbHVlLnR5cGUpIHtcbiAgICBjYXNlIFwiU1RSSU5HXCI6ICAgICAgICByZXR1cm4gY29udmVydFN0cmluZyh2YWx1ZSk7XG4gICAgY2FzZSBcIk5VTUJFUlwiOiAgICAgICAgcmV0dXJuIFN0cmluZyh2YWx1ZS52YWx1ZSk7XG4gICAgY2FzZSBcIktJTlRPTkVfRlVOQ1wiOiAgcmV0dXJuIGNvbnZlcnRLaW50b25lRnVuYyh2YWx1ZSk7XG4gICAgY2FzZSBcIklOX0xJU1RcIjogICAgICAgcmV0dXJuIGNvbnZlcnRJbkxpc3QodmFsdWUsIG9wKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb252ZXJ0U3RyaW5nKHY6IFN0cmluZ0xpdGVyYWwpOiBzdHJpbmcge1xuICAvLyBraW50b25lIFx1MzBBRlx1MzBBOFx1MzBFQVx1MzA2RVx1NjU4N1x1NUI1N1x1NTIxN1x1MzA2Rlx1MzBDMFx1MzBENlx1MzBFQlx1MzBBRlx1MzBBOVx1MzBGQ1x1MzBDOFx1MzA2N1x1NTZGMlx1MzA4MFxuICAvLyBcdTUwMjRcdTUxODVcdTMwNkVcdTMwQzBcdTMwRDZcdTMwRUJcdTMwQUZcdTMwQTlcdTMwRkNcdTMwQzhcdTMwNkZcdTMwQThcdTMwQjlcdTMwQjFcdTMwRkNcdTMwRDdcbiAgcmV0dXJuIGBcIiR7di52YWx1ZS5yZXBsYWNlKC9cXFxcL2csIFwiXFxcXFxcXFxcIikucmVwbGFjZSgvXCIvZywgJ1xcXFxcIicpfVwiYDtcbn1cblxuZnVuY3Rpb24gY29udmVydEtpbnRvbmVGdW5jKHY6IEtpbnRvbmVGdW5jdGlvbik6IHN0cmluZyB7XG4gIC8vIFRPREFZKCkgLyBOT1coKSAvIExPR0lOVVNFUigpIFx1MzA2Rlx1MzA1RFx1MzA2RVx1MzA3RVx1MzA3RVx1NTFGQVx1NTI5QlxuICByZXR1cm4gYCR7di5uYW1lfSgpYDtcbn1cblxuZnVuY3Rpb24gY29udmVydEluTGlzdCh2OiBJbkxpc3QsIG9wOiBDb21wYXJlT3ApOiBzdHJpbmcge1xuICBpZiAob3AgIT09IFwiSU5cIiAmJiBvcCAhPT0gXCJOT1RfSU5cIikge1xuICAgIHRocm93IG5ldyBLaW50b25lUXVlcnlFcnJvcihcIklOX0xJU1QgXHUzMDZGIElOIC8gTk9UIElOIFx1NkYxNFx1N0I5N1x1NUI1MFx1MzA2N1x1MzA2RVx1MzA3Rlx1NEY3Rlx1NzUyOFx1MzA2N1x1MzA0RFx1MzA3RVx1MzA1OVwiKTtcbiAgfVxuICBjb25zdCB2YWx1ZXMgPSB2LnZhbHVlc1xuICAgIC5tYXAoKGl0ZW0pID0+XG4gICAgICBpdGVtLnR5cGUgPT09IFwiU1RSSU5HXCJcbiAgICAgICAgPyBjb252ZXJ0U3RyaW5nKGl0ZW0pXG4gICAgICAgIDogU3RyaW5nKGl0ZW0udmFsdWUpXG4gICAgKVxuICAgIC5qb2luKFwiLFwiKTtcbiAgcmV0dXJuIGAoJHt2YWx1ZXN9KWA7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gXHU4QjU4XHU1MjI1XHU1QjUwXHUzMEFGXHUzMEE5XHUzMEZDXHUzMEM4XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTMwQjNcdTMwRkNcdTMwQzlcdTMwNkJcdTMwQjlcdTMwREFcdTMwRkNcdTMwQjlcdTMwODRcdThBMThcdTUzRjdcdTMwNENcdTU0MkJcdTMwN0VcdTMwOENcdTMwOEJcdTU4MzRcdTU0MDhcdTMwNkZcdTMwQzBcdTMwRDZcdTMwRUJcdTMwQUZcdTMwQTlcdTMwRkNcdTMwQzhcdTMwNjdcdTU2RjJcdTMwODBcdTMwMDJcbiAqIGtpbnRvbmUgXHUzMEFGXHUzMEE4XHUzMEVBXHUzMDY3XHUzMDZGXHU4QjU4XHU1MjI1XHU1QjUwXHUzMDZFXHUzMEFGXHUzMEE5XHUzMEZDXHUzMEM4XHUzMDZCXHUzMEMwXHUzMEQ2XHUzMEVCXHUzMEFGXHUzMEE5XHUzMEZDXHUzMEM4XHUzMDkyXHU0RjdGXHU3NTI4XHUzMDU5XHUzMDhCXHUzMDAyXG4gKlxuICogXHU0RjhCOlxuICogICBcdTMwQjlcdTMwQzZcdTMwRkNcdTMwQkZcdTMwQjkgICAgICAgXHUyMTkyIFx1MzBCOVx1MzBDNlx1MzBGQ1x1MzBCRlx1MzBCOVxuICogICBcdTYyQzVcdTVGNTNcdTgwMDUgXHU1NDBEXHU1MjREICAgICAgXHUyMTkyIFwiXHU2MkM1XHU1RjUzXHU4MDA1IFx1NTQwRFx1NTI0RFwiXG4gKiAgIFx1OTFEMVx1OTg0RChcdTdBMEVcdThGQkMpICAgICAgIFx1MjE5MiBcIlx1OTFEMVx1OTg0RChcdTdBMEVcdThGQkMpXCJcbiAqICAgJGlkICAgICAgICAgICAgICBcdTIxOTIgJGlkXG4gKi9cbmZ1bmN0aW9uIHF1b3RlSWRlbnRpZmllcihuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAvLyBBU0NJSVx1ODJGMVx1NjU3MFx1NUI1N1x1MzBGQiRcdTMwRkJfXHUzMEZCXHU2NUU1XHU2NzJDXHU4QTlFIFVuaWNvZGUgXHU3QkM0XHU1NkYyXHVGRjA4XFx1MzAwMC1cXHU5RkZGXHVGRjA5XHUzMDZFXHUzMDdGIFx1MjE5MiBcdTMwQUZcdTMwQTlcdTMwRkNcdTMwQzhcdTRFMERcdTg5ODFcbiAgaWYgKC9eW1xcdyRcXHUzMDAwLVxcdTlGRkZdKyQvdS50ZXN0KG5hbWUpKSB7XG4gICAgcmV0dXJuIG5hbWU7XG4gIH1cbiAgcmV0dXJuIGBcIiR7bmFtZS5yZXBsYWNlKC9cIi9nLCAnXFxcXFwiJyl9XCJgO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBEOFx1MzBFQlx1MzBEMVx1MzBGQ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogTG9naWNhbEV4cHIgXHUzMDZFXHU1QjUwXHUzMENFXHUzMEZDXHUzMEM5XHUzMDRDXHU3NTcwXHUzMDZBXHUzMDhCXHU4QUQ2XHU3NDA2XHU2RjE0XHU3Qjk3XHU1QjUwXHUzMDkyXHU2MzAxXHUzMDY0XHU1ODM0XHU1NDA4XHUzMDZCXHU2MkVDXHU1RjI3XHUzMDRDXHU1RkM1XHU4OTgxXHUzMDRCXHU1MjI0XHU1QjlBXHUzMDAyXG4gKiBraW50b25lIFx1MzBBRlx1MzBBOFx1MzBFQVx1MzA2Rlx1NURFNlx1N0Q1MFx1NTQwOFx1MzA2NyBhbmQgXHUzMDRDIG9yIFx1MzA4OFx1MzA4QVx1NTEyQVx1NTE0OFx1MzA1NVx1MzA4Q1x1MzA4Qlx1MzA1Rlx1MzA4MVx1MzAwMVxuICogb3IgXHUzMDZFXHU1QjUwXHUzMDZCIGFuZCBcdTMwNENcdTY3NjVcdTMwOEJcdTU4MzRcdTU0MDhcdTMwNkZcdTYyRUNcdTVGMjdcdTMwNENcdTVGQzVcdTg5ODFcdTMwMDJcbiAqL1xuZnVuY3Rpb24gbmVlZHNQYXJlbnMoZXhwcjogV2hlcmVFeHByKTogYm9vbGVhbiB7XG4gIHJldHVybiBleHByLnR5cGUgPT09IFwiTE9HSUNBTFwiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBBOFx1MzBFOVx1MzBGQ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjbGFzcyBLaW50b25lUXVlcnlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJLaW50b25lUXVlcnlFcnJvclwiO1xuICB9XG59XG4iLCAiLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTZWxlY3RTdGF0ZW1lbnQgQVNUIFx1MjE5MiBraW50b25lIEdFVCAvay92MS9yZWNvcmRzIFx1MzBEMVx1MzBFOVx1MzBFMVx1MzBGQ1x1MzBCRlx1NTkwOVx1NjNEQlxuLy9cbi8vIFx1MzAwQ1x1NTM1OFx1N0QxNCBTRUxFQ1RcdTMwMERcdUZGMDhKT0lOIC8gR1JPVVAgQlkgXHUzMDZBXHUzMDU3XHVGRjA5XHUzMDZFXHU1ODM0XHU1NDA4XHUzMDZFXHUzMDdGIGtpbnRvbmUgXHUzMEFGXHUzMEE4XHUzMEVBXHUzMDZCXHU1OTA5XHU2M0RCXHUzMDY3XHUzMDREXHUzMDhCXHUzMDAyXG4vLyBKT0lOIC8gR1JPVVAgQlkgXHUzMDRDXHUzMDQyXHUzMDhCXHU1ODM0XHU1NDA4XHUzMDZGXHU1MTY4XHU0RUY2XHU1M0Q2XHU1Rjk3XHUzMDU3XHUzMDY2IEpTIFx1NTA3NFx1MzA2N1x1NTFFNlx1NzQwNlx1MzA1OVx1MzA4Qlx1MzA1Rlx1MzA4MVx1MzAwMVxuLy8gXHUzMDUzXHUzMDZFXHU5NUEyXHU2NTcwXHUzMDZGXHU1NDdDXHUzMDczXHU1MUZBXHUzMDU1XHUzMDVBIGZldGNoQWxsKCkgXHUzMDkyXHU0RjdGXHUzMDQ2XHUzMDAyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW1wb3J0IHR5cGUgeyBTZWxlY3RTdGF0ZW1lbnQsIFNlbGVjdENvbHVtbiwgT3JkZXJCeUl0ZW0gfSBmcm9tIFwiLi4vdHlwZXMvYXN0XCI7XG5pbXBvcnQgeyB3aGVyZVRvS2ludG9uZSB9IGZyb20gXCIuL3doZXJlVG9LaW50b25lXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8ga2ludG9uZSBHRVQgXHUzMEQxXHUzMEU5XHUzMEUxXHUzMEZDXHUzMEJGXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBLaW50b25lR2V0UGFyYW1zIHtcbiAgYXBwOiBudW1iZXI7XG4gIHF1ZXJ5OiBzdHJpbmc7ICAgICAgICAgLy8ga2ludG9uZSBcdTMwQUZcdTMwQThcdTMwRUFcdTY1ODdcdTVCNTdcdTUyMTdcbiAgZmllbGRzOiBzdHJpbmdbXTsgICAgICAvLyBcdTUzRDZcdTVGOTdcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTRFMDBcdTg5QTdcdUZGMDhcdTdBN0EgPSBcdTUxNjhcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdUZGMDlcbiAgdG90YWxDb3VudDogYm9vbGVhbjtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBcdTU5MDlcdTYzREJcdTMwRTJcdTMwRkNcdTMwQzlcdTUyMjRcdTVCOUFcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgdHlwZSBTZWxlY3RNb2RlID1cbiAgfCBcIlNJTVBMRVwiICAgICAvLyBraW50b25lIFx1MzBBRlx1MzBBOFx1MzBFQVx1MzA2Qlx1NzZGNFx1NjNBNVx1NTkwOVx1NjNEQlx1RkYwOEFQSSBcdTUwNzRcdTMwNjdcdTMwQkRcdTMwRkNcdTMwQzhcdTMwRkJcdTRFRjZcdTY1NzBcdTUyMzZcdTk2NTBcdUZGMDlcbiAgfCBcIkZVTExfU0NBTlwiOyAvLyBcdTUxNjhcdTRFRjZcdTUzRDZcdTVGOTcgXHUyMTkyIEpTIFx1NTA3NFx1MzA2NyBHUk9VUCBCWSAvIEpPSU4gLyBESVNUSU5DVCBcdTUxRTZcdTc0MDZcblxuLyoqXG4gKiBTRUxFQ1QgXHU2NTg3XHUzMDRDIFNJTVBMRSBcdTMwRTJcdTMwRkNcdTMwQzlcdTMwNEIgRlVMTF9TQ0FOIFx1MzBFMlx1MzBGQ1x1MzBDOVx1MzA0Qlx1MzA5Mlx1NTIyNFx1NUI5QVx1MzA1OVx1MzA4Qlx1MzAwMlxuICpcbiAqIEZVTExfU0NBTiBcdTMwNkJcdTMwNkFcdTMwOEJcdTY3NjFcdTRFRjY6XG4gKiAgIC0gSk9JTiBcdTMwNEMgMSBcdTRFRjZcdTRFRTVcdTRFMEFcdTMwNDJcdTMwOEJcbiAqICAgLSBHUk9VUCBCWSBcdTMwNENcdTMwNDJcdTMwOEJcbiAqICAgLSBESVNUSU5DVCBcdTMwNENcdTMwNDJcdTMwOEJcbiAqICAgLSBcdTk2QzZcdThBMDhcdTk1QTJcdTY1NzBcdUZGMDhDT1VOVCAvIFNVTSBcdTdCNDlcdUZGMDlcdTMwNEMgU0VMRUNUIFx1NTNFNVx1MzA2Qlx1MzA0Mlx1MzA4QlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVNlbGVjdE1vZGUoc3RtdDogU2VsZWN0U3RhdGVtZW50KTogU2VsZWN0TW9kZSB7XG4gIGlmIChzdG10LmpvaW5zLmxlbmd0aCA+IDApIHJldHVybiBcIkZVTExfU0NBTlwiO1xuICBpZiAoc3RtdC5ncm91cEJ5Lmxlbmd0aCA+IDApIHJldHVybiBcIkZVTExfU0NBTlwiO1xuICBpZiAoc3RtdC5kaXN0aW5jdCkgcmV0dXJuIFwiRlVMTF9TQ0FOXCI7XG4gIGlmIChzdG10LmNvbHVtbnMuc29tZSgoYykgPT4gYy50eXBlID09PSBcIkFHR1JFR0FURVwiKSkgcmV0dXJuIFwiRlVMTF9TQ0FOXCI7XG4gIHJldHVybiBcIlNJTVBMRVwiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNJTVBMRSBcdTMwRTJcdTMwRkNcdTMwQzk6IGtpbnRvbmUgR0VUIFx1MzBEMVx1MzBFOVx1MzBFMVx1MzBGQ1x1MzBCRlx1MzA3OFx1NTkwOVx1NjNEQlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogU0lNUExFIFx1MzBFMlx1MzBGQ1x1MzBDOVx1MzA2RSBTRUxFQ1QgXHU2NTg3XHUzMDkyIGtpbnRvbmUgR0VUIFx1MzBEMVx1MzBFOVx1MzBFMVx1MzBGQ1x1MzBCRlx1MzA2Qlx1NTkwOVx1NjNEQlx1MzA1OVx1MzA4Qlx1MzAwMlxuICogRlVMTF9TQ0FOIFx1MzA2RVx1NTgzNFx1NTQwOFx1MzA2Rlx1NTQ3Q1x1MzA3M1x1NTFGQVx1MzA1N1x1NTE0M1x1MzA2N1x1MzBBOFx1MzBFOVx1MzBGQ1x1MzBGQlx1MzA3RVx1MzA1Rlx1MzA2RiBmZXRjaEFsbCgpIFx1MzA2Qlx1NTIwN1x1MzA4QVx1NjZGRlx1MzA0OFx1MzA4Qlx1MzA1M1x1MzA2OFx1MzAwMlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VsZWN0VG9LaW50b25lUGFyYW1zKHN0bXQ6IFNlbGVjdFN0YXRlbWVudCk6IEtpbnRvbmVHZXRQYXJhbXMge1xuICBjb25zdCBxdWVyeVBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIFdIRVJFXG4gIGlmIChzdG10LndoZXJlICE9PSBudWxsKSB7XG4gICAgcXVlcnlQYXJ0cy5wdXNoKHdoZXJlVG9LaW50b25lKHN0bXQud2hlcmUpKTtcbiAgfVxuXG4gIC8vIE9SREVSIEJZXG4gIGlmIChzdG10Lm9yZGVyQnkubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG9yZGVyU3RyID0gc3RtdC5vcmRlckJ5Lm1hcChjb252ZXJ0T3JkZXJCeSkuam9pbihcIiwgXCIpO1xuICAgIHF1ZXJ5UGFydHMucHVzaChgb3JkZXIgYnkgJHtvcmRlclN0cn1gKTtcbiAgfVxuXG4gIC8vIExJTUlUIC8gT0ZGU0VUXG4gIGlmIChzdG10LmxpbWl0ICE9PSBudWxsKSB7XG4gICAgcXVlcnlQYXJ0cy5wdXNoKGBsaW1pdCAke3N0bXQubGltaXR9YCk7XG4gIH1cbiAgaWYgKHN0bXQub2Zmc2V0ICE9PSBudWxsKSB7XG4gICAgcXVlcnlQYXJ0cy5wdXNoKGBvZmZzZXQgJHtzdG10Lm9mZnNldH1gKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgYXBwOiBzdG10LmZyb20uYXBwSWQsXG4gICAgcXVlcnk6IHF1ZXJ5UGFydHMuam9pbihcIiBcIiksXG4gICAgZmllbGRzOiBleHRyYWN0RmllbGRzKHN0bXQuY29sdW1ucyksXG4gICAgdG90YWxDb3VudDogZmFsc2UsXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRlVMTF9TQ0FOIFx1MzBFMlx1MzBGQ1x1MzBDOTogXHU1MTY4XHU0RUY2XHU1M0Q2XHU1Rjk3XHU3NTI4XHUzMDZFXHU2NzAwXHU1QzBGXHUzMEQxXHUzMEU5XHUzMEUxXHUzMEZDXHUzMEJGXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBGVUxMX1NDQU4gXHU3NTI4OiBXSEVSRSBcdTMwNjBcdTMwNTFcdTMwOTIga2ludG9uZSBcdTMwQUZcdTMwQThcdTMwRUFcdTMwNkJcdTU5MDlcdTYzREJcdTMwNTdcdTUxNjhcdTRFRjZcdTUzRDZcdTVGOTdcdTMwNTlcdTMwOEJcdTMwMDJcbiAqIE9SREVSIEJZIC8gTElNSVQgXHUzMDZGIEpTIFx1NTA3NFx1MzA2N1x1NTFFNlx1NzQwNlx1MzA1OVx1MzA4Qlx1MzA1Rlx1MzA4MVx1NTQyQlx1MzA4MVx1MzA2QVx1MzA0NFx1MzAwMlxuICogXHUzMERBXHUzMEZDXHUzMEI4XHUzMEYzXHUzMEIwXHVGRjA4bGltaXQgNTAwIG9mZnNldCBOXHVGRjA5XHUzMDZGXHU1NDdDXHUzMDczXHU1MUZBXHUzMDU3XHU1MTQzXHUzMDZFIGZldGNoQWxsKCkgXHUzMDRDXHU0RUQ4XHU0RTBFXHUzMDU5XHUzMDhCXHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWxlY3RUb0ZldGNoQWxsUGFyYW1zKFxuICBzdG10OiBTZWxlY3RTdGF0ZW1lbnQsXG4gIGFwcElkOiBudW1iZXJcbik6IE9taXQ8S2ludG9uZUdldFBhcmFtcywgXCJ0b3RhbENvdW50XCI+IHtcbiAgY29uc3QgcXVlcnlQYXJ0czogc3RyaW5nW10gPSBbXTtcblxuICBpZiAoc3RtdC53aGVyZSAhPT0gbnVsbCkge1xuICAgIHF1ZXJ5UGFydHMucHVzaCh3aGVyZVRvS2ludG9uZShzdG10LndoZXJlKSk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGFwcDogYXBwSWQsXG4gICAgcXVlcnk6IHF1ZXJ5UGFydHMuam9pbihcIiBcIiksXG4gICAgZmllbGRzOiBbXSwgIC8vIFx1NTE2OFx1NEVGNlx1NTNENlx1NUY5N1x1MzA2QVx1MzA2RVx1MzA2N1x1NTE2OFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1MzA5Mlx1NTNENlx1NUY5N1x1MzA1OVx1MzA4QlxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBEOFx1MzBFQlx1MzBEMVx1MzBGQ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogT1JERVIgQlkgXHUzMEEyXHUzMEE0XHUzMEM2XHUzMEUwXHUzMDkyIGtpbnRvbmUgXHUzMEFGXHUzMEE4XHUzMEVBXHU1RjYyXHU1RjBGXHUzMDZCXHU1OTA5XHU2M0RCXHUzMDAyXG4gKiBcdTRGOEI6IHsgZmllbGQ6IFwiXHU0RjVDXHU2MjEwXHU2NUU1XCIsIGRpcmVjdGlvbjogXCJERVNDXCIgfSBcdTIxOTIgXCJcdTRGNUNcdTYyMTBcdTY1RTUgZGVzY1wiXG4gKi9cbmZ1bmN0aW9uIGNvbnZlcnRPcmRlckJ5KGl0ZW06IE9yZGVyQnlJdGVtKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gaXRlbS5kaXJlY3Rpb24gPT09IFwiQVNDXCIgPyBcImFzY1wiIDogXCJkZXNjXCI7XG4gIHJldHVybiBgJHtpdGVtLmZpZWxkfSAke2Rpcn1gO1xufVxuXG4vKipcbiAqIFNFTEVDVCBcdTUzRTVcdTMwNEJcdTMwODlcdTUzRDZcdTVGOTdcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTRFMDBcdTg5QTdcdTMwOTJcdTYyQkRcdTUxRkFcdTMwNTlcdTMwOEJcdTMwMDJcbiAqIFNFTEVDVCAqIFx1MzA4NFx1OTZDNlx1OEEwOFx1OTVBMlx1NjU3MFx1MzA2RVx1NTgzNFx1NTQwOFx1MzA2Rlx1N0E3QVx1OTE0RFx1NTIxN1x1RkYwOGtpbnRvbmUgPSBcdTUxNjhcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTUzRDZcdTVGOTdcdUZGMDlcdTMwMDJcbiAqL1xuZnVuY3Rpb24gZXh0cmFjdEZpZWxkcyhjb2x1bW5zOiBTZWxlY3RDb2x1bW5bXSk6IHN0cmluZ1tdIHtcbiAgLy8gKiBcdTMwN0VcdTMwNUZcdTMwNkZcdTk2QzZcdThBMDhcdTk1QTJcdTY1NzBcdTMwNENcdTU0MkJcdTMwN0VcdTMwOENcdTMwOEJcdTU4MzRcdTU0MDhcdTMwNkZcdTUxNjhcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTUzRDZcdTVGOTdcbiAgY29uc3QgaGFzV2lsZGNhcmQgPSBjb2x1bW5zLnNvbWUoXG4gICAgKGMpID0+IGMudHlwZSA9PT0gXCJXSUxEQ0FSRFwiIHx8IGMudHlwZSA9PT0gXCJBR0dSRUdBVEVcIlxuICApO1xuICBpZiAoaGFzV2lsZGNhcmQpIHJldHVybiBbXTtcblxuICByZXR1cm4gY29sdW1uc1xuICAgIC5maWx0ZXIoKGMpOiBjIGlzIEV4dHJhY3Q8U2VsZWN0Q29sdW1uLCB7IHR5cGU6IFwiRklFTERcIiB9PiA9PlxuICAgICAgYy50eXBlID09PSBcIkZJRUxEXCJcbiAgICApXG4gICAgLm1hcCgoYykgPT4gYy5maWVsZCk7XG59XG4iLCAiLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBJTlNFUlQgLyBVUERBVEUgLyBERUxFVEUgQVNUIFx1MjE5MiBraW50b25lIEFQSSBcdTMwRUFcdTMwQUZcdTMwQThcdTMwQjlcdTMwQzhcdTU5MDlcdTYzREJcbi8vXG4vLyBraW50b25lIEFQSSBcdTMwQThcdTMwRjNcdTMwQzlcdTMwRERcdTMwQTRcdTMwRjNcdTMwQzg6XG4vLyAgIElOU0VSVCBcdTIxOTIgUE9TVCAgIC9rL3YxL3JlY29yZHMuanNvbiAgIChcdTY3MDBcdTU5MjcgMTAwIFx1NEVGNi9cdTMwRUFcdTMwQUZcdTMwQThcdTMwQjlcdTMwQzgpXG4vLyAgIFVQREFURSBcdTIxOTIgR0VUICAgIC9rL3YxL3JlY29yZHMuanNvblx1RkYwOFx1NUJGRVx1OEM2MSAkaWQgXHU1M0Q2XHU1Rjk3XHVGRjA5XG4vLyAgICAgICAgICAgIFBVVCAgICAvay92MS9yZWNvcmRzLmpzb25cbi8vICAgREVMRVRFIFx1MjE5MiBHRVQgICAgL2svdjEvcmVjb3Jkcy5qc29uXHVGRjA4XHU1QkZFXHU4QzYxICRpZCBcdTUzRDZcdTVGOTdcdUZGMDlcbi8vICAgICAgICAgICAgREVMRVRFIC9rL3YxL3JlY29yZHMuanNvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmltcG9ydCB0eXBlIHtcbiAgSW5zZXJ0U3RhdGVtZW50LFxuICBVcGRhdGVTdGF0ZW1lbnQsXG4gIERlbGV0ZVN0YXRlbWVudCxcbiAgU3FsVmFsdWUsXG4gIEFyaXRoRXhwcixcbiAgQXJpdGhPcGVyYW5kLFxufSBmcm9tIFwiLi4vdHlwZXMvYXN0XCI7XG5pbXBvcnQgeyB3aGVyZVRvS2ludG9uZSB9IGZyb20gXCIuL3doZXJlVG9LaW50b25lXCI7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8ga2ludG9uZSBBUEkgXHUzMEVBXHUzMEFGXHUzMEE4XHUzMEI5XHUzMEM4XHU1NzhCXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqIGtpbnRvbmUgXHUzMEVDXHUzMEIzXHUzMEZDXHUzMEM5XHUzMDZFXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHU1MDI0ICovXG5leHBvcnQgaW50ZXJmYWNlIEtpbnRvbmVGaWVsZFZhbHVlIHtcbiAgdmFsdWU6IHN0cmluZzsgICAvLyBraW50b25lIEFQSSBcdTMwNkZcdTMwNTlcdTMwNzlcdTMwNjZcdTY1ODdcdTVCNTdcdTUyMTdcdTMwNjdcdTkwMDFcdTMwOEJcbn1cblxuZXhwb3J0IHR5cGUgS2ludG9uZVJlY29yZCA9IFJlY29yZDxzdHJpbmcsIEtpbnRvbmVGaWVsZFZhbHVlPjtcblxuLy8gLS0tIFBPU1RcdUZGMDhJTlNFUlRcdUZGMDktLS1cblxuZXhwb3J0IGludGVyZmFjZSBLaW50b25lUG9zdFBhcmFtcyB7XG4gIGFwcDogbnVtYmVyO1xuICByZWNvcmRzOiBLaW50b25lUmVjb3JkW107XG59XG5cbi8vIC0tLSBQVVRcdUZGMDhVUERBVEVcdUZGMDktLS1cblxuZXhwb3J0IGludGVyZmFjZSBLaW50b25lVXBkYXRlUmVjb3JkIHtcbiAgaWQ6IG51bWJlcjtcbiAgcmVjb3JkOiBLaW50b25lUmVjb3JkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEtpbnRvbmVQdXRQYXJhbXMge1xuICBhcHA6IG51bWJlcjtcbiAgcmVjb3JkczogS2ludG9uZVVwZGF0ZVJlY29yZFtdO1xufVxuXG4vLyAtLS0gREVMRVRFIC0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIEtpbnRvbmVEZWxldGVQYXJhbXMge1xuICBhcHA6IG51bWJlcjtcbiAgaWRzOiBudW1iZXJbXTtcbn1cblxuLy8gLS0tIEdFVFx1RkYwOFVQREFURSAvIERFTEVURSBcdTMwNkVcdTRFOEJcdTUyNERcdTUzRDZcdTVGOTdcdUZGMDktLS1cblxuZXhwb3J0IGludGVyZmFjZSBLaW50b25lR2V0Rm9yRG1sUGFyYW1zIHtcbiAgYXBwOiBudW1iZXI7XG4gIHF1ZXJ5OiBzdHJpbmc7XG4gIGZpZWxkczogc3RyaW5nW107ICAgLy8gXHU5MDFBXHU1RTM4XHUzMDZGIFtcIiRpZFwiXVx1MzAwMVx1N0I5N1x1ODg1M1x1NUYwRlx1MzA0Mlx1MzA4QVx1MzA2Rlx1NTNDMlx1NzE2N1x1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1MzA4Mlx1NTQyQlx1MzA4MFxuICB0b3RhbENvdW50OiBmYWxzZTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBJTlNFUlQgXHUyMTkyIFBPU1QgXHUzMEQwXHUzMEMzXHUzMEMxXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqIElOU0VSVCBcdTY1ODdcdTMwOTIga2ludG9uZSBQT1NUIFx1MzBFQVx1MzBBRlx1MzBBOFx1MzBCOVx1MzBDOFx1MzA2Qlx1NTkwOVx1NjNEQlx1MzA1OVx1MzA4Qlx1RkYwODEwMCBcdTRFRjZcdTMwNTRcdTMwNjhcdTMwNkJcdTUyMDZcdTUyNzJcdUZGMDlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpbnNlcnRUb1Bvc3RCYXRjaGVzKHN0bXQ6IEluc2VydFN0YXRlbWVudCk6IEtpbnRvbmVQb3N0UGFyYW1zW10ge1xuICBjb25zdCBhbGxSZWNvcmRzID0gc3RtdC52YWx1ZXMubWFwKChyb3cpID0+XG4gICAgYnVpbGRJbnNlcnRSZWNvcmQoc3RtdC5maWVsZHMsIHJvdylcbiAgKTtcbiAgcmV0dXJuIGNodW5rKGFsbFJlY29yZHMsIDEwMCkubWFwKChyZWNvcmRzKSA9PiAoe1xuICAgIGFwcDogc3RtdC5hcHBJZCxcbiAgICByZWNvcmRzLFxuICB9KSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkSW5zZXJ0UmVjb3JkKFxuICBmaWVsZHM6IHN0cmluZ1tdLFxuICByb3c6IEluc2VydFN0YXRlbWVudFtcInZhbHVlc1wiXVtudW1iZXJdXG4pOiBLaW50b25lUmVjb3JkIHtcbiAgY29uc3QgcmVjb3JkOiBLaW50b25lUmVjb3JkID0ge307XG4gIGZpZWxkcy5mb3JFYWNoKChmaWVsZCwgaSkgPT4ge1xuICAgIHJlY29yZFtmaWVsZF0gPSB7IHZhbHVlOiB0b0tpbnRvbmVWYWx1ZShyb3dbaV0pIH07XG4gIH0pO1xuICByZXR1cm4gcmVjb3JkO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFVQREFURSBcdTIxOTIgR0VUIFx1MzBBRlx1MzBBOFx1MzBFQSArIFBVVCBcdTMwRDFcdTMwRTlcdTMwRTFcdTMwRkNcdTMwQkZcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFVQREFURSBcdTMwNkUgV0hFUkUgXHU1M0U1XHUzMDRCXHUzMDg5XHUzMDAxXHU1QkZFXHU4QzYxXHUzMEVDXHUzMEIzXHUzMEZDXHUzMEM5XHUzMDZFICRpZCBcdTMwOTJcdTUzRDZcdTVGOTdcdTMwNTlcdTMwOEJcdTMwNUZcdTMwODFcdTMwNkVcbiAqIGtpbnRvbmUgR0VUIFx1MzBBRlx1MzBBOFx1MzBFQVx1MzA5Mlx1NzUxRlx1NjIxMFx1MzA1OVx1MzA4Qlx1MzAwMlxuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlVG9HZXRRdWVyeShzdG10OiBVcGRhdGVTdGF0ZW1lbnQpOiBLaW50b25lR2V0Rm9yRG1sUGFyYW1zIHtcbiAgcmV0dXJuIHtcbiAgICBhcHA6IHN0bXQuYXBwSWQsXG4gICAgcXVlcnk6IHdoZXJlVG9LaW50b25lKHN0bXQud2hlcmUpLFxuICAgIGZpZWxkczogW1wiJGlkXCJdLFxuICAgIHRvdGFsQ291bnQ6IGZhbHNlLFxuICB9O1xufVxuXG4vKipcbiAqIFx1NTNENlx1NUY5N1x1MzA1N1x1MzA1RiAkaWQgXHUzMEVBXHUzMEI5XHUzMEM4XHUzMDY4IFVQREFURSBcdTUxODVcdTVCQjlcdTMwNEJcdTMwODkga2ludG9uZSBQVVQgXHUzMEQxXHUzMEU5XHUzMEUxXHUzMEZDXHUzMEJGXHUzMDkyXHU3NTFGXHU2MjEwXHUzMDU5XHUzMDhCXHUzMDAyXG4gKiAxMDAgXHU0RUY2XHUzMDU0XHUzMDY4XHUzMDZCXHU1MjA2XHU1MjcyXHUzMDU3XHUzMDY2XHU4RkQ0XHUzMDU5XHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVUb1B1dEJhdGNoZXMoXG4gIHN0bXQ6IFVwZGF0ZVN0YXRlbWVudCxcbiAgaWRzOiBudW1iZXJbXVxuKTogS2ludG9uZVB1dFBhcmFtc1tdIHtcbiAgY29uc3QgcmVjb3JkID0gYnVpbGRVcGRhdGVSZWNvcmQoc3RtdC5hc3NpZ25tZW50cyk7XG4gIHJldHVybiBjaHVuayhpZHMsIDEwMCkubWFwKChiYXRjaCkgPT4gKHtcbiAgICBhcHA6IHN0bXQuYXBwSWQsXG4gICAgcmVjb3JkczogYmF0Y2gubWFwKChpZCkgPT4gKHsgaWQsIHJlY29yZCB9KSksXG4gIH0pKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRVcGRhdGVSZWNvcmQoXG4gIGFzc2lnbm1lbnRzOiBVcGRhdGVTdGF0ZW1lbnRbXCJhc3NpZ25tZW50c1wiXVxuKTogS2ludG9uZVJlY29yZCB7XG4gIGNvbnN0IHJlY29yZDogS2ludG9uZVJlY29yZCA9IHt9O1xuICBmb3IgKGNvbnN0IHsgZmllbGQsIHZhbHVlIH0gb2YgYXNzaWdubWVudHMpIHtcbiAgICAvLyBBcml0aEV4cHIgXHUzMDZGIHVwZGF0ZVRvUHV0QmF0Y2hlc0FyaXRoIFx1MzA2N1x1NTFFNlx1NzQwNlx1MzA1OVx1MzA4Qlx1MzA1Rlx1MzA4MVx1MzAwMVx1MzA1M1x1MzA1M1x1MzA2Qlx1MzA2Rlx1NTIzMFx1OTA1NFx1MzA1N1x1MzA2QVx1MzA0NFxuICAgIGlmICh2YWx1ZS50eXBlID09PSBcIkFSSVRIXCIpIGNvbnRpbnVlO1xuICAgIHJlY29yZFtmaWVsZF0gPSB7IHZhbHVlOiB0b0tpbnRvbmVWYWx1ZSh2YWx1ZSkgfTtcbiAgfVxuICByZXR1cm4gcmVjb3JkO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFVQREFURVx1RkYwOFx1N0I5N1x1ODg1M1x1NUYwRlx1MzA0Mlx1MzA4QVx1RkYwOVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogXHUzMDQ0XHUzMDVBXHUzMDhDXHUzMDRCXHUzMDZFIGFzc2lnbm1lbnQgXHUzMDRDXHU3Qjk3XHU4ODUzXHU1RjBGXHVGRjA4QXJpdGhFeHByXHVGRjA5XHUzMDkyXHU1NDJCXHUzMDgwXHUzMDRCXHU1MjI0XHU1QjlBXHUzMDU5XHUzMDhCXHUzMDAyXG4gKiB0cnVlIFx1MzA2RVx1NTgzNFx1NTQwOFx1MzAwMVVQREFURSBcdTMwNkZcdTMwMENcdTczRkVcdTU3MjhcdTUwMjRcdTUzRDZcdTVGOTcgXHUyMTkyIFx1OEEwOFx1N0I5NyBcdTIxOTIgUFVUXHUzMDBEXHUzMDZFIDIgXHUzMEQ1XHUzMEE3XHUzMEZDXHUzMEJBXHUzMDY3XHU1QjlGXHU4ODRDXHUzMDU5XHUzMDhCXHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNBcml0aEFzc2lnbm1lbnQoc3RtdDogVXBkYXRlU3RhdGVtZW50KTogYm9vbGVhbiB7XG4gIHJldHVybiBzdG10LmFzc2lnbm1lbnRzLnNvbWUoKGEpID0+IGEudmFsdWUudHlwZSA9PT0gXCJBUklUSFwiKTtcbn1cblxuLyoqXG4gKiBcdTdCOTdcdTg4NTNcdTVGMEYgVVBEQVRFIFx1NzUyOFx1MzA2RSBHRVQgXHUzMEFGXHUzMEE4XHUzMEVBXHUzMDkyXHU3NTFGXHU2MjEwXHUzMDU5XHUzMDhCXHUzMDAyXG4gKiAkaWQgXHUzMDZCXHU1MkEwXHUzMDQ4XHUzMDY2XHUzMDAxXHU3Qjk3XHU4ODUzXHU1RjBGXHUzMDY3XHU1M0MyXHU3MTY3XHUzMDU1XHUzMDhDXHUzMDhCXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHU1NDBEXHUzMDgyXHU1M0Q2XHU1Rjk3XHU1QkZFXHU4QzYxXHUzMDZCXHU1NDJCXHUzMDgxXHUzMDhCXHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVUb0dldFF1ZXJ5Rm9yQXJpdGgoc3RtdDogVXBkYXRlU3RhdGVtZW50KTogS2ludG9uZUdldEZvckRtbFBhcmFtcyB7XG4gIGNvbnN0IHJlZkZpZWxkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHsgdmFsdWUgfSBvZiBzdG10LmFzc2lnbm1lbnRzKSB7XG4gICAgaWYgKHZhbHVlLnR5cGUgPT09IFwiQVJJVEhcIikge1xuICAgICAgY29sbGVjdEFyaXRoRmllbGRzKHZhbHVlLCByZWZGaWVsZHMpO1xuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIGFwcDogc3RtdC5hcHBJZCxcbiAgICBxdWVyeTogd2hlcmVUb0tpbnRvbmUoc3RtdC53aGVyZSksXG4gICAgZmllbGRzOiBbXCIkaWRcIiwgLi4ucmVmRmllbGRzXSxcbiAgICB0b3RhbENvdW50OiBmYWxzZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gY29sbGVjdEFyaXRoRmllbGRzKGV4cHI6IEFyaXRoRXhwciwgb3V0OiBTZXQ8c3RyaW5nPik6IHZvaWQge1xuICBpZiAoZXhwci5sZWZ0LnR5cGUgPT09IFwiRklFTERfUkVGXCIpICBvdXQuYWRkKGV4cHIubGVmdC5maWVsZCk7XG4gIGlmIChleHByLnJpZ2h0LnR5cGUgPT09IFwiRklFTERfUkVGXCIpIG91dC5hZGQoZXhwci5yaWdodC5maWVsZCk7XG59XG5cbi8qKlxuICogXHU3Qjk3XHU4ODUzXHU1RjBGIFVQREFURSBcdTc1MjhcdTMwNkUgUFVUIFx1MzBEMFx1MzBDM1x1MzBDMVx1MzA5Mlx1NzUxRlx1NjIxMFx1MzA1OVx1MzA4Qlx1MzAwMlxuICogcmVjb3JkcyBcdTMwNkYgR0VUIFx1MzA2N1x1NTNENlx1NUY5N1x1MzA1N1x1MzA1Rlx1NzUxRlx1MzBFQ1x1MzBCM1x1MzBGQ1x1MzBDOVx1RkYwOFx1NTQwNFx1MzBFQ1x1MzBCM1x1MzBGQ1x1MzBDOVx1MzA2QiAkaWQgXHUzMDY4XHU1M0MyXHU3MTY3XHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHUzMDRDXHU1NDJCXHUzMDdFXHUzMDhDXHUzMDhCXHVGRjA5XHUzMDAyXG4gKiBcdTdCOTdcdTg4NTNcdTVGMEZcdTMwNkZcdTU0MDRcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzlcdTMwNkVcdTczRkVcdTU3MjhcdTUwMjRcdTMwOTJcdTRGN0ZcdTMwNjNcdTMwNjZcdThBNTVcdTRGQTFcdTMwNTlcdTMwOEJcdTMwMDJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVRvUHV0QmF0Y2hlc0FyaXRoKFxuICBzdG10OiBVcGRhdGVTdGF0ZW1lbnQsXG4gIHJlY29yZHM6IEtpbnRvbmVSZWNvcmRbXVxuKTogS2ludG9uZVB1dFBhcmFtc1tdIHtcbiAgY29uc3QgdXBkYXRlUmVjb3JkczogS2ludG9uZVVwZGF0ZVJlY29yZFtdID0gcmVjb3Jkcy5tYXAoKHJhdykgPT4ge1xuICAgIGNvbnN0IGlkID0gTnVtYmVyKHJhd1tcIiRpZFwiXS52YWx1ZSk7XG4gICAgY29uc3QgcmVjb3JkOiBLaW50b25lUmVjb3JkID0ge307XG4gICAgZm9yIChjb25zdCB7IGZpZWxkLCB2YWx1ZSB9IG9mIHN0bXQuYXNzaWdubWVudHMpIHtcbiAgICAgIGlmICh2YWx1ZS50eXBlID09PSBcIkFSSVRIXCIpIHtcbiAgICAgICAgcmVjb3JkW2ZpZWxkXSA9IHsgdmFsdWU6IFN0cmluZyhldmFsQXJpdGgodmFsdWUsIHJhdykpIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWNvcmRbZmllbGRdID0geyB2YWx1ZTogdG9LaW50b25lVmFsdWUodmFsdWUpIH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IGlkLCByZWNvcmQgfTtcbiAgfSk7XG4gIHJldHVybiBjaHVuayh1cGRhdGVSZWNvcmRzLCAxMDApLm1hcCgoYmF0Y2gpID0+ICh7XG4gICAgYXBwOiBzdG10LmFwcElkLFxuICAgIHJlY29yZHM6IGJhdGNoLFxuICB9KSk7XG59XG5cbmZ1bmN0aW9uIGV2YWxBcml0aChleHByOiBBcml0aEV4cHIsIHJhdzogS2ludG9uZVJlY29yZCk6IG51bWJlciB7XG4gIGNvbnN0IGwgPSByZXNvbHZlQXJpdGhPcGVyYW5kKGV4cHIubGVmdCwgcmF3KTtcbiAgY29uc3QgciA9IHJlc29sdmVBcml0aE9wZXJhbmQoZXhwci5yaWdodCwgcmF3KTtcbiAgc3dpdGNoIChleHByLm9wKSB7XG4gICAgY2FzZSBcIitcIjogcmV0dXJuIGwgKyByO1xuICAgIGNhc2UgXCItXCI6IHJldHVybiBsIC0gcjtcbiAgICBjYXNlIFwiKlwiOiByZXR1cm4gbCAqIHI7XG4gICAgY2FzZSBcIi9cIjpcbiAgICAgIGlmIChyID09PSAwKSB0aHJvdyBuZXcgRG1sQ29udmVydEVycm9yKFwiXHU3Qjk3XHU4ODUzXHU1RjBGXHUzMDY3XHUzMEJDXHUzMEVEXHU5NjY0XHU3Qjk3XHUzMDRDXHU3NjdBXHU3NTFGXHUzMDU3XHUzMDdFXHUzMDU3XHUzMDVGXCIpO1xuICAgICAgcmV0dXJuIGwgLyByO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVBcml0aE9wZXJhbmQob3BlcmFuZDogQXJpdGhPcGVyYW5kLCByYXc6IEtpbnRvbmVSZWNvcmQpOiBudW1iZXIge1xuICBpZiAob3BlcmFuZC50eXBlID09PSBcIk5VTUJFUlwiKSByZXR1cm4gb3BlcmFuZC52YWx1ZTtcbiAgY29uc3QgZmllbGRWYWwgPSByYXdbb3BlcmFuZC5maWVsZF0/LnZhbHVlID8/IFwiXCI7XG4gIGNvbnN0IG4gPSBOdW1iZXIoZmllbGRWYWwpO1xuICBpZiAoTnVtYmVyLmlzTmFOKG4pKSB7XG4gICAgdGhyb3cgbmV3IERtbENvbnZlcnRFcnJvcihcbiAgICAgIGBcdTdCOTdcdTg4NTNcdTVGMEZcdTMwNkVcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzkgXCIke29wZXJhbmQuZmllbGR9XCIgXHUzMDZFXHU1MDI0IFwiJHtmaWVsZFZhbH1cIiBcdTMwNkZcdTY1NzBcdTUwMjRcdTMwNjdcdTMwNkZcdTMwNDJcdTMwOEFcdTMwN0VcdTMwNUJcdTMwOTNgXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbjtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBERUxFVEUgXHUyMTkyIEdFVCBcdTMwQUZcdTMwQThcdTMwRUEgKyBERUxFVEUgXHUzMEQxXHUzMEU5XHUzMEUxXHUzMEZDXHUzMEJGXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBERUxFVEUgXHUzMDZFIFdIRVJFIFx1NTNFNVx1MzA0Qlx1MzA4OVx1MzAwMVx1NUJGRVx1OEM2MVx1MzBFQ1x1MzBCM1x1MzBGQ1x1MzBDOVx1MzA2RSAkaWQgXHUzMDkyXHU1M0Q2XHU1Rjk3XHUzMDU5XHUzMDhCXHUzMDVGXHUzMDgxXHUzMDZFXG4gKiBraW50b25lIEdFVCBcdTMwQUZcdTMwQThcdTMwRUFcdTMwOTJcdTc1MUZcdTYyMTBcdTMwNTlcdTMwOEJcdTMwMDJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZVRvR2V0UXVlcnkoc3RtdDogRGVsZXRlU3RhdGVtZW50KTogS2ludG9uZUdldEZvckRtbFBhcmFtcyB7XG4gIHJldHVybiB7XG4gICAgYXBwOiBzdG10LmFwcElkLFxuICAgIHF1ZXJ5OiB3aGVyZVRvS2ludG9uZShzdG10LndoZXJlKSxcbiAgICBmaWVsZHM6IFtcIiRpZFwiXSxcbiAgICB0b3RhbENvdW50OiBmYWxzZSxcbiAgfTtcbn1cblxuLyoqXG4gKiBcdTUzRDZcdTVGOTdcdTMwNTdcdTMwNUYgJGlkIFx1MzBFQVx1MzBCOVx1MzBDOFx1MzA0Qlx1MzA4OSBraW50b25lIERFTEVURSBcdTMwRDFcdTMwRTlcdTMwRTFcdTMwRkNcdTMwQkZcdTMwOTJcdTc1MUZcdTYyMTBcdTMwNTlcdTMwOEJcdTMwMDJcbiAqIDEwMCBcdTRFRjZcdTMwNTRcdTMwNjhcdTMwNkJcdTUyMDZcdTUyNzJcdTMwNTdcdTMwNjZcdThGRDRcdTMwNTlcdUZGMDhraW50b25lIFx1MzA2RVx1NEUwMFx1NjJFQ1x1NTI0QVx1OTY2NFx1NEUwQVx1OTY1MFx1MzA2Qlx1NTQwOFx1MzA4Rlx1MzA1Qlx1MzA4Qlx1RkYwOVx1MzAwMlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlVG9EZWxldGVCYXRjaGVzKFxuICBhcHBJZDogbnVtYmVyLFxuICBpZHM6IG51bWJlcltdXG4pOiBLaW50b25lRGVsZXRlUGFyYW1zW10ge1xuICByZXR1cm4gY2h1bmsoaWRzLCAxMDApLm1hcCgoYmF0Y2gpID0+ICh7IGFwcDogYXBwSWQsIGlkczogYmF0Y2ggfSkpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1NTE3MVx1OTAxQVx1MzBEOFx1MzBFQlx1MzBEMVx1MzBGQ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogU3FsVmFsdWUgXHUzMDkyIGtpbnRvbmUgQVBJIFx1MzA0Q1x1NTNEN1x1MzA1MVx1NEVEOFx1MzA1MVx1MzA4Qlx1NjU4N1x1NUI1N1x1NTIxN1x1MzA2Qlx1NTkwOVx1NjNEQlx1MzA1OVx1MzA4Qlx1MzAwMlxuICpcbiAqIGtpbnRvbmUgXHUzMDZGXHU2NTcwXHU1MDI0XHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHUzMDZFXHU1MDI0XHUzMDgyXHU2NTg3XHU1QjU3XHU1MjE3XHUzMDY4XHUzMDU3XHUzMDY2XHU5MDAxXHU0RkUxXHUzMDU5XHUzMDhCXHUzMDAyXG4gKiBcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTU3OEJcdTYwQzVcdTU4MzFcdTMwNENcdTMwNkFcdTMwNDRcdTMwNUZcdTMwODFcdTMwMDFOdW1iZXJMaXRlcmFsIFx1MzA2Rlx1NjU4N1x1NUI1N1x1NTIxN1x1NTMxNlx1MzA1OVx1MzA4Qlx1MzAwMlxuICogS2ludG9uZUZ1bmN0aW9uXHVGRjA4VE9EQVkoKSBcdTdCNDlcdUZGMDlcdTMwNkYgV0hFUkUgXHU1QzAyXHU3NTI4XHUzMDY3XHUzMDQyXHUzMDhBIFNFVCAvIFZBTFVFUyBcdTMwNkJcdTMwNkZcdTUxRkFcdTczRkVcdTMwNTdcdTMwNkFcdTMwNDRcdTMwMDJcbiAqL1xuZnVuY3Rpb24gdG9LaW50b25lVmFsdWUodmFsdWU6IFNxbFZhbHVlKTogc3RyaW5nIHtcbiAgc3dpdGNoICh2YWx1ZS50eXBlKSB7XG4gICAgY2FzZSBcIlNUUklOR1wiOlxuICAgICAgcmV0dXJuIHZhbHVlLnZhbHVlO1xuICAgIGNhc2UgXCJOVU1CRVJcIjpcbiAgICAgIHJldHVybiBTdHJpbmcodmFsdWUudmFsdWUpO1xuICAgIGNhc2UgXCJLSU5UT05FX0ZVTkNcIjpcbiAgICAgIC8vIFZBTFVFUyAvIFNFVCBcdTMwNjdcdTMwNkZcdTRGN0ZcdTc1MjhcdTRFMERcdTUzRUZcdUZGMDhQYXJzZXIgXHUzMEVDXHUzMEQ5XHUzMEVCXHUzMDY3XHUzMDZGXHU4QTMxXHU1QkI5XHUzMDU3XHUzMDY2XHUzMDU3XHUzMDdFXHUzMDQ2XHUzMDVGXHUzMDgxXHU1QjlGXHU4ODRDXHU2NjQyXHUzMEMxXHUzMEE3XHUzMEMzXHUzMEFGXHVGRjA5XG4gICAgICB0aHJvdyBuZXcgRG1sQ29udmVydEVycm9yKFxuICAgICAgICBgJHt2YWx1ZS5uYW1lfSgpIFx1MzA2RiBJTlNFUlQgLyBVUERBVEUgXHUzMDZFXHU1MDI0XHUzMDY4XHUzMDU3XHUzMDY2XHU0RjdGXHU3NTI4XHUzMDY3XHUzMDREXHUzMDdFXHUzMDVCXHUzMDkzYFxuICAgICAgKTtcbiAgICBjYXNlIFwiSU5fTElTVFwiOlxuICAgICAgdGhyb3cgbmV3IERtbENvbnZlcnRFcnJvcihcbiAgICAgICAgXCJJTl9MSVNUIFx1MzA2RiBJTlNFUlQgLyBVUERBVEUgXHUzMDZFXHU1MDI0XHUzMDY4XHUzMDU3XHUzMDY2XHU0RjdGXHU3NTI4XHUzMDY3XHUzMDREXHUzMDdFXHUzMDVCXHUzMDkzXCJcbiAgICAgICk7XG4gIH1cbn1cblxuLyoqIFx1OTE0RFx1NTIxN1x1MzA5MiBuIFx1NEVGNlx1MzA1QVx1MzA2NFx1MzA2RVx1MzBDMVx1MzBFM1x1MzBGM1x1MzBBRlx1MzA2Qlx1NTIwNlx1NTI3Mlx1MzA1OVx1MzA4QiAqL1xuZnVuY3Rpb24gY2h1bms8VD4oYXJyOiBUW10sIHNpemU6IG51bWJlcik6IFRbXVtdIHtcbiAgY29uc3QgcmVzdWx0OiBUW11bXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyci5sZW5ndGg7IGkgKz0gc2l6ZSkge1xuICAgIHJlc3VsdC5wdXNoKGFyci5zbGljZShpLCBpICsgc2l6ZSkpO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmV4cG9ydCBjbGFzcyBEbWxDb252ZXJ0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiRG1sQ29udmVydEVycm9yXCI7XG4gIH1cbn1cbiIsICIvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIGZldGNoQWxsIFx1MjAxNCBraW50b25lIFx1NTE2OFx1NEVGNlx1NTNENlx1NUY5N1x1RkYwODUwMFx1NEVGNlx1MzA1NFx1MzA2OFx1MzA2RVx1MzBEQVx1MzBGQ1x1MzBCOFx1MzBGM1x1MzBCMFx1MzBFQlx1MzBGQ1x1MzBEN1x1RkYwOVxuLy9cbi8vIGtpbnRvbmUgQVBJIFx1NTIzNlx1N0QwNDpcbi8vICAgLSAxXHUzMEVBXHUzMEFGXHUzMEE4XHUzMEI5XHUzMEM4XHUzMDY3XHU1M0Q2XHU1Rjk3XHUzMDY3XHUzMDREXHUzMDhCXHU2NzAwXHU1OTI3XHU0RUY2XHU2NTcwOiA1MDBcdTRFRjZcbi8vICAgLSBcdTMwREFcdTMwRkNcdTMwQjhcdTMwRjNcdTMwQjBcdTMwNkYgcXVlcnkgXHU2NzJCXHU1QzNFXHUzMDZFIFwibGltaXQgNTAwIG9mZnNldCBOXCIgXHUzMDY3XHU1MjM2XHU1RkExXG4vLyAgIC0gdG90YWxDb3VudCBcdTMwOTJcdTRGN0ZcdTMwNDZcdTY1QjlcdTZDRDVcdTMwODJcdTMwNDJcdTMwOEJcdTMwNENcdTMwMDFcdTMwRUJcdTMwRkNcdTMwRDdcdTdENDJcdTRFODZcdTY3NjFcdTRFRjZcdTMwNkZcbi8vICAgICBcdTMwMENcdTUzRDZcdTVGOTdcdTRFRjZcdTY1NzAgPCA1MDBcdTMwMERcdTMwNjdcdTUyMjRcdTVCOUFcdTMwNTlcdTMwOEJcdTY1QjlcdTMwNEMgQVBJIFx1MzBCM1x1MzBGQ1x1MzBFQlx1NjU3MFx1MzA0Q1x1NUMxMVx1MzA2QVx1MzA0NFxuLy9cbi8vIFx1OEEyRFx1OEEwOFx1NjVCOVx1OTFERDpcbi8vICAgLSBraW50b25lLmFwaSgpIFx1MzA3OFx1MzA2RVx1NEY5RFx1NUI1OFx1MzA5Mlx1NzZGNFx1NjNBNVx1NjMwMVx1MzA1Rlx1MzA2QVx1MzA0NFxuLy8gICAtIFx1MzAwQzFcdTMwREFcdTMwRkNcdTMwQjhcdTUyMDZcdTMwOTJcdTUzRDZcdTVGOTdcdTMwNTlcdTMwOEJcdTk1QTJcdTY1NzBcdTMwMERcdTMwOTJcdTU5MTZcdTMwNEJcdTMwODlcdTZDRThcdTUxNjVcdUZGMDhGZXRjaGVyXHVGRjA5XG4vLyAgIC0gXHUzMEM2XHUzMEI5XHUzMEM4XHU1M0VGXHU4MEZEXHUzMEZCa2ludG9uZSBcdTc0QjBcdTU4ODNcdTU5MTZcdTMwNjdcdTMwODJcdTUzNThcdTRGNTNcdTMwQzZcdTMwQjlcdTMwQzhcdTMwNjdcdTMwNERcdTMwOEJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5pbXBvcnQgdHlwZSB7IEtpbnRvbmVSZWNvcmQgfSBmcm9tIFwiLi4vY29udmVydGVyL2RtbFRvS2ludG9uZVwiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1NTc4Qlx1NUI5QVx1N0ZBOVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBraW50b25lIEdFVCAvay92MS9yZWNvcmRzLmpzb24gXHUzMDZFXHUzMEVDXHUzMEI5XHUzMEREXHUzMEYzXHUzMEI5ICovXG5leHBvcnQgaW50ZXJmYWNlIEtpbnRvbmVHZXRSZXNwb25zZSB7XG4gIHJlY29yZHM6IEtpbnRvbmVSZWNvcmRbXTtcbn1cblxuLyoqIDFcdTMwREFcdTMwRkNcdTMwQjhcdTUyMDZcdTMwNkUgR0VUIFx1MzA5Mlx1NUI5Rlx1ODg0Q1x1MzA1OVx1MzA4Qlx1OTVBMlx1NjU3MCAqL1xuZXhwb3J0IHR5cGUgUGFnZUZldGNoZXIgPSAocGFyYW1zOiBQYWdlRmV0Y2hQYXJhbXMpID0+IFByb21pc2U8S2ludG9uZUdldFJlc3BvbnNlPjtcblxuZXhwb3J0IGludGVyZmFjZSBQYWdlRmV0Y2hQYXJhbXMge1xuICBhcHA6IG51bWJlcjtcbiAgcXVlcnk6IHN0cmluZzsgICAvLyBcIldIRVJFXHU1M0U1IG9yZGVyIGJ5IC4uLiBsaW1pdCA1MDAgb2Zmc2V0IE5cIiBcdTMwNkVcdTVGNjJcdTVGMEZcbiAgZmllbGRzOiBzdHJpbmdbXTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBmZXRjaEFsbCBcdTY3MkNcdTRGNTNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIEZldGNoQWxsT3B0aW9ucyB7XG4gIC8qKiAxXHUzMERBXHUzMEZDXHUzMEI4XHUzMDQyXHUzMDVGXHUzMDhBXHUzMDZFXHU1M0Q2XHU1Rjk3XHU0RUY2XHU2NTcwXHVGRjA4XHUzMEM3XHUzMEQ1XHUzMEE5XHUzMEVCXHUzMEM4OiA1MDBcdUZGMDkqL1xuICBwYWdlU2l6ZT86IG51bWJlcjtcbiAgLyoqIFx1NTE2OFx1NEVGNlx1NTNENlx1NUY5N1x1MzA2RVx1NEUwQVx1OTY1MFx1RkYwOFx1MzBDN1x1MzBENVx1MzBBOVx1MzBFQlx1MzBDODogMTBfMDAwXHVGRjA5XHUzMDAyXHU4RDg1XHUzMDQ4XHUzMDVGXHUzMDg5IEZldGNoQWxsTGltaXRFcnJvciAqL1xuICBtYXhSZWNvcmRzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIGtpbnRvbmUgXHUzMEEyXHUzMEQ3XHUzMEVBXHUzMDZFXHU1MTY4XHUzMEVDXHUzMEIzXHUzMEZDXHUzMEM5XHUzMDkyXHU1M0Q2XHU1Rjk3XHUzMDU3XHUzMDY2XHU4RkQ0XHUzMDU5XHUzMDAyXG4gKlxuICogQHBhcmFtIGZldGNoZXIgIDFcdTMwREFcdTMwRkNcdTMwQjhcdTUyMDZcdTMwOTJcdTUzRDZcdTVGOTdcdTMwNTlcdTMwOEJcdTk1QTJcdTY1NzBcdUZGMDhraW50b25lLmFwaSBcdTMwNkVcdTMwRTlcdTMwQzNcdTMwRDFcdTMwRkNcdTdCNDlcdUZGMDlcbiAqIEBwYXJhbSBhcHAgICAgICBcdTMwQTJcdTMwRDdcdTMwRUEgSURcbiAqIEBwYXJhbSBxdWVyeSAgICBXSEVSRSBcdTUzRTVcdUZGMDhPUkRFUiBCWSAvIExJTUlUIFx1MzA2QVx1MzA1N1x1RkYwOVx1MzAwMlx1NEY4QjogJ1x1MzBCOVx1MzBDNlx1MzBGQ1x1MzBCRlx1MzBCOSA9IFwiXHU1QjhDXHU0RTg2XCInXG4gKiBAcGFyYW0gZmllbGRzICAgXHU1M0Q2XHU1Rjk3XHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHU0RTAwXHU4OUE3XHVGRjA4XHU3QTdBID0gXHU1MTY4XHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHVGRjA5XG4gKiBAcGFyYW0gb3B0aW9ucyAgcGFnZVNpemUgLyBtYXhSZWNvcmRzIFx1MzA2RVx1NEUwQVx1NjZGOFx1MzA0RFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGwoXG4gIGZldGNoZXI6IFBhZ2VGZXRjaGVyLFxuICBhcHA6IG51bWJlcixcbiAgcXVlcnk6IHN0cmluZyxcbiAgZmllbGRzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogRmV0Y2hBbGxPcHRpb25zID0ge31cbik6IFByb21pc2U8S2ludG9uZVJlY29yZFtdPiB7XG4gIGNvbnN0IHBhZ2VTaXplICAgPSBvcHRpb25zLnBhZ2VTaXplICAgPz8gUEFHRV9TSVpFX0RFRkFVTFQ7XG4gIGNvbnN0IG1heFJlY29yZHMgPSBvcHRpb25zLm1heFJlY29yZHMgPz8gTUFYX1JFQ09SRFNfREVGQVVMVDtcblxuICBjb25zdCBhbGxSZWNvcmRzOiBLaW50b25lUmVjb3JkW10gPSBbXTtcbiAgbGV0IG9mZnNldCA9IDA7XG5cbiAgd2hpbGUgKHRydWUpIHtcbiAgICBjb25zdCBwYWdlUXVlcnkgPSBidWlsZFBhZ2VRdWVyeShxdWVyeSwgcGFnZVNpemUsIG9mZnNldCk7XG4gICAgY29uc3QgcmVzcG9uc2UgID0gYXdhaXQgZmV0Y2hlcih7IGFwcCwgcXVlcnk6IHBhZ2VRdWVyeSwgZmllbGRzIH0pO1xuICAgIGNvbnN0IHJlY29yZHMgICA9IHJlc3BvbnNlLnJlY29yZHM7XG5cbiAgICBhbGxSZWNvcmRzLnB1c2goLi4ucmVjb3Jkcyk7XG5cbiAgICAvLyBcdTRFMEFcdTk2NTBcdTMwQzFcdTMwQTdcdTMwQzNcdTMwQUZcbiAgICBpZiAoYWxsUmVjb3Jkcy5sZW5ndGggPiBtYXhSZWNvcmRzKSB7XG4gICAgICB0aHJvdyBuZXcgRmV0Y2hBbGxMaW1pdEVycm9yKFxuICAgICAgICBgXHU1M0Q2XHU1Rjk3XHU0RUY2XHU2NTcwXHUzMDRDXHU0RTBBXHU5NjUwXHVGRjA4JHttYXhSZWNvcmRzfSBcdTRFRjZcdUZGMDlcdTMwOTJcdThEODVcdTMwNDhcdTMwN0VcdTMwNTdcdTMwNUZcdTMwMDJgICtcbiAgICAgICAgXCJXSEVSRSBcdTUzRTVcdTMwNjdcdTdENUVcdTMwOEFcdThGQkNcdTMwODBcdTMwNEJcdTMwMDFtYXhSZWNvcmRzIFx1MzA5Mlx1NUYxNVx1MzA0RFx1NEUwQVx1MzA1Mlx1MzA2Nlx1MzA0Rlx1MzA2MFx1MzA1NVx1MzA0NFx1MzAwMlwiXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIFx1N0Q0Mlx1NEU4Nlx1Njc2MVx1NEVGNjogXHU1M0Q2XHU1Rjk3XHU0RUY2XHU2NTcwXHUzMDRDIHBhZ2VTaXplIFx1NjcyQVx1NkU4MCBcdTIxOTIgXHU2NzAwXHU3RDQyXHUzMERBXHUzMEZDXHUzMEI4XG4gICAgaWYgKHJlY29yZHMubGVuZ3RoIDwgcGFnZVNpemUpIGJyZWFrO1xuXG4gICAgb2Zmc2V0ICs9IHBhZ2VTaXplO1xuICB9XG5cbiAgcmV0dXJuIGFsbFJlY29yZHM7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR0VUIFx1NUY4Q1x1MzA2QiAkaWQgXHUzMDkyXHU2MkJEXHU1MUZBXHUzMDU5XHUzMDhCXHUzMEQ4XHUzMEVCXHUzMEQxXHUzMEZDXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBmZXRjaEFsbCBcdTMwNjdcdTUzRDZcdTVGOTdcdTMwNTdcdTMwNUZcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzlcdTMwNEJcdTMwODkgJGlkXHVGRjA4XHU2NTcwXHU1MDI0XHVGRjA5XHUzMDkyXHU2MkJEXHU1MUZBXHUzMDU3XHUzMDY2XHU4RkQ0XHUzMDU5XHUzMDAyXG4gKiBVUERBVEUgLyBERUxFVEUgXHUzMDZFIDJcdTMwRDVcdTMwQTdcdTMwRkNcdTMwQkFcdTc2RUVcdTMwNjdcdTRGN0ZcdTc1MjhcdTMwNTlcdTMwOEJcdTMwMDJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RJZHMocmVjb3JkczogS2ludG9uZVJlY29yZFtdKTogbnVtYmVyW10ge1xuICByZXR1cm4gcmVjb3Jkcy5tYXAoKHIpID0+IHtcbiAgICBjb25zdCByYXcgPSByW1wiJGlkXCJdPy52YWx1ZTtcbiAgICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzlcdTMwNkIgJGlkIFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1MzA0Q1x1NTQyQlx1MzA3RVx1MzA4Q1x1MzA2Nlx1MzA0NFx1MzA3RVx1MzA1Qlx1MzA5M1x1MzAwMmZpZWxkcyBcdTMwNkIgXFxcIiRpZFxcXCIgXHUzMDkyXHU2MzA3XHU1QjlBXHUzMDU3XHUzMDY2XHUzMDRGXHUzMDYwXHUzMDU1XHUzMDQ0XHUzMDAyXCJcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gTnVtYmVyKHJhdyk7XG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCRpZCBcdTMwNkVcdTUwMjRcdTMwNENcdTY1NzBcdTUwMjRcdTMwNjdcdTMwNkZcdTMwNDJcdTMwOEFcdTMwN0VcdTMwNUJcdTMwOTM6ICR7cmF3fWApO1xuICAgIH1cbiAgICByZXR1cm4gaWQ7XG4gIH0pO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBEOFx1MzBFQlx1MzBEMVx1MzBGQ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNvbnN0IFBBR0VfU0laRV9ERUZBVUxUICAgPSA1MDA7XG5jb25zdCBNQVhfUkVDT1JEU19ERUZBVUxUID0gMTBfMDAwO1xuXG4vKipcbiAqIFx1NjVFMlx1NUI1OFx1MzA2RVx1MzBBRlx1MzBBOFx1MzBFQVx1MzA2QiBcImxpbWl0IE4gb2Zmc2V0IE1cIiBcdTMwOTJcdTRFRDhcdTRFMEVcdTMwNTlcdTMwOEJcdTMwMDJcbiAqXG4gKiBraW50b25lIFx1MzBBRlx1MzBBOFx1MzBFQVx1MzA2RVx1MzBFQlx1MzBGQ1x1MzBFQjpcbiAqICAgLSBsaW1pdCAvIG9mZnNldCBcdTMwNkZcdTY3MkJcdTVDM0VcdTMwNkJcdTdGNkVcdTMwNEZcbiAqICAgLSBcdTMwNTlcdTMwNjdcdTMwNkIgbGltaXQgLyBvZmZzZXQgXHUzMDRDXHU1NDJCXHUzMDdFXHUzMDhDXHUzMDY2XHUzMDQ0XHUzMDhCXHU1ODM0XHU1NDA4XHUzMDZGXHU0RTBBXHU2NkY4XHUzMDREXHUzMDU3XHUzMDZBXHUzMDQ0XG4gKiAgICAgXHVGRjA4ZmV0Y2hBbGwgXHUzMDZCXHU2RTIxXHUzMDU5IHF1ZXJ5IFx1MzA2Qlx1MzA2RiBsaW1pdC9vZmZzZXQgXHUzMDkyXHU1NDJCXHUzMDgxXHUzMDZBXHUzMDQ0XHUzMDUzXHUzMDY4XHUzMDkyXHU1MjREXHU2M0QwXHUzMDY4XHUzMDU5XHUzMDhCXHVGRjA5XG4gKlxuICogXHU0RjhCOlxuICogICBxdWVyeT1cIlwiIFx1MjE5MiBcImxpbWl0IDUwMCBvZmZzZXQgMFwiXG4gKiAgIHF1ZXJ5PSdcdTMwQjlcdTMwQzZcdTMwRkNcdTMwQkZcdTMwQjkgPSBcIlx1NUI4Q1x1NEU4NlwiJyBcdTIxOTIgJ1x1MzBCOVx1MzBDNlx1MzBGQ1x1MzBCRlx1MzBCOSA9IFwiXHU1QjhDXHU0RTg2XCIgbGltaXQgNTAwIG9mZnNldCAwJ1xuICogICBxdWVyeT0nXHUzMEI5XHUzMEM2XHUzMEZDXHUzMEJGXHUzMEI5ID0gXCJcdTVCOENcdTRFODZcIiBvcmRlciBieSBcdTRGNUNcdTYyMTBcdTY1RTUgZGVzYydcbiAqICAgICBcdTIxOTIgJ1x1MzBCOVx1MzBDNlx1MzBGQ1x1MzBCRlx1MzBCOSA9IFwiXHU1QjhDXHU0RTg2XCIgb3JkZXIgYnkgXHU0RjVDXHU2MjEwXHU2NUU1IGRlc2MgbGltaXQgNTAwIG9mZnNldCAwJ1xuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRQYWdlUXVlcnkoXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIHBhZ2VTaXplOiBudW1iZXIsXG4gIG9mZnNldDogbnVtYmVyXG4pOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gcXVlcnkudHJpbUVuZCgpO1xuICBjb25zdCBzdWZmaXggPSBgbGltaXQgJHtwYWdlU2l6ZX0gb2Zmc2V0ICR7b2Zmc2V0fWA7XG4gIHJldHVybiBiYXNlID8gYCR7YmFzZX0gJHtzdWZmaXh9YCA6IHN1ZmZpeDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBcdTMwQThcdTMwRTlcdTMwRkNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY2xhc3MgRmV0Y2hBbGxMaW1pdEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkZldGNoQWxsTGltaXRFcnJvclwiO1xuICB9XG59XG4iLCAiLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBldmFsV2hlcmUgXHUyMDE0IFdoZXJlRXhwciBcdTMwOTIgSmF2YVNjcmlwdCBcdTUwNzRcdTMwNjdcdThBNTVcdTRGQTFcdTMwNTlcdTMwOEJcbi8vXG4vLyBcdTc1MjhcdTkwMTQ6IEpPSU4gXHUzMEFGXHUzMEE4XHUzMEVBXHUzMDZFXHU3RDUwXHU1NDA4XHU1RjhDXHUzMEQ1XHUzMEEzXHUzMEVCXHUzMEJGXHVGRjA4V0hFUkUgXHUzMDkyIEpTIFx1NTA3NFx1MzA2N1x1OTA2OVx1NzUyOFx1RkYwOVxuLy8ga2ludG9uZSBBUEkgXHUzMDY3XHUzMDZGXHU4QTU1XHU0RkExXHUzMDY3XHUzMDREXHUzMDZBXHUzMDQ0XHU1ODM0XHU1NDA4XHVGRjA4XHU4OTA3XHU2NTcwXHUzMEM2XHUzMEZDXHUzMEQ2XHUzMEVCXHU1M0MyXHU3MTY3XHU3QjQ5XHVGRjA5XHUzMDZCXHU0RjdGXHU3NTI4XHUzMDU5XHUzMDhCXHUzMDAyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW1wb3J0IHR5cGUge1xuICBXaGVyZUV4cHIsXG4gIEZpZWxkVmFsdWUsXG4gIFNxbFZhbHVlLFxuICBDb21wYXJlT3AsXG59IGZyb20gXCIuLi90eXBlcy9hc3RcIjtcblxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFByb2Nlc3NSb3c6IFx1NTFFNlx1NzQwNlx1NEUyRFx1MzA2RVx1MzBENVx1MzBFOVx1MzBDM1x1MzBDOFx1ODg0Q1x1RkYwOFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1NTQwRCBcdTIxOTIgXHU2NTg3XHU1QjU3XHU1MjE3XHU1MDI0XHVGRjA5XG4vL1xuLy8gSk9JTiBcdTMwNDJcdTMwOEE6IFwiYWxpYXMuZmllbGRcIiBcdTVGNjJcdTVGMEZcdTMwNkVcdTMwQURcdTMwRkNcbi8vIEpPSU4gXHUzMDZBXHUzMDU3OiBcImZpZWxkXCIgXHU1RjYyXHU1RjBGXHUzMDZFXHUzMEFEXHUzMEZDXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmV4cG9ydCB0eXBlIFByb2Nlc3NSb3cgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBBOFx1MzBGM1x1MzBDOFx1MzBFQVx1MzBERFx1MzBBNFx1MzBGM1x1MzBDOFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBldmFsV2hlcmUoZXhwcjogV2hlcmVFeHByLCByb3c6IFByb2Nlc3NSb3cpOiBib29sZWFuIHtcbiAgc3dpdGNoIChleHByLnR5cGUpIHtcbiAgICBjYXNlIFwiQklOQVJZXCI6ICAgIHJldHVybiBldmFsQmluYXJ5KGV4cHIsIHJvdyk7XG4gICAgY2FzZSBcIk5VTExfQ0hFQ0tcIjogcmV0dXJuIGV2YWxOdWxsQ2hlY2soZXhwciwgcm93KTtcbiAgICBjYXNlIFwiTE9HSUNBTFwiOiAgIHJldHVybiBldmFsTG9naWNhbChleHByLCByb3cpO1xuICAgIGNhc2UgXCJOT1RcIjogICAgICAgcmV0dXJuICFldmFsV2hlcmUoZXhwci5leHByLCByb3cpO1xuICAgIGNhc2UgXCJHUk9VUFwiOiAgICAgcmV0dXJuIGV2YWxXaGVyZShleHByLmV4cHIsIHJvdyk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBCaW5hcnlFeHByXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gZXZhbEJpbmFyeShcbiAgZXhwcjogRXh0cmFjdDxXaGVyZUV4cHIsIHsgdHlwZTogXCJCSU5BUllcIiB9PixcbiAgcm93OiBQcm9jZXNzUm93XG4pOiBib29sZWFuIHtcbiAgY29uc3QgbGVmdCA9IHJlc29sdmVGaWVsZChleHByLmxlZnQsIHJvdyk7XG4gIHJldHVybiBldmFsT3AoZXhwci5vcCwgbGVmdCwgZXhwci5yaWdodCwgcm93KTtcbn1cblxuZnVuY3Rpb24gZXZhbE9wKFxuICBvcDogQ29tcGFyZU9wLFxuICBsZWZ0U3RyOiBzdHJpbmcsXG4gIHJpZ2h0OiBTcWxWYWx1ZSxcbiAgX3JvdzogUHJvY2Vzc1Jvd1xuKTogYm9vbGVhbiB7XG4gIGlmIChvcCA9PT0gXCJJTlwiKSB7XG4gICAgaWYgKHJpZ2h0LnR5cGUgIT09IFwiSU5fTElTVFwiKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHJpZ2h0LnZhbHVlcy5zb21lKCh2KSA9PiBsZWZ0U3RyID09PSBTdHJpbmcodi52YWx1ZSkpO1xuICB9XG5cbiAgaWYgKG9wID09PSBcIk5PVF9JTlwiKSB7XG4gICAgaWYgKHJpZ2h0LnR5cGUgIT09IFwiSU5fTElTVFwiKSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gcmlnaHQudmFsdWVzLmV2ZXJ5KCh2KSA9PiBsZWZ0U3RyICE9PSBTdHJpbmcodi52YWx1ZSkpO1xuICB9XG5cbiAgaWYgKG9wID09PSBcIkxJS0VcIikge1xuICAgIGNvbnN0IHBhdHRlcm4gPSByZXNvbHZlVmFsdWUocmlnaHQpO1xuICAgIHJldHVybiBtYXRjaExpa2UobGVmdFN0ciwgcGF0dGVybik7XG4gIH1cblxuICBpZiAob3AgPT09IFwiTk9UX0xJS0VcIikge1xuICAgIGNvbnN0IHBhdHRlcm4gPSByZXNvbHZlVmFsdWUocmlnaHQpO1xuICAgIHJldHVybiAhbWF0Y2hMaWtlKGxlZnRTdHIsIHBhdHRlcm4pO1xuICB9XG5cbiAgY29uc3QgcmlnaHRTdHIgPSByZXNvbHZlVmFsdWUocmlnaHQpO1xuXG4gIC8vIFx1NjU3MFx1NTAyNFx1NkJENFx1OEYwM1x1MzA0Q1x1NTNFRlx1ODBGRFx1MzA2QVx1NTgzNFx1NTQwOFx1MzA2Rlx1NjU3MFx1NTAyNFx1MzA2OFx1MzA1N1x1MzA2Nlx1NkJENFx1OEYwM1x1MzA1OVx1MzA4QlxuICBjb25zdCBsZWZ0TnVtICA9IE51bWJlcihsZWZ0U3RyKTtcbiAgY29uc3QgcmlnaHROdW0gPSBOdW1iZXIocmlnaHRTdHIpO1xuICBjb25zdCBudW1lcmljICA9ICFOdW1iZXIuaXNOYU4obGVmdE51bSkgJiYgIU51bWJlci5pc05hTihyaWdodE51bSk7XG5cbiAgc3dpdGNoIChvcCkge1xuICAgIGNhc2UgXCI9XCI6ICAgIHJldHVybiBsZWZ0U3RyID09PSByaWdodFN0cjtcbiAgICBjYXNlIFwiIT1cIjpcbiAgICBjYXNlIFwiPD5cIjogICByZXR1cm4gbGVmdFN0ciAhPT0gcmlnaHRTdHI7XG4gICAgY2FzZSBcIj5cIjogICAgcmV0dXJuIG51bWVyaWMgPyBsZWZ0TnVtID4gcmlnaHROdW0gIDogbGVmdFN0ciA+IHJpZ2h0U3RyO1xuICAgIGNhc2UgXCI8XCI6ICAgIHJldHVybiBudW1lcmljID8gbGVmdE51bSA8IHJpZ2h0TnVtICA6IGxlZnRTdHIgPCByaWdodFN0cjtcbiAgICBjYXNlIFwiPj1cIjogICByZXR1cm4gbnVtZXJpYyA/IGxlZnROdW0gPj0gcmlnaHROdW0gOiBsZWZ0U3RyID49IHJpZ2h0U3RyO1xuICAgIGNhc2UgXCI8PVwiOiAgIHJldHVybiBudW1lcmljID8gbGVmdE51bSA8PSByaWdodE51bSA6IGxlZnRTdHIgPD0gcmlnaHRTdHI7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBOdWxsQ2hlY2tFeHByOiBJUyBOVUxMIFx1MjE5MiB2YWx1ZSA9PT0gXCJcIlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGV2YWxOdWxsQ2hlY2soXG4gIGV4cHI6IEV4dHJhY3Q8V2hlcmVFeHByLCB7IHR5cGU6IFwiTlVMTF9DSEVDS1wiIH0+LFxuICByb3c6IFByb2Nlc3NSb3dcbik6IGJvb2xlYW4ge1xuICBjb25zdCB2YWwgPSByZXNvbHZlRmllbGQoZXhwci5maWVsZCwgcm93KTtcbiAgcmV0dXJuIGV4cHIubm90ID8gdmFsICE9PSBcIlwiIDogdmFsID09PSBcIlwiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIExvZ2ljYWxFeHByXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gZXZhbExvZ2ljYWwoXG4gIGV4cHI6IEV4dHJhY3Q8V2hlcmVFeHByLCB7IHR5cGU6IFwiTE9HSUNBTFwiIH0+LFxuICByb3c6IFByb2Nlc3NSb3dcbik6IGJvb2xlYW4ge1xuICBpZiAoZXhwci5vcCA9PT0gXCJBTkRcIikge1xuICAgIHJldHVybiBldmFsV2hlcmUoZXhwci5sZWZ0LCByb3cpICYmIGV2YWxXaGVyZShleHByLnJpZ2h0LCByb3cpO1xuICB9XG4gIHJldHVybiBldmFsV2hlcmUoZXhwci5sZWZ0LCByb3cpIHx8IGV2YWxXaGVyZShleHByLnJpZ2h0LCByb3cpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1NTAyNFx1MzA2RVx1ODlFM1x1NkM3QVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIHJlc29sdmVGaWVsZChcbiAgZmllbGQ6IEZpZWxkVmFsdWUsXG4gIHJvdzogUHJvY2Vzc1Jvd1xuKTogc3RyaW5nIHtcbiAgLy8gXHUzMEE4XHUzMEE0XHUzMEVBXHUzMEEyXHUzMEI5XHU0RUQ4XHUzMDREOiBcImEuXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XCJcbiAgY29uc3Qga2V5ID0gZmllbGQudGFibGVBbGlhc1xuICAgID8gYCR7ZmllbGQudGFibGVBbGlhc30uJHtmaWVsZC5maWVsZH1gXG4gICAgOiBmaWVsZC5maWVsZDtcbiAgcmV0dXJuIHJvd1trZXldID8/IFwiXCI7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVWYWx1ZSh2YWx1ZTogU3FsVmFsdWUpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHZhbHVlLnR5cGUpIHtcbiAgICBjYXNlIFwiU1RSSU5HXCI6ICAgICAgIHJldHVybiB2YWx1ZS52YWx1ZTtcbiAgICBjYXNlIFwiTlVNQkVSXCI6ICAgICAgIHJldHVybiBTdHJpbmcodmFsdWUudmFsdWUpO1xuICAgIGNhc2UgXCJLSU5UT05FX0ZVTkNcIjogcmV0dXJuIHJlc29sdmVLaW50b25lRnVuYyh2YWx1ZS5uYW1lKTtcbiAgICBjYXNlIFwiSU5fTElTVFwiOiAgICAgIHJldHVybiBcIlwiOyAvLyBJTiBcdTMwNkYgZXZhbE9wIFx1MzA2N1x1NTIyNVx1NTFFNlx1NzQwNlxuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVLaW50b25lRnVuYyhuYW1lOiBcIlRPREFZXCIgfCBcIk5PV1wiIHwgXCJMT0dJTlVTRVJcIik6IHN0cmluZyB7XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gIHN3aXRjaCAobmFtZSkge1xuICAgIGNhc2UgXCJUT0RBWVwiOiB7XG4gICAgICAvLyBcIllZWVktTU0tRERcIlxuICAgICAgY29uc3QgeSA9IG5vdy5nZXRGdWxsWWVhcigpO1xuICAgICAgY29uc3QgbSA9IFN0cmluZyhub3cuZ2V0TW9udGgoKSArIDEpLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgICAgIGNvbnN0IGQgPSBTdHJpbmcobm93LmdldERhdGUoKSkucGFkU3RhcnQoMiwgXCIwXCIpO1xuICAgICAgcmV0dXJuIGAke3l9LSR7bX0tJHtkfWA7XG4gICAgfVxuICAgIGNhc2UgXCJOT1dcIjpcbiAgICAgIHJldHVybiBub3cudG9JU09TdHJpbmcoKTtcbiAgICBjYXNlIFwiTE9HSU5VU0VSXCI6XG4gICAgICAvLyBraW50b25lIFx1NzRCMFx1NTg4M1x1NTkxNlx1MzA2N1x1MzA2Rlx1ODlFM1x1NkM3QVx1NEUwRFx1ODBGRCBcdTIxOTIgXHU3QTdBXHU2NTg3XHU1QjU3XHVGRjA4XHU2QkQ0XHU4RjAzXHUzMDRDXHU1RTM4XHUzMDZCIGZhbHNlIFx1MzA2Qlx1MzA2QVx1MzA4Qlx1RkYwOVxuICAgICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBMSUtFIFx1MzBEMVx1MzBCRlx1MzBGQ1x1MzBGM1x1MzBERVx1MzBDM1x1MzBDMVxuLy8gU1FMIFx1MzA2RSAlIFx1MjE5MiAuKiBcdTMwMDFfIFx1MjE5MiAuIFx1MzA2Qlx1NTkwOVx1NjNEQlx1MzA1N1x1MzA2Nlx1NkI2M1x1ODk4Rlx1ODg2OFx1NzNGRVx1MzA2N1x1OEE1NVx1NEZBMVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIG1hdGNoTGlrZSh2YWx1ZTogc3RyaW5nLCBwYXR0ZXJuOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgLy8gXHUzMEQxXHUzMEJGXHUzMEZDXHUzMEYzXHU2NTg3XHU1QjU3XHU1MjE3XHUzMDkyXHU2QjYzXHU4OThGXHU4ODY4XHU3M0ZFXHUzMDZCXHU1OTA5XHU2M0RCXG4gIGxldCByZWdleFN0ciA9IFwiXlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHBhdHRlcm4ubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBjaCA9IHBhdHRlcm5baV07XG4gICAgaWYgKGNoID09PSBcIiVcIikge1xuICAgICAgcmVnZXhTdHIgKz0gXCIuKlwiO1xuICAgIH0gZWxzZSBpZiAoY2ggPT09IFwiX1wiKSB7XG4gICAgICByZWdleFN0ciArPSBcIi5cIjtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gXHU2QjYzXHU4OThGXHU4ODY4XHU3M0ZFXHU3Mjc5XHU2QjhBXHU2NTg3XHU1QjU3XHUzMDkyXHUzMEE4XHUzMEI5XHUzMEIxXHUzMEZDXHUzMEQ3XG4gICAgICByZWdleFN0ciArPSBjaC5yZXBsYWNlKC9bLisqP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG4gICAgfVxuICB9XG4gIHJlZ2V4U3RyICs9IFwiJFwiO1xuICByZXR1cm4gbmV3IFJlZ0V4cChyZWdleFN0ciwgXCJ1XCIpLnRlc3QodmFsdWUpO1xufVxuIiwgIi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gSlMgXHU5NkM2XHU4QTA4XHUzMEE4XHUzMEYzXHUzMEI4XHUzMEYzXG4vL1xuLy8gRlVMTF9TQ0FOIFx1MzBFMlx1MzBGQ1x1MzBDOVx1RkYwOEpPSU4gLyBHUk9VUCBCWSAvIERJU1RJTkNUXHVGRjA5XHUzMDZFXHU1RjhDXHU1MUU2XHU3NDA2XHUzMDkyXHU2MkM1XHUzMDQ2XHUzMDAyXG4vLyBraW50b25lIEFQSSBcdTMwNEJcdTMwODlcdTUzRDZcdTVGOTdcdTMwNTdcdTMwNUZcdTUxNjhcdTRFRjZcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzlcdTMwOTJcdTUzRDdcdTMwNTFcdTUzRDZcdTMwOEFcdTMwMDFcbi8vIFNRTCBcdTMwNkVcdTYxMEZcdTU0NzNcdThBRDZcdTMwNkJcdTVGOTNcdTMwNjNcdTMwNjZcdTUyQTBcdTVERTVcdTMwNTdcdTMwNjZcdThGRDRcdTMwNTlcdTMwMDJcbi8vXG4vLyBcdTUxRTZcdTc0MDZcdTMwRDFcdTMwQTRcdTMwRDdcdTMwRTlcdTMwQTRcdTMwRjNcdUZGMDhGVUxMX1NDQU5cdUZGMDk6XG4vLyAgIDEuIGZsYXR0ZW4gIFx1MjAxNCBLaW50b25lUmVjb3JkIFx1MjE5MiBQcm9jZXNzUm93XG4vLyAgIDIuIGpvaW4gICAgIFx1MjAxNCBcdTg5MDdcdTY1NzBcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUJcdTMwOTJcdTdENTBcdTU0MDhcbi8vICAgMy4gZmlsdGVyICAgXHUyMDE0IEpTIFx1NTA3NCBXSEVSRVx1RkYwOEpPSU4gXHU1RjhDXHUzMEQ1XHUzMEEzXHUzMEVCXHUzMEJGXHVGRjA5XG4vLyAgIDQuIGdyb3VwQnkgIFx1MjAxNCBHUk9VUCBCWSArIFx1OTZDNlx1OEEwOFx1OTVBMlx1NjU3MFxuLy8gICA1LiBoYXZpbmcgICBcdTIwMTQgSEFWSU5HIFx1MzBENVx1MzBBM1x1MzBFQlx1MzBCRlxuLy8gICA2LiBkaXN0aW5jdCBcdTIwMTQgRElTVElOQ1QgXHU5MUNEXHU4OTA3XHU5NjY0XHU1M0JCXG4vLyAgIDcuIG9yZGVyQnkgIFx1MjAxNCBPUkRFUiBCWSBcdTMwQkRcdTMwRkNcdTMwQzhcbi8vICAgOC4gbGltaXQgICAgXHUyMDE0IExJTUlUIFx1NEVGNlx1NjU3MFx1NTIzNlx1OTY1MFxuLy8gICA5LiBwcm9qZWN0ICBcdTIwMTQgU0VMRUNUIFx1NTIxN1x1MzBEN1x1MzBFRFx1MzBCOFx1MzBBN1x1MzBBRlx1MzBCN1x1MzBFN1x1MzBGM1x1RkYwOFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1OTA3OFx1NjI5RVx1MzBGQkFTIGFsaWFzXHVGRjA5XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW1wb3J0IHR5cGUge1xuICBTZWxlY3RTdGF0ZW1lbnQsXG4gIFNlbGVjdENvbHVtbixcbiAgSm9pbkNsYXVzZSxcbiAgT3JkZXJCeUl0ZW0sXG4gIFdoZXJlRXhwcixcbiAgQWdncmVnYXRlRnVuYyxcbn0gZnJvbSBcIi4uL3R5cGVzL2FzdFwiO1xuaW1wb3J0IHR5cGUgeyBLaW50b25lUmVjb3JkIH0gZnJvbSBcIi4uL2NvbnZlcnRlci9kbWxUb0tpbnRvbmVcIjtcbmltcG9ydCB7IGV2YWxXaGVyZSwgUHJvY2Vzc1JvdyB9IGZyb20gXCIuL2V2YWxXaGVyZVwiO1xuXG5leHBvcnQgeyBQcm9jZXNzUm93IH07XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gMS4gZmxhdHRlbiBcdTIwMTQgS2ludG9uZVJlY29yZCBcdTIxOTIgUHJvY2Vzc1Jvd1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICoga2ludG9uZSBcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzlcdTMwOTJcdTMwRDVcdTMwRTlcdTMwQzNcdTMwQzhcdTMwNkFcdTY1ODdcdTVCNTdcdTUyMTdcdTMwREVcdTMwQzNcdTMwRDdcdTMwNkJcdTU5MDlcdTYzREJcdTMwNTlcdTMwOEJcdTMwMDJcbiAqIEpPSU4gXHUzMDRDXHUzMDQyXHUzMDhCXHU1ODM0XHU1NDA4XHUzMDZGIHRhYmxlQWxpYXMgXHUzMDkyXHUzMEFEXHUzMEZDXHUzMDZFXHUzMEQ3XHUzMEVDXHUzMEQ1XHUzMEEzXHUzMEMzXHUzMEFGXHUzMEI5XHUzMDZCXHU0RUQ4XHU0RTBFXHUzMDU5XHUzMDhCXHUzMDAyXG4gKlxuICogXHU0RjhCXHVGRjA4YWxpYXM9XCJhXCJcdUZGMDk6IHsgXHU1NDBEXHU1MjREOiB7dmFsdWU6XCJcdTc1MzBcdTRFMkRcIn0gfSBcdTIxOTIgeyBcImEuXHU1NDBEXHU1MjREXCI6IFwiXHU3NTMwXHU0RTJEXCIgfVxuICogXHU0RjhCXHVGRjA4YWxpYXM9bnVsbFx1RkYwOTogeyBcdTU0MERcdTUyNEQ6IHt2YWx1ZTpcIlx1NzUzMFx1NEUyRFwifSB9IFx1MjE5MiB7IFwiXHU1NDBEXHU1MjREXCI6IFwiXHU3NTMwXHU0RTJEXCIgfVxuICovXG5leHBvcnQgZnVuY3Rpb24gZmxhdHRlbihyZWNvcmQ6IEtpbnRvbmVSZWNvcmQsIGFsaWFzOiBzdHJpbmcgfCBudWxsKTogUHJvY2Vzc1JvdyB7XG4gIGNvbnN0IHJvdzogUHJvY2Vzc1JvdyA9IHt9O1xuICBmb3IgKGNvbnN0IFtmaWVsZCwgZnZdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZCkpIHtcbiAgICBjb25zdCBrZXkgPSBhbGlhcyA/IGAke2FsaWFzfS4ke2ZpZWxkfWAgOiBmaWVsZDtcbiAgICAvLyBcdTMwRTZcdTMwRkNcdTMwQjZcdTMwRkNcdTkwNzhcdTYyOUVcdTMwRkJcdTMwQjVcdTMwRDZcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUJcdTdCNDlcdTMwNkYgdmFsdWUgXHUzMDRDXHU5MTREXHU1MjE3L1x1MzBBQVx1MzBENlx1MzBCOFx1MzBBN1x1MzBBRlx1MzBDOFx1MzA2Qlx1MzA2QVx1MzA4Qlx1NTgzNFx1NTQwOFx1MzA0Q1x1MzA0Mlx1MzA4QlxuICAgIGNvbnN0IHZhbCA9IChmdiBhcyB7IHZhbHVlOiB1bmtub3duIH0pLnZhbHVlO1xuICAgIHJvd1trZXldID0gdHlwZW9mIHZhbCA9PT0gXCJzdHJpbmdcIiA/IHZhbCA6IEpTT04uc3RyaW5naWZ5KHZhbCA/PyBcIlwiKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIDIuIGpvaW5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFx1NURFNlx1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlx1MzA2RVx1ODg0Q1x1MzA2OFx1NTNGM1x1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlx1MzA2RVx1ODg0Q1x1MzA5Mlx1N0Q1MFx1NTQwOFx1MzA1OVx1MzA4Qlx1MzAwMlxuICpcbiAqIC0gSU5ORVIgSk9JTjogXHU3RDUwXHU1NDA4XHU2NzYxXHU0RUY2XHUzMDkyXHU2RTgwXHUzMDVGXHUzMDU5XHU4ODRDXHUzMDZFXHUzMDdGXG4gKiAtIExFRlQgSk9JTjogIFx1NURFNlx1MzA2RVx1NTE2OFx1ODg0QyArIFx1Njc2MVx1NEVGNlx1MzA5Mlx1NkU4MFx1MzA1Rlx1MzA1OVx1NTNGM1x1ODg0Q1x1RkYwOFx1NTNGM1x1MzA0Q1x1NUI1OFx1NTcyOFx1MzA1N1x1MzA2QVx1MzA0NFx1NTgzNFx1NTQwOFx1MzA2Rlx1N0E3QVx1NjU4N1x1NUI1N1x1RkYwOVxuICpcbiAqIFx1N0Q1MFx1NTQwOFx1MzBBRFx1MzBGQ1x1MzA2RiBPTiBhLmZpZWxkID0gYi5maWVsZCBcdTVGNjJcdTVGMEZcdUZGMDhQaGFzZSAxOiBcdTdCNDlcdTUwMjRcdTdENTBcdTU0MDhcdTMwNkVcdTMwN0ZcdUZGMDlcdTMwMDJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5Sm9pbihcbiAgbGVmdFJvd3M6IFByb2Nlc3NSb3dbXSxcbiAgcmlnaHRSb3dzOiBQcm9jZXNzUm93W10sXG4gIGpvaW46IEpvaW5DbGF1c2Vcbik6IFByb2Nlc3NSb3dbXSB7XG4gIGNvbnN0IHsgb24sIHR5cGU6IGpvaW5UeXBlIH0gPSBqb2luO1xuICBjb25zdCBsZWZ0S2V5ICA9IG9uLmxlZnQudGFibGVBbGlhc1xuICAgID8gYCR7b24ubGVmdC50YWJsZUFsaWFzfS4ke29uLmxlZnQuZmllbGR9YFxuICAgIDogb24ubGVmdC5maWVsZDtcbiAgY29uc3QgcmlnaHRLZXkgPSBvbi5yaWdodC50YWJsZUFsaWFzXG4gICAgPyBgJHtvbi5yaWdodC50YWJsZUFsaWFzfS4ke29uLnJpZ2h0LmZpZWxkfWBcbiAgICA6IG9uLnJpZ2h0LmZpZWxkO1xuXG4gIC8vIFx1NTNGM1x1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlx1MzA5Mlx1N0Q1MFx1NTQwOFx1MzBBRFx1MzBGQ1x1MzA2N1x1MzBBNFx1MzBGM1x1MzBDN1x1MzBDM1x1MzBBRlx1MzBCOVx1NTMxNlx1RkYwOE8obittKSBcdTMwNkJcdTMwNTlcdTMwOEJcdUZGMDlcbiAgY29uc3QgcmlnaHRJbmRleCA9IG5ldyBNYXA8c3RyaW5nLCBQcm9jZXNzUm93W10+KCk7XG4gIGZvciAoY29uc3QgclJvdyBvZiByaWdodFJvd3MpIHtcbiAgICBjb25zdCBrID0gclJvd1tyaWdodEtleV0gPz8gXCJcIjtcbiAgICBjb25zdCBidWNrZXQgPSByaWdodEluZGV4LmdldChrKTtcbiAgICBpZiAoYnVja2V0KSBidWNrZXQucHVzaChyUm93KTtcbiAgICBlbHNlIHJpZ2h0SW5kZXguc2V0KGssIFtyUm93XSk7XG4gIH1cblxuICBjb25zdCByZXN1bHQ6IFByb2Nlc3NSb3dbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgbFJvdyBvZiBsZWZ0Um93cykge1xuICAgIGNvbnN0IGsgPSBsUm93W2xlZnRLZXldID8/IFwiXCI7XG4gICAgY29uc3QgbWF0Y2hlZCA9IHJpZ2h0SW5kZXguZ2V0KGspID8/IFtdO1xuXG4gICAgaWYgKG1hdGNoZWQubGVuZ3RoID4gMCkge1xuICAgICAgZm9yIChjb25zdCByUm93IG9mIG1hdGNoZWQpIHtcbiAgICAgICAgcmVzdWx0LnB1c2goeyAuLi5sUm93LCAuLi5yUm93IH0pO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoam9pblR5cGUgPT09IFwiTEVGVFwiKSB7XG4gICAgICAvLyBMRUZUIEpPSU46IFx1NTNGM1x1NTA3NFx1MzA0Q1x1NUI1OFx1NTcyOFx1MzA1N1x1MzA2QVx1MzA0NFx1NTgzNFx1NTQwOFx1MzA2Rlx1N0E3QVx1NjU4N1x1NUI1N1x1MzA2N1x1NTdDQlx1MzA4MVx1MzA4QlxuICAgICAgY29uc3QgZW1wdHlSaWdodDogUHJvY2Vzc1JvdyA9IHt9O1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocmlnaHRSb3dzWzBdID8/IHt9KSkge1xuICAgICAgICBlbXB0eVJpZ2h0W2tleV0gPSBcIlwiO1xuICAgICAgfVxuICAgICAgcmVzdWx0LnB1c2goeyAuLi5sUm93LCAuLi5lbXB0eVJpZ2h0IH0pO1xuICAgIH1cbiAgICAvLyBJTk5FUiBKT0lOIFx1MzA0Qlx1MzA2NFx1OTc1RVx1MzBERVx1MzBDM1x1MzBDMSBcdTIxOTIgXHU5NjY0XHU1OTE2XHVGRjA4XHU0RjU1XHUzMDgyXHUzMDU3XHUzMDZBXHUzMDQ0XHVGRjA5XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIDMuIGZpbHRlciBcdTIwMTQgSlMgXHU1MDc0IFdIRVJFIFx1OEE1NVx1NEZBMVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUZpbHRlcihcbiAgcm93czogUHJvY2Vzc1Jvd1tdLFxuICB3aGVyZTogV2hlcmVFeHByIHwgbnVsbFxuKTogUHJvY2Vzc1Jvd1tdIHtcbiAgaWYgKHdoZXJlID09PSBudWxsKSByZXR1cm4gcm93cztcbiAgcmV0dXJuIHJvd3MuZmlsdGVyKChyb3cpID0+IGV2YWxXaGVyZSh3aGVyZSwgcm93KSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gNC4gZ3JvdXBCeSArIFx1OTZDNlx1OEEwOFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR1JPVVAgQlkgXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHUzMDY3XHUzMEIwXHUzMEVCXHUzMEZDXHUzMEQ3XHU1MzE2XHUzMDU3XHUzMDAxU0VMRUNUIFx1NTNFNVx1MzA2RVx1OTZDNlx1OEEwOFx1OTVBMlx1NjU3MFx1MzA5Mlx1OEE1NVx1NEZBMVx1MzA1OVx1MzA4Qlx1MzAwMlxuICogXHU1MUZBXHU1MjlCXHU4ODRDXHUzMDZFXHUzMEFEXHUzMEZDOlxuICogICAtIEdST1VQIEJZIFx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOSBcdTIxOTIgXHUzMDVEXHUzMDZFXHUzMDdFXHUzMDdFXG4gKiAgIC0gXHU5NkM2XHU4QTA4XHUzMEFCXHUzMEU5XHUzMEUwIFx1MjE5MiBhbGlhcyBcdTMwNENcdTMwNDJcdTMwOENcdTMwNzAgYWxpYXNcdTMwMDFcdTMwNkFcdTMwNTFcdTMwOENcdTMwNzAgXCJDT1VOVCgqKVwiIFx1N0I0OVx1MzA2RVx1NTQwOFx1NjIxMFx1NTQwRFxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlHcm91cEJ5KFxuICByb3dzOiBQcm9jZXNzUm93W10sXG4gIGdyb3VwQnlGaWVsZHM6IHN0cmluZ1tdLFxuICBjb2x1bW5zOiBTZWxlY3RDb2x1bW5bXVxuKTogUHJvY2Vzc1Jvd1tdIHtcbiAgLy8gXHUzMEIwXHUzMEVCXHUzMEZDXHUzMEQ3XHUzMEFEXHUzMEZDIFx1MjE5MiBcdTg4NENcdTMwRUFcdTMwQjlcdTMwQzhcbiAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIFByb2Nlc3NSb3dbXT4oKTtcbiAgZm9yIChjb25zdCByb3cgb2Ygcm93cykge1xuICAgIGNvbnN0IGtleSA9IGdyb3VwQnlGaWVsZHMubWFwKChmKSA9PiByb3dbZl0gPz8gXCJcIikuam9pbihcIlxceDAwXCIpO1xuICAgIGNvbnN0IGJ1Y2tldCA9IGdyb3Vwcy5nZXQoa2V5KTtcbiAgICBpZiAoYnVja2V0KSBidWNrZXQucHVzaChyb3cpO1xuICAgIGVsc2UgZ3JvdXBzLnNldChrZXksIFtyb3ddKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdDogUHJvY2Vzc1Jvd1tdID0gW107XG4gIGZvciAoY29uc3QgZ3JvdXBSb3dzIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xuICAgIGNvbnN0IG91dFJvdzogUHJvY2Vzc1JvdyA9IHt9O1xuXG4gICAgLy8gR1JPVVAgQlkgXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHUzMDZFXHU1MDI0XHVGRjA4XHUzMEIwXHUzMEVCXHUzMEZDXHUzMEQ3XHU1MTg1XHUzMDY3XHU1NDBDXHU0RTAwXHVGRjA5XG4gICAgZm9yIChjb25zdCBmIG9mIGdyb3VwQnlGaWVsZHMpIHtcbiAgICAgIG91dFJvd1tmXSA9IGdyb3VwUm93c1swXVtmXSA/PyBcIlwiO1xuICAgIH1cblxuICAgIC8vIFx1OTZDNlx1OEEwOFx1MzBBQlx1MzBFOVx1MzBFMFx1MzA5Mlx1OEE1NVx1NEZBMVxuICAgIGZvciAoY29uc3QgY29sIG9mIGNvbHVtbnMpIHtcbiAgICAgIGlmIChjb2wudHlwZSAhPT0gXCJBR0dSRUdBVEVcIikgY29udGludWU7XG4gICAgICBjb25zdCBvdXRwdXRLZXkgPSBjb2wuYWxpYXMgPz8gYWdncmVnYXRlU3ludGhldGljTmFtZShjb2wuZnVuYywgY29sLmRpc3RpbmN0LCBjb2wuYXJnKTtcbiAgICAgIG91dFJvd1tvdXRwdXRLZXldID0gU3RyaW5nKGV2YWxBZ2dyZWdhdGUoY29sLmZ1bmMsIGNvbC5kaXN0aW5jdCwgY29sLmFyZywgZ3JvdXBSb3dzKSk7XG4gICAgfVxuXG4gICAgcmVzdWx0LnB1c2gob3V0Um93KTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFx1OTZDNlx1OEEwOFx1OTVBMlx1NjU3MFx1MzA2RVx1OEE1NVx1NEZBMVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGV2YWxBZ2dyZWdhdGUoXG4gIGZ1bmM6IEFnZ3JlZ2F0ZUZ1bmMsXG4gIGRpc3RpbmN0OiBib29sZWFuLFxuICBhcmc6IHN0cmluZyB8IHsgdHlwZTogXCJXSUxEQ0FSRFwiIH0sXG4gIHJvd3M6IFByb2Nlc3NSb3dbXVxuKTogbnVtYmVyIHtcbiAgY29uc3QgaXNXaWxkY2FyZCA9IHR5cGVvZiBhcmcgIT09IFwic3RyaW5nXCI7XG5cbiAgLy8gXHU3NTFGXHUzMDZFXHU2NTg3XHU1QjU3XHU1MjE3XHU1MDI0XHUzMDkyXHU1M0NFXHU5NkM2XHVGRjA4TlVMTC9cdTdBN0FcdTY1ODdcdTVCNTdcdTMwNkZcdTMwQjlcdTMwQURcdTMwQzNcdTMwRDdcdTMwMDFDT1VOVCgqKSBcdTMwNkZcdTk2NjRcdTMwNEZcdUZGMDlcbiAgY29uc3QgcmF3VmFsdWVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJvdyBvZiByb3dzKSB7XG4gICAgaWYgKGlzV2lsZGNhcmQpIHtcbiAgICAgIHJhd1ZhbHVlcy5wdXNoKFwiXCIpOyAvLyBDT1VOVCgqKSBcdTc1MjhcdTMwNkVcdTMwQzBcdTMwREZcdTMwRkNcdUZGMDhcdTUwMjRcdTMwNkZcdTRGN0ZcdTMwOEZcdTMwNkFcdTMwNDRcdUZGMDlcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcmF3ID0gcm93W2FyZyBhcyBzdHJpbmddO1xuICAgICAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdyA9PT0gXCJcIikgY29udGludWU7XG4gICAgICByYXdWYWx1ZXMucHVzaChyYXcpO1xuICAgIH1cbiAgfVxuXG4gIC8vIERJU1RJTkNUOiBcdTY1ODdcdTVCNTdcdTUyMTdcdTMwRUNcdTMwRDlcdTMwRUJcdTMwNjdcdTkxQ0RcdTg5MDdcdTk2NjRcdTUzQkJcbiAgY29uc3QgZWZmZWN0aXZlUmF3ID0gZGlzdGluY3QgPyBbLi4ubmV3IFNldChyYXdWYWx1ZXMpXSA6IHJhd1ZhbHVlcztcblxuICAvLyBDT1VOVDogXHU0RUY2XHU2NTcwXHUzMDkyXHU4RkQ0XHUzMDU5XHVGRjA4XHU2NTcwXHU1MDI0XHU1OTA5XHU2M0RCXHU0RTBEXHU4OTgxXHVGRjA5XG4gIGlmIChmdW5jID09PSBcIkNPVU5UXCIpIHtcbiAgICByZXR1cm4gaXNXaWxkY2FyZCA/IHJvd3MubGVuZ3RoIDogZWZmZWN0aXZlUmF3Lmxlbmd0aDtcbiAgfVxuXG4gIC8vIFNVTSAvIEFWRyAvIE1BWCAvIE1JTjogXHU2NTcwXHU1MDI0XHUzMDZCXHU1OTA5XHU2M0RCXHUzMDU3XHUzMDY2XHU5NkM2XHU4QTA4XG4gIGNvbnN0IG51bXMgPSBlZmZlY3RpdmVSYXcubWFwKE51bWJlcik7XG4gIHN3aXRjaCAoZnVuYykge1xuICAgIGNhc2UgXCJTVU1cIjogcmV0dXJuIG51bXMucmVkdWNlKChhLCBiKSA9PiBhICsgYiwgMCk7XG4gICAgY2FzZSBcIkFWR1wiOiByZXR1cm4gbnVtcy5sZW5ndGggPT09IDAgPyAwIDogbnVtcy5yZWR1Y2UoKGEsIGIpID0+IGEgKyBiLCAwKSAvIG51bXMubGVuZ3RoO1xuICAgIGNhc2UgXCJNQVhcIjogcmV0dXJuIG51bXMubGVuZ3RoID09PSAwID8gMCA6IE1hdGgubWF4KC4uLm51bXMpO1xuICAgIGNhc2UgXCJNSU5cIjogcmV0dXJuIG51bXMubGVuZ3RoID09PSAwID8gMCA6IE1hdGgubWluKC4uLm51bXMpO1xuICB9XG59XG5cbi8vIFwiQ09VTlQoKilcIiAvIFwiU1VNKFx1OTFEMVx1OTg0RClcIiAvIFwiQ09VTlQoRElTVElOQ1QgXHU3QTJFXHU1MjI1KVwiIFx1NUY2Mlx1NUYwRlx1MzA2RVx1NTQwOFx1NjIxMFx1NTQwRFxuZnVuY3Rpb24gYWdncmVnYXRlU3ludGhldGljTmFtZShcbiAgZnVuYzogQWdncmVnYXRlRnVuYyxcbiAgZGlzdGluY3Q6IGJvb2xlYW4sXG4gIGFyZzogdW5rbm93blxuKTogc3RyaW5nIHtcbiAgY29uc3QgYXJnU3RyID0gdHlwZW9mIGFyZyA9PT0gXCJzdHJpbmdcIiA/IGFyZyA6IFwiKlwiO1xuICByZXR1cm4gZGlzdGluY3QgPyBgJHtmdW5jfShESVNUSU5DVCAke2FyZ1N0cn0pYCA6IGAke2Z1bmN9KCR7YXJnU3RyfSlgO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIDUuIGhhdmluZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUhhdmluZyhcbiAgcm93czogUHJvY2Vzc1Jvd1tdLFxuICBoYXZpbmc6IFdoZXJlRXhwciB8IG51bGxcbik6IFByb2Nlc3NSb3dbXSB7XG4gIGlmIChoYXZpbmcgPT09IG51bGwpIHJldHVybiByb3dzO1xuICByZXR1cm4gcm93cy5maWx0ZXIoKHJvdykgPT4gZXZhbFdoZXJlKGhhdmluZywgcm93KSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gNi4gZGlzdGluY3Rcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFNFTEVDVCBcdTUyMTdcdTMwNkJcdTU3RkFcdTMwNjVcdTMwNDRcdTMwNjZcdTkxQ0RcdTg5MDdcdTg4NENcdTMwOTJcdTk2NjRcdTUzQkJcdTMwNTlcdTMwOEJcdTMwMDJcbiAqIEdST1VQIEJZIFx1NUY4Q1x1MzA2Qlx1MzA2Rlx1NEUwRFx1ODk4MVx1MzA2MFx1MzA0QyBESVNUSU5DVCBTRUxFQ1QgXHUzMDY3XHUzMDZGXHU0RjdGXHU3NTI4XHUzMDU5XHUzMDhCXHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseURpc3RpbmN0KFxuICByb3dzOiBQcm9jZXNzUm93W10sXG4gIGNvbHVtbnM6IFNlbGVjdENvbHVtbltdXG4pOiBQcm9jZXNzUm93W10ge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHJldHVybiByb3dzLmZpbHRlcigocm93KSA9PiB7XG4gICAgY29uc3Qga2V5ID0gYnVpbGREaXN0aW5jdEtleShyb3csIGNvbHVtbnMpO1xuICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm4gZmFsc2U7XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkRGlzdGluY3RLZXkocm93OiBQcm9jZXNzUm93LCBjb2x1bW5zOiBTZWxlY3RDb2x1bW5bXSk6IHN0cmluZyB7XG4gIGlmIChjb2x1bW5zLnNvbWUoKGMpID0+IGMudHlwZSA9PT0gXCJXSUxEQ0FSRFwiKSkge1xuICAgIC8vIFNFTEVDVCAqIFx1MjE5MiBcdTUxNjhcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTMwOTJcdTU0MkJcdTMwODBcdTMwQURcdTMwRkNcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoT2JqZWN0LmVudHJpZXMocm93KS5zb3J0KCkpO1xuICB9XG4gIHJldHVybiBjb2x1bW5zXG4gICAgLmZpbHRlcigoYyk6IGMgaXMgRXh0cmFjdDxTZWxlY3RDb2x1bW4sIHsgdHlwZTogXCJGSUVMRFwiIH0+ID0+IGMudHlwZSA9PT0gXCJGSUVMRFwiKVxuICAgIC5tYXAoKGMpID0+IHJvd1tjLmZpZWxkXSA/PyBcIlwiKVxuICAgIC5qb2luKFwiXFx4MDBcIik7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gNy4gb3JkZXJCeVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU9yZGVyQnkoXG4gIHJvd3M6IFByb2Nlc3NSb3dbXSxcbiAgb3JkZXJCeTogT3JkZXJCeUl0ZW1bXVxuKTogUHJvY2Vzc1Jvd1tdIHtcbiAgaWYgKG9yZGVyQnkubGVuZ3RoID09PSAwKSByZXR1cm4gcm93cztcblxuICByZXR1cm4gWy4uLnJvd3NdLnNvcnQoKGEsIGIpID0+IHtcbiAgICBmb3IgKGNvbnN0IHsgZmllbGQsIGRpcmVjdGlvbiB9IG9mIG9yZGVyQnkpIHtcbiAgICAgIGNvbnN0IGF2ID0gYVtmaWVsZF0gPz8gXCJcIjtcbiAgICAgIGNvbnN0IGJ2ID0gYltmaWVsZF0gPz8gXCJcIjtcblxuICAgICAgLy8gXHU2NTcwXHU1MDI0XHU2QkQ0XHU4RjAzXHUzMDRDXHU1M0VGXHU4MEZEXHUzMDZBXHU1ODM0XHU1NDA4XHUzMDZGXHU2NTcwXHU1MDI0XHUzMDY4XHUzMDU3XHUzMDY2XHU2QkQ0XHU4RjAzXG4gICAgICBjb25zdCBhbiA9IE51bWJlcihhdik7XG4gICAgICBjb25zdCBibiA9IE51bWJlcihidik7XG4gICAgICBjb25zdCBudW1lcmljID0gIU51bWJlci5pc05hTihhbikgJiYgIU51bWJlci5pc05hTihibik7XG5cbiAgICAgIGNvbnN0IGNtcCA9IG51bWVyaWMgPyBhbiAtIGJuIDogYXYubG9jYWxlQ29tcGFyZShidiwgXCJqYVwiKTtcbiAgICAgIGlmIChjbXAgIT09IDApIHJldHVybiBkaXJlY3Rpb24gPT09IFwiQVNDXCIgPyBjbXAgOiAtY21wO1xuICAgIH1cbiAgICByZXR1cm4gMDtcbiAgfSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gOC4gbGltaXQgLyBvZmZzZXRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlMaW1pdChcbiAgcm93czogUHJvY2Vzc1Jvd1tdLFxuICBsaW1pdDogbnVtYmVyIHwgbnVsbCxcbiAgb2Zmc2V0OiBudW1iZXIgfCBudWxsXG4pOiBQcm9jZXNzUm93W10ge1xuICBjb25zdCBzdGFydCA9IG9mZnNldCA/PyAwO1xuICBpZiAobGltaXQgPT09IG51bGwpIHJldHVybiByb3dzLnNsaWNlKHN0YXJ0KTtcbiAgcmV0dXJuIHJvd3Muc2xpY2Uoc3RhcnQsIHN0YXJ0ICsgbGltaXQpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIDkuIHByb2plY3QgXHUyMDE0IFNFTEVDVCBcdTUyMTdcdTMwRDdcdTMwRURcdTMwQjhcdTMwQTdcdTMwQUZcdTMwQjdcdTMwRTdcdTMwRjNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFx1NTFFNlx1NzQwNlx1NkUwOFx1MzA3Rlx1ODg0Q1x1MzA0Qlx1MzA4OSBTRUxFQ1QgXHU1M0U1XHUzMDY3XHU2MzA3XHU1QjlBXHUzMDU1XHUzMDhDXHUzMDVGXHU1MjE3XHUzMDYwXHUzMDUxXHUzMDkyXHU1M0Q2XHUzMDhBXHU1MUZBXHUzMDU3XHUzMDAxXG4gKiBBUyBhbGlhcyBcdTMwNENcdTMwNDJcdTMwOENcdTMwNzAgYWxpYXMgXHU1NDBEXHUzMDZCXHU1OTA5XHU2M0RCXHUzMDU3XHUzMDY2XHU4RkQ0XHUzMDU5XHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0KFxuICByb3dzOiBQcm9jZXNzUm93W10sXG4gIGNvbHVtbnM6IFNlbGVjdENvbHVtbltdXG4pOiBQcm9jZXNzUm93W10ge1xuICAvLyBTRUxFQ1QgKiBcdTIxOTIgXHUzMDVEXHUzMDZFXHUzMDdFXHUzMDdFXHU1MTY4XHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XG4gIGlmIChjb2x1bW5zLmxlbmd0aCA9PT0gMSAmJiBjb2x1bW5zWzBdLnR5cGUgPT09IFwiV0lMRENBUkRcIikge1xuICAgIHJldHVybiByb3dzO1xuICB9XG5cbiAgcmV0dXJuIHJvd3MubWFwKChyb3cpID0+IHtcbiAgICBjb25zdCBvdXQ6IFByb2Nlc3NSb3cgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGNvbCBvZiBjb2x1bW5zKSB7XG4gICAgICBzd2l0Y2ggKGNvbC50eXBlKSB7XG4gICAgICAgIGNhc2UgXCJXSUxEQ0FSRFwiOlxuICAgICAgICAgIE9iamVjdC5hc3NpZ24ob3V0LCByb3cpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiRklFTERcIjoge1xuICAgICAgICAgIGNvbnN0IGtleSA9IGNvbC5hbGlhcyA/PyBjb2wuZmllbGQ7XG4gICAgICAgICAgb3V0W2tleV0gPSByb3dbY29sLmZpZWxkXSA/PyBcIlwiO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGNhc2UgXCJBR0dSRUdBVEVcIjoge1xuICAgICAgICAgIGNvbnN0IHNyY0tleSA9IGFnZ3JlZ2F0ZVN5bnRoZXRpY05hbWUoY29sLmZ1bmMsIGNvbC5kaXN0aW5jdCwgY29sLmFyZyk7XG4gICAgICAgICAgY29uc3QgZHN0S2V5ID0gY29sLmFsaWFzID8/IHNyY0tleTtcbiAgICAgICAgICAvLyBHUk9VUCBCWSBcdTVGOENcdTMwNkVcdTg4NENcdTMwNkJcdTMwNkYgYWxpYXMgXHUzMDRCXHU1NDA4XHU2MjEwXHU1NDBEXHUzMDY3XHUzMEFEXHUzMEZDXHUzMDRDXHU1MTY1XHUzMDYzXHUzMDY2XHUzMDQ0XHUzMDhCXG4gICAgICAgICAgb3V0W2RzdEtleV0gPSByb3dbY29sLmFsaWFzID8/IHNyY0tleV0gPz8gcm93W3NyY0tleV0gPz8gXCIwXCI7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHU3RDcxXHU1NDA4XHUzMEE4XHUzMEYzXHUzMEM4XHUzMEVBXHUzMEREXHUzMEE0XHUzMEYzXHUzMEM4OiBGVUxMX1NDQU4gXHUzMEQxXHUzMEE0XHUzMEQ3XHUzMEU5XHUzMEE0XHUzMEYzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGludGVyZmFjZSBGdWxsU2NhbklucHV0IHtcbiAgLyoqIFx1MzBFMVx1MzBBNFx1MzBGM1x1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlx1RkYwOGFsaWFzIFx1MjE5MiByZWNvcmRzXHVGRjA5ICovXG4gIHRhYmxlczogTWFwPHN0cmluZyB8IG51bGwsIEtpbnRvbmVSZWNvcmRbXT47XG4gIHN0bXQ6IFNlbGVjdFN0YXRlbWVudDtcbn1cblxuLyoqXG4gKiBGVUxMX1NDQU4gXHUzMEUyXHUzMEZDXHUzMEM5XHUzMDZFXHU1MTY4XHU1MUU2XHU3NDA2XHUzMDkyXHU0RTAwXHU2QzE3XHUzMDZCXHU1QjlGXHU4ODRDXHUzMDU5XHUzMDhCXHUzMDAyXG4gKiBcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUJcdTMwNkYgeyBhbGlhcyBcdTIxOTIgS2ludG9uZVJlY29yZFtdIH0gXHUzMDZFIE1hcCBcdTMwNjdcdTZFMjFcdTMwNTlcdTMwMDJcbiAqXG4gKiBcdTUzNThcdTRFMDBcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUI6IE1hcCBcdTMwNkIgYWxpYXM9bnVsbCBcdTMwNjcgMVx1MzBBOFx1MzBGM1x1MzBDOFx1MzBFQVxuICogSk9JTjogICAgICAgIE1hcCBcdTMwNkIgYWxpYXMgXHUzMDU0XHUzMDY4XHUzMDZFXHUzMEE4XHUzMEYzXHUzMEM4XHUzMEVBXHUzMDkyXHU4OTA3XHU2NTcwXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5GdWxsU2NhbihpbnB1dDogRnVsbFNjYW5JbnB1dCk6IFByb2Nlc3NSb3dbXSB7XG4gIGNvbnN0IHsgc3RtdCwgdGFibGVzIH0gPSBpbnB1dDtcblxuICAvLyAxLiBmbGF0dGVuXG4gIGxldCByb3dzOiBQcm9jZXNzUm93W10gPSBbXTtcbiAgY29uc3QgbWFpbkFsaWFzID0gc3RtdC5mcm9tLmFsaWFzO1xuICBjb25zdCBtYWluUmVjb3JkcyA9IHRhYmxlcy5nZXQobWFpbkFsaWFzKSA/PyB0YWJsZXMuZ2V0KG51bGwpID8/IFtdO1xuICByb3dzID0gbWFpblJlY29yZHMubWFwKChyKSA9PiBmbGF0dGVuKHIsIG1haW5BbGlhcykpO1xuXG4gIC8vIDIuIGpvaW5cbiAgZm9yIChjb25zdCBqb2luIG9mIHN0bXQuam9pbnMpIHtcbiAgICBjb25zdCByaWdodEFsaWFzID0gam9pbi50YWJsZS5hbGlhcztcbiAgICBjb25zdCByaWdodFJlY29yZHMgPSB0YWJsZXMuZ2V0KHJpZ2h0QWxpYXMpID8/IFtdO1xuICAgIGNvbnN0IHJpZ2h0Um93cyA9IHJpZ2h0UmVjb3Jkcy5tYXAoKHIpID0+IGZsYXR0ZW4ociwgcmlnaHRBbGlhcykpO1xuICAgIHJvd3MgPSBhcHBseUpvaW4ocm93cywgcmlnaHRSb3dzLCBqb2luKTtcbiAgfVxuXG4gIC8vIDMuIGZpbHRlclx1RkYwOEpPSU4gXHU1RjhDXHUzMDZCIFdIRVJFIFx1MzA5MiBKUyBcdThBNTVcdTRGQTFcdUZGMDlcbiAgaWYgKHN0bXQuam9pbnMubGVuZ3RoID4gMCkge1xuICAgIHJvd3MgPSBhcHBseUZpbHRlcihyb3dzLCBzdG10LndoZXJlKTtcbiAgfVxuXG4gIC8vIDQuIEdST1VQIEJZICsgXHU5NkM2XHU4QTA4XG4gIGlmIChzdG10Lmdyb3VwQnkubGVuZ3RoID4gMCkge1xuICAgIHJvd3MgPSBhcHBseUdyb3VwQnkocm93cywgc3RtdC5ncm91cEJ5LCBzdG10LmNvbHVtbnMpO1xuICB9XG5cbiAgLy8gNS4gSEFWSU5HXG4gIHJvd3MgPSBhcHBseUhhdmluZyhyb3dzLCBzdG10LmhhdmluZyk7XG5cbiAgLy8gNi4gRElTVElOQ1RcbiAgaWYgKHN0bXQuZGlzdGluY3QpIHtcbiAgICByb3dzID0gYXBwbHlEaXN0aW5jdChyb3dzLCBzdG10LmNvbHVtbnMpO1xuICB9XG5cbiAgLy8gNy4gT1JERVIgQllcbiAgcm93cyA9IGFwcGx5T3JkZXJCeShyb3dzLCBzdG10Lm9yZGVyQnkpO1xuXG4gIC8vIDguIExJTUlUIC8gT0ZGU0VUXG4gIHJvd3MgPSBhcHBseUxpbWl0KHJvd3MsIHN0bXQubGltaXQsIHN0bXQub2Zmc2V0KTtcblxuICAvLyA5LiBwcm9qZWN0XG4gIHJvd3MgPSBwcm9qZWN0KHJvd3MsIHN0bXQuY29sdW1ucyk7XG5cbiAgcmV0dXJuIHJvd3M7XG59XG4iLCAiLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBleGVjdXRlIFx1MjAxNCBTUUwgXHU2NTg3XHU1QjU3XHU1MjE3XHUzMDkyXHU1M0Q3XHUzMDUxXHU1M0Q2XHUzMDhBIGtpbnRvbmUgQVBJIFx1MzA5Mlx1NTQ3Q1x1MzA3M1x1NTFGQVx1MzA1N1x1MzA2Nlx1N0Q1MFx1Njc5Q1x1MzA5Mlx1OEZENFx1MzA1OVxuLy9cbi8vIFx1NEY5RFx1NUI1OFx1OTVBMlx1NEZDMlx1MzA2Rlx1MzA1OVx1MzA3OVx1MzA2Nlx1NkNFOFx1NTE2NVx1RkYwOEtpbnRvbmVDbGllbnRcdUZGMDlcdTMwNTlcdTMwOEJcdTMwNUZcdTMwODFcdTMwMDFcbi8vIGtpbnRvbmUgXHU3NEIwXHU1ODgzXHU1OTE2XHUzMDY3XHUzMDZFXHUzMEM2XHUzMEI5XHUzMEM4XHUzMDRDXHU1M0VGXHU4MEZEXHUzMDAyXG4vL1xuLy8gXHU1MUU2XHU3NDA2XHUzMEQ1XHUzMEVEXHUzMEZDOlxuLy8gICBTRUxFQ1RcdUZGMDhTSU1QTEVcdUZGMDkgIFx1MjE5MiBHRVQgXHUyMTkyIHByb2plY3Rcbi8vICAgU0VMRUNUXHVGRjA4RlVMTF9TQ0FOXHVGRjA5XHUyMTkyIFx1NTE2OFx1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQiBmZXRjaEFsbCBcdTIxOTIgcnVuRnVsbFNjYW5cbi8vICAgSU5TRVJUICAgICAgICAgICAgXHUyMTkyIFBPU1RcdUZGMDgxMDBcdTRFRjZcdTMwRDBcdTMwQzNcdTMwQzFcdUZGMDlcbi8vICAgVVBEQVRFICAgICAgICAgICAgXHUyMTkyIGZldGNoQWxsXHVGRjA4JGlkIFx1NTNENlx1NUY5N1x1RkYwOVx1MjE5MiBcdTc4QkFcdThBOEQgXHUyMTkyIFBVVCBcdTMwRDBcdTMwQzNcdTMwQzFcbi8vICAgREVMRVRFICAgICAgICAgICAgXHUyMTkyIGZldGNoQWxsXHVGRjA4JGlkIFx1NTNENlx1NUY5N1x1RkYwOVx1MjE5MiBcdTc4QkFcdThBOEQgXHUyMTkyIERFTEVURSBcdTMwRDBcdTMwQzNcdTMwQzFcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5pbXBvcnQgeyBMZXhlciwgTGV4RXJyb3IgfSBmcm9tIFwiLi9sZXhlci9sZXhlclwiO1xuaW1wb3J0IHsgUGFyc2VyLCBQYXJzZUVycm9yIH0gZnJvbSBcIi4vcGFyc2VyL3BhcnNlclwiO1xuaW1wb3J0IHR5cGUgeyBTZWxlY3RTdGF0ZW1lbnQgfSBmcm9tIFwiLi90eXBlcy9hc3RcIjtcbmltcG9ydCB7IHJlc29sdmVTZWxlY3RNb2RlLCBzZWxlY3RUb0tpbnRvbmVQYXJhbXMsIHNlbGVjdFRvRmV0Y2hBbGxQYXJhbXMgfSBmcm9tIFwiLi9jb252ZXJ0ZXIvc2VsZWN0VG9LaW50b25lXCI7XG5pbXBvcnQge1xuICBpbnNlcnRUb1Bvc3RCYXRjaGVzLFxuICB1cGRhdGVUb0dldFF1ZXJ5LFxuICB1cGRhdGVUb1B1dEJhdGNoZXMsXG4gIGhhc0FyaXRoQXNzaWdubWVudCxcbiAgdXBkYXRlVG9HZXRRdWVyeUZvckFyaXRoLFxuICB1cGRhdGVUb1B1dEJhdGNoZXNBcml0aCxcbiAgZGVsZXRlVG9HZXRRdWVyeSxcbiAgZGVsZXRlVG9EZWxldGVCYXRjaGVzLFxuICBLaW50b25lUG9zdFBhcmFtcyxcbiAgS2ludG9uZVB1dFBhcmFtcyxcbiAgS2ludG9uZURlbGV0ZVBhcmFtcyxcbn0gZnJvbSBcIi4vY29udmVydGVyL2RtbFRvS2ludG9uZVwiO1xuaW1wb3J0IHsgZmV0Y2hBbGwsIGV4dHJhY3RJZHMsIFBhZ2VGZXRjaGVyIH0gZnJvbSBcIi4vYXBpL2ZldGNoQWxsXCI7XG5pbXBvcnQgeyBydW5GdWxsU2NhbiwgcHJvamVjdCwgZmxhdHRlbiwgUHJvY2Vzc1JvdyB9IGZyb20gXCIuL2VuZ2luZS9wcm9jZXNzXCI7XG5pbXBvcnQgdHlwZSB7IEtpbnRvbmVSZWNvcmQgfSBmcm9tIFwiLi9jb252ZXJ0ZXIvZG1sVG9LaW50b25lXCI7XG5pbXBvcnQgdHlwZSB7IEtpbnRvbmVHZXRSZXNwb25zZSB9IGZyb20gXCIuL2FwaS9mZXRjaEFsbFwiO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIGtpbnRvbmUgQVBJIFx1MzBBRlx1MzBFOVx1MzBBNFx1MzBBMlx1MzBGM1x1MzBDOFx1MzBBNFx1MzBGM1x1MzBCRlx1MzBGQ1x1MzBENVx1MzBBN1x1MzBGQ1x1MzBCOVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBpbnRlcmZhY2UgS2ludG9uZUNsaWVudCB7XG4gIC8qKiBHRVQgL2svdjEvcmVjb3Jkcy5qc29uXHVGRjA4MVx1MzBEQVx1MzBGQ1x1MzBCOFx1NTIwNlx1RkYwOSAqL1xuICBnZXRSZWNvcmRzOiBQYWdlRmV0Y2hlcjtcbiAgLyoqIFBPU1QgL2svdjEvcmVjb3Jkcy5qc29uXHVGRjA4SU5TRVJUXHVGRjA5ICovXG4gIHBvc3RSZWNvcmRzOiAocGFyYW1zOiBLaW50b25lUG9zdFBhcmFtcykgPT4gUHJvbWlzZTx7IGlkczogc3RyaW5nW10gfT47XG4gIC8qKiBQVVQgL2svdjEvcmVjb3Jkcy5qc29uXHVGRjA4VVBEQVRFXHVGRjA5ICovXG4gIHB1dFJlY29yZHM6IChwYXJhbXM6IEtpbnRvbmVQdXRQYXJhbXMpID0+IFByb21pc2U8dm9pZD47XG4gIC8qKiBERUxFVEUgL2svdjEvcmVjb3Jkcy5qc29uXHVGRjA4REVMRVRFXHVGRjA5ICovXG4gIGRlbGV0ZVJlY29yZHM6IChwYXJhbXM6IEtpbnRvbmVEZWxldGVQYXJhbXMpID0+IFByb21pc2U8dm9pZD47XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHU1QjlGXHU4ODRDXHU3RDUwXHU2NzlDXHU1NzhCXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IHR5cGUgRXhlY3V0ZVJlc3VsdCA9XG4gIHwgU2VsZWN0UmVzdWx0XG4gIHwgSW5zZXJ0UmVzdWx0XG4gIHwgVXBkYXRlUmVzdWx0XG4gIHwgRGVsZXRlUmVzdWx0O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNlbGVjdFJlc3VsdCB7XG4gIHR5cGU6IFwiU0VMRUNUXCI7XG4gIHJvd3M6IFByb2Nlc3NSb3dbXTtcbiAgLyoqIFx1NUI5Rlx1OTY5Qlx1MzA2Qlx1OEZENFx1MzA1N1x1MzA1Rlx1ODg0Q1x1NjU3MFx1RkYwOExJTUlUIFx1OTA2OVx1NzUyOFx1NUY4Q1x1RkYwOSAqL1xuICByb3dDb3VudDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEluc2VydFJlc3VsdCB7XG4gIHR5cGU6IFwiSU5TRVJUXCI7XG4gIC8qKiBcdTRGNUNcdTYyMTBcdTMwNTVcdTMwOENcdTMwNUZcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzkgSURcdUZGMDhcdTMwRDBcdTMwQzNcdTMwQzFcdTMwNTRcdTMwNjhcdUZGMDkgKi9cbiAgY3JlYXRlZElkczogc3RyaW5nW11bXTtcbiAgaW5zZXJ0ZWRDb3VudDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFVwZGF0ZVJlc3VsdCB7XG4gIHR5cGU6IFwiVVBEQVRFXCI7XG4gIHVwZGF0ZWRDb3VudDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERlbGV0ZVJlc3VsdCB7XG4gIHR5cGU6IFwiREVMRVRFXCI7XG4gIGRlbGV0ZWRDb3VudDogbnVtYmVyO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1MzBBQVx1MzBEN1x1MzBCN1x1MzBFN1x1MzBGM1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXhlY3V0ZU9wdGlvbnMge1xuICAvKipcbiAgICogVVBEQVRFIC8gREVMRVRFIFx1NUI5Rlx1ODg0Q1x1NTI0RFx1MzA2Qlx1NTQ3Q1x1MzA3MFx1MzA4Q1x1MzA4Qlx1NzhCQVx1OEE4RFx1MzBCM1x1MzBGQ1x1MzBFQlx1MzBEMFx1MzBDM1x1MzBBRlx1MzAwMlxuICAgKiBmYWxzZSBcdTMwOTJcdThGRDRcdTMwNTlcdTMwNjhcdTMwQURcdTMwRTNcdTMwRjNcdTMwQkJcdTMwRUJcdTMwNTdcdTMwNjYgT3BlcmF0aW9uQ2FuY2VsbGVkRXJyb3IgXHUzMDkyXHU2Mjk1XHUzMDUyXHUzMDhCXHUzMDAyXG4gICAqIFx1NzcwMVx1NzU2NVx1NjY0Mlx1MzA2Rlx1NzhCQVx1OEE4RFx1MzA2QVx1MzA1N1x1MzA2N1x1NUI5Rlx1ODg0Q1x1MzAwMlxuICAgKi9cbiAgY29uZmlybT86IChjb3VudDogbnVtYmVyLCBvcGVyYXRpb246IFwiVVBEQVRFXCIgfCBcIkRFTEVURVwiKSA9PiBQcm9taXNlPGJvb2xlYW4+O1xuICAvKiogXHU1MTY4XHU0RUY2XHU1M0Q2XHU1Rjk3XHUzMDZFXHU0RTBBXHU5NjUwXHVGRjA4XHUzMEM3XHUzMEQ1XHUzMEE5XHUzMEVCXHUzMEM4OiAxMF8wMDBcdUZGMDkgKi9cbiAgbWF4UmVjb3Jkcz86IG51bWJlcjtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdTMwRTFcdTMwQTRcdTMwRjM6IGV4ZWN1dGVcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFNRTCBcdTY1ODdcdTVCNTdcdTUyMTdcdTMwOTJcdTUzRDdcdTMwNTFcdTUzRDZcdTMwOEFcdTMwMDFraW50b25lIEFQSSBcdTMwOTJcdTU0N0NcdTMwNzNcdTUxRkFcdTMwNTdcdTMwNjZcdTdENTBcdTY3OUNcdTMwOTJcdThGRDRcdTMwNTlcdTMwMDJcbiAqXG4gKiBAcGFyYW0gc3FsICAgICBTUUwgXHU2NTg3XHU1QjU3XHU1MjE3XG4gKiBAcGFyYW0gY2xpZW50ICBraW50b25lIEFQSSBcdTMwQUZcdTMwRTlcdTMwQTRcdTMwQTJcdTMwRjNcdTMwQzhcbiAqIEBwYXJhbSBvcHRpb25zIFx1NzhCQVx1OEE4RFx1MzBCM1x1MzBGQ1x1MzBFQlx1MzBEMFx1MzBDM1x1MzBBRlx1MzBGQlx1NEUwQVx1OTY1MFx1NEVGNlx1NjU3MFx1N0I0OVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZShcbiAgc3FsOiBzdHJpbmcsXG4gIGNsaWVudDogS2ludG9uZUNsaWVudCxcbiAgb3B0aW9uczogRXhlY3V0ZU9wdGlvbnMgPSB7fVxuKTogUHJvbWlzZTxFeGVjdXRlUmVzdWx0PiB7XG4gIC8vIDEuIFx1MzBEMVx1MzBGQ1x1MzBCOVxuICBjb25zdCBzdG10ID0gcGFyc2VTcWwoc3FsKTtcblxuICAvLyAyLiBcdTY1ODdcdTMwNkVcdTdBMkVcdTUyMjVcdTMwNjdcdTMwRUJcdTMwRkNcdTMwQzZcdTMwQTNcdTMwRjNcdTMwQjBcbiAgc3dpdGNoIChzdG10LnR5cGUpIHtcbiAgICBjYXNlIFwiU0VMRUNUXCI6IHJldHVybiBleGVjdXRlU2VsZWN0KHN0bXQsIGNsaWVudCwgb3B0aW9ucyk7XG4gICAgY2FzZSBcIklOU0VSVFwiOiByZXR1cm4gZXhlY3V0ZUluc2VydChzdG10LCBjbGllbnQpO1xuICAgIGNhc2UgXCJVUERBVEVcIjogcmV0dXJuIGV4ZWN1dGVVcGRhdGUoc3RtdCwgY2xpZW50LCBvcHRpb25zKTtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBleGVjdXRlRGVsZXRlKHN0bXQsIGNsaWVudCwgb3B0aW9ucyk7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTRUxFQ1Rcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5hc3luYyBmdW5jdGlvbiBleGVjdXRlU2VsZWN0KFxuICBzdG10OiBTZWxlY3RTdGF0ZW1lbnQsXG4gIGNsaWVudDogS2ludG9uZUNsaWVudCxcbiAgb3B0aW9uczogRXhlY3V0ZU9wdGlvbnNcbik6IFByb21pc2U8U2VsZWN0UmVzdWx0PiB7XG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlU2VsZWN0TW9kZShzdG10KTtcblxuICBpZiAobW9kZSA9PT0gXCJTSU1QTEVcIikge1xuICAgIHJldHVybiBleGVjdXRlU2ltcGxlU2VsZWN0KHN0bXQsIGNsaWVudCk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGV4ZWN1dGVGdWxsU2NhblNlbGVjdChzdG10LCBjbGllbnQsIG9wdGlvbnMpO1xuICB9XG59XG5cbi8qKiBTSU1QTEUgXHUzMEUyXHUzMEZDXHUzMEM5OiBraW50b25lIFx1MzBBRlx1MzBBOFx1MzBFQVx1MzA2Qlx1NTkwOVx1NjNEQlx1MzA1N1x1MzA2NiBHRVQgXHUyMTkyIHByb2plY3QgKi9cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTaW1wbGVTZWxlY3QoXG4gIHN0bXQ6IFNlbGVjdFN0YXRlbWVudCxcbiAgY2xpZW50OiBLaW50b25lQ2xpZW50XG4pOiBQcm9taXNlPFNlbGVjdFJlc3VsdD4ge1xuICBjb25zdCBwYXJhbXMgPSBzZWxlY3RUb0tpbnRvbmVQYXJhbXMoc3RtdCk7XG5cbiAgLy8ga2ludG9uZSBcdTMwNkZcdTY3MDBcdTU5MjcgNTAwIFx1NEVGNlx1MzA2QVx1MzA2RVx1MzA2NyBMSU1JVCBcdTMwNEMgNTAwIFx1NEVFNVx1NEUwQlx1MzA2QVx1MzA4OVx1MzBEQVx1MzBGQ1x1MzBCOFx1MzBGM1x1MzBCMFx1MzA2Rlx1NEUwRFx1ODk4MVxuICAvLyBMSU1JVCBcdTYzMDdcdTVCOUFcdTMwNkFcdTMwNTcgb3IgNTAwIFx1OEQ4NVx1MzA2RVx1NTgzNFx1NTQwOFx1MzA2RiBmZXRjaEFsbCBcdTMwOTJcdTRGN0ZcdTMwNDZcbiAgbGV0IHJlY29yZHM6IEtpbnRvbmVSZWNvcmRbXTtcbiAgaWYgKHBhcmFtcy5xdWVyeS5pbmNsdWRlcyhcImxpbWl0XCIpIHx8IChzdG10LmxpbWl0ICE9PSBudWxsICYmIHN0bXQubGltaXQgPD0gNTAwKSkge1xuICAgIGNvbnN0IHJlczogS2ludG9uZUdldFJlc3BvbnNlID0gYXdhaXQgY2xpZW50LmdldFJlY29yZHMoe1xuICAgICAgYXBwOiBwYXJhbXMuYXBwLFxuICAgICAgcXVlcnk6IHBhcmFtcy5xdWVyeSxcbiAgICAgIGZpZWxkczogcGFyYW1zLmZpZWxkcyxcbiAgICB9KTtcbiAgICByZWNvcmRzID0gcmVzLnJlY29yZHM7XG4gIH0gZWxzZSB7XG4gICAgcmVjb3JkcyA9IGF3YWl0IGZldGNoQWxsKFxuICAgICAgY2xpZW50LmdldFJlY29yZHMsXG4gICAgICBwYXJhbXMuYXBwLFxuICAgICAgYnVpbGRCYXNlUXVlcnkocGFyYW1zLnF1ZXJ5KSxcbiAgICAgIHBhcmFtcy5maWVsZHMsXG4gICAgICB7IG1heFJlY29yZHM6IDEwXzAwMCB9XG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJvd3MgPSByZWNvcmRzLm1hcCgocikgPT4gZmxhdHRlbihyLCBudWxsKSk7XG4gIGNvbnN0IHByb2plY3RlZCA9IHByb2plY3Qocm93cywgc3RtdC5jb2x1bW5zKTtcblxuICByZXR1cm4geyB0eXBlOiBcIlNFTEVDVFwiLCByb3dzOiBwcm9qZWN0ZWQsIHJvd0NvdW50OiBwcm9qZWN0ZWQubGVuZ3RoIH07XG59XG5cbi8qKiBGVUxMX1NDQU4gXHUzMEUyXHUzMEZDXHUzMEM5OiBcdTUxNjhcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUJcdTMwOTIgZmV0Y2hBbGwgXHUyMTkyIHJ1bkZ1bGxTY2FuIFx1MzBEMVx1MzBBNFx1MzBEN1x1MzBFOVx1MzBBNFx1MzBGMyAqL1xuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUZ1bGxTY2FuU2VsZWN0KFxuICBzdG10OiBTZWxlY3RTdGF0ZW1lbnQsXG4gIGNsaWVudDogS2ludG9uZUNsaWVudCxcbiAgb3B0aW9uczogRXhlY3V0ZU9wdGlvbnNcbik6IFByb21pc2U8U2VsZWN0UmVzdWx0PiB7XG4gIGNvbnN0IG1heFJlY29yZHMgPSBvcHRpb25zLm1heFJlY29yZHMgPz8gMTBfMDAwO1xuXG4gIC8vIFx1MzBFMVx1MzBBNFx1MzBGM1x1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlx1MzA5Mlx1NTNENlx1NUY5N1xuICBjb25zdCBtYWluUGFyYW1zID0gc2VsZWN0VG9GZXRjaEFsbFBhcmFtcyhzdG10LCBzdG10LmZyb20uYXBwSWQpO1xuICBjb25zdCBtYWluUmVjb3JkcyA9IGF3YWl0IGZldGNoQWxsKFxuICAgIGNsaWVudC5nZXRSZWNvcmRzLFxuICAgIG1haW5QYXJhbXMuYXBwLFxuICAgIG1haW5QYXJhbXMucXVlcnksXG4gICAgbWFpblBhcmFtcy5maWVsZHMsXG4gICAgeyBtYXhSZWNvcmRzIH1cbiAgKTtcblxuICAvLyBKT0lOIFx1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlx1MzA5Mlx1NEUyNlx1NTIxN1x1NTNENlx1NUY5N1xuICBjb25zdCB0YWJsZXMgPSBuZXcgTWFwPHN0cmluZyB8IG51bGwsIEtpbnRvbmVSZWNvcmRbXT4oKTtcbiAgdGFibGVzLnNldChzdG10LmZyb20uYWxpYXMsIG1haW5SZWNvcmRzKTtcblxuICBjb25zdCBqb2luRmV0Y2hlcyA9IHN0bXQuam9pbnMubWFwKGFzeW5jIChqb2luKSA9PiB7XG4gICAgY29uc3Qgam9pblBhcmFtcyA9IHNlbGVjdFRvRmV0Y2hBbGxQYXJhbXMoc3RtdCwgam9pbi50YWJsZS5hcHBJZCk7XG4gICAgY29uc3Qgam9pblJlY29yZHMgPSBhd2FpdCBmZXRjaEFsbChcbiAgICAgIGNsaWVudC5nZXRSZWNvcmRzLFxuICAgICAgam9pbi50YWJsZS5hcHBJZCxcbiAgICAgIFwiXCIsICAgLy8gSk9JTiBcdTMwQzZcdTMwRkNcdTMwRDZcdTMwRUJcdTMwNkYgV0hFUkUgXHUzMDZBXHUzMDU3XHUzMDY3XHU1MTY4XHU0RUY2XHU1M0Q2XHU1Rjk3XG4gICAgICBbXSxcbiAgICAgIHsgbWF4UmVjb3JkcyB9XG4gICAgKTtcbiAgICB0YWJsZXMuc2V0KGpvaW4udGFibGUuYWxpYXMsIGpvaW5SZWNvcmRzKTtcbiAgfSk7XG4gIGF3YWl0IFByb21pc2UuYWxsKGpvaW5GZXRjaGVzKTtcblxuICAvLyBKUyBcdTk2QzZcdThBMDhcdTMwRDFcdTMwQTRcdTMwRDdcdTMwRTlcdTMwQTRcdTMwRjNcbiAgY29uc3Qgcm93cyA9IHJ1bkZ1bGxTY2FuKHsgdGFibGVzLCBzdG10IH0pO1xuXG4gIHJldHVybiB7IHR5cGU6IFwiU0VMRUNUXCIsIHJvd3MsIHJvd0NvdW50OiByb3dzLmxlbmd0aCB9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIElOU0VSVFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVJbnNlcnQoXG4gIHN0bXQ6IEV4dHJhY3Q8QXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZVNxbD4+LCB7IHR5cGU6IFwiSU5TRVJUXCIgfT4sXG4gIGNsaWVudDogS2ludG9uZUNsaWVudFxuKTogUHJvbWlzZTxJbnNlcnRSZXN1bHQ+IHtcbiAgY29uc3QgYmF0Y2hlcyA9IGluc2VydFRvUG9zdEJhdGNoZXMoc3RtdCk7XG4gIGNvbnN0IGNyZWF0ZWRJZHM6IHN0cmluZ1tdW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IGJhdGNoIG9mIGJhdGNoZXMpIHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBjbGllbnQucG9zdFJlY29yZHMoYmF0Y2gpO1xuICAgIGNyZWF0ZWRJZHMucHVzaChyZXMuaWRzKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgdHlwZTogXCJJTlNFUlRcIixcbiAgICBjcmVhdGVkSWRzLFxuICAgIGluc2VydGVkQ291bnQ6IGNyZWF0ZWRJZHMuZmxhdCgpLmxlbmd0aCxcbiAgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBVUERBVEVcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5hc3luYyBmdW5jdGlvbiBleGVjdXRlVXBkYXRlKFxuICBzdG10OiBFeHRyYWN0PEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VTcWw+PiwgeyB0eXBlOiBcIlVQREFURVwiIH0+LFxuICBjbGllbnQ6IEtpbnRvbmVDbGllbnQsXG4gIG9wdGlvbnM6IEV4ZWN1dGVPcHRpb25zXG4pOiBQcm9taXNlPFVwZGF0ZVJlc3VsdD4ge1xuICBjb25zdCBtYXhSZWNvcmRzID0gb3B0aW9ucy5tYXhSZWNvcmRzID8/IDEwXzAwMDtcblxuICBpZiAoaGFzQXJpdGhBc3NpZ25tZW50KHN0bXQpKSB7XG4gICAgLy8gXHUyNTAwXHUyNTAwIFx1N0I5N1x1ODg1M1x1NUYwRlx1MzA0Mlx1MzA4QTogXHU3M0ZFXHU1NzI4XHU1MDI0XHUzMDkyXHU1M0Q2XHU1Rjk3XHUzMDU3XHUzMDY2XHUzMDRCXHUzMDg5XHU4QTA4XHU3Qjk3IFx1MjE5MiBQVVQgXHUyNTAwXHUyNTAwXG4gICAgLy8gMS4gJGlkICsgXHU1M0MyXHU3MTY3XHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHUzMDkyXHU1M0Q2XHU1Rjk3XG4gICAgY29uc3QgZ2V0UGFyYW1zID0gdXBkYXRlVG9HZXRRdWVyeUZvckFyaXRoKHN0bXQpO1xuICAgIGNvbnN0IHJlY29yZHMgPSBhd2FpdCBmZXRjaEFsbChcbiAgICAgIGNsaWVudC5nZXRSZWNvcmRzLFxuICAgICAgZ2V0UGFyYW1zLmFwcCxcbiAgICAgIGdldFBhcmFtcy5xdWVyeSxcbiAgICAgIFsuLi5nZXRQYXJhbXMuZmllbGRzXSxcbiAgICAgIHsgbWF4UmVjb3JkcyB9XG4gICAgKTtcblxuICAgIC8vIDIuIFx1NUI5Rlx1ODg0Q1x1NTI0RFx1NzhCQVx1OEE4RFxuICAgIGlmIChvcHRpb25zLmNvbmZpcm0pIHtcbiAgICAgIGNvbnN0IG9rID0gYXdhaXQgb3B0aW9ucy5jb25maXJtKHJlY29yZHMubGVuZ3RoLCBcIlVQREFURVwiKTtcbiAgICAgIGlmICghb2spIHRocm93IG5ldyBPcGVyYXRpb25DYW5jZWxsZWRFcnJvcihcIlVQREFURVwiLCByZWNvcmRzLmxlbmd0aCk7XG4gICAgfVxuXG4gICAgLy8gMy4gXHUzMEVDXHUzMEIzXHUzMEZDXHUzMEM5XHUzMDU0XHUzMDY4XHUzMDZCXHU3Qjk3XHU4ODUzXHU4QTA4XHU3Qjk3XHUzMDU3XHUzMDY2IFBVVFxuICAgIGNvbnN0IGJhdGNoZXMgPSB1cGRhdGVUb1B1dEJhdGNoZXNBcml0aChzdG10LCByZWNvcmRzKTtcbiAgICBmb3IgKGNvbnN0IGJhdGNoIG9mIGJhdGNoZXMpIHtcbiAgICAgIGF3YWl0IGNsaWVudC5wdXRSZWNvcmRzKGJhdGNoKTtcbiAgICB9XG5cbiAgICByZXR1cm4geyB0eXBlOiBcIlVQREFURVwiLCB1cGRhdGVkQ291bnQ6IHJlY29yZHMubGVuZ3RoIH07XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgXHU5MDFBXHU1RTM4XHUzMEQxXHUzMEI5OiAkaWQgXHUzMDZFXHUzMDdGXHU1M0Q2XHU1Rjk3IFx1MjE5MiBcdTU0MENcdTRFMDBcdTUwMjRcdTMwNjdcdTRFMDBcdTYyRUMgUFVUIFx1MjUwMFx1MjUwMFxuICAvLyAxLiBcdTVCRkVcdThDNjFcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzlcdTMwNkUgJGlkIFx1MzA5Mlx1NTNENlx1NUY5N1xuICBjb25zdCBnZXRQYXJhbXMgPSB1cGRhdGVUb0dldFF1ZXJ5KHN0bXQpO1xuICBjb25zdCByZWNvcmRzID0gYXdhaXQgZmV0Y2hBbGwoXG4gICAgY2xpZW50LmdldFJlY29yZHMsXG4gICAgZ2V0UGFyYW1zLmFwcCxcbiAgICBnZXRQYXJhbXMucXVlcnksXG4gICAgWy4uLmdldFBhcmFtcy5maWVsZHNdLFxuICAgIHsgbWF4UmVjb3JkcyB9XG4gICk7XG4gIGNvbnN0IGlkcyA9IGV4dHJhY3RJZHMocmVjb3Jkcyk7XG5cbiAgLy8gMi4gXHU1QjlGXHU4ODRDXHU1MjREXHU3OEJBXHU4QThEXG4gIGlmIChvcHRpb25zLmNvbmZpcm0pIHtcbiAgICBjb25zdCBvayA9IGF3YWl0IG9wdGlvbnMuY29uZmlybShpZHMubGVuZ3RoLCBcIlVQREFURVwiKTtcbiAgICBpZiAoIW9rKSB0aHJvdyBuZXcgT3BlcmF0aW9uQ2FuY2VsbGVkRXJyb3IoXCJVUERBVEVcIiwgaWRzLmxlbmd0aCk7XG4gIH1cblxuICAvLyAzLiBQVVQgXHUzMEQwXHUzMEMzXHUzMEMxXHU1QjlGXHU4ODRDXG4gIGNvbnN0IGJhdGNoZXMgPSB1cGRhdGVUb1B1dEJhdGNoZXMoc3RtdCwgaWRzKTtcbiAgZm9yIChjb25zdCBiYXRjaCBvZiBiYXRjaGVzKSB7XG4gICAgYXdhaXQgY2xpZW50LnB1dFJlY29yZHMoYmF0Y2gpO1xuICB9XG5cbiAgcmV0dXJuIHsgdHlwZTogXCJVUERBVEVcIiwgdXBkYXRlZENvdW50OiBpZHMubGVuZ3RoIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gREVMRVRFXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZURlbGV0ZShcbiAgc3RtdDogRXh0cmFjdDxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHBhcnNlU3FsPj4sIHsgdHlwZTogXCJERUxFVEVcIiB9PixcbiAgY2xpZW50OiBLaW50b25lQ2xpZW50LFxuICBvcHRpb25zOiBFeGVjdXRlT3B0aW9uc1xuKTogUHJvbWlzZTxEZWxldGVSZXN1bHQ+IHtcbiAgLy8gMS4gXHU1QkZFXHU4QzYxXHUzMEVDXHUzMEIzXHUzMEZDXHUzMEM5XHUzMDZFICRpZCBcdTMwOTJcdTUzRDZcdTVGOTdcbiAgY29uc3QgZ2V0UGFyYW1zID0gZGVsZXRlVG9HZXRRdWVyeShzdG10KTtcbiAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IGZldGNoQWxsKFxuICAgIGNsaWVudC5nZXRSZWNvcmRzLFxuICAgIGdldFBhcmFtcy5hcHAsXG4gICAgZ2V0UGFyYW1zLnF1ZXJ5LFxuICAgIFsuLi5nZXRQYXJhbXMuZmllbGRzXSxcbiAgICB7IG1heFJlY29yZHM6IG9wdGlvbnMubWF4UmVjb3JkcyA/PyAxMF8wMDAgfVxuICApO1xuICBjb25zdCBpZHMgPSBleHRyYWN0SWRzKHJlY29yZHMpO1xuXG4gIC8vIDIuIFx1NUI5Rlx1ODg0Q1x1NTI0RFx1NzhCQVx1OEE4RFxuICBpZiAob3B0aW9ucy5jb25maXJtKSB7XG4gICAgY29uc3Qgb2sgPSBhd2FpdCBvcHRpb25zLmNvbmZpcm0oaWRzLmxlbmd0aCwgXCJERUxFVEVcIik7XG4gICAgaWYgKCFvaykgdGhyb3cgbmV3IE9wZXJhdGlvbkNhbmNlbGxlZEVycm9yKFwiREVMRVRFXCIsIGlkcy5sZW5ndGgpO1xuICB9XG5cbiAgLy8gMy4gREVMRVRFIFx1MzBEMFx1MzBDM1x1MzBDMVx1NUI5Rlx1ODg0Q1xuICBjb25zdCBiYXRjaGVzID0gZGVsZXRlVG9EZWxldGVCYXRjaGVzKHN0bXQuYXBwSWQsIGlkcyk7XG4gIGZvciAoY29uc3QgYmF0Y2ggb2YgYmF0Y2hlcykge1xuICAgIGF3YWl0IGNsaWVudC5kZWxldGVSZWNvcmRzKGJhdGNoKTtcbiAgfVxuXG4gIHJldHVybiB7IHR5cGU6IFwiREVMRVRFXCIsIGRlbGV0ZWRDb3VudDogaWRzLmxlbmd0aCB9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1MzBEOFx1MzBFQlx1MzBEMVx1MzBGQ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIHBhcnNlU3FsKHNxbDogc3RyaW5nKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgdG9rZW5zID0gbmV3IExleGVyKHNxbCkudG9rZW5pemUoKTtcbiAgICByZXR1cm4gbmV3IFBhcnNlcih0b2tlbnMpLnBhcnNlKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIExleEVycm9yIHx8IGUgaW5zdGFuY2VvZiBQYXJzZUVycm9yKSB7XG4gICAgICB0aHJvdyBlOyAvLyBcdTY1RTVcdTY3MkNcdThBOUVcdTMwQThcdTMwRTlcdTMwRkNcdTMwRTFcdTMwQzNcdTMwQkJcdTMwRkNcdTMwQjhcdTMwOTJcdTMwNURcdTMwNkVcdTMwN0VcdTMwN0VcdTRGMURcdTY0QURcbiAgICB9XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG4vKipcbiAqIFNJTVBMRSBcdTMwRTJcdTMwRkNcdTMwQzlcdTc1MjhcdTMwQUZcdTMwQThcdTMwRUFcdTMwNEJcdTMwODkgT1JERVIgQlkgLyBMSU1JVCBcdTMwOTJcdTk2NjRcdTMwNDRcdTMwNUZcdTMwRDlcdTMwRkNcdTMwQjlcdTMwQUZcdTMwQThcdTMwRUFcdTMwOTJcdTUzRDZcdTMwOEFcdTUxRkFcdTMwNTlcdTMwMDJcbiAqIGZldGNoQWxsIFx1MzA2Qlx1NkUyMVx1MzA1OVx1MzA1Rlx1MzA4MVx1MzBEQVx1MzBGQ1x1MzBCOFx1MzBGM1x1MzBCMFx1MzBCNVx1MzBENVx1MzBBM1x1MzBDM1x1MzBBRlx1MzBCOVx1MzA5Mlx1ODFFQVx1NTIwNlx1MzA2N1x1NEVEOFx1NEUwRVx1MzA1NVx1MzA1Qlx1MzA4Qlx1MzAwMlxuICovXG5mdW5jdGlvbiBidWlsZEJhc2VRdWVyeShxdWVyeTogc3RyaW5nKTogc3RyaW5nIHtcbiAgLy8gXCJvcmRlciBieVwiIFx1NEVFNVx1OTY0RFx1MzA5Mlx1NTI0QVx1OTY2NFx1MzA1N1x1MzA2NiBXSEVSRSBcdTUzRTVcdTMwNjBcdTMwNTFcdTMwOTJcdTZCOEJcdTMwNTlcbiAgY29uc3QgaWR4ID0gcXVlcnkudG9Mb3dlckNhc2UoKS5pbmRleE9mKFwiIG9yZGVyIGJ5XCIpO1xuICBpZiAoaWR4ICE9PSAtMSkgcmV0dXJuIHF1ZXJ5LnNsaWNlKDAsIGlkeCkudHJpbUVuZCgpO1xuICBjb25zdCBsaW1JZHggPSBxdWVyeS50b0xvd2VyQ2FzZSgpLmluZGV4T2YoXCIgbGltaXRcIik7XG4gIGlmIChsaW1JZHggIT09IC0xKSByZXR1cm4gcXVlcnkuc2xpY2UoMCwgbGltSWR4KS50cmltRW5kKCk7XG4gIHJldHVybiBxdWVyeTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdTMwQThcdTMwRTlcdTMwRkNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgY2xhc3MgT3BlcmF0aW9uQ2FuY2VsbGVkRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHB1YmxpYyByZWFkb25seSBvcGVyYXRpb246IFwiVVBEQVRFXCIgfCBcIkRFTEVURVwiLFxuICAgIHB1YmxpYyByZWFkb25seSBhZmZlY3RlZENvdW50OiBudW1iZXJcbiAgKSB7XG4gICAgc3VwZXIoXG4gICAgICBgJHtvcGVyYXRpb259IFx1MzA5Mlx1MzBBRFx1MzBFM1x1MzBGM1x1MzBCQlx1MzBFQlx1MzA1N1x1MzA3RVx1MzA1N1x1MzA1Rlx1RkYwOFx1NUJGRVx1OEM2MTogJHthZmZlY3RlZENvdW50fSBcdTRFRjZcdUZGMDlgXG4gICAgKTtcbiAgICB0aGlzLm5hbWUgPSBcIk9wZXJhdGlvbkNhbmNlbGxlZEVycm9yXCI7XG4gIH1cbn1cbiIsICIvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIGtpbnRvbmVDbGllbnQgXHUyMDE0IGtpbnRvbmUuYXBpKCkgXHUzMDkyIEtpbnRvbmVDbGllbnQgXHUzMDZCXHU1OTA5XHU2M0RCXHUzMDU5XHUzMDhCXHUzMEEyXHUzMEMwXHUzMEQ3XHUzMEJGXHUzMEZDXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW1wb3J0IHR5cGUgeyBLaW50b25lQ2xpZW50IH0gZnJvbSBcIi4uL2V4ZWN1dGVcIjtcbmltcG9ydCB0eXBlIHtcbiAgS2ludG9uZVBvc3RQYXJhbXMsXG4gIEtpbnRvbmVQdXRQYXJhbXMsXG4gIEtpbnRvbmVEZWxldGVQYXJhbXMsXG59IGZyb20gXCIuLi9jb252ZXJ0ZXIvZG1sVG9LaW50b25lXCI7XG5pbXBvcnQgdHlwZSB7IFBhZ2VGZXRjaFBhcmFtcyB9IGZyb20gXCIuLi9hcGkvZmV0Y2hBbGxcIjtcblxuY29uc3QgUkVDT1JEU19VUkwgPSBcIi9rL3YxL3JlY29yZHMuanNvblwiO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlS2ludG9uZUNsaWVudCgpOiBLaW50b25lQ2xpZW50IHtcbiAgcmV0dXJuIHtcbiAgICBhc3luYyBnZXRSZWNvcmRzKHBhcmFtczogUGFnZUZldGNoUGFyYW1zKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBraW50b25lLmFwaShSRUNPUkRTX1VSTCwgXCJHRVRcIiwge1xuICAgICAgICBhcHA6ICAgIHBhcmFtcy5hcHAsXG4gICAgICAgIHF1ZXJ5OiAgcGFyYW1zLnF1ZXJ5LFxuICAgICAgICBmaWVsZHM6IHBhcmFtcy5maWVsZHMubGVuZ3RoID4gMCA/IHBhcmFtcy5maWVsZHMgOiB1bmRlZmluZWQsXG4gICAgICB9KSBhcyB7IHJlY29yZHM6IFJlY29yZDxzdHJpbmcsIHsgdmFsdWU6IHN0cmluZyB9PltdIH07XG4gICAgICByZXR1cm4geyByZWNvcmRzOiByZXMucmVjb3JkcyB9O1xuICAgIH0sXG5cbiAgICBhc3luYyBwb3N0UmVjb3JkcyhwYXJhbXM6IEtpbnRvbmVQb3N0UGFyYW1zKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBraW50b25lLmFwaShSRUNPUkRTX1VSTCwgXCJQT1NUXCIsIHtcbiAgICAgICAgYXBwOiAgICAgcGFyYW1zLmFwcCxcbiAgICAgICAgcmVjb3JkczogcGFyYW1zLnJlY29yZHMsXG4gICAgICB9KSBhcyB7IGlkczogc3RyaW5nW10gfTtcbiAgICAgIHJldHVybiB7IGlkczogcmVzLmlkcyB9O1xuICAgIH0sXG5cbiAgICBhc3luYyBwdXRSZWNvcmRzKHBhcmFtczogS2ludG9uZVB1dFBhcmFtcykge1xuICAgICAgYXdhaXQga2ludG9uZS5hcGkoUkVDT1JEU19VUkwsIFwiUFVUXCIsIHtcbiAgICAgICAgYXBwOiAgICAgcGFyYW1zLmFwcCxcbiAgICAgICAgcmVjb3JkczogcGFyYW1zLnJlY29yZHMsXG4gICAgICB9KTtcbiAgICB9LFxuXG4gICAgYXN5bmMgZGVsZXRlUmVjb3JkcyhwYXJhbXM6IEtpbnRvbmVEZWxldGVQYXJhbXMpIHtcbiAgICAgIGF3YWl0IGtpbnRvbmUuYXBpKFJFQ09SRFNfVVJMLCBcIkRFTEVURVwiLCB7XG4gICAgICAgIGFwcDogcGFyYW1zLmFwcCxcbiAgICAgICAgaWRzOiBwYXJhbXMuaWRzLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfTtcbn1cbiIsICIvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIHJlbmRlclJlc3VsdCBcdTIwMTQgRXhlY3V0ZVJlc3VsdCBcdTMwOTIgSFRNTCBcdTY1ODdcdTVCNTdcdTUyMTdcdTMwNkJcdTU5MDlcdTYzREJcdTMwNTlcdTMwOEJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5pbXBvcnQgdHlwZSB7IEV4ZWN1dGVSZXN1bHQsIFNlbGVjdFJlc3VsdCB9IGZyb20gXCIuLi9leGVjdXRlXCI7XG5pbXBvcnQgdHlwZSB7IFByb2Nlc3NSb3cgfSBmcm9tIFwiLi4vZW5naW5lL3Byb2Nlc3NcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdTMwRTFcdTMwQTRcdTMwRjNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyUmVzdWx0KHJlc3VsdDogRXhlY3V0ZVJlc3VsdCk6IHN0cmluZyB7XG4gIHN3aXRjaCAocmVzdWx0LnR5cGUpIHtcbiAgICBjYXNlIFwiU0VMRUNUXCI6IHJldHVybiByZW5kZXJTZWxlY3QocmVzdWx0KTtcbiAgICBjYXNlIFwiSU5TRVJUXCI6IHJldHVybiByZW5kZXJTdWNjZXNzKGAke3Jlc3VsdC5pbnNlcnRlZENvdW50fSBcdTRFRjZcdTMwNkVcdTMwRUNcdTMwQjNcdTMwRkNcdTMwQzlcdTMwOTJcdTc2N0JcdTkzMzJcdTMwNTdcdTMwN0VcdTMwNTdcdTMwNUZcdTMwMDJgKTtcbiAgICBjYXNlIFwiVVBEQVRFXCI6IHJldHVybiByZW5kZXJTdWNjZXNzKGAke3Jlc3VsdC51cGRhdGVkQ291bnR9IFx1NEVGNlx1MzA2RVx1MzBFQ1x1MzBCM1x1MzBGQ1x1MzBDOVx1MzA5Mlx1NjZGNFx1NjVCMFx1MzA1N1x1MzA3RVx1MzA1N1x1MzA1Rlx1MzAwMmApO1xuICAgIGNhc2UgXCJERUxFVEVcIjogcmV0dXJuIHJlbmRlclN1Y2Nlc3MoYCR7cmVzdWx0LmRlbGV0ZWRDb3VudH0gXHU0RUY2XHUzMDZFXHUzMEVDXHUzMEIzXHUzMEZDXHUzMEM5XHUzMDkyXHU1MjRBXHU5NjY0XHUzMDU3XHUzMDdFXHUzMDU3XHUzMDVGXHUzMDAyYCk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckVycm9yKGVycjogdW5rbm93bik6IHN0cmluZyB7XG4gIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgcmV0dXJuIGA8ZGl2IGNsYXNzPVwia3NxbC1lcnJvclwiPjxzcGFuIGNsYXNzPVwia3NxbC1lcnJvci1pY29uXCI+XHUyNkEwPC9zcGFuPiR7ZXNjSHRtbChtc2cpfTwvZGl2PmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJMb2FkaW5nKCk6IHN0cmluZyB7XG4gIHJldHVybiBgPGRpdiBjbGFzcz1cImtzcWwtbG9hZGluZ1wiPlx1NUI5Rlx1ODg0Q1x1NEUyRC4uLjwvZGl2PmA7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gU0VMRUNUIFx1N0Q1MFx1Njc5Q1x1MzBDNlx1MzBGQ1x1MzBENlx1MzBFQlxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIHJlbmRlclNlbGVjdChyZXN1bHQ6IFNlbGVjdFJlc3VsdCk6IHN0cmluZyB7XG4gIGlmIChyZXN1bHQucm93cy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gcmVuZGVySW5mbyhcIjAgXHU0RUY2XHUzMDY3XHUzMDU3XHUzMDVGXHUzMDAyXCIpO1xuICB9XG5cbiAgY29uc3QgaGVhZGVycyA9IE9iamVjdC5rZXlzKHJlc3VsdC5yb3dzWzBdKTtcbiAgY29uc3QgaGVhZGVySHRtbCA9IGhlYWRlcnMubWFwKChoKSA9PiBgPHRoPiR7ZXNjSHRtbChoKX08L3RoPmApLmpvaW4oXCJcIik7XG4gIGNvbnN0IGJvZHlIdG1sID0gcmVzdWx0LnJvd3NcbiAgICAubWFwKChyb3cpID0+IHJlbmRlclJvdyhyb3csIGhlYWRlcnMpKVxuICAgIC5qb2luKFwiXCIpO1xuXG4gIHJldHVybiBgXG48ZGl2IGNsYXNzPVwia3NxbC1yZXN1bHQtbWV0YVwiPiR7cmVzdWx0LnJvd0NvdW50fSBcdTRFRjY8L2Rpdj5cbjxkaXYgY2xhc3M9XCJrc3FsLXRhYmxlLXdyYXBwZXJcIj5cbiAgPHRhYmxlIGNsYXNzPVwia3NxbC10YWJsZVwiPlxuICAgIDx0aGVhZD48dHI+JHtoZWFkZXJIdG1sfTwvdHI+PC90aGVhZD5cbiAgICA8dGJvZHk+JHtib2R5SHRtbH08L3Rib2R5PlxuICA8L3RhYmxlPlxuPC9kaXY+YC50cmltKCk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJvdyhyb3c6IFByb2Nlc3NSb3csIGhlYWRlcnM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgY29uc3QgY2VsbHMgPSBoZWFkZXJzXG4gICAgLm1hcCgoaCkgPT4gYDx0ZD4ke2VzY0h0bWwocm93W2hdID8/IFwiXCIpfTwvdGQ+YClcbiAgICAuam9pbihcIlwiKTtcbiAgcmV0dXJuIGA8dHI+JHtjZWxsc308L3RyPmA7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHU1MTcxXHU5MDFBXHUzMEUxXHUzMEMzXHUzMEJCXHUzMEZDXHUzMEI4XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gcmVuZGVyU3VjY2Vzcyhtc2c6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgPGRpdiBjbGFzcz1cImtzcWwtc3VjY2Vzc1wiPjxzcGFuIGNsYXNzPVwia3NxbC1zdWNjZXNzLWljb25cIj5cdTI3MTM8L3NwYW4+JHtlc2NIdG1sKG1zZyl9PC9kaXY+YDtcbn1cblxuZnVuY3Rpb24gcmVuZGVySW5mbyhtc2c6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgPGRpdiBjbGFzcz1cImtzcWwtaW5mb1wiPiR7ZXNjSHRtbChtc2cpfTwvZGl2PmA7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gWFNTIFx1NUJGRVx1N0I1NjogSFRNTCBcdTMwQThcdTMwQjlcdTMwQjFcdTMwRkNcdTMwRDdcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5mdW5jdGlvbiBlc2NIdG1sKHN0cjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcoc3RyID8/IFwiXCIpXG4gICAgLnJlcGxhY2UoLyYvZywgXCImYW1wO1wiKVxuICAgIC5yZXBsYWNlKC88L2csIFwiJmx0O1wiKVxuICAgIC5yZXBsYWNlKC8+L2csIFwiJmd0O1wiKVxuICAgIC5yZXBsYWNlKC9cIi9nLCBcIiZxdW90O1wiKVxuICAgIC5yZXBsYWNlKC8nL2csIFwiJiMzOTtcIik7XG59XG4iLCAiLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBkZXNrdG9wLnRzIFx1MjAxNCBraW50b25lIFx1MzBEN1x1MzBFOVx1MzBCMFx1MzBBNFx1MzBGM1x1MzA2RVx1MzBBOFx1MzBGM1x1MzBDOFx1MzBFQVx1MzBERFx1MzBBNFx1MzBGM1x1MzBDOFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmltcG9ydCB7IGV4ZWN1dGUsIE9wZXJhdGlvbkNhbmNlbGxlZEVycm9yIH0gZnJvbSBcIi4uL2V4ZWN1dGVcIjtcbmltcG9ydCB7IGNyZWF0ZUtpbnRvbmVDbGllbnQgfSBmcm9tIFwiLi9raW50b25lQ2xpZW50XCI7XG5pbXBvcnQgeyByZW5kZXJSZXN1bHQsIHJlbmRlckVycm9yLCByZW5kZXJMb2FkaW5nIH0gZnJvbSBcIi4vcmVuZGVyUmVzdWx0XCI7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHU0RTAwXHU4OUE3XHUzMEFEXHUzMEUzXHUzMEMzXHUzMEI3XHUzMEU1XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW50ZXJmYWNlIEZpZWxkSW5mbyB7XG4gIGNvZGU6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgZmllbGRUeXBlOiBzdHJpbmc7XG59XG5cbmNvbnN0IGZpZWxkQ2FjaGUgPSBuZXcgTWFwPG51bWJlciwgRmllbGRJbmZvW10+KCk7XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoRmllbGRzKGFwcElkOiBudW1iZXIpOiBQcm9taXNlPEZpZWxkSW5mb1tdPiB7XG4gIGlmIChmaWVsZENhY2hlLmhhcyhhcHBJZCkpIHJldHVybiBmaWVsZENhY2hlLmdldChhcHBJZCkhO1xuXG4gIGNvbnN0IHJlcyA9IGF3YWl0IGtpbnRvbmUuYXBpKFxuICAgIFwiL2svdjEvYXBwL2Zvcm0vZmllbGRzLmpzb25cIixcbiAgICBcIkdFVFwiLFxuICAgIHsgYXBwOiBhcHBJZCB9XG4gICkgYXMgeyBwcm9wZXJ0aWVzOiBSZWNvcmQ8c3RyaW5nLCB7IGNvZGU6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgdHlwZTogc3RyaW5nIH0+IH07XG5cbiAgY29uc3QgZmllbGRzOiBGaWVsZEluZm9bXSA9IE9iamVjdC52YWx1ZXMocmVzLnByb3BlcnRpZXMpLm1hcCgoZikgPT4gKHtcbiAgICBjb2RlOiAgICAgIGYuY29kZSxcbiAgICBsYWJlbDogICAgIGYubGFiZWwsXG4gICAgZmllbGRUeXBlOiBmLnR5cGUsXG4gIH0pKTtcbiAgZmllbGRDYWNoZS5zZXQoYXBwSWQsIGZpZWxkcyk7XG4gIHJldHVybiBmaWVsZHM7XG59XG5cbmNvbnN0IFBMVUdJTl9JRCAgID0ga2ludG9uZS4kUExVR0lOX0lEIGFzIHN0cmluZztcbmNvbnN0IEhJU1RPUllfS0VZID0gYGtzcWxfaGlzdG9yeV8ke1BMVUdJTl9JRH1gO1xuY29uc3QgSElTVE9SWV9NQVggPSAzMDtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTUUwgXHU1QzY1XHU2Qjc0XHVGRjA4bG9jYWxTdG9yYWdlXHVGRjA5XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gbG9hZEhpc3RvcnkoKTogc3RyaW5nW10ge1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUllfS0VZKSA/PyBcIltdXCIpIGFzIHN0cmluZ1tdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuZnVuY3Rpb24gc2F2ZUhpc3Rvcnkoc3FsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbGlzdCA9IGxvYWRIaXN0b3J5KCkuZmlsdGVyKChzKSA9PiBzICE9PSBzcWwpOyAvLyBcdTkxQ0RcdTg5MDdcdTk2NjRcdTUzQkJcbiAgbGlzdC51bnNoaWZ0KHNxbCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gXHU1MTQ4XHU5ODJEXHUzMDZCXHU4RkZEXHU1MkEwXG4gIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfS0VZLCBKU09OLnN0cmluZ2lmeShsaXN0LnNsaWNlKDAsIEhJU1RPUllfTUFYKSkpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIGtpbnRvbmUgXHUzMEE0XHUzMEQ5XHUzMEYzXHUzMEM4XHU3NjdCXHU5MzMyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxua2ludG9uZS5ldmVudHMub24oXG4gIFtcImFwcC5yZWNvcmQuaW5kZXguc2hvd1wiXSxcbiAgKGV2ZW50KSA9PiB7XG4gICAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwia3NxbC1wYW5lbFwiKSkgcmV0dXJuIGV2ZW50O1xuICAgIG1vdW50UGFuZWwoKTtcbiAgICByZXR1cm4gZXZlbnQ7XG4gIH1cbik7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gXHUzMEQxXHUzMENEXHUzMEVCXHUzMDZFXHUzMERFXHUzMEE2XHUzMEYzXHUzMEM4XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gbW91bnRQYW5lbCgpOiB2b2lkIHtcbiAgY29uc3QgcGFuZWwgID0gYnVpbGRQYW5lbCgpO1xuICBjb25zdCBoZWFkZXIgPSBraW50b25lLmFwcC5nZXRIZWFkZXJTcGFjZUVsZW1lbnQoKTtcbiAgaWYgKCFoZWFkZXIpIHJldHVybjtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKHBhbmVsKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdTMwRDFcdTMwQ0RcdTMwRUIgRE9NIFx1MzA2RVx1NjlDQlx1N0JDOVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIGJ1aWxkUGFuZWwoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBwYW5lbCA9IGVsKFwiZGl2XCIsIFwia3NxbC1wYW5lbFwiLCB7IGlkOiBcImtzcWwtcGFuZWxcIiB9KTtcblxuICAvLyAtLS0gXHUzMEQ4XHUzMEMzXHUzMEMwXHUzMEZDIC0tLVxuICBjb25zdCBoZWFkZXIgPSBlbChcImRpdlwiLCBcImtzcWwtcGFuZWwtaGVhZGVyXCIpO1xuICBjb25zdCB0aXRsZSAgPSBlbChcInNwYW5cIiwgXCJrc3FsLXBhbmVsLXRpdGxlXCIpO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwia1NRTCBcdTIwMTQgU1FMIFx1MzBBRlx1MzBBOFx1MzBFQVx1NUI5Rlx1ODg0Q1wiO1xuICBjb25zdCB0b2dnbGUgPSBlbChcImJ1dHRvblwiLCBcImtzcWwtdG9nZ2xlLWJ0blwiKTtcbiAgdG9nZ2xlLnRleHRDb250ZW50ID0gXCJcdTI1QjIgXHU2Mjk4XHUzMDhBXHUzMDVGXHUzMDVGXHUzMDgwXCI7XG4gIHRvZ2dsZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdG9nZ2xlQm9keShib2R5LCB0b2dnbGUpKTtcbiAgaGVhZGVyLmFwcGVuZCh0aXRsZSwgdG9nZ2xlKTtcblxuICAvLyAtLS0gXHUzMERDXHUzMEM3XHUzMEEzIC0tLVxuICBjb25zdCBib2R5ID0gZWwoXCJkaXZcIiwgXCJrc3FsLXBhbmVsLWJvZHlcIiwgeyBpZDogXCJrc3FsLXBhbmVsLWJvZHlcIiB9KTtcblxuICAvLyAtLS0gXHUzMEE4XHUzMEM3XHUzMEEzXHUzMEJGICsgXHUzMEI1XHUzMEE0XHUzMEM5XHUzMEQwXHUzMEZDXHUzMDZFXHU2QTJBXHU0RTI2XHUzMDczXHUzMEU5XHUzMEMzXHUzMEQxXHUzMEZDIC0tLVxuICBjb25zdCBlZGl0b3JSb3cgPSBlbChcImRpdlwiLCBcImtzcWwtZWRpdG9yLXJvd1wiKTtcblxuICAvLyAtLS0gXHU1REU2XHU1MDc0OiBcdTMwQThcdTMwQzdcdTMwQTNcdTMwQkZcdTUyMTcgLS0tXG4gIGNvbnN0IGVkaXRvckNvbCA9IGVsKFwiZGl2XCIsIFwia3NxbC1lZGl0b3ItY29sXCIpO1xuXG4gIC8vIFx1MzBDNlx1MzBBRFx1MzBCOVx1MzBDOFx1MzBBOFx1MzBFQVx1MzBBMlxuICBjb25zdCBlZGl0b3IgPSBlbChcInRleHRhcmVhXCIsIFwia3NxbC1lZGl0b3JcIiwge1xuICAgIGlkOiAgICAgICAgICAgXCJrc3FsLWVkaXRvclwiLFxuICAgIHBsYWNlaG9sZGVyOiAgXCJTRUxFQ1QgKiBGUk9NIEFQUDEwMCBXSEVSRSBcdTMwQjlcdTMwQzZcdTMwRkNcdTMwQkZcdTMwQjkgPSAnXHU1QjhDXHU0RTg2J1wiLFxuICAgIHNwZWxsY2hlY2s6ICAgXCJmYWxzZVwiLFxuICAgIGF1dG9jb21wbGV0ZTogXCJvZmZcIixcbiAgfSkgYXMgSFRNTFRleHRBcmVhRWxlbWVudDtcblxuICBlZGl0b3IuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgKGUpID0+IHtcbiAgICBpZiAoZS5rZXkgPT09IFwiRW50ZXJcIiAmJiAoZS5jdHJsS2V5IHx8IGUubWV0YUtleSkpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIHZvaWQgcnVuU3FsKGVkaXRvci52YWx1ZS50cmltKCksIHJlc3VsdEFyZWEpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUzMERDXHUzMEJGXHUzMEYzXHU4ODRDXG4gIGNvbnN0IGJ1dHRvblJvdyA9IGVsKFwiZGl2XCIsIFwia3NxbC1idXR0b24tcm93XCIpO1xuXG4gIGNvbnN0IHJ1bkJ0biA9IGVsKFwiYnV0dG9uXCIsIFwia3NxbC1ydW4tYnRuXCIsIHsgaWQ6IFwia3NxbC1ydW4tYnRuXCIgfSk7XG4gIHJ1bkJ0bi50ZXh0Q29udGVudCA9IFwiXHU1QjlGXHU4ODRDXHVGRjA4Q3RybCtFbnRlclx1RkYwOVwiO1xuICBydW5CdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgcnVuU3FsKGVkaXRvci52YWx1ZS50cmltKCksIHJlc3VsdEFyZWEpKTtcblxuICBjb25zdCBjbGVhckJ0biA9IGVsKFwiYnV0dG9uXCIsIFwia3NxbC1jbGVhci1idG5cIik7XG4gIGNsZWFyQnRuLnRleHRDb250ZW50ID0gXCJcdTMwQUZcdTMwRUFcdTMwQTJcIjtcbiAgY2xlYXJCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICBlZGl0b3IudmFsdWUgPSBcIlwiO1xuICAgIHJlc3VsdEFyZWEuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBlZGl0b3IuZm9jdXMoKTtcbiAgfSk7XG5cbiAgLy8gXHU1QzY1XHU2Qjc0XHUzMERDXHUzMEJGXHUzMEYzXG4gIGNvbnN0IGhpc3RCdG4gPSBlbChcImJ1dHRvblwiLCBcImtzcWwtaGlzdC1idG5cIiwgeyBpZDogXCJrc3FsLWhpc3QtYnRuXCIgfSk7XG4gIGhpc3RCdG4udGV4dENvbnRlbnQgPSBcIlx1NUM2NVx1NkI3NCBcdTI1QkNcIjtcbiAgaGlzdEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIHRvZ2dsZUhpc3RvcnlEcm9wZG93bihlZGl0b3IsIGhpc3RCdG4pO1xuICB9KTtcblxuICBidXR0b25Sb3cuYXBwZW5kKHJ1bkJ0biwgY2xlYXJCdG4sIGhpc3RCdG4pO1xuXG4gIC8vIFx1NUM2NVx1NkI3NFx1MzBDOVx1MzBFRFx1MzBDM1x1MzBEN1x1MzBDMFx1MzBBNlx1MzBGM1x1RkYwOFx1NTIxRFx1NjcxRlx1OTc1RVx1ODg2OFx1NzkzQVx1RkYwOVxuICBjb25zdCBoaXN0RHJvcGRvd24gPSBlbChcImRpdlwiLCBcImtzcWwtaGlzdC1kcm9wZG93blwiLCB7IGlkOiBcImtzcWwtaGlzdC1kcm9wZG93blwiIH0pO1xuICBoaXN0RHJvcGRvd24uc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuXG4gIGVkaXRvckNvbC5hcHBlbmQoZWRpdG9yLCBidXR0b25Sb3csIGhpc3REcm9wZG93bik7XG5cbiAgLy8gLS0tIFx1NTNGM1x1NTA3NDogXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHU0RTAwXHU4OUE3XHUzMEI1XHUzMEE0XHUzMEM5XHUzMEQwXHUzMEZDIC0tLVxuICBjb25zdCBzaWRlYmFyID0gYnVpbGRGaWVsZFNpZGViYXIoZWRpdG9yKTtcblxuICBlZGl0b3JSb3cuYXBwZW5kKGVkaXRvckNvbCwgc2lkZWJhcik7XG5cbiAgLy8gXHU3RDUwXHU2NzlDXHUzMEE4XHUzMEVBXHUzMEEyXG4gIGNvbnN0IHJlc3VsdEFyZWEgPSBlbChcImRpdlwiLCBcImtzcWwtcmVzdWx0XCIsIHsgaWQ6IFwia3NxbC1yZXN1bHRcIiB9KTtcblxuICBib2R5LmFwcGVuZChlZGl0b3JSb3csIHJlc3VsdEFyZWEpO1xuICBwYW5lbC5hcHBlbmQoaGVhZGVyLCBib2R5KTtcblxuICAvLyBcdTMwQzlcdTMwRURcdTMwQzNcdTMwRDdcdTMwQzBcdTMwQTZcdTMwRjNcdTU5MTZcdTMwQUZcdTMwRUFcdTMwQzNcdTMwQUZcdTMwNjdcdTk1ODlcdTMwNThcdTMwOEJcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IGNsb3NlSGlzdG9yeURyb3Bkb3duKCkpO1xuXG4gIHJldHVybiBwYW5lbDtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTRFMDBcdTg5QTdcdTMwQjVcdTMwQTRcdTMwQzlcdTMwRDBcdTMwRkNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5mdW5jdGlvbiBidWlsZEZpZWxkU2lkZWJhcihlZGl0b3I6IEhUTUxUZXh0QXJlYUVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHNpZGViYXIgPSBlbChcImRpdlwiLCBcImtzcWwtZmllbGQtc2lkZWJhclwiKTtcblxuICAvLyBcdTMwRDhcdTMwQzNcdTMwQzBcdTMwRkNcbiAgY29uc3Qgc2lkZWJhckhlYWRlciA9IGVsKFwiZGl2XCIsIFwia3NxbC1maWVsZC1zaWRlYmFyLWhlYWRlclwiKTtcbiAgY29uc3Qgc2lkZWJhclRpdGxlID0gZWwoXCJzcGFuXCIsIFwia3NxbC1maWVsZC1zaWRlYmFyLXRpdGxlXCIpO1xuICBzaWRlYmFyVGl0bGUudGV4dENvbnRlbnQgPSBcIlx1MzBENVx1MzBBM1x1MzBGQ1x1MzBFQlx1MzBDOVx1NEUwMFx1ODlBN1wiO1xuICBzaWRlYmFySGVhZGVyLmFwcGVuZENoaWxkKHNpZGViYXJUaXRsZSk7XG5cbiAgLy8gXHUzMEEyXHUzMEQ3XHUzMEVBSURcdTUxNjVcdTUyOUJcdTg4NENcbiAgY29uc3QgaW5wdXRSb3cgPSBlbChcImRpdlwiLCBcImtzcWwtZmllbGQtaW5wdXQtcm93XCIpO1xuICBjb25zdCBhcHBJbnB1dCA9IGVsKFwiaW5wdXRcIiwgXCJrc3FsLWZpZWxkLWFwcC1pbnB1dFwiLCB7XG4gICAgdHlwZTogICAgICAgIFwibnVtYmVyXCIsXG4gICAgcGxhY2Vob2xkZXI6IFwiXHUzMEEyXHUzMEQ3XHUzMEVBSURcIixcbiAgICBpZDogICAgICAgICAgXCJrc3FsLWZpZWxkLWFwcC1pbnB1dFwiLFxuICAgIG1pbjogICAgICAgICBcIjFcIixcbiAgfSkgYXMgSFRNTElucHV0RWxlbWVudDtcblxuICBjb25zdCBmZXRjaEJ0biA9IGVsKFwiYnV0dG9uXCIsIFwia3NxbC1maWVsZC1mZXRjaC1idG5cIik7XG4gIGZldGNoQnRuLnRleHRDb250ZW50ID0gXCJcdTUzRDZcdTVGOTdcIjtcblxuICBpbnB1dFJvdy5hcHBlbmQoYXBwSW5wdXQsIGZldGNoQnRuKTtcblxuICAvLyBcdTMwRDVcdTMwQTNcdTMwRkNcdTMwRUJcdTMwQzlcdTMwRUFcdTMwQjlcdTMwQzhcdTk4MThcdTU3REZcbiAgY29uc3QgbGlzdEFyZWEgPSBlbChcImRpdlwiLCBcImtzcWwtZmllbGQtbGlzdC1hcmVhXCIsIHsgaWQ6IFwia3NxbC1maWVsZC1saXN0LWFyZWFcIiB9KTtcbiAgbGlzdEFyZWEudGV4dENvbnRlbnQgPSBcIlx1MzBBMlx1MzBEN1x1MzBFQUlEXHUzMDkyXHU1MTY1XHU1MjlCXHUzMDU3XHUzMDY2XHU1M0Q2XHU1Rjk3XCI7XG5cbiAgLy8gXHU1M0Q2XHU1Rjk3XHUzMERDXHUzMEJGXHUzMEYzXHU2MkJDXHU0RTBCXG4gIGNvbnN0IGRvRmV0Y2ggPSAoKTogdm9pZCA9PiB7XG4gICAgY29uc3QgYXBwSWQgPSBwYXJzZUludChhcHBJbnB1dC52YWx1ZS50cmltKCksIDEwKTtcbiAgICBpZiAoaXNOYU4oYXBwSWQpIHx8IGFwcElkIDw9IDApIHtcbiAgICAgIGxpc3RBcmVhLnRleHRDb250ZW50ID0gXCJcdTMwQTJcdTMwRDdcdTMwRUFJRFx1MzA5Mlx1NTE2NVx1NTI5Qlx1MzA1N1x1MzA2Nlx1MzA0Rlx1MzA2MFx1MzA1NVx1MzA0NFwiO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsaXN0QXJlYS50ZXh0Q29udGVudCA9IFwiXHU1M0Q2XHU1Rjk3XHU0RTJELi4uXCI7XG4gICAgZmV0Y2hCdG4uZGlzYWJsZWQgPSB0cnVlO1xuXG4gICAgZmV0Y2hGaWVsZHMoYXBwSWQpXG4gICAgICAudGhlbigoZmllbGRzKSA9PiB7XG4gICAgICAgIHJlbmRlckZpZWxkTGlzdChsaXN0QXJlYSwgZmllbGRzLCBlZGl0b3IpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgICAgIGxpc3RBcmVhLnRleHRDb250ZW50ID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgfSlcbiAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgZmV0Y2hCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIH0pO1xuICB9O1xuXG4gIGZldGNoQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBkb0ZldGNoKTtcbiAgYXBwSW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgKGUpID0+IHtcbiAgICBpZiAoZS5rZXkgPT09IFwiRW50ZXJcIikgZG9GZXRjaCgpO1xuICB9KTtcblxuICBzaWRlYmFyLmFwcGVuZChzaWRlYmFySGVhZGVyLCBpbnB1dFJvdywgbGlzdEFyZWEpO1xuICByZXR1cm4gc2lkZWJhcjtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRmllbGRMaXN0KFxuICBsaXN0QXJlYTogSFRNTEVsZW1lbnQsXG4gIGZpZWxkczogRmllbGRJbmZvW10sXG4gIGVkaXRvcjogSFRNTFRleHRBcmVhRWxlbWVudFxuKTogdm9pZCB7XG4gIGxpc3RBcmVhLmlubmVySFRNTCA9IFwiXCI7XG5cbiAgaWYgKGZpZWxkcy5sZW5ndGggPT09IDApIHtcbiAgICBsaXN0QXJlYS50ZXh0Q29udGVudCA9IFwiXHUzMEQ1XHUzMEEzXHUzMEZDXHUzMEVCXHUzMEM5XHUzMDRDXHUzMDQyXHUzMDhBXHUzMDdFXHUzMDVCXHUzMDkzXCI7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHU2OTFDXHU3RDIyXHUzMEQ1XHUzMEEzXHUzMEVCXHUzMEJGXG4gIGNvbnN0IHNlYXJjaElucHV0ID0gZWwoXCJpbnB1dFwiLCBcImtzcWwtZmllbGQtc2VhcmNoXCIsIHtcbiAgICB0eXBlOiAgICAgICAgXCJ0ZXh0XCIsXG4gICAgcGxhY2Vob2xkZXI6IFwiXHUzMEQ1XHUzMEEzXHUzMEVCXHUzMEJGLi4uXCIsXG4gIH0pIGFzIEhUTUxJbnB1dEVsZW1lbnQ7XG5cbiAgY29uc3QgbGlzdCA9IGVsKFwidWxcIiwgXCJrc3FsLWZpZWxkLWxpc3RcIik7XG5cbiAgY29uc3QgYnVpbGRJdGVtcyA9IChmaWx0ZXI6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGxpc3QuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCBsb3dlciA9IGZpbHRlci50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IGZpbHRlcmVkID0gZmlsdGVyXG4gICAgICA/IGZpZWxkcy5maWx0ZXIoXG4gICAgICAgICAgKGYpID0+XG4gICAgICAgICAgICBmLmNvZGUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcikgfHxcbiAgICAgICAgICAgIGYubGFiZWwudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcilcbiAgICAgICAgKVxuICAgICAgOiBmaWVsZHM7XG5cbiAgICBmb3IgKGNvbnN0IGYgb2YgZmlsdGVyZWQpIHtcbiAgICAgIGNvbnN0IGxpID0gZWwoXCJsaVwiLCBcImtzcWwtZmllbGQtaXRlbVwiKTtcbiAgICAgIGxpLnRpdGxlID0gYCR7Zi5sYWJlbH0gKCR7Zi5maWVsZFR5cGV9KWA7XG5cbiAgICAgIGNvbnN0IGNvZGVTcGFuID0gZWwoXCJzcGFuXCIsIFwia3NxbC1maWVsZC1jb2RlXCIpO1xuICAgICAgY29kZVNwYW4udGV4dENvbnRlbnQgPSBmLmNvZGU7XG5cbiAgICAgIGNvbnN0IGxhYmVsU3BhbiA9IGVsKFwic3BhblwiLCBcImtzcWwtZmllbGQtbGFiZWxcIik7XG4gICAgICBsYWJlbFNwYW4udGV4dENvbnRlbnQgPSBmLmxhYmVsICE9PSBmLmNvZGUgPyBmLmxhYmVsIDogXCJcIjtcblxuICAgICAgbGkuYXBwZW5kKGNvZGVTcGFuLCBsYWJlbFNwYW4pO1xuICAgICAgbGkuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IGluc2VydEF0Q3Vyc29yKGVkaXRvciwgZi5jb2RlKSk7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGxpKTtcbiAgICB9XG5cbiAgICBpZiAobGlzdC5jaGlsZHJlbi5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IGVtcHR5ID0gZWwoXCJsaVwiLCBcImtzcWwtZmllbGQtZW1wdHlcIik7XG4gICAgICBlbXB0eS50ZXh0Q29udGVudCA9IFwiXHU4QTcyXHU1RjUzXHUzMDZBXHUzMDU3XCI7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICB9XG4gIH07XG5cbiAgc2VhcmNoSW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IGJ1aWxkSXRlbXMoc2VhcmNoSW5wdXQudmFsdWUpKTtcbiAgYnVpbGRJdGVtcyhcIlwiKTtcblxuICBsaXN0QXJlYS5hcHBlbmQoc2VhcmNoSW5wdXQsIGxpc3QpO1xufVxuXG4vKiogXHUzMEM2XHUzMEFEXHUzMEI5XHUzMEM4XHUzMEE4XHUzMEVBXHUzMEEyXHUzMDZFXHUzMEFCXHUzMEZDXHUzMEJEXHUzMEVCXHU0RjREXHU3RjZFXHUzMDZCXHUzMEM2XHUzMEFEXHUzMEI5XHUzMEM4XHUzMDkyXHU2MzNGXHU1MTY1XHUzMDU5XHUzMDhCICovXG5mdW5jdGlvbiBpbnNlcnRBdEN1cnNvcih0YTogSFRNTFRleHRBcmVhRWxlbWVudCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHN0YXJ0ID0gdGEuc2VsZWN0aW9uU3RhcnQgPz8gdGEudmFsdWUubGVuZ3RoO1xuICBjb25zdCBlbmQgICA9IHRhLnNlbGVjdGlvbkVuZCAgID8/IHRhLnZhbHVlLmxlbmd0aDtcbiAgdGEudmFsdWUgPSB0YS52YWx1ZS5zbGljZSgwLCBzdGFydCkgKyB0ZXh0ICsgdGEudmFsdWUuc2xpY2UoZW5kKTtcbiAgY29uc3QgcG9zID0gc3RhcnQgKyB0ZXh0Lmxlbmd0aDtcbiAgdGEuc2V0U2VsZWN0aW9uUmFuZ2UocG9zLCBwb3MpO1xuICB0YS5mb2N1cygpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1NUM2NVx1NkI3NFx1MzBDOVx1MzBFRFx1MzBDM1x1MzBEN1x1MzBDMFx1MzBBNlx1MzBGM1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIHRvZ2dsZUhpc3RvcnlEcm9wZG93bihlZGl0b3I6IEhUTUxUZXh0QXJlYUVsZW1lbnQsIGJ0bjogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgZHJvcGRvd24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImtzcWwtaGlzdC1kcm9wZG93blwiKTtcbiAgaWYgKCFkcm9wZG93bikgcmV0dXJuO1xuXG4gIGlmIChkcm9wZG93bi5zdHlsZS5kaXNwbGF5ICE9PSBcIm5vbmVcIikge1xuICAgIGNsb3NlSGlzdG9yeURyb3Bkb3duKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHU1QzY1XHU2Qjc0XHUzMEVBXHUzMEI5XHUzMEM4XHUzMDkyXHU2M0NGXHU3NTNCXG4gIGNvbnN0IGhpc3RvcnkgPSBsb2FkSGlzdG9yeSgpO1xuICBpZiAoaGlzdG9yeS5sZW5ndGggPT09IDApIHtcbiAgICBkcm9wZG93bi5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImtzcWwtaGlzdC1lbXB0eVwiPlx1NUM2NVx1NkI3NFx1MzA0Q1x1MzA0Mlx1MzA4QVx1MzA3RVx1MzA1Qlx1MzA5MzwvZGl2PmA7XG4gIH0gZWxzZSB7XG4gICAgZHJvcGRvd24uaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cImtzcWwtaGlzdC1oZWFkZXJcIj5cbiAgICAgICAgPHNwYW4+XHU1QzY1XHU2Qjc0XHVGRjA4XHU2NzAwXHU2NUIwICR7aGlzdG9yeS5sZW5ndGh9IFx1NEVGNlx1RkYwOTwvc3Bhbj5cbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cImtzcWwtaGlzdC1jbGVhci1hbGxcIiBpZD1cImtzcWwtaGlzdC1jbGVhci1hbGxcIj5cdTMwNTlcdTMwNzlcdTMwNjZcdTUyNEFcdTk2NjQ8L2J1dHRvbj5cbiAgICAgIDwvZGl2PlxuICAgICAgPHVsIGNsYXNzPVwia3NxbC1oaXN0LWxpc3RcIiBpZD1cImtzcWwtaGlzdC1saXN0XCI+PC91bD5cbiAgICBgO1xuXG4gICAgY29uc3QgdWwgPSBkcm9wZG93bi5xdWVyeVNlbGVjdG9yKFwiI2tzcWwtaGlzdC1saXN0XCIpITtcbiAgICBoaXN0b3J5LmZvckVhY2goKHNxbCwgaSkgPT4ge1xuICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICBsaS5jbGFzc05hbWUgPSBcImtzcWwtaGlzdC1pdGVtXCI7XG4gICAgICBsaS50aXRsZSA9IHNxbDtcblxuICAgICAgY29uc3QgcHJldmlldyA9IGVsKFwic3BhblwiLCBcImtzcWwtaGlzdC1wcmV2aWV3XCIpO1xuICAgICAgcHJldmlldy50ZXh0Q29udGVudCA9IHNxbC5sZW5ndGggPiA4MCA/IHNxbC5zbGljZSgwLCA4MCkgKyBcIlx1MjAyNlwiIDogc3FsO1xuXG4gICAgICBjb25zdCBydW5IaXN0QnRuID0gZWwoXCJidXR0b25cIiwgXCJrc3FsLWhpc3QtcnVuXCIpO1xuICAgICAgcnVuSGlzdEJ0bi50ZXh0Q29udGVudCA9IFwiXHU1QjlGXHU4ODRDXCI7XG4gICAgICBydW5IaXN0QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICBlZGl0b3IudmFsdWUgPSBzcWw7XG4gICAgICAgIGNsb3NlSGlzdG9yeURyb3Bkb3duKCk7XG4gICAgICAgIGNvbnN0IHJlc3VsdEFyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImtzcWwtcmVzdWx0XCIpO1xuICAgICAgICBpZiAocmVzdWx0QXJlYSkgdm9pZCBydW5TcWwoc3FsLCByZXN1bHRBcmVhKTtcbiAgICAgIH0pO1xuXG4gICAgICBsaS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgICBlZGl0b3IudmFsdWUgPSBzcWw7XG4gICAgICAgIGNsb3NlSGlzdG9yeURyb3Bkb3duKCk7XG4gICAgICAgIGVkaXRvci5mb2N1cygpO1xuICAgICAgfSk7XG5cbiAgICAgIGxpLmFwcGVuZChwcmV2aWV3LCBydW5IaXN0QnRuKTtcbiAgICAgIHVsLmFwcGVuZENoaWxkKGxpKTtcbiAgICB9KTtcblxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwia3NxbC1oaXN0LWNsZWFyLWFsbFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgdm9pZCBzaG93Q29uZmlybURpYWxvZyhcIlx1NUM2NVx1NkI3NFx1MzA5Mlx1MzA1OVx1MzA3OVx1MzA2Nlx1NTI0QVx1OTY2NFx1MzA1N1x1MzA3RVx1MzA1OVx1MzA0Qlx1RkYxRlwiKS50aGVuKChvaykgPT4ge1xuICAgICAgICBpZiAob2spIHtcbiAgICAgICAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShISVNUT1JZX0tFWSk7XG4gICAgICAgICAgY2xvc2VIaXN0b3J5RHJvcGRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBkcm9wZG93bi5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgYnRuLnRleHRDb250ZW50ID0gXCJcdTVDNjVcdTZCNzQgXHUyNUIyXCI7XG59XG5cbmZ1bmN0aW9uIGNsb3NlSGlzdG9yeURyb3Bkb3duKCk6IHZvaWQge1xuICBjb25zdCBkcm9wZG93biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwia3NxbC1oaXN0LWRyb3Bkb3duXCIpO1xuICBjb25zdCBidG4gICAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwia3NxbC1oaXN0LWJ0blwiKTtcbiAgaWYgKGRyb3Bkb3duKSBkcm9wZG93bi5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGlmIChidG4pIGJ0bi50ZXh0Q29udGVudCA9IFwiXHU1QzY1XHU2Qjc0IFx1MjVCQ1wiO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFNRTCBcdTVCOUZcdTg4NENcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5hc3luYyBmdW5jdGlvbiBydW5TcWwoc3FsOiBzdHJpbmcsIHJlc3VsdEFyZWE6IEhUTUxFbGVtZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghc3FsKSByZXR1cm47XG5cbiAgY29uc3QgcnVuQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJrc3FsLXJ1bi1idG5cIikgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuXG4gIHRyeSB7XG4gICAgaWYgKHJ1bkJ0bikgcnVuQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICByZXN1bHRBcmVhLmlubmVySFRNTCA9IHJlbmRlckxvYWRpbmcoKTtcblxuICAgIGNvbnN0IGNsaWVudCA9IGNyZWF0ZUtpbnRvbmVDbGllbnQoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlKHNxbCwgY2xpZW50LCB7XG4gICAgICBjb25maXJtOiBjb25maXJtRGlhbG9nLFxuICAgICAgbWF4UmVjb3JkczogMTBfMDAwLFxuICAgIH0pO1xuXG4gICAgc2F2ZUhpc3Rvcnkoc3FsKTsgLy8gXHU2MjEwXHU1MjlGXHU2NjQyXHUzMDZFXHUzMDdGXHU1QzY1XHU2Qjc0XHUzMDZCXHU0RkREXHU1QjU4XG4gICAgcmVzdWx0QXJlYS5pbm5lckhUTUwgPSByZW5kZXJSZXN1bHQocmVzdWx0KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlIGluc3RhbmNlb2YgT3BlcmF0aW9uQ2FuY2VsbGVkRXJyb3IpIHtcbiAgICAgIHJlc3VsdEFyZWEuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJrc3FsLWluZm9cIj5cdTMwQURcdTMwRTNcdTMwRjNcdTMwQkJcdTMwRUJcdTMwNTdcdTMwN0VcdTMwNTdcdTMwNUZcdUZGMDhcdTVCRkVcdThDNjE6ICR7ZS5hZmZlY3RlZENvdW50fSBcdTRFRjZcdUZGMDk8L2Rpdj5gO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHRBcmVhLmlubmVySFRNTCA9IHJlbmRlckVycm9yKGUpO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAocnVuQnRuKSBydW5CdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgfVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFx1MzBBQlx1MzBCOVx1MzBCRlx1MzBFMFx1NzhCQVx1OEE4RFx1MzBDMFx1MzBBNFx1MzBBMlx1MzBFRFx1MzBCMFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogUHJvbWlzZSBcdTMwRDlcdTMwRkNcdTMwQjlcdTMwNkVcdTMwQUJcdTMwQjlcdTMwQkZcdTMwRTBcdTc4QkFcdThBOERcdTMwQzBcdTMwQTRcdTMwQTJcdTMwRURcdTMwQjBcdTMwOTJcdTg4NjhcdTc5M0FcdTMwNTlcdTMwOEJcdTMwMDJcbiAqIHJlc29sdmUodHJ1ZSkgPSBPS1x1MzAwMXJlc29sdmUoZmFsc2UpID0gXHUzMEFEXHUzMEUzXHUzMEYzXHUzMEJCXHUzMEVCXHUzMDAyXG4gKi9cbmZ1bmN0aW9uIHNob3dDb25maXJtRGlhbG9nKG1lc3NhZ2U6IHN0cmluZywgZGFuZ2VyID0gZmFsc2UpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgLy8gXHUzMEFBXHUzMEZDXHUzMEQwXHUzMEZDXHUzMEVDXHUzMEE0XG4gICAgY29uc3Qgb3ZlcmxheSA9IGVsKFwiZGl2XCIsIFwia3NxbC1kaWFsb2ctb3ZlcmxheVwiKTtcblxuICAgIC8vIFx1MzBDMFx1MzBBNFx1MzBBMlx1MzBFRFx1MzBCMFx1NjcyQ1x1NEY1M1xuICAgIGNvbnN0IGRpYWxvZyA9IGVsKFwiZGl2XCIsIFwia3NxbC1kaWFsb2dcIik7XG5cbiAgICBjb25zdCBtc2dFbCA9IGVsKFwiZGl2XCIsIFwia3NxbC1kaWFsb2ctbWVzc2FnZVwiKTtcbiAgICBtc2dFbC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG5cbiAgICBjb25zdCBidG5Sb3cgPSBlbChcImRpdlwiLCBcImtzcWwtZGlhbG9nLWJ0bi1yb3dcIik7XG5cbiAgICBjb25zdCBva0J0biA9IGVsKFwiYnV0dG9uXCIsIGRhbmdlciA/IFwia3NxbC1kaWFsb2ctb2sga3NxbC1kaWFsb2ctb2stLWRhbmdlclwiIDogXCJrc3FsLWRpYWxvZy1va1wiKTtcbiAgICBva0J0bi50ZXh0Q29udGVudCA9IFwiT0tcIjtcblxuICAgIGNvbnN0IGNhbmNlbEJ0biA9IGVsKFwiYnV0dG9uXCIsIFwia3NxbC1kaWFsb2ctY2FuY2VsXCIpO1xuICAgIGNhbmNlbEJ0bi50ZXh0Q29udGVudCA9IFwiXHUzMEFEXHUzMEUzXHUzMEYzXHUzMEJCXHUzMEVCXCI7XG5cbiAgICBjb25zdCBjbG9zZSA9IChyZXN1bHQ6IGJvb2xlYW4pOiB2b2lkID0+IHtcbiAgICAgIGRvY3VtZW50LmJvZHkucmVtb3ZlQ2hpbGQob3ZlcmxheSk7XG4gICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgfTtcblxuICAgIG9rQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgICAgKCkgPT4gY2xvc2UodHJ1ZSkpO1xuICAgIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gY2xvc2UoZmFsc2UpKTtcbiAgICBvdmVybGF5LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgIChlKSA9PiB7IGlmIChlLnRhcmdldCA9PT0gb3ZlcmxheSkgY2xvc2UoZmFsc2UpOyB9KTtcblxuICAgIGJ0blJvdy5hcHBlbmQoY2FuY2VsQnRuLCBva0J0bik7XG4gICAgZGlhbG9nLmFwcGVuZChtc2dFbCwgYnRuUm93KTtcbiAgICBvdmVybGF5LmFwcGVuZENoaWxkKGRpYWxvZyk7XG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChvdmVybGF5KTtcbiAgICBva0J0bi5mb2N1cygpO1xuICB9KTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBVUERBVEUgLyBERUxFVEUgXHU3OEJBXHU4QThEXHUzMEMwXHUzMEE0XHUzMEEyXHUzMEVEXHUzMEIwXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlybURpYWxvZyhcbiAgY291bnQ6IG51bWJlcixcbiAgb3BlcmF0aW9uOiBcIlVQREFURVwiIHwgXCJERUxFVEVcIlxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGxhYmVsID0gb3BlcmF0aW9uID09PSBcIlVQREFURVwiID8gXCJcdTY2RjRcdTY1QjBcIiA6IFwiXHU1MjRBXHU5NjY0XCI7XG4gIHJldHVybiBzaG93Q29uZmlybURpYWxvZyhcbiAgICBgJHtjb3VudH0gXHU0RUY2XHUzMDZFXHUzMEVDXHUzMEIzXHUzMEZDXHUzMEM5XHUzMDkyJHtsYWJlbH1cdTMwNTdcdTMwN0VcdTMwNTlcdTMwMDJcdTMwODhcdTMwOERcdTMwNTdcdTMwNDRcdTMwNjdcdTMwNTlcdTMwNEJcdUZGMUZcXG5cdTMwNTNcdTMwNkVcdTY0Q0RcdTRGNUNcdTMwNkZcdTUxNDNcdTMwNkJcdTYyM0JcdTMwNUJcdTMwN0VcdTMwNUJcdTMwOTNcdTMwMDJgLFxuICAgIHRydWVcbiAgKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBcdTMwRDFcdTMwQ0RcdTMwRUJcdTYyOThcdTMwOEFcdTMwNUZcdTMwNUZcdTMwN0Zcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5mdW5jdGlvbiB0b2dnbGVCb2R5KGJvZHk6IEhUTUxFbGVtZW50LCBidG46IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IGNvbGxhcHNlZCA9IGJvZHkuc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCI7XG4gIGJvZHkuc3R5bGUuZGlzcGxheSA9IGNvbGxhcHNlZCA/IFwiXCIgOiBcIm5vbmVcIjtcbiAgYnRuLnRleHRDb250ZW50ID0gY29sbGFwc2VkID8gXCJcdTI1QjIgXHU2Mjk4XHUzMDhBXHUzMDVGXHUzMDVGXHUzMDgwXCIgOiBcIlx1MjVCQyBcdTVDNTVcdTk1OEJcIjtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBET00gXHUzMEQ4XHUzMEVCXHUzMEQxXHUzMEZDXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gZWwoXG4gIHRhZzogc3RyaW5nLFxuICBjbGFzc05hbWU/OiBzdHJpbmcsXG4gIGF0dHJzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICBpZiAoY2xhc3NOYW1lKSBlLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgaWYgKGF0dHJzKSB7XG4gICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoYXR0cnMpKSB7XG4gICAgICBlLnNldEF0dHJpYnV0ZShrLCB2KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGU7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFrR08sTUFBTSxXQUEyQyxvQkFBSSxJQUFJO0FBQUEsSUFDOUQsQ0FBQyxVQUFhLHFCQUFnQjtBQUFBLElBQzlCLENBQUMsWUFBYSx5QkFBa0I7QUFBQSxJQUNoQyxDQUFDLFFBQWEsaUJBQWM7QUFBQSxJQUM1QixDQUFDLE1BQWEsYUFBWTtBQUFBLElBQzFCLENBQUMsU0FBYSxtQkFBZTtBQUFBLElBQzdCLENBQUMsVUFBYSxxQkFBZ0I7QUFBQSxJQUM5QixDQUFDLFFBQWEsaUJBQWM7QUFBQSxJQUM1QixDQUFDLFVBQWEscUJBQWdCO0FBQUEsSUFDOUIsQ0FBQyxVQUFhLHFCQUFnQjtBQUFBLElBQzlCLENBQUMsT0FBYSxlQUFhO0FBQUEsSUFDM0IsQ0FBQyxVQUFhLHFCQUFnQjtBQUFBLElBQzlCLENBQUMsU0FBYSxtQkFBZTtBQUFBLElBQzdCLENBQUMsUUFBYSxpQkFBYztBQUFBLElBQzVCLENBQUMsUUFBYSxpQkFB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
