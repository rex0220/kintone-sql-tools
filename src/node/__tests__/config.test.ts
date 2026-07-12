import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createAppResolutionContext,
  loadKsqlConfig,
  validateKsqlConfig,
  type KsqlConfig,
} from "../config";

describe("logical app config", () => {
  test("logicalApps を受理し、ASCII 大文字キーへ正規化する", () => {
    const config: KsqlConfig = {
      profiles: {
        prod: {
          logicalApps: { orders: 1234, Customer_2: 1235 },
          allowPhysicalAppRefs: false,
        },
      },
    };

    expect(validateKsqlConfig(config).profiles?.prod.logicalApps).toEqual({
      ORDERS: 1234,
      CUSTOMER_2: 1235,
    });
  });

  test.each(["APP899", "899", "LAPP_ORDERS"])("禁止キー %s を拒否する", (name) => {
    expect(() => validateKsqlConfig({
      profiles: { prod: { logicalApps: { [name]: 1234 } } },
    })).toThrow(/logical app key/);
  });

  test.each(["_ORDERS", "ORDER-NOW", "注文", `A${"B".repeat(64)}`])(
    "不正な論理名 %s を拒否する",
    (name) => {
      expect(() => validateKsqlConfig({
        profiles: { prod: { logicalApps: { [name]: 1234 } } },
      })).toThrow(/must match/);
    }
  );

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1234", null])(
    "不正な物理 ID %p を拒否する",
    (appId) => {
      expect(() => validateKsqlConfig({
        profiles: { prod: { logicalApps: { ORDERS: appId as number } } },
      })).toThrow(/positive safe integer/);
    }
  );

  test("大文字正規化後の同名重複を拒否する", () => {
    expect(() => validateKsqlConfig({
      profiles: { prod: { logicalApps: { orders: 1234, ORDERS: 1235 } } },
    })).toThrow(/duplicated after case normalization/);
  });

  test("同一 profile 内の物理 ID alias を明示メッセージで拒否する", () => {
    expect(() => validateKsqlConfig({
      profiles: { prod: { logicalApps: { ORDERS: 1234, SALES: 1234 } } },
    })).toThrow(/physical app aliases are not supported yet/);
  });

  test("allowPhysicalAppRefs は boolean 以外を拒否する", () => {
    expect(() => validateKsqlConfig({
      profiles: { prod: { allowPhysicalAppRefs: "false" as unknown as boolean } },
    })).toThrow(/must be boolean/);
  });

  test("読込時に検証と正規化を行う", () => {
    const dir = mkdtempSync(join(tmpdir(), "ksql-logical-config-"));
    const path = join(dir, "ksql.config.json");
    try {
      writeFileSync(path, JSON.stringify({ profiles: { prod: { logicalApps: { orders: 1234 } } } }));
      expect(loadKsqlConfig(path).profiles?.prod.logicalApps).toEqual({ ORDERS: 1234 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AppResolutionContext", () => {
  const config = validateKsqlConfig({
    profiles: {
      prod: { logicalApps: { orders: 1234 }, allowPhysicalAppRefs: false },
      dev: { logicalApps: { ORDERS: 899 } },
    },
  });
  const context = createAppResolutionContext(config, "dev");

  test("論理名と profile を大文字非依存で解決する", () => {
    expect(context.resolveLogicalApp("orders", "prod")).toBe(1234);
    expect(context.resolveLogicalApp("ORDERS", "dev")).toBe(899);
  });

  test("空 profile は factory の defaultProfile を使う", () => {
    expect(context.resolveLogicalApp("orders", "")).toBe(899);
  });

  test("未定義論理名と未知 profile は fallback せず拒否する", () => {
    expect(() => context.resolveLogicalApp("MISSING", "prod")).toThrow(/is not defined/);
    expect(() => context.resolveLogicalApp("ORDERS", "missing")).toThrow(/profile "missing" is not defined/);
  });

  test("allowPhysicalAppRefs:false の profile を拒否する", () => {
    expect(() => context.assertPhysicalAppAllowed("prod")).toThrow(/physical app references are not allowed/);
    expect(() => context.assertPhysicalAppAllowed("dev")).not.toThrow();
  });

  test("config 未設定の既定 profile は物理参照を従来どおり許可する", () => {
    const emptyContext = createAppResolutionContext({}, "dev");
    expect(() => emptyContext.assertPhysicalAppAllowed("dev")).not.toThrow();
    expect(() => emptyContext.assertPhysicalAppAllowed("other")).not.toThrow();
  });

  test("factory 作成後の config 変更で解決結果が変わらない", () => {
    const mutableConfig = validateKsqlConfig({
      profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
    });
    const snapshotContext = createAppResolutionContext(mutableConfig, "prod");
    mutableConfig.profiles!.prod.logicalApps!.ORDERS = 9999;
    expect(snapshotContext.resolveLogicalApp("ORDERS", "prod")).toBe(1234);
  });
});
