import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement } from "../../types/ast";
import { KintoneQueryError, whereToKintone } from "../whereToKintone";

function where(sql: string) {
  return (new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement).where!;
}

test("中央ガード: LIKE / NOT LIKE をワイルドカードの有無にかかわらず拒否", () => {
  expect(() => whereToKintone(where("SELECT * FROM APP100 WHERE 件名 LIKE '報告%'"))).toThrow(KintoneQueryError);
  expect(() => whereToKintone(where("SELECT * FROM APP100 WHERE 件名 NOT LIKE '_一時'"))).toThrow(KintoneQueryError);
  expect(() => whereToKintone(where("SELECT * FROM APP100 WHERE 件名 LIKE '報告'"))).toThrow(KintoneQueryError);
  expect(() => whereToKintone(where("SELECT * FROM APP100 WHERE 件名 NOT LIKE '一時'"))).toThrow(KintoneQueryError);
});
