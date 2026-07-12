import { ParseError } from "../../parser/parser";
import { TokenKind } from "../../lexer/tokens";
import { normalizeSqlAppProfiles } from "../appProfiles";
import { createAppResolutionContext, validateKsqlConfig } from "../config";
import { restoreSqlContextError, restoreSqlDiagnosticValue } from "../sqlDiagnostics";

function normalized(sourceSql: string) {
  const resolution = createAppResolutionContext(validateKsqlConfig({
    profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
  }), "prod");
  const result = normalizeSqlAppProfiles(sourceSql, "prod", resolution);
  return {
    sourceSql,
    result,
    context: {
      bindings: result.appBindingByMappedApp,
      rewriteSegments: result.rewriteSegments,
    },
  };
}

test("元Errorを維持してmapped表記と位置を元SQLへ復元する", () => {
  const sourceSql = "SELECT * FROM LAPP_ORDERS WHERE )";
  const { result, context } = normalized(sourceSql);
  const normalizedPos = result.normalizedSql.indexOf(")");
  const err = new ParseError("式が必要です", {
    kind: TokenKind.RPAREN,
    value: ")",
    pos: normalizedPos,
  });
  const restored = restoreSqlContextError(err, sourceSql, context);

  expect(restored).toBe(err);
  expect(err).toBeInstanceOf(ParseError);
  expect(err.token.pos).toBe(normalizedPos);
  expect(err.message).toContain(`位置 ${sourceSql.indexOf(")")}`);
  expect(err.message).not.toContain("APP900000000");
});

test("mapped table tokenを元のLAPP表記へ復元する", () => {
  const sourceSql = "DESCRIBE LAPP_ORDERS$明細";
  const { result, context } = normalized(sourceSql);
  const err = new ParseError("サブテーブルは指定できません", {
    kind: TokenKind.IDENT,
    value: "APP900000000$明細",
    pos: result.normalizedSql.indexOf("APP900000000"),
  });
  restoreSqlContextError(err, sourceSql, context);

  expect(err.message).toContain("LAPP_ORDERS$明細");
  expect(err.message).not.toContain("900000000");
});

test("EXPLAIN値は再帰的に復元し内部mapped IDを公開しない", () => {
  const { result } = normalized("SELECT * FROM LAPP_ORDERS@prod");
  const restored = restoreSqlDiagnosticValue({
    plan: ["scan APP900000000 (900000000)"],
  }, result.appBindingByMappedApp);

  expect(restored).toEqual({ plan: ["scan LAPP_ORDERS@prod"] });
});

test("DML target 行は論理名と物理ID・profileを併記する（仕様 §9.2）", () => {
  const { result } = normalized("UPDATE LAPP_ORDERS SET 名前='x' WHERE $id=1");
  const restored = restoreSqlDiagnosticValue({
    plan: ["  [UPDATE]", "  target:        APP900000000 (900000000)"],
  }, result.appBindingByMappedApp);

  expect(restored).toEqual({
    plan: ["  [UPDATE]", "  target:        LAPP_ORDERS -> APP1234@prod"],
  });
});

test("物理参照の DML target 行は APP<id>@profile（矢印なし）", () => {
  const resolution = createAppResolutionContext(validateKsqlConfig({
    profiles: { prod: { allowPhysicalAppRefs: true } },
  }), "prod");
  const result = normalizeSqlAppProfiles("UPDATE APP89@prod SET 名前='x' WHERE $id=1", "prod", resolution);
  const restored = restoreSqlDiagnosticValue({
    plan: ["  target:        APP89 (89)"],
  }, result.appBindingByMappedApp);

  expect(restored).toEqual({ plan: ["  target:        APP89@prod"] });
});
