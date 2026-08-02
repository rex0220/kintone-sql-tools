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

test("EXPLAIN の app・JOIN 行は別名を保ち、括弧内 mapped ID を1パスで除く", () => {
  const resolution = createAppResolutionContext(validateKsqlConfig({
    profiles: { prod: { logicalApps: { ORDERS: 1234, CUSTOMERS: 5678 } } },
  }), "prod");
  const result = normalizeSqlAppProfiles(
    "SELECT * FROM LAPP_ORDERS AS o JOIN LAPP_CUSTOMERS AS c ON o.id = c.id",
    "prod",
    resolution
  );
  const [ordersId, customersId] = [...result.appBindingByMappedApp.keys()];
  const restored = restoreSqlDiagnosticValue({
    plan: [
      `  app:           APP${ordersId} AS o (${ordersId})`,
      `  JOIN:          APP${customersId} AS c (${customersId})`,
    ],
  }, result.appBindingByMappedApp);

  expect(restored).toEqual({
    plan: [
      "  app:           LAPP_ORDERS@prod AS o",
      "  JOIN:          LAPP_CUSTOMERS@prod AS c",
    ],
  });
  expect(JSON.stringify(restored)).not.toMatch(/APP9000000\d+/);
});

test("物理 EXPLAIN の profile は二重化せず、別名形の括弧内 ID を除く", () => {
  const resolution = createAppResolutionContext(validateKsqlConfig({
    profiles: { prod: { allowPhysicalAppRefs: true } },
  }), "prod");
  const result = normalizeSqlAppProfiles(
    "SELECT * FROM APP89@prod AS a JOIN APP90@prod AS b ON a.id = b.id",
    "prod",
    resolution
  );
  const restored = restoreSqlDiagnosticValue({
    plan: ["  app:           APP89 (89)", "  JOIN:          APP90 AS b (90)"],
  }, result.appBindingByMappedApp);

  expect(restored).toEqual({
    plan: ["  app:           APP89@prod", "  JOIN:          APP90@prod AS b"],
  });
});

test("library physical 表示も別名を保ち、括弧内 mapped ID を除く", () => {
  const { result } = normalized("SELECT * FROM LAPP_ORDERS@prod AS o");
  const mappedId = [...result.appBindingByMappedApp.keys()][0];
  const restored = restoreSqlDiagnosticValue(
    { plan: [`  app:           APP${mappedId} AS o (${mappedId})`] },
    result.appBindingByMappedApp,
    { logicalAppDisplay: "physical" }
  );

  expect(restored).toEqual({ plan: ["  app:           LAPP_ORDERS -> APP1234 AS o"] });
});
