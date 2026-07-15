import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import type { InsertStatement, UpdateStatement, DeleteStatement } from "../../types/ast";
import {
  insertToPostBatches,
  updateToGetQuery,
  updateToPutBatches,
  hasArithAssignment,
  updateToGetQueryForArith,
  updateToPutBatchesArith,
  deleteToGetQuery,
  deleteToDeleteBatches,
  DmlConvertError,
} from "../dmlToKintone";
import type { KintoneRecord } from "../dmlToKintone";

function parse(sql: string) {
  return new Parser(new Lexer(sql).tokenize()).parse();
}

// ----------------------------------------------------------------
// INSERT
// ----------------------------------------------------------------

test("INSERT 単一行 → POST パラメータ", () => {
  const stmt = parse(
    "INSERT INTO APP100 (名前, 金額) VALUES ('田中', 1000)"
  ) as InsertStatement;
  const batches = insertToPostBatches(stmt);

  expect(batches).toHaveLength(1);
  expect(batches[0]).toEqual({
    app: 100,
    records: [{ 名前: { value: "田中" }, 金額: { value: "1000" } }],
  });
});

test("INSERT 複数行 → POST パラメータ", () => {
  const stmt = parse(
    "INSERT INTO APP100 (名前) VALUES ('田中'), ('鈴木'), ('佐藤')"
  ) as InsertStatement;
  const batches = insertToPostBatches(stmt);

  expect(batches).toHaveLength(1);
  expect(batches[0].records).toHaveLength(3);
});

test("INSERT 101行 → 2バッチに分割", () => {
  // 101行の VALUES 句を動的生成
  const rows = Array.from({ length: 101 }, (_, i) => `('名前${i}')`).join(", ");
  const stmt = parse(
    `INSERT INTO APP100 (名前) VALUES ${rows}`
  ) as InsertStatement;
  const batches = insertToPostBatches(stmt);

  expect(batches).toHaveLength(2);
  expect(batches[0].records).toHaveLength(100);
  expect(batches[1].records).toHaveLength(1);
});

// ----------------------------------------------------------------
// UPDATE
// ----------------------------------------------------------------

test("UPDATE → GET クエリ", () => {
  const stmt = parse(
    "UPDATE APP100 SET ステータス = '完了' WHERE $id = 1"
  ) as UpdateStatement;
  const getParams = updateToGetQuery(stmt);

  expect(getParams).toEqual({
    app: 100,
    query: '$id = 1',
    fields: ["$id"],
    totalCount: false,
  });
});

test("UPDATE → PUT パラメータ（複数 ID）", () => {
  const stmt = parse(
    "UPDATE APP100 SET ステータス = '完了', 金額 = 999 WHERE ステータス = '未完了'"
  ) as UpdateStatement;
  const batches = updateToPutBatches(stmt, [1, 2, 3]);

  expect(batches).toHaveLength(1);
  expect(batches[0]).toEqual({
    app: 100,
    records: [
      { id: 1, record: { ステータス: { value: "完了" }, 金額: { value: "999" } } },
      { id: 2, record: { ステータス: { value: "完了" }, 金額: { value: "999" } } },
      { id: 3, record: { ステータス: { value: "完了" }, 金額: { value: "999" } } },
    ],
  });
});

test("UPDATE 101件 → PUT が 2バッチに分割", () => {
  const stmt = parse(
    "UPDATE APP100 SET f = 'v' WHERE f = 'old'"
  ) as UpdateStatement;
  const ids = Array.from({ length: 101 }, (_, i) => i + 1);
  const batches = updateToPutBatches(stmt, ids);

  expect(batches).toHaveLength(2);
  expect(batches[0].records).toHaveLength(100);
  expect(batches[1].records).toHaveLength(1);
});

// ----------------------------------------------------------------
// DELETE
// ----------------------------------------------------------------

test("DELETE → GET クエリ", () => {
  const stmt = parse(
    "DELETE FROM APP100 WHERE 作成日 < '2023-01-01'"
  ) as DeleteStatement;
  const getParams = deleteToGetQuery(stmt);

  expect(getParams).toEqual({
    app: 100,
    query: '作成日 < "2023-01-01"',
    fields: ["$id"],
    totalCount: false,
  });
});

test("DELETE → DELETE パラメータ", () => {
  const batches = deleteToDeleteBatches(100, [10, 20, 30]);

  expect(batches).toHaveLength(1);
  expect(batches[0]).toEqual({ app: 100, ids: [10, 20, 30] });
});

test("DELETE 101件 → DELETE が 2バッチに分割", () => {
  const ids = Array.from({ length: 101 }, (_, i) => i + 1);
  const batches = deleteToDeleteBatches(100, ids);

  expect(batches).toHaveLength(2);
  expect(batches[0].ids).toHaveLength(100);
  expect(batches[1].ids).toHaveLength(1);
});

// ----------------------------------------------------------------
// WHERE 変換（DML 側の確認）
// ----------------------------------------------------------------

test("UPDATE WHERE ワイルドカード LIKE → 安全のため拒否", () => {
  const stmt = parse(
    "UPDATE APP100 SET f = 'v' WHERE 件名 LIKE '%報告%'"
  ) as UpdateStatement;
  expect(() => updateToGetQuery(stmt)).toThrow(DmlConvertError);
  expect(() => updateToGetQuery(stmt)).toThrow("SELECT で対象レコード番号を確認");
});

test("算術式 UPDATE / DELETE もワイルドカード LIKE を拒否", () => {
  const update = parse(
    "UPDATE APP100 SET 金額 = 金額 * 2 WHERE 件名 LIKE '報告%'"
  ) as UpdateStatement;
  const del = parse("DELETE FROM APP100 WHERE 件名 NOT LIKE '_一時'") as DeleteStatement;
  expect(() => updateToGetQueryForArith(update)).toThrow(DmlConvertError);
  expect(() => deleteToGetQuery(del)).toThrow(DmlConvertError);
});

test("UPDATE WHERE ワイルドカードなし LIKE も安全のため拒否", () => {
  const stmt = parse(
    "UPDATE APP100 SET f = 'v' WHERE 件名 LIKE '報告'"
  ) as UpdateStatement;
  expect(() => updateToGetQuery(stmt)).toThrow(DmlConvertError);
  expect(() => updateToGetQuery(stmt)).toThrow("親レコード DML には JS 評価経路がない");
});

test("親 UPDATE / DELETE でも KLIKE を中央ガードで拒否する", () => {
  const update = parse("UPDATE APP100 SET f = 'v' WHERE 件名 KLIKE '報告'") as UpdateStatement;
  const del = parse("DELETE FROM APP100 WHERE 件名 NOT KLIKE '一時'") as DeleteStatement;
  expect(() => updateToGetQuery(update)).toThrow(DmlConvertError);
  expect(() => updateToGetQuery(update)).toThrow(/全 DML/);
  expect(() => deleteToGetQuery(del)).toThrow(DmlConvertError);
});

test("UPDATE WHERE IN → kintone クエリ", () => {
  const stmt = parse(
    "UPDATE APP100 SET f = 'v' WHERE 種別 IN ('A', 'B')"
  ) as UpdateStatement;
  expect(updateToGetQuery(stmt).query).toBe('種別 in ("A","B")');
});

test("UPDATE WHERE IS NULL → kintone クエリ", () => {
  const stmt = parse(
    "UPDATE APP100 SET f = 'v' WHERE 担当者 IS NULL"
  ) as UpdateStatement;
  expect(updateToGetQuery(stmt).query).toBe('担当者 = ""');
});

// ----------------------------------------------------------------
// UPDATE 算術式
// ----------------------------------------------------------------

test("算術式 UPDATE を hasArithAssignment が検出する", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 * 1.1 WHERE ステータス = '対象'"
  ) as UpdateStatement;
  expect(hasArithAssignment(stmt)).toBe(true);
});

test("通常 UPDATE は hasArithAssignment が false を返す", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 1000 WHERE $id = 1"
  ) as UpdateStatement;
  expect(hasArithAssignment(stmt)).toBe(false);
});

test("算術式 UPDATE → GET クエリに参照フィールドを含む", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 * 1.1 WHERE ステータス = '対象'"
  ) as UpdateStatement;
  const getParams = updateToGetQueryForArith(stmt);

  expect(getParams.app).toBe(100);
  expect(getParams.fields).toContain("$id");
  expect(getParams.fields).toContain("金額");
});

test("算術式 UPDATE: field * number → 各レコードに計算結果を反映", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 * 2 WHERE $id = 1"
  ) as UpdateStatement;
  const records: KintoneRecord[] = [
    { "$id": { value: "10" }, 金額: { value: "500" } },
    { "$id": { value: "11" }, 金額: { value: "200" } },
  ];
  const batches = updateToPutBatchesArith(stmt, records);

  expect(batches).toHaveLength(1);
  expect(batches[0].records[0]).toEqual({ id: 10, record: { 金額: { value: "1000" } } });
  expect(batches[0].records[1]).toEqual({ id: 11, record: { 金額: { value: "400" } } });
});

test("算術式 UPDATE: field + number", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 + 100 WHERE $id = 1"
  ) as UpdateStatement;
  const records: KintoneRecord[] = [
    { "$id": { value: "1" }, 金額: { value: "900" } },
  ];
  const batches = updateToPutBatchesArith(stmt, records);
  expect(batches[0].records[0].record["金額"].value).toBe("1000");
});

test("算術式 UPDATE: field - number", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 - 50 WHERE $id = 1"
  ) as UpdateStatement;
  const records: KintoneRecord[] = [
    { "$id": { value: "1" }, 金額: { value: "300" } },
  ];
  const batches = updateToPutBatchesArith(stmt, records);
  expect(batches[0].records[0].record["金額"].value).toBe("250");
});

test("算術式 UPDATE: field / number", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 / 2 WHERE $id = 1"
  ) as UpdateStatement;
  const records: KintoneRecord[] = [
    { "$id": { value: "1" }, 金額: { value: "800" } },
  ];
  const batches = updateToPutBatchesArith(stmt, records);
  expect(batches[0].records[0].record["金額"].value).toBe("400");
});

test("算術式 UPDATE: ゼロ除算でエラー", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 / 0 WHERE $id = 1"
  ) as UpdateStatement;
  const records: KintoneRecord[] = [
    { "$id": { value: "1" }, 金額: { value: "100" } },
  ];
  expect(() => updateToPutBatchesArith(stmt, records)).toThrow(DmlConvertError);
});

test("算術式 UPDATE: 数値でないフィールド値でエラー", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 * 2 WHERE $id = 1"
  ) as UpdateStatement;
  const records: KintoneRecord[] = [
    { "$id": { value: "1" }, 金額: { value: "abc" } },
  ];
  expect(() => updateToPutBatchesArith(stmt, records)).toThrow(DmlConvertError);
});

test("算術式と通常代入の混在", () => {
  const stmt = parse(
    "UPDATE APP100 SET 金額 = 金額 * 1.1, 備考 = '値上げ後' WHERE $id = 1"
  ) as UpdateStatement;
  const records: KintoneRecord[] = [
    { "$id": { value: "5" }, 金額: { value: "1000" } },
  ];
  const batches = updateToPutBatchesArith(stmt, records);
  expect(batches[0].records[0].record).toEqual({
    金額: { value: "1100" },
    備考: { value: "値上げ後" },
  });
});

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

test("INSERT で TODAY() を値に使うとエラー", () => {
  // Parser は許容してしまうため、converter レベルでエラー
  // KintoneFunction を手動で組み立ててテスト
  const stmt = {
    type: "INSERT",
    appId: 100,
    fields: ["作成日"],
    values: [[{ type: "KINTONE_FUNC", name: "TODAY" }]],
  } as unknown as InsertStatement;
  expect(() => insertToPostBatches(stmt)).toThrow(DmlConvertError);
});
