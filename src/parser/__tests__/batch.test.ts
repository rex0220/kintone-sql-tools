// ============================================================
// 複文（バッチ）と一時テーブル構文のテスト（フェーズ1 S2）
//
// - parseStatements(): `;` 区切りの複文分割・空文スキップ・文数上限
// - CREATE TEMP TABLE / DROP TEMP TABLE のパース
// - # 識別子の位置制限（テーブル参照位置のみ）と alias 拒否
// ============================================================

import { Lexer } from "../../lexer/lexer";
import { Parser, ParseError } from "../parser";
import type {
  SelectStatement,
  CreateTempTableStatement,
  DropTempTableStatement,
  UpdateStatement,
  AssertStatement,
} from "../../types/ast";

function parseAll(sql: string) {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parseStatements();
}
function parseOne(sql: string) {
  const tokens = new Lexer(sql).tokenize();
  return new Parser(tokens).parse();
}

// ----------------------------------------------------------------
// 複文分割
// ----------------------------------------------------------------

test("複文を ; で分割できる", () => {
  const stmts = parseAll("SELECT * FROM APP100; SELECT * FROM APP200;");
  expect(stmts.map((s) => s.type)).toEqual(["SELECT", "SELECT"]);
});

test("空文（連続する ; や先頭・末尾の ;）はスキップされる", () => {
  const stmts = parseAll(";;SELECT * FROM APP100;;; SELECT * FROM APP200");
  expect(stmts).toHaveLength(2);
});

test("空入力は空配列を返す", () => {
  expect(parseAll("")).toEqual([]);
  expect(parseAll(" ; ; ")).toEqual([]);
});

test("; なしで文が連続するとエラー", () => {
  expect(() => parseAll("SELECT * FROM APP100 SELECT * FROM APP200"))
    .toThrow(/文の区切りには ; が必要です/);
});

test("20 文まで受理し、21 文でエラー", () => {
  const one = "SELECT * FROM APP100";
  expect(parseAll(Array(20).fill(one).join(";"))).toHaveLength(20);
  expect(() => parseAll(Array(21).fill(one).join(";")))
    .toThrow(/batch exceeds 20 statements/);
});

test("単文 API parse() は複文を拒否する", () => {
  expect(() => parseOne("SELECT * FROM APP100; SELECT * FROM APP200"))
    .toThrow(/単文のみ/);
});

test("SET @name は専用 ScalarExpr としてパースし、名前を小文字化する", () => {
  const stmts = parseAll("SET @Rate = 2 + 3 * 4; SET @label = CONCAT('A', 'B'); SET @now = NOW()");
  expect(stmts[0]).toMatchObject({
    type: "SET_VARIABLE", name: "rate", expr: { type: "ARITH", op: "+" },
  });
  expect(stmts[1]).toMatchObject({ type: "SET_VARIABLE", name: "label", expr: { type: "STRING_FUNC" } });
  expect(stmts[2]).toEqual({ type: "SET_VARIABLE", name: "now", expr: { type: "KINTONE_FUNC", name: "NOW" } });
});

test("変数参照を WHERE / UPDATE SET / ASSERT の直接値で受理する", () => {
  const stmts = parseAll("SET @x = 10; UPDATE APP100 SET 金額 = @x WHERE $id = @x; ASSERT @x BETWEEN 1 AND 20");
  const update = stmts[1] as UpdateStatement;
  expect(update.assignments[0].value).toEqual({ type: "VARIABLE", name: "x" });
  expect(update.where).toMatchObject({ type: "BINARY", right: { type: "VARIABLE", name: "x" } });
  expect((stmts[2] as AssertStatement).left).toEqual({ type: "VARIABLE", name: "x" });
});

test("SET RHS のフィールド・他変数・NULL・スカラーサブクエリを拒否する", () => {
  expect(() => parseOne("SET @x = field + 1")).toThrow(/フィールド参照/);
  expect(() => parseOne("SET @x = @other")).toThrow(/他の変数/);
  expect(() => parseOne("SET @x = NULL")).toThrow(/NULL/);
  expect(() => parseOne("SET @user = LOGINUSER()"))
    .toThrow(/SET の右辺で LOGINUSER\(\) は使用できません/);
  expect(() => parseOne("SET @x = (SELECT COUNT(*) FROM APP100)")).toThrow(/Phase 1b/);
  expect(() => parseOne("SET @list = ('A', 'B')")).toThrow(ParseError);
});

// ----------------------------------------------------------------
// CREATE TEMP TABLE / DROP TEMP TABLE
// ----------------------------------------------------------------

test("CREATE TEMP TABLE #t AS SELECT", () => {
  const stmt = parseOne(
    "CREATE TEMP TABLE #高額 AS SELECT 顧客名, 売上 FROM APP100 WHERE 売上 > 100"
  ) as CreateTempTableStatement;
  expect(stmt.type).toBe("CREATE_TEMP_TABLE");
  expect(stmt.name).toBe("#高額");
  expect(stmt.query.type).toBe("SELECT");
});

test("CREATE TEMP TABLE — ソフトキーワードは大文字小文字を区別しない", () => {
  const stmt = parseOne(
    "create temp table #t as select * from APP100"
  ) as CreateTempTableStatement;
  expect(stmt.type).toBe("CREATE_TEMP_TABLE");
  expect(stmt.name).toBe("#t");
});

test("CREATE TEMP TABLE ... AS WITH（CTE）", () => {
  const stmt = parseOne(
    "CREATE TEMP TABLE #t AS WITH c1 AS (SELECT 顧客ID FROM APP100) SELECT * FROM c1"
  ) as CreateTempTableStatement;
  expect(stmt.query.type).toBe("WITH");
});

test("CREATE TEMP TABLE ... AS UNION", () => {
  const stmt = parseOne(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100 UNION ALL SELECT 顧客名 FROM APP200"
  ) as CreateTempTableStatement;
  expect(stmt.query.type).toBe("UNION");
});

test("CREATE TEMP TABLE の名前は # 必須", () => {
  expect(() => parseOne("CREATE TEMP TABLE t AS SELECT * FROM APP100"))
    .toThrow(/# で始まる必要があります/);
});

test("CREATE TEMP TABLE に AS が無いとエラー", () => {
  expect(() => parseOne("CREATE TEMP TABLE #t SELECT * FROM APP100"))
    .toThrow(ParseError);
});

test("DROP TEMP TABLE #t", () => {
  const stmt = parseOne("DROP TEMP TABLE #t") as DropTempTableStatement;
  expect(stmt).toEqual({ type: "DROP_TEMP_TABLE", name: "#t" });
});

test("DROP TEMP TABLE の名前は # 必須", () => {
  expect(() => parseOne("DROP TEMP TABLE APP100")).toThrow(/# で始まる必要があります/);
});

test("CREATE / TEMP / TABLE は予約語ではない（フィールド名・alias に使える）", () => {
  const ast = parseOne("SELECT create, temp AS table FROM APP100") as SelectStatement;
  expect(ast.columns).toEqual([
    { type: "FIELD", field: "create", alias: null },
    { type: "FIELD", field: "temp",   alias: "table" },
  ]);
});

// ----------------------------------------------------------------
// # 識別子の位置制限
// ----------------------------------------------------------------

test("FROM #t は一時テーブル参照（cteName 機構）になる（バッチ API）", () => {
  const ast = parseAll("SELECT * FROM #t")[0] as SelectStatement;
  expect(ast.from.cteName).toBe("#t");
  expect(ast.from.appId).toBe(0);
});

test("JOIN #t も一時テーブル参照になる（バッチ API）", () => {
  const ast = parseAll(
    "SELECT a.顧客名 FROM APP100 a INNER JOIN #t b ON a.顧客ID = b.顧客ID"
  )[0] as SelectStatement;
  expect(ast.joins[0].table.cteName).toBe("#t");
});

// ----------------------------------------------------------------
// 単文 API parse() は一時テーブル参照を拒否する
// （バッチ実行器導入前に既存の単文実行経路へ漏らさないためのガード）
// ----------------------------------------------------------------

test("単文 API: FROM #t は拒否", () => {
  expect(() => parseOne("SELECT * FROM #t"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("単文 API: JOIN #t は拒否", () => {
  expect(() => parseOne("SELECT a.顧客名 FROM APP100 a INNER JOIN #t b ON a.顧客ID = b.顧客ID"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("単文 API: WITH 内の FROM #t は拒否（cteCache の空結果化を防ぐ）", () => {
  expect(() => parseOne("WITH c1 AS (SELECT 顧客ID FROM APP100) SELECT * FROM #t"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("単文 API: INSERT INTO APP ... SELECT FROM #t は拒否", () => {
  expect(() => parseOne("INSERT INTO APP100 (顧客名) SELECT 顧客名 FROM #t"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("単文 API: サブクエリ内の FROM #t も拒否", () => {
  expect(() => parseOne("SELECT * FROM APP100 WHERE 顧客ID IN (SELECT 顧客ID FROM #t)"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("SELECT 句の # 識別子はエラー", () => {
  expect(() => parseOne("SELECT #x FROM APP100"))
    .toThrow(/FROM \/ JOIN \/ CREATE \/ DROP TEMP TABLE でのみ使用できます/);
});

test("WHERE 句の # 識別子はエラー", () => {
  expect(() => parseOne("SELECT * FROM APP100 WHERE #x = 1")).toThrow(ParseError);
});

test("CTE 名に # は使えない", () => {
  expect(() => parseOne("WITH #c AS (SELECT * FROM APP100) SELECT * FROM #c"))
    .toThrow(ParseError);
});

test("DESCRIBE #t はエラー", () => {
  expect(() => parseOne("DESCRIBE #t")).toThrow(ParseError);
});

// ----------------------------------------------------------------
// alias 位置の # 拒否
// ----------------------------------------------------------------

test("暗黙テーブル alias の # はエラー（APP#x の分割対策）", () => {
  expect(() => parseOne("SELECT * FROM APP100 #x")).toThrow(ParseError);
  expect(() => parseOne("SELECT * FROM APP#x")).toThrow(ParseError);
  expect(() => parseOne("SELECT * FROM #a#b")).toThrow(ParseError);
});

test("明示テーブル alias の # はエラー", () => {
  expect(() => parseOne("SELECT * FROM APP100 AS #x")).toThrow(ParseError);
});

test("列 alias の # はエラー", () => {
  expect(() => parseOne("SELECT 顧客名 AS #x FROM APP100"))
    .toThrow(/エイリアス名に # で始まる名前は使用できません/);
});

// ----------------------------------------------------------------
// 一時テーブルへの DML 拒否
// ----------------------------------------------------------------

test("INSERT INTO #t はエラー", () => {
  expect(() => parseOne("INSERT INTO #t (顧客名) VALUES ('A')"))
    .toThrow(/DML on temp table #t is not supported/);
});

test("UPDATE #t はエラー", () => {
  expect(() => parseOne("UPDATE #t SET 顧客名 = 'A' WHERE $id = 1"))
    .toThrow(/DML on temp table #t is not supported/);
});

test("DELETE FROM #t はエラー", () => {
  expect(() => parseOne("DELETE FROM #t WHERE $id = 1"))
    .toThrow(/DML on temp table #t is not supported/);
});

test("UPSERT INTO #t はエラー", () => {
  expect(() => parseOne("UPSERT INTO #t (顧客名) VALUES ('A') ON DUPLICATE (顧客名)"))
    .toThrow(/DML on temp table #t is not supported/);
});

test("REORDER #t はエラー", () => {
  expect(() => parseOne("REORDER #t BY 順序 ASC"))
    .toThrow(/DML on temp table #t is not supported/);
});

// ----------------------------------------------------------------
// バッククォート識別子の # は temp マーカーではない（既存互換）
// ----------------------------------------------------------------

test("バッククォートの `#field` は通常フィールド名として使える", () => {
  const ast = parseOne("SELECT `#備考` FROM APP100") as SelectStatement;
  expect(ast.columns).toEqual([
    { type: "FIELD", field: "#備考", alias: null },
  ]);
});

test("バッククォートでも alias の # は拒否する", () => {
  expect(() => parseOne("SELECT 顧客名 AS `#x` FROM APP100"))
    .toThrow(/エイリアス名に # で始まる名前は使用できません/);
});

test("バッククォートのテーブル alias（明示 AS）の # も拒否する", () => {
  expect(() => parseOne("SELECT * FROM APP100 AS `#x`"))
    .toThrow(/エイリアス名に # で始まる名前は使用できません/);
});

test("バッククォートのテーブル alias（暗黙）の # も拒否する", () => {
  expect(() => parseOne("SELECT * FROM APP100 `#x`"))
    .toThrow(/エイリアス名に # で始まる名前は使用できません/);
});
