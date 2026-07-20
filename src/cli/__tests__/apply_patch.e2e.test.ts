import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let parentCount = 1;
let childCount = 1;
let confirmAnswer = "yes";

jest.mock("readline", () => ({
  createInterface: () => ({
    question: (_message: string, callback: (answer: string) => void) => callback(confirmAnswer),
    close: jest.fn(),
  }),
}));

const makeRecord = (index: number) => ({
  $id: { value: String(8 + index) },
  $revision: { value: "3" },
  親: { value: index === 0 ? "old" : `parent-${index}` },
  タグ: { value: ["B"] },
  テーブル: { value: Array.from({ length: childCount }, (_, childIndex) => ({
    id: String(101 + childIndex), value: { 子: { value: "old" } },
  })) },
});

const getRecords = jest.fn(async (params?: { query?: string }) => {
  const records = Array.from({ length: parentCount }, (_, index) => makeRecord(index));
  if (!params?.query?.includes(" in (")) return { records };
  const requested = new Set([...params.query.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) => match[1]));
  const idList = params.query.match(/\bin\s*\(([^)]*)/i)?.[1] ?? "";
  const requestedIds = new Set(idList.match(/\d+/g) ?? []);
  return {
    records: params.query.includes("$id in")
      ? records.filter((record) => requestedIds.has(record.$id.value))
      : records.filter((record) => requested.has(record.親.value)),
  };
});
const postRecords = jest.fn(async (params: { records: unknown[] }) => ({
  ids: params.records.map((_record, index) => String(1000 + index)),
}));
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
      { code: "タグ", label: "タグ", fieldType: "MULTI_SELECT", writable: true, optionOrder: { A: 0, B: 1 } },
      { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
      { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
    ]),
    getProcessStatuses: jest.fn(async () => ({ enable: false, states: [] })),
    getNumberPrecision: jest.fn(async () => ({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" })),
  }),
}));

import { runWithArgv } from "../index";

const UPDATE_SQL = "UPDATE APP4221 SET 親='after' WHERE $id > 0 APPLY テーブル (PATCH SET 子='patched' ALL ROWS)";
const INSERT_SQL = "INSERT INTO APP4221 (親) VALUES ('new') APPLY テーブル (APPEND (子) VALUES ('child'))";
const UPSERT_SQL = "UPSERT INTO APP4221 (親) VALUES ('new'), ('old') ON DUPLICATE (親) "
  + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('initial')) "
  + "ON UPDATE APPLY テーブル (PATCH SET 子='patched' WHERE 子='old')";
const MULTI_SQL = "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY タグ (ADD 'A'; REMOVE 'B')";
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

async function capturedInteractive(argv: string[], answer: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  confirmAnswer = answer;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    return await captured(argv);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}

beforeEach(() => {
  parentCount = 1;
  childCount = 1;
  confirmAnswer = "yes";
  jest.clearAllMocks();
  delete process.env.KSQL_DML_MAX_SUBTABLE_ROWS;
});

afterAll(() => {
  delete process.env.KSQL_DML_MAX_SUBTABLE_ROWS;
});

test.each([100, 101])("複数親 UPDATE APPLY は %i 親を shared detail で表示し100件chunkで実行する", async (count) => {
  parentCount = count;
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", String(count),
    "--dml-max-subtable-rows", String(count), "-e", UPDATE_SQL,
  ]);
  expect(result.code).toBe(0);
  expect(putRecords).toHaveBeenCalledTimes(Math.ceil(count / 100));
  expect(result.stderr).toContain(`[APPLY Confirm] statement=UPDATE parents=${count} chunks=${Math.ceil(count / 100)} chunkSize=100 changedSubtableRows=${count} addedSubtableRows=0`);
  expect(result.stderr).toContain(`table=テーブル PATCH=${count} APPEND=0 REMOVE=0`);
  expect(result.stderr).toContain(`deletedParents=0 revisionRequired=true guardParents=${count}/${count}`);
  expect(result.stderr).toContain("deleted=0 deletedParents=0 revisionRequired=true");
  expect(result.stderr).toContain("revision conflict retry=false");
  expect(result.stderr).toContain("irreversible=true");
  expect(result.stderr).toContain("WARNING: nonTransactional=true partialSuccessPossible=true retryOnRevisionConflict=false");
});

test("INSERT APPLY を開通し、作成親数・初期子行を shared detail から表示する", async () => {
  const result = await captured([...BASE, "--allow-dml", "--yes", "-e", INSERT_SQL]);
  expect(result.code).toBe(0);
  expect(postRecords).toHaveBeenCalledTimes(1);
  expect(result.stderr).toContain("[APPLY Confirm] statement=INSERT parents=1");
  expect(result.stderr).toContain("branch=insert parents=1 createdParents=1 initialSubtableRows=1 chunks=1");
  expect(result.stderr).toContain("table=テーブル PATCH=0 APPEND=1 REMOVE=0");
  expect(result.stderr).toContain("revisionRequired=false");
});

test("UPSERT APPLY を開通し、insert/update 分岐内訳を表示して POST→PUT する", async () => {
  parentCount = 1;
  const result = await captured([...BASE, "--allow-dml", "--yes", "-e", UPSERT_SQL]);
  expect(result.code).toBe(0);
  expect(postRecords).toHaveBeenCalledTimes(1);
  expect(putRecords).toHaveBeenCalledTimes(1);
  expect(result.stderr).toContain("[APPLY Confirm] statement=UPSERT parents=2 chunks=2 chunkSize=100");
  expect(result.stderr).toContain("branch=insert parents=1 createdParents=1 initialSubtableRows=1 chunks=1");
  expect(result.stderr).toContain("branch=update parents=1 chunks=1");
});

test("多値 APPLY を開通し、ADD/REMOVE 件数を表示する（subtable guard 対象外）", async () => {
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-subtable-rows", "1", "-e", MULTI_SQL,
  ]);
  expect(result.code).toBe(0);
  expect(putRecords).toHaveBeenCalledTimes(1);
  expect(result.stderr).toContain("multiValue=タグ fieldType=MULTI_SELECT ADD=1 REMOVE=1");
  expect(result.stderr).toContain("guardSubtableRows=0/1");
});

test("confirm cancel は UPDATE/INSERT とも PUT/POST 0", async () => {
  const update = await capturedInteractive([...BASE, "--allow-dml", "-e", UPDATE_SQL], "no");
  expect(update.code).toBe(2);
  expect(update.stderr).toContain("キャンセル");
  expect(putRecords).not.toHaveBeenCalled();

  jest.clearAllMocks();
  const insert = await capturedInteractive([...BASE, "--allow-dml", "-e", INSERT_SQL], "no");
  expect(insert.code).toBe(2);
  expect(insert.stderr).toContain("キャンセル");
  expect(postRecords).not.toHaveBeenCalled();
});

test("--yes でも親 guard 超過は迂回できず PUT 0", async () => {
  parentCount = 2;
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", "1", "--dml-max-subtable-rows", "10", "-e", UPDATE_SQL,
  ]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("APPLY parent rows (2) exceed dmlMaxRows (1)");
  expect(putRecords).not.toHaveBeenCalled();
});

test("--yes でも子 guard 超過は迂回できず PUT 0", async () => {
  childCount = 2;
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", "1", "--dml-max-subtable-rows", "1", "-e", UPDATE_SQL,
  ]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("changed subtable rows (2) exceed dmlMaxSubtableRows (1)");
  expect(putRecords).not.toHaveBeenCalled();
});

test("単文の部分成功は成功済みchunk/親と失敗stageを明示する", async () => {
  parentCount = 101;
  putRecords.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("GAIA_CO02"));
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", "101", "--dml-max-subtable-rows", "101", "-e", UPDATE_SQL,
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("[APPLY Partial Success] successfulChunks=1 successfulParents=100 failedBranch=UPDATE failedStage=PUT_CHUNK failedChunk=2");
  expect(result.stderr).toContain("already successful writes remain committed");
});

test("UPSERT 部分成功は insert/update 別の成功済み親数と失敗分岐を明示する", async () => {
  parentCount = 101;
  const insertValues = Array.from({ length: 101 }, (_, index) => `('new-${index}')`);
  const updateValues = ["('old')", ...Array.from({ length: 100 }, (_, index) => `('parent-${index + 1}')`)];
  const sql = `UPSERT INTO APP4221 (親) VALUES ${[...insertValues, ...updateValues].join(", ")} ON DUPLICATE (親) `
    + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('initial')) "
    + "ON UPDATE APPLY テーブル (PATCH SET 子='patched' WHERE 子='old')";
  putRecords.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("GAIA_CO02"));
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", "202", "--dml-max-subtable-rows", "202", "-e", sql,
  ]);
  expect(result.code).toBe(1);
  expect(postRecords).toHaveBeenCalledTimes(2);
  expect(putRecords).toHaveBeenCalledTimes(2);
  expect(result.stderr).toContain("successfulParents=201 successfulInserts=101 successfulUpdates=100 failedBranch=UPDATE failedStage=PUT_CHUNK failedChunk=2");
});

test("batch summary も部分成功の成功済み件数と失敗stageを保持する", async () => {
  parentCount = 101;
  putRecords.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("GAIA_CO02"));
  const result = await captured([
    ...BASE, "--allow-dml", "--yes", "--dml-max-rows", "101", "--dml-max-subtable-rows", "101",
    "-e", `${UPDATE_SQL}; SELECT 1 AS ok`,
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("partialSuccess successfulChunks=1 successfulParents=100");
  expect(result.stderr).toContain("failedBranch=UPDATE failedStage=PUT_CHUNK failedChunk=2");
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
    const explicit = await captured([...BASE, "--config", configPath, "--dry-run", "--allow-dml", "--dml-max-subtable-rows", "55", "-e", UPDATE_SQL]);
    expect(explicit.stdout).toContain("dmlMaxSubtableRows:     55");
    const env = await captured([...BASE, "--config", configPath, "--dry-run", "--allow-dml", "-e", UPDATE_SQL]);
    expect(env.stdout).toContain("dmlMaxSubtableRows:     44");
    delete process.env.KSQL_DML_MAX_SUBTABLE_ROWS;
    const profile = await captured([...BASE, "--config", configPath, "--dry-run", "--allow-dml", "-e", UPDATE_SQL]);
    expect(profile.stdout).toContain("dmlMaxSubtableRows:     33");
    const defaults = await captured([...BASE, "--dry-run", "--allow-dml", "-e", UPDATE_SQL]);
    expect(defaults.stdout).toContain("dmlMaxSubtableRows:     500");
    expect(getRecords).not.toHaveBeenCalled();
    expect(postRecords).not.toHaveBeenCalled();
    expect(putRecords).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
