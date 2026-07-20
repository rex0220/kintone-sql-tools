import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let childCount = 1;
const getRecords = jest.fn(async () => ({
  records: [{
    $id: { value: "8" },
    $revision: { value: "3" },
    親: { value: "before" },
    テーブル: { value: Array.from({ length: childCount }, (_, index) => ({
      id: String(101 + index), value: { 子: { value: "old" } },
    })) },
  }],
}));
const postRecords = jest.fn(async () => ({ ids: [] }));
const putRecords = jest.fn(async () => undefined);
const deleteRecords = jest.fn(async () => undefined);

jest.mock("../nodeKintoneClient", () => ({
  createNodeKintoneClient: () => ({
    getRecords,
    openCursor: jest.fn(async () => { throw new Error("unexpected cursor"); }),
    postRecords,
    putRecords,
    deleteRecords,
    getApps: jest.fn(async () => []),
    getFields: jest.fn(async () => [
      { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
      { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
      { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
    ]),
    getProcessStatuses: jest.fn(async () => ({ enable: false, states: [] })),
    getNumberPrecision: jest.fn(async () => ({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" })),
  }),
}));

import { runWithArgv } from "../index";

const SQL = "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (PATCH SET 子='patched' ALL ROWS)";
const INSERT_SQL = "INSERT INTO APP4221 (親) VALUES ('new') APPLY テーブル (APPEND (子) VALUES ('child'))";
const BASE = ["--base-url", "https://example.cybozu.com", "--auth", "token", "--token", "dummy"];

async function captured(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk); return true;
  }) as typeof process.stdout.write);
  const err = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk); return true;
  }) as typeof process.stderr.write);
  try {
    return { code: await runWithArgv(argv), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

beforeEach(() => {
  childCount = 1;
  jest.clearAllMocks();
  delete process.env.KSQL_DML_MAX_SUBTABLE_ROWS;
});

afterAll(() => {
  delete process.env.KSQL_DML_MAX_SUBTABLE_ROWS;
});

test("APPLY mutation は --allow-dml/--yes 内で capability と二重 guard を配線し専用 detail を表示する", async () => {
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", "1",
    "--dml-max-subtable-rows", "1", "-e", SQL,
  ]);
  expect(result.code).toBe(0);
  expect(putRecords).toHaveBeenCalledTimes(1);
  expect(result.stderr).toContain("[APPLY PATCH/APPEND/REMOVE Confirm] parents=1 changedSubtableRows=1 addedSubtableRows=0");
  expect(result.stderr).toContain("table=テーブル PATCH=1 APPEND=0 REMOVE=0");
  expect(result.stderr).toContain("deleted=0 deletedParents=0 revisionRequired=true");
  expect(result.stderr).toContain("revision conflict retry=false");
  expect(result.stderr).toContain("irreversible=true");
});

test("APPLY 子 guard 超過は --yes でも records PUT 0", async () => {
  childCount = 2;
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", "1",
    "--dml-max-subtable-rows", "1", "-e", SQL,
  ]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("changed subtable rows (2) exceed dmlMaxSubtableRows (1)");
  expect(putRecords).not.toHaveBeenCalled();
});

test("APPLY mutation を含む batch にも capability と 100/100 境界を渡す", async () => {
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--format", "json",
    "-e", `${SQL}; SELECT 1 AS ok`,
  ]);
  expect(result.code).toBe(0);
  expect(putRecords).toHaveBeenCalledTimes(1);
  expect(result.stderr).toContain("[APPLY PATCH/APPEND/REMOVE Confirm]");
});

test("Phase 13c: CLIはINSERT APPLY capabilityをPhase 16bまで開かずPOST 0", async () => {
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "-e", INSERT_SQL,
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  expect(postRecords).not.toHaveBeenCalled();
  expect(getRecords).not.toHaveBeenCalled();
});

test("APPLY dry-run は records API 0 で args > env > profile > default を表示する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-apply-config-"));
  const configPath = join(dir, "ksql.config.json");
  writeFileSync(configPath, JSON.stringify({
    defaultProfile: "prod",
    profiles: { prod: { query: { dmlMaxSubtableRows: 33 } } },
  }), "utf8");
  try {
    process.env.KSQL_DML_MAX_SUBTABLE_ROWS = "44";
    const explicit = await captured([...BASE, "--config", configPath, "--dry-run", "--allow-dml", "--dml-max-subtable-rows", "55", "-e", SQL]);
    expect(explicit.stdout).toContain("dmlMaxSubtableRows:     55");
    const env = await captured([...BASE, "--config", configPath, "--dry-run", "--allow-dml", "-e", SQL]);
    expect(env.stdout).toContain("dmlMaxSubtableRows:     44");
    delete process.env.KSQL_DML_MAX_SUBTABLE_ROWS;
    const profile = await captured([...BASE, "--config", configPath, "--dry-run", "--allow-dml", "-e", SQL]);
    expect(profile.stdout).toContain("dmlMaxSubtableRows:     33");
    const defaults = await captured([...BASE, "--dry-run", "--allow-dml", "-e", SQL]);
    expect(defaults.stdout).toContain("dmlMaxSubtableRows:     500");
    expect(getRecords).not.toHaveBeenCalled();
    expect(postRecords).not.toHaveBeenCalled();
    expect(putRecords).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
