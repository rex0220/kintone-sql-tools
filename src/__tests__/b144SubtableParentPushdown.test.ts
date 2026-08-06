import { execute, KintoneClient, SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type { KintoneGetParams } from "../converter/selectToKintone";

/**
 * B144 サブテーブル仮想テーブルの親レコード取得に WHERE を押し下げる。
 *
 * 以前は `const parentQuery = isMainTable ? "" : "";`（両辺とも空文字）で、
 * 親クエリを一切組み立てていなかった。EXPLAIN は WHERE 全体が exact に
 * 押し下げられる場合に `kintone query:` を表示するため、
 * 「計画は EXACT・実行は全件取得」と食い違っていた。
 */

function makeClient(records: KintoneRecord[], fieldTypes: Record<string, string> = {}): KintoneClient & {
  getCalls: { app: number; query: string }[];
} {
  const getCalls: { app: number; query: string }[] = [];
  return {
    getCalls,
    async getRecords(params: KintoneGetParams) {
      getCalls.push({ app: params.app, query: params.query ?? "" });
      return { records };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* no writes in these tests */ },
    async deleteRecords() { /* no deletes in these tests */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "数値", label: "数値", fieldType: fieldTypes["数値"] ?? "NUMBER" },
        { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
        // 明細項目は inSubtable を立てる。親の解決表から除外され（execute.ts の
        // infoByCode）、WHERE が EXACT にならないので押し下げ対象から外れる。
        { code: "数値_0", label: "数値_0", fieldType: "NUMBER", inSubtable: true, subtableCode: "テーブル" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  } as KintoneClient & { getCalls: { app: number; query: string }[] };
}

/** fetchAll が付ける `order by ... limit ... offset ...` を落とし、WHERE 部分だけを返す。 */
function whereOf(query: string): string {
  return query.replace(/s*order by .*$/, "").trim();
}

/** 親 2 レコード・各 2 行のサブテーブル。 */
function parentRecords(): KintoneRecord[] {
  const row = (id: string, value: string) => ({
    id,
    value: { 数値_0: { type: "NUMBER", value } },
  });
  return [
    {
      $id: { type: "__ID__", value: "1" },
      数値: { type: "NUMBER", value: "100" },
      テーブル: { type: "SUBTABLE", value: [row("11", "5"), row("12", "6")] },
    },
    {
      $id: { type: "__ID__", value: "2" },
      数値: { type: "NUMBER", value: "200" },
      テーブル: { type: "SUBTABLE", value: [row("21", "7"), row("22", "8")] },
    },
  ] as unknown as KintoneRecord[];
}

test("B144: 親項目だけの WHERE は親レコード取得へ押し下げる", async () => {
  const client = makeClient(parentRecords());
  await execute("SELECT _pid, 数値_0 FROM APP100$テーブル WHERE _p.数値 = 100", client);
  expect(client.getCalls).toHaveLength(1);
  expect(whereOf(client.getCalls[0].query)).toBe("数値 = 100");
});

test("B144: $id 条件も押し下げる", async () => {
  const client = makeClient(parentRecords());
  await execute("SELECT _pid FROM APP100$テーブル WHERE _p.$id in (1, 2)", client);
  expect(whereOf(client.getCalls[0].query)).toBe("$id in (1,2)");
});

test("B144: 明細項目の WHERE は押し下げない（親を全件取得する）", async () => {
  const client = makeClient(parentRecords());
  await execute("SELECT _pid, 数値_0 FROM APP100$テーブル WHERE 数値_0 = 5", client);
  expect(whereOf(client.getCalls[0].query)).toBe("");
});

test("B144: サブテーブル側のシステム列は押し下げない", async () => {
  const client = makeClient(parentRecords());
  await execute("SELECT COUNT(*) AS 件数 FROM APP100$テーブル WHERE _pid = 1", client);
  expect(whereOf(client.getCalls[0].query)).toBe("");
});

test("B144: 親項目と明細項目の混在は押し下げない（EXACT にならないため）", async () => {
  const client = makeClient(parentRecords());
  await execute("SELECT _pid FROM APP100$テーブル WHERE _p.数値 = 100 AND 数値_0 = 5", client);
  expect(whereOf(client.getCalls[0].query)).toBe("");
});

test("B144: _p. で明細項目を指しても押し下げない（codex レビュー指摘の回帰固定）", async () => {
  // レビューで「_p. の解決表が明細項目を除外しておらず、親クエリへ漏れて行が落ちる」と
  // 高重大度の指摘を受けた。実機（= / != / テキスト項目）では再現せず、いずれも
  // WHERE_RESIDUAL となって全件取得になる。解決側が変わったときに気づけるよう固定する。
  for (const sql of [
    "SELECT _pid FROM APP100$テーブル WHERE _p.数値_0 = 5",
    "SELECT _pid FROM APP100$テーブル WHERE _p.数値_0 != 5",
  ]) {
    const client = makeClient(parentRecords());
    await execute(sql, client);
    expect(whereOf(client.getCalls[0].query)).toBe("");
  }
});

test("B144: 押し下げても行は落ちない（取得後に WHERE を再評価する）", async () => {
  const client = makeClient(parentRecords());
  const pushed = await execute(
    "SELECT _pid, 数値_0 FROM APP100$テーブル WHERE _p.数値 = 100", client
  ) as SelectResult;
  // 押し下げない同義のクエリ（明細側で親を特定できないので全件取得になる）と行が一致する。
  const scanned = await execute(
    "SELECT _pid, 数値_0 FROM APP100$テーブル WHERE _pid = 1", client
  ) as SelectResult;
  expect(pushed.rows).toEqual(scanned.rows);
  expect(pushed.rows).toHaveLength(2);
});
