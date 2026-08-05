import { parseSqlStatement } from "../../sql";
import { resolveFieldSemantics } from "../../fieldSemantics";
import { normalizeChoiceEquality } from "../whereCapability";
import type { SelectStatement } from "../../../types/ast";

function normalize(sql: string, fields: Record<string, {
  fieldType: string;
  optionOrder?: Readonly<Record<string, number>>;
}>) {
  const where = (parseSqlStatement(sql) as SelectStatement).where!;
  return normalizeChoiceEquality(where, (field) => {
    const source = fields[field.field];
    return source ? resolveFieldSemantics(source) : undefined;
  });
}

describe("B126 choice equality normalization", () => {
  test.each([
    ["=", "IN"],
    ["!=", "NOT_IN"],
    ["<>", "NOT_IN"],
  ] as const)("実在する非空の単一選択肢 %s を %s の singleton AST にする", (operator, expected) => {
    const result = normalize(
      `SELECT choice FROM APP1 WHERE choice ${operator} 'A'`,
      { choice: { fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } } }
    );
    expect(result.normalizedWhere).toMatchObject({
      type: "BINARY",
      op: expected,
      right: { type: "IN_LIST", values: [{ type: "STRING", value: "A" }] },
    });
    expect(result.rewrites).toHaveLength(1);
  });

  test.each([
    ["存在しない値", { A: 0 }],
    ["", { "": 0, A: 1 }],
  ] as const)("値 %p は正規化しない", (value, optionOrder) => {
    const result = normalize(
      `SELECT choice FROM APP1 WHERE choice = '${value}'`,
      { choice: { fieldType: "DROP_DOWN", optionOrder } }
    );
    expect(result.normalizedWhere).toMatchObject({ op: "=", right: { type: "STRING", value } });
    expect(result.rewrites).toEqual([]);
  });

  test("optionOrder 不明・複数値型・通常文字列は正規化しない", () => {
    for (const source of [
      { fieldType: "DROP_DOWN" },
      { fieldType: "USER_SELECT", optionOrder: { A: 0 } },
      { fieldType: "SINGLE_LINE_TEXT", optionOrder: { A: 0 } },
    ]) {
      expect(normalize("SELECT choice FROM APP1 WHERE choice = 'A'", { choice: source }).rewrites)
        .toEqual([]);
    }
  });

  test("AND の各 leaf を独立に判定する", () => {
    const result = normalize(
      "SELECT choice FROM APP1 WHERE choice = 'A' AND text > 'x'",
      {
        choice: { fieldType: "DROP_DOWN", optionOrder: { A: 0 } },
        text: { fieldType: "SINGLE_LINE_TEXT" },
      }
    );
    expect(result.normalizedWhere).toMatchObject({
      type: "LOGICAL",
      left: { type: "BINARY", op: "IN" },
      right: { type: "BINARY", op: ">" },
    });
    expect(result.rewrites).toHaveLength(1);
  });
});
