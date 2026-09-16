import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UNRESOLVED_AGGREGATE_COMPARISON_WARNING } from "../../engine/process";

jest.setTimeout(30_000);

const RANGE_WARNING_PREFIX =
  "累計 は既定フレーム（RANGE）で評価されます。ORDER BY の値が同じ行はすべて同じ値になります。";
const RANGE_SQL = "SELECT 売上, SUM(売上) OVER (ORDER BY 売上) AS 累計 FROM APP100";
const BASE_ARGS = ["--auth", "token", "--token", "unused", "--app", "100"];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let server: Server;
let baseUrl = "";
let dir = "";
let bootstrapPath = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("/app/form/fields.json")) {
      res.end(JSON.stringify({
        properties: {
          区分: { code: "区分", label: "区分", type: "SINGLE_LINE_TEXT" },
          売上: { code: "売上", label: "売上", type: "NUMBER" },
        },
      }));
      return;
    }
    if (req.url?.includes("/app/status.json")) {
      res.end(JSON.stringify({ enable: false, states: {} }));
      return;
    }
    if (req.url?.includes("/app/settings.json")) {
      res.end(JSON.stringify({
        numberPrecision: { digits: "30", decimalPlaces: "10", roundingMode: "HALF_EVEN" },
      }));
      return;
    }
    if (req.url?.includes("/records.json") && req.method === "GET") {
      res.end(JSON.stringify({
        records: [
          { $id: { value: "1" }, 区分: { value: "A" }, 売上: { value: "100" } },
          { $id: { value: "2" }, 区分: { value: "A" }, 売上: { value: "200" } },
        ],
      }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ code: "UNEXPECTED_API", message: `${req.method} ${req.url}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server did not expose a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  dir = await mkdtemp(join(tmpdir(), "ksql-b189-cli-"));
  bootstrapPath = join(dir, "run-cli.cjs");
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
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runCli(args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [bootstrapPath, "--base-url", baseUrl, ...BASE_ARGS, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, KSQL_USERNAME: "", KSQL_PASSWORD: "" },
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
  return { code, stdout, stderr };
}

function warningLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((line) => line.startsWith("warning="));
}

test.each(["table", "csv", "markdown"] as const)(
  "%s: RANGE 警告を stderr に1行出し stdout を固定する",
  async (format) => {
    const result = await runCli(["--format", format, "-e", RANGE_SQL]);
    expect(result.code).toBe(0);
    expect(warningLines(result.stderr)).toHaveLength(1);
    expect(warningLines(result.stderr)[0]).toContain(`warning=${RANGE_WARNING_PREFIX}`);
    if (format === "csv") expect(result.stdout).toMatchSnapshot("csv stdout unchanged");
    if (format === "markdown") expect(result.stdout).toMatchSnapshot("markdown stdout unchanged");
    if (format === "table") {
      expect(result.stdout).toMatchSnapshot("table stdout unchanged");
      expect(result.stdout).toContain("売上");
      expect(result.stdout).toContain("累計");
      expect(result.stdout).not.toContain("warning=");
    }
  }
);

test("HAVING の未掲載集計も既存の警告文を stderr に出す", async () => {
  const result = await runCli([
    "--format", "table",
    "-e", "SELECT 区分, COUNT(*) AS 件数 FROM APP100 GROUP BY 区分 HAVING SUM(売上) > 0",
  ]);
  expect(result.code).toBe(0);
  expect(warningLines(result.stderr)).toEqual([`warning=${UNRESOLVED_AGGREGATE_COMPARISON_WARNING}`]);
});

test("json は stderr に警告を複製せず warnings 配列を維持する", async () => {
  const result = await runCli(["--format", "json", "-e", RANGE_SQL]);
  expect(result.code).toBe(0);
  expect(warningLines(result.stderr)).toEqual([]);
  const payload = JSON.parse(result.stdout) as { warnings: string[] };
  expect(payload.warnings).toHaveLength(1);
  expect(payload.warnings[0]).toContain(RANGE_WARNING_PREFIX);
});

test("--quiet は単文 SELECT の警告を抑止する", async () => {
  const result = await runCli(["--quiet", "--format", "table", "-e", RANGE_SQL]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
});

test("警告の無い単文 SELECT は stderr を増やさない", async () => {
  const result = await runCli(["--format", "table", "-e", "SELECT 売上 FROM APP100"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("rowCount=2\n");
});

test("--export-csv でも警告を stderr に出し、CSV ファイルへ混ぜない", async () => {
  const target = join(dir, "export.csv");
  const result = await runCli(["--format", "table", "--export-csv", target, "-e", RANGE_SQL]);
  expect(result.code).toBe(0);
  expect(warningLines(result.stderr)).toHaveLength(1);
  expect(result.stderr).toContain("export: (select) ->");
  expect(await readFile(target, "utf8")).toBe("売上,累計\r\n100,100\r\n200,300\r\n");
});

test("--output は結果だけをファイルへ書き、警告を stderr に保つ", async () => {
  const target = join(dir, "output.csv");
  const result = await runCli(["--format", "csv", "--output", target, "-e", RANGE_SQL]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(warningLines(result.stderr)).toHaveLength(1);
  expect(await readFile(target, "utf8")).toMatchSnapshot("--output csv unchanged");
});

test("jsonl は行ストリームを stdout に保ち、警告だけを stderr に出す", async () => {
  const result = await runCli(["--format", "jsonl", "-e", RANGE_SQL]);
  expect(result.code).toBe(0);
  expect(warningLines(result.stderr)).toHaveLength(1);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  expect(result.stdout).not.toContain("warning=");
});
