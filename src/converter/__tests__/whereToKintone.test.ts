import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { SelectStatement, WhereExpr } from "../../types/ast";
import { KintoneQueryError, whereToKintone } from "../whereToKintone";

test("resolved-only BOOLEAN は kintone query へ漏らさない", () => {
  const constant: WhereExpr = { type: "BOOLEAN", value: false };
  expect(() => whereToKintone(constant)).toThrow(/BOOLEAN predicate/);
});

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
  // +1 は kintone が受理しない先頭符号のため平文 1 へ正規化する（-1 は保持）。
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 金額 IN (-1, +1, '-1')")))
    .toBe('金額 in (-1,1,"-1")');
});

test("LOGINUSER() singleton は IN / NOT IN の REST query byte を維持する", () => {
  expect(whereToKintone(where(
    "SELECT * FROM APP100 WHERE 作成者 IN (LOGINUSER())"
  ))).toBe("作成者 in (LOGINUSER())");
  expect(whereToKintone(where(
    "SELECT * FROM APP100 WHERE 更新者 NOT IN (LOGINUSER())"
  ))).toBe("更新者 not in (LOGINUSER())");
});

test("PRIMARY_ORGANIZATION() singleton は IN / NOT IN をそのまま出力する", () => {
  expect(whereToKintone(where(
    "SELECT * FROM APP100 WHERE 担当組織 IN (PRIMARY_ORGANIZATION())"
  ))).toBe("担当組織 in (PRIMARY_ORGANIZATION())");
  expect(whereToKintone(where(
    "SELECT * FROM APP100 WHERE 担当組織 NOT IN (PRIMARY_ORGANIZATION())"
  ))).toBe("担当組織 not in (PRIMARY_ORGANIZATION())");
});

test("SIMPLE REST query は16桁超の精度を保ちつつ平文10進で押し下げる", () => {
  // 16桁超はbinary64で丸めずそのまま保持する。
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 金額 = 9007199254740993")))
    .toBe("金額 = 9007199254740993");
  // 指数表記は kintone が受理しないため平文10進へ展開する（値は不変・全桁保持）。
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 金額 = 1e3")))
    .toBe("金額 = 1000");
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 金額 IN (1.20e+21, 9007199254740993)")))
    .toBe("金額 in (1200000000000000000000,9007199254740993)");
});

test("KLIKE / NOT KLIKE を kintone like / not like へ変換する", () => {
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE 件名 KLIKE '至急'")))
    .toBe('件名 like "至急"');
  expect(whereToKintone(where("SELECT * FROM APP100 WHERE NOT (件名 KLIKE '至急')")))
    .toBe('(件名 not like "至急")');
});
