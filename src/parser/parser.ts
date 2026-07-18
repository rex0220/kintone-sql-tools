// ============================================================
// Parser（構文解析器）
//
// 入力: Token[]（Lexer の出力）
// 出力: Statement AST
//
// 再帰下降法で実装。
// 演算子の優先順位:
//   OR < AND < NOT < 比較演算子 < 一次式
// ============================================================

import { Token, TokenKind, KEYWORDS } from "../lexer/tokens";
import type {
  Statement,
  SelectStatement,
  UnionStatement,
  WithStatement,
  CteDefinition,
  ArithFieldValue,
  ArithSqlValue,
  CaseFieldValue,
  CaseSqlValue,
  SelectColumn,
  WildcardColumn,
  FieldColumn,
  AggregateColumn,
  AggregateFunc,
  TableRef,
  JoinClause,
  JoinType,
  JoinCondition,
  QualifiedIdentifier,
  WhereExpr,
  BinaryExpr,
  NullCheckExpr,
  LogicalExpr,
  NotExpr,
  GroupExpr,
  ExistsExpr,
  FieldValue,
  FieldRef,
  SqlValue,
  StringLiteral,
  NumberLiteral,
  KintoneFunction,
  InList,
  SubqueryInList,
  CompareOp,
  OrderByItem,
  InsertStatement,
  InsertSelectStatement,
  InsertRow,
  AggArithColumn,
  AggArithExpr,
  AggOperand,
  AggregateRef,
  GroupByKey,
  UpdateStatement,
  Assignment,
  DeleteStatement,
  ReorderStatement,
  UpsertStatement,
  UpsertSelectStatement,
  ShowAppsStatement,
  DescribeStatement,
  ExplainStatement,
  ArithExpr,
  ArithOp,
  ArithNode,
  ArithColumn,
  CaseColumn,
  CaseWhenExpr,
  CaseWhenClause,
  CaseResult,
  StringFuncName,
  StringFuncArg,
  StringFuncExpr,
  StringFuncColumn,
  FuncFieldValue,
  OrderByKey,
  ArrayLiteral,
  CreateTempTableStatement,
  DropTempTableStatement,
  AssertStatement,
  AssertOperand,
  AssertCompareOp,
  SetVariableStatement,
  DeclareVariableStatement,
  ScalarExpr,
  VariableRef,
  WindowColumn,
  WindowFunc,
} from "../types/ast";
import { NO_FROM_CTE_NAME } from "../types/ast";

/** バッチ(複文)の文数上限 */
const MAX_BATCH_STATEMENTS = 20;

// BETWEEN 展開用の型エイリアス（ローカル）
type ExpandedBetween = LogicalExpr;

// ------------------------------------------------------------
// トークン列 → テキスト再構成（ASSERT のエラーメッセージ用）
// ------------------------------------------------------------

/** この種別の直後の "(" は関数呼び出しとして詰めて表示する（COUNT( / ROUND( 等） */
const FUNC_CALL_PREFIX_KINDS: ReadonlySet<TokenKind> = new Set([
  TokenKind.IDENT, TokenKind.BIDENT,
  TokenKind.COUNT, TokenKind.SUM, TokenKind.AVG, TokenKind.MAX, TokenKind.MIN,
  TokenKind.ROW_NUMBER, TokenKind.RANK, TokenKind.DENSE_RANK,
  TokenKind.TODAY, TokenKind.NOW, TokenKind.LOGINUSER,
  TokenKind.UPPER, TokenKind.LOWER, TokenKind.TRIM, TokenKind.LTRIM, TokenKind.RTRIM,
  TokenKind.LENGTH, TokenKind.LENGTH_CHAR, TokenKind.SUBSTRING, TokenKind.SUBSTR, TokenKind.CONCAT,
  TokenKind.REPLACE, TokenKind.TRANSLATE, TokenKind.COALESCE, TokenKind.NULLIF, TokenKind.ISNULL,
  TokenKind.LEFT, TokenKind.RIGHT, TokenKind.INSTR,
  TokenKind.GREATEST, TokenKind.LEAST, TokenKind.LPAD, TokenKind.RPAD,
  TokenKind.CAST, TokenKind.CONVERT, TokenKind.FORMAT,
  TokenKind.ROUND, TokenKind.FLOOR, TokenKind.CEIL, TokenKind.CEILING,
  TokenKind.TRUNCATE, TokenKind.TRUNC,
  TokenKind.ABS, TokenKind.MOD, TokenKind.POWER, TokenKind.POW, TokenKind.SQRT,
  TokenKind.YEAR, TokenKind.MONTH, TokenKind.DAY,
  TokenKind.DATE_FORMAT, TokenKind.DATEDIFF, TokenKind.DATE_ADD, TokenKind.LAST_DAY,
  TokenKind.IF,
]);

/** 再構成テキストでトークン間に空白を入れるか */
function needsSpaceBetween(prev: Token, cur: Token): boolean {
  if (prev.kind === TokenKind.LPAREN || prev.kind === TokenKind.DOT) return false;
  if (
    cur.kind === TokenKind.RPAREN ||
    cur.kind === TokenKind.COMMA  ||
    cur.kind === TokenKind.DOT
  ) return false;
  if (cur.kind === TokenKind.LPAREN) {
    return !FUNC_CALL_PREFIX_KINDS.has(prev.kind);
  }
  return true;
}

// ------------------------------------------------------------
// エラー
// ------------------------------------------------------------

export class ParseError extends Error {
  constructor(message: string, public readonly token: Token) {
    super(`${message}（位置 ${token.pos}、トークン: 「${token.value}」）`);
    this.name = "ParseError";
  }
}

// ------------------------------------------------------------
// Parser クラス
// ------------------------------------------------------------

export class Parser {
  private allowUnaryPlusNumber = false;
  private pos = 0;
  /** WITH 句で定義された CTE 名のセット（parseTableRef で参照） */
  private cteNames: Set<string> = new Set();
  /** パース中に出現した一時テーブル参照（#name）のトークン。単文 API での拒否に使う */
  private tempTableRefs: Token[] = [];

  constructor(private readonly tokens: Token[]) {}

  // ----------------------------------------------------------
  // 公開 API
  // ----------------------------------------------------------

  /** 単文をパースする（従来 API。複文が渡されたらエラー） */
  parse(): Statement {
    const stmts = this.parseStatements();
    if (stmts.length === 0) {
      throw new ParseError("SQL 文がありません", this.peek());
    }
    if (stmts.length > 1) {
      throw new ParseError(
        "この API は単文のみ受け付けます（複文はバッチ実行 API を使用してください）",
        this.peek()
      );
    }
    // 一時テーブルはバッチスコープのため、単文では参照先が存在し得ない。
    // バッチ実行器（parseStatements 経由）が入るまで、既存の単文実行経路
    // （executeSelect が APP0 を読む / executeWith が空結果を返す）へ漏らさない
    if (this.tempTableRefs.length > 0) {
      const tok = this.tempTableRefs[0];
      throw new ParseError(
        `temp table ${tok.value} is not defined in this batch.`,
        tok
      );
    }
    return stmts[0];
  }

  /** 複文（`;` 区切り）をパースする。空文はスキップする */
  parseStatements(): Statement[] {
    const stmts: Statement[] = [];
    while (true) {
      // 空文（連続する ;）をスキップ
      while (this.peek().kind === TokenKind.SEMICOLON) this.advance();
      if (this.peek().kind === TokenKind.EOF) break;

      const startTok = this.peek();
      stmts.push(this.parseStatement());
      if (stmts.length > MAX_BATCH_STATEMENTS) {
        throw new ParseError(
          `batch exceeds ${MAX_BATCH_STATEMENTS} statements.`,
          startTok
        );
      }
      // 文の直後は ; または EOF
      const after = this.peek();
      if (after.kind !== TokenKind.SEMICOLON && after.kind !== TokenKind.EOF) {
        throw new ParseError("文の区切りには ; が必要です", after);
      }
    }
    this.expect(TokenKind.EOF);
    return stmts;
  }

  // ----------------------------------------------------------
  // Statement ディスパッチ
  // ----------------------------------------------------------

  private parseStatement(): Statement {
    const tok = this.peek();
    switch (tok.kind) {
      case TokenKind.WITH:     return this.parseWith();
      case TokenKind.SELECT:   return this.tryParseUnionChain(this.parseSelect(true));
      case TokenKind.INSERT:   return this.parseInsert();
      case TokenKind.UPDATE:   return this.parseUpdate();
      case TokenKind.DELETE:   return this.parseDelete();
      case TokenKind.REORDER:  return this.parseReorder();
      case TokenKind.UPSERT:   return this.parseUpsert();
      case TokenKind.SHOW:     return this.parseShow();
      case TokenKind.DESCRIBE:
      case TokenKind.DESC:     return this.parseDescribe();
      case TokenKind.EXPLAIN:  return this.parseExplain();
      case TokenKind.SET:      return this.parseSetVariable();
      case TokenKind.ASSERT:   return this.parseAssert();
      case TokenKind.IDENT: {
        // CREATE / DROP は予約語にせずソフトキーワードで扱う
        //（既存アプリのフィールド名・テーブル名を潰さないため）
        const upper = tok.value.toUpperCase();
        if (upper === "CREATE") return this.parseCreateTempTable();
        if (upper === "DROP")   return this.parseDropTempTable();
        if (upper === "DECLARE") return this.parseDeclareVariable();
        break;
      }
      default:
        break;
    }
    throw new ParseError(
      "SELECT / INSERT / UPDATE / DELETE / REORDER / WITH / SHOW / DESCRIBE / EXPLAIN / CREATE TEMP TABLE / DROP TEMP TABLE / SET / DECLARE / ASSERT のいずれかで始まる SQL 文が必要です",
      tok
    );
  }

  // ----------------------------------------------------------
  // SET @name = <ScalarExpr>
  // ----------------------------------------------------------

  private parseSetVariable(): SetVariableStatement {
    this.expect(TokenKind.SET);
    const variable = this.expect(TokenKind.VARIABLE, "SET の後には変数名（例: @name）が必要です");
    this.expect(TokenKind.EQ);
    const expr = this.parseScalarExpr("SET", true);
    return { type: "SET_VARIABLE", name: variable.value.slice(1).toLowerCase(), expr };
  }

  private parseDeclareVariable(): DeclareVariableStatement {
    this.advance(); // DECLARE（ソフトキーワード）
    const variable = this.expect(TokenKind.VARIABLE, "DECLARE の後には変数名（例: @name）が必要です");
    this.expect(TokenKind.EQ);
    const expr = this.parseScalarExpr("DECLARE", false);
    if (expr.type === "SCALAR_SUBQUERY") {
      // allowScalarSubquery=false で到達しないが、型の絞り込みを明示する。
      throw new ParseError("DECLARE の既定値にスカラーサブクエリは使用できません", this.peek());
    }
    return { type: "DECLARE_VARIABLE", name: variable.value.slice(1).toLowerCase(), default: expr };
  }

  /** SET / DECLARE RHS 専用。既存式パーサーで構文を読み、フィールド参照を明示的に拒否する。 */
  private parseScalarExpr(context: "SET" | "DECLARE", allowScalarSubquery: boolean): ScalarExpr {
    const tok = this.peek();
    if (tok.kind === TokenKind.VARIABLE) {
      throw new ParseError(`${context} の右辺では他の変数を参照できません`, tok);
    }
    if (tok.kind === TokenKind.NULL) {
      throw new ParseError(`${context} の右辺で NULL は使用できません`, tok);
    }
    if (tok.kind === TokenKind.LPAREN && this.peekAt(1).kind === TokenKind.SELECT) {
      if (!allowScalarSubquery) {
        throw new ParseError("DECLARE の既定値にスカラーサブクエリは使用できません", tok);
      }
      this.advance(); // ( を消費
      const query = this.parseSelect();
      this.expect(TokenKind.RPAREN);
      if (this.isArithOp(this.peek().kind)) {
        throw new ParseError(
          "スカラーサブクエリの後に算術演算子は使用できません。サブクエリ内で計算してください",
          this.peek()
        );
      }
      // SELECT * / _p.* は列数を静的判定できないため実行時検証に委ねる。
      const hasWildcard = query.columns.some(
        (c) => c.type === "WILDCARD" || c.type === "PARENT_WILDCARD"
      );
      if (!hasWildcard && query.columns.length !== 1) {
        throw new ParseError("scalar subquery in SET must return exactly 1 column.", tok);
      }
      return { type: "SCALAR_SUBQUERY", query };
    }
    if (tok.kind === TokenKind.STRING) {
      this.advance();
      return { type: "STRING", value: tok.value };
    }
    if (tok.kind === TokenKind.LOGINUSER) {
      throw new ParseError(
        `${context} の右辺で LOGINUSER() は使用できません（実行環境共通のログインユーザー解決は未対応です）`,
        tok
      );
    }
    if (tok.kind === TokenKind.TODAY || tok.kind === TokenKind.NOW) {
      return this.parseSqlValue() as KintoneFunction;
    }
    const expr = this.parseArithAddSub();
    this.rejectNonScalarExpr(expr, tok, context);
    if (expr.type === "NUMBER" || expr.type === "STRING_FUNC" || expr.type === "ARITH") return expr;
    throw new ParseError(`${context} の右辺にはフィールド参照を含まないスカラー式を指定してください`, tok);
  }

  private rejectNonScalarExpr(node: StringFuncArg, tok: Token, context: "SET" | "DECLARE"): void {
    if (node.type === "STRING" || node.type === "NUMBER") return;
    if (node.type === "FIELD_REF" || node.type === "AGG_REF") {
      throw new ParseError(`${context} の右辺ではフィールド参照・集計関数を使用できません`, tok);
    }
    if (node.type === "ARITH" || node.type === "AGG_ARITH") {
      this.rejectNonScalarExpr(node.left, tok, context);
      this.rejectNonScalarExpr(node.right, tok, context);
      return;
    }
    if (node.type === "STRING_FUNC") {
      for (const arg of node.args) this.rejectNonScalarExpr(arg, tok, context);
    }
  }

  // ----------------------------------------------------------
  // CREATE TEMP TABLE / DROP TEMP TABLE（バッチ内一時テーブル）
  // CREATE / DROP / TEMP / TABLE は予約語にしない（ソフトキーワード）
  // ----------------------------------------------------------

  private parseCreateTempTable(): CreateTempTableStatement {
    this.advance(); // CREATE
    this.expectSoftKeyword("TEMP", "CREATE の後には TEMP TABLE が必要です（例: CREATE TEMP TABLE #temp AS SELECT ...）");
    this.expectSoftKeyword("TABLE", "CREATE TEMP の後には TABLE が必要です");
    const name = this.parseTempTableName();
    this.expect(TokenKind.AS, "CREATE TEMP TABLE には AS SELECT が必要です");

    const tok = this.peek();
    let query: CreateTempTableStatement["query"];
    if (tok.kind === TokenKind.WITH) {
      query = this.parseWith();
    } else if (tok.kind === TokenKind.SELECT) {
      query = this.tryParseUnionChain(this.parseSelect());
    } else {
      throw new ParseError("CREATE TEMP TABLE ... AS の後には SELECT / WITH が必要です", tok);
    }
    return { type: "CREATE_TEMP_TABLE", name, query };
  }

  private parseDropTempTable(): DropTempTableStatement {
    this.advance(); // DROP
    this.expectSoftKeyword("TEMP", "DROP の後には TEMP TABLE が必要です（例: DROP TEMP TABLE #temp）");
    this.expectSoftKeyword("TABLE", "DROP TEMP の後には TABLE が必要です");
    const name = this.parseTempTableName();
    return { type: "DROP_TEMP_TABLE", name };
  }

  private expectSoftKeyword(word: string, msg: string): void {
    const tok = this.peek();
    if (tok.kind === TokenKind.IDENT && tok.value.toUpperCase() === word) {
      this.advance();
      return;
    }
    throw new ParseError(msg, tok);
  }

  private parseTempTableName(): string {
    const tok = this.peek();
    if (tok.kind === TokenKind.IDENT && tok.value.startsWith("#")) {
      this.advance();
      return tok.value;
    }
    throw new ParseError("一時テーブル名は # で始まる必要があります（例: #temp）", tok);
  }

  private parseShow(): ShowAppsStatement {
    this.advance(); // SHOW
    if (!this.consume(TokenKind.APPS)) {
      throw new ParseError("SHOW の後には APPS が必要です（例: SHOW APPS）", this.peek());
    }
    return { type: "SHOW_APPS" };
  }

  private parseDescribe(): DescribeStatement {
    this.advance(); // DESCRIBE / DESC
    const name = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(name, this.prev());
    if (subtableCode) {
      throw new ParseError("DESCRIBE はサブテーブル仮想テーブル名を受け付けません", this.prev());
    }
    return { type: "DESCRIBE", appId };
  }

  private parseExplain(): ExplainStatement {
    this.advance(); // EXPLAIN を消費
    const tok = this.peek();
    let query: ExplainStatement["query"];
    if (tok.kind === TokenKind.WITH) {
      const w = this.parseWith();
      if (w.type !== "WITH") {
        throw new ParseError("EXPLAIN に続く WITH 句が不正です", tok);
      }
      query = w;
    } else if (tok.kind === TokenKind.SELECT) {
      const sel = this.parseSelect(true);
      const chained = this.tryParseUnionChain(sel);
      query = chained as SelectStatement | UnionStatement;
    } else if (tok.kind === TokenKind.INSERT) {
      query = this.parseInsert() as InsertStatement | InsertSelectStatement;
    } else if (tok.kind === TokenKind.UPSERT) {
      query = this.parseUpsert() as UpsertStatement | UpsertSelectStatement;
    } else if (tok.kind === TokenKind.UPDATE) {
      query = this.parseUpdate();
    } else if (tok.kind === TokenKind.DELETE) {
      query = this.parseDelete();
    } else if (tok.kind === TokenKind.REORDER) {
      query = this.parseReorder();
    } else {
      throw new ParseError("EXPLAIN の後には SELECT / WITH / INSERT / UPSERT / UPDATE / DELETE / REORDER が必要です", tok);
    }
    return { type: "EXPLAIN", query };
  }

  // ----------------------------------------------------------
  // ASSERT
  //
  //   ASSERT <式> <比較演算子> <式>
  //   ASSERT <式> BETWEEN <式> AND <式>
  //
  // 式: リテラル / 算術式 / スカラーサブクエリ。
  // フィールド参照（FROM コンテキストがない）・AND / OR 複合条件・
  // 裸の値のみ（ASSERT 1）は ParseError。
  // ----------------------------------------------------------

  private parseAssert(): AssertStatement {
    this.expect(TokenKind.ASSERT);
    const condStart = this.pos;
    const left = this.parseAssertOperand();

    const opTok = this.peek();
    if (this.consume(TokenKind.BETWEEN)) {
      const low = this.parseAssertOperand();
      this.expect(
        TokenKind.AND,
        "ASSERT の BETWEEN には AND が必要です（例: ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500）"
      );
      const high = this.parseAssertOperand();
      this.rejectAssertCompound();
      return {
        type: "ASSERT", left, op: "BETWEEN", right: null, low, high,
        text: this.renderTokenRange(condStart, this.pos),
      };
    }

    const op = this.tryAssertCompareOp();
    if (op === null) {
      throw new ParseError(
        "ASSERT には比較演算子（= <> < <= > >=）または BETWEEN が必要です（値のみの ASSERT は不可）",
        opTok
      );
    }
    const right = this.parseAssertOperand();
    this.rejectAssertCompound();
    return {
      type: "ASSERT", left, op, right, low: null, high: null,
      text: this.renderTokenRange(condStart, this.pos),
    };
  }

  /** ASSERT のオペランド: 文字列 / スカラーサブクエリ / 数値算術式 */
  private parseAssertOperand(): AssertOperand {
    const tok = this.peek();

    if (tok.kind === TokenKind.VARIABLE) {
      this.advance();
      return { type: "VARIABLE", name: tok.value.slice(1).toLowerCase() } satisfies VariableRef;
    }

    // 文字列リテラル
    if (tok.kind === TokenKind.STRING) {
      this.advance();
      return { type: "STRING", value: tok.value } satisfies StringLiteral;
    }

    // スカラーサブクエリ: (SELECT ...)
    if (tok.kind === TokenKind.LPAREN && this.peekAt(1).kind === TokenKind.SELECT) {
      this.advance(); // ( を消費
      const query = this.parseSelect();
      this.expect(TokenKind.RPAREN);
      if (this.isArithOp(this.peek().kind)) {
        throw new ParseError(
          "スカラーサブクエリの後に算術演算子は使用できません。サブクエリ内で計算してください（例: ASSERT (SELECT COUNT(*) * 2 FROM APP100) > 10）",
          this.peek()
        );
      }
      // 複数列は静的に拒否する。SELECT * / _p.* は列数を静的判定できないため
      // 実行時の 1行1列検証に委ねる（仕様 §2.2）
      const hasWildcard = query.columns.some(
        (c) => c.type === "WILDCARD" || c.type === "PARENT_WILDCARD"
      );
      if (!hasWildcard && query.columns.length > 1) {
        throw new ParseError("scalar subquery in ASSERT must return exactly 1 column.", tok);
      }
      return { type: "SCALAR_SUBQUERY", query };
    }

    // 数値・括弧・単項マイナス → 算術式（葉は数値リテラルのみ）
    if (
      tok.kind === TokenKind.NUMBER ||
      tok.kind === TokenKind.LPAREN ||
      tok.kind === TokenKind.MINUS
    ) {
      const expr = this.parseArithAddSub();
      this.rejectNonLiteralArith(expr, tok);
      if (expr.type === "NUMBER") return expr;
      return expr as ArithExpr;
    }

    // 関数呼び出し（ROUND / LENGTH / TODAY 等）は初期版では非対応
    if (this.tryStringFuncName() !== null) {
      throw new ParseError(
        "ASSERT の式では関数は使用できません（スカラーサブクエリ内で計算してください）",
        tok
      );
    }

    throw new ParseError(
      "ASSERT の式にはリテラル・算術式・スカラーサブクエリを指定してください（フィールド参照は使用できません）",
      tok
    );
  }

  /** ASSERT の算術式にフィールド参照・関数呼び出しが含まれていたら拒否する */
  private rejectNonLiteralArith(node: ArithNode, tok: Token): void {
    if (node.type === "FIELD_REF") {
      throw new ParseError(
        `ASSERT ではフィールド参照は使用できません（FROM コンテキストがありません）: ${node.field}`,
        tok
      );
    }
    if (node.type === "STRING_FUNC") {
      throw new ParseError(
        "ASSERT の式では関数は使用できません（スカラーサブクエリ内で計算してください）",
        tok
      );
    }
    if (node.type === "ARITH") {
      this.rejectNonLiteralArith(node.left, tok);
      this.rejectNonLiteralArith(node.right, tok);
    }
  }

  /** ASSERT の比較演算子を読む（該当しなければ null・消費しない） */
  private tryAssertCompareOp(): AssertCompareOp | null {
    switch (this.peek().kind) {
      case TokenKind.EQ:    this.advance(); return "=";
      case TokenKind.NEQ:   this.advance(); return "!=";
      case TokenKind.LT_GT: this.advance(); return "<>";
      case TokenKind.GT:    this.advance(); return ">";
      case TokenKind.LT:    this.advance(); return "<";
      case TokenKind.GTE:   this.advance(); return ">=";
      case TokenKind.LTE:   this.advance(); return "<=";
      default: return null;
    }
  }

  /** ASSERT は AND / OR による複合条件に対応しない（初期版仕様） */
  private rejectAssertCompound(): void {
    const tok = this.peek();
    if (tok.kind === TokenKind.AND || tok.kind === TokenKind.OR) {
      throw new ParseError(
        "ASSERT は AND / OR による複合条件に対応していません（複数の ASSERT 文に分けてください）",
        tok
      );
    }
  }

  /**
   * トークン列 [fromIdx, toIdx) を SQL 風テキストに再構成する。
   * AssertError の "assertion failed: <条件>" メッセージ用（正規化表示で十分）。
   */
  private renderTokenRange(fromIdx: number, toIdx: number): string {
    let out = "";
    for (let i = fromIdx; i < toIdx; i++) {
      const t = this.tokens[i];
      let text: string;
      if (t.kind === TokenKind.STRING)      text = `'${t.value.replace(/'/g, "''")}'`;
      else if (t.kind === TokenKind.BIDENT) text = `\`${t.value}\``;
      else                                  text = t.value;
      if (out.length > 0 && needsSpaceBetween(this.tokens[i - 1], t)) out += " ";
      out += text;
    }
    return out;
  }

  // ----------------------------------------------------------
  // SELECT
  // ----------------------------------------------------------

  private parseSelect(allowKorder = false): SelectStatement {
    this.expect(TokenKind.SELECT);

    const distinct = this.consume(TokenKind.DISTINCT);
    const columns = this.parseSelectColumns();

    const hasFrom = this.consume(TokenKind.FROM);
    const from = hasFrom
      ? this.parseTableRef()
      : { appId: 0, alias: null, cteName: NO_FROM_CTE_NAME };

    const joins = hasFrom ? this.parseJoins() : [];

    const where = this.consume(TokenKind.WHERE) ? this.parseWhereExpr() : null;

    let groupBy: GroupByKey[] = [];
    let having: WhereExpr | null = null;
    if (this.consume(TokenKind.GROUP)) {
      this.expect(TokenKind.BY);
      groupBy = this.parseGroupByKeys();
      if (this.consume(TokenKind.HAVING)) {
        having = this.parseWhereExpr();
      }
    }

    let orderMode: SelectStatement["orderMode"] = "CANONICAL";
    let orderBy: OrderByItem[] = [];
    if (this.consume(TokenKind.ORDER)) {
      this.expect(TokenKind.BY);
      orderBy = this.parseOrderBy();
    } else if (this.consume(TokenKind.KORDER)) {
      if (!allowKorder) {
        throw new ParseError("KORDER BY は利用者へ結果を返すトップレベル SELECT でのみ使用できます", this.prev());
      }
      orderMode = "KINTONE_NATIVE";
      this.expect(TokenKind.BY);
      orderBy = this.parseOrderBy();
    }

    const limit = this.consume(TokenKind.LIMIT)
      ? this.parseUnsignedInt()
      : null;

    const offset = this.consume(TokenKind.OFFSET)
      ? this.parseUnsignedInt()
      : null;

    const hasWindow = columns.some((column) => column.type === "WINDOW_COL");
    const hasAggregate = columns.some((column) => this.selectColumnHasAggregate(column));
    if (hasWindow && (groupBy.length > 0 || hasAggregate)) {
      throw new ParseError("ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません", this.peek());
    }

    return {
      type: "SELECT",
      distinct,
      columns,
      from,
      joins,
      where,
      groupBy,
      having,
      orderMode,
      orderBy,
      limit,
      offset,
    };
  }

  // ----------------------------------------------------------
  // WITH 句（CTE）
  // ----------------------------------------------------------

  private parseWith(): WithStatement {
    this.expect(TokenKind.WITH);
    const ctes: CteDefinition[] = [];

    do {
      const name = this.parseIdentifier();
      this.expect(TokenKind.AS);
      this.expect(TokenKind.LPAREN);
      let query: CteDefinition["query"];
      const inner = this.peek().kind;
      if (inner === TokenKind.SHOW) {
        query = this.parseShow();
      } else if (inner === TokenKind.DESCRIBE || inner === TokenKind.DESC) {
        query = this.parseDescribe();
      } else {
        query = this.tryParseUnionChain(this.parseSelect());
      }
      this.expect(TokenKind.RPAREN);
      ctes.push({ name, query });
      // 定義済み CTE 名を登録（後続の CTE・最終クエリで FROM に使える）
      this.cteNames.add(name);
    } while (this.consume(TokenKind.COMMA));

    const query = this.tryParseUnionChain(this.parseSelect());
    this.cteNames.clear();
    return { type: "WITH", ctes, query };
  }

  // ----------------------------------------------------------
  // UNION / UNION ALL チェーン
  // ----------------------------------------------------------

  private tryParseUnionChain(
    left: SelectStatement | UnionStatement
  ): SelectStatement | UnionStatement {
    if (this.peek().kind !== TokenKind.UNION) return left;
    if (left.type === "SELECT" && left.orderMode === "KINTONE_NATIVE") {
      throw new ParseError("KORDER BY は UNION 分岐では使用できません", this.peek());
    }
    this.advance(); // UNION を消費
    const all = this.consume(TokenKind.ALL);
    const right = this.parseSelect();
    const union: UnionStatement = { type: "UNION", all, left, right };
    return this.tryParseUnionChain(union);
  }

  // SELECT 句のカラムリスト
  private parseSelectColumns(): SelectColumn[] {
    const cols: SelectColumn[] = [];
    do {
      cols.push(this.parseSelectColumn());
    } while (this.consume(TokenKind.COMMA));
    return cols;
  }

  private parseSelectColumn(): SelectColumn {
    // *
    if (this.consume(TokenKind.STAR)) {
      return { type: "WILDCARD" };
    }

    const windowFunc = this.tryWindowFunc();
    if (windowFunc !== null) {
      return this.parseWindowColumn(windowFunc);
    }

    // CASE WHEN ... END [AS alias]
    if (this.peek().kind === TokenKind.CASE) {
      const expr = this.parseCaseWhenExpr();
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return { type: "CASE_COL", expr, alias } satisfies CaseColumn;
    }

    // IF(cond, then, else) [AS alias] → CASE WHEN として処理
    if (this.peek().kind === TokenKind.IF) {
      const expr = this.parseIfExpr();
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return { type: "CASE_COL", expr, alias } satisfies CaseColumn;
    }

    // 文字列関数: UPPER / LOWER / TRIM / ... [AS alias]
    // 関数の後に算術演算子が続く場合は ArithColumn (例: ROUND(金額)/2)
    if (this.tryStringFuncName() !== null) {
      const funcExpr = this.parseStringFuncExpr();
      if (this.isArithOp(this.peek().kind)) {
        const node = this.continueArith(funcExpr);
        const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
        return { type: "ARITH_COL", expr: node, alias };
      }
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return { type: "STRFUNC_COL", expr: funcExpr, alias } satisfies StringFuncColumn;
    }

    // 集計関数: COUNT / SUM / AVG / MAX / MIN / GROUP_CONCAT
    // 後続に算術演算子があれば → ARITH_AGG_COL (例: SUM(金額) * 1.1)
    const aggFunc = this.tryAggregateFunc();
    if (aggFunc !== null) {
      const ref = this.parseAggregateRef(aggFunc);
      if (this.isArithOp(this.peek().kind)) {
        const expr = this.continueAggArith(ref);
        const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
        return { type: "ARITH_AGG_COL", expr, alias } satisfies AggArithColumn;
      }
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return {
        type: "AGGREGATE",
        func: ref.func,
        distinct: ref.distinct,
        arg: ref.arg,
        ...(ref.separator !== undefined ? { separator: ref.separator } : {}),
        alias,
      } satisfies AggregateColumn;
    }

    // スカラーサブクエリ: ( SELECT ... ) [AS alias]
    if (this.peek().kind === TokenKind.LPAREN && this.peekAt(1).kind === TokenKind.SELECT) {
      this.advance(); // ( を消費
      const query = this.parseSelect();
      this.expect(TokenKind.RPAREN);
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return { type: "SCALAR_SUBQUERY_COL", query, alias };
    }

    // 文字列リテラル列: 'XXX' [AS alias]
    if (this.peek().kind === TokenKind.STRING) {
      const value = this.expect(TokenKind.STRING).value;
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return { type: "LITERAL_COL", value, alias };
    }

    // 算術式が ( または数値リテラルで始まる場合
    if (
      this.peek().kind === TokenKind.LPAREN ||
      this.peek().kind === TokenKind.NUMBER
    ) {
      const node = this.parseArithAddSub();
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return { type: "ARITH_COL", expr: node, alias };
    }

    // フィールド [AS alias]
    // alias.field 形式（JOIN の修飾識別子）も処理する
    const field = this.parseColumnFieldRef();
    if (field === "_p.*") {
      return { type: "PARENT_WILDCARD" };
    }
    if (field === "_parent.*") {
      throw new ParseError("_parent.* は廃止しました。_p.* を使用してください", this.prev());
    }

    // 算術演算子が続く場合 → ArithColumn
    if (this.isArithOp(this.peek().kind)) {
      const left: ArithNode = { type: "FIELD_REF", field };
      const node = this.continueArith(left);
      const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return { type: "ARITH_COL", expr: node, alias };
    }

    const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
    return { type: "FIELD", field, alias };
  }

  private tryWindowFunc(): WindowFunc | null {
    switch (this.peek().kind) {
      case TokenKind.ROW_NUMBER: return "ROW_NUMBER";
      case TokenKind.RANK: return "RANK";
      case TokenKind.DENSE_RANK: return "DENSE_RANK";
      default: return null;
    }
  }

  private parseWindowColumn(func: WindowFunc): WindowColumn {
    this.advance();
    this.expect(TokenKind.LPAREN);
    if (this.peek().kind !== TokenKind.RPAREN) {
      throw new ParseError(`${func} は引数を受け付けません`, this.peek());
    }
    this.expect(TokenKind.RPAREN);
    this.expectSoftKeyword("OVER", `${func} には OVER (...) が必要です`);
    this.expect(TokenKind.LPAREN);

    const partitionBy: FieldRef[] = [];
    if (this.isSoftKeyword("PARTITION")) {
      this.advance();
      this.expect(TokenKind.BY, "PARTITION の後には BY が必要です");
      do {
        const ref = this.parseQualifiedIdent();
        partitionBy.push({ type: "FIELD", tableAlias: ref.tableAlias, field: ref.field });
      } while (this.consume(TokenKind.COMMA));
    }

    const orderBy = this.consume(TokenKind.ORDER)
      ? (this.expect(TokenKind.BY), this.parseOrderBy())
      : [];
    this.expect(TokenKind.RPAREN);

    if (!this.consume(TokenKind.AS)) {
      throw new ParseError("ウィンドウ関数には AS alias が必要です", this.peek());
    }
    const alias = this.parseAliasName();
    return { type: "WINDOW_COL", func, partitionBy, orderBy, alias };
  }

  private selectColumnHasAggregate(column: SelectColumn): boolean {
    if (column.type === "AGGREGATE" || column.type === "ARITH_AGG_COL") return true;
    if (column.type !== "STRFUNC_COL") return false;
    return column.expr.args.some((arg) => this.stringFuncArgHasAggregate(arg));
  }

  private stringFuncArgHasAggregate(arg: StringFuncArg): boolean {
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
    if (arg.type === "STRING_FUNC") {
      return arg.args.some((nested) => this.stringFuncArgHasAggregate(nested));
    }
    return false;
  }

  private isArithOp(kind: TokenKind): boolean {
    return (
      kind === TokenKind.PLUS    ||
      kind === TokenKind.MINUS   ||
      kind === TokenKind.STAR    ||
      kind === TokenKind.SLASH   ||
      kind === TokenKind.PERCENT
    );
  }

  // ──────────────────────────────────────────────────
  // 集計算術式パーサー
  //
  //   continueAggArith     : + - > * /
  //     └ continueAggArithMulDiv : * /
  //         └ parseAggPrimary : 集計関数 / 数値 / (expr)
  // ──────────────────────────────────────────────────

  private continueAggArith(left: AggOperand): AggOperand {
    return this.continueAggArithAddSub(this.continueAggArithMulDiv(left));
  }

  private continueAggArithMulDiv(left: AggOperand): AggOperand {
    while (
      this.peek().kind === TokenKind.STAR    ||
      this.peek().kind === TokenKind.SLASH   ||
      this.peek().kind === TokenKind.PERCENT
    ) {
      const op = this.parseArithOp();
      left = { type: "AGG_ARITH", left, op, right: this.parseAggPrimary() } satisfies AggArithExpr;
    }
    return left;
  }

  private continueAggArithAddSub(left: AggOperand): AggOperand {
    while (this.peek().kind === TokenKind.PLUS || this.peek().kind === TokenKind.MINUS) {
      const op = this.parseArithOp();
      left = { type: "AGG_ARITH", left, op, right: this.parseAggArithMulDiv() } satisfies AggArithExpr;
    }
    return left;
  }

  private parseAggArithMulDiv(): AggOperand {
    return this.continueAggArithMulDiv(this.parseAggPrimary());
  }

  /** 集計算術式の一次式: 集計関数 / 数値リテラル / 括弧 */
  private parseAggPrimary(): AggOperand {
    // 括弧
    if (this.consume(TokenKind.LPAREN)) {
      const inner = this.continueAggArith(this.parseAggPrimary());
      this.expect(TokenKind.RPAREN);
      return inner;
    }
    // 単項マイナス
    if (this.peek().kind === TokenKind.MINUS) {
      this.advance();
      const operand = this.parseAggPrimary();
      if (operand.type === "NUMBER") return { type: "NUMBER", value: -operand.value };
      return { type: "AGG_ARITH", left: { type: "NUMBER", value: 0 }, op: "-", right: operand };
    }
    // 数値リテラル
    if (this.peek().kind === TokenKind.NUMBER) {
      const tok = this.advance();
      return { type: "NUMBER", value: Number(tok.value) };
    }
    // 集計関数
    const aggFunc = this.tryAggregateFunc();
    if (aggFunc !== null) {
      return this.parseAggregateRef(aggFunc);
    }
    throw new ParseError("集計算術式には集計関数または数値が必要です", this.peek());
  }

  // ──────────────────────────────────────────────────
  // 算術式パーサー（演算子優先順位: * / > + -）
  //
  //   parseArithAddSub   : + -（左結合・低優先度）
  //     └ parseArithMulDiv : * /（左結合・高優先度）
  //         └ parseArithPrimary : 数値 / フィールド / (expr)
  //
  // continueArith*(left) は先頭の primary を外部で読んだ場合に使う
  // ──────────────────────────────────────────────────

  private parseArithAddSub(): ArithNode {
    return this.continueArithAddSub(this.parseArithMulDiv());
  }

  private parseArithMulDiv(): ArithNode {
    return this.continueArithMulDiv(this.parseArithPrimary());
  }

  /** 左辺が決まっている状態から残りを解析（SELECT column など） */
  private continueArith(left: ArithNode): ArithNode {
    return this.continueArithAddSub(this.continueArithMulDiv(left));
  }

  private continueArithMulDiv(left: ArithNode): ArithNode {
    while (
      this.peek().kind === TokenKind.STAR    ||
      this.peek().kind === TokenKind.SLASH   ||
      this.peek().kind === TokenKind.PERCENT
    ) {
      const op = this.parseArithOp();
      const right = this.parseArithPrimary();
      left = { type: "ARITH", left, op, right };
    }
    return left;
  }

  private continueArithAddSub(left: ArithNode): ArithNode {
    while (
      this.peek().kind === TokenKind.PLUS ||
      this.peek().kind === TokenKind.MINUS
    ) {
      const op = this.parseArithOp();
      // 右辺は mul/div 優先でパース
      const right = this.parseArithMulDiv();
      left = { type: "ARITH", left, op, right };
    }
    return left;
  }

  private parseArithPrimary(): ArithNode {
    // 括弧: (expr)
    if (this.consume(TokenKind.LPAREN)) {
      const expr = this.parseArithAddSub();
      this.expect(TokenKind.RPAREN);
      return expr;
    }
    // 単項プラス: 数値リテラルの直前だけを受理する
    if (this.allowUnaryPlusNumber && this.peek().kind === TokenKind.PLUS) {
      this.advance();
      const number = this.expect(TokenKind.NUMBER, "単項 + の直後には数値リテラルが必要です");
      return { type: "NUMBER", value: Number(number.value) };
    }
    // 単項マイナス: -expr（符号のネストは受理しない）
    if (this.peek().kind === TokenKind.MINUS) {
      this.advance();
      if (this.peek().kind === TokenKind.MINUS || this.peek().kind === TokenKind.PLUS) {
        throw new ParseError("単項符号を重ねて指定することはできません", this.peek());
      }
      const operand = this.parseArithPrimary();
      // 数値リテラルは即座に符号反転
      if (operand.type === "NUMBER") return { type: "NUMBER", value: -operand.value };
      // それ以外は 0 - operand に展開
      return { type: "ARITH", left: { type: "NUMBER", value: 0 }, op: "-", right: operand };
    }
    // 文字列・数値関数 (ROUND / LENGTH / UPPER / ...) → StringFuncExpr as ArithNode
    if (this.tryStringFuncName() !== null) {
      return this.parseStringFuncExpr();
    }
    const tok = this.peek();
    if (tok.kind === TokenKind.NUMBER) {
      this.advance();
      return { type: "NUMBER", value: Number(tok.value) };
    }
    if (tok.kind === TokenKind.IDENT || tok.kind === TokenKind.BIDENT) {
      this.advance();
      let field = tok.value;
      // alias.field 形式の修飾識別子（例: a.金額 * 1.1）
      if (this.peek().kind === TokenKind.DOT) {
        this.advance(); // DOT を消費
        const fieldTok = this.advance();
        field = `${field}.${fieldTok.value}`;
      }
      return { type: "FIELD_REF", field };
    }
    throw new ParseError(
      "算術式のオペランドには識別子・数値・括弧式を指定してください",
      tok
    );
  }

  // ──────────────────────────────────────────────────
  // CASE WHEN 式パーサー
  //
  //   CASE WHEN cond THEN result [WHEN cond THEN result]... [ELSE result] END
  //
  // cond  : WhereExpr（WHERE 句と同じ文法）
  // result: 文字列リテラル / 算術式（フィールド参照・数値含む）
  // ──────────────────────────────────────────────────

  /** IF(条件, then値, else値) → CaseWhenExpr に変換 */
  private parseIfExpr(): CaseWhenExpr {
    this.advance(); // IF を消費
    this.expect(TokenKind.LPAREN);
    const condition = this.parseWhereExpr();
    this.expect(TokenKind.COMMA);
    const thenResult = this.parseCaseResult();
    this.expect(TokenKind.COMMA);
    const elseResult = this.parseCaseResult();
    this.expect(TokenKind.RPAREN);
    return {
      type: "CASE_WHEN",
      branches: [{ condition, result: thenResult }],
      elseResult,
    };
  }

  private parseCaseWhenExpr(): CaseWhenExpr {
    this.expect(TokenKind.CASE);
    const branches: CaseWhenClause[] = [];

    while (this.peek().kind === TokenKind.WHEN) {
      this.advance(); // WHEN を消費
      const condition = this.parseWhereExpr();
      this.expect(TokenKind.THEN);
      const result = this.parseCaseResult();
      branches.push({ condition, result });
    }

    if (branches.length === 0) {
      throw new ParseError("CASE の後には WHEN が最低 1 つ必要です", this.peek());
    }

    let elseResult: CaseResult | null = null;
    if (this.consume(TokenKind.ELSE)) {
      elseResult = this.parseCaseResult();
    }

    this.expect(TokenKind.END);
    return { type: "CASE_WHEN", branches, elseResult };
  }

  /** THEN / ELSE の結果値: 文字列リテラル / 配列リテラル / 文字列関数 / 算術式 */
  private parseCaseResult(): CaseResult {
    const tok = this.peek();
    // 配列リテラル: ['val1', 'val2'] → ArrayLiteral
    if (tok.kind === TokenKind.LBRACKET) {
      return this.parseArrayLiteral();
    }
    if (tok.kind === TokenKind.STRING) {
      this.advance();
      return { type: "STRING", value: tok.value };
    }
    if (this.tryStringFuncName() !== null) {
      return this.parseStringFuncExpr();
    }
    // 数値・フィールド参照・括弧 → ArithNode として解析
    return this.parseArithAddSub();
  }

  // ──────────────────────────────────────────────────
  // 文字列関数パーサー
  //
  //   UPPER(arg) / LOWER(arg) / TRIM(arg) / LTRIM(arg) / RTRIM(arg)
  //   LENGTH(arg)
  //   SUBSTRING(arg, start [, len]) / SUBSTR(arg, start [, len])
  //   CONCAT(arg1, arg2, ...)
  //   REPLACE(arg, from, to)
  //
  // arg: 文字列リテラル / 算術式（フィールド参照・数値含む）/ ネスト文字列関数
  // ──────────────────────────────────────────────────

  private tryStringFuncName(): StringFuncName | null {
    // LEFT / RIGHT は JOIN 修飾子でもあるため、直後が "(" の場合だけ関数とする。
    if (this.peekAt(1).kind === TokenKind.LPAREN) {
      if (this.peek().kind === TokenKind.LEFT) return "LEFT";
      if (this.peek().kind === TokenKind.RIGHT) return "RIGHT";
    }

    const map: Partial<Record<TokenKind, StringFuncName>> = {
      [TokenKind.UPPER]:     "UPPER",
      [TokenKind.LOWER]:     "LOWER",
      [TokenKind.TRIM]:      "TRIM",
      [TokenKind.LTRIM]:     "LTRIM",
      [TokenKind.RTRIM]:     "RTRIM",
      [TokenKind.LENGTH]:    "LENGTH",
      [TokenKind.LENGTH_CHAR]: "LENGTH_CHAR",
      [TokenKind.SUBSTRING]: "SUBSTRING",
      [TokenKind.SUBSTR]:    "SUBSTRING",
      [TokenKind.CONCAT]:    "CONCAT",
      [TokenKind.REPLACE]:   "REPLACE",
      [TokenKind.TRANSLATE]: "TRANSLATE",
      [TokenKind.COALESCE]:  "COALESCE",
      [TokenKind.NULLIF]:    "NULLIF",
      [TokenKind.ISNULL]:    "ISNULL",
      [TokenKind.INSTR]:     "INSTR",
      [TokenKind.GREATEST]:  "GREATEST",
      [TokenKind.LEAST]:     "LEAST",
      [TokenKind.LPAD]:      "LPAD",
      [TokenKind.RPAD]:      "RPAD",
      [TokenKind.CAST]:      "CAST",
      [TokenKind.CONVERT]:   "CAST",   // CONVERT → CAST に正規化
      [TokenKind.FORMAT]:    "FORMAT",
      [TokenKind.ROUND]:     "ROUND",
      [TokenKind.FLOOR]:     "FLOOR",
      [TokenKind.CEIL]:      "CEIL",
      [TokenKind.CEILING]:   "CEIL",   // CEILING → CEIL に正規化
      [TokenKind.TRUNCATE]:  "TRUNCATE",
      [TokenKind.TRUNC]:     "TRUNCATE", // TRUNC → TRUNCATE に正規化
      [TokenKind.YEAR]:        "YEAR",
      [TokenKind.MONTH]:       "MONTH",
      [TokenKind.DAY]:         "DAY",
      [TokenKind.DATE_FORMAT]: "DATE_FORMAT",
      [TokenKind.DATEDIFF]:    "DATEDIFF",
      [TokenKind.DATE_ADD]:    "DATE_ADD",
      [TokenKind.LAST_DAY]:    "LAST_DAY",
      [TokenKind.ABS]:         "ABS",
      [TokenKind.MOD]:         "MOD",
      [TokenKind.POWER]:       "POWER",
      [TokenKind.POW]:         "POWER",  // POW → POWER に正規化
      [TokenKind.SQRT]:        "SQRT",
    };
    const byKind = map[this.peek().kind] ?? null;
    if (byKind !== null) return byKind;

    // キーワード登録なしの関数名: IDENT で名前を先読みし、直後に '(' がある場合のみ関数と判断
    if (this.peek().kind === TokenKind.IDENT) {
      const name = this.peek().value.toUpperCase();
      if (name === "CURRENT_DATE" || name === "CURRENT_TIMESTAMP") {
        // 1トークン先が '(' であれば関数呼び出し
        if (this.peekAt(1).kind === TokenKind.LPAREN) {
          return name as StringFuncName;
        }
      }
    }
    return null;
  }

  private parseStringFuncExpr(): StringFuncExpr {
    const tokenKind = this.peek().kind; // CAST / CONVERT / FORMAT ... を記憶
    const func = this.tryStringFuncName()!; // 呼び出し元が保証
    this.advance(); // 関数名トークンを消費
    this.expect(TokenKind.LPAREN);

    // ── CAST(expr AS type) ──────────────────────────────────
    if (tokenKind === TokenKind.CAST) {
      const valueArg = this.parseStringFuncArg();
      this.expect(TokenKind.AS);
      const typeArg = this.parseCastType();
      this.expect(TokenKind.RPAREN);
      return { type: "STRING_FUNC", func: "CAST", args: [valueArg, typeArg] };
    }

    // ── CONVERT(expr, type) ─────────────────────────────────
    if (tokenKind === TokenKind.CONVERT) {
      const valueArg = this.parseStringFuncArg();
      this.expect(TokenKind.COMMA);
      const typeArg = this.parseCastType();
      this.expect(TokenKind.RPAREN);
      return { type: "STRING_FUNC", func: "CAST", args: [valueArg, typeArg] };
    }

    // ── 通常の関数（カンマ区切り引数） ──────────────────────
    const args: StringFuncArg[] = [];
    if (this.peek().kind !== TokenKind.RPAREN) {
      do {
        args.push(this.parseStringFuncArg());
      } while (this.consume(TokenKind.COMMA));
    }

    this.expect(TokenKind.RPAREN);
    return { type: "STRING_FUNC", func, args };
  }

  /**
   * CAST / CONVERT のキャスト先型を解析する。
   * TEXT / VARCHAR / CHAR / STRING → "TEXT"
   * NUMBER / INT / INTEGER / NUMERIC / DECIMAL / FLOAT / DOUBLE → "NUMBER"
   * `SIZE(n)` 指定（VARCHAR(255) 等）はカッコを無視して型名だけ読む。
   */
  private parseCastType(): StringFuncArg {
    const tok = this.peek();
    let typeName: string;
    // 識別子（TEXT, NUMBER, INT 等は KEYWORDS に登録されていないため IDENT）
    // AS, SET 等のキーワードが型名になることはないが、念のため IDENT/BIDENT のみ受け付ける
    if (tok.kind === TokenKind.IDENT || tok.kind === TokenKind.BIDENT) {
      this.advance();
      typeName = tok.value.toUpperCase();
    } else {
      throw new ParseError(
        "キャスト先の型名（TEXT, NUMBER, INT など）が必要です",
        tok
      );
    }
    // VARCHAR(255) 等のサイズ指定は読み飛ばす
    if (this.peek().kind === TokenKind.LPAREN) {
      this.advance(); // (
      this.parseUnsignedInt(); // 255
      this.expect(TokenKind.RPAREN);
    }
    // 型名を正規化して文字列リテラルとして返す（evalStringFunc で判定）
    const normalized = normalizeCastType(typeName);
    if (normalized === null) {
      throw new ParseError(
        `不明なキャスト型「${typeName}」。TEXT または NUMBER を指定してください`,
        tok
      );
    }
    return { type: "STRING", value: normalized };
  }

  /** 文字列関数の引数: 文字列リテラル / ネスト文字列関数 / 算術式 / 集計算術式 */
  private parseStringFuncArg(): StringFuncArg {
    const tok = this.peek();
    if (tok.kind === TokenKind.STRING) {
      this.advance();
      return { type: "STRING", value: tok.value };
    }
    if (this.tryStringFuncName() !== null) {
      return this.parseStringFuncExpr();
    }
    // 関数引数内では、集計式（例: SUM(金額), 100+SUM(金額)）を優先的に試す。
    // ただし集計関数を含まない式は従来どおり算術式として扱う。
    const startPos = this.pos;
    try {
      const left = this.parseAggPrimary();
      const expr = this.continueAggArith(left);
      if (this.hasAggregateOperand(expr)) return expr;
    } catch {
      // fallback: 通常の算術式として解釈
    }
    this.pos = startPos;
    // 数値・フィールド参照・算術式 → ArithNode
    return this.parseArithAddSub();
  }

  private hasAggregateOperand(node: AggOperand): boolean {
    if (node.type === "AGG_REF") return true;
    if (node.type === "AGG_ARITH") {
      return this.hasAggregateOperand(node.left) || this.hasAggregateOperand(node.right);
    }
    return false;
  }

  private tryAggregateFunc(): AggregateFunc | null {
    const map: Partial<Record<TokenKind, AggregateFunc>> = {
      [TokenKind.COUNT]: "COUNT",
      [TokenKind.SUM]:   "SUM",
      [TokenKind.AVG]:   "AVG",
      [TokenKind.MAX]:   "MAX",
      [TokenKind.MIN]:   "MIN",
      [TokenKind.GROUP_CONCAT]: "GROUP_CONCAT",
    };
    const kind = this.peek().kind;
    return map[kind] ?? null;
  }

  /** 集計関数参照を読む。SELECT 列の alias は呼び出し側で式全体の後に処理する。 */
  private parseAggregateRef(func: AggregateFunc): AggregateRef {
    this.advance(); // 関数名トークンを消費
    this.expect(TokenKind.LPAREN);

    const distinct = this.consume(TokenKind.DISTINCT);

    let arg: AggregateColumn["arg"];
    if (this.consume(TokenKind.STAR)) {
      if (func === "GROUP_CONCAT") {
        throw new ParseError("GROUP_CONCAT(*) は使用できません。フィールドまたは式を指定してください", this.prev());
      }
      arg = { type: "WILDCARD" };
    } else {
      arg = this.parseArithAddSub(); // フィールド名・算術式・関数呼び出し
    }

    let separator: string | undefined;
    if (this.isSoftKeyword("SEPARATOR")) {
      const separatorToken = this.advance();
      if (func !== "GROUP_CONCAT") {
        throw new ParseError("SEPARATOR は GROUP_CONCAT でのみ使用できます", separatorToken);
      }
      separator = this.expect(TokenKind.STRING, "SEPARATOR の後には文字列リテラルが必要です").value;
    }

    this.expect(TokenKind.RPAREN);
    return {
      type: "AGG_REF",
      func,
      distinct,
      arg,
      ...(separator !== undefined ? { separator } : {}),
    };
  }

  // ----------------------------------------------------------
  // FROM / JOIN
  // ----------------------------------------------------------

  private parseTableRef(): TableRef {
    const nameTok = this.peek();
    const name = this.parseTableName();
    // 一時テーブル参照（#name）: CTE と同じ機構（FULL_SCAN 注入）で実行される
    //（temp マーカーは IDENT のみ。バッククォートの `#x` は通常識別子として後段へ）
    if (nameTok.kind === TokenKind.IDENT && name.startsWith("#")) {
      this.tempTableRefs.push(this.prev());
      const alias = this.consume(TokenKind.AS) ? this.parseTableAliasName() : this.tryParseImplicitAlias();
      return { appId: 0, alias, cteName: name };
    }
    // CTE 参照（WITH 句で定義された名前）
    if (this.cteNames.has(name)) {
      const alias = this.consume(TokenKind.AS) ? this.parseTableAliasName() : this.tryParseImplicitAlias();
      return { appId: 0, alias, cteName: name };
    }
    const { appId, subtableCode } = extractTableRef(name, this.prev());
    if (subtableCode) {
      const alias = this.consume(TokenKind.AS) ? this.parseTableAliasName() : this.tryParseImplicitAlias();
      return { appId, alias, cteName: null, subtableCode };
    }
    // `AS alias` のほか、`FROM APP100 a` 形式も許可する。
    // 省略時はテーブル名をデフォルトエイリアスとする。
    const implicit = this.tryParseImplicitAlias();
    const alias = this.consume(TokenKind.AS) ? this.parseTableAliasName() : (implicit ?? name);
    return { appId, alias, cteName: null };
  }

  // テーブル alias 名を読む（IDENT / BIDENT）。alias 位置の # は BIDENT でも拒否
  private parseTableAliasName(): string {
    const tok = this.peek();
    if (
      (tok.kind === TokenKind.IDENT || tok.kind === TokenKind.BIDENT) &&
      tok.value.startsWith("#")
    ) {
      throw new ParseError("エイリアス名に # で始まる名前は使用できません", tok);
    }
    return this.parseIdentifier();
  }

  private tryParseImplicitAlias(): string | null {
    const k = this.peek().kind;
    if (k === TokenKind.IDENT || k === TokenKind.BIDENT) {
      if (
        k === TokenKind.IDENT &&
        this.peek().value.toUpperCase() === "VALIDATE" &&
        this.peekAt(1).kind === TokenKind.IDENT &&
        this.peekAt(1).value.toUpperCase() === "ONLY"
      ) return null;
      return this.parseTableAliasName();
    }
    return null;
  }

  private parseJoins(): JoinClause[] {
    const joins: JoinClause[] = [];
    while (true) {
      const joinType = this.tryJoinType();
      if (joinType === null) break;

      const table = this.parseTableRef();
      this.expect(TokenKind.ON);
      const on = this.parseJoinCondition();
      joins.push({ type: joinType, table, on });
    }
    return joins;
  }

  private tryJoinType(): JoinType | null {
    if (this.consume(TokenKind.INNER)) {
      this.expect(TokenKind.JOIN);
      return "INNER";
    }
    if (this.consume(TokenKind.LEFT)) {
      this.expect(TokenKind.JOIN);
      return "LEFT";
    }
    if (this.consume(TokenKind.RIGHT)) {
      this.expect(TokenKind.JOIN);
      return "RIGHT";
    }
    if (this.consume(TokenKind.JOIN)) {
      return "INNER"; // JOIN 単体は INNER 扱い
    }
    return null;
  }

  // ON a.field = b.field
  private parseJoinCondition(): JoinCondition {
    const left = this.parseQualifiedIdent();
    this.expect(TokenKind.EQ);
    const right = this.parseQualifiedIdent();
    return { left, right };
  }

  // alias.field または field
  private parseQualifiedIdent(): QualifiedIdentifier {
    const first = this.parseIdentifier();
    if (this.consume(TokenKind.DOT)) {
      if (this.peek().kind === TokenKind.STAR) {
        throw new ParseError("ここでは * は指定できません", this.peek());
      }
      const field = this.parseIdentifier();
      return { tableAlias: first, field };
    }
    return { tableAlias: null, field: first };
  }

  // ----------------------------------------------------------
  // WHERE 式（再帰下降・優先順位付き）
  // ----------------------------------------------------------

  private parseWhereExpr(): WhereExpr {
    return this.parseOrExpr();
  }

  // OR（最低優先度）
  private parseOrExpr(): WhereExpr {
    let left = this.parseAndExpr();
    while (this.consume(TokenKind.OR)) {
      const right = this.parseAndExpr();
      left = { type: "LOGICAL", op: "OR", left, right } satisfies LogicalExpr;
    }
    return left;
  }

  // AND
  private parseAndExpr(): WhereExpr {
    let left = this.parseNotExpr();
    while (this.consume(TokenKind.AND)) {
      const right = this.parseNotExpr();
      left = { type: "LOGICAL", op: "AND", left, right } satisfies LogicalExpr;
    }
    return left;
  }

  // NOT / EXISTS / NOT EXISTS
  private parseNotExpr(): WhereExpr {
    // EXISTS (SELECT ...)
    if (this.consume(TokenKind.EXISTS)) {
      this.expect(TokenKind.LPAREN);
      const query = this.parseSelect();
      this.expect(TokenKind.RPAREN);
      return { type: "EXISTS", not: false, query } satisfies ExistsExpr;
    }
    if (this.consume(TokenKind.NOT)) {
      // NOT EXISTS (SELECT ...)
      if (this.consume(TokenKind.EXISTS)) {
        this.expect(TokenKind.LPAREN);
        const query = this.parseSelect();
        this.expect(TokenKind.RPAREN);
        return { type: "EXISTS", not: true, query } satisfies ExistsExpr;
      }
      const expr = this.parseNotExpr();
      return { type: "NOT", expr } satisfies NotExpr;
    }
    return this.parseCompareExpr();
  }

  /**
   * 現在位置が LPAREN のとき、その括弧が算術式の括弧かどうかを判定する。
   * 対応する RPAREN の直後のトークンが算術演算子なら算術括弧、そうでなければ GROUP。
   * 例: (単価 + 送料) * 数量 → true
   *     (ステータス = '完了' OR ...) → false
   */
  private isArithParen(): boolean {
    let depth = 0;
    let i = this.pos;
    while (i < this.tokens.length) {
      const k = this.tokens[i].kind;
      if (k === TokenKind.LPAREN) depth++;
      else if (k === TokenKind.RPAREN) {
        depth--;
        if (depth === 0) {
          const next = this.tokens[i + 1]?.kind;
          return (
            next === TokenKind.STAR  ||
            next === TokenKind.SLASH ||
            next === TokenKind.PLUS  ||
            next === TokenKind.MINUS
          );
        }
      }
      i++;
    }
    return false;
  }

  // 比較演算子: =, !=, <>, >, <, >=, <=, LIKE, KLIKE, IN, IS NULL
  private parseCompareExpr(): WhereExpr {
    // ( expr ) グループ — ただし算術括弧（例: (単価 + 送料) * 数量）は除く
    if (this.peek().kind === TokenKind.LPAREN && !this.isArithParen()) {
      this.advance();
      const expr = this.parseWhereExpr();
      this.expect(TokenKind.RPAREN);
      return { type: "GROUP", expr } satisfies GroupExpr;
    }

    const field = this.parseFieldValue();

    // IS NULL / IS NOT NULL
    if (this.consume(TokenKind.IS)) {
      const not = this.consume(TokenKind.NOT);
      this.expect(TokenKind.NULL);
      return { type: "NULL_CHECK", field, not } satisfies NullCheckExpr;
    }

    // BETWEEN low AND high → field >= low AND field <= high に展開
    if (this.consume(TokenKind.BETWEEN)) {
      const low  = this.parseSqlValue();
      this.expect(TokenKind.AND);
      const high = this.parseSqlValue();
      return {
        type: "LOGICAL",
        op: "AND",
        left:  { type: "BINARY", op: ">=", left: field, right: low  },
        right: { type: "BINARY", op: "<=", left: field, right: high },
      } satisfies ExpandedBetween;
    }

    // NOT IN / NOT LIKE / NOT KLIKE
    if (this.consume(TokenKind.NOT)) {
      if (this.consume(TokenKind.IN)) {
        this.expect(TokenKind.LPAREN);
        const right = this.parseInListOrSubquery();
        this.expect(TokenKind.RPAREN);
        return { type: "BINARY", op: "NOT_IN", left: field, right } satisfies BinaryExpr;
      }
      if (this.consume(TokenKind.LIKE)) {
        const pattern = this.parseSqlValue();
        return { type: "BINARY", op: "NOT_LIKE", left: field, right: pattern } satisfies BinaryExpr;
      }
      if (this.consume(TokenKind.KLIKE)) {
        const pattern = this.parseKlikePattern();
        return { type: "BINARY", op: "NOT_KLIKE", left: field, right: pattern } satisfies BinaryExpr;
      }
      throw new ParseError(
        "NOT の後には IN、LIKE、KLIKE のいずれかが必要です",
        this.peek()
      );
    }

    // IN (...)
    if (this.consume(TokenKind.IN)) {
      this.expect(TokenKind.LPAREN);
      const right = this.parseInListOrSubquery();
      this.expect(TokenKind.RPAREN);
      return { type: "BINARY", op: "IN", left: field, right } satisfies BinaryExpr;
    }

    // KLIKE は kintone キーワード検索。右辺は文字列またはバッチ変数だけ。
    if (this.consume(TokenKind.KLIKE)) {
      const pattern = this.parseKlikePattern();
      return { type: "BINARY", op: "KLIKE", left: field, right: pattern } satisfies BinaryExpr;
    }

    // 比較演算子
    const op = this.parseCompareOp();
    const right = this.parseSqlValue();
    return { type: "BINARY", op, left: field, right } satisfies BinaryExpr;
  }

  private parseCompareOp(): CompareOp {
    const tok = this.advance();
    switch (tok.kind) {
      case TokenKind.EQ:    return "=";
      case TokenKind.NEQ:   return "!=";
      case TokenKind.LT_GT: return "<>";
      case TokenKind.GT:    return ">";
      case TokenKind.LT:    return "<";
      case TokenKind.GTE:   return ">=";
      case TokenKind.LTE:   return "<=";
      case TokenKind.LIKE:  return "LIKE";
      default:
        throw new ParseError(
          "比較演算子（=, !=, >, <, >=, <=, LIKE, KLIKE, IN, IS）が必要です",
          tok
        );
    }
  }

  /** KLIKE / NOT KLIKE の右辺。kintone キーワードは文字列値だけを受け付ける。 */
  private parseKlikePattern(): StringLiteral | VariableRef {
    const tok = this.peek();
    if (tok.kind === TokenKind.STRING) {
      this.advance();
      return { type: "STRING", value: tok.value } satisfies StringLiteral;
    }
    if (tok.kind === TokenKind.VARIABLE) {
      this.advance();
      return { type: "VARIABLE", name: tok.value.slice(1).toLowerCase() } satisfies VariableRef;
    }
    throw new ParseError(
      "KLIKE / NOT KLIKE の右辺には文字列リテラルまたはバッチ変数が必要です",
      tok
    );
  }

  // WHERE / HAVING の左辺
  // - 文字列・数値関数: UPPER(f) / LENGTH(f) / ROUND(f, 2) ...
  // - 集計関数（HAVING のみ）: COUNT(*) / SUM(f) ...
  // - 通常フィールド参照: [alias.]field
  private parseFieldValue(): FieldValue {
    // 文字列・数値関数: UPPER(f) / LENGTH(f) / ROUND(f,2) / ...
    if (this.tryStringFuncName() !== null) {
      const expr = this.parseStringFuncExpr();
      // 関数の後に算術演算子が続く場合 → ArithFieldValue（例: LENGTH(備考) * 2 > 10）
      if (this.isArithOp(this.peek().kind)) {
        return { type: "ARITH_FIELD", expr: this.continueArith(expr) } satisfies ArithFieldValue;
      }
      return { type: "FUNC_FIELD", expr } satisfies FuncFieldValue;
    }

    // 集計関数（HAVING のみ）
    const aggFunc = this.tryAggregateFunc();
    if (aggFunc !== null) {
      this.advance(); // 関数名トークンを消費
      this.expect(TokenKind.LPAREN);
      const distinct = this.consume(TokenKind.DISTINCT);
      let argStr: string;
      if (this.consume(TokenKind.STAR)) {
        if (aggFunc === "GROUP_CONCAT") {
          throw new ParseError("GROUP_CONCAT(*) は使用できません。フィールドまたは式を指定してください", this.prev());
        }
        argStr = "*";
      } else {
        argStr = this.parseIdentifier();
      }
      if (this.isSoftKeyword("SEPARATOR")) {
        const separatorToken = this.advance();
        if (aggFunc !== "GROUP_CONCAT") {
          throw new ParseError("SEPARATOR は GROUP_CONCAT でのみ使用できます", separatorToken);
        }
        this.expect(TokenKind.STRING, "SEPARATOR の後には文字列リテラルが必要です");
      }
      this.expect(TokenKind.RPAREN);
      const syntheticName = distinct
        ? `${aggFunc}(DISTINCT ${argStr})`
        : `${aggFunc}(${argStr})`;
      return { type: "FIELD", tableAlias: null, field: syntheticName };
    }

    // CASE WHEN ... END: CASE WHEN 式を左辺として使う
    if (this.peek().kind === TokenKind.CASE) {
      const expr = this.parseCaseWhenExpr();
      return { type: "CASE_FIELD", expr } satisfies CaseFieldValue;
    }

    // IF(cond, then, else) → CASE WHEN として処理
    if (this.peek().kind === TokenKind.IF) {
      const expr = this.parseIfExpr();
      return { type: "CASE_FIELD", expr } satisfies CaseFieldValue;
    }

    // 括弧 → 算術式として処理（例: (金額 + 消費税) * 1.1 > 5000）
    if (this.peek().kind === TokenKind.LPAREN) {
      this.advance(); // ( を消費
      const inner = this.parseArithAddSub();
      this.expect(TokenKind.RPAREN);
      const expr = this.continueArith(inner);
      return { type: "ARITH_FIELD", expr } satisfies ArithFieldValue;
    }

    // 単項マイナス → 算術式として処理
    if (this.peek().kind === TokenKind.MINUS) {
      return { type: "ARITH_FIELD", expr: this.parseArithAddSub() } satisfies ArithFieldValue;
    }

    // 通常のフィールド参照（修飾識別子含む）
    const qi = this.parseQualifiedIdent();
    // 算術演算子が続く場合 → ArithFieldValue（例: 金額 * 1.1 > 10000）
    if (this.isArithOp(this.peek().kind)) {
      const baseField = qi.tableAlias ? `${qi.tableAlias}.${qi.field}` : qi.field;
      const left: ArithNode = { type: "FIELD_REF", field: baseField };
      return { type: "ARITH_FIELD", expr: this.continueArith(left) } satisfies ArithFieldValue;
    }
    return { type: "FIELD", tableAlias: qi.tableAlias, field: qi.field };
  }

  // 右辺の値
  private parseSqlValue(): SqlValue {
    const tok = this.peek();

    if (tok.kind === TokenKind.VARIABLE) {
      this.advance();
      return { type: "VARIABLE", name: tok.value.slice(1).toLowerCase() } satisfies VariableRef;
    }

    // 文字列リテラル
    if (tok.kind === TokenKind.STRING) {
      this.advance();
      return { type: "STRING", value: tok.value } satisfies StringLiteral;
    }

    // kintone 専用関数
    if (
      tok.kind === TokenKind.TODAY ||
      tok.kind === TokenKind.NOW ||
      tok.kind === TokenKind.LOGINUSER
    ) {
      this.advance();
      this.expect(TokenKind.LPAREN);
      this.expect(TokenKind.RPAREN);
      return {
        type: "KINTONE_FUNC",
        name: tok.value as KintoneFunction["name"],
      } satisfies KintoneFunction;
    }

    // CASE WHEN ... END を右辺として使う
    if (tok.kind === TokenKind.CASE) {
      const expr = this.parseCaseWhenExpr();
      return { type: "CASE_VALUE", expr } satisfies CaseSqlValue;
    }

    // IF(cond, then, else) → CASE WHEN として右辺に使う
    if (tok.kind === TokenKind.IF) {
      const expr = this.parseIfExpr();
      return { type: "CASE_VALUE", expr } satisfies CaseSqlValue;
    }

    // スカラーサブクエリ: (SELECT ...)
    if (tok.kind === TokenKind.LPAREN && this.peekAt(1).kind === TokenKind.SELECT) {
      this.advance(); // ( を消費
      const query = this.parseSelect();
      this.expect(TokenKind.RPAREN);
      if (this.isArithOp(this.peek().kind)) {
        throw new ParseError(
          "スカラーサブクエリの後に算術演算子は使用できません。サブクエリ内で計算してください（例: (SELECT AVG(合計費用)/2 FROM APP88)）",
          this.peek()
        );
      }
      return { type: "SCALAR_SUBQUERY", query };
    }

    // 算術式（数値・フィールド参照・文字列関数・括弧・単項マイナス）
    // 例: 1000 / 金額 * 1.1 / (単価 * 数量) / LENGTH(備考) / -5
    if (
      tok.kind === TokenKind.NUMBER ||
      tok.kind === TokenKind.IDENT ||
      tok.kind === TokenKind.BIDENT ||
      tok.kind === TokenKind.LPAREN ||
      tok.kind === TokenKind.MINUS ||
      this.tryStringFuncName() !== null
    ) {
      const expr = this.parseArithAddSub();
      // 単純な数値リテラルはそのまま NumberLiteral に
      if (expr.type === "NUMBER") return { type: "NUMBER", value: expr.value } satisfies NumberLiteral;
      return { type: "ARITH_VALUE", expr } satisfies ArithSqlValue;
    }

    throw new ParseError(
      "値（文字列・数値・フィールド参照・TODAY()・NOW()・LOGINUSER()）が必要です",
      tok
    );
  }

  // IN (...) — 値リストまたはサブクエリ
  private parseInListOrSubquery(): InList | SubqueryInList {
    // IN (SELECT ...) → サブクエリ
    if (this.peek().kind === TokenKind.SELECT) {
      const query = this.parseSelect();
      // サブクエリの最初の列名を取得（column = null の場合は実行時に rows[0] の最初のキーを使う）
      const firstCol = query.columns[0];
      const column = (firstCol && firstCol.type === "FIELD")
        ? (firstCol.alias ?? firstCol.field)
        : null;
      return { type: "SUBQUERY_IN_LIST", query, column };
    }
    // IN (v1, v2, ...)
    return { type: "IN_LIST", values: this.parseInValues() };
  }

  // IN リストの値
  private parseInValues(): InList["values"] {
    const values: InList["values"] = [];
    const invalidValueMessage = "IN リストには文字列、数値、またはバッチ変数が必要です";
    do {
      const tok = this.advance();
      if (tok.kind === TokenKind.STRING) {
        values.push({ type: "STRING", value: tok.value });
      } else if (tok.kind === TokenKind.NUMBER) {
        values.push({ type: "NUMBER", value: Number(tok.value) });
      } else if (tok.kind === TokenKind.MINUS || tok.kind === TokenKind.PLUS) {
        const number = this.peek();
        if (number.kind !== TokenKind.NUMBER) {
          throw new ParseError(invalidValueMessage, tok);
        }
        this.advance();
        const sign = tok.kind === TokenKind.MINUS ? -1 : 1;
        values.push({ type: "NUMBER", value: sign * Number(number.value) });
      } else if (tok.kind === TokenKind.VARIABLE) {
        values.push({ type: "VARIABLE", name: tok.value.slice(1).toLowerCase() });
      } else {
        throw new ParseError(invalidValueMessage, tok);
      }
    } while (this.consume(TokenKind.COMMA));
    return values;
  }

  // ----------------------------------------------------------
  // GROUP BY / ORDER BY
  // ----------------------------------------------------------

  private parseIdentList(): string[] {
    const idents: string[] = [];
    do {
      idents.push(this.parseIdentifier());
    } while (this.consume(TokenKind.COMMA));
    return idents;
  }

  private parseGroupByKeys(): GroupByKey[] {
    const keys: GroupByKey[] = [];
    do {
      keys.push(this.parseGroupByKey());
    } while (this.consume(TokenKind.COMMA));
    return keys;
  }

  /**
   * GROUP BY のキーを解析する。ORDER BY と同じ文法（方向指定なし）。
   *   関数:              SUBSTRING(作成日時, 1, 7) / ROUND(金額, -4)
   *   算術式（( や数値): (単価 + 税額) * 数量
   *   フィールド + 算術: 金額 * 1.1
   *   フィールド名:       部署 / 担当者
   */
  private parseGroupByKey(): GroupByKey {
    if (this.tryStringFuncName() !== null) {
      const funcExpr = this.parseStringFuncExpr();
      if (this.isArithOp(this.peek().kind)) {
        return { type: "ARITH_KEY", expr: this.continueArith(funcExpr) };
      }
      return { type: "FUNC_KEY", expr: funcExpr };
    }
    if (
      this.peek().kind === TokenKind.LPAREN ||
      this.peek().kind === TokenKind.NUMBER
    ) {
      return { type: "ARITH_KEY", expr: this.parseArithAddSub() };
    }
    const name = this.parseFieldPath();
    if (this.isArithOp(this.peek().kind)) {
      const left: ArithNode = { type: "FIELD_REF", field: name };
      return { type: "ARITH_KEY", expr: this.continueArith(left) };
    }
    return { type: "FIELD_NAME", name };
  }

  private parseOrderBy(): OrderByItem[] {
    const items: OrderByItem[] = [];
    do {
      const key = this.parseOrderByKey();
      let direction: "ASC" | "DESC" = "ASC";
      if (this.consume(TokenKind.DESC))  direction = "DESC";
      else this.consume(TokenKind.ASC); // ASC は省略可
      items.push({ key, direction });
    } while (this.consume(TokenKind.COMMA));
    return items;
  }

  /**
   * ORDER BY のソートキーを解析する。
   *   関数:              UPPER(名前) / LENGTH(名前) / ROUND(金額, -3)
   *   算術式（( や数値): (金額 + 税額) / 1000
   *   フィールド + 算術: 金額 * 1.1
   *   フィールド名/alias: 名前 / total
   */
  private parseOrderByKey(): OrderByKey {
    // 文字列・数値関数
    if (this.tryStringFuncName() !== null) {
      const funcExpr = this.parseStringFuncExpr();
      if (this.isArithOp(this.peek().kind)) {
        return { type: "ARITH_KEY", expr: this.continueArith(funcExpr) };
      }
      return { type: "FUNC_KEY", expr: funcExpr };
    }
    // 括弧または数値で始まる算術式
    if (
      this.peek().kind === TokenKind.LPAREN ||
      this.peek().kind === TokenKind.NUMBER
    ) {
      return { type: "ARITH_KEY", expr: this.parseArithAddSub() };
    }
    // フィールド名（続いて算術演算子があれば算術式として処理）
    const name = this.parseFieldPath();
    if (this.isArithOp(this.peek().kind)) {
      const left: ArithNode = { type: "FIELD_REF", field: name };
      return { type: "ARITH_KEY", expr: this.continueArith(left) };
    }
    return { type: "FIELD_NAME", name };
  }

  // ----------------------------------------------------------
  // INSERT
  // ----------------------------------------------------------

  private parseInsert(): InsertStatement | InsertSelectStatement {
    this.expect(TokenKind.INSERT);
    this.expect(TokenKind.INTO);

    this.rejectTempTableDml();
    const name = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(name, this.prev());

    this.expect(TokenKind.LPAREN);
    const fields = this.parseIdentList();
    this.expect(TokenKind.RPAREN);

    // INSERT INTO ... SELECT ...
    if (this.peek().kind === TokenKind.SELECT) {
      const select = this.parseSelect();
      if (subtableCode) {
        throw new ParseError("INSERT INTO ... SELECT はサブテーブル仮想テーブルでは未対応です", this.prev());
      }
      const validation = this.parseDmlControlSuffix();
      return { type: "INSERT_SELECT", appId, fields, select, ...validation } satisfies InsertSelectStatement;
    }

    // INSERT INTO ... VALUES (...)
    this.expect(TokenKind.VALUES);

    const values: InsertRow[] = [];
    do {
      this.expect(TokenKind.LPAREN);
      const row = this.parseInsertRow(fields.length);
      this.expect(TokenKind.RPAREN);
      values.push(row);
    } while (this.consume(TokenKind.COMMA));

    const validation = this.parseDmlControlSuffix();
    if (subtableCode && (validation.validateOnly || validation.onErrorSkip)) {
      throw new ParseError("VALIDATE ONLY / ON ERROR SKIP はサブテーブル INSERT に対応していません", this.prev());
    }
    return subtableCode
      ? { type: "INSERT", appId, subtableCode, fields, values, ...validation }
      : { type: "INSERT", appId, fields, values, ...validation };
  }

  private parseUpsert(): UpsertStatement | UpsertSelectStatement {
    this.expect(TokenKind.UPSERT);
    this.expect(TokenKind.INTO);

    this.rejectTempTableDml();
    const name = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(name, this.prev());
    if (subtableCode) {
      throw new ParseError("UPSERT はまだサブテーブル仮想テーブルに対応していません", this.prev());
    }

    this.expect(TokenKind.LPAREN);
    const fields = this.parseIdentList();
    this.expect(TokenKind.RPAREN);

    // UPSERT INTO ... SELECT ...
    if (this.peek().kind === TokenKind.SELECT) {
      const select = this.parseSelect();
      const keyFields = this.parseOnDuplicate();
      const validation = this.parseDmlControlSuffix();
      return { type: "UPSERT_SELECT", appId, fields, select, keyFields, ...validation };
    }

    // UPSERT INTO ... VALUES (...)
    this.expect(TokenKind.VALUES);

    const values: UpsertStatement["values"] = [];
    do {
      this.expect(TokenKind.LPAREN);
      values.push(this.parseInsertRow(fields.length));
      this.expect(TokenKind.RPAREN);
    } while (this.consume(TokenKind.COMMA));

    const keyFields = this.parseOnDuplicate();
    const validation = this.parseDmlControlSuffix();
    return { type: "UPSERT", appId, fields, values, keyFields, ...validation };
  }

  private parseOnDuplicate(): string[] {
    this.expectKeyword(TokenKind.ON, "UPSERT には ON DUPLICATE (キーフィールド) が必要です");
    if (!this.consume(TokenKind.DUPLICATE)) {
      throw new ParseError("ON の後には DUPLICATE が必要です", this.peek());
    }
    this.expect(TokenKind.LPAREN);
    const keyFields = this.parseIdentList();
    this.expect(TokenKind.RPAREN);
    if (keyFields.length === 0) {
      throw new ParseError("ON DUPLICATE にはキーフィールドが最低 1 つ必要です", this.prev());
    }
    return keyFields;
  }

  /** 配列リテラル ['val1', 'val2'] を解析して ArrayLiteral を返す */
  private parseArrayLiteral(): ArrayLiteral {
    this.expect(TokenKind.LBRACKET);
    const elements: ArrayLiteral["elements"] = [];
    if (this.peek().kind !== TokenKind.RBRACKET) {
      do {
        const tok = this.expect(TokenKind.STRING);
        elements.push({ type: "STRING", value: tok.value });
      } while (this.consume(TokenKind.COMMA));
    }
    this.expect(TokenKind.RBRACKET);
    return { type: "ARRAY", elements };
  }

  private parseInsertRow(expectedLen: number): InsertRow {
    const row: InsertRow = [];
    do {
      if (this.peek().kind === TokenKind.LBRACKET) {
        row.push(this.parseArrayLiteral());
      } else if (this.peek().kind === TokenKind.CASE) {
        // CASE WHEN ... END → CaseSqlValue
        const expr = this.parseCaseWhenExpr();
        row.push({ type: "CASE_VALUE", expr });
      } else if (this.peek().kind === TokenKind.IF) {
        // IF(cond, then, else) → CaseSqlValue
        const expr = this.parseIfExpr();
        row.push({ type: "CASE_VALUE", expr });
      } else if (this.peek().kind === TokenKind.MINUS || this.peek().kind === TokenKind.PLUS) {
        const sign = this.advance();
        const number = this.expect(TokenKind.NUMBER, "INSERT の単項符号の直後には数値リテラルが必要です");
        const value = Number(number.value);
        row.push({ type: "NUMBER", value: sign.kind === TokenKind.MINUS ? -value : value });
      } else {
        const tok = this.advance();
        if (tok.kind === TokenKind.STRING) {
          row.push({ type: "STRING", value: tok.value });
        } else if (tok.kind === TokenKind.NUMBER) {
          row.push({ type: "NUMBER", value: Number(tok.value) });
        } else {
          throw new ParseError("INSERT の値には文字列・数値・配列リテラル・CASE WHEN が必要です", tok);
        }
      }
    } while (this.consume(TokenKind.COMMA));

    if (row.length !== expectedLen) {
      throw new ParseError(
        `カラム数（${expectedLen}）と値の数（${row.length}）が一致しません`,
        this.prev()
      );
    }
    return row;
  }

  // ----------------------------------------------------------
  // UPDATE
  // ----------------------------------------------------------

  private parseUpdate(): UpdateStatement {
    this.expect(TokenKind.UPDATE);

    this.rejectTempTableDml();
    const name = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(name, this.prev());

    this.expect(TokenKind.SET);
    const assignments = this.parseAssignments();

    if (subtableCode && assignments.some((a) => a.value.type === "STRING_FUNC")) {
      throw new ParseError(
        "サブテーブル UPDATE SET では文字列関数を直接使用できません",
        this.prev()
      );
    }

    let from: UpdateStatement["from"] = null;
    if (this.consume(TokenKind.FROM)) {
      const table = this.parseTableRef();
      if (table.subtableCode) {
        throw new ParseError("UPDATE ... FROM のソースにサブテーブルは指定できません", this.prev());
      }
      if (table.cteName !== null && !table.cteName.startsWith("#")) {
        throw new ParseError("UPDATE ... FROM のソースは #temp または APP<n> を指定してください（CTE は非対応）", this.prev());
      }
      if (!table.alias) {
        throw new ParseError("UPDATE ... FROM のソースにはエイリアスが必要です", this.prev());
      }
      if (table.alias.toLowerCase() === `app${appId}`.toLowerCase()) {
        throw new ParseError(`UPDATE ... FROM のソース alias は更新先 APP${appId} と同名にできません`, this.prev());
      }
      from = {
        appId: table.appId,
        cteName: table.cteName,
        alias: table.alias,
        targetJoinField: "",
        joinKeyField: "",
        targetFilter: null,
      };
    }

    const whereTok = this.peek();
    if (!this.consume(TokenKind.WHERE)) {
      throw new ParseError(
        "UPDATE 文には WHERE 句が必要です（全件更新を防ぐため）",
        whereTok
      );
    }
    const where = this.parseWhereExpr();

    if (from !== null) {
      if (subtableCode) {
        throw new ParseError("サブテーブル UPDATE ... FROM はサポートしていません", whereTok);
      }
      this.validateUpdateFromAssignments(assignments, from.alias, whereTok);
      const decomposed = this.decomposeUpdateFromWhere(where, appId, from.alias, whereTok);
      from.targetJoinField = decomposed.targetJoinField;
      from.joinKeyField = decomposed.joinKeyField;
      from.targetFilter = decomposed.targetFilter;
    } else if (assignments.some((a) => a.value.type === "SOURCE_FIELD")) {
      throw new ParseError(
        "SET の値にフィールド参照を単独で指定することはできません",
        whereTok
      );
    } else if (assignments.some(
      (a) => a.value.type === "STRING_FUNC" && this.nodeContainsAnyQualifier(a.value)
    )) {
      throw new ParseError(
        "UPDATE SET の文字列関数では更新先フィールドを修飾しないでください",
        whereTok
      );
    }

    const validation = this.parseDmlControlSuffix();
    if (subtableCode && (validation.validateOnly || validation.onErrorSkip)) {
      throw new ParseError("VALIDATE ONLY / ON ERROR SKIP はサブテーブル UPDATE に対応していません", this.prev());
    }
    if (from !== null) return { type: "UPDATE", appId, assignments, where, from, ...validation };
    return subtableCode
      ? { type: "UPDATE", appId, subtableCode, assignments, where, ...validation }
      : { type: "UPDATE", appId, assignments, where, ...validation };
  }

  /** DML末尾の VALIDATE ONLY または ON ERROR SKIP。各語はsoft keyword。 */
  private parseDmlControlSuffix(): {
    validateOnly?: true;
    validationErrorTable?: string | null;
    onErrorSkip?: true;
    errorTable?: string;
    rejectLimit?: number | null;
  } {
    if (this.peek().kind === TokenKind.ON) return this.parseOnErrorSkipSuffix();
    if (this.isSoftKeyword("REJECT")) {
      throw new ParseError("REJECT LIMIT には ON ERROR SKIP INTO が必要です", this.peek());
    }
    if (!this.isSoftKeyword("VALIDATE")) return {};
    const validateTok = this.advance();
    if (!this.isSoftKeyword("ONLY")) {
      throw new ParseError("VALIDATE の後には ONLY が必要です", this.peek());
    }
    this.advance();
    let validationErrorTable: string | null = null;
    if (this.consume(TokenKind.INTO)) {
      const tok = this.peek();
      if (tok.kind !== TokenKind.IDENT || !tok.value.startsWith("#")) {
        throw new ParseError("VALIDATE ONLY INTO には # で始まる一時テーブル名が必要です", tok);
      }
      validationErrorTable = this.parseTableName();
    }
    if (this.peek().kind === TokenKind.ON || this.isSoftKeyword("REJECT")) {
      throw new ParseError("VALIDATE ONLY と ON ERROR / REJECT LIMIT は併記できません", validateTok);
    }
    return { validateOnly: true, validationErrorTable };
  }

  private parseOnErrorSkipSuffix(): { onErrorSkip: true; errorTable: string; rejectLimit: number | null } {
    const onTok = this.advance();
    if (!this.isSoftKeyword("ERROR")) throw new ParseError("ON の後には ERROR が必要です", this.peek());
    this.advance();
    if (!this.isSoftKeyword("SKIP")) throw new ParseError("ON ERROR の後には SKIP が必要です", this.peek());
    this.advance();
    this.expect(TokenKind.INTO, "ON ERROR SKIP には INTO #一時テーブル が必要です");
    const tableTok = this.peek();
    if (tableTok.kind !== TokenKind.IDENT || !tableTok.value.startsWith("#")) {
      throw new ParseError("ON ERROR SKIP INTO には # で始まる一時テーブル名が必要です", tableTok);
    }
    const errorTable = this.parseTableName();
    let rejectLimit: number | null = null;
    if (this.isSoftKeyword("REJECT")) {
      this.advance();
      this.expect(TokenKind.LIMIT, "REJECT の後には LIMIT が必要です");
      const tok = this.expect(TokenKind.NUMBER, "REJECT LIMIT には 0 以上の整数が必要です");
      if (!/^\d+$/.test(tok.value)) throw new ParseError("REJECT LIMIT は 0 以上の安全な整数で指定してください", tok);
      rejectLimit = Number(tok.value);
      if (!Number.isSafeInteger(rejectLimit)) throw new ParseError("REJECT LIMIT は 0 以上の安全な整数で指定してください", tok);
    }
    if (this.isSoftKeyword("REJECT") || this.isSoftKeyword("VALIDATE") || this.peek().kind === TokenKind.ON) {
      throw new ParseError("ON ERROR SKIP の句が重複または競合しています", onTok);
    }
    return { onErrorSkip: true, errorTable, rejectLimit };
  }

  private isSoftKeyword(value: string): boolean {
    return this.peek().kind === TokenKind.IDENT && this.peek().value.toUpperCase() === value;
  }

  private validateUpdateFromAssignments(
    assignments: Assignment[],
    sourceAlias: string,
    tok: Token
  ): void {
    for (const assignment of assignments) {
      if (assignment.value.type === "STRING_FUNC") {
        throw new ParseError(
          "UPDATE ... FROM の SET では文字列関数を直接使用できません",
          tok
        );
      }
      if (assignment.value.type === "SOURCE_FIELD") {
        if (assignment.value.alias.toLowerCase() !== sourceAlias.toLowerCase()) {
          throw new ParseError(`UPDATE ... FROM の SET 参照はソース alias ${sourceAlias} で修飾してください`, tok);
        }
        continue;
      }
      if (this.nodeContainsQualifiedField(assignment.value, sourceAlias)) {
        throw new ParseError("UPDATE ... FROM のソース列は SET の直接値としてのみ参照できます", tok);
      }
      if (assignment.value.type === "SCALAR_SUBQUERY") {
        throw new ParseError("UPDATE ... FROM の SET ではスカラーサブクエリを使用できません", tok);
      }
      if (this.nodeContainsAnyQualifier(assignment.value)) {
        throw new ParseError("UPDATE ... FROM のターゲット式ではフィールドを修飾しないでください", tok);
      }
    }
  }

  private decomposeUpdateFromWhere(
    where: WhereExpr,
    targetAppId: number,
    sourceAlias: string,
    tok: Token
  ): { targetJoinField: string; joinKeyField: string; targetFilter: WhereExpr | null } {
    const leaves = this.flattenTopLevelAnd(where);
    const joins: Array<{ index: number; targetField: string; sourceField: string }> = [];
    leaves.forEach((leaf, index) => {
      const matched = this.matchUpdateFromJoin(leaf, targetAppId, sourceAlias);
      if (matched !== null) joins.push({ index, ...matched });
    });
    if (joins.length !== 1) {
      throw new ParseError("UPDATE ... FROM の WHERE には target.key = source.key の結合等値がちょうど1つ必要です", tok);
    }
    const join = joins[0];
    for (let i = 0; i < leaves.length; i++) {
      if (i !== join.index && this.nodeContainsQualifiedField(leaves[i], sourceAlias)) {
        throw new ParseError("UPDATE ... FROM のソース alias は結合等値以外の WHERE 条件では参照できません", tok);
      }
      if (i !== join.index && this.nodeContainsForeignQualifier(leaves[i], targetAppId)) {
        throw new ParseError(`UPDATE ... FROM のターゲットフィルタは APP${targetAppId} のフィールドだけを参照できます`, tok);
      }
    }
    const filters = leaves.filter((_, index) => index !== join.index);
    const targetFilter = filters.reduce<WhereExpr | null>(
      (acc, expr) => acc === null ? expr : { type: "LOGICAL", op: "AND", left: acc, right: expr },
      null
    );
    return { targetJoinField: join.targetField, joinKeyField: join.sourceField, targetFilter };
  }

  private flattenTopLevelAnd(expr: WhereExpr): WhereExpr[] {
    if (expr.type === "GROUP") return this.flattenTopLevelAnd(expr.expr);
    if (expr.type === "LOGICAL" && expr.op === "AND") {
      return [...this.flattenTopLevelAnd(expr.left), ...this.flattenTopLevelAnd(expr.right)];
    }
    return [expr];
  }

  private matchUpdateFromJoin(
    expr: WhereExpr,
    targetAppId: number,
    sourceAlias: string
  ): { targetField: string; sourceField: string } | null {
    if (expr.type !== "BINARY" || expr.op !== "=" || expr.left.type !== "FIELD") return null;
    const right = expr.right.type === "ARITH_VALUE" && expr.right.expr.type === "FIELD_REF"
      ? this.splitQualifiedField(expr.right.expr.field)
      : null;
    if (right === null) return null;
    const left = { alias: expr.left.tableAlias, field: expr.left.field };
    if (this.isTargetRef(left, targetAppId) && this.isSourceRef(right, sourceAlias)) {
      return { targetField: left.field, sourceField: right.field };
    }
    if (this.isSourceRef(left, sourceAlias) && this.isTargetRef(right, targetAppId)) {
      return { targetField: right.field, sourceField: left.field };
    }
    return null;
  }

  private splitQualifiedField(field: string): { alias: string | null; field: string } {
    const dot = field.indexOf(".");
    return dot < 0 ? { alias: null, field } : { alias: field.slice(0, dot), field: field.slice(dot + 1) };
  }

  private isTargetRef(ref: { alias: string | null; field: string }, appId: number): boolean {
    return ref.alias === null || ref.alias.toLowerCase() === `app${appId}`.toLowerCase();
  }

  private isSourceRef(ref: { alias: string | null; field: string }, alias: string): boolean {
    return ref.alias?.toLowerCase() === alias.toLowerCase();
  }

  private nodeContainsQualifiedField(node: unknown, alias: string): boolean {
    if (Array.isArray(node)) return node.some((v) => this.nodeContainsQualifiedField(v, alias));
    if (node === null || typeof node !== "object") return false;
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "FIELD" && typeof obj["tableAlias"] === "string" && obj["tableAlias"].toLowerCase() === alias.toLowerCase()) return true;
    if (obj["type"] === "FIELD_REF" && typeof obj["field"] === "string") {
      const ref = this.splitQualifiedField(obj["field"]);
      if (this.isSourceRef(ref, alias)) return true;
    }
    return Object.values(obj).some((v) => this.nodeContainsQualifiedField(v, alias));
  }

  private nodeContainsForeignQualifier(node: unknown, targetAppId: number): boolean {
    if (Array.isArray(node)) return node.some((v) => this.nodeContainsForeignQualifier(v, targetAppId));
    if (node === null || typeof node !== "object") return false;
    const obj = node as Record<string, unknown>;
    const expected = `app${targetAppId}`.toLowerCase();
    if (obj["type"] === "FIELD" && typeof obj["tableAlias"] === "string") {
      return obj["tableAlias"].toLowerCase() !== expected;
    }
    if (obj["type"] === "FIELD_REF" && typeof obj["field"] === "string") {
      const ref = this.splitQualifiedField(obj["field"]);
      if (ref.alias !== null) return ref.alias.toLowerCase() !== expected;
    }
    return Object.values(obj).some((v) => this.nodeContainsForeignQualifier(v, targetAppId));
  }

  private nodeContainsAnyQualifier(node: unknown): boolean {
    if (Array.isArray(node)) return node.some((v) => this.nodeContainsAnyQualifier(v));
    if (node === null || typeof node !== "object") return false;
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "FIELD" && typeof obj["tableAlias"] === "string") return true;
    if (obj["type"] === "FIELD_REF" && typeof obj["field"] === "string") {
      if (this.splitQualifiedField(obj["field"]).alias !== null) return true;
    }
    return Object.values(obj).some((v) => this.nodeContainsAnyQualifier(v));
  }

  private parseAssignments(): Assignment[] {
    const assignments: Assignment[] = [];
    do {
      const field = this.parseIdentifier();
      this.expect(TokenKind.EQ);
      const value = this.parseAssignmentValue();
      assignments.push({ field, value });
    } while (this.consume(TokenKind.COMMA));
    return assignments;
  }

  /**
   * SET の右辺を解析する。
   * 文字列・kintone 関数はそのまま SqlValue として処理し、
   * 数値・フィールド参照・括弧が先頭なら算術式パーサーに渡す。
   */
  private parseAssignmentValue(): Assignment["value"] {
    const tok = this.peek();
    if (tok.kind === TokenKind.VARIABLE) return this.parseSqlValue();
    // 文字列リテラルは算術不可
    if (tok.kind === TokenKind.STRING) return this.parseSqlValue();
    // kintone 専用関数（TODAY / NOW / LOGINUSER）
    if (
      tok.kind === TokenKind.TODAY ||
      tok.kind === TokenKind.NOW   ||
      tok.kind === TokenKind.LOGINUSER
    ) return this.parseSqlValue();
    // IN_LIST は WHERE 専用
    if (tok.kind === TokenKind.IN) return this.parseSqlValue();
    // CASE WHEN ... END → CaseSqlValue
    if (tok.kind === TokenKind.CASE || tok.kind === TokenKind.IF) {
      return this.parseSqlValue();
    }
    // 配列リテラル: ['val1', 'val2']
    if (tok.kind === TokenKind.LBRACKET) return this.parseArrayLiteral();
    // スカラーサブクエリ: ( SELECT ... )
    if (tok.kind === TokenKind.LPAREN && this.peekAt(1).kind === TokenKind.SELECT) {
      this.advance(); // ( を消費
      const query = this.parseSelect();
      this.expect(TokenKind.RPAREN);
      return { type: "SCALAR_SUBQUERY", query };
    }

    // 数値・識別子・括弧 → 算術式として解析
    const previousAllowUnaryPlusNumber = this.allowUnaryPlusNumber;
    this.allowUnaryPlusNumber = true;
    let node: ArithNode;
    try {
      node = this.parseArithAddSub();
    } finally {
      this.allowUnaryPlusNumber = previousAllowUnaryPlusNumber;
    }
    if (node.type === "NUMBER") return node;   // 数値単独 → SqlValue
    if (node.type === "ARITH")  return node;   // 算術式
    if (node.type === "STRING_FUNC") return node; // UPDATE SET 専用の行評価
    if (node.type === "FIELD_REF") {
      const dot = node.field.indexOf(".");
      if (dot > 0 && dot < node.field.length - 1) {
        return { type: "SOURCE_FIELD", alias: node.field.slice(0, dot), field: node.field.slice(dot + 1) };
      }
    }
    // FIELD_REF 単独（SET f = other_field）は未サポート
    throw new ParseError(
      "SET の値にフィールド参照を単独で指定することはできません",
      tok
    );
  }

  private parseArithOp(): ArithOp {
    const tok = this.advance();
    switch (tok.kind) {
      case TokenKind.PLUS:    return "+";
      case TokenKind.MINUS:   return "-";
      case TokenKind.STAR:    return "*";
      case TokenKind.SLASH:   return "/";
      case TokenKind.PERCENT: return "%";
      default:
        throw new ParseError("算術演算子（+ - * / %）が必要です", tok);
    }
  }

  // ----------------------------------------------------------
  // DELETE
  // ----------------------------------------------------------

  private parseDelete(): DeleteStatement {
    this.expect(TokenKind.DELETE);
    this.expect(TokenKind.FROM);

    this.rejectTempTableDml();
    const name = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(name, this.prev());

    const whereTok = this.peek();
    if (!this.consume(TokenKind.WHERE)) {
      throw new ParseError(
        "DELETE 文には WHERE 句が必須です（全件削除を防ぐため）",
        whereTok
      );
    }
    const where = this.parseWhereExpr();

    return subtableCode
      ? { type: "DELETE", appId, subtableCode, where }
      : { type: "DELETE", appId, where };
  }

  // ----------------------------------------------------------
  // REORDER
  // ----------------------------------------------------------

  private parseReorder(): ReorderStatement {
    this.expect(TokenKind.REORDER);
    const all = this.consume(TokenKind.ALL);

    this.rejectTempTableDml();
    const name = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(name, this.prev());
    if (!subtableCode) {
      throw new ParseError("REORDER はサブテーブル仮想テーブルのみ指定できます（例: REORDER APP100$明細 ...）", this.prev());
    }

    this.expect(TokenKind.BY);
    const by = this.parseOrderBy();
    if (by.length === 0) {
      throw new ParseError("REORDER には BY キーが必要です", this.prev());
    }

    let where: WhereExpr | null = null;
    if (all) {
      if (this.peek().kind === TokenKind.WHERE) {
        throw new ParseError("REORDER ALL では WHERE は指定できません", this.peek());
      }
    } else {
      const whereTok = this.peek();
      if (!this.consume(TokenKind.WHERE)) {
        throw new ParseError("REORDER には WHERE 句が必須です（誤操作防止）", whereTok);
      }
      where = this.parseWhereExpr();
    }

    return {
      type: "REORDER",
      appId,
      subtableCode,
      all,
      by,
      where,
    };
  }

  // ----------------------------------------------------------
  // トークン操作ヘルパー
  // ----------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: TokenKind.EOF, value: "", pos: -1 };
  }

  /** n 先のトークンを読み取る（消費しない） */
  private peekAt(n: number): Token {
    return this.tokens[this.pos + n] ?? { kind: TokenKind.EOF, value: "", pos: -1 };
  }

  private prev(): Token {
    return this.tokens[this.pos - 1] ?? { kind: TokenKind.EOF, value: "", pos: -1 };
  }

  private advance(): Token {
    const tok = this.peek();
    if (tok.kind !== TokenKind.EOF) this.pos++;
    return tok;
  }

  /** 指定 kind なら消費して true を返す */
  private consume(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.advance();
      return true;
    }
    return false;
  }

  /** 指定 kind でなければエラー */
  private expect(kind: TokenKind, msg?: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new ParseError(
        msg ?? `「${kind}」が必要です`,
        tok
      );
    }
    return this.advance();
  }

  /** FROM / GROUP BY など文脈付きエラーメッセージ */
  private expectKeyword(kind: TokenKind, msg: string): Token {
    return this.expect(kind, msg);
  }

  /** 符号なし整数を読む */
  private parseUnsignedInt(): number {
    const tok = this.expect(TokenKind.NUMBER, "整数が必要です");
    const n = Number(tok.value);
    if (!Number.isInteger(n) || n < 0) {
      throw new ParseError("正の整数が必要です", tok);
    }
    return n;
  }

  // 識別子（IDENT / BIDENT）を読む。# 始まりの一時テーブル名は不可
  //（temp マーカーはレキサが生成する IDENT のみ。`#field` のような
  //  バッククォート識別子は # で始まる通常フィールド名として許容する）
  private parseIdentifier(): string {
    const tok = this.peek();
    if (tok.kind === TokenKind.IDENT || tok.kind === TokenKind.BIDENT) {
      if (tok.kind === TokenKind.IDENT && tok.value.startsWith("#")) {
        throw new ParseError(
          "一時テーブル名（# で始まる名前）は FROM / JOIN / CREATE / DROP TEMP TABLE でのみ使用できます",
          tok
        );
      }
      this.advance();
      return tok.value;
    }
    throw new ParseError(
      "フィールド名またはテーブル名が必要です",
      tok
    );
  }

  // テーブル名（IDENT / BIDENT）を読む。# 始まりの一時テーブル名を許容する
  //（一時テーブルを受理してよいのはテーブル参照位置のみ。他は parseIdentifier を使う）
  private parseTableName(): string {
    const tok = this.peek();
    if (tok.kind === TokenKind.IDENT || tok.kind === TokenKind.BIDENT) {
      this.advance();
      return tok.value;
    }
    throw new ParseError(
      "フィールド名またはテーブル名が必要です",
      tok
    );
  }

  // DML の対象テーブル位置に一時テーブルが指定されていたら拒否する
  private rejectTempTableDml(): void {
    const tok = this.peek();
    if (tok.kind === TokenKind.IDENT && tok.value.startsWith("#")) {
      throw new ParseError(
        `DML on temp table ${tok.value} is not supported.`,
        tok
      );
    }
  }

  // エイリアス名: IDENT / BIDENT に加え、キーワードも許容する
  // 例: SELECT SUM(金額) AS avg → "avg" は AVG キーワードだが alias として有効
  private parseAliasName(): string {
    const tok = this.peek();
    if (tok.value.startsWith("#")) {
      throw new ParseError("エイリアス名に # で始まる名前は使用できません", tok);
    }
    if (
      tok.kind === TokenKind.IDENT ||
      tok.kind === TokenKind.BIDENT ||
      KEYWORDS.has(tok.value.toUpperCase())
    ) {
      this.advance();
      return tok.value.toLowerCase(); // alias は小文字で統一
    }
    throw new ParseError("エイリアス名が必要です", tok);
  }

  /** フィールド名または修飾フィールド名（alias.field）を解析する */
  private parseFieldPath(): string {
    const first = this.parseIdentifier();
    if (this.peek().kind !== TokenKind.DOT) return first;
    this.advance(); // .
    const second = this.parseIdentifier();
    return `${first}.${second}`;
  }

  /** SELECT 列用: alias.field に加えて _p.* / _parent.* を受け付ける */
  private parseColumnFieldRef(): string {
    const first = this.parseIdentifier();
    if (this.peek().kind !== TokenKind.DOT) return first;
    this.advance(); // .
    if (this.consume(TokenKind.STAR)) {
      return `${first}.*`;
    }
    const second = this.parseIdentifier();
    return `${first}.${second}`;
  }
}

// ----------------------------------------------------------
// ヘルパー: キャスト型名の正規化
// ----------------------------------------------------------

/**
 * CAST / CONVERT のキャスト先型名を "TEXT" または "NUMBER" に正規化する。
 * 不明な型名の場合は null を返す。
 */
function normalizeCastType(raw: string): "TEXT" | "NUMBER" | null {
  const upper = raw.toUpperCase();
  const textTypes    = new Set(["TEXT", "VARCHAR", "CHAR", "NCHAR", "NVARCHAR", "STRING"]);
  const numberTypes  = new Set(["NUMBER", "INT", "INTEGER", "NUMERIC", "DECIMAL",
                                "FLOAT", "DOUBLE", "REAL", "BIGINT", "SMALLINT"]);
  if (textTypes.has(upper))   return "TEXT";
  if (numberTypes.has(upper)) return "NUMBER";
  return null;
}

// ----------------------------------------------------------
// ヘルパー: APP100 → appId: 100
// ----------------------------------------------------------

function extractTableRef(name: string, tok: Token): { appId: number; subtableCode: string | null } {
  const m = name.match(/^[Aa][Pp][Pp](\d+)(?:\$(.+))?$/);
  if (!m) {
    throw new ParseError(
      `テーブル名は APP + 数字（または APP + 数字 + $サブテーブル）で指定してください（例: APP100 / APP100$明細）。「${name}」は無効です`,
      tok
    );
  }
  return { appId: Number(m[1]), subtableCode: m[2] ?? null };
}
