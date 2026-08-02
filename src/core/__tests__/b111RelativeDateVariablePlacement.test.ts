import { analyzeBatch } from "../batch";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";

function analyze(sql: string) {
  return analyzeBatch(new Parser(new Lexer(sql).tokenize()).parseStatements());
}

test.each([
  "SELECT * FROM APP100 WHERE 日付 = @p",
  "SELECT * FROM APP100 WHERE 日付 BETWEEN @p AND @p",
  "SELECT * FROM APP100 WHERE (日付 >= @p AND 日付 <= @p)",
])("RELATIVE_DATE 変数を WHERE 比較右辺・BETWEEN 境界で許可する: %s", (statement) => {
  expect(() => analyze(`DECLARE @p RELATIVE_DATE = THIS_MONTH(); ${statement}`)).not.toThrow();
});

test.each([
  "SELECT @p AS period FROM APP100",
  "SELECT 日付 FROM APP100 WHERE 日付 IN (@p)",
  "SELECT 日付 FROM APP100 WHERE 件名 KLIKE @p",
  "SELECT (売上 * 100) / @p AS ratio FROM APP100",
  "SELECT 日付, COUNT(*) FROM APP100 GROUP BY 日付 HAVING 日付 = @p",
  "UPDATE APP100 SET 日付 = @p WHERE $id = 1",
])("RELATIVE_DATE 配置違反を名前入り静的エラーにする: %s", (statement) => {
  expect(() => analyze(`DECLARE @p RELATIVE_DATE = THIS_MONTH(); ${statement}`))
    .toThrow(/RELATIVE_DATE variable @p/);
});

test.each([
  "DELETE FROM APP100 WHERE 日付 = @p",
  "UPDATE APP100 SET 件名 = 'x' WHERE 日付 = @p",
  "VALIDATE APP100 WHERE 日付 = @p",
])("RELATIVE_DATE 変数を DML・VALIDATE では fail-closed にする: %s", (statement) => {
  expect(() => analyze(`DECLARE @p RELATIVE_DATE = THIS_MONTH(); ${statement}`))
    .toThrow(/RELATIVE_DATE variable @p.*DML or VALIDATE/);
});
