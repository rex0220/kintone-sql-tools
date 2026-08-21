import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

jest.setTimeout(30_000);

test("B168 Stage 4a: -f dialect 1 script runs in a real CLI process", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-b168-cli-"));
  const bootstrapPath = join(dir, "run-cli.cjs");
  const sqlPath = join(dir, "flow.ksql");
  const sql = `-- @ksql dialect: 1
CREATE TEMP TABLE flow_rows AS
WITH series AS (GENERATE_SERIES(1, 3) AS n)
SELECT n FROM series;
ASSERT (SELECT COUNT(*) FROM flow_rows) = 3, 'row count';
ASSERT WARN 1 = 2, 'expected warning';
EXIT SUCCESS IF (SELECT COUNT(*) FROM flow_rows) = 3, 'completed';
SELECT n FROM flow_rows;`;

  try {
    // Source-under-test を子 process 内で CommonJS 変換し、成果物の有無や鮮度に依存せず実 CLI を通す。
    const cliEntry = join(process.cwd(), "src", "cli", "index.ts");
    await writeFile(bootstrapPath, `
const fs = require("node:fs");
const ts = require(${JSON.stringify(require.resolve("typescript"))});
require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const entry = ${JSON.stringify(cliEntry)};
process.argv[1] = entry;
require(entry);
`, "utf8");
    await writeFile(sqlPath, sql, "utf8");

    const env = { ...process.env };
    delete env.KSQL_USERNAME;
    delete env.KSQL_PASSWORD;
    const child = spawn(process.execPath, [
      bootstrapPath,
      "-f", sqlPath,
      "--format", "json",
      "--base-url", "http://127.0.0.1",
      "--app", "1",
      "--token", "unused",
    ], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (value) => resolve(value ?? 1));
    });

    if (code !== 0) {
      throw new Error(`CLI failed: code=${code} stdout=${stdout} stderr=${stderr}\nsql=${await readFile(sqlPath, "utf8")}`);
    }
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      statements: Array<Record<string, unknown>>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.statements[2]).toMatchObject({
      type: "ASSERT", status: "success", passed: false, warning: "expected warning",
    });
    expect(payload.statements[3]).toMatchObject({
      type: "EXIT", status: "success", exited: true, message: "completed",
    });
    expect(payload.statements[4]).toMatchObject({
      type: "SELECT", status: "skipped", skippedReason: "exit",
    });
    expect(stderr).toContain("[3] ASSERT success");
    expect(stderr).toContain("[5] SELECT skipped reason=exit");

    const consoleChild = spawn(process.execPath, [
      bootstrapPath,
      "--console",
      "--format", "json",
      "--base-url", "http://127.0.0.1",
      "--app", "1",
      "--token", "unused",
    ], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let consoleStdout = "";
    let consoleStderr = "";
    let markConsoleReady: (() => void) | null = null;
    let markConsoleExecuted: (() => void) | null = null;
    const consoleReady = new Promise<void>((resolve) => { markConsoleReady = resolve; });
    const consoleExecuted = new Promise<void>((resolve) => { markConsoleExecuted = resolve; });
    consoleChild.stdout.on("data", (chunk) => {
      consoleStdout += chunk.toString();
      if (consoleStdout.includes("ksql> ")) markConsoleReady?.();
      if (consoleStdout.includes('"warning":"expected warning"')) markConsoleExecuted?.();
    });
    consoleChild.stderr.on("data", (chunk) => { consoleStderr += chunk.toString(); });
    await consoleReady;
    const [headerLine, ...bodyLines] = sql.split("\n");
    consoleChild.stdin.write(`${headerLine}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    consoleChild.stdin.write(`${bodyLines.join(" ")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    consoleChild.stdin.write(":run\n");
    await Promise.race([
      consoleExecuted,
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    consoleChild.stdin.end(":exit\n");
    const consoleCode = await new Promise<number>((resolve, reject) => {
      consoleChild.on("error", reject);
      consoleChild.on("close", (value) => resolve(value ?? 1));
    });

    if (!consoleStdout.includes('"ok":true')) {
      throw new Error(`Console CLI did not execute: stdout=${consoleStdout} stderr=${consoleStderr}`);
    }
    expect(consoleCode).toBe(0);
    expect(consoleStdout).toContain("kSQL Console");
    expect(consoleStdout).toContain('"ok":true');
    expect(consoleStdout).toContain('"warning":"expected warning"');
    expect(consoleStderr).toContain("[5] SELECT skipped reason=exit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
