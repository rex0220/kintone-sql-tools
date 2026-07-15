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

test("EXPLAIN FULL_SCAN — LIKE はワイルドカードの有無にかかわらず JS 評価理由を表示", async () => {
  const plan = await explain("EXPLAIN SELECT * FROM APP100 WHERE 件名 LIKE '報告'");
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.find((l) => l.includes("reason"))).toContain("LIKE は常に JS 評価のため全件取得");
});

test("EXPLAIN FULL_SCAN — 単一テーブルの $id 条件だけを確定押し下げ表示する", async () => {
  const plan = await explain(
    "EXPLAIN SELECT $id, 会社名 FROM APP100 WHERE ($id >= 1000 AND 会社名 LIKE '%A%')"
  );
  const query = plan.find((l) => l.includes("kintone query:")) ?? "";
  expect(query).toContain("$id >= 1000");
  expect(query.toLowerCase()).not.toContain("like");
});

test("EXPLAIN FULL_SCAN — エイリアス経路のテキスト等値は押し下げない", async () => {
  const plan = await explain(
    "EXPLAIN SELECT a.$id FROM APP100 AS a WHERE a.状態 = '完了' AND a.会社名 LIKE '%A%'"
  );
  expect(plan.find((l) => l.includes("kintone query:"))).toContain("(全件取得)");
});

test("EXPLAIN FULL_SCAN — 一般数値比較は確定 query と分離して候補表示する", async () => {
  const plan = await explain(
    "EXPLAIN SELECT $id, 金額 FROM APP100 WHERE $id >= 10 AND 金額 > 1000 AND 会社名 LIKE '%A%'"
  );
  const query = plan.find((l) => l.includes("kintone query:")) ?? "";
  const candidate = plan.find((l) => l.includes("pushdown candidate:")) ?? "";
  expect(query).toContain("$id >= 10");
  expect(query).not.toContain("金額");
  expect(candidate).toContain("金額 > 1000");
  expect(candidate).toContain("実行時の型確認待ち");
});

test("EXPLAIN FULL_SCAN — 一般 NUMBER の包含比較は候補表示しない", async () => {
  const plan = await explain(
    "EXPLAIN SELECT $id, 金額 FROM APP100 WHERE 金額 >= 1000 AND 会社名 LIKE '%A%'"
  );
  expect(plan.some((l) => l.includes("pushdown candidate:"))).toBe(false);
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
  expect(plan.find((l) => l.includes("target:"))).toContain("APP89 (89)");
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
  expect(plan.find((l) => l.includes("target:"))).toContain("APP88 (88)");
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
  expect(plan.find((l) => l.includes("target:"))).toContain("APP89 (89)");
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
  expect(plan.find((l) => l.includes("target:"))).toContain("APP89 (89)");
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
  expect(plan.find((l) => l.includes("target:"))).toContain("APP89 (89)");
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

// ----------------------------------------------------------------
// バッチ EXPLAIN（フェーズ2 M3）
// ----------------------------------------------------------------

import { buildBatchExplainPlans } from "../execute";

test("バッチ EXPLAIN: CREATE TEMP TABLE のプラン（スコープ・行数不明・内側の SELECT プラン）", () => {
  const plans = buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100 WHERE 売上 > 100;" +
    "SELECT 顧客名 FROM #t"
  );
  expect(plans.statementCount).toBe(2);

  const create = plans.statements[0];
  expect(create.type).toBe("CREATE_TEMP_TABLE");
  expect(create.plan[0]).toBe("CREATE TEMP TABLE #t");
  expect(create.plan.join("\n")).toMatch(/scope:\s+batch/);
  expect(create.plan.join("\n")).toMatch(/実体化前のため不明/);
  // 上限は既定値であること（tempTableMaxRows で変更可）を明示する。静的プランは
  // 実行時オプションを知らないため実効値ではなく「既定上限」と表示する
  expect(create.plan.join("\n")).toMatch(/既定上限 10000 行、tempTableMaxRows で変更可、超過はエラー/);
  expect(create.plan.join("\n")).toMatch(/mode:\s+SIMPLE/); // 内側 SELECT のプラン
});

test("バッチ EXPLAIN: 一時テーブル参照文は FULL_SCAN と行数不明を明示", () => {
  const plans = buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "SELECT a.顧客名 FROM APP200 a INNER JOIN #t b ON a.顧客名 = b.顧客名"
  );
  const select = plans.statements[1];
  const text = select.plan.join("\n");
  expect(text).toMatch(/mode:\s+FULL_SCAN（一時テーブル参照）/);
  expect(text).toMatch(/temp:\s+#t（インメモリ走査。実体化前のため行数不明）/);
  expect(text).toMatch(/APP200/);
  expect(text).toMatch(/WHERE プッシュダウンは行われない/);
});

test("バッチ EXPLAIN: 一時テーブルソースの UPSERT_SELECT はヘッダ行 + FULL_SCAN を明示（v1.7.0）", () => {
  const plans = buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "UPSERT INTO APP400 (顧客名) SELECT 顧客名 FROM #t ON DUPLICATE (顧客名)"
  );
  const upsert = plans.statements[1];
  const text = upsert.plan.join("\n");
  expect(upsert.type).toBe("UPSERT_SELECT");
  expect(text).toMatch(/UPSERT INTO APP400 \.\.\. SELECT（一時テーブルソース。照合後に insert \+ update 合計確定 → dmlMaxRows 適用）/);
  expect(text).toMatch(/mode:\s+FULL_SCAN（一時テーブル参照）/);
  expect(text).not.toMatch(/app:\s+.*APP400/); // 書き込み先アプリはソース一覧から除外
});

test("バッチ EXPLAIN: 一時テーブル無関係の文は既存プラン、DROP は解放のみ", () => {
  const plans = buildBatchExplainPlans(
    "SELECT 顧客名 FROM APP100;" +
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "DROP TEMP TABLE #t"
  );
  expect(plans.statements[0].plan.join("\n")).toMatch(/mode:\s+SIMPLE/);
  expect(plans.statements[2].type).toBe("DROP_TEMP_TABLE");
  expect(plans.statements[2].plan.join("\n")).toMatch(/kintone アクセスなし/);
});

test("バッチ EXPLAIN: temp ソースの INSERT_SELECT は件数確定と dmlMaxRows 適用を明示", () => {
  const plans = buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #t"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toMatch(/INSERT INTO APP200/);
  expect(text).toMatch(/実行時に件数確定 → dmlMaxRows 適用/);
  expect(text).not.toMatch(/app:\s+.*APP200/); // 書き込み先は app 行に混ぜない
});

test("バッチ EXPLAIN: 静的検証違反（未定義参照）は拒否される", () => {
  expect(() => buildBatchExplainPlans("SELECT 1 FROM APP100; SELECT * FROM #t"))
    .toThrow(/temp table #t is not defined in this batch/);
});

// ----------------------------------------------------------------
// バッチ EXPLAIN: ASSERT（バッチ強化第1弾 A4）
// ----------------------------------------------------------------

test("バッチ EXPLAIN: ASSERT はサブクエリのプラン + 実行時評価の注記を表示", () => {
  const plans = buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500"
  );
  const assert = plans.statements[1];
  expect(assert.type).toBe("ASSERT");
  const text = assert.plan.join("\n");
  expect(assert.plan[0]).toBe("ASSERT (SELECT COUNT(*) FROM #t) BETWEEN 1 AND 500");
  expect(text).toMatch(/実行時に条件評価/);
  expect(text).toMatch(/AssertError でバッチ停止/);
  expect(text).toMatch(/subquery:/);
  expect(text).toMatch(/mode:\s+FULL_SCAN（一時テーブル参照）/);
});

test("バッチ EXPLAIN: ASSERT の APP 参照サブクエリは通常プラン（FULL_SCAN 表示にしない）", () => {
  const plans = buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM APP200) = 0"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toMatch(/subquery:/);
  expect(text).not.toMatch(/一時テーブル参照/);
  expect(text).toMatch(/APP200/);
});

test("バッチ EXPLAIN: リテラルのみの ASSERT はサブクエリ行を持たない", () => {
  const plans = buildBatchExplainPlans("SELECT 顧客名 FROM APP100; ASSERT 1 = 1");
  const text = plans.statements[1].plan.join("\n");
  expect(plans.statements[1].type).toBe("ASSERT");
  expect(text).toMatch(/実行時に条件評価/);
  expect(text).not.toMatch(/subquery/);
});

test("バッチ EXPLAIN: SET と後続の変数参照を実行せずに計画化できる", () => {
  const plans = buildBatchExplainPlans(
    "SET @min = 10; SELECT 顧客名 FROM APP100 WHERE 売上 > @min"
  );
  expect(plans.statements[0]).toMatchObject({
    type: "SET_VARIABLE",
    plan: expect.arrayContaining([expect.stringContaining("SET @min")]),
  });
  expect(plans.statements[1].plan.join("\n")).toContain("@min");
});

test("バッチ EXPLAIN: SET の APP スカラーサブクエリ計画と1回評価を表示する", () => {
  const plans = buildBatchExplainPlans(
    "SET @cnt = (SELECT COUNT(*) FROM APP8201); ASSERT @cnt >= 0"
  );
  const set = plans.statements[0];
  const text = set.plan.join("\n");
  expect(set.type).toBe("SET_VARIABLE");
  expect(set.plan[0]).toBe("SET @cnt = (SELECT ...)");
  expect(text).toMatch(/実行時に1回評価/);
  expect(text).toMatch(/subquery:/);
  expect(text).toMatch(/APP8201/);
});

test("バッチ EXPLAIN: SET の一時テーブル参照を FULL_SCAN 計画で表示する", () => {
  const plans = buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP8202;" +
    "SET @cnt = (SELECT COUNT(*) FROM #t); ASSERT @cnt >= 0"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toMatch(/subquery:/);
  expect(text).toMatch(/mode:\s+FULL_SCAN（一時テーブル参照）/);
  expect(text).toMatch(/temp:\s+#t/);
});

test("バッチ EXPLAIN: SET サブクエリ内の先行変数をプレースホルダー解決する", () => {
  const plans = buildBatchExplainPlans(
    "SET @target = 1;" +
    "SET @amount = (SELECT 売上 FROM APP8203 WHERE $id = @target LIMIT 1);" +
    "ASSERT @amount >= 0"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toContain("@target");
  expect(text).not.toMatch(/variable @target is not defined/);
});
