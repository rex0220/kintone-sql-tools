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
])("押し下げ可能な AND リーフなら FULL_SCAN でも KLIKE を許可する — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).not.toThrow();
});

test.each([
  "SELECT * FROM APP100$明細 WHERE 商品名 KLIKE '至急'",
  "SELECT DISTINCT 件名 FROM APP100 WHERE 件名 KLIKE '至急' OR 種別 = 'A'",
  "SELECT DISTINCT 件名 FROM APP100 WHERE NOT (件名 KLIKE '至急')",
  "SELECT * FROM APP100 a LEFT JOIN APP200 b ON a.ID = b.ID WHERE a.件名 KLIKE '至急'",
  "SELECT * FROM APP100 a RIGHT JOIN APP200 b ON a.ID = b.ID WHERE b.件名 KLIKE '至急'",
])("押し下げを保証できない FULL_SCAN KLIKE を拒否する — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).toThrow(KlikeValidationError);
  expect(() => validateKlikeStatement(raw(sql))).toThrow(/押し下げ|LEFT \/ RIGHT/);
});

test("% は拒否し、_ は kintone の単語構成文字として許可する", () => {
  expect(() => validateKlikeStatement(raw("SELECT * FROM APP100 WHERE 件名 KLIKE 'A%B'")))
    .toThrow(/% は使用できません/);
  expect(() => validateKlikeStatement(raw("SELECT * FROM APP100 WHERE 件名 KLIKE 'A_B'")))
    .not.toThrow();
});

test("単純 CTE は共通インライン化後 AST で KLIKE を押し下げる", () => {
  expect(() => validateKlikeStatement(raw(
    "WITH c AS (SELECT * FROM APP100 WHERE 件名 KLIKE '至急') SELECT * FROM c"
  ))).not.toThrow();
  expect(() => validateKlikeStatement(raw(
    "WITH c AS (SELECT * FROM APP100 WHERE 件名 KLIKE '至急') SELECT * FROM c WHERE 備考 LIKE '%A%'"
  ))).not.toThrow();
});

test("非インライン CTE / 一時テーブル上の KLIKE はインメモリ評価になるため拒否する", () => {
  expect(() => validateKlikeStatement(raw(
    "WITH a AS (SELECT * FROM APP100), b AS (SELECT * FROM APP200) SELECT * FROM a WHERE 件名 KLIKE '至急'"
  ))).toThrow(/押し下げ/);
});

test.each([
  "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
  "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急' OR 種別 = 'A'",
  "UPDATE APP100 SET 状態 = '完了' WHERE NOT (件名 KLIKE '至急' OR 種別 = 'A')",
  "DELETE FROM APP100 WHERE 件名 NOT KLIKE '至急'",
  "EXPLAIN UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急'",
])("B5: 通常親 UPDATE / DELETE の WHERE KLIKE を許可する — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).not.toThrow();
});

test.each([
  ["UPDATE APP100$明細 SET 商品名 = 'x' WHERE 商品名 KLIKE '至急'", /サブテーブル UPDATE/],
  ["DELETE FROM APP100$明細 WHERE 商品名 NOT KLIKE '至急'", /サブテーブル DELETE/],
  ["REORDER APP100$明細 BY 商品名 WHERE _rid = '1' AND 商品名 KLIKE '至急'", /REORDER/],
  ["INSERT INTO APP100 (件名) SELECT 件名 FROM APP200 WHERE 件名 KLIKE '至急'", /INSERT/],
  ["UPSERT INTO APP100 (件名) SELECT 件名 FROM APP200 WHERE 件名 KLIKE '至急' ON DUPLICATE (件名)", /UPSERT/],
  ["VALIDATE APP100 WHERE 件名 KLIKE '至急'", /VALIDATE/],
])("B5: 対象外 DML の KLIKE を文種・対象種が分かるエラーで拒否する — %s", (sql, message) => {
  expect(() => validateKlikeStatement(raw(sql as string))).toThrow(message as RegExp);
});

test.each([
  "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE 'A%B'",
  "DELETE FROM APP100 WHERE 件名 KLIKE 1",
])("B5: 通常親 DML でも KLIKE の既存右辺制約を維持する — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).toThrow();
});

test("B5: UPDATE の carve-out は WHERE 外の CHECK KLIKE を巻き込まない", () => {
  expect(() => validateKlikeStatement(raw(
    "UPDATE APP100 SET 状態 = '完了' WHERE 件名 KLIKE '至急' " +
    "CHECK WHEN 備考 KLIKE '危険' THEN 'bad' VALIDATE ONLY"
  ))).toThrow(/通常親 UPDATE の WHERE/);
});

test.each([
  "UPDATE APP100 SET 状態='完了' WHERE 件名 KLIKE '至急' APPLY 明細 (PATCH SET 商品名='x' ALL ROWS)",
  "EXPLAIN UPDATE APP100 SET 状態='完了' WHERE 件名 NOT KLIKE '至急' APPLY 明細 (PATCH SET 商品名='x' ALL ROWS)",
])("B47-P3: APPLY複数親UPDATEの親KLIKEだけ共通validationを通す — %s", (sql) => {
  expect(() => validateKlikeStatement(raw(sql))).not.toThrow();
});
