import { execute, KintoneClient, SelectResult } from "../execute";

// ----------------------------------------------------------------
// EXPLAIN は API 呼び出しなし — 空クライアントで十分
// ----------------------------------------------------------------

function makeClient(): KintoneClient {
  return {
    async getRecords()  { return { records: [] }; },
    async postRecords() { return { ids: [] }; },
    async putRecords()  { },
    async deleteRecords() { },
    async getApps()     { return []; },
    async getFields()   { return []; },
  };
}

/** plan 列の値を配列で返す */
async function explain(sql: string): Promise<string[]> {
  const client = makeClient();
  const result = await execute(sql, client) as SelectResult;
  expect(result.type).toBe("SELECT");
  expect(result.columns).toEqual(["plan"]);
  return result.rows.map((r) => r["plan"] as string);
}

// ----------------------------------------------------------------
// SIMPLE モード
// ----------------------------------------------------------------

test("EXPLAIN SIMPLE — 基本 SELECT", async () => {
  const plan = await explain("EXPLAIN SELECT 顧客名, 金額 FROM APP100 WHERE ステータス = '完了' ORDER BY 金額 desc LIMIT 10");
  expect(plan.find((l) => l.includes("mode"))).toContain("SIMPLE");
  expect(plan.find((l) => l.includes("kintone query"))).toContain('ステータス = "完了"');
  expect(plan.find((l) => l.includes("fields"))).toContain("顧客名");
  expect(plan.find((l) => l.includes("fields"))).toContain("金額");
});

test("EXPLAIN SIMPLE — WHERE なし", async () => {
  const plan = await explain("EXPLAIN SELECT 顧客名 FROM APP100");
  expect(plan.find((l) => l.includes("mode"))).toContain("SIMPLE");
  expect(plan.find((l) => l.includes("kintone query"))).toContain("(なし)");
});

test("EXPLAIN SIMPLE — SELECT *", async () => {
  const plan = await explain("EXPLAIN SELECT * FROM APP100 WHERE 金額 > 1000");
  expect(plan.find((l) => l.includes("mode"))).toContain("SIMPLE");
  expect(plan.find((l) => l.includes("fields"))).toContain("(全フィールド)");
});

// ----------------------------------------------------------------
// FULL_SCAN モード — 理由別
// ----------------------------------------------------------------

test("EXPLAIN FULL_SCAN — GROUP BY", async () => {
  const plan = await explain("EXPLAIN SELECT 担当者, COUNT(*) FROM APP100 GROUP BY 担当者");
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  const reason = plan.find((l) => l.includes("reason")) ?? "";
  expect(reason).toContain("GROUP BY あり");
  expect(reason).toContain("集計関数");
});

test("EXPLAIN FULL_SCAN — DISTINCT", async () => {
  const plan = await explain("EXPLAIN SELECT DISTINCT 担当者 FROM APP100");
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.find((l) => l.includes("reason"))).toContain("DISTINCT あり");
});

test("EXPLAIN FULL_SCAN — WHERE 関数", async () => {
  const plan = await explain("EXPLAIN SELECT * FROM APP100 WHERE UPPER(顧客名) = 'ABC'");
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.find((l) => l.includes("reason"))).toContain("WHERE 句に JS 評価が必要な式");
});

test("EXPLAIN FULL_SCAN — JOIN", async () => {
  const plan = await explain("EXPLAIN SELECT * FROM APP100 JOIN APP200 ON APP100.顧客ID = APP200.顧客ID");
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.find((l) => l.includes("reason"))).toContain("JOIN あり");
});

test("EXPLAIN FULL_SCAN — JOIN + GROUP BY でテーブル別必要フィールドを表示", async () => {
  const plan = await explain(
    "EXPLAIN SELECT a.顧客ランク AS 顧客ランク, FORMAT(SUM(b.合計費用),'#,##0') AS 合計 FROM APP89 AS a INNER JOIN APP88 AS b ON a.顧客名 = b.顧客名 GROUP BY a.顧客ランク"
  );
  const fieldLines = plan.filter((l) => l.includes("fields:"));
  expect(fieldLines.length).toBeGreaterThanOrEqual(2);
  expect(fieldLines[0]).toContain("顧客名");
  expect(fieldLines[0]).toContain("顧客ランク");
  expect(fieldLines[1]).toContain("顧客名");
  expect(fieldLines[1]).toContain("合計費用");
});

// ----------------------------------------------------------------
// サブクエリ
// ----------------------------------------------------------------

test("EXPLAIN — WHERE スカラーサブクエリ → [subquery:1]", async () => {
  const plan = await explain(
    "EXPLAIN SELECT * FROM APP100 WHERE 金額 > (SELECT AVG(金額) FROM APP100)"
  );
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.find((l) => l.includes("reason"))).toContain("WHERE 句に JS 評価が必要な式");
  expect(plan.some((l) => l.includes("[subquery:1]"))).toBe(true);
  // サブクエリ自身も FULL_SCAN（AVG）
  const subIdx = plan.findIndex((l) => l.includes("[subquery:1]"));
  const subMode = plan.slice(subIdx).find((l) => l.includes("mode")) ?? "";
  expect(subMode).toContain("FULL_SCAN");
});

test("EXPLAIN — SELECT 列スカラーサブクエリ → [subquery:1]", async () => {
  const plan = await explain(
    "EXPLAIN SELECT 顧客名, (SELECT COUNT(*) FROM APP100) AS 総件数 FROM APP100"
  );
  expect(plan.find((l) => l.includes("reason"))).toContain("SELECT 列にスカラーサブクエリ");
  expect(plan.some((l) => l.includes("[subquery:1]"))).toBe(true);
});

test("EXPLAIN — EXISTS → [subquery:1]", async () => {
  const plan = await explain(
    "EXPLAIN SELECT * FROM APP100 WHERE EXISTS (SELECT * FROM APP200 WHERE APP200.顧客ID = '1')"
  );
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.some((l) => l.includes("[subquery:1]"))).toBe(true);
});

// ----------------------------------------------------------------
// UNION
// ----------------------------------------------------------------

test("EXPLAIN UNION — 2 セクション", async () => {
  const plan = await explain(
    "EXPLAIN SELECT 顧客名 FROM APP100 UNION SELECT 顧客名 FROM APP200"
  );
  expect(plan.some((l) => l.includes("[union:1]"))).toBe(true);
  expect(plan.some((l) => l.includes("[union:2]"))).toBe(true);
  // 各セクションに mode 行がある
  expect(plan.filter((l) => l.includes("mode")).length).toBeGreaterThanOrEqual(2);
});

// ----------------------------------------------------------------
// WITH
// ----------------------------------------------------------------

test("EXPLAIN WITH — CTE + main セクション", async () => {
  const plan = await explain(
    "EXPLAIN WITH 対象 AS (SELECT * FROM APP100 WHERE ステータス = '完了') SELECT 顧客名, 金額 FROM 対象"
  );
  expect(plan.some((l) => l.includes("[cte: 対象]"))).toBe(true);
  expect(plan.some((l) => l.includes("[main]"))).toBe(true);
});

// ----------------------------------------------------------------
// エラーケース
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// EXPLAIN INSERT
// ----------------------------------------------------------------

test("EXPLAIN INSERT — 単一行", async () => {
  const plan = await explain(
    "EXPLAIN INSERT INTO APP89 (顧客名, 部署名, 顧客ランク) VALUES ('株式会社テスト', '営業部', 'B')"
  );
  expect(plan.some((l) => l.includes("[INSERT]"))).toBe(true);
  expect(plan.find((l) => l.includes("app:"))).toContain("APP89 (89)");
  expect(plan.find((l) => l.includes("records:"))).toContain("1 件");
  expect(plan.find((l) => l.includes("api:"))).toContain("POST /k/v1/records.json × 1");
  expect(plan.find((l) => l.includes("fields:"))).toContain("顧客名");
});

test("EXPLAIN INSERT — 複数行（バッチ分割）", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => `('顧客${i}', '部署', 'A')`).join(",\n  ");
  const plan = await explain(
    `EXPLAIN INSERT INTO APP89 (顧客名, 部署名, 顧客ランク) VALUES ${rows}`
  );
  expect(plan.find((l) => l.includes("records:"))).toContain("150 件");
  expect(plan.find((l) => l.includes("records:"))).toContain("バッチ 2 回");
  expect(plan.find((l) => l.includes("api:"))).toContain("× 2");
});

test("EXPLAIN INSERT SELECT — SELECT 部分のプランも表示", async () => {
  const plan = await explain(
    "EXPLAIN INSERT INTO APP88 (顧客名, 案件名) SELECT 顧客名, 案件名 FROM APP88 WHERE 確度 in ('0%')"
  );
  expect(plan.some((l) => l.includes("[INSERT SELECT]"))).toBe(true);
  expect(plan.find((l) => l.includes("app:"))).toContain("APP88 (88)");
  expect(plan.some((l) => l.includes("[source SELECT]"))).toBe(true);
  // source SELECT は SIMPLE モード
  const srcIdx = plan.findIndex((l) => l.includes("[source SELECT]"));
  expect(plan.slice(srcIdx).find((l) => l.includes("mode:"))).toContain("SIMPLE");
});

// ----------------------------------------------------------------
// EXPLAIN UPDATE
// ----------------------------------------------------------------

test("EXPLAIN UPDATE — 単純 SET", async () => {
  const plan = await explain(
    "EXPLAIN UPDATE APP89 SET 顧客ランク = 'A' WHERE 顧客名 = '株式会社テスト'"
  );
  expect(plan.some((l) => l.includes("[UPDATE]"))).toBe(true);
  expect(plan.find((l) => l.includes("app:"))).toContain("APP89 (89)");
  expect(plan.find((l) => l.includes("kintone query:"))).toContain("顧客名");
  expect(plan.find((l) => l.includes("api:"))).toContain("GET /k/v1/records.json → PUT");
  expect(plan.find((l) => l.includes("set type:"))).toContain("単純 SET");
  expect(plan.some((l) => l.includes("顧客ランク = 'A'"))).toBe(true);
});

test("EXPLAIN UPDATE — 算術 SET", async () => {
  const plan = await explain(
    "EXPLAIN UPDATE APP88 SET プラン費用 = プラン費用 * 1.1 WHERE 確度 in ('80%', '100%')"
  );
  expect(plan.find((l) => l.includes("set type:"))).toContain("算術 SET");
  expect(plan.find((l) => l.includes("ref fields:"))).toContain("プラン費用");
  expect(plan.some((l) => l.includes("プラン費用 = プラン費用 * 1.1"))).toBe(true);
});

test("EXPLAIN UPDATE — スカラーサブクエリ SET", async () => {
  const plan = await explain(
    "EXPLAIN UPDATE APP88 SET 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%', '100%')"
  );
  expect(plan.find((l) => l.includes("set type:"))).toContain("スカラーサブクエリ SET");
  expect(plan.some((l) => l.includes("上限費用 = (SELECT ...)"))).toBe(true);
  // サブクエリセクションが展開される
  expect(plan.some((l) => l.includes("[subquery: 上限費用]"))).toBe(true);
  const subIdx = plan.findIndex((l) => l.includes("[subquery: 上限費用]"));
  expect(plan.slice(subIdx).find((l) => l.includes("mode:"))).toContain("FULL_SCAN");
});

test("EXPLAIN UPDATE — 算術 SET + スカラーサブクエリ SET の混在", async () => {
  const plan = await explain(
    "EXPLAIN UPDATE APP88 SET 合計費用 = 合計費用 * 1.1, 上限費用 = (SELECT MAX(合計費用) FROM APP88) WHERE 確度 in ('80%', '100%')"
  );
  const setType = plan.find((l) => l.includes("set type:")) ?? "";
  expect(setType).toContain("算術 SET");
  expect(setType).toContain("スカラーサブクエリ SET");
  expect(plan.some((l) => l.includes("[subquery: 上限費用]"))).toBe(true);
});

// ----------------------------------------------------------------
// EXPLAIN DELETE
// ----------------------------------------------------------------

test("EXPLAIN DELETE — 基本", async () => {
  const plan = await explain(
    "EXPLAIN DELETE FROM APP89 WHERE 顧客名 = '株式会社テスト'"
  );
  expect(plan.some((l) => l.includes("[DELETE]"))).toBe(true);
  expect(plan.find((l) => l.includes("app:"))).toContain("APP89 (89)");
  expect(plan.find((l) => l.includes("kintone query:"))).toContain("顧客名");
  expect(plan.find((l) => l.includes("api:"))).toContain("GET /k/v1/records.json → DELETE");
});

test("EXPLAIN DELETE — DROP_DOWN 条件", async () => {
  const plan = await explain(
    "EXPLAIN DELETE FROM APP88 WHERE 確度 in ('0%') AND 受注予定日 < TODAY()"
  );
  const q = plan.find((l) => l.includes("kintone query:")) ?? "";
  expect(q).toContain('確度 in ("0%")');
  expect(q).toContain("受注予定日");
});

// ----------------------------------------------------------------
// EXPLAIN UPSERT
// ----------------------------------------------------------------

test("EXPLAIN UPSERT — VALUES（単一行）", async () => {
  const plan = await explain(
    "EXPLAIN UPSERT INTO APP89 (顧客名, 顧客ランク) VALUES ('株式会社テスト', 'A') ON DUPLICATE (顧客名)"
  );
  expect(plan.some((l) => l.includes("[UPSERT]"))).toBe(true);
  expect(plan.find((l) => l.includes("app:"))).toContain("APP89 (89)");
  expect(plan.find((l) => l.includes("records:"))).toContain("1 件");
  expect(plan.find((l) => l.includes("key fields:"))).toContain("顧客名");
  expect(plan.find((l) => /^\s+fields:/.test(l))).toContain("顧客ランク");
  expect(plan.find((l) => l.includes("api:"))).toContain("POST または PUT");
});

test("EXPLAIN UPSERT SELECT — SELECT 部分のプランも表示", async () => {
  const plan = await explain(
    "EXPLAIN UPSERT INTO APP89 (顧客名, 顧客ランク) SELECT 顧客名, 顧客ランク FROM APP89 WHERE 顧客ランク in ('A') ON DUPLICATE (顧客名)"
  );
  expect(plan.some((l) => l.includes("[UPSERT SELECT]"))).toBe(true);
  expect(plan.find((l) => l.includes("key fields:"))).toContain("顧客名");
  expect(plan.some((l) => l.includes("[source SELECT]"))).toBe(true);
  const srcIdx = plan.findIndex((l) => l.includes("[source SELECT]"));
  expect(plan.slice(srcIdx).find((l) => l.includes("mode:"))).toContain("SIMPLE");
});

// ----------------------------------------------------------------
// EXPLAIN REORDER
// ----------------------------------------------------------------

test("EXPLAIN REORDER — WHERE あり（単一親）", async () => {
  const plan = await explain(
    "EXPLAIN REORDER APP88$明細 BY 金額 asc WHERE _pid = 1"
  );
  expect(plan.some((l) => l.includes("[REORDER]"))).toBe(true);
  expect(plan.find((l) => l.includes("table:"))).toContain("APP88$明細");
  expect(plan.find((l) => l.includes("scope:"))).toContain("WHERE 条件に一致する親レコード対象");
  expect(plan.find((l) => l.includes("by:"))).toContain("金額 ASC");
  expect(plan.find((l) => l.includes("api:"))).toContain("PUT /k/v1/records.json");
});

test("EXPLAIN REORDER ALL — 全件", async () => {
  const plan = await explain(
    "EXPLAIN REORDER ALL APP89$履歴 BY 日付 desc"
  );
  expect(plan.some((l) => l.includes("[REORDER]"))).toBe(true);
  expect(plan.find((l) => l.includes("scope:"))).toContain("全親レコード対象");
  expect(plan.find((l) => l.includes("by:"))).toContain("日付 DESC");
});

// ----------------------------------------------------------------
// エラーケース
// ----------------------------------------------------------------

test("EXPLAIN DML 以外のキーワード — エラー", async () => {
  const client = makeClient();
  await expect(
    execute("EXPLAIN SHOW APPS", client)
  ).rejects.toThrow();
});
