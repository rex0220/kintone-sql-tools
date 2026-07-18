import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement, WhereExpr } from "../../types/ast";
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

test("IN リストへ未解決 VARIABLE が到達したら変換前に拒否する", () => {
  const unresolved: WhereExpr = {
    type: "BINARY",
    op: "IN",
    left: { type: "FIELD", tableAlias: null, field: "種別" },
    right: {
      type: "IN_LIST",
      values: [
        { type: "STRING", value: "A" },
        { type: "VARIABLE", name: "missing" },
      ],
    },
  };
  expect(() => whereToKintone(unresolved)).toThrow(/未解決のバッチ変数 @missing/);
});

test("IN の負数は引用符なし、文字列の負数は引用符付きで変換する", () => {
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 金額 IN (-1, +1, '-1')")))
    .toBe('金額 in (-1,+1,"-1")');
});

test("SIMPLE REST query は16桁超・指数のraw lexemeを保持する", () => {
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 金額 = 9007199254740993")))
    .toBe("金額 = 9007199254740993");
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 金額 IN (1.20e+21, 9007199254740993)")))
    .toBe("金額 in (1.20e+21,9007199254740993)");
});

test("KLIKE / NOT KLIKE を kintone like / not like へ変換する", () => {
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 件名 KLIKE '至急'")))
    .toBe('件名 like "至急"');
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE NOT (件名 KLIKE '至急')")))
    .toBe('(件名 not like "至急")');
});
