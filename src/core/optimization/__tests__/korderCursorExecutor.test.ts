import type { KintoneClient } from "../../../execute";
import type { KintoneRecord } from "../../../converter/dmlToKintone";
import { executeKorderCursor } from "../korderCursorExecutor";

function record(id: number): KintoneRecord {
  return { $id: { value: String(id) } };
}

function clientWithPages(pages: Array<{ records: KintoneRecord[]; next: boolean }>) {
  let index = 0;
  let closes = 0;
  const client = {
    async openCursor() {
      return {
        totalCount: 100,
        async nextPage() { return pages[index++] ?? { records: [], next: false }; },
        async close() { closes += 1; },
      };
    },
  } as unknown as KintoneClient;
  return { client, closes: () => closes, pages: () => index };
}

test("offsetをページ境界越しに読み飛ばし、limit到達時に早期closeする", async () => {
  const fixture = clientWithPages([
    { records: [record(1), record(2)], next: true },
    { records: [], next: true },
    { records: [record(3), record(4), record(5)], next: true },
  ]);
  const result = await executeKorderCursor({
    client: fixture.client,
    app: 100,
    fields: ["$id"],
    query: "order by $id asc",
    offset: 2,
    limit: 2,
  });
  expect(result.records.map((r) => r.$id.value)).toEqual(["3", "4"]);
  expect(fixture.pages()).toBe(3);
  expect(fixture.closes()).toBe(1);
});

test("cleanup失敗は成功結果を捨てずwarningにする", async () => {
  const client = {
    async openCursor() {
      return {
        totalCount: 1,
        async nextPage() { return { records: [record(1)], next: true }; },
        async close() { throw new Error("delete failed"); },
      };
    },
  } as unknown as KintoneClient;
  const result = await executeKorderCursor({
    client, app: 100, fields: [], query: "order by $id asc", offset: 0, limit: 1,
  });
  expect(result.records).toHaveLength(1);
  expect(result.cleanupWarning).toContain("CursorCleanupWarning");
});
