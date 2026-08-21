import { Lexer } from "../../lexer/lexer";
import { ParseError, Parser } from "../parser";

function parseDialect1(sql: string) {
  return new Parser(new Lexer(sql).tokenize(), { dialect1: true }).parseStatements();
}

function parseDialect0(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parseStatements();
}

const createSource = "CREATE TEMP TABLE temp_monthly_summary AS SELECT 顧客コード, 受注件数, 当月売上合計 FROM APP100";

test("B168 acceptance 3: UPSERT KEY and MERGE normalize to deeply equal UPSERT_SELECT AST", () => {
  const upsert = parseDialect1(`${createSource};
    UPSERT INTO APP200 (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
    SELECT 顧客コード, 受注件数, 当月売上合計, CURRENT_TIMESTAMP() FROM temp_monthly_summary
    KEY (顧客コード)`)[1];
  const merge = parseDialect1(`${createSource};
    MERGE INTO APP200 AS t
    USING temp_monthly_summary AS s
    ON t.顧客コード = s.顧客コード
    WHEN MATCHED THEN UPDATE SET
      当月受注件数 = s.受注件数,
      当月売上実績 = s.当月売上合計,
      最終集計日時 = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT
      (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
      VALUES (s.顧客コード, s.受注件数, s.当月売上合計, CURRENT_TIMESTAMP())`)[1];

  expect(merge).toEqual(upsert);
  expect(merge.type).toBe("UPSERT_SELECT");
});

test("dialect 1 bare TEMP names normalize through declaration, FROM/JOIN, and DROP", () => {
  const statements = parseDialect1(
    "CREATE TEMP TABLE bare AS SELECT code FROM APP100;" +
    "CREATE TEMP TABLE #legacy AS SELECT code FROM bare;" +
    "SELECT b.code FROM bare AS b INNER JOIN #legacy AS l ON b.code = l.code;" +
    "DROP TEMP TABLE bare; DROP TEMP TABLE #legacy"
  );
  expect(statements[0]).toMatchObject({ type: "CREATE_TEMP_TABLE", name: "#bare" });
  expect(statements[1]).toMatchObject({ type: "CREATE_TEMP_TABLE", name: "#legacy", query: { from: { cteName: "#bare" } } });
  expect(statements[2]).toMatchObject({
    type: "SELECT",
    from: { cteName: "#bare", alias: "b" },
    joins: [{ table: { cteName: "#legacy", alias: "l" } }],
  });
  expect(statements[3]).toEqual({ type: "DROP_TEMP_TABLE", name: "#bare" });
  expect(statements[4]).toEqual({ type: "DROP_TEMP_TABLE", name: "#legacy" });
});

test("dialect 0 keeps bare TEMP and MERGE gated while legacy # TEMP remains valid", () => {
  expect(() => parseDialect0("CREATE TEMP TABLE bare AS SELECT * FROM APP100"))
    .toThrow(/一時テーブル名は # で始まる必要があります/);
  expect(() => parseDialect0("MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k"))
    .toThrow(/-- @ksql dialect: 1 の宣言が必要/);
  expect(parseDialect0("CREATE TEMP TABLE #legacy AS SELECT * FROM APP100; DROP TEMP TABLE #legacy"))
    .toHaveLength(2);
});

test("KEY lookahead is never consumed as an implicit table alias", () => {
  expect(() => parseDialect1("WITH t AS (SELECT k FROM APP100) SELECT * FROM t KEY (k)"))
    .toThrow(ParseError);
  expect(parseDialect1("WITH t AS (SELECT k FROM APP100) SELECT * FROM t k")[0])
    .toMatchObject({ query: { from: { cteName: "t", alias: "k" } } });
  expect(parseDialect1("SELECT key AS KEY FROM APP100")[0])
    .toMatchObject({ columns: [{ type: "FIELD", field: "key", alias: "key" }] });
});

test.each([
  [
    "multiple ON keys",
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k AND t.k2 = s.k2 WHEN MATCHED THEN UPDATE SET v=s.v WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,s.v)",
    /単一キー.*連結キーフィールド/,
  ],
  [
    "non equality ON",
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k <> s.k WHEN MATCHED THEN UPDATE SET v=s.v WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,s.v)",
    /単一キーの等値.*連結キーフィールド/,
  ],
  [
    "alias mismatch ON",
    "MERGE INTO APP200 AS t USING APP100 AS s ON x.k = s.k WHEN MATCHED THEN UPDATE SET v=s.v WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,s.v)",
    /t\.key = s\.key の別名修飾/,
  ],
  [
    "different expressions",
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k WHEN MATCHED THEN UPDATE SET v=s.v WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,'different')",
    /両句の式が一致する場合のみ MERGE を UPSERT へ正規化できます/,
  ],
  [
    "missing NOT MATCHED",
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k WHEN MATCHED THEN UPDATE SET v=s.v",
    /両句が必要.*UPDATE \.\.\. FROM.*INSERT \.\.\. SELECT/,
  ],
  [
    "missing MATCHED",
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,s.v)",
    /両句が必要.*UPDATE \.\.\. FROM.*INSERT \.\.\. SELECT/,
  ],
  [
    "missing key in INSERT fields",
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k WHEN MATCHED THEN UPDATE SET v=s.v WHEN NOT MATCHED THEN INSERT (v) VALUES (s.v)",
    /ON キー k は INSERT 列リストに含めてください/,
  ],
])("MERGE rejects %s with cause and remediation", (_case, sql, message) => {
  expect(() => parseDialect1(sql)).toThrow(message);
});

test("MERGE reuses UPSERT suffix parsers without leaving MERGE syntax in AST", () => {
  const statement = parseDialect1(
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k " +
    "WHEN MATCHED THEN UPDATE SET v=s.v " +
    "WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,s.v) " +
    "CHECK WHEN v = '' THEN 'required' VALIDATE ONLY INTO #errors"
  )[0];
  expect(statement).toMatchObject({
    type: "UPSERT_SELECT",
    checkGroups: [{ rules: [{ message: { type: "STRING", value: "required" } }] }],
    validateOnly: true,
    validationErrorTable: "#errors",
  });
  expect(statement).not.toHaveProperty("merge");
});

test("MERGE expression comparison strips the source qualifier and compares numeric literal values", () => {
  const statement = parseDialect1(
    "MERGE INTO APP200 AS t USING APP100 AS s ON t.k = s.k " +
    "WHEN MATCHED THEN UPDATE SET t.v=1 " +
    "WHEN NOT MATCHED THEN INSERT (k,v) VALUES (s.k,1.0)"
  )[0];
  expect(statement).toMatchObject({
    type: "UPSERT_SELECT",
    fields: ["k", "v"],
    select: { columns: [{ type: "FIELD", field: "k" }, { type: "ARITH_COL", expr: { value: 1, raw: "1.0" } }] },
  });
});
