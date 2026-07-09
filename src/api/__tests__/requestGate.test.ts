// ============================================================
// リクエストゲート（P0-1）のテスト
// sleep / random を注入して実時間を待たずに検証する
// ============================================================

import {
  RequestGate,
  isRetryableError,
  withRequestGate,
  getGlobalRequestGate,
  resetGlobalRequestGate,
} from "../requestGate";
import type { KintoneClient } from "../../execute";

/** sleep を記録だけして即解決する注入 */
function makeSleepRecorder() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const fixedRandom = () => 0.5; // ジッタ = ×1.0（そのままの値）

function httpError(status: number, body = "{}"): Error {
  return new Error(`kintone API error ${status}: ${body}`);
}

// ----------------------------------------------------------------
// セマフォ
// ----------------------------------------------------------------

test("同時実行数が maxConcurrent を超えない", async () => {
  const gate = new RequestGate({ maxConcurrent: 3 });
  let current = 0;
  let maxObserved = 0;

  const task = () =>
    gate.runReadOnly(async () => {
      current += 1;
      maxObserved = Math.max(maxObserved, current);
      await new Promise((r) => setTimeout(r, 5));
      current -= 1;
      return "ok";
    });

  const results = await Promise.all(Array.from({ length: 12 }, task));
  expect(results).toHaveLength(12);
  expect(maxObserved).toBeLessThanOrEqual(3);
  expect(gate.activeCount).toBe(0);
});

test("書き込み系と読み取り系が同じセマフォを共有する", async () => {
  const gate = new RequestGate({ maxConcurrent: 2 });
  let current = 0;
  let maxObserved = 0;
  const work = async () => {
    current += 1;
    maxObserved = Math.max(maxObserved, current);
    await new Promise((r) => setTimeout(r, 5));
    current -= 1;
  };

  await Promise.all([
    gate.runReadOnly(work),
    gate.runMutation(work),
    gate.runReadOnly(work),
    gate.runMutation(work),
  ]);
  expect(maxObserved).toBeLessThanOrEqual(2);
});

// ----------------------------------------------------------------
// リトライ分類
// ----------------------------------------------------------------

test("リトライ対象: 408/429/502/503/504 とネットワーク層の一時エラー", () => {
  for (const s of [408, 429, 502, 503, 504]) {
    expect(isRetryableError(httpError(s))).toBe(true);
  }
  expect(isRetryableError(new Error("fetch failed"))).toBe(true);
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  expect(isRetryableError(timeout)).toBe(true);
});

test("リトライ対象外: その他の 4xx・素の 500・CB_IL02・一般エラー", () => {
  // 500 は決定的なサーバーエラーの可能性があるため対象外（502/503/504 のみ対象）
  for (const s of [400, 401, 403, 404, 500]) {
    expect(isRetryableError(httpError(s))).toBe(false);
  }
  // CB_IL02 は 400 系ボディで返る（クエリ書き換えフォールバックの責務）
  expect(isRetryableError(httpError(400, '{"code":"CB_IL02"}'))).toBe(false);
  expect(isRetryableError(new Error("ArgumentError: bad input"))).toBe(false);
  expect(isRetryableError("not an error")).toBe(false);
});

// ----------------------------------------------------------------
// リトライ動作（GET 系）
// ----------------------------------------------------------------

test("429 は指数バックオフでリトライして成功する", async () => {
  const { delays, sleep } = makeSleepRecorder();
  const gate = new RequestGate({ maxConcurrent: 2, maxRetries: 3, sleep, random: fixedRandom });
  let calls = 0;

  const result = await gate.runReadOnly(async () => {
    calls += 1;
    if (calls <= 2) throw httpError(429);
    return "ok";
  });

  expect(result).toBe("ok");
  expect(calls).toBe(3);
  expect(delays).toEqual([500, 1000]); // 500ms → 1s（ジッタ ×1.0）
});

test("バックオフは maxDelayMs で頭打ちになる", async () => {
  const { delays, sleep } = makeSleepRecorder();
  const gate = new RequestGate({
    maxRetries: 4,
    baseDelayMs: 500,
    maxDelayMs: 1000,
    sleep,
    random: fixedRandom,
  });
  let calls = 0;
  await expect(
    gate.runReadOnly(async () => {
      calls += 1;
      throw httpError(503);
    })
  ).rejects.toThrow(/kintone API error 503/);
  expect(calls).toBe(5); // 初回 + リトライ4回
  expect(delays).toEqual([500, 1000, 1000, 1000]);
});

test("リトライ対象外のエラーは即 throw（リトライしない）", async () => {
  const { delays, sleep } = makeSleepRecorder();
  const gate = new RequestGate({ maxRetries: 3, sleep });
  let calls = 0;
  await expect(
    gate.runReadOnly(async () => {
      calls += 1;
      throw httpError(400);
    })
  ).rejects.toThrow(/kintone API error 400/);
  expect(calls).toBe(1);
  expect(delays).toEqual([]);
});

test("maxRetries: 0 でリトライ無効", async () => {
  const gate = new RequestGate({ maxRetries: 0 });
  let calls = 0;
  await expect(
    gate.runReadOnly(async () => {
      calls += 1;
      throw httpError(429);
    })
  ).rejects.toThrow(/429/);
  expect(calls).toBe(1);
});

test("書き込み系は 429 でもリトライしない", async () => {
  const { sleep } = makeSleepRecorder();
  const gate = new RequestGate({ maxRetries: 3, sleep });
  let calls = 0;
  await expect(
    gate.runMutation(async () => {
      calls += 1;
      throw httpError(429);
    })
  ).rejects.toThrow(/429/);
  expect(calls).toBe(1);
});

// ----------------------------------------------------------------
// withRequestGate
// ----------------------------------------------------------------

function makeFailThenOkClient(failures: { getRecords: number }) {
  let getRecordsCalls = 0;
  let postCalls = 0;
  const client: KintoneClient = {
    async getRecords() {
      getRecordsCalls += 1;
      if (getRecordsCalls <= failures.getRecords) throw httpError(429);
      return { records: [] };
    },
    async postRecords() {
      postCalls += 1;
      throw httpError(429);
    },
    async putRecords() { },
    async deleteRecords() { },
    async getApps() { return []; },
    async getFields() { return []; },
  };
  return { client, calls: () => ({ getRecordsCalls, postCalls }) };
}

test("withRequestGate: GET 系はリトライ付き、書き込み系はリトライなし", async () => {
  const { sleep } = makeSleepRecorder();
  const gate = new RequestGate({ maxRetries: 2, sleep, random: fixedRandom });
  const { client, calls } = makeFailThenOkClient({ getRecords: 1 });
  const gated = withRequestGate(client, gate);

  const res = await gated.getRecords({ app: 1, query: "", fields: [] });
  expect(res.records).toEqual([]);
  expect(calls().getRecordsCalls).toBe(2); // 1回失敗 → リトライで成功

  await expect(gated.postRecords({ app: 1, records: [] })).rejects.toThrow(/429/);
  expect(calls().postCalls).toBe(1); // リトライしない
});

// ----------------------------------------------------------------
// グローバルゲート
// ----------------------------------------------------------------

describe("getGlobalRequestGate", () => {
  const envBackup = process.env.KSQL_MAX_CONCURRENT;

  afterEach(() => {
    if (envBackup === undefined) delete process.env.KSQL_MAX_CONCURRENT;
    else process.env.KSQL_MAX_CONCURRENT = envBackup;
    resetGlobalRequestGate();
  });

  test("初回解決値で固定され、以降のヒントは無視される", () => {
    delete process.env.KSQL_MAX_CONCURRENT;
    resetGlobalRequestGate();
    const g1 = getGlobalRequestGate(5);
    expect(g1.limit).toBe(5);
    const g2 = getGlobalRequestGate(20);
    expect(g2).toBe(g1);
    expect(g2.limit).toBe(5);
  });

  test("KSQL_MAX_CONCURRENT env がヒントより優先される", () => {
    process.env.KSQL_MAX_CONCURRENT = "7";
    resetGlobalRequestGate();
    expect(getGlobalRequestGate(3).limit).toBe(7);
  });

  test("ヒントなし・env なしは既定 10", () => {
    delete process.env.KSQL_MAX_CONCURRENT;
    resetGlobalRequestGate();
    expect(getGlobalRequestGate().limit).toBe(10);
  });
});
