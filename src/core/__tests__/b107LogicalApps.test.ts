import {
  LOGICAL_APP_NAME_RE,
  canonicalizeLogicalAppName,
  collectAppProfileTokens,
  isLogicalAppNameContinue,
  isLogicalAppNameStart,
  normalizeSqlAppProfiles,
} from "../logicalApps";

describe("B107 logical app name rules", () => {
  test.each([
    "A",
    "orders_2",
    "注文",
    "案件＄明細",
    "案件＠本番",
    "案件・管理",
    "案件ー管理",
    `A${"B".repeat(63)}`,
  ])("shared RegExp and canonicalizer accept %s", (name) => {
    const canonical = canonicalizeLogicalAppName(name);
    expect(LOGICAL_APP_NAME_RE.test(canonical)).toBe(true);
    expect(isLogicalAppNameStart(canonical[0])).toBe(true);
    expect([...canonical.slice(1)].every(isLogicalAppNameContinue)).toBe(true);
  });

  test.each([
    "_ORDERS",
    "ORDER-NOW",
    "1ORDER",
    "案件$明細",
    "案件@本番",
    `A${"B".repeat(64)}`,
  ])("shared RegExp and canonicalizer reject %s", (name) => {
    expect(LOGICAL_APP_NAME_RE.test(name)).toBe(false);
    expect(() => canonicalizeLogicalAppName(name)).toThrow(name);
  });

  test.each(["\u3040", "\u30ff", "\u3400", "\u9fff", "\uf900", "\ufaff", "\uff01", "\uff60"])(
    "accepts each Japanese range boundary U+%s",
    (name) => {
      expect(isLogicalAppNameStart(name)).toBe(true);
      expect(LOGICAL_APP_NAME_RE.test(name)).toBe(true);
    }
  );

  test.each(["\u303f", "\u3100", "\u33ff", "\ua000", "\uf8ff", "\ufb00", "\uff00", "\uff61"])(
    "rejects adjacent out-of-range character U+%s",
    (name) => {
      expect(isLogicalAppNameStart(name)).toBe(false);
      expect(LOGICAL_APP_NAME_RE.test(name)).toBe(false);
    }
  );

  test("canonicalization is NFC first and then toUpperCase", () => {
    expect(canonicalizeLogicalAppName("か\u3099くせいａ")).toBe("がくせいＡ");
    expect(canonicalizeLogicalAppName("かな漢字")).not.toBe(
      canonicalizeLogicalAppName("カナ漢字")
    );
  });

  test("scanner handles Japanese FROM/JOIN, suffixes, and fullwidth dollar as a name character", () => {
    const sql = "SELECT * FROM LAPP_案件＄明細 a JOIN LAPP_顧客$連絡先@prod b ON 1=1";
    const tokens = collectAppProfileTokens(sql);
    expect(tokens).toMatchObject([
      { source: "logical", logicalName: "案件＄明細", profile: null },
      { source: "logical", logicalName: "顧客", profile: "prod" },
    ]);
    expect(sql.slice(tokens[1].referenceValueEnd, tokens[1].appEnd)).toBe("$連絡先");
  });

  test("scanner NFC-normalizes SQL names and skips strings, comments, and backticks", () => {
    const sql = [
      "SELECT 'LAPP_注文', `LAPP_注文`",
      "FROM LAPP_か\u3099くせい",
      "-- LAPP_注文",
      "/* LAPP_顧客 */",
    ].join("\n");
    const tokens = collectAppProfileTokens(sql);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ source: "logical", logicalName: "がくせい" });
  });

  test("over-limit and invalid-start references remain non-tokens", () => {
    expect(collectAppProfileTokens(`SELECT * FROM LAPP_A${"B".repeat(64)}`)).toEqual([]);
    expect(collectAppProfileTokens("SELECT * FROM LAPP__ORDERS")).toEqual([]);
  });

  test("NFD SQL names resolve against NFC canonical config names", () => {
    const result = normalizeSqlAppProfiles("SELECT * FROM LAPP_か\u3099くせい", "dev", {
      resolveLogicalApp(name) {
        expect(name).toBe("がくせい");
        return 4221;
      },
    });
    expect(result.normalizedSql).toMatch(/^SELECT \* FROM APP\d+$/);
    expect([...result.appBindingByMappedApp.values()]).toMatchObject([
      { source: "logical", logicalName: "がくせい", appId: 4221 },
    ]);
  });
});
