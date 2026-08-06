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
  // 症状は書いた場所で変わるので、原因と代表的な現れ方を書く。
  // 「全行が空」だけだと HAVING で 0 行を見た人が自分の話だと思わない（依頼元の指摘）。
  expect(warning).toContain("値が取れず");
  expect(warning).toContain("HAVING");
  // どこから選べばよいかを名指しする。
  expect(warning).toContain("APP100$テーブル");
  // FROM の差し替えだけでは足りない。$id は仮想テーブルに無く、そのまま書くと
  // 今度は $id が空になる（同じ静かな失敗を繰り返す）。codex レビューの指摘。
  expect(warning).toContain("_pid");
  expect(warning).toContain("_p.<フィールドコード>");
});

test("B145: HAVING では 0 行になる（警告だけが手がかり）", async () => {
  // 依頼元いわく「いちばん怖い形」。0 行は分析では正当な結論に見えるので、
  // 警告を読み飛ばすとそのままレポートに載る。値は変えないが、文面で症状を示す。
  const result = await execute(
    "SELECT 数値, COUNT(*) AS 件数 FROM APP100 GROUP BY 数値 HAVING MAX(数量) > 0",
    makeClient(parentRecords())
  ) as SelectResult;
  expect(result.rows).toEqual([]);
  const warning = (result.warnings ?? []).find((w) => w.includes("数量"));
  expect(warning).toContain("HAVING");
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

test("B145: 明細項目を親の GROUP BY に書くと、存在しない扱いではなく別表を案内する", async () => {
  // 依頼元は「落ちる」と報告し、こちらは「静かに空」と実測した。どちらも正しく、
  // 分かれ目はクエリの形だった（素の射影＝空 / GROUP BY＝エラー）。
  // エラーになる側の文面が unknown field code(s) で「そんな項目は無い」と読めていた。
  await expect(
    execute("SELECT 数量, COUNT(*) AS 件数 FROM APP100 GROUP BY 数量", makeClient(parentRecords()))
  ).rejects.toThrow("数量 はサブテーブル「テーブル」（APP100）の中の項目です");
  await expect(
    execute("SELECT 数量, COUNT(*) AS 件数 FROM APP100 GROUP BY 数量", makeClient(parentRecords()))
  ).rejects.toThrow("APP100$テーブル から集計してください");
  // 案内先はその項目を持つ APP。FROM 側の APP ではない（codex レビュー指摘）。
  await expect(
    execute("SELECT 数量, COUNT(*) AS 件数 FROM APP100 GROUP BY 数量", makeClient(parentRecords()))
  ).rejects.toThrow("（APP100）");
});

test("B145: 本当に存在しない項目は従来どおり unknown field code(s)", async () => {
  await expect(
    execute("SELECT 無い列, COUNT(*) FROM APP100 GROUP BY 無い列", makeClient(parentRecords()))
  ).rejects.toThrow("unknown field code(s): 無い列");
});

test("B145: ROLLUP / CUBE / GROUPING SETS でも同じ案内でエラーになる", async () => {
  // codex の仕様レビュー I3。plain GROUP BY はエラーになるのに、拡張 grouping は
  // 「存在する」と扱われて素通りし、全レコードが空キーの 1 グループへ畳まれた表が
  // 黙って返っていた（実測: 14 レコードが 2 行になる）。plain 側と揃える。
  for (const clause of [
    "ROLLUP(数量)",
    "CUBE(数量)",
    "GROUPING SETS ((数量), ())",
  ]) {
    await expect(
      execute(`SELECT 数量, COUNT(*) AS 件数 FROM APP100 GROUP BY ${clause}`, makeClient(parentRecords()))
    ).rejects.toThrow("数量 はサブテーブル「テーブル」（APP100）の中の項目です");
  }
});

test("B145: GROUPING() の引数に明細項目を書いた場合も同じ案内になる", async () => {
  await expect(
    execute(
      "SELECT 数値, GROUPING(数量) AS g, COUNT(*) FROM APP100 GROUP BY ROLLUP(数値)",
      makeClient(parentRecords())
    )
  ).rejects.toThrow("数量 はサブテーブル「テーブル」（APP100）の中の項目です");
});

test("B145: サブテーブル側の ROLLUP は従来どおり動く（回帰）", async () => {
  const result = await execute(
    "SELECT 数量, COUNT(*) AS 件数 FROM APP100$テーブル GROUP BY ROLLUP(数量)",
    makeClient(parentRecords())
  ) as SelectResult;
  // 明細 1 行 + 総計行。
  expect(result.rows).toEqual([
    { 数量: "5", 件数: "1" },
    { 数量: "", 件数: "1" },
  ]);
});

test("B145: 別名で修飾しても同じ案内になる（codex レビュー R2）", async () => {
  // 修飾すると別経路（grouping resolver の qualified 分岐 / plain の item.name）へ行き、
  // 「存在しない」と言う古い文面に戻っていた。実測で確認して両方を揃えた。
  for (const sql of [
    "SELECT a.数量, COUNT(*) FROM APP100 a GROUP BY ROLLUP(a.数量)",
    "SELECT a.数量, COUNT(*) FROM APP100 a GROUP BY a.数量",
  ]) {
    await expect(execute(sql, makeClient(parentRecords())))
      .rejects.toThrow("サブテーブル「テーブル」（APP100）の中の項目です");
  }
});
