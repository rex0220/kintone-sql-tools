import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DEFAULT_FIELDS = [
  { code: "code", label: "code", fieldType: "SINGLE_LINE_TEXT" },
  { code: "tags", label: "tags", fieldType: "CHECK_BOX" },
  { code: "Lines", label: "Lines", fieldType: "SUBTABLE" },
];
const getRecords = jest.fn(async () => ({ records: [] as unknown[] }));
const getFields = jest.fn(async () => DEFAULT_FIELDS);
const postRecords = jest.fn(async (params: { records: unknown[] }) => ({ ids: params.records.map((_r, i) => String(i + 1)) }));

jest.mock("../nodeKintoneClient", () => ({
  createNodeKintoneClient: () => ({
    getRecords,
    openCursor: jest.fn(async () => { throw new Error("unexpected cursor"); }),
    postRecords,
    putRecords: jest.fn(async () => undefined),
    deleteRecords: jest.fn(async () => undefined),
    getApps: jest.fn(async () => []),
    getFields,
    getProcessStatuses: jest.fn(async () => ({ enable: false, states: [] })),
    getNumberPrecision: jest.fn(async () => ({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" })),
  }),
}));

import { runWithArgv } from "../index";

const BASE = ["--base-url", "https://example.cybozu.com", "--auth", "token", "--token", "dummy", "--app", "100", "--format", "json"];

let dir = "";
let stdout: jest.SpyInstance;
let stderr: jest.SpyInstance;
const out = () => stdout.mock.calls.flat().join("");
const err = () => stderr.mock.calls.flat().join("");
const tmpFiles = () => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ksql-export-e2e-"));
  stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  getRecords.mockReset();
  getRecords.mockResolvedValue({ records: [] });
  getFields.mockReset();
  getFields.mockResolvedValue(DEFAULT_FIELDS);
  postRecords.mockClear();
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const run = (argv: string[]) => runWithArgv([...BASE, ...argv]);

describe("B179 CLI --export-csv", () => {
  test("named sink writes canonical CSV after the whole batch succeeds", async () => {
    const target = join(dir, "export.csv");
    const code = await run([
      "--export-csv", `export=${target}`,
      "-e", "CREATE TEMP TABLE #export AS SELECT 'A' AS code, 'x,\"y\"' AS text; SELECT 1 AS done",
    ]);
    expect({ code, stderr: err() }).toEqual({ code: 0, stderr: expect.stringContaining("export: export ->") });
    expect(readFileSync(target, "utf8")).toBe('code,text\r\nA,"x,""y"""\r\n');
    expect(tmpFiles()).toEqual([]);
    expect(err()).toContain("export: export ->");
  });

  test("unnamed path exports a single SELECT with engine column metadata", async () => {
    getRecords.mockResolvedValue({ records: [{ code: { value: "A" }, tags: { value: ["p", "q"] } }] });
    const target = join(dir, "single.csv");
    const code = await run(["--export-csv", target, "-e", "SELECT code, tags FROM APP100"]);
    expect(code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe('code,tags\r\nA,"p\nq"\r\n');
  });

  test.each([
    ["multi-statement", "SELECT 1 AS a; SELECT 2 AS b"],
    ["DML", "INSERT INTO APP100 (code) VALUES ('A')"],
  ])("unnamed path is rejected before execution for %s", async (_label, sql) => {
    const target = join(dir, "bad.csv");
    const code = await run(["--allow-dml", "--yes", "--export-csv", target, "-e", sql]);
    expect(code).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(getRecords).not.toHaveBeenCalled();
    expect(postRecords).not.toHaveBeenCalled();
  });

  test.each([
    ["missing CREATE", "SELECT 1 AS a; SELECT 2 AS b", "ExportSinkNotFoundError"],
    ["dropped sink", "CREATE TEMP TABLE #export AS SELECT 1 AS a; DROP TEMP TABLE #export", "ExportSinkNotFoundError"],
    ["DML target", "UPDATE APP100 SET code = 'x' WHERE code = 'a' VALIDATE ONLY INTO #export; SELECT * FROM #export", "ExportSinkInvalidTargetError"],
  ])("named sink validation fails before execution for %s", async (_label, sql, expectedCode) => {
    const target = join(dir, "sink.csv");
    const code = await run(["--allow-dml", "--yes", "--export-csv", `export=${target}`, "-e", sql]);
    expect(code).toBe(2);
    expect(err()).toContain(expectedCode);
    expect(existsSync(target)).toBe(false);
    expect(getRecords).not.toHaveBeenCalled();
    expect(getFields).not.toHaveBeenCalled();
  });

  test.each([
    ["invalid left side", "bad:left=out.csv"],
    ["missing path", "export="],
    ["empty", ""],
  ])("option syntax error: %s", async (_label, value) => {
    const code = await run(["--export-csv", value, "-e", "SELECT 1 AS a"]);
    expect(code).toBe(2);
    expect(err()).toContain("ArgumentError");
  });

  test("the first '=' splits name and path, keeping later '=' in the path", async () => {
    const target = join(dir, "a=b.csv");
    const code = await run(["--export-csv", `export=${target}`, "-e", "CREATE TEMP TABLE #export AS SELECT 1 AS n; SELECT 1 AS done"]);
    expect({ code, stderr: err() }).toEqual({ code: 0, stderr: expect.any(String) });
    expect(readFileSync(target, "utf8")).toBe("n\r\n1\r\n");
  });

  test("duplicate sink name, duplicate path, --output collision, and --dry-run are rejected", async () => {
    const target = join(dir, "dup.csv");
    const sql = "CREATE TEMP TABLE #a AS SELECT 1 AS n; CREATE TEMP TABLE #b AS SELECT 2 AS n";
    expect(await run(["--export-csv", `a=${target}`, "--export-csv", `a=${join(dir, "other.csv")}`, "-e", sql])).toBe(2);
    expect(await run(["--export-csv", `a=${target}`, "--export-csv", `b=${target}`, "-e", sql])).toBe(2);
    expect(await run(["--output", target, "--export-csv", `a=${target}`, "-e", sql])).toBe(2);
    expect(await run(["--dry-run", "--export-csv", `a=${target}`, "-e", sql])).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(getRecords).not.toHaveBeenCalled();
    expect(getFields).not.toHaveBeenCalled();
  });

  test("a failing statement leaves existing files untouched and writes nothing", async () => {
    const target = join(dir, "keep.csv");
    writeFileSync(target, "OLD");
    getFields.mockRejectedValueOnce(new Error("schema unavailable"));
    const code = await run([
      "--export-csv", `export=${target}`,
      "-e", "CREATE TEMP TABLE #export AS SELECT code FROM APP100; SELECT 1 AS later",
    ]);
    expect(code).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("OLD");
    expect(tmpFiles()).toEqual([]);
  });

  test("EXIT before CREATE produces no file, keeps existing files, and exits 0", async () => {
    const target = join(dir, "exit.csv");
    writeFileSync(target, "OLD");
    const code = await run([
      "--export-csv", `export=${target}`,
      "-e", "-- @ksql dialect: 1\nEXIT SUCCESS IF 1 = 1, 'nothing'; CREATE TEMP TABLE #export AS SELECT 1 AS n",
    ]);
    expect(code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("OLD");
    expect(err()).toContain("not created");
  });

  test("a SUBTABLE column fails serialization with no file for any sink", async () => {
    getRecords.mockResolvedValue({ records: [{ code: { value: "A" }, Lines: { value: [] } }] });
    const good = join(dir, "good.csv");
    const bad = join(dir, "bad.csv");
    const code = await run([
      "--export-csv", `good=${good}`, "--export-csv", `bad=${bad}`,
      "-e", "CREATE TEMP TABLE #good AS SELECT code FROM APP100; CREATE TEMP TABLE #bad AS SELECT Lines FROM APP100",
    ]);
    expect(code).toBe(1);
    expect(err()).toContain("ExportSinkUnsupportedColumnError");
    expect(existsSync(good)).toBe(false);
    expect(existsSync(bad)).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  test("Shift_JIS export writes CP932 bytes without BOM and rejects unrepresentable characters", async () => {
    const ok = join(dir, "sjis.csv");
    expect(await run([
      "--export-encoding", "sjis", "--export-csv", `export=${ok}`,
      "-e", "CREATE TEMP TABLE #export AS SELECT '日本' AS v; SELECT 1 AS done",
    ])).toBe(0);
    const bytes = readFileSync(ok);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0x76, 0x0d, 0x0a]);
    expect(new TextDecoder("shift_jis").decode(bytes)).toBe("v\r\n日本\r\n");

    const bad = join(dir, "sjis-bad.csv");
    writeFileSync(bad, "OLD");
    const code = await run([
      "--export-encoding", "sjis", "--export-csv", `export=${bad}`,
      "-e", "CREATE TEMP TABLE #export AS SELECT '波〜' AS v; SELECT 1 AS done",
    ]);
    expect(code).toBe(1);
    expect(err()).toContain("ExportSinkEncodingError");
    expect(err()).toContain("U+301C");
    expect(readFileSync(bad, "utf8")).toBe("OLD");
    expect(tmpFiles()).toEqual([]);
  });

  test("--export-timezone converts DATETIME cells", async () => {
    getFields.mockResolvedValue([{ code: "when", label: "when", fieldType: "DATETIME" }]);
    getRecords.mockResolvedValue({ records: [{ when: { value: "2026-01-02T03:04:05Z" } }] });
    const target = join(dir, "tz.csv");
    expect(await run(["--export-timezone", "Asia/Tokyo", "--export-csv", target, "-e", "SELECT `when` FROM APP100"])).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("when\r\n2026-01-02T12:04:05+09:00\r\n");
    expect(await run(["--export-timezone", "Invalid/Zone", "--export-csv", join(dir, "x.csv"), "-e", "SELECT `when` FROM APP100"])).toBe(2);
  });

  test("--format csv stdout stays byte-identical whether or not --export-csv is used", async () => {
    getRecords.mockResolvedValue({ records: [{ code: { value: "A" }, tags: { value: ["p", "q"] } }] });
    const sql = "SELECT code, tags FROM APP100";
    const plainCode = await runWithArgv([...BASE.slice(0, -2), "--format", "csv", "-e", sql]);
    expect({ code: plainCode, stderr: err() }).toEqual({ code: 0, stderr: expect.any(String) });
    const plain = out();
    stdout.mockClear();
    expect(await runWithArgv([...BASE.slice(0, -2), "--format", "csv", "--export-csv", join(dir, "e.csv"), "-e", sql])).toBe(0);
    expect(out()).toBe(plain);
    expect(plain).toBe('code,tags\nA,"[""p"",""q""]"\n');
  });

  test("replacing an existing target succeeds, and an open handle on Windows keeps the old file", async () => {
    const target = join(dir, "replace.csv");
    writeFileSync(target, "OLD");
    expect(await run(["--export-csv", `export=${target}`, "-e", "CREATE TEMP TABLE #export AS SELECT 1 AS n; SELECT 1 AS done"])).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("n\r\n1\r\n");

    const held = openSync(target, "r");
    try {
      const code = await run(["--export-csv", `export=${target}`, "-e", "CREATE TEMP TABLE #export AS SELECT 2 AS n; SELECT 1 AS done"]);
      if (process.platform === "win32") {
        expect(code).toBe(1);
        expect(err()).toContain("ExportSinkWriteError");
        expect(readFileSync(target, "utf8")).toBe("n\r\n1\r\n");
      } else {
        expect(code).toBe(0);
        expect(readFileSync(target, "utf8")).toBe("n\r\n2\r\n");
      }
      expect(tmpFiles()).toEqual([]);
    } finally {
      closeSync(held);
    }
  });
});
