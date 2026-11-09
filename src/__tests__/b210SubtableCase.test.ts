import { execute, type KintoneClient } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import type { KintoneGetParams } from "../converter/selectToKintone";

/**
 * B210: サブテーブルの DML でも、CASE と WHERE の数値の項目の大小を数値で比べる。
 *
 * 明細の 数値_0 は 5・10（親 1）、30・8（親 2）。`> 7` は数値なら 10・30・8 の 3 行、
 * 辞書順なら "8" の 1 行だけ。
 */
interface Put { app: number; id: number; record: Record<string, { value: unknown }> }

function makeClient(puts: Put[]): KintoneClient {
  const row = (id: string, value: string) => ({ id, value: { 数値_0: { type: "NUMBER", value } } });
  const records = [
    { $id: { type: "__ID__", value: "1" }, テーブル: { type: "SUBTABLE", value: [row("11", "5"), row("12", "10")] } },
    { $id: { type: "__ID__", value: "2" }, テーブル: { type: "SUBTABLE", value: [row("21", "30"), row("22", "8")] } },
  ] as unknown as KintoneRecord[];
  return {
    async getRecords(_params: KintoneGetParams) { return { records }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords(params: { app: number; records: Array<{ id: number; record: Put["record"] }> }) {
      for (const record of params.records) puts.push({ app: params.app, id: Number(record.id), record: record.record });
    },
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
        { code: "数値_0", label: "数値_0", fieldType: "NUMBER", inSubtable: true, subtableCode: "テーブル" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  } as unknown as KintoneClient;
}

/** 書いた明細の行を [行 id, 数値_0] で返す（書かなかった行は value に id だけ） */
function writtenRows(puts: Put[]): Array<[string, string]> {
  return puts.flatMap((put) => (put.record.テーブル.value as Array<{ id: string; value?: { 数値_0?: { value: string } } }>)
    .filter((row) => row.value?.数値_0 !== undefined)
    .map((row): [string, string] => [row.id, String(row.value!.数値_0!.value)]));
}

test("B210: サブテーブルの UPDATE の WHERE の大小を数値で比べる（> 7 は 3 行）", async () => {
  const puts: Put[] = [];
  await execute("UPDATE APP100$テーブル SET 数値_0 = 0 WHERE _rid IN ('11', '12', '21', '22') AND 数値_0 > 7", makeClient(puts), { cacheContext: "b210-sub-where" });
  expect(writtenRows(puts).map(([id]) => id).sort()).toEqual(["12", "21", "22"]);
});

test("B210: サブテーブルの UPDATE の SET の CASE を数値で比べる（10 > 7 は 1）", async () => {
  const puts: Put[] = [];
  await execute(
    "UPDATE APP100$テーブル SET 数値_0 = CASE WHEN 数値_0 > 7 THEN 1 ELSE 0 END WHERE _rid IN ('11', '12')",
    makeClient(puts),
    { cacheContext: "b210-sub-case" }
  );
  expect(Object.fromEntries(writtenRows(puts))).toEqual({ 11: "0", 12: "1" });
});

test("B210: サブテーブルの DELETE の WHERE の大小を数値で比べる", async () => {
  const puts: Put[] = [];
  await execute("DELETE FROM APP100$テーブル WHERE _rid IN ('11', '12', '21', '22') AND 数値_0 > 7", makeClient(puts), { cacheContext: "b210-sub-delete" });
  // 残るのは 5 の行だけ（親 1 の 11）。親 2 は 2 行とも消える
  const remaining = puts.flatMap((put) => (put.record.テーブル.value as Array<{ id: string }>).map((row) => row.id));
  expect(remaining.sort()).toEqual(["11"]);
});

test("B210: サブテーブルの UPDATE の SET の CASE（_rid を = で指定。IN が無い形）", async () => {
  const puts: Put[] = [];
  await execute(
    "UPDATE APP100$テーブル SET 数値_0 = CASE WHEN 数値_0 > 7 THEN 1 ELSE 0 END WHERE _rid = '12'",
    makeClient(puts),
    { cacheContext: "b210-sub-case-eq" }
  );
  expect(Object.fromEntries(writtenRows(puts))).toEqual({ 12: "1" });
});

test("B210: サブテーブルの UPDATE の WHERE（_rid を = で指定。IN が無い形）", async () => {
  const puts: Put[] = [];
  await execute("UPDATE APP100$テーブル SET 数値_0 = 0 WHERE _rid = '12' AND 数値_0 > 7", makeClient(puts), { cacheContext: "b210-sub-where-eq" });
  expect(writtenRows(puts).map(([id]) => id)).toEqual(["12"]);
});

test("B210: サブテーブルの DELETE の WHERE（_rid を = で指定。IN が無い形）", async () => {
  const puts: Put[] = [];
  await execute("DELETE FROM APP100$テーブル WHERE _rid = '12' AND 数値_0 > 7", makeClient(puts), { cacheContext: "b210-sub-delete-eq" });
  const remaining = puts.flatMap((put) => (put.record.テーブル.value as Array<{ id: string }>).map((row) => row.id));
  expect(remaining.sort()).toEqual(["11"]);
});
