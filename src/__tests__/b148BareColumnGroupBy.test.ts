import { analyzeBatch } from "../core/batch";
import { parseSqlStatements } from "../core/sql";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { execute, executeBatch, type KintoneClient, type SelectResult } from "../execute";

function record(values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

type B148Client = KintoneClient & {
  recordCalls: Map<number, number>;
  mutationCalls: number;
};

function client(recordsByApp: Record<number, KintoneRecord[]>): B148Client {
  return {
    recordCalls: new Map(),
    mutationCalls: 0,
    async getRecords(params) {
      this.recordCalls.set(params.app, (this.recordCalls.get(params.app) ?? 0) + 1);
      const rows = recordsByApp[params.app] ?? [];
      const limit = Number(params.query.match(/\blimit\s+(\d+)/i)?.[1] ?? "500");
      const offset = Number(params.query.match(/\boffset\s+(\d+)/i)?.[1] ?? "0");
      return { records: rows.slice(offset, offset + limit) };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { this.mutationCalls++; return { ids: [] }; },
    async putRecords() { this.mutationCalls++; },
    async deleteRecords() { this.mutationCalls++; },
    async getApps() { return []; },
    async getFields(appId) {
      const codes = new Set((recordsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...codes].filter((code) => !code.startsWith("$id")).map((code) => ({
        code,
        label: code,
        fieldType: code === "個数" || code === "金額" || code === "数量" ? "NUMBER" : "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const app4228 = [
  record({ $id: "1", 製品名: "パン", 個数: "10", 日付: "2025-01-02", 入出庫区分: "入庫" }),
  record({ $id: "2", 製品名: "パン", 個数: "20", 日付: "2025-02-03", 入出庫区分: "出庫" }),
  record({ $id: "3", 製品名: "米", 個数: "5", 日付: "2026-01-04", 入出庫区分: "入庫" }),
];

async function rejection(sql: string, mock = client({ 4228: app4228 })): Promise<Error> {
  try {
    await execute(sql, mock, { cacheContext: `b148-${sql}` });
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected rejection");
}

describe("B148 bare-column aggregate dependency", () => {
  test("ordinary GROUP BY の grouping field と aggregate は公開結果を維持する", async () => {
    const result = await execute(
      "SELECT 製品名, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名 ORDER BY 製品名",
      client({ 4228: app4228 }),
      { cacheContext: "b148-valid-field" }
    ) as SelectResult;
    expect(result).toMatchObject({
      columns: ["製品名", "合計"],
      rowCount: 2,
      rows: [{ 製品名: "パン", 合計: "30" }, { 製品名: "米", 合計: "5" }],
    });
  });

  test.each([
    ["SELECT", "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名", "個数"],
    ["HAVING", "SELECT 製品名, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名 HAVING 日付>'2025-01-01'", "日付"],
    ["ORDER BY", "SELECT 製品名, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名 ORDER BY 個数", "個数"],
    ["SELECT", "SELECT *, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名", "wildcard"],
  ])("%s の最初の非 grouping 依存を records API 前に拒否する", async (clause, sql, dependency) => {
    const mock = client({ 4228: app4228 });
    const error = await rejection(sql, mock);
    expect(error.message).toContain(`ArgumentError: ${clause}`);
    expect(error.message).toContain(`非グループ化依存: ${dependency}`);
    expect(error.message).toContain("reason=B65_NON_GROUPED_DEPENDENCY");
    expect(error.message.replace(/reason=B65_NON_GROUPED_DEPENDENCY/, "")).not.toMatch(/B65|Phase1/);
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
  });

  test("GROUP BY なし集計は空 identity として first SELECT column を拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const error = await rejection(
      "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228",
      mock
    );
    expect(error.message).toContain("非グループ化依存: 製品名");
    expect(error.message).toContain("GROUP BY がない");
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
  });

  test("人間向け本文の具体的な移行 SQL は同じ parser/runtime で実行できる", async () => {
    const error = await rejection(
      "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名"
    );
    const sql = error.message.match(/書き換え例: 「([^」]+)」/)?.[1];
    expect(sql).toBe("SELECT 製品名, MIN(個数) FROM APP4228 GROUP BY 製品名");
    expect(sql).not.toMatch(/GROUP BY CASE| AS 個数\b/);
    const result = await execute(sql!, client({ 4228: app4228 }), {
      cacheContext: "b148-migration-sql",
    }) as SelectResult;
    expect(result.rowCount).toBe(2);
    expect(result.columns).toEqual(["製品名", "MIN(個数)"]);
  });

  test("grouping expression と一致する部分木を semantic leaf として扱う", async () => {
    const result = await execute(
      "SELECT YEAR(日付)+1 AS 翌年, SUM(個数) AS 合計 FROM APP4228 GROUP BY YEAR(日付) ORDER BY 翌年",
      client({ 4228: app4228 }),
      { cacheContext: "b148-semantic-leaf" }
    ) as SelectResult;
    expect(result.rows).toEqual([{ 翌年: "2026", 合計: "30" }, { 翌年: "2027", 合計: "5" }]);
  });

  test("plain GROUP BY alias は安全な CASE expression identity を使う", async () => {
    const result = await execute(
      "SELECT CASE WHEN 個数>10 THEN '大' ELSE '小' END AS 区分, SUM(個数) AS 合計 " +
      "FROM APP4228 GROUP BY 区分 ORDER BY 区分",
      client({ 4228: app4228 }),
      { cacheContext: "b148-case-alias" }
    ) as SelectResult;
    expect(result.rows).toEqual([{ 区分: "大", 合計: "20" }, { 区分: "小", 合計: "15" }]);
  });

  test("物理フィールドは同名 SELECT alias より優先される", async () => {
    const rows = [record({ $id: "1", 日付: "2025-01-01", 年月: "legacy", 個数: "1" })];
    const mock = client({ 148: rows });
    const error = await rejection(
      "SELECT DATE_FORMAT(日付,'%Y-%m') AS 年月, SUM(個数) AS 合計 FROM APP148 GROUP BY 年月",
      mock
    );
    expect(error.message).toContain("非グループ化依存: 日付");
    expect(mock.recordCalls.get(148) ?? 0).toBe(0);
  });

  test("JOIN は source identity を分離し右 source の dependency を拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const error = await rejection(
      "SELECT l.製品名, r.個数, SUM(l.個数) AS 合計 FROM APP4228 l " +
      "JOIN APP4228 r ON l.製品名=r.製品名 GROUP BY l.製品名",
      mock
    );
    expect(error.message).toContain("非グループ化依存: r.個数");
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
  });

  test("UNION 右 arm の違反を左右の records API 前に拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const error = await rejection(
      "SELECT 製品名, MIN(個数) AS 最小個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名 " +
      "UNION ALL SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名",
      mock
    );
    expect(error.message).toContain("非グループ化依存: 個数");
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
  });

  test("scalar subquery 内側の違反を outer records API 前に拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const error = await rejection(
      "SELECT (SELECT 製品名 FROM APP4228 GROUP BY 日付) AS 内側値, SUM(個数) AS 合計 FROM APP4228",
      mock
    );
    expect(error.message).toContain("非グループ化依存: 製品名");
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
  });

  test("CTE 実体化後の final query 違反は追加 records API 前に拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const error = await rejection(
      "WITH base AS (SELECT 製品名, 個数 FROM APP4228) " +
      "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM base GROUP BY 製品名",
      mock
    );
    expect(error.message).toContain("非グループ化依存: 個数");
    expect(mock.recordCalls.get(4228) ?? 0).toBeGreaterThan(0);
  });

  test("EXPLAIN は CTE output schema を行取得なしで伝播して final query を拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const error = await rejection(
      "EXPLAIN WITH base AS (SELECT 製品名, 個数 FROM APP4228) " +
      "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM base GROUP BY 製品名",
      mock
    );
    expect(error.message).toContain("非グループ化依存: 個数");
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
  });

  test("CREATE TEMP TABLE source の違反は records API 前に拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const result = await executeBatch(
      "CREATE TEMP TABLE #bad AS " +
      "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名; " +
      "SELECT * FROM #bad;",
      mock
    );
    expect(result.statements[0]).toMatchObject({ status: "error" });
    expect(result.statements[1]).toMatchObject({ status: "skipped" });
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
  });

  test("batch EXPLAIN は保存済み temp columns で bare dependency を拒否する", async () => {
    const mock = client({ 4228: app4228 });
    const result = await executeBatch(
      "CREATE TEMP TABLE #base AS SELECT 製品名, 個数 FROM APP4228; " +
      "EXPLAIN SELECT 製品名, 個数, SUM(個数) AS 合計 FROM #base GROUP BY 製品名;",
      mock
    );
    expect(result.statements[0]).toMatchObject({ status: "success" });
    expect(result.statements[1]).toMatchObject({ status: "error" });
    expect(mock.recordCalls.get(4228) ?? 0).toBeGreaterThan(0);
  });

  test.each(["INSERT", "UPSERT"] as const)("%s SELECT source の違反は fetch/mutation 前に拒否する", async (kind) => {
    const mock = client({ 4228: app4228, 1480: [] });
    const sql = kind === "INSERT"
      ? "INSERT INTO APP1480 (製品名, 個数, 合計) " +
        "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名"
      : "UPSERT INTO APP1480 (製品名, 個数, 合計) " +
        "SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名 " +
        "ON DUPLICATE (製品名)";
    const error = await rejection(sql, mock);
    expect(error.message).toContain("非グループ化依存: 個数");
    expect(mock.recordCalls.get(4228) ?? 0).toBe(0);
    expect(mock.mutationCalls).toBe(0);
  });

  test("aggregate 内部は外側 dependency walk を停止する", async () => {
    const result = await execute(
      "SELECT 製品名, SUM(CASE WHEN 個数>10 THEN 個数 ELSE 0 END) AS 大口合計 " +
      "FROM APP4228 GROUP BY 製品名 ORDER BY 製品名",
      client({ 4228: app4228 }),
      { cacheContext: "b148-aggregate-boundary" }
    ) as SelectResult;
    expect(result.rows).toEqual([{ 製品名: "パン", 大口合計: "20" }, { 製品名: "米", 大口合計: "5" }]);
  });

  test("window-only query は aggregate query block にしない", async () => {
    const result = await execute(
      "SELECT SUM(個数) OVER () AS 総計 FROM APP4228",
      client({ 4228: app4228 }),
      { cacheContext: "b148-window-only" }
    ) as SelectResult;
    expect(result.rowCount).toBe(3);
  });

  test("aggregate と window の同一 SELECT は既存 ParseError のまま", async () => {
    const error = await rejection(
      "SELECT 製品名, SUM(個数) AS 合計, ROW_NUMBER() OVER (ORDER BY 製品名) AS 順位 " +
      "FROM APP4228 GROUP BY 製品名"
    );
    expect(error.name).toBe("ParseError");
    expect(error.message).not.toContain("B65_NON_GROUPED_DEPENDENCY");
  });

  test("AST-only batch validation も GROUP BY なしの明白な違反を拒否する", () => {
    expect(() => analyzeBatch(parseSqlStatements(
      "SELECT 製品名, SUM(個数) AS 合計 FROM APP4228"
    ))).toThrow(/B65_NON_GROUPED_DEPENDENCY/);
  });
});

/**
 * B148 エラー文の呼び名（Claude レビュー C / D）。
 *
 * エラー文は保存クエリ・プラグイン利用者にとって唯一の案内なので、
 * 「式」とだけ書くと列の多い SELECT でどれを直せばよいか分からない。
 * 実装当初は算術式が別名、関数式が「式」と割れていた。
 */
describe("B148: 違反箇所の呼び名", () => {
  test("別名のある計算列は、算術式でも関数式でも別名で呼ぶ", async () => {
    const arith = await rejection(
      "SELECT 個数 + 1 AS 加算, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名"
    );
    expect(arith.message).toContain("SELECT 式「加算」");

    const func = await rejection(
      "SELECT DATE_FORMAT(日付,'%m') AS 月, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名"
    );
    expect(func.message).toContain("SELECT 式「月」");
  });

  test("別名の無い関数式は関数名で呼ぶ（「式」で済ませない）", async () => {
    const error = await rejection(
      "SELECT DATE_FORMAT(日付,'%m'), SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名"
    );
    expect(error.message).toContain("SELECT 式「DATE_FORMAT(...)」");
    expect(error.message).not.toContain("SELECT 式「式」");
  });

  test("素の列は列名で呼び、具体的な書き換え例も出す", async () => {
    // 別名より列名を優先する。書き換え例は呼び名と依存名が一致するときだけ出るため。
    const error = await rejection(
      "SELECT 製品名, 個数 AS 数, SUM(個数) AS 合計 FROM APP4228 GROUP BY 製品名"
    );
    expect(error.message).toContain("SELECT 式「個数」");
    expect(error.message).toContain("実行可能な書き換え例");
  });

  test("GROUP BY が式のときも「式」で済ませない", async () => {
    const error = await rejection(
      "SELECT DATE_FORMAT(日付,'%m') AS 月, SUM(個数) AS 合計 FROM APP4228 "
      + "GROUP BY DATE_FORMAT(日付,'%Y')"
    );
    expect(error.message).toContain("GROUP BY DATE_FORMAT(...)");
    expect(error.message).not.toContain("GROUP BY 式");
  });
});

/**
 * B148 サブテーブル仮想テーブルの移行案（codex 最終チェック 1）。
 *
 * 実装当初は `APPn` だけを組み立てており、`APPn$表` の違反に対して
 * 親 APP を指す SQL を案内していた。従うと `unknown field code(s): _pid` で落ちる。
 * しかもその文面は v3.56.1 で「そんな項目は無い」と誤読されると直したばかりのもの。
 * 「従うと壊れる助言」の 4 度目になるところだった（実測で再現）。
 */
test("B148: サブテーブルの移行案は APPn$表 を指す（親 APP ではない）", async () => {
  const parent = [{
    $id: { value: "1" },
    数値: { value: "100" },
    テーブル: {
      type: "SUBTABLE",
      value: [
        { id: "11", value: { 商品コード: { value: "A" }, 数量: { value: "3" } } },
        { id: "12", value: { 商品コード: { value: "A" }, 数量: { value: "5" } } },
      ],
    },
  }] as unknown as KintoneRecord[];
  const mock: KintoneClient = {
    async getRecords() { return { records: parent }; },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() { /* no writes */ },
    async deleteRecords() { /* no deletes */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "数値", label: "数値", fieldType: "NUMBER" },
        { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE" },
        { code: "商品コード", label: "商品コード", fieldType: "SINGLE_LINE_TEXT",
          inSubtable: true, subtableCode: "テーブル" },
        { code: "数量", label: "数量", fieldType: "NUMBER",
          inSubtable: true, subtableCode: "テーブル" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  } as unknown as KintoneClient;

  const error = await rejection(
    "SELECT _pid, 数量, SUM(数量) AS 合計 FROM APP100$テーブル GROUP BY _pid",
    mock as never
  );
  // 案内先も source 表示も、違反したその表を指すこと。
  expect(error.message).toContain("APP100$テーブル");
  expect(error.message).not.toMatch(/FROM APP100 GROUP BY/);
});
