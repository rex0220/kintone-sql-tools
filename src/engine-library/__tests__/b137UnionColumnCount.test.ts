import {
  runBatch,
  runQuery,
  type ReadonlyKintoneClient,
  type ReadonlyKintoneRecord,
} from "../index";

const field = (value: unknown) => ({ value });

function makeClient(): ReadonlyKintoneClient {
  const recordsByApp: Record<number, ReadonlyKintoneRecord[]> = {
    100: [{ a: field("A"), b: field("B") }],
    200: [{ c: field("C") }],
  };
  return {
    async getRecords({ app }) { return { records: recordsByApp[app] ?? [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async getApps() { return []; },
    async getFields(appId) {
      return Object.keys(recordsByApp[appId]?.[0] ?? {}).map((code) => ({
        code,
        label: code,
        fieldType: "SINGLE_LINE_TEXT",
      }));
    },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

test("B137: engine runQuery は UNION の列数不一致を ArgumentError として返す", async () => {
  await expect(runQuery(
    "SELECT a, b FROM APP100 UNION SELECT c FROM APP200",
    { client: makeClient() }
  )).rejects.toMatchObject({
    code: "EXECUTION_ERROR",
    message: expect.stringContaining(
      "ArgumentError: UNION の左右で列数が一致しません（左 2 列 / 右 1 列）。"
    ),
  });
});

test("B137: engine runBatch は一時テーブル source の UNION 列数不一致を返す", async () => {
  await expect(runBatch(
    "CREATE TEMP TABLE #t AS SELECT a, b FROM APP100 UNION SELECT c FROM APP200; " +
      "SELECT * FROM #t",
    { client: makeClient() }
  )).rejects.toMatchObject({
    code: "EXECUTION_ERROR",
    statementIndex: 0,
    statementType: "CREATE_TEMP_TABLE",
    message: expect.stringContaining("左 2 列 / 右 1 列"),
  });
});
