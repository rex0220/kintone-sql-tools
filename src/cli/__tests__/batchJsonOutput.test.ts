// ============================================================
// CLI バッチ + --format json のエンベロープ出力（バッチ強化第1弾 B2）
//
// executeBatch（モッククライアント）で実バッチ結果を作り、
// writeBatchOutput の stdout / ファイル出力を検証する。
// - json: MCP と同一のエンベロープ（buildBatchEnvelope）を単一 JSON で出力
// - table / jsonl: 従来出力（結果セットごと・空行区切り / 行ストリーム）を維持
// ============================================================

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeBatchOutput } from "../index";
import { executeBatch, type BatchExecuteResult, type KintoneClient } from "../../core";
import { buildBatchEnvelope } from "../../output/batchEnvelope";
import type { KintoneRecord } from "../../converter/dmlToKintone";

function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}

function makeClient(recordsByApp: Record<number, KintoneRecord[]> = {}): KintoneClient {
  return {
    async getRecords(params) {
      return { records: recordsByApp[params.app] ?? [] };
    },
    async postRecords(params) { return { ids: params.records.map((_r, i) => String(i + 1)) }; },
    async putRecords() { },
    async deleteRecords() { },
    async getApps() { return []; },
    async getFields() { return []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

const APP1 = [
  makeRecord({ $id: "1", 顧客名: "A社", 売上: "100" }),
  makeRecord({ $id: "2", 顧客名: "B社", 売上: "300" }),
];

const BATCH_SQL =
  "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100;" +
  "SELECT 顧客名 FROM #t;" +
  "SELECT 売上 FROM #t";

async function runBatch(sql: string): Promise<BatchExecuteResult> {
  return executeBatch(sql, makeClient({ 100: APP1 }));
}

interface Captured {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function callWriteBatchOutput(
  batch: BatchExecuteResult,
  opts: Partial<Parameters<typeof writeBatchOutput>[1]> = {}
): Captured {
  let stdout = "";
  let stderr = "";
  const outSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const errSpy = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    const exitCode = writeBatchOutput(batch, {
      format: "json",
      noHeader: false,
      pretty: false,
      displayOptions: {},
      outputPath: null,
      quiet: false,
      ...opts,
    });
    return { exitCode, stdout, stderr };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

test("json: バッチ全体を MCP と同一のエンベロープ単一 JSON で出力する", async () => {
  const batch = await runBatch(BATCH_SQL);
  const { exitCode, stdout } = callWriteBatchOutput(batch, { format: "json" });

  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout); // 単一 JSON ドキュメントとしてパースできる
  expect(parsed).toEqual(JSON.parse(JSON.stringify(buildBatchEnvelope(batch)))); // MCP と一致
  expect(parsed.ok).toBe(true);
  expect(parsed.batch).toBe(true);
  expect(parsed.statementCount).toBe(3);
  expect(parsed.statements[0]).toMatchObject({ type: "CREATE_TEMP_TABLE", tempTable: "#t", rowCount: 2 });
  expect(parsed.statements[1].resultIndex).toBe(0);
  expect(parsed.results).toHaveLength(2);
  expect(parsed.results[0].rows).toEqual([{ 顧客名: "A社" }, { 顧客名: "B社" }]);
});

test("json: --pretty でインデント付き出力", async () => {
  const batch = await runBatch(BATCH_SQL);
  const { stdout } = callWriteBatchOutput(batch, { format: "json", pretty: true });
  expect(stdout).toContain("\n  ");
  expect(JSON.parse(stdout).statementCount).toBe(3);
});

test("json: --output でファイルにも同じエンベロープを書く", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-batch-json-"));
  const path = join(dir, "out.json");
  try {
    const batch = await runBatch(BATCH_SQL);
    const { exitCode, stdout } = callWriteBatchOutput(batch, { format: "json", outputPath: path });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(""); // stdout には出さない
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.batch).toBe(true);
    expect(parsed.statementCount).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("json: 部分失敗（continueOnError）は ok: false + exit 1、statements[] で判別できる", async () => {
  // 2文目はスカラーサブクエリ複数行の実行時エラー
  const batch = await executeBatch(
    "SELECT 顧客名 FROM APP100;" +
    "SELECT 顧客名 FROM APP100 WHERE 売上 = (SELECT 売上 FROM APP100);" +
    "SELECT 売上 FROM APP100",
    makeClient({ 100: APP1 }),
    { continueOnError: true }
  );
  const { exitCode, stdout } = callWriteBatchOutput(batch, { format: "json" });

  expect(exitCode).toBe(1);
  const parsed = JSON.parse(stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.statements[1].status).toBe("error");
  expect(parsed.statements[2].status).toBe("success");
});

test("json: バッチ内 ASSERT は status のみの no-result 文として出力される", async () => {
  const batch = await runBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM #t) = 2;" +
    "SELECT 顧客名 FROM #t"
  );
  const { stdout } = callWriteBatchOutput(batch, { format: "json" });
  const parsed = JSON.parse(stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.statements[1]).toEqual({ index: 1, type: "ASSERT", status: "success" });
  expect(parsed.results).toHaveLength(1); // ASSERT は results に入らない
});

test("table: 従来出力（結果セットの空行区切り）を維持する", async () => {
  const batch = await runBatch(BATCH_SQL);
  const { stdout, stderr } = callWriteBatchOutput(batch, { format: "table" });
  expect(stdout).toContain("顧客名");
  expect(stdout).toContain("\n\n"); // 結果セット間の空行
  expect(() => JSON.parse(stdout)).toThrow(); // 単一 JSON ではない
  expect(stderr).toContain("[1] CREATE_TEMP_TABLE success"); // サマリは stderr のまま
});

test("jsonl: 行ストリームの契約を維持する（エンベロープ化しない）", async () => {
  const batch = await runBatch(BATCH_SQL);
  const { stdout } = callWriteBatchOutput(batch, { format: "jsonl" });
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  // 各行が独立した JSON（行オブジェクト）としてパースできる
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
  expect(JSON.parse(lines[0])).toEqual({ 顧客名: "A社" });
});

test("json: --quiet で stderr のサマリ行を抑止する", async () => {
  const batch = await runBatch(BATCH_SQL);
  const { stderr } = callWriteBatchOutput(batch, { format: "json", quiet: true });
  expect(stderr).toBe("");
});
