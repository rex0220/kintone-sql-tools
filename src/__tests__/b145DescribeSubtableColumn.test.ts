import { execute, KintoneClient, SelectResult, DESCRIBE_COLUMNS } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

/**
 * B145 `DESCRIBE` が明細項目を親項目と区別せずに返し、
 * 親から SELECT すると静かに空になる。
 *
 * 案 A＝`DESCRIBE` に `サブテーブル` 列を足す。
 * 案 B＝親から明細項目を選んだら警告を出す（値は変えない）。
 */

function makeClient(records: KintoneRecord[]): KintoneClient {
  return {
    async getRecords() { return { records }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* no writes */ },
    async deleteRecords() { /* no deletes */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "数値", label: "数値", fieldType: "NUMBER" },
        { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
        { code: "数量", label: "数量", fieldType: "NUMBER", inSubtable: true, subtableCode: "テーブル" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  } as KintoneClient;
}

function parentRecords(): KintoneRecord[] {
  return [{
    $id: { type: "__ID__", value: "1" },
    数値: { type: "NUMBER", value: "100" },
    テーブル: { type: "SUBTABLE", value: [{ id: "11", value: { 数量: { type: "NUMBER", value: "5" } } }] },
  }] as unknown as KintoneRecord[];
}

test("B145 案 A: DESCRIBE_COLUMNS に サブテーブル 列があり、タイプの直後に置かれる", () => {
  expect(DESCRIBE_COLUMNS).toContain("サブテーブル");
  // 「その項目がどの表にあるか」は型の次に読む情報なので、タイプの直後に置く。
  expect(DESCRIBE_COLUMNS.indexOf("サブテーブル")).toBe(DESCRIBE_COLUMNS.indexOf("タイプ") + 1);
});

test("B145 案 A: DESCRIBE は明細項目にサブテーブル名、親項目に空文字を返す", async () => {
  const result = await execute("DESCRIBE APP100", makeClient(parentRecords())) as SelectResult;
  const byCode = new Map(result.rows.map((row) => [row["フィールドコード"], row]));
  expect(byCode.get("数量")?.["サブテーブル"]).toBe("テーブル");
  expect(byCode.get("数値")?.["サブテーブル"]).toBe("");
  // サブテーブル本体（SUBTABLE 型）は親項目なので空文字。
  expect(byCode.get("テーブル")?.["サブテーブル"]).toBe("");
});

test("B145 案 B: 親から明細項目を選ぶと警告が出る（値は変えない）", async () => {
  const result = await execute("SELECT $id, 数量 FROM APP100", makeClient(parentRecords())) as SelectResult;
  // 値は従来どおり空。既存の SQL を壊さない。
  expect(result.rows[0]["数量"]).toBe("");
  const warning = (result.warnings ?? []).find((w) => w.includes("数量"));
  expect(warning).toBeDefined();
  expect(warning).toContain("サブテーブル「テーブル」");
  expect(warning).toContain("全行が空になります");
  // どこから選べばよいかを名指しする。
  expect(warning).toContain("APP100$テーブル");
  // FROM の差し替えだけでは足りない。$id は仮想テーブルに無く、そのまま書くと
  // 今度は $id が空になる（同じ静かな失敗を繰り返す）。codex レビューの指摘。
  expect(warning).toContain("_pid");
  expect(warning).toContain("_p.<フィールドコード>");
});

test("B145 案 B: サブテーブルから選んだときは警告を出さない", async () => {
  const result = await execute(
    "SELECT _pid, 数量 FROM APP100$テーブル", makeClient(parentRecords())
  ) as SelectResult;
  expect(result.rows[0]["数量"]).toBe("5");
  expect((result.warnings ?? []).filter((w) => w.includes("サブテーブル「"))).toEqual([]);
});

test("B145 案 B: 親項目だけの SELECT では警告を出さない", async () => {
  const result = await execute("SELECT $id, 数値 FROM APP100", makeClient(parentRecords())) as SelectResult;
  expect(result.rows[0]["数値"]).toBe("100");
  expect((result.warnings ?? []).filter((w) => w.includes("サブテーブル「"))).toEqual([]);
});
