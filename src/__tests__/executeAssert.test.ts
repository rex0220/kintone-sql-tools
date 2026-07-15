// ============================================================
// ASSERT 実行のテスト（バッチ強化第1弾 A3）
//
// モッククライアント注入でネットワークなしに検証する。
// - 単文: execute() 経由（AssertResult / AssertError）
// - バッチ: executeBatch() 経由（no-result 文 / continueOnError 無視の停止）
// ============================================================

import {
  execute,
  executeBatch,
  AssertError,
  KintoneClient,
  SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}

function makeClient(recordsByApp: Record<number, KintoneRecord[]> = {}): KintoneClient & {
  getCalls: { app: number; query: string }[];
  putCalls: { app: number; records: unknown[] }[];
} {
  const getCalls: { app: number; query: string }[] = [];
  const putCalls: { app: number; records: unknown[] }[] = [];
  return {
    getCalls,
    putCalls,
    async getRecords(params) {
      getCalls.push({ app: params.app, query: params.query ?? "" });
      return { records: recordsByApp[params.app] ?? [] };
    },
    async postRecords(params) {
      return { ids: params.records.map((_r, i) => String(i + 1)) };
    },
    async putRecords(params) {
      putCalls.push({ app: params.app, records: [...params.records] });
    },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

const APP1 = [
  makeRecord({ $id: "1", 顧客名: "A社", 売上: "100" }),
  makeRecord({ $id: "2", 顧客名: "B社", 売上: "300" }),
  makeRecord({ $id: "3", 顧客名: "C社", 売上: "500" }),
];

// ----------------------------------------------------------------
// 単文: リテラル・算術式
// ----------------------------------------------------------------

test("単文: 成立（リテラル比較）は AssertResult を返す", async () => {
  const client = makeClient();
  const result = await execute("ASSERT 1 = 1", client);
  expect(result.type).toBe("ASSERT");
  if (result.type === "ASSERT") {
    expect(result.condition).toBe("1 = 1");
    expect(result.metrics).toBeDefined();
  }
  expect(client.getCalls).toHaveLength(0); // kintone を読まない
});

test("単文: 算術式の評価（優先順位）", async () => {
  const result = await execute("ASSERT 2 + 3 * 4 = 14", makeClient());
  expect(result.type).toBe("ASSERT");
});

test("単文: 不成立は AssertError（actual 値入り）", async () => {
  await expect(execute("ASSERT 1 = 2", makeClient()))
    .rejects.toThrow("AssertError: assertion failed: 1 = 2 (actual: 1).");
});

test("単文: 文字列比較", async () => {
  const result = await execute("ASSERT 'a' <> 'b'", makeClient());
  expect(result.type).toBe("ASSERT");
  await expect(execute("ASSERT 'a' = 'b'", makeClient()))
    .rejects.toThrow(/assertion failed: 'a' = 'b' \(actual: a\)\./);
});

test("単文: BETWEEN（境界含む）", async () => {
  expect((await execute("ASSERT 5 BETWEEN 1 AND 5", makeClient())).type).toBe("ASSERT");
  await expect(execute("ASSERT 6 BETWEEN 1 AND 5", makeClient()))
    .rejects.toThrow(/assertion failed: 6 BETWEEN 1 AND 5 \(actual: 6\)\./);
});

test("単文: 大小比較は数値として評価される（'9' < '10'）", async () => {
  const result = await execute("ASSERT 9 < 10", makeClient());
  expect(result.type).toBe("ASSERT");
});

test("単文: 空左辺と有限数の範囲比較は WHERE と同じ −∞ 規則を使う", async () => {
  expect((await execute("ASSERT '' < -1000000", makeClient())).type).toBe("ASSERT");
  await expect(execute("ASSERT '' >= -1000000", makeClient()))
    .rejects.toThrow(/assertion failed/);
  await expect(execute("ASSERT '' BETWEEN 0 AND 100", makeClient()))
    .rejects.toThrow(/assertion failed/);
});

// ----------------------------------------------------------------
// 単文: スカラーサブクエリ（APP 参照）
// ----------------------------------------------------------------

test("単文: サブクエリ成立（COUNT）", async () => {
  const client = makeClient({ 100: APP1 });
  const result = await execute("ASSERT (SELECT COUNT(*) FROM APP100) = 3", client);
  expect(result.type).toBe("ASSERT");
  expect(client.getCalls.length).toBeGreaterThan(0);
});

test("単文: サブクエリ不成立は actual に実測値が入る", async () => {
  const client = makeClient({ 100: APP1 });
  await expect(execute("ASSERT (SELECT COUNT(*) FROM APP100) = 0", client))
    .rejects.toThrow(/assertion failed: \(SELECT COUNT\(\*\) FROM APP100\) = 0 \(actual: 3\)\./);
});

test("単文: サブクエリ + BETWEEN", async () => {
  const client = makeClient({ 100: APP1 });
  const result = await execute(
    "ASSERT (SELECT COUNT(*) FROM APP100) BETWEEN 1 AND 500", client
  );
  expect(result.type).toBe("ASSERT");
  await expect(
    execute("ASSERT (SELECT COUNT(*) FROM APP100) BETWEEN 5 AND 10", makeClient({ 100: APP1 }))
  ).rejects.toThrow(/\(actual: 3\)\./);
});

test("単文: サブクエリ 0 行は AssertError", async () => {
  const client = makeClient({ 300: [] });
  await expect(execute("ASSERT (SELECT 売上 FROM APP300) = 1", client))
    .rejects.toThrow("AssertError: scalar subquery returned no rows (expected 1 row).");
});

test("単文: サブクエリ複数行は AssertError", async () => {
  const client = makeClient({ 100: APP1 });
  await expect(execute("ASSERT (SELECT 売上 FROM APP100) = 1", client))
    .rejects.toThrow(/AssertError: scalar subquery returned .+ \(expected 1 row\)\./);
});

test("単文: SELECT * サブクエリの複数列は実行時 AssertError", async () => {
  const client = makeClient({ 200: [makeRecord({ $id: "1", a: "x", b: "y" })] });
  await expect(execute("ASSERT (SELECT * FROM APP200) = 1", client))
    .rejects.toThrow(/AssertError: scalar subquery returned \d+ columns \(expected 1 column\)\./);
});

// ----------------------------------------------------------------
// 単文: 0 件集計は 1 行（COUNT = 0）を返す（v1.12.0）
// ----------------------------------------------------------------

test("単文: 0 件集計の = 0 健全性チェックが成立する（空アプリ）", async () => {
  const client = makeClient({ 300: [] });
  const result = await execute("ASSERT (SELECT COUNT(*) FROM APP300) = 0", client);
  expect(result.type).toBe("ASSERT");
});

test("単文: JS 側 WHERE で全滅した集計も 0 として成立する", async () => {
  // LENGTH は kintone クエリに変換できず JS 側でフィルタされる（全滅 → COUNT = 0）
  const client = makeClient({ 100: APP1 });
  const result = await execute(
    "ASSERT (SELECT COUNT(*) FROM APP100 WHERE LENGTH(顧客名) > 100) = 0", client
  );
  expect(result.type).toBe("ASSERT");
});

test("単文: 0 件集計の不成立は no-rows ではなく actual: 0 になる", async () => {
  const client = makeClient({ 300: [] });
  await expect(execute("ASSERT (SELECT COUNT(*) FROM APP300) BETWEEN 1 AND 500", client))
    .rejects.toThrow(/assertion failed: .+ \(actual: 0\)\./);
});

// ----------------------------------------------------------------
// バッチ: 一時テーブル参照・no-result 文
// ----------------------------------------------------------------

test("バッチ: 一時テーブル参照の ASSERT が成立し result を持たない", async () => {
  const client = makeClient({ 100: APP1 });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 顧客名, 売上 FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500;" +
    "SELECT 顧客名 FROM #t",
    client
  );
  expect(r.ok).toBe(true);
  const assert = r.statements[1];
  expect(assert.type).toBe("ASSERT");
  expect(assert.status).toBe("success");
  expect(assert.result).toBeUndefined(); // no-result 文（mutation summary に流入しない）
  expect((r.statements[2].result as SelectResult).rowCount).toBe(3);
});

test("バッチ: APP 参照の ASSERT も実行できる", async () => {
  const client = makeClient({ 100: APP1 });
  const r = await executeBatch(
    "SELECT 顧客名 FROM APP100; ASSERT (SELECT COUNT(*) FROM APP100) = 3",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements[1].status).toBe("success");
});

test("バッチ: 異常 0 件の = 0 ゲートが成立し後続文が実行される（v1.12.0）", async () => {
  // 言語リファレンスの CLI ヘルスチェック例と同形（健全時に成立するゲート）
  const client = makeClient({ 100: APP1, 300: [] });
  const r = await executeBatch(
    "ASSERT (SELECT COUNT(*) FROM APP300) = 0;" +
    "SELECT 顧客名 FROM APP100",
    client
  );
  expect(r.ok).toBe(true);
  expect(r.statements[0].status).toBe("success");
  expect((r.statements[1].result as SelectResult).rowCount).toBe(3);
});

// ----------------------------------------------------------------
// バッチ: 失敗時の停止（DML ゲート / continueOnError 無視）
// ----------------------------------------------------------------

test("バッチ: ASSERT 失敗で後続 DML が skipped（skippedReason: assertion）", async () => {
  const client = makeClient({ 100: APP1 });
  const r = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT $id, 売上 FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM #t) = 0;" +
    "UPDATE APP100 SET 顧客名 = 'X' WHERE $id = 1",
    client
  );
  expect(r.ok).toBe(false);

  const assert = r.statements[1];
  expect(assert.status).toBe("error");
  expect(assert.error?.code).toBe("AssertError");
  expect(assert.error?.message).toMatch(/^AssertError: assertion failed: .+ \(actual: 3\)\.$/);

  const update = r.statements[2];
  expect(update.status).toBe("skipped");
  expect(update.skippedReason).toBe("assertion");
  expect(client.putCalls).toHaveLength(0); // DML は実行されない
});

test("バッチ: ASSERT 失敗は continueOnError を無視して停止する（設計判断 D3）", async () => {
  const client = makeClient({ 100: APP1 });
  const r = await executeBatch(
    "SELECT 顧客名 FROM APP100;" +
    "ASSERT 1 = 2;" +
    "SELECT 顧客名 FROM APP100",
    client,
    { continueOnError: true }
  );
  expect(r.ok).toBe(false);
  expect(r.statements[0].status).toBe("success");
  expect(r.statements[1].status).toBe("error");
  expect(r.statements[1].error?.code).toBe("AssertError");
  expect(r.statements[2].status).toBe("skipped");
  expect(r.statements[2].skippedReason).toBe("assertion");
});

test("バッチ: continueOnError で通常の実行時エラーは続行する（対照）", async () => {
  const client = makeClient({ 100: APP1 });
  // 2文目はスカラーサブクエリが複数行を返す実行時エラー（AssertError ではない）
  const r = await executeBatch(
    "SELECT 顧客名 FROM APP100;" +
    "SELECT 顧客名 FROM APP100 WHERE 売上 = (SELECT 売上 FROM APP100);" +
    "SELECT 顧客名 FROM APP100",
    client,
    { continueOnError: true }
  );
  expect(r.ok).toBe(false);
  expect(r.statements[1].status).toBe("error");
  expect(r.statements[1].error?.code).not.toBe("AssertError");
  // AssertError と異なり後続は実行される
  expect(r.statements[2].status).toBe("success");
});

test("AssertError は名前と message 接頭辞の両方で識別できる", async () => {
  try {
    await execute("ASSERT 1 = 2", makeClient());
    throw new Error("エラーになりませんでした");
  } catch (e) {
    expect(e).toBeInstanceOf(AssertError);
    expect((e as Error).name).toBe("AssertError");
    expect((e as Error).message.startsWith("AssertError:")).toBe(true);
  }
});
