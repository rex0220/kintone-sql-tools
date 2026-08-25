import {
  explainNeedsAppMetadata,
  explainNeedsNativeUpsertTargetMetadata,
} from "../explainMetadata";
import { parseSqlStatement, parseSqlStatements } from "../sql";

describe("explainNeedsAppMetadata", () => {
  test.each([
    "SELECT * FROM APP88",
    "SELECT * FROM APP88 WHERE $id = 1",
    "SELECT a.$id,b.$id FROM APP88 a CROSS JOIN APP99 b",
    "DELETE FROM APP88 WHERE $id = 1",
  ])("組み込み列だけの dry-run はフォーム定義を必要としない: %s", (sql) => {
    expect(explainNeedsAppMetadata(parseSqlStatement(sql))).toBe(false);
  });

  test.each([
    "SELECT * FROM APP88 WHERE 郵便番号 > '100'",
    "SELECT * FROM APP88 ORDER BY 郵便番号",
    "SELECT ROW_NUMBER() OVER (ORDER BY 郵便番号) AS rn FROM APP88",
    "UPDATE APP88 SET 状態 = '完了' WHERE 郵便番号 > '100'",
    "WITH s AS (SELECT '食パン' AS k) SELECT s.k FROM s INNER JOIN APP88 AS t ON s.k = t.キー",
    "WITH s AS (GENERATE_SERIES('2025-08-04','2025-08-06') AS 日付) SELECT s.日付 FROM s INNER JOIN APP88 AS t ON s.日付 = t.日付",
  ])("型依存の計画はフォーム定義を必要とする: %s", (sql) => {
    expect(explainNeedsAppMetadata(parseSqlStatement(sql))).toBe(true);
  });

  test("バッチとサブクエリを再帰的に判定する", () => {
    const statements = parseSqlStatements(
      "SELECT * FROM APP88; SELECT * FROM APP99 WHERE $id IN (SELECT $id FROM APP100 ORDER BY 名前)"
    );
    expect(statements.some(explainNeedsAppMetadata)).toBe(true);
  });

  test("B44: APPLY target はフォーム metadata を必要とする", () => {
    expect(explainNeedsAppMetadata(parseSqlStatement(
      "EXPLAIN UPDATE APP88 SET 親 = 'x' WHERE $id = 1 APPLY 明細 (PATCH SET 子 = 'x' ALL ROWS)"
    ))).toBe(true);
  });

  test("B176: CLI offline helper と runtime 用 native UPSERT helper を分離する", () => {
    const upsert = parseSqlStatement(
      "UPSERT INTO APP88 (key) VALUES ('K1') ON DUPLICATE (key)"
    );
    expect(explainNeedsAppMetadata(upsert)).toBe(false);
    expect(explainNeedsNativeUpsertTargetMetadata(upsert)).toBe(true);
    expect(explainNeedsNativeUpsertTargetMetadata(parseSqlStatement("SELECT * FROM APP88"))).toBe(false);
  });

  test.each([
    "SELECT category, COUNT(*) FROM APP88 GROUP BY category",
    "SELECT category FROM APP88 GROUP BY category",
    "SELECT category, COUNT(*) FROM APP88 GROUP BY category HAVING COUNT(*) > 1",
    "SELECT a.category, COUNT(*) FROM APP88 a LEFT JOIN APP99 b ON a.id = b.id GROUP BY a.category",
  ])("B123: 通常 GROUP BY はフォーム定義を必要とする: %s", (sql) => {
    expect(explainNeedsAppMetadata(parseSqlStatement(sql))).toBe(true);
  });

  test.each([
    "WITH grouped AS (SELECT category, COUNT(*) AS count FROM APP88 GROUP BY category) SELECT * FROM grouped",
    "SELECT * FROM APP88 WHERE $id IN (SELECT $id FROM APP99 GROUP BY $id)",
  ])("B123: CTE / サブクエリ内の通常 GROUP BY も再帰的に判定する: %s", (sql) => {
    expect(explainNeedsAppMetadata(parseSqlStatement(sql))).toBe(true);
  });
});
