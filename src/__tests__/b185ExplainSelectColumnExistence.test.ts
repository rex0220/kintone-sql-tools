import {
  buildBatchExplainPlans,
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

const fieldsByApp: Record<number, KintoneFieldInfo[]> = {
  4149: [
    { code: "商談フェーズ", label: "商談フェーズ", fieldType: "DROP_DOWN" },
    { code: "売上", label: "売上", fieldType: "NUMBER" },
    { code: "受注予定日", label: "受注予定日", fieldType: "DATE" },
    { code: "顧客No", label: "顧客No", fieldType: "SINGLE_LINE_TEXT" },
  ],
  4150: [
    { code: "顧客No", label: "顧客No", fieldType: "SINGLE_LINE_TEXT" },
    { code: "顧客名", label: "顧客名", fieldType: "SINGLE_LINE_TEXT" },
  ],
};

function makeClient(options: { emptyFields?: boolean } = {}): KintoneClient & {
  getFields: jest.Mock;
  getRecords: jest.Mock;
} {
  const getFields = jest.fn(async (appId: number) =>
    options.emptyFields ? [] : fieldsByApp[appId] ?? []
  );
  const getRecords = jest.fn(async () => ({ records: [] }));
  return {
    getFields,
    getRecords,
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

async function rejectedMessage(sql: string, cacheContext: string): Promise<string> {
  try {
    await execute(sql, makeClient(), { cacheContext });
    throw new Error("expected rejection");
  } catch (error) {
    return (error as Error).message;
  }
}

const typedWhere = "WHERE 受注予定日 = THIS_YEAR()";

test("B185: 実践例の EXPLAIN と実行は同じ不存在列エラーになる", async () => {
  const sql =
    "SELECT 商談フェーズ, COUNT(*) AS 件数, SUM(売上金額) AS 売上合計 " +
    `FROM APP4149 ${typedWhere} GROUP BY 商談フェーズ`;
  const explainMessage = await rejectedMessage(`EXPLAIN ${sql}`, "b185-example-explain");
  const executeMessage = await rejectedMessage(sql, "b185-example-execute");

  expect(explainMessage).toBe("ArgumentError: unknown field code(s): 売上金額 (APP4149)");
  expect(explainMessage).toBe(executeMessage);
});

test.each([
  ["SELECT 列", `SELECT Missing FROM APP4149 ${typedWhere}`],
  ["別名付き列", `SELECT Missing AS value FROM APP4149 ${typedWhere}`],
  ["集計引数", `SELECT SUM(Missing) AS total FROM APP4149 ${typedWhere}`],
  ["CASE 条件", `SELECT CASE WHEN Missing > 0 THEN 売上 ELSE 0 END AS value FROM APP4149 ${typedWhere}`],
  ["CASE 結果", `SELECT CASE WHEN 売上 > 0 THEN Missing ELSE 0 END AS value FROM APP4149 ${typedWhere}`],
  ["文字列関数引数", `SELECT UPPER(Missing) AS value FROM APP4149 ${typedWhere}`],
  ["GROUP BY", `SELECT COUNT(*) AS n FROM APP4149 ${typedWhere} GROUP BY Missing`],
  ["ORDER BY", `SELECT 売上 FROM APP4149 ${typedWhere} ORDER BY Missing`],
  [
    "window PARTITION BY",
    `SELECT ROW_NUMBER() OVER (PARTITION BY Missing ORDER BY 売上) AS rn FROM APP4149 ${typedWhere}`,
  ],
  [
    "window ORDER BY",
    `SELECT ROW_NUMBER() OVER (PARTITION BY 商談フェーズ ORDER BY Missing) AS rn FROM APP4149 ${typedWhere}`,
  ],
] as const)("B185: EXPLAIN は %s の不存在列を拒否する", async (_label, sql) => {
  await expect(execute(`EXPLAIN ${sql}`, makeClient(), { cacheContext: `b185-position-${_label}` }))
    .rejects.toThrow("ArgumentError: unknown field code(s): Missing (APP4149)");
});

test.each([
  [
    "JOIN 左側",
    "SELECT a.Missing FROM APP4149 AS a INNER JOIN APP4150 AS b ON a.顧客No = b.顧客No " + typedWhere,
    "APP4149",
  ],
  [
    "JOIN 右側",
    "SELECT b.Missing FROM APP4149 AS a INNER JOIN APP4150 AS b ON a.顧客No = b.顧客No " + typedWhere,
    "APP4150",
  ],
] as const)("B185: EXPLAIN は %sの alias 修飾不存在列を拒否する", async (label, sql, app) => {
  await expect(execute(`EXPLAIN ${sql}`, makeClient(), { cacheContext: `b185-${label}` }))
    .rejects.toThrow(`ArgumentError: unknown field code(s): Missing (${app})`);
});

// フォーム定義を「計画作成の途中で」読む文型。相対日付を含まないので、束縛直後の早期検査では
// キャッシュが空で、計画作成の最後の検査で初めて捕まる（Claude レビューで実機の取りこぼしを確認して追加）
test.each([
  ["型付き WHERE だけ", "SELECT Missing FROM APP4149 WHERE 商談フェーズ = '受注'"],
  ["型付き WHERE + GROUP BY", "SELECT 商談フェーズ, SUM(Missing) AS s FROM APP4149 WHERE 商談フェーズ = '受注' GROUP BY 商談フェーズ"],
  ["ORDER BY だけ", "SELECT Missing FROM APP4149 ORDER BY 売上 LIMIT 1"],
  ["GROUP BY だけ", "SELECT 商談フェーズ, SUM(Missing) AS s FROM APP4149 GROUP BY 商談フェーズ"],
] as const)("B185: 計画作成の途中でフォーム定義を読む文（%s）でも不存在列を拒否する", async (_label, sql) => {
  const client = makeClient();
  await expect(execute(`EXPLAIN ${sql}`, client, { cacheContext: `b185-late-${_label}` }))
    .rejects.toThrow("ArgumentError: unknown field code(s): Missing (APP4149)");
  // 追加の API は無い（EXPLAIN が計画のために読んだ 1 回だけ）
  expect(client.getFields).toHaveBeenCalledTimes(1);
});

test("B185: フォーム定義を読まない EXPLAIN は追加取得せず従来どおり通す", async () => {
  const countClient = makeClient();
  await expect(execute(
    "EXPLAIN SELECT COUNT(*) FROM APP4149",
    countClient,
    { cacheContext: "b185-no-fields-count" }
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(countClient.getFields).not.toHaveBeenCalled();

  const missingClient = makeClient();
  await expect(execute(
    "EXPLAIN SELECT Missing FROM APP4149",
    missingClient,
    { cacheContext: "b185-no-fields-missing" }
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(missingClient.getFields).not.toHaveBeenCalled();
});

test("B185: defs=[] は非 authoritative として従来どおり通す", async () => {
  const client = makeClient({ emptyFields: true });
  await execute("DESCRIBE APP4149", client, { cacheContext: "b185-empty-fields" });
  expect(client.getFields).toHaveBeenCalledTimes(1);
  await expect(execute(
    "EXPLAIN SELECT Missing FROM APP4149",
    client,
    { cacheContext: "b185-empty-fields" }
  )).resolves.toMatchObject({ type: "SELECT" });
  expect(client.getFields).toHaveBeenCalledTimes(1);
});

test("B185: CTE の不存在列は既存 B86 と同じ文言で拒否する", async () => {
  await expect(execute(
    "EXPLAIN WITH t AS (SELECT 売上 AS Amount FROM APP4149) SELECT Missing FROM t",
    makeClient(),
    { cacheContext: "b185-cte-missing" }
  )).rejects.toThrow("ArgumentError: unknown field code(s): Missing (t)");
});

test("B185: UNION・生成系列・SHOW APPS・DESCRIBE の推定 relation を誤拒否しない", async () => {
  const client = makeClient();
  const queries = [
    "EXPLAIN SELECT 売上 FROM APP4149 WHERE 受注予定日 = THIS_YEAR() " +
      "UNION ALL SELECT 売上 FROM APP4149 WHERE 受注予定日 = THIS_YEAR()",
    "EXPLAIN SELECT (SELECT 売上 FROM APP4149 WHERE 受注予定日 = THIS_YEAR() LIMIT 1) AS value " +
      "FROM APP4149 WHERE 受注予定日 = THIS_YEAR()",
    "EXPLAIN WITH s AS (GENERATE_SERIES(1, 2) AS n) SELECT n FROM s ORDER BY n",
    "EXPLAIN WITH a AS (SHOW APPS) SELECT アプリ名 FROM a",
    "EXPLAIN WITH d AS (DESCRIBE APP4149) SELECT フィールドコード FROM d",
  ];
  for (const [index, sql] of queries.entries()) {
    await expect(execute(sql, client, { cacheContext: `b185-relation-${index}` }))
      .resolves.toMatchObject({ type: "SELECT" });
  }
});

test("B185: 0 行の一時テーブル schema と B186 の混在 CTE 列解決を誤拒否しない", async () => {
  const client = makeClient();
  const batch = await buildBatchExplainPlans(
    "CREATE TEMP TABLE #t AS SELECT 売上 AS Amount FROM APP4149;" +
      "SELECT Amount FROM #t",
    client,
    undefined,
    "b185-empty-temp"
  );
  expect(batch.statements[1].plan).toEqual(expect.arrayContaining([
    expect.stringContaining("static schema / runtime rows"),
  ]));

  await expect(execute(
    "EXPLAIN WITH t AS (SELECT 売上 AS Amount FROM APP4149) " +
      "SELECT Amount FROM t INNER JOIN APP4150 AS p ON t.Amount = p.顧客No ORDER BY Amount",
    makeClient(),
    { cacheContext: "b185-b186-mixed" }
  )).resolves.toMatchObject({ type: "SELECT" });
});

test("B185: 存在する列だけの EXPLAIN は既存 plan 行だけを返す", async () => {
  const result = await execute(
    `EXPLAIN SELECT 商談フェーズ, SUM(売上) AS total FROM APP4149 ${typedWhere} GROUP BY 商談フェーズ`,
    makeClient(),
    { cacheContext: "b185-valid-plan" }
  ) as SelectResult;
  expect(result.columns).toEqual(["plan"]);
  expect(result.rows.length).toBeGreaterThan(0);
  expect(result.rows.every((row) => Object.keys(row).length === 1 && "plan" in row)).toBe(true);
});
