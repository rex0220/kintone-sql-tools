import type { KintoneFieldInfo } from "../../execute";
import { DiagnosticCodes } from "../diagnostics";
import { validateScriptCore } from "../dialect1Validation";
import { parseScript } from "../script";

const header = "-- @ksql dialect: 1\n";

async function validate(
  sql: string,
  fields?: readonly KintoneFieldInfo[],
  strict = false
) {
  const parsed = parseScript(header + sql);
  expect(parsed.diagnostics).toEqual([]);
  return validateScriptCore(
    parsed.statements,
    parsed.meta,
    fields === undefined ? undefined : async () => fields,
    { strict }
  );
}

describe("B168 Stage 5 dialect 1 validation", () => {
  test.each([
    [
      "unique=false",
      { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT", isUnique: false },
      DiagnosticCodes.UPDATE_KEY_NOT_UNIQUE,
      "重複禁止ではありません",
      "値の重複を禁止する",
      "error",
    ],
    [
      "unique unknown",
      { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
      DiagnosticCodes.UPDATE_KEY_NOT_UNIQUE,
      "確認できません",
      "isUnique",
      "warning",
    ],
    [
      "invalid DATE type",
      { code: "key", label: "key", fieldType: "DATE", isUnique: true },
      DiagnosticCodes.UPDATE_KEY_FIELD_TYPE,
      "型 DATE",
      "文字列（1行）または数値",
      "error",
    ],
  ] as const)("updateKey: %s", async (_case, field, code, cause, remedy, severity) => {
    const diagnostics = await validate(
      "UPSERT INTO APP1 (key,value) VALUES ('A','x') KEY (key)",
      [field, { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" }]
    );
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code, severity }),
    ]));
    const message = diagnostics.find((diagnostic) => diagnostic.code === code)!.message;
    expect(message).toContain(cause);
    expect(message).toContain(remedy);
  });

  test("compound key is rejected with the concatenated-field workaround", async () => {
    const diagnostics = await validate(
      "UPSERT INTO APP1 (a,b) VALUES ('A','B') KEY (a,b)"
    );
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: DiagnosticCodes.UPDATE_KEY_COMPOSITE,
    });
    expect(diagnostics[0].message).toContain("連結キーフィールド（例: 顧客コード_年月）");
  });

  test.each(["INSERT INTO APP1$明細 (値) VALUES ('x')", "UPDATE APP1$明細 SET 値='x' WHERE $id=1", "DELETE FROM APP1$明細 WHERE $id=1"])(
    "subtable DML is rejected: %s",
    async (sql) => {
      const diagnostics = await validate(sql);
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: DiagnosticCodes.SUBTABLE_DML_FORBIDDEN,
          message: expect.stringContaining("SELECT は可能です"),
        }),
      ]));
    }
  );

  test("dialect 0 keeps subtable DML outside validation", async () => {
    const parsed = parseScript("INSERT INTO APP1$明細 (値) VALUES ('x')");
    expect(await validateScriptCore(parsed.statements, parsed.meta)).toEqual([]);
  });

  test.each([
    "INSERT INTO APP1 (key) VALUES ('A')",
    "INSERT INTO APP1 (key) SELECT key FROM APP2",
  ])("bare INSERT warns and strict promotes it to error: %s", async (sql) => {
    const warning = await validate(sql);
    expect(warning[0]).toMatchObject({
      severity: "warning",
      code: DiagnosticCodes.BARE_INSERT_NOT_IDEMPOTENT,
      message: expect.stringContaining("冪等性のため UPSERT / MERGE を推奨します"),
    });
    const strict = await validate(sql, undefined, true);
    expect(strict[0]).toMatchObject({ severity: "error", code: warning[0].code });
  });

  test("dialect gate parse errors receive the dedicated diagnostic code", () => {
    const parsed = parseScript("ASSERT WARN 1 = 2, 'warn'");
    expect(parsed.diagnostics[0]).toMatchObject({
      severity: "error",
      code: DiagnosticCodes.DIALECT1_REQUIRED,
      message: expect.stringContaining("-- @ksql dialect: 1"),
    });
  });

  test("bare server-time warning shares the executeBatch wording and code", async () => {
    const diagnostics = await validate("SELECT $id FROM APP1 WHERE 日付 = TODAY()");
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: DiagnosticCodes.SERVER_TIME_FUNCTION_NOT_AS_OF }),
    ]);
    expect(diagnostics[0].message).toContain("as-of の対象外");
  });
});
