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
import { makeNumberLiteral, numberLiteralText } from "../types/ast";
import { expandCubeGroupingSets } from "../core/grouping";
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
  VariableColumn,
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
  LegacyKintoneFunction,
  RelativeDateFunction,
  RelativeDateMonthDay,
  RelativeDatePeriodUnit,
  RelativeDateWeekday,
  InList,
  VariableInList,
  SubqueryInList,
  CompareOp,
  OrderByItem,
  InsertStatement,
  InsertSelectStatement,
  InsertRow,
  AggArithColumn,
  AggArithExpr,
  AggOperand,
  AggGroupKeyRef,
  AggregateRef,
  GroupByKey,
  GroupingSpec,
  GroupingFieldItem,
  GroupingRef,
  UpdateStatement,
  Assignment,
  DeleteStatement,
  ReorderStatement,
  UpsertStatement,
  UpsertSelectStatement,
  ShowAppsStatement,
  DescribeStatement,
  ExplainStatement,
  LegacyArithExpr,
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
  AggregateWindowColumn,
  WindowAggFunc,
  WindowFrame,
  ValueWindowColumn,
  ValueWindowFunc,
  ScalarValueExpr,
  AggregateArgExpr,
  ConcatExpr,
  ScalarValueColumn,
  CheckGroup,
  ValidateStatement,
  ImportStatement,
  ApplyBlock,
  ApplyOperation,
  RowSelector,
  ExpectRowsGuard,
  GenerateSeriesStatement,
  GenerateSeriesArgument,
} from "../types/ast";
import { aggregateSyntheticName } from "../core/aggregateExpression";
import { NO_FROM_CTE_NAME } from "../types/ast";
import {
  RELATIVE_DATE_FUNCTION_NAMES,
  isRelativeDateFunctionName,
} from "../core/relativeDateFunction";

/** バッチ(複文)の文数上限 */
const MAX_BATCH_STATEMENTS = 20;

// BETWEEN 展開用の型エイリアス（ローカル）
type ExpandedBetween = LogicalExpr;

export const PARSER_SCALAR_FUNCTION_TOKEN_MAP: Readonly<Partial<Record<TokenKind, StringFuncName>>> = Object.freeze({
  [TokenKind.UPPER]: "UPPER",
  [TokenKind.LOWER]: "LOWER",
  [TokenKind.TRIM]: "TRIM",
  [TokenKind.LTRIM]: "LTRIM",
  [TokenKind.RTRIM]: "RTRIM",
  [TokenKind.LENGTH]: "LENGTH",
  [TokenKind.LENGTH_CHAR]: "LENGTH_CHAR",
  [TokenKind.SUBSTRING]: "SUBSTRING",
  [TokenKind.SUBSTR]: "SUBSTRING",
  [TokenKind.LEFT]: "LEFT",
  [TokenKind.RIGHT]: "RIGHT",
  [TokenKind.INSTR]: "INSTR",
  [TokenKind.CONCAT]: "CONCAT",
  [TokenKind.REPLACE]: "REPLACE",
  [TokenKind.REGEXP_LIKE]: "REGEXP_LIKE",
  [TokenKind.REGEXP_REPLACE]: "REGEXP_REPLACE",
  [TokenKind.REGEXP_SUBSTR]: "REGEXP_SUBSTR",
  [TokenKind.TRANSLATE]: "TRANSLATE",
  [TokenKind.COALESCE]: "COALESCE",
  [TokenKind.ISNULL]: "ISNULL",
  [TokenKind.NULLIF]: "NULLIF",
  [TokenKind.GREATEST]: "GREATEST",
  [TokenKind.LEAST]: "LEAST",
  [TokenKind.LPAD]: "LPAD",
  [TokenKind.RPAD]: "RPAD",
  [TokenKind.ROUND]: "ROUND",
  [TokenKind.FLOOR]: "FLOOR",
  [TokenKind.CEIL]: "CEIL",
  [TokenKind.CEILING]: "CEIL",
  [TokenKind.TRUNCATE]: "TRUNCATE",
  [TokenKind.TRUNC]: "TRUNCATE",
  [TokenKind.ABS]: "ABS",
  [TokenKind.MOD]: "MOD",
  [TokenKind.POWER]: "POWER",
  [TokenKind.POW]: "POWER",
  [TokenKind.SQRT]: "SQRT",
  [TokenKind.FORMAT]: "FORMAT",
  [TokenKind.CAST]: "CAST",
  [TokenKind.CONVERT]: "CAST",
  [TokenKind.YEAR]: "YEAR",
  [TokenKind.MONTH]: "MONTH",
  [TokenKind.DAY]: "DAY",
  [TokenKind.DAYOFWEEK]: "DAYOFWEEK",
  [TokenKind.QUARTER]: "QUARTER",
  [TokenKind.WEEK]: "WEEK",
  [TokenKind.DATE_FORMAT]: "DATE_FORMAT",
  [TokenKind.DATEDIFF]: "DATEDIFF",
  [TokenKind.DATE_ADD]: "DATE_ADD",
  [TokenKind.LAST_DAY]: "LAST_DAY",
});

export const PARSER_IDENT_SCALAR_FUNCTIONS = Object.freeze([
  "CURRENT_DATE", "CURRENT_TIMESTAMP",
] as const satisfies readonly StringFuncName[]);

export const PARSER_AGGREGATE_FUNCTION_TOKEN_MAP: Readonly<Partial<Record<TokenKind, AggregateFunc>>> = Object.freeze({
  [TokenKind.COUNT]: "COUNT",
  [TokenKind.SUM]: "SUM",
  [TokenKind.AVG]: "AVG",
  [TokenKind.MAX]: "MAX",
  [TokenKind.MIN]: "MIN",
  [TokenKind.GROUP_CONCAT]: "GROUP_CONCAT",
  [TokenKind.STDDEV_POP]: "STDDEV_POP",
  [TokenKind.STDDEV_SAMP]: "STDDEV_SAMP",
  [TokenKind.VAR_POP]: "VAR_POP",
  [TokenKind.VAR_SAMP]: "VAR_SAMP",
  [TokenKind.MEDIAN]: "MEDIAN",
  [TokenKind.MODE]: "MODE",
});

export const PARSER_AGGREGATE_FUNCTIONS = Object.freeze(
  Object.values(PARSER_AGGREGATE_FUNCTION_TOKEN_MAP).filter(
    (func): func is AggregateFunc => func !== undefined
  )
);

export const PARSER_AGGREGATE_WILDCARD_FUNCTIONS = Object.freeze([
  "COUNT", "SUM", "AVG", "MAX", "MIN",
] as const satisfies readonly AggregateFunc[]);

const PARSER_AGGREGATE_WILDCARD_FUNCTION_SET: ReadonlySet<AggregateFunc> =
  new Set(PARSER_AGGREGATE_WILDCARD_FUNCTIONS);

export function aggregateAcceptsWildcard(func: AggregateFunc): boolean {
  return PARSER_AGGREGATE_WILDCARD_FUNCTION_SET.has(func);
}

export const PARSER_WINDOW_FUNCTION_TOKEN_MAP: Readonly<Partial<Record<TokenKind, WindowFunc>>> = Object.freeze({
  [TokenKind.ROW_NUMBER]: "ROW_NUMBER",
  [TokenKind.RANK]: "RANK",
  [TokenKind.DENSE_RANK]: "DENSE_RANK",
});

export const PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP: Readonly<Partial<Record<TokenKind, LegacyKintoneFunction["name"]>>> = Object.freeze({
  [TokenKind.TODAY]: "TODAY",
  [TokenKind.NOW]: "NOW",
  [TokenKind.LOGINUSER]: "LOGINUSER",
  [TokenKind.PRIMARY_ORGANIZATION]: "PRIMARY_ORGANIZATION",
});

export function isContextualFunctionToken(kind: TokenKind): boolean {
  return PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP[kind] !== undefined;
}

/** Contextual IDENT spellings; none of these are lexer keywords. */
export const PARSER_IDENT_RELATIVE_DATE_FUNCTIONS = Object.freeze(
  [...RELATIVE_DATE_FUNCTION_NAMES]
);

const RELATIVE_DATE_PERIOD_UNITS: ReadonlySet<string> =
  new Set(["DAYS", "WEEKS", "MONTHS", "YEARS"]);
const RELATIVE_DATE_WEEKDAYS: ReadonlySet<string> = new Set([
  "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY",
]);

function isRelativeDatePeriodUnit(value: string): value is RelativeDatePeriodUnit {
  return RELATIVE_DATE_PERIOD_UNITS.has(value);
}

function isRelativeDateWeekday(value: string): value is RelativeDateWeekday {
  return RELATIVE_DATE_WEEKDAYS.has(value);
}

function isRelativeDateMonthDay(value: number): value is RelativeDateMonthDay {
  return Number.isInteger(value) && value >= 1 && value <= 31;
}

export const PARSER_FUNCTION_SPELLINGS = Object.freeze(Array.from(new Set([
  ...Object.keys(PARSER_SCALAR_FUNCTION_TOKEN_MAP),
  ...PARSER_IDENT_SCALAR_FUNCTIONS,
  ...Object.keys(PARSER_AGGREGATE_FUNCTION_TOKEN_MAP),
  ...Object.keys(PARSER_WINDOW_FUNCTION_TOKEN_MAP),
  ...Object.keys(PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP), ...PARSER_IDENT_RELATIVE_DATE_FUNCTIONS,
  "IF",
])));

// ------------------------------------------------------------
// トークン列 → テキスト再構成（ASSERT のエラーメッセージ用）
// ------------------------------------------------------------

/** この種別の直後の "(" は関数呼び出しとして詰めて表示する（COUNT( / ROUND( 等） */
const FUNC_CALL_PREFIX_KINDS: ReadonlySet<TokenKind> = new Set([
  TokenKind.IDENT, TokenKind.BIDENT,
  TokenKind.COUNT, TokenKind.SUM, TokenKind.AVG, TokenKind.MAX, TokenKind.MIN,
  TokenKind.GROUP_CONCAT, TokenKind.STDDEV_POP, TokenKind.STDDEV_SAMP,
  TokenKind.VAR_POP, TokenKind.VAR_SAMP, TokenKind.MEDIAN, TokenKind.MODE,
  TokenKind.ROW_NUMBER, TokenKind.RANK, TokenKind.DENSE_RANK,
  TokenKind.TODAY, TokenKind.NOW, TokenKind.LOGINUSER, TokenKind.PRIMARY_ORGANIZATION,
  TokenKind.UPPER, TokenKind.LOWER, TokenKind.TRIM, TokenKind.LTRIM, TokenKind.RTRIM,
  TokenKind.LENGTH, TokenKind.LENGTH_CHAR, TokenKind.SUBSTRING, TokenKind.SUBSTR, TokenKind.CONCAT,
  TokenKind.REPLACE, TokenKind.TRANSLATE, TokenKind.COALESCE, TokenKind.NULLIF, TokenKind.ISNULL,
  TokenKind.REGEXP_LIKE, TokenKind.REGEXP_REPLACE, TokenKind.REGEXP_SUBSTR,
  TokenKind.LEFT, TokenKind.RIGHT, TokenKind.INSTR,
  TokenKind.GREATEST, TokenKind.LEAST, TokenKind.LPAD, TokenKind.RPAD,
  TokenKind.CAST, TokenKind.CONVERT, TokenKind.FORMAT,
  TokenKind.ROUND, TokenKind.FLOOR, TokenKind.CEIL, TokenKind.CEILING,
  TokenKind.TRUNCATE, TokenKind.TRUNC,
  TokenKind.ABS, TokenKind.MOD, TokenKind.POWER, TokenKind.POW, TokenKind.SQRT,
  TokenKind.YEAR, TokenKind.MONTH, TokenKind.DAY,
  TokenKind.DAYOFWEEK, TokenKind.QUARTER, TokenKind.WEEK,
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
  constructor(public readonly rawMessage: string, public readonly token: Token) {
    super(`${rawMessage}（位置 ${token.pos}、トークン: 「${token.value}」）`);
    this.name = "ParseError";
  }
}

/**
 * ウィンドウ結果を同一 SELECT の式に使ったときの診断（B129）。
 * 次の一手は 3 つの形（関数で包む・算術に混ぜる・CASE の中）すべて同じなので 1 文言で扱う。
 * 位置・トークンは ParseError が末尾に付けるため、最終行は SQL ではなく文で終える。
 */
export const WINDOW_RESULT_IN_EXPRESSION_MESSAGE = [
  "ウィンドウ関数の結果は同じ SELECT の式では使えません。",
  "  × SELECT ROUND(SUM(x) OVER (), 1) AS a FROM t",
  "  ○ WITH w AS (SELECT SUM(x) OVER () AS 総計 FROM t) SELECT ROUND(総計, 1) AS a FROM w",
  "ウィンドウ結果を列として出し、それを使う式は次の段（CTE または一時テーブル）に書いてください",
].join("\n");

// ------------------------------------------------------------
// Parser クラス
// ------------------------------------------------------------

export interface ParserCapabilities { import?: boolean; }

type GroupingFieldContext = "FORBIDDEN" | "SELECT_CASE" | "HAVING";

export class Parser {
  private allowUnaryPlusNumber = false;
  private scalarAllowsAggregateArgs = true;
  private scalarAllowsCase = true;
  private pos = 0;
  private insideAggregateArg = 0;
  /** GROUPING(field) is limited to the explicitly selected query context. */
  private groupingFieldContext: GroupingFieldContext = "FORBIDDEN";
  /** True only while parsing an actual SQL WHERE clause (including nested groups). */
  private allowRelativeDateFunctions = false;
  /** WITH 句で定義された CTE 名のセット（parseTableRef で参照） */
  private cteNames: Set<string> = new Set();
  /** パース中に出現した一時テーブル参照（#name）のトークン。単文 API での拒否に使う */
  private tempTableRefs: Token[] = [];
  /** GROUP BY を読む前に作る B124 候補 leaf の診断位置。AST 公開型へ位置情報を足さない。 */
  private aggregateGroupKeyTokens = new WeakMap<AggGroupKeyRef, Token>();

  constructor(
    private readonly tokens: Token[],
    private readonly capabilities: ParserCapabilities = {}
  ) {}

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
        if (upper === "VALIDATE") return this.parseValidate();
        if (upper === "GENERATE_SERIES") {
          throw new ParseError(
            "GENERATE_SERIES は WITH の CTE 本体に書いてください。例: WITH s AS (GENERATE_SERIES(1, 5)) SELECT generate_series FROM s",
            tok
          );
        }
        if (upper === "IMPORT") {
          if (!this.capabilities.import) {
            throw new ParseError("IMPORT is not supported (capability is disabled).", tok);
          }
          return this.parseImport();
        }
        break;
      }
      default:
        break;
    }
    throw new ParseError(
      "SELECT / INSERT / UPDATE / DELETE / REORDER / VALIDATE / WITH / SHOW / DESCRIBE / EXPLAIN / CREATE TEMP TABLE / DROP TEMP TABLE / SET / DECLARE / ASSERT のいずれかで始まる SQL 文が必要です",
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
    const expr = this.peek().kind === TokenKind.LBRACKET
      ? this.parseArrayLiteral()
      : this.parseScalarExpr("SET", true);
    return { type: "SET_VARIABLE", name: variable.value.slice(1).toLowerCase(), expr };
  }

  private parseDeclareVariable(): DeclareVariableStatement {
    this.advance(); // DECLARE（ソフトキーワード）
    const variable = this.expect(TokenKind.VARIABLE, "DECLARE の後には変数名（例: @name）が必要です");
    const relativeDate = this.peek().kind === TokenKind.IDENT
      && this.peek().value.toUpperCase() === "RELATIVE_DATE";
    if (relativeDate) this.advance(); // RELATIVE_DATE（ソフトキーワード）
    this.expect(TokenKind.EQ);
    if (relativeDate) {
      return {
        type: "DECLARE_VARIABLE",
        name: variable.value.slice(1).toLowerCase(),
        annotation: "RELATIVE_DATE",
        default: this.parseRelativeDateVariableToken(),
      };
    }
    const expr = this.parseScalarExpr("DECLARE", false);
    if (expr.type === "SCALAR_SUBQUERY") {
      // allowScalarSubquery=false で到達しないが、型の絞り込みを明示する。
      throw new ParseError("DECLARE の既定値にスカラーサブクエリは使用できません", this.peek());
    }
    return { type: "DECLARE_VARIABLE", name: variable.value.slice(1).toLowerCase(), default: expr };
  }

  /** RELATIVE_DATE 宣言専用。WHERE と同じ関数パーサーを使い、日付系14個だけを許可する。 */
  private parseRelativeDateVariableToken(): LegacyKintoneFunction | RelativeDateFunction {
    const tok = this.peek();
    const contextualFunction = PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP[tok.kind];
    if (contextualFunction === "TODAY" || contextualFunction === "NOW") {
      return this.parseSqlValue() as LegacyKintoneFunction;
    }
    if (
      tok.kind === TokenKind.IDENT
      && this.peekAt(1).kind === TokenKind.LPAREN
      && isRelativeDateFunctionName(tok.value.toUpperCase())
    ) {
      return this.parseRelativeDateFunction();
    }
    throw new ParseError(
      "RELATIVE_DATE の既定値にはサポート対象の相対日付関数トークンが必要です",
      tok
    );
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
    const contextualFunction = PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP[tok.kind];
    if (contextualFunction === "LOGINUSER") {
      throw new ParseError(
        `${context} の右辺で LOGINUSER() は使用できません（実行環境共通のログインユーザー解決は未対応です）`,
        tok
      );
    }
    if (contextualFunction === "PRIMARY_ORGANIZATION") {
      throw new ParseError(
        `${context} の右辺で PRIMARY_ORGANIZATION() は使用できません（実行環境共通の優先組織解決は未対応です）`,
        tok
      );
    }
    if (contextualFunction !== undefined) {
      return this.parseSqlValue() as LegacyKintoneFunction;
    }
    const expr = this.parseArithAddSub();
    this.rejectNonScalarExpr(expr, tok, context);
    if (expr.type === "NUMBER" || expr.type === "STRING_FUNC" || expr.type === "ARITH") return expr;
    throw new ParseError(`${context} の右辺にはフィールド参照を含まないスカラー式を指定してください`, tok);
  }

  private rejectNonScalarExpr(node: StringFuncArg | ArithNode, tok: Token, context: "SET" | "DECLARE"): void {
    if (node.type === "STRING" || node.type === "NUMBER") return;
    if (node.type === "FIELD_REF" || node.type === "FIELD" || node.type === "VARIABLE" || node.type === "AGG_REF") {
      throw new ParseError(`${context} の右辺ではフィールド参照・集計関数を使用できません`, tok);
    }
    if (node.type === "ARITH" || node.type === "SCALAR_ARITH" || node.type === "CONCAT_OP" || node.type === "AGG_ARITH") {
      this.rejectNonScalarExpr(node.left, tok, context);
      this.rejectNonScalarExpr(node.right, tok, context);
      return;
    }
    if (node.type === "STRING_FUNC") {
      for (const arg of node.args) this.rejectNonScalarExpr(arg, tok, context);
      return;
    }
    throw new ParseError(`${context} の右辺では CASE を使用できません`, tok);
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

  private consumeSoftKeyword(word: string): boolean {
    if (!this.isSoftKeyword(word)) return false;
    this.advance();
    return true;
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
    } else if (tok.kind === TokenKind.IDENT && tok.value.toUpperCase() === "VALIDATE") {
      query = this.parseValidate();
    } else if (tok.kind === TokenKind.IDENT && tok.value.toUpperCase() === "IMPORT") {
      if (!this.capabilities.import) {
        throw new ParseError("IMPORT is not supported (capability is disabled).", tok);
      }
      query = this.parseImport();
    } else {
      throw new ParseError("EXPLAIN の後には SELECT / WITH / INSERT / UPSERT / UPDATE / DELETE / REORDER / VALIDATE が必要です", tok);
    }
    return { type: "EXPLAIN", query };
  }

  private parseImport(): ImportStatement {
    this.advance(); // IMPORT (soft keyword)
    let writeMode: "UPDATE_RECORD_NUMBER" | undefined;
    if (this.peek().kind === TokenKind.UPDATE) {
      this.advance();
      writeMode = "UPDATE_RECORD_NUMBER";
    }
    this.expect(TokenKind.INTO);
    this.rejectTempTableDml();
    const target = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(target, this.prev());
    if (subtableCode) throw new ParseError("IMPORT does not support subtables in Phase 1.", this.prev());
    this.expect(TokenKind.LPAREN);
    const targets: ImportStatement["targets"] = [];
    const fields: string[] = [];
    const targetNames = new Set<string>();
    while (true) {
      const name = this.parseIdentifier();
      if (targetNames.has(name)) throw new ParseError(`IMPORT target ${name} is declared more than once.`, this.prev());
      targetNames.add(name);
      if (this.peek().kind === TokenKind.LPAREN) {
        this.advance();
        const children = this.parseIdentList();
        this.expect(TokenKind.RPAREN);
        if (new Set(children).size !== children.length) {
          throw new ParseError(`IMPORT subtable ${name} contains duplicate child declarations.`, this.prev());
        }
        let rowIdSourceHeader: string | undefined;
        if (this.isSoftKeyword("ROW")) {
          this.advance();
          for (const word of ["ID", "SOURCE"]) {
            if (!this.isSoftKeyword(word)) throw new ParseError(`ROW must be followed by ID SOURCE <header>.`, this.peek());
            this.advance();
          }
          rowIdSourceHeader = this.parseIdentifier();
        }
        targets.push({ kind: "SUBTABLE", subtableCode: name, children, ...(rowIdSourceHeader ? { rowIdSourceHeader } : {}) });
      } else {
        fields.push(name);
        targets.push({ kind: "FIELD", field: name });
      }
      if (this.peek().kind !== TokenKind.COMMA) break;
      this.advance();
    }
    this.expect(TokenKind.RPAREN);
    this.expect(TokenKind.FROM);
    if (!this.isSoftKeyword("CSV") && !this.isSoftKeyword("JSON")) throw new ParseError("IMPORT FROM requires CSV or JSON.", this.peek());
    const sourceKind = this.peek().value.toUpperCase() as "CSV" | "JSON";
    this.advance();
    const sourceName = this.parseIdentifier();
    let encoding: "utf8" | "sjis" | undefined;
    let hasHeader = true;
    let columns: string[] | undefined;
    if (this.isSoftKeyword("ENCODING")) {
      if (sourceKind === "JSON") throw new ParseError("JSON source is UTF-8 only; ENCODING is not allowed.", this.peek());
      this.advance();
      const value = this.parseIdentifier().toUpperCase();
      if (value !== "UTF8" && value !== "SJIS") throw new ParseError("ENCODING must be UTF8 or SJIS.", this.prev());
      encoding = value === "UTF8" ? "utf8" : "sjis";
    }
    if (this.peek().kind === TokenKind.NOT && this.peekAt(1).kind === TokenKind.IDENT && this.peekAt(1).value.toUpperCase() === "HEADER") {
      if (sourceKind === "JSON") throw new ParseError("NO HEADER is CSV-only.", this.peek());
      this.advance(); this.advance(); hasHeader = false;
    } else if (this.isSoftKeyword("NO") && this.peekAt(1).kind === TokenKind.IDENT && this.peekAt(1).value.toUpperCase() === "HEADER") {
      if (sourceKind === "JSON") throw new ParseError("NO HEADER is CSV-only.", this.peek());
      this.advance(); this.advance(); hasHeader = false;
    }
    if (this.isSoftKeyword("COLUMNS")) {
      if (sourceKind === "JSON") throw new ParseError("COLUMNS is CSV-only.", this.peek());
      if (hasHeader) throw new ParseError("COLUMNS requires NO HEADER.", this.peek());
      this.advance(); this.expect(TokenKind.LPAREN); columns = this.parseIdentList(); this.expect(TokenKind.RPAREN);
    }
    let projection: SelectStatement | undefined;
    if (this.peek().kind === TokenKind.SELECT) {
      if (sourceKind === "JSON") throw new ParseError("SELECT projection is CSV-only.", this.peek());
      projection = this.parseSelect();
      if (projection.from.cteName !== NO_FROM_CTE_NAME || projection.joins.length > 0) {
        throw new ParseError("IMPORT projection cannot use FROM or JOIN.", this.prev());
      }
      if (projection.where || projection.groupBy.length || projection.grouping !== undefined
        || projection.having || projection.orderBy.length || projection.limit !== null || projection.offset !== null) {
        throw new ParseError("IMPORT projection supports SELECT expressions only.", this.prev());
      }
      this.validateImportProjectionScope(projection, this.prev());
      if (targets.some((item) => item.kind === "SUBTABLE")) {
        throw new ParseError("IMPORT subtable sources cannot use SELECT projection.", this.prev());
      }
      if (projection.columns.length !== fields.length) {
        throw new ParseError(`IMPORT projection has ${projection.columns.length} columns; target has ${fields.length}.`, this.prev());
      }
    }
    let mappingMode: "POSITION" | "BY_NAME" = "POSITION";
    let ignoreUnknownColumns = false;
    if (this.peek().kind === TokenKind.BY || this.isSoftKeyword("BY")) {
      if (sourceKind === "JSON") throw new ParseError("BY NAME is CSV-only.", this.peek());
      this.advance();
      if (!this.isSoftKeyword("NAME")) throw new ParseError("BY must be followed by NAME in IMPORT.", this.peek());
      this.advance();
      if (!hasHeader) throw new ParseError("BY NAME requires HEADER.", this.prev());
      if (projection) throw new ParseError("BY NAME and SELECT projection are mutually exclusive.", this.prev());
      mappingMode = "BY_NAME";
      if (this.isSoftKeyword("IGNORE")) {
        this.advance();
        if (!this.isSoftKeyword("UNKNOWN")) throw new ParseError("IGNORE must be followed by UNKNOWN COLUMNS.", this.peek());
        this.advance();
        if (!this.isSoftKeyword("COLUMNS")) throw new ParseError("IGNORE UNKNOWN must be followed by COLUMNS.", this.peek());
        this.advance();
        ignoreUnknownColumns = true;
      }
    }
    let keyFields: string[] | undefined;
    let recordNumberSourceHeader: string | undefined;
    if (this.isSoftKeyword("MATCH")) {
      this.advance();
      for (const word of ["RECORD", "NUMBER", "SOURCE"]) {
        if (!this.isSoftKeyword(word)) throw new ParseError(`MATCH must be followed by RECORD NUMBER SOURCE <header>.`, this.peek());
        this.advance();
      }
      recordNumberSourceHeader = this.parseIdentifier();
    }
    if (this.peek().kind === TokenKind.ON && this.peekAt(1).kind === TokenKind.DUPLICATE) keyFields = this.parseOnDuplicate();
    let replaceSubtables: string[] | undefined;
    // REPLACE predates IMPORT as a scalar-function token; accept that existing
    // token without adding any of the Phase 5 words to the keyword table.
    if (this.peek().kind === TokenKind.REPLACE || this.isSoftKeyword("REPLACE")) {
      this.advance();
      if (!this.isSoftKeyword("SUBTABLES")) throw new ParseError("REPLACE must be followed by SUBTABLES (...).", this.peek());
      this.advance(); this.expect(TokenKind.LPAREN); replaceSubtables = this.parseIdentList(); this.expect(TokenKind.RPAREN);
      if (new Set(replaceSubtables).size !== replaceSubtables.length) throw new ParseError("REPLACE SUBTABLES contains duplicates.", this.prev());
    }
    const subtableTargets = targets.filter((item): item is Extract<NonNullable<ImportStatement["targets"]>[number], { kind: "SUBTABLE" }> => item.kind === "SUBTABLE");
    if (subtableTargets.length) {
      if (projection) throw new ParseError("IMPORT subtables cannot use SELECT projection.", this.prev());
      if (sourceKind === "JSON") {
        if (subtableTargets.some((item) => item.rowIdSourceHeader)) throw new ParseError("JSON subtable IMPORT does not accept ROW ID SOURCE.", this.prev());
        if (replaceSubtables) throw new ParseError("REPLACE SUBTABLES is CSV-only; JSON uses nested-array replacement semantics.", this.prev());
      } else {
        if (writeMode !== "UPDATE_RECORD_NUMBER" || !recordNumberSourceHeader) throw new ParseError("CSV subtable IMPORT requires IMPORT UPDATE and MATCH RECORD NUMBER SOURCE.", this.prev());
        if (mappingMode !== "BY_NAME") throw new ParseError("CSV subtable IMPORT requires BY NAME.", this.prev());
        if (!replaceSubtables) throw new ParseError("CSV subtable IMPORT requires REPLACE SUBTABLES (...).", this.prev());
        const replacement = new Set(replaceSubtables);
        for (const item of subtableTargets) {
          if (!item.rowIdSourceHeader) throw new ParseError(`CSV subtable ${item.subtableCode} requires ROW ID SOURCE <header>.`, this.prev());
          if (!replacement.has(item.subtableCode)) throw new ParseError(`IMPORT declares child columns for non-replaced subtable ${item.subtableCode}.`, this.prev());
        }
        for (const code of replacement) {
          if (!subtableTargets.some((item) => item.subtableCode === code)) throw new ParseError(`REPLACE SUBTABLES target ${code} is not declared in INTO.`, this.prev());
        }
      }
    } else if (replaceSubtables) {
      throw new ParseError("REPLACE SUBTABLES requires subtable targets in INTO.", this.prev());
    }
    if (writeMode) {
      if (sourceKind !== "CSV") throw new ParseError("IMPORT UPDATE supports CSV only.", this.prev());
      if (mappingMode !== "BY_NAME") throw new ParseError("IMPORT UPDATE requires BY NAME.", this.prev());
      if (!recordNumberSourceHeader) throw new ParseError("IMPORT UPDATE requires MATCH RECORD NUMBER SOURCE <header>.", this.peek());
      if (keyFields) throw new ParseError("IMPORT UPDATE and ON DUPLICATE are mutually exclusive.", this.prev());
    } else if (recordNumberSourceHeader) {
      throw new ParseError("MATCH RECORD NUMBER SOURCE requires IMPORT UPDATE.", this.prev());
    }
    const checkGroups = this.parseCheckGroups();
    const control = this.parseDmlControlSuffix();
    return {
      type: "IMPORT", appId, fields, targets,
      source: sourceKind === "JSON"
        ? { kind: "JSON", sourceName }
        : { kind: "CSV", sourceName, encoding, hasHeader, mappingMode, ignoreUnknownColumns, ...(columns ? { columns } : {}), ...(projection ? { projection } : {}) },
      ...(writeMode ? { writeMode, recordNumberSourceHeader } : {}),
      ...(replaceSubtables ? { replaceSubtables } : {}),
      ...(keyFields ? { keyFields } : {}), ...checkGroups, ...control,
    };
  }

  private validateImportProjectionScope(node: unknown, token: Token): void {
    if (Array.isArray(node)) {
      node.forEach((item) => this.validateImportProjectionScope(item, token));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (value.type === "SCALAR_SUBQUERY" || value.type === "SCALAR_SUBQUERY_COL") {
      throw new ParseError("IMPORT projection cannot use subqueries.", token);
    }
    if (typeof value.tableAlias === "string") {
      throw new ParseError("IMPORT projection cannot use qualified column references.", token);
    }
    Object.values(value).forEach((item) => this.validateImportProjectionScope(item, token));
  }

  /** VALIDATE APP100 [(fields)] [WHERE ...] [CHECK ...] [INTO #err]. */
  private parseValidate(): ValidateStatement {
    const validateTok = this.advance(); // soft keyword VALIDATE
    const name = this.parseIdentifier();
    const { appId, subtableCode } = extractTableRef(name, this.prev());
    if (subtableCode) throw new ParseError(
      `VALIDATE APP${appId}$${subtableCode} はサポートされていません。VALIDATE APP${appId} (${subtableCode}) を使用してください`,
      this.prev()
    );

    let targets: ValidateStatement["targets"];
    if (this.consume(TokenKind.LPAREN)) {
      targets = [];
      do {
        const field = this.parseIdentifier();
        if (this.consume(TokenKind.LPAREN)) {
          const children = this.peek().kind === TokenKind.RPAREN ? [] : this.parseIdentList();
          this.expect(TokenKind.RPAREN);
          targets.push({ kind: "SUBTABLE", subtableCode: field, children });
        } else {
          targets.push({ kind: "FIELD", field });
        }
      } while (this.consume(TokenKind.COMMA));
      this.expect(TokenKind.RPAREN);
    }
    let summary: true | undefined;
    if (this.isSoftKeyword("SUMMARY")) {
      this.advance();
      summary = true;
    }
    const where = this.consume(TokenKind.WHERE) ? this.parseWhereExpr(undefined, true) : null;
    const checks = this.parseCheckGroups();
    let errorTable: string | undefined;
    if (this.consume(TokenKind.INTO)) {
      const tableTok = this.peek();
      if (tableTok.kind !== TokenKind.IDENT || !tableTok.value.startsWith("#")) {
        throw new ParseError("VALIDATE INTO には # で始まる一時テーブル名が必要です", tableTok);
      }
      errorTable = this.parseTableName();
    }
    const stmt: ValidateStatement = { type: "VALIDATE", appId, targets, ...(summary ? { summary } : {}), where, ...checks, ...(errorTable ? { errorTable } : {}) };
    this.assertValidateExpressions(stmt, validateTok);
    return stmt;
  }

  /** v1 VALIDATE is single-app/local: subqueries and qualified references are rejected. */
  private assertValidateExpressions(stmt: ValidateStatement, tok: Token): void {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "EXISTS" || obj.type === "SUBQUERY_IN_LIST" || obj.type === "SCALAR_SUBQUERY") {
        throw new ParseError("VALIDATE の WHERE / CHECK にサブクエリは使用できません", tok);
      }
      if (obj.type === "FIELD" && obj.tableAlias !== null && obj.tableAlias !== undefined) {
        throw new ParseError("VALIDATE の WHERE / CHECK では修飾フィールド参照を使用できません", tok);
      }
      if (obj.type === "FIELD_REF" && typeof obj.field === "string" && obj.field.includes(".")) {
        throw new ParseError("VALIDATE の WHERE / CHECK では修飾フィールド参照を使用できません", tok);
      }
      Object.values(obj).forEach(visit);
    };
    visit(stmt.where);
    visit(stmt.checkGroups);
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
      return expr as LegacyArithExpr;
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

    const where = this.consume(TokenKind.WHERE) ? this.parseWhereExpr(undefined, true) : null;

    let groupBy: GroupByKey[] = [];
    let grouping: GroupingSpec | undefined;
    let having: WhereExpr | null = null;
    if (this.consume(TokenKind.GROUP)) {
      this.expect(TokenKind.BY);
      if (this.peek().kind === TokenKind.DISTINCT || this.isSoftKeyword("DISTINCT")) {
        throw new ParseError("B65: GROUP BY DISTINCT is not supported in Phase1.", this.peek());
      }
      if (this.isGroupingSetsStart()) {
        grouping = this.parseGroupingSetsClause();
      } else if (this.isRollupStart()) {
        grouping = this.parseRollupClause();
      } else if (this.isCubeStart()) {
        grouping = this.parseCubeClause();
      } else {
        groupBy = this.parseGroupByKeys();
      }
      if (grouping && this.peek().kind === TokenKind.COMMA) {
        throw new ParseError("B65: ordinary GROUP BY items cannot be mixed with grouping elements.", this.peek());
      }
      if (this.consume(TokenKind.HAVING)) {
        having = this.parseWhereExpr("HAVING");
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
    if (hasWindow && (groupBy.length > 0 || grouping !== undefined || hasAggregate)) {
      throw new ParseError("ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません", this.peek());
    }
    if (grouping && orderMode === "KINTONE_NATIVE") {
      throw new ParseError("B65: KORDER BY cannot be combined with grouping sets in Phase1.", this.peek());
    }
    this.validateAggregateGroupKeyRefs(columns, having, groupBy, grouping);

    return {
      type: "SELECT",
      distinct,
      columns,
      from,
      joins,
      where,
      groupBy,
      ...(grouping ? { grouping } : {}),
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

  /** B53 parser-private state. Kept here so earlier diagnostic source locations remain stable. */
  private activeCteDefinition: { name: string; recursiveWith: boolean; phase: "SEED" | "RECURSIVE_TERM" } | null = null;
  private provisionalRecursiveCte: { name: string; references: number } | null = null;

  private parseWith(): WithStatement {
    this.expect(TokenKind.WITH);
    // `WITH RECURSIVE AS (...)` and `WITH RECURSIVE(cols) AS (...)` keep
    // RECURSIVE as an ordinary CTE name. Only the clause position consumes it.
    const recursive = this.isSoftKeyword("RECURSIVE") &&
      this.peekAt(1).kind !== TokenKind.AS && this.peekAt(1).kind !== TokenKind.LPAREN;
    if (recursive) this.advance();
    const ctes: CteDefinition[] = [];
    let recursiveCount = 0;

    try {
      do {
        const name = this.parseIdentifier();
        const columnAliases = this.parseOptionalCteColumnAliases();
        this.expect(TokenKind.AS);
        this.expect(TokenKind.LPAREN);
        this.activeCteDefinition = { name, recursiveWith: recursive, phase: "SEED" };

        let query: CteDefinition["query"];
        let recursiveSpec: CteDefinition["recursiveSpec"];
        const inner = this.peek().kind;
        if (inner === TokenKind.SHOW) {
          query = this.parseShow();
        } else if (inner === TokenKind.DESCRIBE || inner === TokenKind.DESC) {
          query = this.parseDescribe();
        } else if (inner === TokenKind.IDENT && this.peek().value.toUpperCase() === "GENERATE_SERIES") {
          query = this.parseGenerateSeries();
        } else if (recursive) {
          const parsed = this.parseRecursiveCteCandidate(name);
          query = parsed.query;
          recursiveSpec = parsed.recursiveSpec;
        } else {
          query = this.tryParseUnionChain(this.parseSelect());
        }
        this.expect(TokenKind.RPAREN);

        const cycle = recursive && this.isSoftKeyword("CYCLE") ? this.parseRecursiveCycleClause() : null;
        if (cycle && !recursiveSpec) {
          throw new ParseError("CYCLE 句は自己参照する再帰 CTE にだけ指定できます", this.prev());
        }
        if (recursiveSpec) {
          recursiveSpec = { ...recursiveSpec, cycle };
          this.validateRecursiveCte(name, columnAliases, recursiveSpec);
          recursiveCount++;
          if (recursiveCount > 1) {
            throw new ParseError("WITH RECURSIVE で定義できる再帰 CTE は1個までです", this.prev());
          }
        }
        if (columnAliases && !recursiveSpec) {
          throw new ParseError("CTE の列名リストは WITH RECURSIVE の再帰 CTE にだけ指定できます", this.prev());
        }

        const definition: CteDefinition = { name, query };
        if (columnAliases) definition.columnAliases = columnAliases;
        if (recursiveSpec) definition.recursiveSpec = recursiveSpec;
        ctes.push(definition);
        this.activeCteDefinition = null;
        this.provisionalRecursiveCte = null;
        // 定義済み CTE 名を登録（後続の CTE・最終クエリで FROM に使える）
        this.cteNames.add(name);
      } while (this.consume(TokenKind.COMMA));

      const query = this.tryParseUnionChain(this.parseSelect());
      return recursive ? { type: "WITH", ctes, query, recursive: true } : { type: "WITH", ctes, query };
    } finally {
      // A failed parse must never leak either the provisional self name or completed CTE names.
      this.activeCteDefinition = null;
      this.provisionalRecursiveCte = null;
      this.cteNames.clear();
    }
  }

  private parseOptionalCteColumnAliases(): string[] | undefined {
    if (!this.consume(TokenKind.LPAREN)) return undefined;
    const aliases: string[] = [];
    if (this.peek().kind === TokenKind.RPAREN) {
      throw new ParseError("CTE の列名リストには1個以上の列名が必要です", this.peek());
    }
    do aliases.push(this.parseIdentifier()); while (this.consume(TokenKind.COMMA));
    this.expect(TokenKind.RPAREN);
    if (new Set(aliases).size !== aliases.length) {
      throw new ParseError("CTE の列名リストに同じ列名を重複して指定できません", this.prev());
    }
    return aliases;
  }

  private parseRecursiveCteCandidate(name: string): {
    query: SelectStatement | UnionStatement;
    recursiveSpec?: NonNullable<CteDefinition["recursiveSpec"]>;
  } {
    const seed = this.parseSelect();
    if (this.peek().kind !== TokenKind.UNION) return { query: seed };

    this.advance();
    const all = this.consume(TokenKind.ALL);
    this.activeCteDefinition = { name, recursiveWith: true, phase: "RECURSIVE_TERM" };
    this.provisionalRecursiveCte = { name, references: 0 };
    const recursiveTerm = this.parseSelect();
    const references = this.provisionalRecursiveCte.references;
    this.provisionalRecursiveCte = null;

    let query: SelectStatement | UnionStatement = { type: "UNION", all, left: seed, right: recursiveTerm };
    query = this.tryParseUnionChain(query);
    this.activeCteDefinition = { name, recursiveWith: true, phase: "SEED" };
    if (references === 0) return { query };
    if (!all || query.type !== "UNION" || query.left !== seed || query.right !== recursiveTerm) {
      throw new ParseError("再帰 CTE は seed SELECT UNION ALL recursive SELECT の2分岐で指定してください", this.prev());
    }
    if (references !== 1) {
      throw new ParseError("再帰項からの自己参照はちょうど1回にしてください", this.prev());
    }
    return {
      query,
      recursiveSpec: { seed, recursiveTerm, unionAll: true, cycle: null },
    };
  }

  private parseRecursiveCycleClause(): NonNullable<CteDefinition["recursiveSpec"]>["cycle"] {
    this.advance(); // CYCLE (soft keyword)
    const column = this.parseIdentifier();
    this.expect(TokenKind.SET, "CYCLE の列名の後には SET が必要です");
    const markColumn = this.parseIdentifier();
    if (!this.isSoftKeyword("TO")) throw new ParseError("CYCLE の mark 列の後には TO が必要です", this.peek());
    this.advance();
    const mark = this.expect(TokenKind.STRING, "CYCLE TO には文字列リテラルが必要です");
    if (!this.isSoftKeyword("DEFAULT")) throw new ParseError("CYCLE TO の値の後には DEFAULT が必要です", this.peek());
    this.advance();
    const normal = this.expect(TokenKind.STRING, "CYCLE DEFAULT には文字列リテラルが必要です");
    if (mark.value === normal.value) {
      throw new ParseError("CYCLE の TO と DEFAULT には異なる文字列を指定してください", normal);
    }
    return { column, markColumn, markValue: mark.value, defaultValue: normal.value, exposePath: false };
  }

  private validateRecursiveCte(
    name: string,
    columnAliases: string[] | undefined,
    spec: NonNullable<CteDefinition["recursiveSpec"]>
  ): void {
    const token = this.prev();
    const seed = spec.seed;
    const term = spec.recursiveTerm;
    const { groupBy } = term;
    if (seed.columns.length !== term.columns.length) {
      throw new ParseError("再帰 CTE の seed と再帰項の列数を一致させてください", token);
    }
    if (columnAliases && columnAliases.length !== seed.columns.length) {
      throw new ParseError("CTE の列名リストと SELECT の列数を一致させてください", token);
    }
    if (seed.columns.some((column) => column.type === "WILDCARD" || column.type === "PARENT_WILDCARD") ||
        term.columns.some((column) => column.type === "WILDCARD" || column.type === "PARENT_WILDCARD")) {
      throw new ParseError("再帰 CTE の seed と再帰項では列を明示的に射影してください", token);
    }
    if (term.distinct || groupBy.length > 0 || term.grouping !== undefined || term.having !== null ||
        term.orderBy.length > 0 || term.orderMode !== "CANONICAL" || term.limit !== null || term.offset !== null) {
      throw new ParseError("再帰項では DISTINCT、集計、window、GROUP BY、HAVING、ORDER BY、LIMIT、OFFSET を使用できません", token);
    }
    if (term.joins.length !== 1 || term.joins[0].type !== "INNER") {
      throw new ParseError("再帰項は自己参照と物理 source または先行 CTE の INNER JOIN 1個で構成してください", token);
    }
    const relationNames = [term.from.cteName, term.joins[0].table.cteName];
    if (relationNames.filter((value) => value === name).length !== 1) {
      throw new ParseError("再帰項の INNER JOIN には自己参照をちょうど1回含めてください", token);
    }
    if (this.containsRecursiveForbiddenNode(term.columns) || this.containsRecursiveForbiddenNode(term.where)) {
      throw new ParseError("再帰項では集計、window、DISTINCT、subquery を使用できません", token);
    }

    const outputNames = columnAliases ?? seed.columns.map((column) => this.selectColumnOutputName(column));
    if (spec.cycle) {
      const cycleMatches = outputNames.filter((value) => value === spec.cycle!.column).length;
      if (cycleMatches !== 1) {
        throw new ParseError("CYCLE 列は再帰 CTE の出力列1個へ一意に解決できる必要があります", token);
      }
      if (outputNames.includes(spec.cycle.markColumn)) {
        throw new ParseError("CYCLE の mark 列は再帰 CTE の既存出力列と同名にできません", token);
      }
    }
  }

  private containsRecursiveForbiddenNode(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((item) => this.containsRecursiveForbiddenNode(item));
    if (value === null || typeof value !== "object") return false;
    const node = value as { type?: string; [key: string]: unknown };
    if (node.type === "AGGREGATE" || node.type === "AGG_REF" || node.type === "ARITH_AGG_COL" ||
        node.type === "WINDOW_COL" || node.type === "SCALAR_SUBQUERY" || node.type === "SCALAR_SUBQUERY_COL" ||
        node.type === "SUBQUERY_IN_LIST" || node.type === "EXISTS") return true;
    return Object.values(node).some((item) => this.containsRecursiveForbiddenNode(item));
  }

  private selectColumnOutputName(column: SelectColumn): string | null {
    if ("alias" in column && typeof column.alias === "string") return column.alias;
    if (column.type === "FIELD") return column.field;
    return null;
  }

  private parseGenerateSeries(): GenerateSeriesStatement {
    const name = this.advance();
    if (name.kind !== TokenKind.IDENT || name.value.toUpperCase() !== "GENERATE_SERIES") {
      throw new ParseError("GENERATE_SERIES が必要です", name);
    }
    this.expect(TokenKind.LPAREN);
    const args: GenerateSeriesArgument[] = [];
    if (this.peek().kind !== TokenKind.RPAREN) {
      do {
        const tok = this.peek();
        if (tok.kind === TokenKind.STRING) {
          this.advance();
          args.push({ type: "STRING", value: tok.value });
          continue;
        }
        if (tok.kind === TokenKind.VARIABLE) {
          this.advance();
          args.push({ type: "VARIABLE", name: tok.value.slice(1).toLowerCase() });
          continue;
        }
        let sign = "";
        if (tok.kind === TokenKind.PLUS || tok.kind === TokenKind.MINUS) {
          sign = tok.kind === TokenKind.MINUS ? "-" : "+";
          this.advance();
        }
        const number = this.peek();
        if (number.kind !== TokenKind.NUMBER) {
          throw new ParseError("GENERATE_SERIES の引数には数値、文字列、またはバッチ変数を指定してください", number);
        }
        this.advance();
        args.push(makeNumberLiteral(`${sign}${number.value}`));
      } while (this.consume(TokenKind.COMMA));
    }
    this.expect(TokenKind.RPAREN);
    const columnAlias = this.consume(TokenKind.AS) ? this.parseIdentifier() : "generate_series";
    return { type: "GENERATE_SERIES", args, columnAlias };
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

  private allowSelectArithVariable = false;

  private parseSelectArith<T>(parse: () => T): T {
    const previous = this.allowSelectArithVariable;
    this.allowSelectArithVariable = true;
    try {
      return parse();
    } finally {
      this.allowSelectArithVariable = previous;
    }
  }

  private parseSelectColumn(): SelectColumn {
    // *
    if (this.consume(TokenKind.STAR)) {
      return { type: "WILDCARD" };
    }

    if (this.isUnsupportedGroupingIdStart()) {
      throw new ParseError("B65: GROUPING_ID is not supported in Phase1.", this.peek());
    }
    if (this.isGroupingFunctionStart()) {
      const ref = this.parseGroupingRef();
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "GROUPING_COL", ref, alias: parsedAlias?.alias ?? null }, parsedAlias);
    }

    const valueWindowFunc = this.tryValueWindowFunc();
    if (valueWindowFunc !== null) {
      return this.parseValueWindowColumn(valueWindowFunc);
    }

    if (this.tryAggregateFunc() === null && this.hasNestedAggregateWindowInSelectColumn()) {
      throw new ParseError(
        WINDOW_RESULT_IN_EXPRESSION_MESSAGE,
        this.peek()
      );
    }

    if (this.isNonAggregateArithmeticStartWithAggregate()) {
      throw new ParseError(
        `集計算術式は集計関数から始まる必要があります（${this.peek().value}）。`,
        this.peek()
      );
    }

    // `||` のない既存列は従来 AST を維持する。
    if (this.tryAggregateFunc() === null && this.hasTopLevelTokenBeforeValueEnd(TokenKind.CONCAT_OP)) {
      const expr = this.parseScalarValueExpr({ allowAggregateArgs: true });
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "SCALAR_VALUE_COL", expr, alias: parsedAlias?.alias ?? null } satisfies ScalarValueColumn, parsedAlias);
    }

    // Must remain after CONCAT_OP detection: @x || field keeps its legacy path.
    if (this.peek().kind === TokenKind.VARIABLE) {
      const variable = this.advance();
      if (!this.consume(TokenKind.AS)) {
        throw new ParseError("SELECT 列のバッチ変数には AS alias が必要です", this.peek());
      }
      const parsedAlias = this.parseAliasName();
      return this.withAliasDisplay({
        type: "VARIABLE_COL",
        name: variable.value.slice(1).toLowerCase(),
        alias: parsedAlias.alias,
      } satisfies VariableColumn, parsedAlias);
    }

    const windowFunc = this.tryWindowFunc();
    if (windowFunc !== null) {
      return this.parseWindowColumn(windowFunc);
    }

    // CASE WHEN ... END [AS alias]
    if (this.peek().kind === TokenKind.CASE) {
      const expr = this.parseCaseWhenExpr(true);
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "CASE_COL", expr, alias: parsedAlias?.alias ?? null } satisfies CaseColumn, parsedAlias);
    }

    // IF(cond, then, else) [AS alias] → CASE WHEN として処理
    if (this.peek().kind === TokenKind.IF) {
      const expr = this.parseIfExpr(true);
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "CASE_COL", expr, alias: parsedAlias?.alias ?? null } satisfies CaseColumn, parsedAlias);
    }

    // 文字列関数: UPPER / LOWER / TRIM / ... [AS alias]
    // 関数の後に算術演算子が続く場合は ArithColumn (例: ROUND(金額)/2)
    if (this.tryStringFuncName() !== null) {
      const funcExpr = this.parseStringFuncExpr();
      if (this.isArithOp(this.peek().kind)) {
        const node = this.parseSelectArith(() => this.continueArith(funcExpr));
        const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
        return this.withAliasDisplay({ type: "ARITH_COL", expr: node, alias: parsedAlias?.alias ?? null }, parsedAlias);
      }
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "STRFUNC_COL", expr: funcExpr, alias: parsedAlias?.alias ?? null } satisfies StringFuncColumn, parsedAlias);
    }

    // 集計関数: COUNT / SUM / AVG / MAX / MIN / GROUP_CONCAT
    // 後続に算術演算子があれば → ARITH_AGG_COL (例: SUM(金額) * 1.1)
    const aggFunc = this.tryAggregateFunc();
    if (aggFunc !== null) {
      const ref = this.parseAggregateRef(aggFunc);
      if (this.isSoftKeyword("OVER")) {
        return this.parseAggregateWindowColumn(ref);
      }
      if (this.isArithOp(this.peek().kind)) {
        const expr = this.continueAggArith(ref);
        const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
        return this.withAliasDisplay({ type: "ARITH_AGG_COL", expr, alias: parsedAlias?.alias ?? null } satisfies AggArithColumn, parsedAlias);
      }
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({
        type: "AGGREGATE",
        func: ref.func,
        distinct: ref.distinct,
        arg: ref.arg,
        ...(ref.separator !== undefined ? { separator: ref.separator } : {}),
        alias: parsedAlias?.alias ?? null,
      } satisfies AggregateColumn, parsedAlias);
    }

    // スカラーサブクエリ: ( SELECT ... ) [AS alias]
    if (this.peek().kind === TokenKind.LPAREN && this.peekAt(1).kind === TokenKind.SELECT) {
      this.advance(); // ( を消費
      const query = this.parseSelect();
      this.expect(TokenKind.RPAREN);
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "SCALAR_SUBQUERY_COL", query, alias: parsedAlias?.alias ?? null }, parsedAlias);
    }

    // 文字列リテラル列: 'XXX' [AS alias]
    if (this.peek().kind === TokenKind.STRING) {
      const value = this.expect(TokenKind.STRING).value;
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "LITERAL_COL", value, alias: parsedAlias?.alias ?? null }, parsedAlias);
    }

    // 算術式が ( または数値リテラルで始まる場合
    if (
      this.peek().kind === TokenKind.LPAREN ||
      this.peek().kind === TokenKind.NUMBER
    ) {
      const node = this.parseSelectArith(() => this.parseArithAddSub());
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "ARITH_COL", expr: node, alias: parsedAlias?.alias ?? null }, parsedAlias);
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
      const node = this.parseSelectArith(() => this.continueArith(left));
      const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
      return this.withAliasDisplay({ type: "ARITH_COL", expr: node, alias: parsedAlias?.alias ?? null }, parsedAlias);
    }

    const parsedAlias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
    return this.withAliasDisplay({ type: "FIELD", field, alias: parsedAlias?.alias ?? null }, parsedAlias);
  }

  private tryWindowFunc(): WindowFunc | null {
    return PARSER_WINDOW_FUNCTION_TOKEN_MAP[this.peek().kind] ?? null;
  }

  private tryValueWindowFunc(index = this.pos): ValueWindowFunc | null {
    const token = this.tokens[index];
    if (token?.kind !== TokenKind.IDENT || this.tokens[index + 1]?.kind !== TokenKind.LPAREN) return null;
    const name = token.value.toUpperCase();
    if (name !== "LAG" && name !== "LEAD") return null;
    let depth = 0;
    for (let cursor = index + 1; cursor < this.tokens.length; cursor++) {
      const candidate = this.tokens[cursor];
      if (candidate.kind === TokenKind.LPAREN) depth++;
      else if (candidate.kind === TokenKind.RPAREN && --depth === 0) {
        const next = this.tokens[cursor + 1];
        return next?.kind === TokenKind.IDENT && next.value.toUpperCase() === "OVER"
          ? name as ValueWindowFunc
          : null;
      }
    }
    return null;
  }

  private hasNestedAggregateWindowInSelectColumn(): boolean {
    let depth = 0;
    for (let index = this.pos; index < this.tokens.length; index++) {
      const token = this.tokens[index];
      if (depth === 0 && (token.kind === TokenKind.COMMA || token.kind === TokenKind.FROM
        || token.kind === TokenKind.SEMICOLON || token.kind === TokenKind.EOF)) return false;
      if (PARSER_AGGREGATE_FUNCTION_TOKEN_MAP[token.kind] !== undefined
        && this.tokens[index + 1]?.kind === TokenKind.LPAREN) {
        let aggregateDepth = 0;
        for (let cursor = index + 1; cursor < this.tokens.length; cursor++) {
          const candidate = this.tokens[cursor];
          if (candidate.kind === TokenKind.LPAREN) aggregateDepth++;
          else if (candidate.kind === TokenKind.RPAREN && --aggregateDepth === 0) {
            const next = this.tokens[cursor + 1];
            if (next?.kind === TokenKind.IDENT && next.value.toUpperCase() === "OVER") return true;
            break;
          }
        }
      }
      if (this.tryValueWindowFunc(index) !== null) return true;
      if (token.kind === TokenKind.LPAREN) depth++;
      else if (token.kind === TokenKind.RPAREN) depth--;
    }
    return false;
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
      ? (this.expect(TokenKind.BY), this.parseOrderBy(false))
      : [];
    this.expect(TokenKind.RPAREN);

    if (!this.consume(TokenKind.AS)) {
      throw new ParseError("ウィンドウ関数には AS alias が必要です", this.peek());
    }
    const parsedAlias = this.parseAliasName();
    return this.withAliasDisplay({ type: "WINDOW_COL", func, partitionBy, orderBy, alias: parsedAlias.alias }, parsedAlias);
  }

  private parseValueWindowColumn(valueFunc: ValueWindowFunc): ValueWindowColumn {
    this.advance(); // LAG / LEAD (soft keyword IDENT)
    this.expect(TokenKind.LPAREN);
    const arg = this.parseScalarValueExpr({ allowCase: true, allowAggregateArgs: false });
    let offset = 1;
    if (this.consume(TokenKind.COMMA)) {
      const token = this.expect(TokenKind.NUMBER, `${valueFunc} の offset は非負の整数リテラルだけです`);
      offset = Number(token.value);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new ParseError(`${valueFunc} の offset は非負の safe integer リテラルだけです`, token);
      }
    }
    this.expect(TokenKind.RPAREN, `${valueFunc} は expr と省略可能な offset の 2 引数までです`);
    this.expectSoftKeyword("OVER", `${valueFunc} には OVER (...) が必要です`);
    this.expect(TokenKind.LPAREN);

    const partitionBy: FieldRef[] = [];
    if (this.isSoftKeyword("PARTITION")) {
      this.advance();
      this.expect(TokenKind.BY, "PARTITION の後には BY が必要です");
      do {
        const field = this.parseQualifiedIdent();
        partitionBy.push({ type: "FIELD", tableAlias: field.tableAlias, field: field.field });
      } while (this.consume(TokenKind.COMMA));
    }
    if (!this.consume(TokenKind.ORDER)) {
      throw new ParseError(`${valueFunc} の OVER には ORDER BY が必要です`, this.peek());
    }
    this.expect(TokenKind.BY);
    const orderBy = this.parseOrderBy(false);
    this.expect(TokenKind.RPAREN);

    if (this.isArithOp(this.peek().kind) || this.peek().kind === TokenKind.CONCAT_OP) {
      throw new ParseError(WINDOW_RESULT_IN_EXPRESSION_MESSAGE, this.peek());
    }
    if (!this.consume(TokenKind.AS)) {
      throw new ParseError("ウィンドウ関数には AS alias が必要です", this.peek());
    }
    const parsedAlias = this.parseAliasName();
    return this.withAliasDisplay({
      type: "WINDOW_COL", windowKind: "VALUE", valueFunc, arg, offset,
      partitionBy, orderBy, alias: parsedAlias.alias,
    }, parsedAlias);
  }

  private parseAggregateWindowColumn(ref: AggregateRef): AggregateWindowColumn {
    const supported = new Set<AggregateFunc>(["SUM", "COUNT", "AVG", "MIN", "MAX"]);
    if (!supported.has(ref.func)) {
      throw new ParseError(
        `${ref.func} のウィンドウ集計は未対応です。対応は SUM / COUNT / AVG / MIN / MAX です`,
        this.peek()
      );
    }
    if (ref.distinct) {
      throw new ParseError("ウィンドウ集計では引数の DISTINCT を使用できません", this.peek());
    }

    this.advance(); // OVER
    this.expect(TokenKind.LPAREN);
    const partitionBy: FieldRef[] = [];
    if (this.isSoftKeyword("PARTITION")) {
      this.advance();
      this.expect(TokenKind.BY, "PARTITION の後には BY が必要です");
      do {
        const field = this.parseQualifiedIdent();
        partitionBy.push({ type: "FIELD", tableAlias: field.tableAlias, field: field.field });
      } while (this.consume(TokenKind.COMMA));
    }

    const orderBy = this.consume(TokenKind.ORDER)
      ? (this.expect(TokenKind.BY), this.parseOrderBy(false))
      : [];
    let frame: WindowFrame | null = orderBy.length > 0
      ? { unit: "RANGE", source: "DEFAULT" }
      : null;
    if (this.isSoftKeyword("ROWS") || this.isSoftKeyword("RANGE")) {
      if (orderBy.length === 0) {
        throw new ParseError("フレーム句には OVER (ORDER BY ...) が必要です", this.peek());
      }
      const unit = this.advance().value.toUpperCase() as WindowFrame["unit"];
      const valid = this.consume(TokenKind.BETWEEN)
        && this.consumeSoftKeyword("UNBOUNDED")
        && this.consumeSoftKeyword("PRECEDING")
        && this.consume(TokenKind.AND)
        && this.consumeSoftKeyword("CURRENT")
        && this.consumeSoftKeyword("ROW");
      if (!valid) {
        throw new ParseError(
          "対応するフレームは BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW だけです",
          this.peek()
        );
      }
      frame = { unit, source: "EXPLICIT" };
    }
    this.expect(TokenKind.RPAREN);

    if (this.isArithOp(this.peek().kind)) {
      throw new ParseError(
        WINDOW_RESULT_IN_EXPRESSION_MESSAGE,
        this.peek()
      );
    }
    if (!this.consume(TokenKind.AS)) {
      throw new ParseError("ウィンドウ関数には AS alias が必要です", this.peek());
    }
    const parsedAlias = this.parseAliasName();
    return this.withAliasDisplay({
      type: "WINDOW_COL",
      windowKind: "AGGREGATE",
      aggFunc: ref.func as WindowAggFunc,
      arg: ref.arg,
      frame,
      partitionBy,
      orderBy,
      alias: parsedAlias.alias,
    }, parsedAlias);
  }

  private selectColumnHasAggregate(column: SelectColumn): boolean {
    if (column.type === "AGGREGATE" || column.type === "ARITH_AGG_COL") return true;
    if (column.type === "STRFUNC_COL") return column.expr.args.some((arg) => this.stringFuncArgHasAggregate(arg));
    if (column.type === "SCALAR_VALUE_COL") return this.scalarValueHasAggregate(column.expr);
    if (column.type === "CASE_COL") return this.nodeHasAggregate(column.expr);
    return false;
  }

  private nodeHasAggregate(node: unknown): boolean {
    if (node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((value) => this.nodeHasAggregate(value));
    const value = node as Record<string, unknown>;
    if (value["type"] === "AGG_REF" || value["type"] === "AGG_ARITH") return true;
    if (value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY") return false;
    return Object.values(value).some((child) => this.nodeHasAggregate(child));
  }

  private stringFuncArgHasAggregate(arg: StringFuncArg): boolean {
    if (arg.type === "AGG_REF" || arg.type === "AGG_ARITH") return true;
    if (arg.type === "AGG_GROUP_KEY" || arg.type === "VARIABLE") return false;
    return this.scalarValueHasAggregate(arg);
  }

  private scalarValueHasAggregate(expr: ScalarValueExpr): boolean {
    if (expr.type === "STRING_FUNC") return expr.args.some((arg) => this.stringFuncArgHasAggregate(arg));
    if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
      return this.scalarValueHasAggregate(expr.left) || this.scalarValueHasAggregate(expr.right);
    }
    if (expr.type === "CASE_WHEN") {
      return this.nodeHasAggregate(expr);
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

  /** 集計算術式の一次式: 集計関数 / 数値 / 変数 / GROUP BY キー候補 / 括弧 */
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
      if (operand.type === "NUMBER") return makeNumberLiteral(`-${numberLiteralText(operand)}`);
      return { type: "AGG_ARITH", left: makeNumberLiteral("0"), op: "-", right: operand };
    }
    // 数値リテラル
    if (this.peek().kind === TokenKind.NUMBER) {
      const tok = this.advance();
      return makeNumberLiteral(tok.value);
    }
    // バッチ変数（既存 resolver が AGG_ARITH の子を NUMBER へ置換する）
    if (this.peek().kind === TokenKind.VARIABLE) {
      const tok = this.advance();
      return { type: "VARIABLE", name: tok.value.slice(1).toLowerCase() } satisfies VariableRef;
    }
    // 集計関数
    const aggFunc = this.tryAggregateFunc();
    if (aggFunc !== null) {
      const ref = this.parseAggregateRef(aggFunc);
      this.rejectAggregateWindowOutsideSelect();
      return ref;
    }
    // ordinary GROUP BY キー候補。membership は SELECT 全体を読み終えた後に検証する。
    if (this.peek().kind === TokenKind.IDENT || this.peek().kind === TokenKind.BIDENT) {
      const tok = this.peek();
      const parsed = this.parseQualifiedIdent();
      const ref: AggGroupKeyRef = {
        type: "AGG_GROUP_KEY",
        field: parsed.field,
        ...(parsed.tableAlias ? { tableAlias: parsed.tableAlias } : {}),
      };
      this.aggregateGroupKeyTokens.set(ref, tok);
      return ref;
    }
    throw new ParseError("集計算術式には集計関数または数値が必要です", this.peek());
  }

  /** B124 Phase 1 はトップレベルの非集計オペランド開始形を明示拒否する。 */
  private isNonAggregateArithmeticStartWithAggregate(): boolean {
    const first = this.peek();
    if (this.tryAggregateFunc() !== null || first.kind === TokenKind.CASE || first.kind === TokenKind.IF) return false;
    if (this.isGroupingFunctionStart()) return false;
    if (this.tryStringFuncName() !== null) return false;
    if (![TokenKind.IDENT, TokenKind.BIDENT, TokenKind.VARIABLE, TokenKind.LPAREN].includes(first.kind)) return false;
    let depth = 0;
    let sawArithmetic = false;
    for (let index = this.pos; index < this.tokens.length; index++) {
      const token = this.tokens[index];
      if (depth === 0 && index > this.pos && (
        token.kind === TokenKind.COMMA || token.kind === TokenKind.AS || token.kind === TokenKind.FROM
        || token.kind === TokenKind.SEMICOLON || token.kind === TokenKind.EOF
        || token.kind === TokenKind.EQ || token.kind === TokenKind.NEQ || token.kind === TokenKind.LT_GT
        || token.kind === TokenKind.GT || token.kind === TokenKind.LT || token.kind === TokenKind.GTE
        || token.kind === TokenKind.LTE || token.kind === TokenKind.AND || token.kind === TokenKind.OR
      )) break;
      if (this.isArithOp(token.kind)) sawArithmetic = true;
      if (PARSER_AGGREGATE_FUNCTION_TOKEN_MAP[token.kind] !== undefined
        && this.tokens[index + 1]?.kind === TokenKind.LPAREN) return sawArithmetic;
      if (token.kind === TokenKind.LPAREN) depth++;
      else if (token.kind === TokenKind.RPAREN) {
        depth--;
        if (depth < 0) break;
      }
    }
    return false;
  }

  /** SELECT ローカルの B124 leaf だけを ordinary GROUP BY の表記と照合する。 */
  private validateAggregateGroupKeyRefs(
    columns: SelectColumn[],
    having: WhereExpr | null,
    groupBy: GroupByKey[],
    grouping: GroupingSpec | undefined
  ): void {
    const refs: AggGroupKeyRef[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node === null || typeof node !== "object") return;
      const value = node as Record<string, unknown>;
      // 入れ子 SELECT は自身の parseSelect で既に検証済み。外側 scope へ混ぜない。
      if (value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY") return;
      if (value["type"] === "AGG_GROUP_KEY") {
        refs.push(node as AggGroupKeyRef);
        return;
      }
      Object.values(value).forEach(visit);
    };
    visit(columns);
    visit(having);
    if (refs.length === 0) return;

    const first = refs[0];
    const firstToken = this.aggregateGroupKeyTokens.get(first) ?? this.peek();
    if (grouping !== undefined) {
      throw new ParseError(
        "ROLLUP / CUBE / GROUPING SETS では集計算術式にフィールドを書けません（小計・総計行で値が定まらないためです）。",
        firstToken
      );
    }
    if (groupBy.length === 0) {
      throw new ParseError(
        `集計算術式にフィールドを書くには GROUP BY が必要です（${this.aggregateGroupKeyDisplay(first)}）。`,
        firstToken
      );
    }
    const ordinaryNames = new Set(groupBy.filter((key): key is Extract<GroupByKey, { type: "FIELD_NAME" }> =>
      key.type === "FIELD_NAME").map((key) => key.name));
    for (const ref of refs) {
      const display = this.aggregateGroupKeyDisplay(ref);
      if (!ordinaryNames.has(display)) {
        throw new ParseError(
          `集計算術式のフィールド参照は GROUP BY に書いた表記と一致する列だけです（${display}）。グループ内で値が定まらないためです。`,
          this.aggregateGroupKeyTokens.get(ref) ?? firstToken
        );
      }
    }
  }

  private aggregateGroupKeyDisplay(ref: AggGroupKeyRef): string {
    return ref.tableAlias ? `${ref.tableAlias}.${ref.field}` : ref.field;
  }

  // ──────────────────────────────────────────────────
  // 汎用スカラー値式パーサー（B38）
  // ──────────────────────────────────────────────────

  /** 比較・述語・集約・サブクエリを含まない値式の公開入口。 */
  public parseScalarValueExpr(options: { allowCase?: boolean; allowAggregateArgs?: boolean } = {}): ScalarValueExpr {
    const previousAggregateArgs = this.scalarAllowsAggregateArgs;
    const previousCase = this.scalarAllowsCase;
    this.scalarAllowsAggregateArgs = options.allowAggregateArgs === true;
    this.scalarAllowsCase = options.allowCase !== false;
    let expr: ScalarValueExpr;
    try {
      expr = this.parseScalarAddSubConcat(this.scalarAllowsCase);
    } finally {
      this.scalarAllowsAggregateArgs = previousAggregateArgs;
      this.scalarAllowsCase = previousCase;
    }
    const next = this.peek();
    if (
      next.kind === TokenKind.IS ||
      next.kind === TokenKind.EQ || next.kind === TokenKind.NEQ || next.kind === TokenKind.LT_GT ||
      next.kind === TokenKind.GT || next.kind === TokenKind.LT || next.kind === TokenKind.GTE || next.kind === TokenKind.LTE ||
      next.kind === TokenKind.LIKE || next.kind === TokenKind.KLIKE || next.kind === TokenKind.IN || next.kind === TokenKind.BETWEEN
    ) throw new ParseError("スカラー値式に比較・述語は使用できません", next);
    return expr;
  }

  private parseScalarAddSubConcat(allowCase: boolean): ScalarValueExpr {
    let left = this.parseScalarMulDiv(allowCase);
    while (this.peek().kind === TokenKind.PLUS || this.peek().kind === TokenKind.MINUS || this.peek().kind === TokenKind.CONCAT_OP) {
      const token = this.advance();
      const right = this.parseScalarMulDiv(allowCase);
      left = token.kind === TokenKind.CONCAT_OP
        ? { type: "CONCAT_OP", left, right } satisfies ConcatExpr
        : { type: "SCALAR_ARITH", left, op: token.kind === TokenKind.PLUS ? "+" : "-", right };
    }
    return left;
  }

  private parseScalarMulDiv(allowCase: boolean): ScalarValueExpr {
    let left = this.parseScalarPrimary(allowCase);
    while (this.peek().kind === TokenKind.STAR || this.peek().kind === TokenKind.SLASH || this.peek().kind === TokenKind.PERCENT) {
      const token = this.advance();
      const op: ArithOp = token.kind === TokenKind.STAR ? "*" : token.kind === TokenKind.SLASH ? "/" : "%";
      left = { type: "SCALAR_ARITH", left, op, right: this.parseScalarPrimary(allowCase) };
    }
    return left;
  }

  private parseScalarPrimary(allowCase: boolean): ScalarValueExpr {
    const tok = this.peek();
    if (tok.kind === TokenKind.LPAREN) {
      if (this.peekAt(1).kind === TokenKind.SELECT) throw new ParseError("スカラー値式にサブクエリは使用できません", tok);
      this.advance();
      const expr = this.parseScalarAddSubConcat(allowCase);
      this.expect(TokenKind.RPAREN);
      return expr;
    }
    if (tok.kind === TokenKind.PLUS || tok.kind === TokenKind.MINUS) {
      this.advance();
      if (this.peek().kind === TokenKind.PLUS || this.peek().kind === TokenKind.MINUS) {
        throw new ParseError("単項符号を重ねて指定することはできません", this.peek());
      }
      const operand = this.parseScalarPrimary(allowCase);
      if (operand.type === "NUMBER") {
        return makeNumberLiteral(`${tok.kind === TokenKind.MINUS ? "-" : "+"}${numberLiteralText(operand)}`);
      }
      if (tok.kind === TokenKind.PLUS) throw new ParseError("単項 + の直後には数値リテラルが必要です", tok);
      return { type: "SCALAR_ARITH", left: makeNumberLiteral("0"), op: "-", right: operand };
    }
    if (tok.kind === TokenKind.STRING) { this.advance(); return { type: "STRING", value: tok.value }; }
    if (tok.kind === TokenKind.NUMBER) { this.advance(); return makeNumberLiteral(tok.value); }
    if (tok.kind === TokenKind.VARIABLE) { this.advance(); return { type: "VARIABLE", name: tok.value.slice(1).toLowerCase() }; }
    if (tok.kind === TokenKind.CASE) {
      if (!allowCase) throw new ParseError("このスカラー値式では CASE を使用できません", tok);
      return this.parseCaseWhenExpr();
    }
    if (this.tryAggregateFunc() !== null) {
      throw new ParseError(
        this.insideAggregateArg > 0
          ? "集計関数の引数内に集計関数は使用できません"
          : "スカラー値式に集約関数は使用できません",
        tok
      );
    }
    if (this.tryStringFuncName() !== null) return this.parseStringFuncExpr();
    if (tok.kind === TokenKind.IDENT || tok.kind === TokenKind.BIDENT) {
      this.advance();
      if (this.consume(TokenKind.DOT)) return { type: "FIELD", tableAlias: tok.value, field: this.parseIdentifier() };
      return { type: "FIELD", tableAlias: null, field: tok.value };
    }
    throw new ParseError("スカラー値式のオペランドが必要です", tok);
  }

  /** 現在の値の終端までに指定トークンがあるか（括弧内も対象）。 */
  private hasTopLevelTokenBeforeValueEnd(target: TokenKind): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const kind = this.tokens[i].kind;
      if (kind === TokenKind.LPAREN || kind === TokenKind.LBRACKET) depth++;
      else if (kind === TokenKind.RPAREN || kind === TokenKind.RBRACKET) {
        if (depth === 0) break;
        depth--;
      }
      if (kind === target) return true;
      if (depth === 0 && (
        kind === TokenKind.COMMA || kind === TokenKind.AS || kind === TokenKind.FROM || kind === TokenKind.WHERE ||
        kind === TokenKind.WHEN || kind === TokenKind.THEN || kind === TokenKind.ELSE || kind === TokenKind.END ||
        kind === TokenKind.SEMICOLON || kind === TokenKind.EOF
      )) break;
    }
    return false;
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
      return makeNumberLiteral(`+${number.value}`);
    }
    // 単項マイナス: -expr（符号のネストは受理しない）
    if (this.peek().kind === TokenKind.MINUS) {
      this.advance();
      if (this.peek().kind === TokenKind.MINUS || this.peek().kind === TokenKind.PLUS) {
        throw new ParseError("単項符号を重ねて指定することはできません", this.peek());
      }
      const operand = this.parseArithPrimary();
      // 数値リテラルは即座に符号反転
      if (operand.type === "NUMBER") return makeNumberLiteral(`-${numberLiteralText(operand)}`);
      // それ以外は 0 - operand に展開
      return { type: "ARITH", left: makeNumberLiteral("0"), op: "-", right: operand };
    }
    // 文字列・数値関数 (ROUND / LENGTH / UPPER / ...) → StringFuncExpr as ArithNode
    if (this.tryStringFuncName() !== null) {
      return this.parseStringFuncExpr();
    }
    const tok = this.peek();
    if (tok.kind === TokenKind.NUMBER) {
      this.advance();
      return makeNumberLiteral(tok.value);
    }
    if (this.allowSelectArithVariable && tok.kind === TokenKind.VARIABLE) {
      this.advance();
      return { type: "VARIABLE", name: tok.value.slice(1).toLowerCase() };
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
  private parseIfExpr(allowGroupingCondition = false): CaseWhenExpr {
    this.advance(); // IF を消費
    this.expect(TokenKind.LPAREN);
    const condition = this.parseCaseCondition(allowGroupingCondition);
    this.expect(TokenKind.COMMA);
    const thenResult = this.parseCaseResult(allowGroupingCondition);
    this.expect(TokenKind.COMMA);
    const elseResult = this.parseCaseResult(allowGroupingCondition);
    this.expect(TokenKind.RPAREN);
    return {
      type: "CASE_WHEN",
      branches: [{ condition, result: thenResult }],
      elseResult,
    };
  }

  private parseCaseWhenExpr(allowGroupingCondition = false): CaseWhenExpr {
    this.expect(TokenKind.CASE);
    const branches: CaseWhenClause[] = [];

    while (this.peek().kind === TokenKind.WHEN) {
      this.advance(); // WHEN を消費
      const condition = this.parseCaseCondition(allowGroupingCondition);
      this.expect(TokenKind.THEN);
      const result = this.parseCaseResult(allowGroupingCondition);
      branches.push({ condition, result });
    }

    if (branches.length === 0) {
      throw new ParseError("CASE の後には WHEN が最低 1 つ必要です", this.peek());
    }

    let elseResult: CaseResult | null = null;
    if (this.consume(TokenKind.ELSE)) {
      elseResult = this.parseCaseResult(allowGroupingCondition);
    }

    this.expect(TokenKind.END);
    return { type: "CASE_WHEN", branches, elseResult };
  }

  private parseCaseCondition(allowGroupingCondition: boolean): WhereExpr {
    if (!allowGroupingCondition) return this.parseWhereExpr();
    return this.parseWhereExpr("SELECT_CASE");
  }

  /** THEN / ELSE の結果値。`||` を含む場合だけ新スカラー文法へ渡す。 */
  private parseCaseResult(allowAggregateResult = false): CaseResult {
    const tok = this.peek();
    if (this.insideAggregateArg > 0 && this.tryAggregateFunc() !== null) {
      throw new ParseError("集計関数の引数内に集計関数は使用できません", tok);
    }
    // 配列リテラル: ['val1', 'val2'] → ArrayLiteral
    if (tok.kind === TokenKind.LBRACKET) {
      return this.parseArrayLiteral();
    }
    const aggregateFunc = this.tryAggregateFunc();
    if (aggregateFunc !== null && allowAggregateResult) {
      const ref = this.parseAggregateRef(aggregateFunc);
      this.rejectAggregateWindowOutsideSelect();
      return this.continueAggArith(ref) as AggregateRef | AggArithExpr;
    }
    if (this.hasTopLevelTokenBeforeValueEnd(TokenKind.CONCAT_OP)) {
      return this.parseScalarValueExpr({ allowAggregateArgs: true });
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
      const conditional = PARSER_SCALAR_FUNCTION_TOKEN_MAP[this.peek().kind];
      if (conditional === "LEFT" || conditional === "RIGHT") return conditional;
    }
    const byKind = PARSER_SCALAR_FUNCTION_TOKEN_MAP[this.peek().kind] ?? null;
    if (byKind !== null && byKind !== "LEFT" && byKind !== "RIGHT") return byKind;

    // キーワード登録なしの関数名: IDENT で名前を先読みし、直後に '(' がある場合のみ関数と判断
    if (this.peek().kind === TokenKind.IDENT) {
      const nameToken = this.peek();
      const name = nameToken.value.toUpperCase();
      if ((PARSER_IDENT_SCALAR_FUNCTIONS as readonly string[]).includes(name)) {
        // 1トークン先が '(' であれば関数呼び出し
        if (this.peekAt(1).kind === TokenKind.LPAREN) {
          return name as StringFuncName;
        }
      }
      if (this.peekAt(1).kind === TokenKind.LPAREN) {
        const hint = name === "DATE_SUB"
          ? "。日付を減算するには DATE_ADD の加算値へ負数を指定してください"
          : "";
        throw new ParseError(`「${nameToken.value}」という関数はありません${hint}`, nameToken);
      }
    }
    return null;
  }

  private parseStringFuncExpr(): StringFuncExpr {
    const nameToken = this.peek();
    const func = this.tryStringFuncName()!;
    try {
      return this.parseStringFuncExprBody();
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      const displayName = nameToken.value.toUpperCase();
      const guidance = func === "DATE_ADD"
        ? `${displayName} の構文は DATE_ADD(列, n, '単位') です。`
        : `${displayName} の引数構文が不正です。`;
      throw new ParseError(`${guidance}${error.rawMessage}`, error.token);
    }
  }

  private parseStringFuncExprBody(): StringFuncExpr {
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

  /** 文字列関数の引数: ScalarValueExpr / 集計算術式 */
  private parseStringFuncArg(): StringFuncArg {
    // 関数引数内では、集計式（例: SUM(金額), 100+SUM(金額)）を優先的に試す。
    // ただし集計関数を含まない式は従来どおり算術式として扱う。
    if (this.scalarAllowsAggregateArgs) {
      const startPos = this.pos;
      try {
        const left = this.parseAggPrimary();
        const expr = this.continueAggArith(left);
        if (this.hasAggregateOperand(expr)) return expr;
      } catch {
        // fallback: 通常のスカラー値式として解釈
      }
      this.pos = startPos;
    }
    return this.parseScalarAddSubConcat(this.scalarAllowsCase);
  }

  private hasAggregateOperand(node: AggOperand): boolean {
    if (node.type === "AGG_REF") return true;
    if (node.type === "AGG_ARITH") {
      return this.hasAggregateOperand(node.left) || this.hasAggregateOperand(node.right);
    }
    return false;
  }

  private tryAggregateFunc(): AggregateFunc | null {
    return PARSER_AGGREGATE_FUNCTION_TOKEN_MAP[this.peek().kind] ?? null;
  }

  /** 集計関数参照を読む。SELECT 列の alias は呼び出し側で式全体の後に処理する。 */
  private parseAggregateRef(func: AggregateFunc): AggregateRef {
    this.advance(); // 関数名トークンを消費
    this.expect(TokenKind.LPAREN);

    const distinct = this.consume(TokenKind.DISTINCT);
    const distinctToken = distinct ? this.prev() : null;
    if (func === "MODE" && distinctToken) {
      throw new ParseError("MODE では DISTINCT は使用できません", distinctToken);
    }

    let arg: AggregateColumn["arg"];
    if (this.consume(TokenKind.STAR)) {
      if (!aggregateAcceptsWildcard(func)) {
        throw new ParseError(`${func}(*) は使用できません。フィールドまたは式を指定してください`, this.prev());
      }
      arg = { type: "WILDCARD" };
    } else {
      arg = this.parseAggregateArgExpr();
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

  private isAggregateArgEnd(): boolean {
    return this.peek().kind === TokenKind.RPAREN || this.isSoftKeyword("SEPARATOR");
  }

  /** 旧算術 AST を優先し、新規形だけ ScalarValueExpr として読む。 */
  private parseAggregateArgExpr(): AggregateArgExpr {
    const start = this.pos;
    try {
      const legacy = this.parseArithAddSub();
      if (this.isAggregateArgEnd()) return legacy;
    } catch {
      // ScalarValueExpr で読み直す。
    }
    this.pos = start;
    this.insideAggregateArg++;
    try {
      let expr: ScalarValueExpr;
      try {
        expr = this.parseScalarValueExpr({ allowCase: true, allowAggregateArgs: false });
      } catch (error) {
        if (error instanceof ParseError) {
          if (error.message.includes("比較・述語")) {
            throw new ParseError(
              "集計関数の引数に比較・述語は使用できません。CASE で値を明示してください。例: SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END)",
              error.token
            );
          }
          if (error.message.includes("集約関数")) {
            throw new ParseError("集計関数の引数内に集計関数は使用できません", error.token);
          }
        }
        throw error;
      }
      if (!this.isAggregateArgEnd()) {
        throw new ParseError(
          "この集計関数の引数形式は使用できません。CASE で値を明示するか、CTE で式を列にしてから集計してください。",
          this.peek()
        );
      }
      this.assertNoNestedAggregate(expr);
      return expr;
    } finally {
      this.insideAggregateArg--;
    }
  }

  private assertNoNestedAggregate(expr: AggregateArgExpr): void {
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      const node = value as { type?: string; [key: string]: unknown };
      if (node.type === "AGG_REF" || node.type === "AGG_ARITH") {
        throw new ParseError("集計関数の引数内に集計関数は使用できません", this.peek());
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(expr);
  }

  // ----------------------------------------------------------
  // FROM / JOIN
  // ----------------------------------------------------------

  private parseTableRef(): TableRef {
    const nameTok = this.peek();
    if (nameTok.kind === TokenKind.IDENT && nameTok.value.toUpperCase() === "GENERATE_SERIES" && this.peekAt(1).kind === TokenKind.LPAREN) {
      throw new ParseError(
        "GENERATE_SERIES は WITH の CTE 本体に書いてください。例: WITH s AS (GENERATE_SERIES(1, 5)) SELECT generate_series FROM s",
        nameTok
      );
    }
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
    if (this.activeCteDefinition?.name === name) {
      if (this.activeCteDefinition.recursiveWith && this.activeCteDefinition.phase === "RECURSIVE_TERM" &&
          this.provisionalRecursiveCte?.name === name) {
        this.provisionalRecursiveCte.references++;
        const alias = this.consume(TokenKind.AS) ? this.parseTableAliasName() : this.tryParseImplicitAlias();
        return { appId: 0, alias, cteName: name };
      }
      const message = this.activeCteDefinition.recursiveWith
        ? this.activeCteDefinition.phase === "RECURSIVE_TERM"
          ? "再帰 CTE は seed SELECT UNION ALL recursive SELECT の2分岐で指定してください"
          : "再帰 CTE の seed から自分自身を参照できません"
        : "CTE の定義内から自分自身を参照しています。自己参照には `WITH RECURSIVE` が必要です";
      throw new ParseError(message, nameTok);
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
      if (
        k === TokenKind.IDENT &&
        this.peek().value.toUpperCase() === "CHECK" &&
        this.peekAt(1).kind === TokenKind.WHEN
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
      if (joinType === "CROSS") {
        if (this.peek().kind === TokenKind.ON) {
          throw new ParseError("CROSS JOIN に ON 句は指定できません。", this.peek());
        }
        joins.push({ type: "CROSS", table, on: null });
        continue;
      }
      this.expect(TokenKind.ON);
      const on = this.parseJoinCondition();
      joins.push({ type: joinType, table, on });
    }
    return joins;
  }

  private tryJoinType(): JoinType | null {
    if (this.consume(TokenKind.INNER)) {
      if (this.peek().kind === TokenKind.CROSS) {
        throw new ParseError("CROSS JOIN に INNER は指定できません。", this.peek());
      }
      this.expect(TokenKind.JOIN);
      return "INNER";
    }
    if (this.consume(TokenKind.LEFT)) {
      if (this.peek().kind === TokenKind.CROSS) {
        throw new ParseError("CROSS JOIN に LEFT / RIGHT は指定できません。", this.peek());
      }
      this.expect(TokenKind.JOIN);
      return "LEFT";
    }
    if (this.consume(TokenKind.RIGHT)) {
      if (this.peek().kind === TokenKind.CROSS) {
        throw new ParseError("CROSS JOIN に LEFT / RIGHT は指定できません。", this.peek());
      }
      this.expect(TokenKind.JOIN);
      return "RIGHT";
    }
    if (this.consume(TokenKind.CROSS)) {
      this.expect(TokenKind.JOIN);
      return "CROSS";
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

  private parseWhereExpr(
    groupingFieldContext: GroupingFieldContext | undefined = this.groupingFieldContext,
    allowRelativeDateFunctions: boolean = this.allowRelativeDateFunctions
  ): WhereExpr {
    const previousContext = this.groupingFieldContext;
    const previousAllowRelativeDateFunctions = this.allowRelativeDateFunctions;
    this.groupingFieldContext = groupingFieldContext ?? previousContext;
    this.allowRelativeDateFunctions = allowRelativeDateFunctions;
    try {
      return this.parseOrExpr();
    } finally {
      this.groupingFieldContext = previousContext;
      this.allowRelativeDateFunctions = previousAllowRelativeDateFunctions;
    }
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
      const low  = this.parseWhereSqlValue();
      this.expect(TokenKind.AND);
      const high = this.parseWhereSqlValue();
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
        const right = this.parseInRight();
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
      const right = this.parseInRight();
      return { type: "BINARY", op: "IN", left: field, right } satisfies BinaryExpr;
    }

    // KLIKE は kintone キーワード検索。右辺は文字列またはバッチ変数だけ。
    if (this.consume(TokenKind.KLIKE)) {
      const pattern = this.parseKlikePattern();
      return { type: "BINARY", op: "KLIKE", left: field, right: pattern } satisfies BinaryExpr;
    }

    // 比較演算子
    const op = this.parseCompareOp();
    const right = this.parseWhereSqlValue(op !== "LIKE");
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
    if (this.groupingFieldContext === "HAVING" && this.isNonAggregateArithmeticStartWithAggregate()) {
      throw new ParseError(
        `集計算術式は集計関数から始まる必要があります（${this.peek().value}）。`,
        this.peek()
      );
    }
    if (this.isUnsupportedGroupingIdStart()) {
      throw new ParseError("B65: GROUPING_ID is not supported in Phase1.", this.peek());
    }
    if (this.isGroupingFunctionStart()) {
      if (this.groupingFieldContext === "FORBIDDEN" || this.insideAggregateArg > 0) {
        throw new ParseError(
          "B65: GROUPING() is only allowed in SELECT, SELECT CASE conditions, HAVING, and direct ORDER BY.",
          this.peek()
        );
      }
      return { type: "GROUPING_FIELD", ref: this.parseGroupingRef() };
    }
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
      if (this.insideAggregateArg > 0) {
        throw new ParseError("集計関数の引数内に集計関数は使用できません", this.peek());
      }
      const ref = this.parseAggregateRef(aggFunc);
      this.rejectAggregateWindowOutsideSelect();
      if (this.isArithOp(this.peek().kind)) {
        return {
          type: "AGG_FIELD",
          expr: this.continueAggArith(ref),
        };
      }
      const syntheticName = aggregateSyntheticName(ref.func, ref.distinct, ref.arg);
      return {
        type: "FIELD",
        tableAlias: null,
        field: syntheticName,
        ...(this.groupingFieldContext === "SELECT_CASE" || this.groupingFieldContext === "HAVING"
          ? { aggregateRef: ref }
          : {}),
      };
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
  private parseWhereSqlValue(allowUnaryPlusNumberLiteral = true): SqlValue {
    const tok = this.peek();
    if (allowUnaryPlusNumberLiteral && tok.kind === TokenKind.PLUS) {
      this.advance();
      const number = this.expect(TokenKind.NUMBER, "単項 + の直後には数値リテラルが必要です");
      return makeNumberLiteral(`+${number.value}`);
    }
    if (
      this.allowRelativeDateFunctions
      && tok.kind === TokenKind.IDENT
      && this.peekAt(1).kind === TokenKind.LPAREN
      && isRelativeDateFunctionName(tok.value.toUpperCase())
    ) {
      return this.parseRelativeDateFunction();
    }
    return this.parseSqlValue();
  }

  private parseRelativeDateFunction(): RelativeDateFunction {
    const nameToken = this.expect(TokenKind.IDENT);
    const name = nameToken.value.toUpperCase();
    this.expect(TokenKind.LPAREN);

    switch (name) {
      case "YESTERDAY":
      case "TOMORROW":
      case "THIS_YEAR":
      case "LAST_YEAR":
      case "NEXT_YEAR":
        this.expect(TokenKind.RPAREN, `${name}() は引数を受け取りません`);
        return { type: "KINTONE_FUNC", name, args: { kind: "NONE" } };

      case "FROM_TODAY": {
        let sign = "";
        if (this.consume(TokenKind.MINUS)) sign = "-";
        if (this.peek().kind === TokenKind.PLUS) {
          throw new ParseError("FROM_TODAY の offset に + 符号は使用できません", this.peek());
        }
        const offsetToken = this.expect(
          TokenKind.NUMBER,
          "FROM_TODAY には整数 offset と単位が必要です"
        );
        if (!/^\d+$/.test(offsetToken.value)) {
          throw new ParseError("FROM_TODAY の offset は10進整数で指定してください", offsetToken);
        }
        const rawOffset = `${sign}${offsetToken.value}`;
        const offset = Number(rawOffset);
        if (!Number.isSafeInteger(offset)) {
          throw new ParseError("FROM_TODAY の offset は安全な整数の範囲で指定してください", offsetToken);
        }
        this.expect(TokenKind.COMMA, "FROM_TODAY の offset と単位はカンマで区切ってください");
        const unitToken = this.expect(
          TokenKind.IDENT,
          "FROM_TODAY の単位には非引用の DAYS / WEEKS / MONTHS / YEARS が必要です"
        );
        const unit = unitToken.value.toUpperCase();
        if (!isRelativeDatePeriodUnit(unit)) {
          throw new ParseError("FROM_TODAY の単位には DAYS / WEEKS / MONTHS / YEARS が必要です", unitToken);
        }
        this.expect(TokenKind.RPAREN, "FROM_TODAY は offset と単位の2引数だけを受け取ります");
        const offsetText = String(offset === 0 ? 0 : offset);
        return {
          type: "KINTONE_FUNC",
          name,
          args: { kind: "FROM_TODAY", offset, offsetText, unit },
        };
      }

      case "THIS_WEEK":
      case "LAST_WEEK":
      case "NEXT_WEEK": {
        let weekday: RelativeDateWeekday | null = null;
        if (this.peek().kind !== TokenKind.RPAREN) {
          const weekdayToken = this.expect(
            TokenKind.IDENT,
            `${name} の曜日には非引用の SUNDAY ... SATURDAY が必要です`
          );
          const candidate = weekdayToken.value.toUpperCase();
          if (!isRelativeDateWeekday(candidate)) {
            throw new ParseError(`${name} の曜日が不正です`, weekdayToken);
          }
          weekday = candidate;
        }
        this.expect(TokenKind.RPAREN, `${name} は曜日を最大1個だけ受け取ります`);
        return { type: "KINTONE_FUNC", name, args: { kind: "WEEK", weekday } };
      }

      case "THIS_MONTH":
      case "LAST_MONTH":
      case "NEXT_MONTH": {
        let day: RelativeDateMonthDay | "LAST" | null = null;
        if (this.peek().kind !== TokenKind.RPAREN) {
          const dayToken = this.peek();
          if (dayToken.kind === TokenKind.IDENT && dayToken.value.toUpperCase() === "LAST") {
            this.advance();
            day = "LAST";
          } else if (dayToken.kind === TokenKind.NUMBER && /^\d+$/.test(dayToken.value)) {
            this.advance();
            const candidate = Number(dayToken.value);
            if (!isRelativeDateMonthDay(candidate)) {
              throw new ParseError(`${name} の日は 1 から 31 で指定してください`, dayToken);
            }
            day = candidate;
          } else {
            throw new ParseError(`${name} の日は非引用の LAST または 1 から 31 が必要です`, dayToken);
          }
        }
        this.expect(TokenKind.RPAREN, `${name} は日を最大1個だけ受け取ります`);
        return { type: "KINTONE_FUNC", name, args: { kind: "MONTH", day } };
      }

      default:
        throw new ParseError(`未知の相対日付関数 ${name} です`, nameToken);
    }
  }

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
    if (isContextualFunctionToken(tok.kind)) {
      this.advance();
      this.expect(TokenKind.LPAREN);
      this.expect(TokenKind.RPAREN);
      return {
        type: "KINTONE_FUNC",
        name: PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP[tok.kind]!,
      } satisfies LegacyKintoneFunction;
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
      if (expr.type === "NUMBER") return expr satisfies NumberLiteral;
      return { type: "ARITH_VALUE", expr } satisfies ArithSqlValue;
    }

    throw new ParseError(
      "値（文字列・数値・フィールド参照・TODAY()・NOW()・LOGINUSER()）が必要です",
      tok
    );
  }

  // IN (...) — 値リストまたはサブクエリ
  private parseInRight(): InList | SubqueryInList | VariableInList {
    if (this.consume(TokenKind.LPAREN)) {
      const right = this.parseInListOrSubquery();
      this.expect(TokenKind.RPAREN);
      return right;
    }
    const variable = this.expect(
      TokenKind.VARIABLE,
      "IN / NOT IN の後には (値リストまたは SELECT) か配列変数が必要です"
    );
    return { type: "VARIABLE_IN_LIST", name: variable.value.slice(1).toLowerCase() };
  }

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
    const invalidValueMessage =
      "IN リストには文字列、数値、バッチ変数、または単独の LOGINUSER() が必要です";
    const mixedLoginUserMessage =
      "LOGINUSER() は IN / NOT IN リストの単独要素としてのみ使用できます";
    do {
      const tok = this.advance();
      if (tok.kind === TokenKind.STRING) {
        values.push({ type: "STRING", value: tok.value });
      } else if (tok.kind === TokenKind.NUMBER) {
        values.push(makeNumberLiteral(tok.value));
      } else if (tok.kind === TokenKind.MINUS || tok.kind === TokenKind.PLUS) {
        const number = this.peek();
        if (number.kind !== TokenKind.NUMBER) {
          throw new ParseError(invalidValueMessage, tok);
        }
        this.advance();
        const sign = tok.kind === TokenKind.MINUS ? "-" : "+";
        values.push(makeNumberLiteral(`${sign}${number.value}`));
      } else if (tok.kind === TokenKind.VARIABLE) {
        values.push({ type: "VARIABLE", name: tok.value.slice(1).toLowerCase() });
      } else if (tok.kind === TokenKind.LOGINUSER) {
        if (values.length > 0) {
          throw new ParseError(mixedLoginUserMessage, tok);
        }
        this.expect(TokenKind.LPAREN, "LOGINUSER の直後には空引数の () が必要です");
        this.expect(TokenKind.RPAREN, "LOGINUSER の直後には空引数の () が必要です");
        values.push({ type: "KINTONE_FUNC", name: "LOGINUSER" });
        if (this.peek().kind === TokenKind.COMMA) {
          throw new ParseError(mixedLoginUserMessage, this.peek());
        }
      } else if (tok.kind === TokenKind.PRIMARY_ORGANIZATION) {
        const mixedPrimaryOrganizationMessage =
          "PRIMARY_ORGANIZATION() は IN / NOT IN リストの単独要素としてのみ使用できます";
        if (values.length > 0) {
          throw new ParseError(mixedPrimaryOrganizationMessage, tok);
        }
        this.expect(
          TokenKind.LPAREN,
          "PRIMARY_ORGANIZATION の直後には空引数の () が必要です"
        );
        this.expect(
          TokenKind.RPAREN,
          "PRIMARY_ORGANIZATION の直後には空引数の () が必要です"
        );
        values.push({ type: "KINTONE_FUNC", name: "PRIMARY_ORGANIZATION" });
        if (this.peek().kind === TokenKind.COMMA) {
          throw new ParseError(mixedPrimaryOrganizationMessage, this.peek());
        }
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
      if (keys.length > 0 && (this.isRollupStart() || this.isGroupingSetsStart() || this.isCubeStart())) {
        throw new ParseError("B65: ordinary GROUP BY items cannot be mixed with grouping elements.", this.peek());
      }
      keys.push(this.parseGroupByKey());
    } while (this.consume(TokenKind.COMMA));
    return keys;
  }

  private isRollupStart(): boolean {
    return this.isSoftKeyword("ROLLUP") && this.peekAt(1).kind === TokenKind.LPAREN;
  }

  private isCubeStart(): boolean {
    return this.isSoftKeyword("CUBE") && this.peekAt(1).kind === TokenKind.LPAREN;
  }

  private isGroupingSetsStart(): boolean {
    return this.isSoftKeyword("GROUPING")
      && this.peekAt(1).kind === TokenKind.IDENT
      && this.peekAt(1).value.toUpperCase() === "SETS"
      && this.peekAt(2).kind === TokenKind.LPAREN;
  }

  private isGroupingFunctionStart(): boolean {
    return this.isSoftKeyword("GROUPING") && this.peekAt(1).kind === TokenKind.LPAREN;
  }

  private isUnsupportedGroupingIdStart(): boolean {
    return this.isSoftKeyword("GROUPING_ID") && this.peekAt(1).kind === TokenKind.LPAREN;
  }

  private groupingItemSyntaxKey(item: GroupingFieldItem): string {
    return `${item.tableAlias ?? ""}\u0000${item.field}`;
  }

  private groupingAllItems(sets: { items: GroupingFieldItem[] }[]): GroupingFieldItem[] {
    const seen = new Set<string>();
    const allItems: GroupingFieldItem[] = [];
    for (const set of sets) {
      for (const item of set.items) {
        const key = this.groupingItemSyntaxKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        allItems.push(item);
      }
    }
    return allItems;
  }

  private parseGroupingFieldItem(): GroupingFieldItem {
    if (this.isRollupStart() || this.isGroupingSetsStart() || this.isCubeStart()) {
      throw new ParseError("B65: nested grouping elements are not supported in Phase1.", this.peek());
    }
    const token = this.peek();
    const field = this.parseQualifiedIdent();
    if (this.peek().kind !== TokenKind.COMMA && this.peek().kind !== TokenKind.RPAREN) {
      throw new ParseError("B65: grouping items must be physical field references only.", token);
    }
    return { type: "FIELD", tableAlias: field.tableAlias, field: field.field };
  }

  private parseGroupingSetsClause(): GroupingSpec {
    this.advance(); // GROUPING
    this.advance(); // SETS
    this.expect(TokenKind.LPAREN);
    if (this.peek().kind === TokenKind.RPAREN) {
      throw new ParseError("B65: GROUPING SETS requires at least one grouping set; use (()) for the empty set.", this.peek());
    }
    const sets: { items: GroupingFieldItem[] }[] = [];
    do {
      if (this.consume(TokenKind.LPAREN)) {
        const items: GroupingFieldItem[] = [];
        if (this.peek().kind !== TokenKind.RPAREN) {
          do {
            items.push(this.parseGroupingFieldItem());
          } while (this.consume(TokenKind.COMMA));
        }
        this.expect(TokenKind.RPAREN);
        sets.push({ items });
      } else {
        sets.push({ items: [this.parseGroupingFieldItem()] });
      }
    } while (this.consume(TokenKind.COMMA));
    this.expect(TokenKind.RPAREN);
    return {
      type: "GROUPING_SETS",
      source: "GROUPING_SETS",
      allItems: this.groupingAllItems(sets),
      sets,
    };
  }

  private parseRollupClause(): GroupingSpec {
    this.advance(); // ROLLUP
    this.expect(TokenKind.LPAREN);
    if (this.peek().kind === TokenKind.RPAREN) {
      throw new ParseError("B65: ROLLUP requires at least one field.", this.peek());
    }
    const items: GroupingFieldItem[] = [];
    do {
      items.push(this.parseGroupingFieldItem());
    } while (this.consume(TokenKind.COMMA));
    this.expect(TokenKind.RPAREN);
    const sets = Array.from(
      { length: items.length + 1 },
      (_, index) => ({ items: items.slice(0, items.length - index) })
    );
    return {
      type: "GROUPING_SETS",
      source: "ROLLUP",
      allItems: this.groupingAllItems(sets),
      sets,
    };
  }

  private parseCubeClause(): GroupingSpec {
    this.advance(); // CUBE
    this.expect(TokenKind.LPAREN);
    if (this.peek().kind === TokenKind.RPAREN) {
      throw new ParseError("B65: CUBE requires at least one field.", this.peek());
    }
    const items: GroupingFieldItem[] = [];
    do {
      items.push(this.parseGroupingFieldItem());
    } while (this.consume(TokenKind.COMMA));
    this.expect(TokenKind.RPAREN);
    const sets = expandCubeGroupingSets(items);
    return {
      type: "GROUPING_SETS",
      source: "CUBE",
      allItems: this.groupingAllItems(sets),
      sets,
    };
  }

  private parseGroupingRef(): GroupingRef {
    const start = this.advance(); // GROUPING
    this.expect(TokenKind.LPAREN);
    if (this.peek().kind === TokenKind.RPAREN) {
      throw new ParseError("B65: GROUPING() requires exactly one physical field argument.", this.peek());
    }
    const field = this.parseQualifiedIdent();
    if (this.peek().kind !== TokenKind.RPAREN) {
      throw new ParseError("B65: GROUPING() requires exactly one physical field argument.", start);
    }
    this.expect(TokenKind.RPAREN);
    return {
      type: "GROUPING_REF",
      field: { type: "FIELD", tableAlias: field.tableAlias, field: field.field },
    };
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

  private parseOrderBy(allowGrouping = true): OrderByItem[] {
    const items: OrderByItem[] = [];
    do {
      const key = this.parseOrderByKey(allowGrouping);
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
  private parseOrderByKey(allowGrouping = true): OrderByKey {
    const aggregateStart = this.tryAggregateFunc();
    if (aggregateStart !== null) {
      const start = this.pos;
      const ref = this.parseAggregateRef(aggregateStart);
      if (this.isSoftKeyword("OVER")) {
        throw new ParseError("ウィンドウ関数は SELECT 列にのみ記述できます", this.peek());
      }
      this.pos = start;
      void ref;
    }
    if (this.isUnsupportedGroupingIdStart()) {
      throw new ParseError("B65: GROUPING_ID is not supported in Phase1.", this.peek());
    }
    if (this.isGroupingFunctionStart()) {
      if (!allowGrouping) {
        throw new ParseError("B65: GROUPING() is not allowed in window ORDER BY.", this.peek());
      }
      return { type: "GROUPING_KEY", ref: this.parseGroupingRef() };
    }
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
      if (this.isApplyBlockStart()
        || (this.prev().kind === TokenKind.IDENT
          && this.prev().value.toUpperCase() === "APPLY"
          && (this.peek().kind === TokenKind.IDENT || this.peek().kind === TokenKind.BIDENT)
          && this.peekAt(1).kind === TokenKind.LPAREN)) {
        throw new ParseError("INSERT INTO ... SELECT は APPLY に対応していません", this.prev());
      }
      if (subtableCode) {
        throw new ParseError("INSERT INTO ... SELECT はサブテーブル仮想テーブルでは未対応です", this.prev());
      }
      const checkGroups = this.parseCheckGroups();
      const validation = this.parseDmlControlSuffix();
      return { type: "INSERT_SELECT", appId, fields, select, ...checkGroups, ...validation } satisfies InsertSelectStatement;
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

    const applyBlocks: ApplyBlock[] = [];
    while (this.isApplyBlockStart()) applyBlocks.push(this.parseApplyBlock());
    if (this.isSoftKeyword("APPLY") && this.peekAt(1).kind === TokenKind.IDENT
      && this.peekAt(1).value.toUpperCase() === "SUBTABLE") {
      throw new ParseError(
        "APPLY SUBTABLE noun is not supported; use APPLY <field> (...)",
        this.peek()
      );
    }
    if (applyBlocks.length > 0 && this.isSoftKeyword("CHECK")) {
      throw new ParseError("APPLY ブロックの後に CHECK は指定できません", this.peek());
    }
    if (applyBlocks.length > 0 && (this.peek().kind === TokenKind.ON || this.isSoftKeyword("REJECT"))) {
      throw new ParseError("ON ERROR SKIP / REJECT LIMIT は APPLY と併用できません", this.peek());
    }
    const checkGroups = this.parseCheckGroups();
    const validation = this.parseDmlControlSuffix();
    if (this.isSoftKeyword("APPLY")) {
      throw new ParseError("APPLY は CHECK / VALIDATE ONLY より前に指定してください", this.peek());
    }
    if (subtableCode && checkGroups.checkGroups) {
      throw new ParseError("CHECK はサブテーブル INSERT に対応していません", this.prev());
    }
    if (subtableCode && (validation.validateOnly || validation.onErrorSkip)) {
      throw new ParseError("VALIDATE ONLY / ON ERROR SKIP はサブテーブル INSERT に対応していません", this.prev());
    }
    const apply = applyBlocks.length > 0 ? { applyBlocks } : {};
    return subtableCode
      ? { type: "INSERT", appId, subtableCode, fields, values, ...apply, ...checkGroups, ...validation }
      : { type: "INSERT", appId, fields, values, ...apply, ...checkGroups, ...validation };
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
      if (this.isUpsertApplyBranchStart() || this.isApplyBlockStart()) {
        throw new ParseError("UPSERT INTO ... SELECT は ON INSERT / ON UPDATE APPLY に対応していません", this.peek());
      }
      const checkGroups = this.parseCheckGroups();
      const validation = this.parseDmlControlSuffix();
      if (this.isUpsertApplyBranchStart() || this.isApplyBlockStart()) {
        throw new ParseError("UPSERT INTO ... SELECT は ON INSERT / ON UPDATE APPLY に対応していません", this.peek());
      }
      return { type: "UPSERT_SELECT", appId, fields, select, keyFields, ...checkGroups, ...validation };
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
    const applyBranches = this.parseUpsertApplyBranches();
    const hasApplyBranches = applyBranches.onInsertApplyBlocks !== undefined
      || applyBranches.onUpdateApplyBlocks !== undefined;
    if (hasApplyBranches && this.isSoftKeyword("CHECK")) {
      throw new ParseError("UPSERT の分岐 APPLY は CHECK と併用できません", this.peek());
    }
    if (hasApplyBranches && (this.peek().kind === TokenKind.ON || this.isSoftKeyword("REJECT"))) {
      throw new ParseError("UPSERT の分岐 APPLY は ON ERROR SKIP / REJECT LIMIT と併用できません", this.peek());
    }
    const checkGroups = this.parseCheckGroups();
    const validation = this.parseDmlControlSuffix();
    if (this.isUpsertApplyBranchStart() || this.isApplyBlockStart()) {
      throw new ParseError("ON INSERT / ON UPDATE APPLY は CHECK / VALIDATE ONLY より前に指定してください", this.peek());
    }
    return {
      type: "UPSERT", appId, fields, values, keyFields,
      ...applyBranches, ...checkGroups, ...validation,
    };
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

  private isUpsertApplyBranchStart(): boolean {
    return this.peek().kind === TokenKind.ON
      && (this.peekAt(1).kind === TokenKind.INSERT || this.peekAt(1).kind === TokenKind.UPDATE);
  }

  private parseUpsertApplyBranches(): Pick<UpsertStatement, "onInsertApplyBlocks" | "onUpdateApplyBlocks"> {
    let onInsertApplyBlocks: ApplyBlock[] | undefined;
    let onUpdateApplyBlocks: ApplyBlock[] | undefined;
    while (this.isUpsertApplyBranchStart()) {
      this.advance(); // ON
      const branch = this.advance(); // INSERT / UPDATE
      const isInsert = branch.kind === TokenKind.INSERT;
      if ((isInsert && onInsertApplyBlocks) || (!isInsert && onUpdateApplyBlocks)) {
        throw new ParseError(`ON ${isInsert ? "INSERT" : "UPDATE"} APPLY は 1 回だけ指定できます`, branch);
      }
      if (!this.isApplyBlockStart()) {
        throw new ParseError(`ON ${isInsert ? "INSERT" : "UPDATE"} の後には APPLY ブロックが必要です`, this.peek());
      }
      const blocks: ApplyBlock[] = [];
      while (this.isApplyBlockStart()) blocks.push(this.parseApplyBlock());
      if (isInsert) onInsertApplyBlocks = blocks;
      else onUpdateApplyBlocks = blocks;
    }
    if (this.isApplyBlockStart()) {
      throw new ParseError("UPSERT の APPLY には ON INSERT または ON UPDATE が必要です", this.peek());
    }
    return {
      ...(onInsertApplyBlocks ? { onInsertApplyBlocks } : {}),
      ...(onUpdateApplyBlocks ? { onUpdateApplyBlocks } : {}),
    };
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
        row.push(makeNumberLiteral(`${sign.kind === TokenKind.MINUS ? "-" : "+"}${number.value}`));
      } else {
        const tok = this.advance();
        if (tok.kind === TokenKind.STRING) {
          row.push({ type: "STRING", value: tok.value });
        } else if (tok.kind === TokenKind.NUMBER) {
          row.push(makeNumberLiteral(tok.value));
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
    const where = this.parseWhereExpr(undefined, true);

    const applyBlocks: ApplyBlock[] = [];
    while (this.isApplyBlockStart()) applyBlocks.push(this.parseApplyBlock());
    if (this.isSoftKeyword("APPLY") && this.peekAt(1).kind === TokenKind.IDENT
      && this.peekAt(1).value.toUpperCase() === "SUBTABLE") {
      throw new ParseError(
        "APPLY SUBTABLE noun is not supported; use APPLY <field> (...)",
        this.peek()
      );
    }
    if (applyBlocks.length > 0 && this.peek().kind === TokenKind.WHERE) {
      throw new ParseError("親 WHERE は APPLY ブロックより前に指定してください", this.peek());
    }

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

    if (applyBlocks.length > 0 && this.isSoftKeyword("CHECK")) {
      throw new ParseError("APPLY ブロックの後に CHECK は指定できません", this.peek());
    }
    if (applyBlocks.length > 0 && (this.peek().kind === TokenKind.ON || this.isSoftKeyword("REJECT"))) {
      throw new ParseError("ON ERROR SKIP / REJECT LIMIT は APPLY と併用できません", this.peek());
    }
    const checkGroups = this.parseCheckGroups();
    const validation = this.parseDmlControlSuffix();
    if (this.isSoftKeyword("APPLY")) {
      throw new ParseError("APPLY は VALIDATE ONLY より前に指定してください", this.peek());
    }
    if (subtableCode && checkGroups.checkGroups) {
      throw new ParseError("CHECK はサブテーブル UPDATE に対応していません", this.prev());
    }
    if (subtableCode && (validation.validateOnly || validation.onErrorSkip)) {
      throw new ParseError("VALIDATE ONLY / ON ERROR SKIP はサブテーブル UPDATE に対応していません", this.prev());
    }
    const apply = applyBlocks.length > 0 ? { applyBlocks } : {};
    if (from !== null) return { type: "UPDATE", appId, assignments, where, from, ...apply, ...checkGroups, ...validation };
    return subtableCode
      ? { type: "UPDATE", appId, subtableCode, assignments, where, ...apply, ...checkGroups, ...validation }
      : { type: "UPDATE", appId, assignments, where, ...apply, ...checkGroups, ...validation };
  }

  private isApplyBlockStart(): boolean {
    return this.isSoftKeyword("APPLY")
      && (this.peekAt(1).kind === TokenKind.IDENT || this.peekAt(1).kind === TokenKind.BIDENT)
      && this.peekAt(2).kind === TokenKind.LPAREN;
  }

  private parseApplyBlock(): ApplyBlock {
    this.advance(); // APPLY
    const field = this.parseIdentifier();
    this.expect(TokenKind.LPAREN);
    if (this.peek().kind === TokenKind.RPAREN || this.peek().kind === TokenKind.SEMICOLON) {
      throw new ParseError("APPLY ブロックには操作が最低 1 つ必要です", this.peek());
    }
    const operations: ApplyOperation[] = [];
    while (true) {
      operations.push(this.parseApplyOperation());
      if (!this.consume(TokenKind.SEMICOLON)) break;
      if (this.peek().kind === TokenKind.RPAREN) break;
      if (this.peek().kind === TokenKind.SEMICOLON) {
        throw new ParseError("APPLY ブロックに空の操作は指定できません", this.peek());
      }
    }
    this.expect(TokenKind.RPAREN, "APPLY ブロックの末尾には ) が必要です");
    const hasSubtableOperation = operations.some((operation) =>
      operation.kind === "PATCH" || operation.kind === "APPEND" || operation.kind === "REMOVE"
    );
    const hasMultiValueOperation = operations.some((operation) =>
      operation.kind === "ADD" || operation.kind === "REMOVE_VALUE"
    );
    if (hasSubtableOperation && hasMultiValueOperation) {
      throw new ParseError("1 つの APPLY ブロックに行操作と多値操作は混在できません", this.prev());
    }
    return hasMultiValueOperation
      ? { field, targetKind: "MULTI_VALUE", operations: operations as Extract<ApplyBlock, { targetKind: "MULTI_VALUE" }>["operations"] }
      : { field, targetKind: "SUBTABLE", operations: operations as Extract<ApplyBlock, { targetKind: "SUBTABLE" }>["operations"] };
  }

  private parseApplyOperation(): ApplyOperation {
    if (this.isSoftKeyword("ADD")) {
      this.advance();
      const value = this.expect(TokenKind.STRING, "ADD の後には文字列リテラルが必要です").value;
      return { kind: "ADD", value };
    }
    if (this.isSoftKeyword("PATCH")) {
      this.advance();
      this.expect(TokenKind.SET, "PATCH の後には SET が必要です");
      const assignments = this.parseAssignments();
      const selector = this.parseApplyRowSelector();
      const expectRows = this.parseExpectRowsGuard();
      return { kind: "PATCH", assignments, selector, ...(expectRows ? { expectRows } : {}) };
    }
    if (this.isSoftKeyword("APPEND")) {
      this.advance();
      this.expect(TokenKind.LPAREN, "APPEND の後にはフィールド一覧が必要です");
      if (this.peek().kind === TokenKind.RPAREN) {
        throw new ParseError("APPEND のフィールド一覧は空にできません", this.peek());
      }
      const fields: string[] = [];
      do fields.push(this.parseIdentifier()); while (this.consume(TokenKind.COMMA));
      this.expect(TokenKind.RPAREN);
      this.expect(TokenKind.VALUES, "APPEND のフィールド一覧の後には VALUES が必要です");
      const values: InsertRow[] = [];
      do {
        this.expect(TokenKind.LPAREN, "APPEND VALUES の各行は ( で始めてください");
        values.push(this.parseInsertRow(fields.length));
        this.expect(TokenKind.RPAREN);
      } while (this.consume(TokenKind.COMMA));
      return { kind: "APPEND", fields, values };
    }
    if (this.isSoftKeyword("REMOVE")) {
      this.advance();
      if (this.peek().kind === TokenKind.STRING) {
        return { kind: "REMOVE_VALUE", value: this.advance().value };
      }
      const selector = this.parseApplyRowSelector();
      const expectRows = this.parseExpectRowsGuard();
      return { kind: "REMOVE", selector, ...(expectRows ? { expectRows } : {}) };
    }
    throw new ParseError("APPLY の操作には PATCH / APPEND / REMOVE / ADD が必要です", this.peek());
  }

  private parseApplyRowSelector(): RowSelector {
    if (this.consume(TokenKind.WHERE)) return { kind: "WHERE", where: this.parseWhereExpr(undefined, true) };
    if (this.consume(TokenKind.ALL)) {
      if (!this.isSoftKeyword("ROWS")) throw new ParseError("ALL の後には ROWS が必要です", this.peek());
      this.advance();
      return { kind: "ALL_ROWS" };
    }
    throw new ParseError("PATCH / REMOVE には WHERE または ALL ROWS が必要です", this.peek());
  }

  private parseExpectRowsGuard(): ExpectRowsGuard | undefined {
    if (!this.isSoftKeyword("EXPECT")) return undefined;
    this.advance();
    if (!this.isSoftKeyword("ROWS")) throw new ParseError("EXPECT の後には ROWS が必要です", this.peek());
    this.advance();
    if (this.consume(TokenKind.BETWEEN)) {
      const min = this.parseExpectRowsCount();
      this.expect(TokenKind.AND, "EXPECT ROWS BETWEEN の下限と上限は AND で区切ってください");
      const max = this.parseExpectRowsCount();
      if (min > max) throw new ParseError("EXPECT ROWS BETWEEN の下限は上限以下にしてください", this.peek());
      return { kind: "BETWEEN", min, max };
    }
    if (this.isSoftKeyword("AT")) {
      this.advance();
      if (this.peek().value.toUpperCase() === "LEAST") {
        this.advance();
        return { kind: "AT_LEAST", count: this.parseExpectRowsCount() };
      }
      if (this.isSoftKeyword("MOST")) {
        this.advance();
        return { kind: "AT_MOST", count: this.parseExpectRowsCount() };
      }
      throw new ParseError("EXPECT ROWS AT の後には LEAST または MOST が必要です", this.peek());
    }
    return { kind: "EXACT", count: this.parseExpectRowsCount() };
  }

  private parseExpectRowsCount(): number {
    const tok = this.expect(TokenKind.NUMBER, "EXPECT ROWS には 0 以上の整数が必要です");
    if (!/^\d+$/.test(tok.value) || !Number.isSafeInteger(Number(tok.value))) {
      throw new ParseError("EXPECT ROWS は 0 以上の安全な整数で指定してください", tok);
    }
    return Number(tok.value);
  }

  /** CHECK WHEN ... THEN ... blocks. CHECK is a soft keyword. */
  private parseCheckGroups(): { checkGroups?: CheckGroup[] } {
    const groups: CheckGroup[] = [];
    while (this.isSoftKeyword("CHECK") && this.peekAt(1).kind === TokenKind.WHEN) {
      const check = this.advance();
      const rules: CheckGroup["rules"] = [];
      while (this.consume(TokenKind.WHEN)) {
        const condition = this.parseWhereExpr();
        this.expect(TokenKind.THEN, "CHECK WHEN の条件の後には THEN が必要です");
        const message = this.parseScalarValueExpr({ allowCase: false });
        rules.push({ condition, message });
      }
      if (rules.length === 0) throw new ParseError("CHECK の後には WHEN が最低 1 つ必要です", check);
      groups.push({ rules });
    }
    return groups.length > 0 ? { checkGroups: groups } : {};
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

  private rejectAggregateWindowOutsideSelect(): void {
    if (this.isSoftKeyword("OVER")) {
      throw new ParseError("ウィンドウ関数は SELECT 列にのみ記述できます", this.peek());
    }
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
    if (this.hasTopLevelTokenBeforeValueEnd(TokenKind.CONCAT_OP)) {
      const expr = this.parseScalarValueExpr();
      if (expr.type === "CONCAT_OP" || expr.type === "SCALAR_ARITH" || expr.type === "STRING_FUNC") return expr;
      if (expr.type === "CASE_WHEN") return { type: "CASE_VALUE", expr };
      throw new ParseError("SET の値には連結を含むスカラー値式が必要です", tok);
    }
    if (tok.kind === TokenKind.VARIABLE) return this.parseSqlValue();
    // 文字列リテラルは算術不可
    if (tok.kind === TokenKind.STRING) return this.parseSqlValue();
    // kintone 専用関数（TODAY / NOW / LOGINUSER）
    if (isContextualFunctionToken(tok.kind)) return this.parseSqlValue();
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
    const where = this.parseWhereExpr(undefined, true);

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
      where = this.parseWhereExpr(undefined, true);
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
    const digitPrefixed = this.tryParseDigitPrefixedIdentifier();
    if (digitPrefixed !== null) return digitPrefixed;
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
    const digitPrefixed = this.tryParseDigitPrefixedIdentifier();
    if (digitPrefixed !== null) return digitPrefixed;
    throw new ParseError(
      "フィールド名またはテーブル名が必要です",
      tok
    );
  }

  /** `0埋め` のように数字から始まる日本語識別子を、空白なしの場合だけ読む。 */
  private tryParseDigitPrefixedIdentifier(): string | null {
    const first = this.peek();
    const second = this.peekAt(1);
    if (first.kind !== TokenKind.NUMBER
      || !/^\d+$/.test(first.value)
      || second.kind !== TokenKind.IDENT
      || second.pos !== first.pos + first.value.length) {
      return null;
    }
    this.advance();
    this.advance();
    return first.value + second.value;
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
  private parseAliasName(): { alias: string; display: string } {
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
      return {
        alias: tok.value.toLowerCase(), // alias は小文字で統一
        display: tok.value,
      };
    }
    throw new ParseError("エイリアス名が必要です", tok);
  }

  /** 互換 snapshot を変えず、SELECT 列 AST に表示表記を保持する。 */
  private withAliasDisplay<const T extends { alias: string | null }>(
    column: T,
    parsedAlias: { alias: string; display: string } | null
  ): T & { aliasDisplay?: string } {
    if (parsedAlias !== null) {
      Object.defineProperty(column, "aliasDisplay", {
        value: parsedAlias.display,
        enumerable: false,
      });
    }
    return column;
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
