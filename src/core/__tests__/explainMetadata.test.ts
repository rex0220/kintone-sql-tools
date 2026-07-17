import { explainNeedsAppMetadata } from "../explainMetadata";
import { parseSqlStatement, parseSqlStatements } from "../sql";

describe("explainNeedsAppMetadata", () => {
  test.each([
    "SELECT * FROM APP88",
    "SELECT * FROM APP88 WHERE $id = 1",
    "DELETE FROM APP88 WHERE $id = 1",
  ])("組み込み列だけの dry-run はフォーム定義を必要としない: %s", (sql) => {
    expect(explainNeedsAppMetadata(parseSqlStatement(sql))).toBe(false);
  });

  test.each([
    "SELECT * FROM APP88 WHERE 郵便番号 > '100'",
    "SELECT * FROM APP88 ORDER BY 郵便番号",
    "SELECT ROW_NUMBER() OVER (ORDER BY 郵便番号) AS rn FROM APP88",
    "UPDATE APP88 SET 状態 = '完了' WHERE 郵便番号 > '100'",
  ])("型依存の WHERE / ORDER BY はフォーム定義を必要とする: %s", (sql) => {
    expect(explainNeedsAppMetadata(parseSqlStatement(sql))).toBe(true);
  });

  test("バッチとサブクエリを再帰的に判定する", () => {
    const statements = parseSqlStatements(
      "SELECT * FROM APP88; SELECT * FROM APP99 WHERE $id IN (SELECT $id FROM APP100 ORDER BY 名前)"
    );
    expect(statements.some(explainNeedsAppMetadata)).toBe(true);
  });
});
