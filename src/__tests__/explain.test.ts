import {
  execute,
  KintoneClient,
  resolveBatchVariableReferences,
  SelectResult,
} from "../execute";
import { Lexer } from "../lexer/lexer";
import { Parser } from "../parser/parser";

// ----------------------------------------------------------------
// EXPLAIN は schema-aware planner として form metadata のみ読む。
// ----------------------------------------------------------------

function makeClient(): KintoneClient {
  return {
    async getRecords()  { return { records: [] }; },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords()  { },
    async deleteRecords() { },
    async getApps()     { return []; },
    async getFields() {
      const numberFields = ["金額", "売上", "数量", "合計費用", "上限費用", "案件No", "顧客No"];
      const dateFields = ["登録日", "作成日", "受注予定日"];
      const optionFields = ["選択", "確度", "顧客ランク"];
      const textFields = [
        "顧客名", "顧客ID", "会社名", "担当者", "件名", "郵便番号", "値", "フラグ", "名前", "備考", "状態",
      ];
      return [
        ...numberFields.map((code) => ({ code, label: code, fieldType: "NUMBER" })),
        ...dateFields.map((code) => ({ code, label: code, fieldType: "DATE" })),
        ...optionFields.map((code) => ({ code, label: code, fieldType: "DROP_DOWN" })),
        ...textFields.map((code) => ({ code, label: code, fieldType: "SINGLE_LINE_TEXT" })),
        { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
        { code: "利用者", label: "利用者", fieldType: "USER_SELECT" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
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

test("B44 Phase 5: UPDATE APPLY EXPLAIN は固定順の静的planだけを返し records/mutation API 0", async () => {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const putRecords = jest.fn(async () => undefined);
  const getFields = jest.fn(async () => [
    { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
    { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
    { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
  ]);
  const client: KintoneClient = {
    ...makeClient(), getRecords, putRecords, getFields,
  };
  const result = await execute(
    "EXPLAIN UPDATE APP4221 SET 親='after' WHERE $id=8 " +
      "APPLY テーブル (PATCH SET 子='x' WHERE 子='old')",
    client,
    { cacheContext: "apply-explain", dmlMaxRows: 7, dmlMaxSubtableRows: 9 }
  ) as SelectResult;
  const plan = result.rows.map((row) => row.plan);
  const expected = [
    "statement:              UPDATE APPLY",
    "target app:             APP4221",
    "parent selector:        $id = 8",
    "parent cardinality:     single",
    "apply target:           テーブル (SUBTABLE)",
    "operations:             PATCH",
    "selector:               SAFE_PREDICATE",
    "snapshot evaluation:    yes",
    "inserted rows visible:  no",
    "revision guard:         required",
    "revision:               unknown (records API not called)",
    "payload preservation:   row ids=yes, row order=yes, unpatched cells=yes, remove tables=none",
    "post-image validation:  required (B43 equivalent)",
    "parent rows:            unknown (records API not called)",
    "matched subtable rows:  unknown (records API not called)",
    "validation errors:      unknown (records API not called)",
    "deleted rows:           0 (static without REMOVE)",
    "dmlMaxRows:             7",
    "dmlMaxSubtableRows:     9",
    "MCP mutation:           disabled in v1",
    "records API:            0",
    "mutation API:           0",
  ];
  expect(plan.filter((line) => expected.includes(line))).toEqual(expected);
  expect(getFields).toHaveBeenCalledWith(4221);
  expect(getRecords).not.toHaveBeenCalled();
  expect(putRecords).not.toHaveBeenCalled();
  expect(plan.join("\n")).not.toMatch(/revision:\s+\d|matched subtable rows:\s+\d/);

  const remove = await execute(
    "EXPLAIN UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (REMOVE ALL ROWS)",
    client,
    { cacheContext: "apply-remove-explain" }
  ) as SelectResult;
  expect(remove.rows.map((row) => row.plan)).toEqual(expect.arrayContaining([
    "operations:             REMOVE",
    "payload preservation:   row ids=yes, row order=yes, unpatched cells=yes, remove tables=FULL_SURVIVORS",
    "deleted rows:           unknown (records API not called)",
  ]));
  expect(getRecords).not.toHaveBeenCalled();
  expect(putRecords).not.toHaveBeenCalled();
});

test("B47-P3: UPDATE APPLY EXPLAINはselection planとfail-closed契約をrecords API 0で表示する", async () => {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const client: KintoneClient = {
    ...makeClient(),
    getRecords,
    getFields: async () => [
      { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
      { code: "金額", label: "金額", fieldType: "NUMBER", writable: true },
      { code: "タイトル", label: "タイトル", fieldType: "SINGLE_LINE_TEXT", writable: true },
      { code: "説明", label: "説明", fieldType: "MULTI_LINE_TEXT", writable: true },
      { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
      { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
    ],
  };
  const result = await execute(
    "EXPLAIN UPDATE APP4221 SET 親='after' WHERE 金額 > 0 AND 説明 KLIKE '至急' AND タイトル LIKE 'B44%' "
      + "APPLY テーブル (PATCH SET 子='x' ALL ROWS)",
    client,
    { cacheContext: "b47-p3-explain", maxRecords: 321, dmlMaxRows: 7 }
  ) as SelectResult;
  const plan = result.rows.map((row) => row.plan);

  expect(plan).toEqual(expect.arrayContaining([
    "parent cardinality:     multiple",
    "parent selection:       safe prefilter + JS residual evaluation",
    'kintone prefilter:      金額 > 0 and 説明 like "至急"',
    "JS residual:            original parent WHERE",
    "applied KLIKE:          1",
    "unapplied KLIKE:        0",
    "candidate limit:        maxRecords=321, onLimit=error, stopAfter=none",
    "target guard:           dmlMaxRows=7 after JS residual evaluation",
    "search abort:           DML fail-closed (B7-P3; all surfaces, no surface gate)",
    "records API:            0",
    "mutation API:           0",
  ]));
  expect(getRecords).not.toHaveBeenCalled();
});

test("B47-P3: UPDATE APPLY EXPLAINはunapplied KLIKE件数とunsupported理由をAPI 0で表示する", async () => {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const client: KintoneClient = {
    ...makeClient(), getRecords,
    getFields: async () => [
      { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
      { code: "説明", label: "説明", fieldType: "MULTI_LINE_TEXT", writable: true },
      { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
      { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
    ],
  };
  const result = await execute(
    "EXPLAIN UPDATE APP4221 SET 親='after' WHERE NOT (説明 KLIKE '至急') APPLY テーブル (PATCH SET 子='x' ALL ROWS)",
    client,
    { cacheContext: "b47-p3-explain-unapplied" }
  ) as SelectResult;
  expect(result.rows.map((row) => row.plan)).toEqual(expect.arrayContaining([
    "kintone prefilter:      (none; empty query)",
    "applied KLIKE:          0",
    "unapplied KLIKE:        1 (unsupported: cannot be fully applied to native query)",
  ]));
  expect(getRecords).not.toHaveBeenCalled();
});

test.each([
  [
    "INSERT",
    "EXPLAIN INSERT INTO APP4221 (親) VALUES ('a'), ('b') APPLY テーブル (APPEND (子) VALUES ('x'))",
    ["apply diagnostic:       INSERT", "apply branch:           insert", "  parent rows:          2",
      "  chunks:               1 × max 100", "    operations:         APPEND=2"],
  ],
  [
    "UPSERT",
    "EXPLAIN UPSERT INTO APP4221 (親) VALUES ('a'), ('b') ON DUPLICATE (親) "
      + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('x')) ON UPDATE APPLY タグ (ADD 'A'; REMOVE 'B')",
    ["apply diagnostic:       UPSERT", "apply branch:           insert", "apply branch:           update",
      "  parent rows:          unknown (records API not called)", "    operations:         ADD=unknown | REMOVE_VALUE=unknown"],
  ],
] as const)("Phase 16a: %s APPLY EXPLAINはshared静的診断とAPI 0を返す", async (_kind, sql, expected) => {
  const getRecords = jest.fn(async () => ({ records: [] }));
  const postRecords = jest.fn(async () => ({ ids: [] }));
  const putRecords = jest.fn(async () => undefined);
  const client: KintoneClient = {
    ...makeClient(), getRecords, postRecords, putRecords,
    getFields: async () => [
      { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
      { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
      { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
      { code: "タグ", label: "タグ", fieldType: "MULTI_SELECT", writable: true },
    ],
  };
  const result = await execute(sql, client, { cacheContext: `phase16a-explain-${_kind}` }) as SelectResult;
  const plan = result.rows.map((row) => row.plan);
  expect(plan).toEqual(expect.arrayContaining([
    ...expected,
    "non-transactional:      true",
    "partial success:        possible",
    "records API:            0",
    "mutation API:           0",
  ]));
  expect(getRecords).not.toHaveBeenCalled();
  expect(postRecords).not.toHaveBeenCalled();
  expect(putRecords).not.toHaveBeenCalled();
});

// ----------------------------------------------------------------
// SIMPLE モード
// ----------------------------------------------------------------

test("EXPLAIN canonical local — allowlist外 ORDER BY は REST 窓を表示しない", async () => {
  const plan = await explain("EXPLAIN SELECT 顧客名, 金額 FROM APP100 WHERE ステータス = '完了' ORDER BY 金額 desc LIMIT 10");
  expect(plan.find((l) => l.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.find((l) => l.includes("order plan"))).toContain("CANONICAL_LOCAL");
  expect(plan.find((l) => l.includes("kintone query"))).toContain('ステータス = "完了"');
  expect(plan.find((l) => l.includes("fields"))).toContain("顧客名");
  expect(plan.find((l) => l.includes("fields"))).toContain("金額");
  expect(plan.find((l) => l.includes("complete input"))).toContain("onLimit=truncate disabled");
});

test("EXPLAIN canonical REST top-N — $id exact window を表示する", async () => {
  const plan = await explain("EXPLAIN SELECT $id FROM APP100 WHERE $id > 0 ORDER BY $id DESC LIMIT 5");
  expect(plan.find((l) => l.includes("order plan"))).toContain("CANONICAL_REST_TOP_N");
  expect(plan.find((l) => l.includes("kintone query"))).toContain("order by $id desc limit 5");
  expect(plan.some((line) => line.includes("complete input"))).toBe(false);
});

test("B31: EXPLAIN KORDER BY は native plan とそのままの REST query を表示する", async () => {
  const plan = await explain(
    "EXPLAIN SELECT 金額 FROM APP100 WHERE 金額 > 0 KORDER BY 金額 DESC, $id ASC LIMIT 5 OFFSET 2"
  );
  expect(plan.find((line) => line.includes("mode"))).toContain("SIMPLE");
  expect(plan.find((line) => line.includes("order plan"))).toContain("KORDER_NATIVE");
  expect(plan.find((line) => line.includes("kintone query")))
    .toContain("order by 金額 desc, $id asc limit 5 offset 2");
  expect(plan.some((line) => line.includes("complete input"))).toBe(false);
  expect(plan.find((line) => line.includes("order semantics")))
    .toContain("kintone native (not kSQL canonical)");
  expect(plan.find((line) => line.includes("REST execution"))).toContain("single GET");
});

test.each([0, 1])("B31: EXPLAIN も native allowlist 外を LIMIT %i で同じく拒否する", async (limit) => {
  await expect(explain(
    `EXPLAIN SELECT $id FROM APP100 KORDER BY 利用者 LIMIT ${limit}`
  )).rejects.toThrow(/KORDER_TYPE_UNSUPPORTED/);
});

test("B33: EXPLAIN も実行時 maxRecords を使って cursor scanRows を検査する", async () => {
  const client = makeClient();
  await expect(execute(
    "EXPLAIN SELECT $id FROM APP100 KORDER BY $id LIMIT 500",
    client,
    { maxRecords: 100 }
  )).rejects.toThrow(/KORDER_SCAN_ROWS_EXCEEDS_MAX_RECORDS/);
});

test("B33: EXPLAIN KORDER_CURSOR はcursor APIとscanRowsを表示しLIMIT/OFFSETをqueryへ入れない", async () => {
  const plan = await explain(
    "EXPLAIN SELECT $id FROM APP100 KORDER BY $id LIMIT 501 OFFSET 2"
  );
  expect(plan.find((line) => line.includes("order plan"))).toContain("KORDER_CURSOR");
  expect(plan.find((line) => line.includes("fetch API"))).toContain("records/cursor.json");
  expect(plan.find((line) => line.includes("scan rows"))).toContain("503");
  expect(plan.find((line) => line.includes("cursor concurrency"))).toContain("2 per domain (process-local)");
  expect(plan.find((line) => line.includes("kintone query"))).toContain("order by $id asc");
  expect(plan.find((line) => line.includes("kintone query"))).not.toMatch(/limit|offset/i);
});

test("B33: EXPLAINは実行surfaceで解決したcursorMaxActiveを表示する", async () => {
  const result = await execute(
    "EXPLAIN SELECT $id FROM APP100 KORDER BY $id LIMIT 501",
    makeClient(),
    { maxRecords: 501, cursorMaxActive: 5 }
  ) as SelectResult;
  expect(result.rows.map((row) => String(row.plan)).find((line) => line.includes("cursor concurrency")))
    .toContain("5 per domain (process-local)");
});

test("B31: EXPLAIN STATUS KORDER BY は process status metadata に依存しない", async () => {
  const plan = await explain(
    "EXPLAIN SELECT ステータス FROM APP100 KORDER BY ステータス LIMIT 1"
  );
  expect(plan.find((line) => line.includes("order plan"))).toContain("KORDER_NATIVE");
  expect(plan.some((line) => line.includes("metadata API: process status"))).toBe(false);
});

test("EXPLAIN は unsupported ORDER key を行数に依存せず拒否する", async () => {
  await expect(explain("EXPLAIN SELECT $id FROM APP100 ORDER BY 利用者 LIMIT 1"))
    .rejects.toThrow(/ORDER_KEY_UNSUPPORTED/);
  await expect(explain("EXPLAIN SELECT RANK() OVER (ORDER BY 利用者) AS r FROM APP100"))
    .rejects.toThrow(/ORDER_KEY_UNSUPPORTED/);
});

test("EXPLAIN ORDER BY なし — complete input 要件を表示しない", async () => {
  const plan = await explain("EXPLAIN SELECT 顧客名 FROM APP100");
  expect(plan.some((line) => line.includes("complete input"))).toBe(false);
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

test("B32: EXPLAIN は SINGLE_LINE_TEXT 範囲比較を schema-aware FULL_SCAN と表示する", async () => {
  const plan = await explain("EXPLAIN SELECT 郵便番号 FROM APP100 WHERE 郵便番号 > '100' LIMIT 5");
  expect(plan.find((line) => line.includes("mode"))).toContain("FULL_SCAN");
  expect(plan.some((line) => line.includes("WHERE_RESIDUAL"))).toBe(true);
  expect(plan.some((line) => line.includes("郵便番号 >"))).toBe(false);
  expect(plan.some((line) => line.includes("metadata API: form definition APP100"))).toBe(true);
});

test("B32: DML EXPLAIN も実行と同じ capability error で拒否する", async () => {
  await expect(explain(
    "EXPLAIN UPDATE APP100 SET 郵便番号 = '200' WHERE 郵便番号 > '100'"
  )).rejects.toThrow(/cannot be represented by kintone REST/);
});

test("EXPLAIN STATUS ORDER BY は status metadata API 依存を表示する", async () => {
  const plan = await explain("EXPLAIN SELECT ステータス FROM APP100 ORDER BY ステータス");
  expect(plan.some((line) => line.includes("metadata API: process status APP100"))).toBe(true);
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
  expect(candidate).toContain("実行時の型・実在確認待ち");
});

test("EXPLAIN FULL_SCAN — 選択系 IN は実行時確認前の候補として分離表示する", async () => {
  const plan = await explain(
    "EXPLAIN SELECT $id FROM APP100 WHERE 選択 IN ('A', 'B') AND 件名 LIKE '%'"
  );
  const query = plan.find((l) => l.includes("kintone query:")) ?? "";
  const candidate = plan.find((l) => l.includes("pushdown candidate:")) ?? "";
  expect(query).toContain("(全件取得)");
  expect(candidate).toContain('選択 in ("A","B")');
  expect(candidate).toContain("実行時の型・実在確認待ち");
});

test("EXPLAIN FULL_SCAN — STATUS IN をmetadata解決後に候補表示する", async () => {
  const plan = await explain(
    "EXPLAIN SELECT $id FROM APP100 WHERE ステータス IN ('処理中') AND 件名 LIKE '%'"
  );
  const candidate = plan.find((l) => l.includes("pushdown candidate:")) ?? "";
  expect(candidate).toContain('ステータス in ("処理中")');
  expect(candidate).toContain("実行時の型・実在確認待ち");
});

test.each([
  "選択 IN (1)",
  "選択 IN ('A', 1)",
  "選択 IN ('')",
  "選択 IN (SELECT 値 FROM APP101)",
])("EXPLAIN FULL_SCAN — 選択系候補にならない形: %s", async (predicate) => {
  const plan = await explain(
    `EXPLAIN SELECT $id FROM APP100 WHERE ${predicate} AND 件名 LIKE '%'`
  );
  expect(plan.some((l) => l.includes("pushdown candidate:"))).toBe(false);
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

test.each(["_pid = 1", "_rid = 'r1'", "_idx > 2"])(
  "B45: EXPLAIN サブテーブル system 列は FULL_SCAN かつ押し下げ候補外: %s",
  async (predicate) => {
    const plan = await explain(`EXPLAIN SELECT _rid FROM APP100$明細 WHERE ${predicate}`);
    expect(plan.find((line) => line.includes("mode"))).toContain("FULL_SCAN");
    expect(plan.find((line) => line.includes("reason"))).toContain("サブテーブル仮想テーブル");
    expect(plan.find((line) => line.includes("kintone query:"))).toContain("(全件取得)");
    expect(plan.some((line) => line.includes("pushdown candidate:"))).toBe(false);
  }
);

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

test("EXPLAIN UPDATE FROM — 業務キー結合を表示", async () => {
  const plan = await explain(
    "EXPLAIN UPDATE APP88 SET 顧客名 = s.顧客名 FROM APP89 s WHERE APP88.顧客コード = s.顧客コード"
  );
  expect(plan.some((l) => l.includes("[UPDATE FROM]"))).toBe(true);
  expect(plan.find((l) => l.includes("join:"))).toContain("APP88.顧客コード = s.顧客コード");
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

import { buildBatchExplainPlans as buildBatchExplainPlansCore } from "../execute";

async function buildBatchExplainPlans(
  sql: string,
  variables?: Readonly<Record<string, string>>
) {
  return buildBatchExplainPlansCore(sql, makeClient(), variables, "explain-test-batch");
}

test("B3: バッチ EXPLAIN は配列 SET を実値評価して空配列を実行同様に簡約する", async () => {
  const plans = await buildBatchExplainPlans(
    "SET @e=[]; SELECT 顧客名 FROM APP100 WHERE 顧客名 IN @e"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toMatch(/constant false/);
  expect(text).toMatch(/records API access: none/);
  expect(text).not.toMatch(/in \(\)|not in \(\)/i);

  await expect(buildBatchExplainPlans(
    "SET @e=[]; DELETE FROM APP100 WHERE 顧客名 NOT IN @e"
  )).rejects.toThrow(/always true/);
});

test("バッチ EXPLAIN: CREATE TEMP TABLE のプラン（スコープ・行数不明・内側の SELECT プラン）", async () => {
  const plans = await buildBatchExplainPlans(
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

test("B31: バッチ EXPLAIN も実行時 maxRecords で KORDER window を検査する", async () => {
  await expect(buildBatchExplainPlansCore(
    "SELECT $id FROM APP100 KORDER BY $id LIMIT 500; SELECT $id FROM APP100 LIMIT 1",
    makeClient(),
    undefined,
    "explain-test-korder-max",
    100
  )).rejects.toThrow(/KORDER_SCAN_ROWS_EXCEEDS_MAX_RECORDS/);
});

test("バッチ EXPLAIN: 一時テーブル参照文は FULL_SCAN と行数不明を明示", async () => {
  const plans = await buildBatchExplainPlans(
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

test("バッチ EXPLAIN: 一時テーブルソースの UPSERT_SELECT はヘッダ行 + FULL_SCAN を明示（v1.7.0）", async () => {
  const plans = await buildBatchExplainPlans(
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

test("バッチ EXPLAIN: 一時テーブル無関係の文は既存プラン、DROP は解放のみ", async () => {
  const plans = await buildBatchExplainPlans(
    "SELECT 顧客名 FROM APP100;" +
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "DROP TEMP TABLE #t"
  );
  expect(plans.statements[0].plan.join("\n")).toMatch(/mode:\s+SIMPLE/);
  expect(plans.statements[2].type).toBe("DROP_TEMP_TABLE");
  expect(plans.statements[2].plan.join("\n")).toMatch(/kintone アクセスなし/);
});

test("バッチ EXPLAIN: temp ソースの INSERT_SELECT は件数確定と dmlMaxRows 適用を明示", async () => {
  const plans = await buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP100;" +
    "INSERT INTO APP200 (名前) SELECT 顧客名 FROM #t"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toMatch(/INSERT INTO APP200/);
  expect(text).toMatch(/実行時に件数確定 → dmlMaxRows 適用/);
  expect(text).not.toMatch(/app:\s+.*APP200/); // 書き込み先は app 行に混ぜない
});

test("バッチ EXPLAIN: 静的検証違反（未定義参照）は拒否される", async () => {
  await expect(buildBatchExplainPlans("SELECT 1 FROM APP100; SELECT * FROM #t"))
    .rejects.toThrow(/temp table #t is not defined in this batch/);
});

// ----------------------------------------------------------------
// バッチ EXPLAIN: ASSERT（バッチ強化第1弾 A4）
// ----------------------------------------------------------------

test("バッチ EXPLAIN: ASSERT はサブクエリのプラン + 実行時評価の注記を表示", async () => {
  const plans = await buildBatchExplainPlans(
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

test("バッチ EXPLAIN: ASSERT の APP 参照サブクエリは通常プラン（FULL_SCAN 表示にしない）", async () => {
  const plans = await buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP100;" +
    "ASSERT (SELECT COUNT(*) FROM APP200) = 0"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toMatch(/subquery:/);
  expect(text).not.toMatch(/一時テーブル参照/);
  expect(text).toMatch(/APP200/);
});

test("バッチ EXPLAIN: リテラルのみの ASSERT はサブクエリ行を持たない", async () => {
  const plans = await buildBatchExplainPlans("SELECT 顧客名 FROM APP100; ASSERT 1 = 1");
  const text = plans.statements[1].plan.join("\n");
  expect(plans.statements[1].type).toBe("ASSERT");
  expect(text).toMatch(/実行時に条件評価/);
  expect(text).not.toMatch(/subquery/);
});

test("バッチ EXPLAIN: SET と後続の変数参照を実行せずに計画化できる", async () => {
  const plans = await buildBatchExplainPlans(
    "SET @min = 10; SELECT 顧客名 FROM APP100 WHERE 売上 > @min"
  );
  expect(plans.statements[0]).toMatchObject({
    type: "SET_VARIABLE",
    plan: expect.arrayContaining([expect.stringContaining("SET @min")]),
  });
  expect(plans.statements[1].plan.join("\n")).toContain("@min");
});

test.each([
  ["直接算術", "(顧客No * 100) / @total AS 構成比"],
  ["ROUND", "ROUND(顧客No * 100 / @total, 1) AS 構成比"],
] as const)("B92: バッチ EXPLAIN は変数を使う%sを式非表示の既存計画で受理する", async (_label, expression) => {
  const plans = await buildBatchExplainPlans(
    "CREATE TEMP TABLE #g AS SELECT 案件No, 顧客No FROM APP4147;" +
      "SET @total = (SELECT SUM(顧客No) FROM #g);" +
      `SELECT 案件No, ${expression} FROM #g`
  );
  expect(plans.statements[2].plan).toEqual([
    "  mode:          FULL_SCAN（一時テーブル参照）",
    "  temp:          #g（インメモリ走査。実体化前のため行数不明）",
    "  note:          一時テーブルへの WHERE プッシュダウンは行われない",
  ]);
});

test.each([
  ["直接算術", "(顧客No * 100) / @total AS 構成比"],
  ["ROUND", "ROUND(顧客No * 100 / @total, 1) AS 構成比"],
] as const)("B92: 算術プレースホルダーの数値ノードは raw に変数名を保持する（%s）", (_label, expression) => {
  const [statement] = new Parser(
    new Lexer(`SELECT 案件No, ${expression} FROM #g`).tokenize()
  ).parseStatements();
  const resolved = resolveBatchVariableReferences(
    statement,
    new Map([[
      "total",
      { type: "string" as const, value: "@total", placeholder: true as const },
    ]])
  );
  const placeholderNodes: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (record["raw"] === "@total") placeholderNodes.push(record);
      Object.values(record).forEach(visit);
    }
  };
  visit(resolved);
  expect(placeholderNodes).toEqual([
    { type: "NUMBER", value: 0, raw: "@total" },
  ]);
});

test("B92: 算術外の文字列プレースホルダーは文字列リテラルと同じ計画を維持する", async () => {
  const placeholder = await buildBatchExplainPlans(
    "DECLARE @phase = '受注'; SELECT $id FROM APP100 WHERE 状態 = @phase"
  );
  const literal = await buildBatchExplainPlans(
    "SELECT $id FROM APP100 WHERE 状態 = '@phase'"
  );
  expect(placeholder.statements[1].plan).toEqual(literal.statements[0].plan);
});

test("バッチ EXPLAIN: 選択系 IN の文字列変数を候補表示し、値は実行しない", async () => {
  const plans = await buildBatchExplainPlans(
    "DECLARE @choice = 'A'; " +
      "SELECT $id FROM APP100 WHERE 選択 IN (@choice) AND 件名 LIKE '%'",
    { choice: "secret-option" }
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toContain("pushdown candidate:");
  expect(text).toContain('選択 in ("@choice")');
  expect(text).not.toContain("secret-option");
});

test("バッチ EXPLAIN: SET の APP スカラーサブクエリ計画と1回評価を表示する", async () => {
  const plans = await buildBatchExplainPlans(
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

test("バッチ EXPLAIN: SET の一時テーブル参照を FULL_SCAN 計画で表示する", async () => {
  const plans = await buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT $id FROM APP8202;" +
    "SET @cnt = (SELECT COUNT(*) FROM #t); ASSERT @cnt >= 0"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toMatch(/subquery:/);
  expect(text).toMatch(/mode:\s+FULL_SCAN（一時テーブル参照）/);
  expect(text).toMatch(/temp:\s+#t/);
});

test("バッチ EXPLAIN: SET サブクエリ内の先行変数をプレースホルダー解決する", async () => {
  const plans = await buildBatchExplainPlans(
    "SET @target = 1;" +
    "SET @amount = (SELECT 売上 FROM APP8203 WHERE $id = @target LIMIT 1);" +
    "ASSERT @amount >= 0"
  );
  const text = plans.statements[1].plan.join("\n");
  expect(text).toContain("@target");
  expect(text).not.toMatch(/variable @target is not defined/);
});

test("バッチ EXPLAIN: DECLARE は値を表示せず、注入名を事前照合する", async () => {
  const plans = await buildBatchExplainPlans(
    "DECLARE @since = '2026-01-01'; SELECT * FROM APP100 WHERE 登録日 >= @since",
    { Since: "secret-value" }
  );
  const text = plans.statements[0].plan.join("\n");
  expect(plans.statements[0].type).toBe("DECLARE_VARIABLE");
  expect(text).toContain("DECLARE @since");
  expect(text).not.toContain("secret-value");
  await expect(buildBatchExplainPlans(
    "DECLARE @since = '2026-01-01'; SELECT * FROM APP100 WHERE 登録日 >= @since",
    { typo: "x" }
  )).rejects.toThrow(/@typo is not declared/);
});

test("バッチ EXPLAIN schema-aware形は実行と同じWHERE capabilityを使う", async () => {
  const client = makeClient();
  const plans = await buildBatchExplainPlansCore(
    "SELECT 郵便番号 FROM APP100 WHERE 郵便番号 > '100'; SELECT $id FROM APP100",
    client,
    undefined,
    "batch-explain-b32"
  );
  const first = plans.statements[0].plan.join("\n");
  expect(first).toMatch(/mode:\s+FULL_SCAN/);
  expect(first).toContain("WHERE_RESIDUAL");
  expect(first).toContain("metadata API: form definition APP100");
  expect(first).not.toContain('kintone query: 郵便番号 > "100"');
});

test("B56: EXPLAIN は統計集約の完全入力理由を表示する", async () => {
  const plan = await explain("EXPLAIN SELECT STDDEV_POP(金額) AS sd FROM APP100");
  expect(plan).toContain("  complete input: required (onLimit=truncate disabled)");
  expect(plan).toContain("  complete input reason: STATISTICAL_AGGREGATE");
  expect(plan).toContain("  onLimit=truncate: disabled");
});

test("B58: EXPLAIN は MODE の完全入力理由を表示する", async () => {
  const plan = await explain("EXPLAIN SELECT MODE(ステータス) AS mode FROM APP100");
  expect(plan).toContain("  complete input: required (onLimit=truncate disabled)");
  expect(plan).toContain("  complete input reason: STATISTICAL_AGGREGATE");
  expect(plan).toContain("  onLimit=truncate: disabled");
});

test("B56: constant-false WHERE の EXPLAIN は完全入力表示を免除する", async () => {
  const plans = await buildBatchExplainPlans(
    "SET @empty=[]; SELECT MEDIAN(金額) AS med FROM APP100 WHERE 金額 IN @empty"
  );
  const plan = plans.statements[1].plan;
  expect(plan).toContain("  records API access: none");
  expect(plan.some((line) => line.includes("complete input"))).toBe(false);
});

test("B65-X01: constant-false WHERE でも grouping/guard/complete-input 静的情報を保持する", async () => {
  const plans = await buildBatchExplainPlans(
    "SET @empty=[]; " +
    "SELECT 顧客名, GROUPING(顧客名) AS g, COUNT(*) AS n FROM APP100 " +
    "WHERE 顧客名 IN @empty GROUP BY ROLLUP(顧客名)"
  );
  const plan = plans.statements[1].plan;
  expect(plan).toEqual(expect.arrayContaining([
    "  grouping source: ROLLUP",
    "  grouping sets: 2 (limit: 64)",
    "  grouping items: 1 (limit: 16)",
    "  grouping output rows: runtime checked (limit: 50000, before HAVING/DISTINCT/LIMIT)",
    "  complete input: required (onLimit=truncate disabled)",
    "  complete input reason: GROUPING_SETS",
    expect.stringMatching(/order plan:\s+CANONICAL_LOCAL/),
    "  records API access: none",
  ]));
});
