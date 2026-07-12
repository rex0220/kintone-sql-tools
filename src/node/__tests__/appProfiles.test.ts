import { normalizeSqlAppProfiles, type SqlRewriteSegment } from "../appProfiles";
import { createAppResolutionContext, validateKsqlConfig } from "../config";

function context() {
  return createAppResolutionContext(validateKsqlConfig({
    profiles: {
      dev: { logicalApps: { ORDERS: 899, CUSTOMERS: 800 } },
      prod: { logicalApps: { ORDERS: 1234, CUSTOMERS: 1235 } },
    },
  }), "dev");
}

function expectContiguousSegments(segments: SqlRewriteSegment[], normalizedLength: number, sourceLength: number) {
  expect(segments[0]?.normalizedStart ?? 0).toBe(0);
  expect(segments[0]?.sourceStart ?? 0).toBe(0);
  for (let i = 1; i < segments.length; i++) {
    expect(segments[i].normalizedStart).toBe(segments[i - 1].normalizedEnd);
    expect(segments[i].sourceStart).toBe(segments[i - 1].sourceEnd);
  }
  expect(segments[segments.length - 1]?.normalizedEnd ?? 0).toBe(normalizedLength);
  expect(segments[segments.length - 1]?.sourceEnd ?? 0).toBe(sourceLength);
}

describe("normalizeSqlAppProfiles: logical app scanner/rewrite", () => {
  test("LAPP を mapped APP へ rewrite し logical binding を生成する", () => {
    const sql = "SELECT * FROM LAPP_ORDERS@prod";
    const result = normalizeSqlAppProfiles(sql, "dev", context());
    const [binding] = [...result.appBindingByMappedApp.values()];

    expect(result.normalizedSql).toBe(`SELECT * FROM APP${binding.mappedAppId}`);
    expect(result.hasProfileSyntax).toBe(true);
    expect(binding).toEqual({
      source: "logical",
      logicalName: "ORDERS",
      mappedAppId: binding.mappedAppId,
      appId: 1234,
      profile: "prod",
    });
    expect(binding.mappedAppId).toBeGreaterThanOrEqual(900_000_000);
  });

  test("LAPP の大小文字を同じ論理名として解決し同じ mapped ID を使う", () => {
    const result = normalizeSqlAppProfiles(
      "SELECT * FROM lapp_orders a JOIN LAPP_Orders b ON 1=1 JOIN LAPP_ORDERS c ON 1=1",
      "dev",
      context()
    );
    expect(result.appBindingByMappedApp.size).toBe(1);
    expect(result.normalizedSql.match(/APP900000000/g)).toHaveLength(3);
  });

  test("同じ論理名を profile ごとに別 binding へ割り当てる", () => {
    const result = normalizeSqlAppProfiles(
      "SELECT * FROM LAPP_ORDERS@dev d JOIN LAPP_ORDERS@prod p ON 1=1",
      "dev",
      context()
    );
    const bindings = [...result.appBindingByMappedApp.values()];
    expect(bindings).toHaveLength(2);
    expect(bindings.map((b) => b.appId).sort((a, b) => a - b)).toEqual([899, 1234]);
  });

  test("subtable を維持して LAPP_ORDERS$明細@prod を rewrite する", () => {
    const result = normalizeSqlAppProfiles(
      "SELECT * FROM LAPP_ORDERS$明細@prod",
      "dev",
      context()
    );
    expect(result.normalizedSql).toBe("SELECT * FROM APP900000000$明細");
  });

  test("文字列・backtick・コメント内の LAPP_ を無視する", () => {
    const sql = [
      "SELECT 'LAPP_ORDERS@prod', `LAPP_CUSTOMERS`",
      "FROM LAPP_ORDERS",
      "-- LAPP_ORDERS@prod",
      "/* LAPP_CUSTOMERS@prod */",
    ].join("\n");
    const result = normalizeSqlAppProfiles(sql, "dev", context());
    expect(result.appBindingByMappedApp.size).toBe(1);
    expect(result.normalizedSql).toContain("'LAPP_ORDERS@prod'");
    expect(result.normalizedSql).toContain("`LAPP_CUSTOMERS`");
    expect(result.normalizedSql).toContain("-- LAPP_ORDERS@prod");
    expect(result.normalizedSql).toContain("/* LAPP_CUSTOMERS@prod */");
  });

  test("resolver が無い LAPP を fallback せず拒否する", () => {
    expect(() => normalizeSqlAppProfiles("SELECT * FROM LAPP_ORDERS", "dev"))
      .toThrow(/requires logicalApps configuration/);
  });

  test("未定義論理名を resolver 経由で拒否する", () => {
    expect(() => normalizeSqlAppProfiles("SELECT * FROM LAPP_UNKNOWN", "dev", context()))
      .toThrow(/LAPP_UNKNOWN@dev is not defined/);
  });

  test("物理参照と論理参照は同じ実体でも別 binding にする", () => {
    const result = normalizeSqlAppProfiles(
      "SELECT * FROM APP1234@prod p JOIN LAPP_ORDERS@prod l ON 1=1",
      "dev",
      context()
    );
    const bindings = [...result.appBindingByMappedApp.values()];
    expect(bindings).toHaveLength(2);
    expect(bindings).toContainEqual({
      source: "physical",
      mappedAppId: 1234,
      appId: 1234,
      profile: "prod",
    });
    expect(bindings.some((b) => b.source === "logical" && b.appId === 1234 && b.mappedAppId !== 1234)).toBe(true);
  });

  test("既存 profile 仮想 ID と logical mapped ID は共有 allocator で衝突しない", () => {
    const result = normalizeSqlAppProfiles(
      "SELECT * FROM APP88@dev a JOIN APP88@prod b ON 1=1 JOIN LAPP_ORDERS@prod c ON 1=1",
      "dev",
      context()
    );
    const mappedIds = [...result.appBindingByMappedApp.keys()];
    expect(new Set(mappedIds).size).toBe(mappedIds.length);
    expect(mappedIds).toEqual([900_000_000, 900_000_001, 900_000_002]);
  });

  test("論理解決先の物理 ID と mapped ID を衝突させない", () => {
    const highIdContext = createAppResolutionContext(validateKsqlConfig({
      profiles: { dev: { logicalApps: { ORDERS: 900_000_000 } } },
    }), "dev");
    const result = normalizeSqlAppProfiles("SELECT * FROM LAPP_ORDERS", "dev", highIdContext);
    const [binding] = [...result.appBindingByMappedApp.values()];
    expect(binding.appId).toBe(900_000_000);
    expect(binding.mappedAppId).toBe(900_000_001);
  });

  test("既存 APP@profile の意味と表記を維持する", () => {
    const result = normalizeSqlAppProfiles("SELECT * FROM app899$明細@prod", "dev", context());
    expect(result.normalizedSql).toBe("SELECT * FROM app899$明細");
    expect([...result.appBindingByMappedApp.values()]).toEqual([{
      source: "physical",
      mappedAppId: 899,
      appId: 899,
      profile: "prod",
    }]);
  });

  test("rewrite segment が source と normalized SQL 全体を連続して覆う", () => {
    const sql = "SELECT * FROM LAPP_ORDERS$明細@prod WHERE x = 'LAPP_X'";
    const result = normalizeSqlAppProfiles(sql, "dev", context());
    expectContiguousSegments(result.rewriteSegments, result.normalizedSql.length, sql.length);
    const rewritten = result.rewriteSegments.find((segment) => segment.bindingMappedAppId !== undefined);
    expect(rewritten).toMatchObject({
      sourceStart: sql.indexOf("LAPP_ORDERS"),
      sourceEnd: sql.indexOf(" WHERE"),
      bindingMappedAppId: 900_000_000,
    });
    expect(result.normalizedSql.slice(rewritten!.normalizedStart, rewritten!.normalizedEnd))
      .toBe("APP900000000$明細");
  });
});
