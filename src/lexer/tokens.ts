// ============================================================
// トークン定義
// ============================================================

// ------------------------------------------------------------
// トークン種別
// ------------------------------------------------------------

export const enum TokenKind {
  // リテラル
  STRING  = "STRING",   // 'value'
  NUMBER  = "NUMBER",   // 123 / 3.14

  // 識別子
  IDENT   = "IDENT",   // フィールド名・テーブル名（日本語含む）
  BIDENT  = "BIDENT",  // `バッククォート識別子`

  // キーワード ― 集合演算
  UNION = "UNION",
  ALL   = "ALL",

  // キーワード ― CTE
  WITH = "WITH",

  // キーワード ― スキーマ探索
  SHOW     = "SHOW",
  DESCRIBE = "DESCRIBE",
  APPS     = "APPS",
  EXPLAIN  = "EXPLAIN",

  // キーワード ― UPSERT
  UPSERT    = "UPSERT",
  DUPLICATE = "DUPLICATE",

  // キーワード ― DML
  REORDER  = "REORDER",
  SELECT   = "SELECT",
  DISTINCT = "DISTINCT",
  FROM     = "FROM",
  AS       = "AS",
  WHERE    = "WHERE",
  INSERT   = "INSERT",
  INTO     = "INTO",
  VALUES   = "VALUES",
  UPDATE   = "UPDATE",
  SET      = "SET",
  DELETE   = "DELETE",

  // キーワード ― JOIN
  INNER = "INNER",
  LEFT  = "LEFT",
  RIGHT = "RIGHT",
  JOIN  = "JOIN",
  ON    = "ON",

  // キーワード ― 集計・グループ
  GROUP  = "GROUP",
  BY     = "BY",
  HAVING = "HAVING",
  ORDER  = "ORDER",
  ASC    = "ASC",
  DESC   = "DESC",
  LIMIT  = "LIMIT",
  OFFSET = "OFFSET",

  // キーワード ― 集計関数
  COUNT = "COUNT",
  SUM   = "SUM",
  AVG   = "AVG",
  MAX   = "MAX",
  MIN   = "MIN",

  // キーワード ― 条件
  AND     = "AND",
  OR      = "OR",
  NOT     = "NOT",
  EXISTS  = "EXISTS",
  IS      = "IS",
  NULL    = "NULL",
  LIKE    = "LIKE",
  IN      = "IN",
  BETWEEN = "BETWEEN",

  // キーワード ― CASE WHEN
  CASE = "CASE",
  WHEN = "WHEN",
  THEN = "THEN",
  ELSE = "ELSE",
  END  = "END",

  // kintone 専用関数
  TODAY      = "TODAY",
  NOW        = "NOW",
  LOGINUSER  = "LOGINUSER",

  // 文字列関数
  UPPER     = "UPPER",
  LOWER     = "LOWER",
  TRIM      = "TRIM",
  LTRIM     = "LTRIM",
  RTRIM     = "RTRIM",
  LENGTH    = "LENGTH",
  SUBSTRING = "SUBSTRING",
  SUBSTR    = "SUBSTR",
  CONCAT    = "CONCAT",
  REPLACE   = "REPLACE",
  COALESCE  = "COALESCE",
  NULLIF    = "NULLIF",
  ISNULL    = "ISNULL",

  // 数値関数
  ROUND   = "ROUND",
  FLOOR   = "FLOOR",
  CEIL    = "CEIL",
  CEILING = "CEILING",

  // 数学関数
  ABS   = "ABS",
  MOD   = "MOD",
  POWER = "POWER",
  POW   = "POW",
  SQRT  = "SQRT",

  // 型変換・書式
  CAST    = "CAST",
  CONVERT = "CONVERT",
  FORMAT  = "FORMAT",

  // 日付関数
  YEAR        = "YEAR",
  MONTH       = "MONTH",
  DAY         = "DAY",
  DATE_FORMAT = "DATE_FORMAT",
  DATEDIFF    = "DATEDIFF",
  DATE_ADD    = "DATE_ADD",

  // 条件関数
  IF = "IF",

  // 演算子
  EQ    = "=",
  NEQ   = "!=",
  LT_GT = "<>",
  GT    = ">",
  LT    = "<",
  GTE   = ">=",
  LTE   = "<=",

  // 算術演算子
  PLUS    = "+",
  MINUS   = "-",
  SLASH   = "/",
  PERCENT = "%",

  // 記号
  STAR      = "*",
  LPAREN    = "(",
  RPAREN    = ")",
  LBRACKET  = "[",
  RBRACKET  = "]",
  COMMA     = ",",
  DOT       = ".",
  SEMICOLON = ";",

  // 終端
  EOF = "EOF",
}

// ------------------------------------------------------------
// キーワードマップ（大文字小文字を正規化）
// ------------------------------------------------------------

export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["UNION",     TokenKind.UNION],
  ["ALL",       TokenKind.ALL],
  ["WITH",      TokenKind.WITH],
  ["SHOW",      TokenKind.SHOW],
  ["DESCRIBE",  TokenKind.DESCRIBE],
  ["APPS",      TokenKind.APPS],
  ["EXPLAIN",   TokenKind.EXPLAIN],
  ["UPSERT",    TokenKind.UPSERT],
  ["REORDER",   TokenKind.REORDER],
  ["DUPLICATE", TokenKind.DUPLICATE],
  ["SELECT",    TokenKind.SELECT],
  ["DISTINCT",  TokenKind.DISTINCT],
  ["FROM",      TokenKind.FROM],
  ["AS",        TokenKind.AS],
  ["WHERE",     TokenKind.WHERE],
  ["INSERT",    TokenKind.INSERT],
  ["INTO",      TokenKind.INTO],
  ["VALUES",    TokenKind.VALUES],
  ["UPDATE",    TokenKind.UPDATE],
  ["SET",       TokenKind.SET],
  ["DELETE",    TokenKind.DELETE],
  ["INNER",     TokenKind.INNER],
  ["LEFT",      TokenKind.LEFT],
  ["RIGHT",     TokenKind.RIGHT],
  ["JOIN",      TokenKind.JOIN],
  ["ON",        TokenKind.ON],
  ["GROUP",     TokenKind.GROUP],
  ["BY",        TokenKind.BY],
  ["HAVING",    TokenKind.HAVING],
  ["ORDER",     TokenKind.ORDER],
  ["ASC",       TokenKind.ASC],
  ["DESC",      TokenKind.DESC],
  ["LIMIT",     TokenKind.LIMIT],
  ["OFFSET",    TokenKind.OFFSET],
  ["COUNT",     TokenKind.COUNT],
  ["SUM",       TokenKind.SUM],
  ["AVG",       TokenKind.AVG],
  ["MAX",       TokenKind.MAX],
  ["MIN",       TokenKind.MIN],
  ["AND",       TokenKind.AND],
  ["OR",        TokenKind.OR],
  ["NOT",       TokenKind.NOT],
  ["EXISTS",    TokenKind.EXISTS],
  ["IS",        TokenKind.IS],
  ["NULL",      TokenKind.NULL],
  ["LIKE",      TokenKind.LIKE],
  ["IN",        TokenKind.IN],
  ["BETWEEN",   TokenKind.BETWEEN],
  ["TODAY",     TokenKind.TODAY],
  ["NOW",       TokenKind.NOW],
  ["LOGINUSER", TokenKind.LOGINUSER],
  ["CASE",      TokenKind.CASE],
  ["WHEN",      TokenKind.WHEN],
  ["THEN",      TokenKind.THEN],
  ["ELSE",      TokenKind.ELSE],
  ["END",       TokenKind.END],
  ["UPPER",     TokenKind.UPPER],
  ["LOWER",     TokenKind.LOWER],
  ["TRIM",      TokenKind.TRIM],
  ["LTRIM",     TokenKind.LTRIM],
  ["RTRIM",     TokenKind.RTRIM],
  ["LENGTH",    TokenKind.LENGTH],
  ["SUBSTRING", TokenKind.SUBSTRING],
  ["SUBSTR",    TokenKind.SUBSTR],
  ["CONCAT",    TokenKind.CONCAT],
  ["REPLACE",   TokenKind.REPLACE],
  ["COALESCE",  TokenKind.COALESCE],
  ["NULLIF",    TokenKind.NULLIF],
  ["ISNULL",    TokenKind.ISNULL],
  ["CAST",      TokenKind.CAST],
  ["CONVERT",   TokenKind.CONVERT],
  ["FORMAT",    TokenKind.FORMAT],
  ["ROUND",     TokenKind.ROUND],
  ["FLOOR",     TokenKind.FLOOR],
  ["CEIL",      TokenKind.CEIL],
  ["CEILING",   TokenKind.CEILING],
  ["ABS",       TokenKind.ABS],
  ["MOD",       TokenKind.MOD],
  ["POWER",     TokenKind.POWER],
  ["POW",       TokenKind.POW],
  ["SQRT",      TokenKind.SQRT],
  ["YEAR",        TokenKind.YEAR],
  ["MONTH",       TokenKind.MONTH],
  ["DAY",         TokenKind.DAY],
  ["DATE_FORMAT", TokenKind.DATE_FORMAT],
  ["DATEDIFF",    TokenKind.DATEDIFF],
  ["DATE_ADD",    TokenKind.DATE_ADD],
  ["IF",          TokenKind.IF],
]);

// ------------------------------------------------------------
// Token オブジェクト
// ------------------------------------------------------------

export interface Token {
  kind:  TokenKind;
  value: string;   // 元のテキスト（リテラルは加工済み）
  pos:   number;   // 入力文字列上の開始位置（0-indexed）
}
