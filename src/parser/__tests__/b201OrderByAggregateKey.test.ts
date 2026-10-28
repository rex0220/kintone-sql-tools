import { parseSqlStatementsForScript } from "../../core/sql";
import { ORDER_BY_AGGREGATE_KEY_MESSAGE } from "../parser";
import type { SelectStatement, UpdateStatement } from "../../types/ast";

const header = "-- @ksql dialect: 1\n";
const parse = (sql: string) => parseSqlStatementsForScript(`${header}${sql}`);

describe("B201: 文の ORDER BY / KORDER BY のキーに集計式は書けない（案 B＝書いた時点で断る）", () => {
  test.each([
    ["SUM", "SELECT 担当者, SUM(金額) FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) DESC"],
    ["列に別名があっても同じ", "SELECT 担当者, SUM(金額) AS 合計 FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) DESC"],
    ["COUNT(*)", "SELECT 担当者, COUNT(*) FROM APP1 GROUP BY 担当者 ORDER BY COUNT(*) DESC"],
    ["MAX", "SELECT 担当者, MAX(金額) FROM APP1 GROUP BY 担当者 ORDER BY MAX(金額)"],
    ["AVG", "SELECT 担当者, AVG(金額) FROM APP1 GROUP BY 担当者 ORDER BY AVG(金額) DESC"],
    ["DISTINCT 集計", "SELECT 担当者, SUM(DISTINCT 金額) FROM APP1 GROUP BY 担当者 ORDER BY SUM(DISTINCT 金額)"],
    ["GROUP BY なし", "SELECT SUM(金額) FROM APP1 ORDER BY SUM(金額)"],
    ["KORDER BY", "SELECT 担当者, 金額 FROM APP1 KORDER BY SUM(金額) DESC LIMIT 10"],
    ["CTE の中", "WITH t AS (SELECT 担当者, SUM(金額) AS 合計 FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) DESC) SELECT * FROM t"],
    ["UNION の枝", "SELECT 担当者, SUM(金額) AS 合計 FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) DESC"
      + " UNION ALL SELECT 担当者, 金額 FROM APP2"],
    ["INSERT ... SELECT のソース", "INSERT INTO APP2 (担当者, 金額)"
      + " SELECT 担当者, SUM(金額) FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) DESC"],
    ["一時テーブルのソース", "CREATE TEMP TABLE #t AS"
      + " SELECT 担当者, SUM(金額) AS 合計 FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) DESC"],
    ["APPLY APPEND のソース（B200-2）", "UPDATE APP2 SET 合計 = 1 WHERE $id = 1"
      + " APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者, 金額)"
      + " SELECT 担当者, SUM(金額) FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) DESC)"],
  ])("拒否する: %s", (_label, sql) => {
    expect(() => parse(sql)).toThrow(ORDER_BY_AGGREGATE_KEY_MESSAGE.split("\n")[0]);
  });

  test("メッセージは別名の付け方を示す", () => {
    expect(ORDER_BY_AGGREGATE_KEY_MESSAGE).toContain("SUM(金額) AS 金額合計");
    expect(ORDER_BY_AGGREGATE_KEY_MESSAGE).toContain("OVER (ORDER BY …) では集計式を書けます");
  });
});

describe("B201: 通る形は変わらない", () => {
  test("別名で並べる", () => {
    const statement = parse("SELECT 担当者, SUM(金額) AS 合計 FROM APP1 GROUP BY 担当者 ORDER BY 合計 DESC")
      .statements[0] as SelectStatement;
    expect(statement.orderBy).toEqual([{ key: { type: "FIELD_NAME", name: "合計" }, direction: "DESC" }]);
  });

  test("列名で並べる", () => {
    expect(() => parse("SELECT 担当者, 金額 FROM APP1 ORDER BY 金額 DESC")).not.toThrow();
  });

  test.each([
    ["順位系ウィンドウ", "SELECT 担当者, SUM(金額) AS 合計, ROW_NUMBER() OVER (ORDER BY SUM(金額) DESC) AS r"
      + " FROM APP1 GROUP BY 担当者"],
    ["文の ORDER BY と併記", "SELECT 担当者, SUM(金額) AS 合計, ROW_NUMBER() OVER (ORDER BY SUM(金額) DESC) AS r"
      + " FROM APP1 GROUP BY 担当者 ORDER BY 担当者"],
    ["集計ウィンドウ", "SELECT 担当者, SUM(金額) AS 合計,"
      + " SUM(SUM(金額)) OVER (ORDER BY SUM(金額) DESC) AS 累計 FROM APP1 GROUP BY 担当者"],
  ])("ウィンドウの OVER (ORDER BY 集計式) は通る: %s", (_label, sql) => {
    expect(() => parse(sql)).not.toThrow();
  });

  test("集計式の算術は従来どおり別のメッセージで止まる（変更なし）", () => {
    expect(() => parse("SELECT 担当者, SUM(金額) FROM APP1 GROUP BY 担当者 ORDER BY SUM(金額) * 2 DESC"))
      .toThrow("フィールド名またはテーブル名が必要です");
  });

  test("REORDER BY は対象外（動きを変えていない）", () => {
    const statement = parse("REORDER APP1$明細 BY SUM(子金額) DESC WHERE $id = 1").statements[0];
    expect(statement.type).toBe("REORDER");
  });

  test("B200-2 のソースは別名で並べれば通る", () => {
    const statement = parse("UPDATE APP2 SET 合計 = 1 WHERE $id = 1"
      + " APPLY 明細 (REMOVE ALL ROWS; APPEND (担当者, 金額)"
      + " SELECT 担当者, SUM(金額) AS 金額合計 FROM APP1 GROUP BY 担当者 ORDER BY 金額合計 DESC)")
      .statements[0] as UpdateStatement;
    const operation = statement.applyBlocks![0].operations[1];
    expect(operation).toMatchObject({ kind: "APPEND" });
  });
});
