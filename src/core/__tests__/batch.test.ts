// ============================================================
// バッチ静的検証（analyzeBatch）のテスト（フェーズ1 S3）
// ============================================================

import { analyzeBatch, BatchAnalysisError, MAX_TEMP_TABLES } from "../batch";
import { parseSqlStatements } from "../sql";

function analyze(sql: string) {
  return analyzeBatch(parseSqlStatements(sql));
}
function analyzeImport(sql: string) {
  return analyzeBatch(parseSqlStatements(sql, { import: true }));
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

test("VALIDATE ONLY はread-onlyだが完全入力を要求する", () => {
  const a = analyze("INSERT INTO APP100 (x) VALUES ('a') VALIDATE ONLY");
  expect(a.isReadOnlyBatch).toBe(true);
  expect(a.containsDml).toBe(false);
  expect(a.containsValidationOnly).toBe(true);
  expect(a.requiresCompleteInput).toBe(true);
  expect(a.statements[0]).toMatchObject({ isDml: false, isReadOnly: true, isValidationOnly: true });
});

test("B44 Phase 1: APPLY mutation / VALIDATE ONLY を正しく分類する", () => {
  const operation = "APPLY 明細 (PATCH SET 子 = 'x' ALL ROWS)";
  const mutation = analyze(`UPDATE APP100 SET 親 = 'x' WHERE $id = 1 ${operation}`);
  expect(mutation.statements[0]).toMatchObject({
    statementType: "UPDATE", isDml: true, isReadOnly: false, requiresCompleteInput: true,
  });
  const validation = analyze(`UPDATE APP100 SET 親 = 'x' WHERE $id = 1 ${operation} VALIDATE ONLY`);
  expect(validation.statements[0]).toMatchObject({
    statementType: "UPDATE", isDml: false, isReadOnly: true,
    isValidationOnly: true, requiresCompleteInput: true,
  });
});

test("B44 Phase 8: batch は全実行前に APPLY v1.2 scope を検証する", () => {
  expect(() => analyze(
    "SELECT * FROM APP100; UPDATE APP100 SET 親 = 'x' WHERE $id = 1 APPLY 明細 (REMOVE ALL ROWS)"
  )).not.toThrow();
  expect(() => analyze(
    "SELECT * FROM APP100; UPDATE APP100 SET 親 = 'x' WHERE $id = 1 APPLY 明細 (REMOVE ALL ROWS EXPECT ROWS 1)"
  )).toThrow(/UnsupportedError: APPLY v1\.2 scope does not support EXPECT ROWS/);
});

test("B30: ORDER BY は SELECT / WINDOW / UNION / WITH / temp を横断して完全入力を要求する", () => {
  expect(analyze("SELECT * FROM APP100 ORDER BY name").requiresCompleteInput).toBe(true);
  expect(analyze(
    "SELECT ROW_NUMBER() OVER (ORDER BY name) AS rn FROM APP100"
  ).requiresCompleteInput).toBe(true);
  expect(analyze(
    "SELECT name FROM APP100 UNION ALL SELECT name FROM APP200 ORDER BY name"
  ).requiresCompleteInput).toBe(true);
  expect(analyze(
    "WITH x AS (SELECT name FROM APP100 ORDER BY name) SELECT name FROM x"
  ).requiresCompleteInput).toBe(true);
  expect(analyze(
    "CREATE TEMP TABLE #x AS SELECT name FROM APP100 ORDER BY name; SELECT * FROM #x"
  ).requiresCompleteInput).toBe(true);
});

test("B30: ORDER BY のないread-only SELECTとEXPLAIN自体はtruncateを禁止しない", () => {
  expect(analyze("SELECT * FROM APP100").requiresCompleteInput).toBe(false);
  expect(analyze("EXPLAIN SELECT * FROM APP100 ORDER BY name").requiresCompleteInput).toBe(false);
});

test("VALIDATE ONLY INTO は暗黙temp作成・同schema appendを解析する", () => {
  const a = analyze(
    "INSERT INTO APP100 (x) VALUES ('a') VALIDATE ONLY INTO #err; " +
    "INSERT INTO APP100 (x) VALUES ('b') VALIDATE ONLY INTO #err; SELECT * FROM #err"
  );
  expect(a.statements[0].tempTablesCreated).toEqual(["#err"]);
  expect(a.statements[1].dependsOn).toEqual([0]);
  expect(a.statements[2].dependsOn).toEqual([0]);
});

test("VALIDATE ONLY INTO の単文・異schema appendを拒否する", () => {
  expect(() => analyze("INSERT INTO APP100 (x) VALUES ('a') VALIDATE ONLY INTO #err")).toThrow(
    "ArgumentError: VALIDATE ONLY INTO requires a batch."
  );
  expect(() => analyze(
    "INSERT INTO APP100 (x) VALUES ('a') VALIDATE ONLY INTO #err; " +
    "INSERT INTO APP100 (y) VALUES ('b') VALIDATE ONLY INTO #err"
  )).toThrow("different payload schema");
});

test("Phase 5 IMPORT error table schema is extended without changing the existing validation schema", () => {
  const phase5 = analyzeImport(
    "IMPORT INTO APP100 (code, Lines(name)) FROM JSON src VALIDATE ONLY INTO #err; SELECT * FROM #err"
  );
  expect(phase5.statements[0].tempTablesCreated).toEqual(["#err"]);
  expect(() => analyzeImport(
    "INSERT INTO APP100 (code) VALUES ('A') VALIDATE ONLY INTO #err; " +
    "IMPORT INTO APP100 (code, Lines(name)) FROM JSON src VALIDATE ONLY INTO #err"
  )).toThrow("different payload schema");
});

test("ON ERROR SKIP は書き込みDML・完全入力・暗黙tempとして解析し単文を拒否する", () => {
  expect(() => analyze(
    "INSERT INTO APP100 (x) VALUES ('a') ON ERROR SKIP INTO #err"
  )).toThrow("ArgumentError: ON ERROR SKIP requires a batch.");
  const a = analyze(
    "INSERT INTO APP100 (x) VALUES ('a') ON ERROR SKIP INTO #err; SELECT * FROM #err"
  );
  expect(a).toMatchObject({ containsDml: true, isReadOnlyBatch: false, requiresCompleteInput: true });
  expect(a.statements[0]).toMatchObject({
    isDml: true, isReadOnly: false, isOnErrorSkip: true, tempTablesCreated: ["#err"],
  });
  expect(a.statements[1].dependsOn).toEqual([0]);
});

test("UPDATE FROM #temp は collectRefs により依存と参照が自動配線される", () => {
  const a = analyze(
    "CREATE TEMP TABLE #e AS SELECT $id AS k, name AS f FROM APP200; " +
    "UPDATE APP100 SET name = e.f FROM #e e WHERE APP100.$id = e.k"
  );
  expect(a.statements[1].tempTablesReferenced).toEqual(["#e"]);
  expect(a.statements[1].dependsOn).toEqual([0]);
  expect(a.statements[1].isUpdateFrom).toBe(true);
});

test("UPDATE FROM の未定義・DROP 後 #temp 参照を拒否する", () => {
  expect(() => analyze("UPDATE APP100 SET name = e.f FROM #e e WHERE APP100.$id = e.k")).toThrow(BatchAnalysisError);
  expect(() => analyze(
    "CREATE TEMP TABLE #e AS SELECT $id AS k, name AS f FROM APP200; DROP TEMP TABLE #e; " +
    "UPDATE APP100 SET name = e.f FROM #e e WHERE APP100.$id = e.k"
  )).toThrow(BatchAnalysisError);
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

test("SET_VARIABLE は read-only で、参照索引と未使用警告を返す", () => {
  const a = analyze("SET @Used = 10; SET @unused = 'x'; SELECT * FROM APP100 WHERE 売上 > @used");
  expect(a.isReadOnlyBatch).toBe(true);
  expect(a.variables).toEqual([
    { name: "used", kind: "scalar", referencedBy: [2] },
    { name: "unused", kind: "scalar", referencedBy: [] },
  ]);
  expect(a.warnings).toEqual(["variable @unused is never used."]);
});

test("DECLARE_VARIABLE は SET と名前空間・参照解析を共有する", () => {
  const a = analyze("DECLARE @p = 'x'; SELECT * FROM APP100 WHERE 顧客名 = @p");
  expect(a.isReadOnlyBatch).toBe(true);
  expect(a.variables).toEqual([{ name: "p", kind: "scalar", referencedBy: [1] }]);
  expect(a.statements[0]).toMatchObject({ statementType: "DECLARE_VARIABLE", isReadOnly: true });
  expect(() => analyze("DECLARE @x = 1; SET @X = 2")).toThrow(/already defined/);
  expect(() => analyze("DECLARE @x = 1")).toThrow(/DECLARE variable requires a batch/);
});

test("変数の未定義・前方参照・再代入を静的に拒否する", () => {
  expect(() => analyze("SELECT * FROM APP100; SELECT * FROM APP100 WHERE 売上 > @missing"))
    .toThrow(/variable @missing is not defined/);
  expect(() => analyze("SELECT * FROM APP100 WHERE 売上 > @x; SET @x = 1"))
    .toThrow(/variable @x is not defined/);
  expect(() => analyze("SET @x = 1; SET @X = 2"))
    .toThrow(/variable @x is already defined/);
});

test("IN リスト内の変数を静的解析し、参照索引・未定義・前方参照を扱う", () => {
  const a = analyze("SET @a = 'A'; SET @b = 'B'; SELECT * FROM APP100 WHERE 種別 IN (@a, @b, 'C')");
  expect(a.variables).toEqual([
    { name: "a", kind: "scalar", referencedBy: [2] },
    { name: "b", kind: "scalar", referencedBy: [2] },
  ]);
  expect(() => analyze("SET @a = 'A'; SELECT * FROM APP100 WHERE 種別 IN (@a, @missing)"))
    .toThrow(/variable @missing is not defined/);
  expect(() => analyze("SELECT * FROM APP100 WHERE 種別 IN (@later); SET @later = 'A'"))
    .toThrow(/variable @later is not defined/);
});

test("SET スカラーサブクエリ内の先行変数を汎用再帰で参照索引へ収集する", () => {
  const a = analyze(
    "SET @cutoff = 100;" +
    "SET @cnt = (SELECT COUNT(*) FROM APP100 WHERE 売上 > @cutoff);" +
    "ASSERT @cnt >= 0"
  );
  expect(a.variables).toEqual([
    { name: "cutoff", kind: "scalar", referencedBy: [1] },
    { name: "cnt", kind: "scalar", referencedBy: [2] },
  ]);
});

test("SET スカラーサブクエリ内の一時テーブル参照を依存関係へ収集する", () => {
  const a = analyze(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
    "SET @cnt = (SELECT COUNT(*) FROM #t);" +
    "ASSERT @cnt >= 0"
  );
  expect(a.statements[1].tempTablesReferenced).toEqual(["#t"]);
  expect(a.statements[1].dependsOn).toEqual([0]);
});

test("array/scalar の定義 kind と参照 kind を validate-all-first で検査する", () => {
  const a = analyze("SET @s='A'; SET @l=['A','B']; SELECT @s AS c FROM APP100 WHERE code IN @l");
  expect(a.variables).toEqual([
    { name: "s", kind: "scalar", referencedBy: [2] },
    { name: "l", kind: "array", referencedBy: [2] },
  ]);
  expect(() => analyze("SET @s='A'; SELECT * FROM APP100 WHERE code IN @s")).toThrow(/scalar variable/);
  expect(() => analyze("SET @l=['A']; SELECT @l AS c FROM APP100")).toThrow(/array variable/);
  expect(() => analyze("SET @l=['A']; SELECT * FROM APP100 WHERE code IN (@l)")).toThrow(/array variable/);
});

test("単文 SET はエラー", () => {
  expect(() => analyze("SET @x = 1")).toThrow(/SET variable requires a batch/);
});

// ----------------------------------------------------------------
// ASSERT（バッチ強化第1弾 A2）
// ----------------------------------------------------------------

test("ASSERT は read-only 扱い（read-only バッチを維持する）", () => {
  const a = analyze("SELECT * FROM APP100; ASSERT (SELECT COUNT(*) FROM APP100) > 0");
  expect(a.isReadOnlyBatch).toBe(true);
  expect(a.containsDml).toBe(false);
  expect(a.statements[1]).toMatchObject({
    statementType: "ASSERT",
    isDml: false,
    isReadOnly: true,
    hasWhere: false,
    targetAppId: null,
  });
});

test("ASSERT のサブクエリから appIds を収集する", () => {
  const a = analyze("SELECT * FROM APP100; ASSERT (SELECT COUNT(*) FROM APP200) = 0");
  expect(a.statements[1].appIds).toEqual([200]);
});

test("ASSERT の一時テーブル参照は tempTablesReferenced / dependsOn に入る", () => {
  const a = analyze(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500"
  );
  expect(a.statements[1].tempTablesReferenced).toEqual(["#t"]);
  expect(a.statements[1].dependsOn).toEqual([0]);
});

test("ASSERT の未定義一時テーブル参照はエラー", () => {
  expect(() => analyze("SELECT * FROM APP100; ASSERT (SELECT COUNT(*) FROM #t) = 0"))
    .toThrow(/temp table #t is not defined in this batch/);
});

test("単文の ASSERT は許可される（CREATE / DROP TEMP TABLE と異なる）", () => {
  const a = analyze("ASSERT (SELECT COUNT(*) FROM APP100 WHERE 異常フラグ = '1') = 0");
  expect(a.statementCount).toBe(1);
  expect(a.isReadOnlyBatch).toBe(true);
  expect(a.statements[0].statementType).toBe("ASSERT");
});

test("DML バッチ内の ASSERT: バッチは DML 扱いのまま・ASSERT 文自体は read-only", () => {
  const a = analyze(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100 WHERE 売上 > 100;" +
    "ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500;" +
    "UPDATE APP100 SET 状態 = '対象' WHERE $id IN (SELECT $id FROM #t)"
  );
  expect(a.containsDml).toBe(true);
  expect(a.isReadOnlyBatch).toBe(false);
  expect(a.statements[1].isReadOnly).toBe(true);
  expect(a.statements[2].dependsOn).toEqual([0]);
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
