import { parseScript } from "../script";
import {
  isNumericVariableDeclaration,
  isNumericVariableText,
  validateDeclaredBatchVariables,
} from "../batchVariables";
import type { Statement } from "../../types/ast";

/**
 * B209（2 回目のレビューの MAJOR 1・2）: 「数値で宣言した変数」の判定を 1 か所に寄せる。
 *
 * 1 回目の実装は `DECLARE` の既定値が**数値リテラルのときだけ**数値と見ていたため、
 * `DECLARE @x = 10 + 5`（算術）や `DECLARE @x = ABS(15)`（数値を返す関数）が文字列扱いになり、
 * 数値のスカラーサブクエリとの大小比較が**混在のエラー**になっていた（過剰停止）。
 *
 * 注入値の検証も `Number()` で見ていたため `"0x10"` や `"Infinity"` を通していた。
 * 通した後の比較は十進として読めず**辞書順の帯**に落ちる（fail-open が戻る）ので、
 * 判定は比較に使う十進のパーサー（`parseExactDecimal`）に合わせる。
 */
const header = "-- @ksql dialect: 1\n";

function declarationOf(sql: string): Statement & { type: "DECLARE_VARIABLE" } {
  const parsed = parseScript(`${header}${sql}`);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const declaration = parsed.statements.find((stmt) => stmt.type === "DECLARE_VARIABLE");
  if (declaration === undefined) throw new Error("DECLARE が見つかりません");
  return declaration as Statement & { type: "DECLARE_VARIABLE" };
}

describe("isNumericVariableDeclaration（宣言の型）", () => {
  test.each([
    ["数値リテラル", "DECLARE @x = 10;", true],
    ["負の数値", "DECLARE @x = -5;", true],
    ["小数", "DECLARE @x = 1.5;", true],
    ["0", "DECLARE @x = 0;", true],
    ["算術式", "DECLARE @x = 10 + 5;", true],
    ["掛け算と括弧", "DECLARE @x = (10 + 5) * 2;", true],
    ["数値を返す関数", "DECLARE @x = ABS(-15);", true],
    ["文字列リテラル", "DECLARE @x = '10';", false],
    ["文字列を返す関数", "DECLARE @x = CONCAT('1', '2');", false],
    ["配列（B203）", "DECLARE @x = [];", false],
  ] as const)("%s → %s", (_label, sql, expected) => {
    expect(isNumericVariableDeclaration(declarationOf(sql))).toBe(expected);
  });

  test("RELATIVE_DATE の宣言は数値ではない", () => {
    // 注釈つきの宣言は相対日付トークンを入れる口なので、数値の検証を当ててはいけない
    const declaration = declarationOf("DECLARE @d RELATIVE_DATE = TODAY();");
    expect(declaration.annotation).toBe("RELATIVE_DATE");
    expect(isNumericVariableDeclaration(declaration)).toBe(false);
  });
});

describe("isNumericVariableText（注入値の境界）", () => {
  test.each([
    ["10", true],
    ["-5", true],
    ["0", true],
    ["1.5", true],
    [".5", true],
    ["1e3", true],        // 比較の十進パーサーが指数を読むので同じく通す
    ["  10  ", true],     // 前後の空白は比較側も trim する
    ["+10", true],
    ["0x10", false],      // Number() は 16 と読むが比較は十進として読めない
    ["0b1", false],
    ["0o7", false],
    ["Infinity", false],
    ["-Infinity", false],
    ["NaN", false],
    ["1_000", false],
    ["", false],
    ["   ", false],
    ["+", false],
    ["-", false],
    ["1,000", false],
    ["１０", false],      // 全角
    ["12abc", false],
  ] as const)("\"%s\" → %s", (value, expected) => {
    expect(isNumericVariableText(value)).toBe(expected);
  });

  test("文字列以外は数値として扱わない", () => {
    expect(isNumericVariableText(10)).toBe(false);
    expect(isNumericVariableText(undefined)).toBe(false);
    expect(isNumericVariableText(["1"])).toBe(false);
  });
});

describe("validateDeclaredBatchVariables（宣言の型で注入を弾く）", () => {
  const statements = (sql: string) => {
    const parsed = parseScript(`${header}${sql}`);
    return parsed.statements;
  };

  test("算術式で宣言した変数にも数値の検証が効く", () => {
    const stmts = statements("DECLARE @limit = 10 + 5;\nSELECT $id FROM APP200;");
    expect(() => validateDeclaredBatchVariables(stmts, { limit: "0x10" }))
      .toThrow(/declared as a number/);
    expect(validateDeclaredBatchVariables(stmts, { limit: "1e3" })).toEqual({ limit: "1e3" });
  });

  test("文字列で宣言した変数には何でも入れられる（今までどおり）", () => {
    const stmts = statements("DECLARE @name = '';\nSELECT $id FROM APP200;");
    expect(validateDeclaredBatchVariables(stmts, { name: "0x10" })).toEqual({ name: "0x10" });
  });
});
