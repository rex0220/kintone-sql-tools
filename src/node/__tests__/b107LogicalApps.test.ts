import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveSqlContext } from "../runtime";

test("B107: CLI/MCP shared runtime resolves a Japanese logical app from config", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-b107-runtime-"));
  const configPath = join(dir, "ksql.config.json");
  try {
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "prod",
      profiles: {
        prod: { logicalApps: { 案件管理: 4149 } },
      },
    }));
    const context = resolveSqlContext(
      { configPath },
      "SELECT * FROM LAPP_案件管理",
      "prod"
    );
    expect([...context.bindings.values()]).toMatchObject([
      {
        source: "logical",
        logicalName: "案件管理",
        appId: 4149,
        profile: "prod",
      },
    ]);
    expect(context.normalizedSql).toMatch(/^SELECT \* FROM APP\d+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
