// ============================================================
// バッチ静的検証（analyzeBatch）のテスト（フェーズ1 S3）
// ============================================================

import { analyzeBatch, BatchAnalysisError, MAX_TEMP_TABLES } from "../batch";
import { parseSqlStatements } from "../sql";

function analyze(sql: string) {
  return analyzeBatch(parseSqlStatements(sql));
}

// ----------------------------------------------------------------
// 分類とバッチサマリ
// ----------------------------------------------------------------

test("read-only バッチ: isReadOnlyBatch = true / containsDml = false", () => {
  const a = analyze("SELECT * FROM APP100; SHOW APPS; EXPLAIN SELECT * FROM APP100");
  expect(a.statementCount).toBe(3);
  expect(a.isReadOnlyBatch).toBe(true);
  expect(a.containsDml).toBe(false);
  expect(a.statements.map((s) => s.statementType)).toEqual(["SELECT", "SHOW_APPS", "EXPLAIN"]);
});

test("DML を含むバッチ: containsDml = true / isReadOnlyBatch = false", () => {
  const a = analyze("SELECT * FROM APP100; UPDATE APP100 SET x = 1 WHERE $id = 1");
  expect(a.containsDml).toBe(true);
  expect(a.isReadOnlyBatch).toBe(false);
  expect(a.statements[1].isDml).toBe(true);
  expect(a.statements[1].hasWhere).toBe(true);
});

test("CREATE / DROP TEMP TABLE は read-only 扱い", () => {
  const a = analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100; SELECT * FROM #t; DROP TEMP TABLE #t");
  expect(a.isReadOnlyBatch).toBe(true);
  expect(a.statements[0].isReadOnly).toBe(true);
  expect(a.statements[2].isReadOnly).toBe(true);
});

test("insertValuesCount が文ごとに入る", () => {
  const a = analyze("SELECT * FROM APP100; INSERT INTO APP100 (x) VALUES ('a'), ('b')");
  expect(a.statements[0].insertValuesCount).toBeNull();
  expect(a.statements[1].insertValuesCount).toBe(2);
});

// ----------------------------------------------------------------
// 一時テーブルの静的解決
// ----------------------------------------------------------------

test("CREATE → 参照: tempTables と created/referenced が埋まる", () => {
  const a = analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100; SELECT * FROM #t");
  expect(a.tempTables).toEqual(["#t"]);
  expect(a.statements[0].tempTablesCreated).toEqual(["#t"]);
  expect(a.statements[1].tempTablesReferenced).toEqual(["#t"]);
});

test("未定義参照はエラー", () => {
  expect(() => analyze("SELECT * FROM APP100; SELECT * FROM #t"))
    .toThrow(/ParseError: temp table #t is not defined in this batch\./);
});

test("CREATE より前の参照はエラー（定義順）", () => {
  expect(() => analyze("SELECT * FROM #t; CREATE TEMP TABLE #t AS SELECT * FROM APP100"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("同名の再 CREATE はエラー", () => {
  expect(() =>
    analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100; CREATE TEMP TABLE #t AS SELECT * FROM APP200")
  ).toThrow(/ParseError: temp table #t is already defined\./);
});

test("DROP 後の参照はエラー", () => {
  expect(() =>
    analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100; DROP TEMP TABLE #t; SELECT * FROM #t")
  ).toThrow(/temp table #t is not defined in this batch/);
});

test("DROP 後の再 CREATE は許容される", () => {
  const a = analyze(
    "CREATE TEMP TABLE #t AS SELECT * FROM APP100; DROP TEMP TABLE #t; CREATE TEMP TABLE #t AS SELECT * FROM APP200; SELECT * FROM #t"
  );
  expect(a.tempTables).toEqual(["#t", "#t"]);
  // 再 CREATE 後の参照は 2 回目の CREATE（index 2）に依存する
  expect(a.statements[3].dependsOn).toEqual([2]);
});

test("未定義名の DROP はエラー", () => {
  expect(() => analyze("SELECT * FROM APP100; DROP TEMP TABLE #t"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("エラーには違反した文の index が入る", () => {
  try {
    analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100; DROP TEMP TABLE #t; SELECT * FROM #t");
    throw new Error("エラーになりませんでした");
  } catch (e) {
    expect(e).toBeInstanceOf(BatchAnalysisError);
    expect((e as BatchAnalysisError).statementIndex).toBe(2);
  }
});

// ----------------------------------------------------------------
// 同時個数上限（MAX_TEMP_TABLES = 16）
// ----------------------------------------------------------------

function createN(n: number, offset = 0): string {
  return Array.from({ length: n }, (_, i) => `CREATE TEMP TABLE #t${i + offset} AS SELECT * FROM APP100`).join(";");
}

test("同時 16 個までは受理される", () => {
  const a = analyze(createN(MAX_TEMP_TABLES));
  expect(a.tempTables).toHaveLength(16);
});

test("同時 17 個目はエラー", () => {
  expect(() => analyze(createN(MAX_TEMP_TABLES + 1)))
    .toThrow(/ParseError: batch exceeds 16 temp tables\./);
});

test("DROP で枠が空けば 17 個目を CREATE できる（上限は同時数）", () => {
  const sql = createN(MAX_TEMP_TABLES) + "; DROP TEMP TABLE #t0; " + createN(1, 99);
  expect(analyze(sql).tempTables).toHaveLength(17);
});

// ----------------------------------------------------------------
// 依存グラフ
// ----------------------------------------------------------------

test("参照文は CREATE 文の index に依存する", () => {
  const a = analyze(
    "CREATE TEMP TABLE #a AS SELECT * FROM APP100;" +
    "CREATE TEMP TABLE #b AS SELECT * FROM APP200;" +
    "SELECT * FROM #a x INNER JOIN #b y ON x.$id = y.$id"
  );
  expect(a.statements[2].dependsOn).toEqual([0, 1]);
});

test("CREATE の AS 句が他の一時テーブルを参照すると依存に入る", () => {
  const a = analyze(
    "CREATE TEMP TABLE #a AS SELECT * FROM APP100;" +
    "CREATE TEMP TABLE #b AS SELECT * FROM #a"
  );
  expect(a.statements[1].tempTablesReferenced).toEqual(["#a"]);
  expect(a.statements[1].dependsOn).toEqual([0]);
});

test("DROP は対象の CREATE に依存する", () => {
  const a = analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100; DROP TEMP TABLE #t");
  expect(a.statements[1].dependsOn).toEqual([0]);
  expect(a.statements[1].tempTablesDropped).toEqual(["#t"]);
});

test("サブクエリ内の参照も依存として拾う（DML の WHERE 内）", () => {
  const a = analyze(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
    "UPDATE APP200 SET x = 1 WHERE $id IN (SELECT $id FROM #t)"
  );
  expect(a.statements[1].tempTablesReferenced).toEqual(["#t"]);
  expect(a.statements[1].dependsOn).toEqual([0]);
});

test("WITH 内の一時テーブル参照も拾う", () => {
  const a = analyze(
    "CREATE TEMP TABLE #t AS SELECT * FROM APP100;" +
    "WITH c AS (SELECT * FROM #t) SELECT * FROM c"
  );
  expect(a.statements[1].tempTablesReferenced).toEqual(["#t"]);
});

test("依存しない文の dependsOn は空", () => {
  const a = analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100; SELECT * FROM APP200");
  expect(a.statements[1].dependsOn).toEqual([]);
});

// ----------------------------------------------------------------
// 単文入力の CREATE / DROP TEMP TABLE 拒否（仕様 §4.3）
// ----------------------------------------------------------------

test("単文の CREATE TEMP TABLE は ArgumentError", () => {
  expect(() => analyze("CREATE TEMP TABLE #t AS SELECT * FROM APP100"))
    .toThrow(/ArgumentError: CREATE TEMP TABLE requires a batch \(temp tables are batch-scoped\)\./);
});

test("単文の DROP TEMP TABLE は ArgumentError", () => {
  expect(() => analyze("DROP TEMP TABLE #t"))
    .toThrow(/ArgumentError: DROP TEMP TABLE requires a batch \(temp tables are batch-scoped\)\./);
});

test("単文の SELECT は通常どおり解析される", () => {
  const a = analyze("SELECT * FROM APP100");
  expect(a.statementCount).toBe(1);
  expect(a.isReadOnlyBatch).toBe(true);
});

// ----------------------------------------------------------------
// 空バッチの拒否
// ----------------------------------------------------------------

test("空配列は ArgumentError", () => {
  expect(() => analyzeBatch([])).toThrow(/ArgumentError: SQL is empty\./);
});

test("空入力・セミコロンのみの入力は ArgumentError", () => {
  expect(() => analyze("")).toThrow(/ArgumentError: SQL is empty\./);
  expect(() => analyze(" ; ; ")).toThrow(/ArgumentError: SQL is empty\./);
});
