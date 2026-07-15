import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { Statement } from "../../types/ast";
import { KlikeValidationError, validateKlikeStatement } from "../klikeValidation";

function raw(sql: string): Statement {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

test.each([
  "SELECT * FROM APP100 WHERE 件名 KLIKE '至急'",
  "SELECT * FROM APP100 WHERE 件名 KLIKE 'foo_bar' OR 種別 = 'A'",
  "SELECT * FROM APP100 WHERE NOT (件名 KLIKE '至急')",
  "SELECT (SELECT $id FROM APP200 WHERE 件名 KLIKE '至急' LIMIT 1) AS x FROM APP100",
  "SELECT * FROM APP100 WHERE EXISTS (SELECT $id FROM APP200 WHERE 件名 KLIKE '至急')",
  "SELECT * FROM APP100 WHERE 件名 KLIKE 'A' UNION ALL SELECT * FROM APP200 WHERE 件名 NOT KLIKE 'B'",
])("SIMPLE の各 SELECT スコープでは KLIKE を許可する — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).not.toThrow();
});

test.each([
  "SELECT DISTINCT 件名 FROM APP100 WHERE 件名 KLIKE '至急'",
  "SELECT COUNT(*) FROM APP100 WHERE 件名 KLIKE '至急'",
  "SELECT * FROM APP100 WHERE 件名 KLIKE '至急' AND 備考 LIKE '%A%'",
  "SELECT * FROM APP100 a JOIN APP200 b ON a.ID = b.ID WHERE a.件名 KLIKE '至急'",
  "SELECT * FROM APP100 WHERE 件名 KLIKE '至急' ORDER BY LENGTH(件名)",
  "SELECT * FROM APP100$明細 WHERE 商品名 KLIKE '至急'",
])("同一 SELECT が FULL_SCAN なら KLIKE を拒否する — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).toThrow(KlikeValidationError);
  expect(() => validateKlikeStatement(raw(sql))).toThrow(/SIMPLE SELECT/);
});

test("% は拒否し、_ は kintone の単語構成文字として許可する", () => {
  expect(() => validateKlikeStatement(raw("SELECT * FROM APP100 WHERE 件名 KLIKE 'A%B'")))
    .toThrow(/% は使用できません/);
  expect(() => validateKlikeStatement(raw("SELECT * FROM APP100 WHERE 件名 KLIKE 'A_B'")))
    .not.toThrow();
});

test("単純 CTE は実効クエリで検証し、KLIKE + LIKE により FULL_SCAN なら拒否する", () => {
  expect(() => validateKlikeStatement(raw(
    "WITH c AS (SELECT * FROM APP100 WHERE 件名 KLIKE '至急') SELECT * FROM c"
  ))).not.toThrow();
  expect(() => validateKlikeStatement(raw(
    "WITH c AS (SELECT * FROM APP100 WHERE 件名 KLIKE '至急') SELECT * FROM c WHERE 備考 LIKE '%A%'"
  ))).toThrow(/FULL_SCAN/);
});

test("非インライン CTE / 一時テーブル上の KLIKE はインメモリ評価になるため拒否する", () => {
  expect(() => validateKlikeStatement(raw(
    "WITH a AS (SELECT * FROM APP100), b AS (SELECT * FROM APP200) SELECT * FROM a WHERE 件名 KLIKE '至急'"
  ))).toThrow(/FULL_SCAN/);
});

test.each([
  "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
  "DELETE FROM APP100 WHERE 件名 NOT KLIKE '至急'",
  "REORDER APP100$明細 BY 商品名 WHERE _rid = '1' AND 商品名 KLIKE '至急'",
  "INSERT INTO APP100 (件名) SELECT 件名 FROM APP200 WHERE 件名 KLIKE '至急'",
  "EXPLAIN UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
])("v1 はネストした SELECT を含む全 DML で KLIKE を拒否する — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).toThrow(/v1 では.*DML/);
});
