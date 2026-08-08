// ============================================================
// 単文互換スナップショット
//
// S2(複文対応)で parse() の内部を parseStatements() ベースに
// 置き換えるにあたり、既存単文の AST 出力が変わらないことを固定する。
// スナップショットは置き換え前の実装で生成したもの。
// ============================================================

import { parseSqlStatement } from "../../core/sql";
import { ParseError } from "../parser";

const CASES: Array<[string, string]> = [
  ["SELECT 単純", "SELECT * FROM APP100"],
  [
    "SELECT フル句",
    "SELECT 顧客名, SUM(売上) AS 合計 FROM APP100 WHERE ステータス = '完了' GROUP BY 顧客名 HAVING SUM(売上) > 100 ORDER BY 合計 DESC LIMIT 10 OFFSET 5",
  ],
  ["JOIN + 暗黙 alias", "SELECT a.顧客名, b.部署名 FROM APP100 a INNER JOIN APP200 b ON a.部署ID = b.$id"],
  ["CROSS JOIN", "SELECT a.x, b.y FROM APP100 a CROSS JOIN APP200 b"],
  ["WITH CTE", "WITH c1 AS (SELECT 顧客ID FROM APP100) SELECT * FROM c1"],
  ["UNION ALL", "SELECT 顧客名 FROM APP100 UNION ALL SELECT 顧客名 FROM APP200"],
  ["INSERT VALUES", "INSERT INTO APP100 (顧客名, 売上) VALUES ('A', 100), ('B', 200)"],
  ["INSERT SELECT", "INSERT INTO APP100 (顧客名) SELECT 顧客名 FROM APP200"],
  ["UPDATE", "UPDATE APP100 SET ステータス = '完了' WHERE $id = 1"],
  ["UPDATE APPLY", "UPDATE APP100 SET APPLY = '親' WHERE $id = 1 APPLY APPLY (PATCH SET PATCH = '子' ALL ROWS) VALIDATE ONLY"],
  ["APPLY soft keyword alias", "SELECT APPLY AS APPLY FROM APP100 APPLY"],
  ["DELETE", "DELETE FROM APP100 WHERE ステータス = '無効'"],
  ["UPSERT", "UPSERT INTO APP100 (顧客コード, ランク) VALUES ('C1', 'A') ON DUPLICATE (顧客コード)"],
  ["REORDER", "REORDER APP100$明細 BY 商品コード ASC WHERE _pid = 1"],
  ["SHOW APPS", "SHOW APPS"],
  ["DESCRIBE", "DESCRIBE APP100"],
  ["EXPLAIN", "EXPLAIN SELECT * FROM APP100"],
  ["末尾セミコロン", "SELECT * FROM APP100;"],
];

test.each(CASES)("単文互換: %s", (_label, sql) => {
  expect(parseSqlStatement(sql)).toMatchSnapshot();
});

test("単文互換: 単文 API への複文入力はエラーのまま", () => {
  expect(() => parseSqlStatement("SELECT * FROM APP100; SELECT * FROM APP200")).toThrow(ParseError);
});

test("単文互換: 空入力はエラーのまま", () => {
  expect(() => parseSqlStatement("")).toThrow(ParseError);
});
