import {
  execute,
  getSelectColumnMeta,
  type KintoneClient,
  type SelectResult,
} from "../execute";

const client: KintoneClient = {
  async getRecords(params) {
    return {
      records: [{
        $id: { value: params.app === 100 ? "1" : "2" },
        ステータス: { value: "受注" },
      }],
    };
  },
  async openCursor() {
    return {
      totalCount: 0,
      async nextPage() {
        return { records: [], next: false };
      },
      async close() {},
    };
  },
  async postRecords() {
    return { ids: [] };
  },
  async putRecords() {},
  async deleteRecords() {},
  async getApps() {
    return [];
  },
  async getFields() {
    return [{
      code: "ステータス",
      label: "ステータス",
      fieldType: "DROP_DOWN",
    }];
  },
  async getNumberPrecision() {
    return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" };
  },
  async getProcessStatuses() {
    return { enable: false, states: null };
  },
};

test("内部 CTE 実体化の system 列メタは semantics.source を持たない", async () => {
  const result = await execute(
    "WITH t AS (SELECT $id FROM APP100), "
      + "unused AS (SELECT $id FROM APP200) "
      + "SELECT $id FROM t",
    client,
    { captureColumnMeta: true, cacheContext: "b69-internal-system-meta" }
  ) as SelectResult;

  const meta = getSelectColumnMeta(result)?.get("$id");
  expect(meta).toMatchObject({ fieldType: "__ID__", sortKind: "number" });
  expect(meta?.semantics?.source).toBeUndefined();
  expect(meta?.publicSourceApp).toBeUndefined();
});
