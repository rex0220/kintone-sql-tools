import {
  __metadataCacheScopeCountsForTest,
  buildBatchExplainPlans,
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([code, value]) => [code, { value }])
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClient(initialFields: KintoneFieldInfo[]) {
  let fields = initialFields;
  let recordsByApp: Record<number, KintoneRecord[]> = {};
  const calls = { fields: 0, precision: 0 };
  const client: KintoneClient = {
    async getRecords(params) {
      return { records: recordsByApp[params.app] ?? [] };
    },
    async openCursor() {
      throw new Error("unexpected cursor");
    },
    async postRecords(params) {
      return { ids: params.records.map((_, index) => String(index + 1)) };
    },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() {
      return [];
    },
    async getFields() {
      calls.fields += 1;
      return fields;
    },
    async getProcessStatuses() {
      return { enable: false, states: [] };
    },
    async getNumberPrecision() {
      calls.precision += 1;
      return { digits: 4, decimalPlaces: 2, roundingMode: "HALF_EVEN" };
    },
  };
  return {
    client,
    calls,
    setFields(next: KintoneFieldInfo[]) {
      fields = next;
    },
    setRecords(next: Record<number, KintoneRecord[]>) {
      recordsByApp = next;
    },
  };
}

const OLD_FIELD: KintoneFieldInfo = {
  code: "old",
  label: "old",
  fieldType: "SINGLE_LINE_TEXT",
};
const NEW_FIELD: KintoneFieldInfo = {
  code: "added",
  label: "added",
  fieldType: "SINGLE_LINE_TEXT",
};

test("B87: 定義変更は同じcacheContextの次のexecuteで反映される", async () => {
  const mock = makeClient([OLD_FIELD]);
  mock.setRecords({ 87001: [record({ old: "before", added: "after" })] });
  const options = { cacheContext: "b87-definition-refresh" };

  await execute("SELECT old FROM APP87001", mock.client, options);
  mock.setFields([OLD_FIELD, NEW_FIELD]);

  const result = await execute("SELECT added FROM APP87001", mock.client, options) as SelectResult;
  await execute("SELECT added FROM APP87001", mock.client, options);
  expect(result.rows).toEqual([{ added: "after" }]);
  expect(mock.calls.fields).toBe(3);
});

test("B87: SELECT *で見える追加項目を名指ししてもunknown fieldにならない", async () => {
  const mock = makeClient([OLD_FIELD]);
  mock.setRecords({ 87002: [record({ old: "before" })] });
  const options = { cacheContext: "b87-wildcard-consistency" };

  await execute("SELECT old FROM APP87002", mock.client, options);
  mock.setFields([OLD_FIELD, NEW_FIELD]);
  mock.setRecords({ 87002: [record({ old: "before", added: "after" })] });

  const wildcard = await execute("SELECT * FROM APP87002", mock.client, options) as SelectResult;
  expect(wildcard.columns).toContain("added");
  const named = await execute("SELECT added FROM APP87002", mock.client, options) as SelectResult;
  expect(named.rows).toEqual([{ added: "after" }]);
});

test("B87: 1 execute内の2アプリJOINはgetFieldsを2回だけ呼ぶ", async () => {
  const mock = makeClient([
    { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
    { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  mock.setRecords({
    87003: [record({ key: "K", value: "left" })],
    87004: [record({ key: "K", value: "right" })],
  });

  const result = await execute(
    "SELECT a.value AS leftValue, b.value AS rightValue " +
      "FROM APP87003 a JOIN APP87004 b ON a.key = b.key",
    mock.client,
    { cacheContext: "b87-join-dedup" }
  ) as SelectResult;

  expect(result.rows).toEqual([{ leftvalue: "left", rightvalue: "right" }]);
  expect(mock.calls.fields).toBe(2);
  expect(result.metrics?.fieldCalls).toBe(2);
});

test("B87: 4文2アプリのexecuteBatchはバッチ全体でgetFieldsを2回だけ呼ぶ", async () => {
  const mock = makeClient([
    { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  mock.setRecords({
    87005: [record({ value: "A" })],
    87006: [record({ value: "B" })],
  });
  const before = __metadataCacheScopeCountsForTest();

  const result = await executeBatch(
    "SELECT value FROM APP87005; SELECT value FROM APP87005; " +
      "SELECT value FROM APP87006; SELECT value FROM APP87006",
    mock.client,
    { cacheContext: "b87-batch-dedup" }
  );

  expect(result.ok).toBe(true);
  expect(mock.calls.fields).toBe(2);
  expect(result.metrics?.fieldCalls).toBe(2);
  expect(__metadataCacheScopeCountsForTest()).toEqual(before);
});

test("B87: numberPrecisionも実行を跨いで再利用しない", async () => {
  const mock = makeClient([
    { code: "n", label: "n", fieldType: "NUMBER", writable: true },
  ]);
  const options = { cacheContext: "b87-number-precision" };

  await execute("INSERT INTO APP87007 (n) VALUES (1)", mock.client, options);
  await execute("INSERT INTO APP87007 (n) VALUES (2)", mock.client, options);

  expect(mock.calls.precision).toBe(2);
});

test("B87: 正常終了後は6キャッシュのスコープ数が実行前へ戻る", async () => {
  const mock = makeClient([
    { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  mock.setRecords({ 87009: [record({ value: "A" })] });
  const before = __metadataCacheScopeCountsForTest();

  await execute(
    "SELECT value FROM APP87009 ORDER BY value",
    mock.client,
    { cacheContext: "b87-release-success" }
  );

  expect(__metadataCacheScopeCountsForTest()).toEqual(before);
});

test("B87: metadata取得例外でも6キャッシュのスコープ数が実行前へ戻る", async () => {
  const mock = makeClient([
    { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  mock.client.getFields = async () => {
    throw new Error("mock metadata failure");
  };
  const before = __metadataCacheScopeCountsForTest();

  await expect(execute(
    "SELECT value FROM APP87010",
    mock.client,
    { cacheContext: "b87-release-error" }
  )).rejects.toThrow("mock metadata failure");

  expect(__metadataCacheScopeCountsForTest()).toEqual(before);
});

test("B87: 同じcacheContextの並行executeは別スコープで互いの解放に干渉しない", async () => {
  const mock = makeClient([
    { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  mock.setRecords({ 87011: [record({ value: "A" })] });
  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  let fieldCalls = 0;
  mock.client.getFields = async () => {
    fieldCalls += 1;
    if (fieldCalls === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
    return [{ code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" }];
  };
  const before = __metadataCacheScopeCountsForTest();
  const options = { cacheContext: "b87-concurrent" };

  const first = execute("SELECT value FROM APP87011", mock.client, options);
  await firstStarted.promise;
  const second = execute("SELECT value FROM APP87011", mock.client, options);
  await secondStarted.promise;

  expect(fieldCalls).toBe(2);
  expect(__metadataCacheScopeCountsForTest().fieldInfo).toBe(before.fieldInfo + 2);

  releaseFirst.resolve();
  await first;
  expect(__metadataCacheScopeCountsForTest().fieldInfo).toBe(before.fieldInfo + 1);

  releaseSecond.resolve();
  await second;
  expect(__metadataCacheScopeCountsForTest()).toEqual(before);
});

test("B87: buildBatchExplainPlansも呼び出しを跨いでfield metadataを再利用しない", async () => {
  const mock = makeClient([
    { code: "value", label: "value", fieldType: "SINGLE_LINE_TEXT" },
  ]);

  const before = __metadataCacheScopeCountsForTest();
  await buildBatchExplainPlans(
    "SELECT value FROM APP87008 WHERE value > 'A'",
    mock.client
  );
  await buildBatchExplainPlans(
    "SELECT value FROM APP87008 WHERE value > 'A'",
    mock.client
  );

  expect(mock.calls.fields).toBe(2);
  expect(__metadataCacheScopeCountsForTest()).toEqual(before);
});
