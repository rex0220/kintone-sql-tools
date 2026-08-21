import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runWithArgv } from "../index";

const dir = mkdtempSync(join(tmpdir(), "ksql-b170-cli-"));
const config = join(dir, "ksql.config.json");

beforeAll(() => writeFileSync(config, JSON.stringify({
  defaultProfile: "test",
  profiles: { test: { baseUrl: "https://example.invalid", tokenMap: { "1": "unused" } } },
})));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("E-6 CLI batch dry-run reaches shared default as-of injection", async () => {
  let stdout = "";
  let stderr = "";
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
  try {
    const code = await runWithArgv([
      "--config", config,
      "--dry-run",
      "-e", "-- @ksql dialect: 1\nSELECT @NOW() AS n; SELECT @MONTH_START() AS m;",
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("[1] SELECT");
    expect(stdout).toContain("[2] SELECT");
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});
