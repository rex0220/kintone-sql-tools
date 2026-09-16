import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function client(): KintoneClient {
  const fields: Record<number, KintoneFieldInfo[]> = {
    100: [
      { code: "売上", label: "売上", fieldType: "NUMBER" },
      { code: "顧客No", label: "顧客No", fieldType: "SINGLE_LINE_TEXT" },
    ],
    200: [
      { code: "dest", label: "dest", fieldType: "SINGLE_LINE_TEXT" },
    ],
  };
  return {
    async getRecords(params) {
      return { records: params.app === 100
        ? [
            record({ $id: "1", 売上: "9", 顧客No: "C1" }),
            record({ $id: "2", 売上: "10", 顧客No: "C2" }),
          ]
        : [] };
    },
    async openCursor() { throw new Error("unexpected cursor"); },
    async postRecords() { return { ids: ["1"] }; },
    async putRecords() { return undefined; },
    async deleteRecords() { return undefined; },
    async getApps() { return []; },
    async getFields(appId) { return fields[appId] ?? []; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

test("B181: 文書例は元の alias 表記でも小文字でも同じ列名と行を返す", async () => {
  const sql = (name: string) =>
    `WITH t AS (SELECT 売上 AS Amount FROM APP100) SELECT ${name} FROM t ORDER BY ${name}`;
  const original = await execute(sql("Amount"), client()) as SelectResult;
  const lowercase = await execute(sql("amount"), client()) as SelectResult;
  expect(original).toMatchObject({ columns: ["amount"], rows: [{ amount: "9" }, { amount: "10" }] });
  expect(original.rows).toEqual(lowercase.rows);
});

test("B181: 英字混在の日本語 alias を元表記と小文字表記で参照できる", async () => {
  for (const name of ["顧客No", "顧客no"]) {
    const result = await execute(
      `WITH t AS (SELECT 顧客No AS 顧客No FROM APP100) SELECT ${name} FROM t ORDER BY ${name}`,
      client()
    ) as SelectResult;
    expect(result).toMatchObject({ columns: ["顧客no"], rows: [{ 顧客no: "C1" }, { 顧客no: "C2" }] });
  }
});

test("B181: 同一 SELECT の HAVING alias は元表記でも解決する", async () => {
  const result = await execute(
    "SELECT 売上, SUM(売上) AS Amount FROM APP100 GROUP BY 売上 HAVING Amount > 9",
    client()
  ) as SelectResult;
  expect(result.rows).toEqual([{ 売上: "10", amount: "10" }]);
});

test.each([
  ["SELECT", "SELECT Amount FROM t WHERE Amount > 9 ORDER BY Amount", [{ amount: "10" }]],
  ["CASE", "SELECT CASE WHEN Amount > 9 THEN Amount ELSE 0 END AS v FROM t ORDER BY v", [{ v: "0" }, { v: "10" }]],
  ["aggregate", "SELECT SUM(Amount) AS total FROM t", [{ total: "19" }]],
  ["GROUP BY", "SELECT Amount, COUNT(*) AS n FROM t GROUP BY Amount ORDER BY Amount", [{ amount: "9", n: "1" }, { amount: "10", n: "1" }]],
  ["HAVING", "SELECT Amount, COUNT(*) AS n FROM t GROUP BY Amount HAVING Amount > 9", [{ amount: "10", n: "1" }]],
  ["window ORDER BY", "SELECT Amount, ROW_NUMBER() OVER (ORDER BY Amount) AS rn FROM t ORDER BY rn", [{ amount: "9", rn: "1" }, { amount: "10", rn: "2" }]],
] as const)("B181: CTE の %s 参照を実体化列へ束縛する", async (_name, body, expected) => {
  const result = await execute(
    `WITH t AS (SELECT 売上 AS Amount FROM APP100) ${body}`,
    client()
  ) as SelectResult;
  expect(result.rows).toEqual(expected);
});

test("B181: JOIN ON・サブクエリ・UNION も元の alias 表記を解決する", async () => {
  const joined = await execute(
    "WITH a AS (SELECT 顧客No AS 顧客No, 売上 AS Amount FROM APP100), " +
      "b AS (SELECT 顧客No AS 顧客No FROM APP100) " +
      "SELECT a.Amount FROM a INNER JOIN b ON a.顧客No = b.顧客No ORDER BY a.Amount",
    client()
  ) as SelectResult;
  expect(joined.rows).toEqual([{ amount: "9" }, { amount: "10" }]);

  const subquery = await execute(
    "WITH t AS (SELECT 売上 AS Amount FROM APP100) " +
      "SELECT (SELECT Amount FROM t ORDER BY Amount DESC LIMIT 1) AS v FROM t LIMIT 1",
    client()
  ) as SelectResult;
  expect(subquery.rows).toEqual([{ v: "10" }]);

  const union = await execute(
    "WITH t AS (SELECT 売上 AS Amount FROM APP100) " +
      "SELECT Amount FROM t WHERE Amount = 9 UNION ALL SELECT Amount FROM t WHERE Amount = 10",
    client()
  ) as SelectResult;
  expect(union).toMatchObject({ columns: ["amount"], rows: [{ amount: "9" }, { amount: "10" }] });
});

test("B181: 一時テーブルは 0 行でも元の alias 表記を保存列へ束縛する", async () => {
  const nonEmpty = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 売上 AS Amount FROM APP100;SELECT Amount FROM #t ORDER BY Amount",
    client()
  );
  expect(nonEmpty.ok).toBe(true);
  expect(nonEmpty.statements[1].result).toMatchObject({ columns: ["amount"], rows: [{ amount: "9" }, { amount: "10" }] });

  const empty = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 売上 AS Amount FROM APP999;SELECT Amount FROM #t",
    client()
  );
  expect(empty.ok).toBe(true);
  expect(empty.statements[1].result).toMatchObject({ columns: ["amount"], rows: [] });
});

test("B181: 不存在列の文言は維持し、物理 APP フィールドは大文字小文字を区別する", async () => {
  await expect(execute(
    "WITH t AS (SELECT 売上 AS Amount FROM APP100) SELECT Missing FROM t",
    client()
  )).rejects.toThrow(/ArgumentError: unknown field code\(s\): Missing \(t\)/);
  await expect(execute("SELECT 顧客no FROM APP100", client()))
    .rejects.toThrow(/ArgumentError: unknown field code\(s\): 顧客no \(APP100\)/);
});

test("B181: UPSERT SELECT VALIDATE ONLY と UPDATE FROM のキー参照を解決する", async () => {
  const upsert = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT 'K1' AS Dest;" +
      "UPSERT INTO APP200 (dest) SELECT Dest FROM #t ON DUPLICATE (dest) VALIDATE ONLY",
    client()
  );
  expect(upsert.ok).toBe(true);

  const update = await executeBatch(
    "CREATE TEMP TABLE #t AS SELECT '1' AS KeyValue, 'after' AS Amount;" +
      "UPDATE APP200 SET dest = s.Amount FROM #t s WHERE APP200.$id = s.KeyValue VALIDATE ONLY",
    client()
  );
  expect(update.ok).toBe(true);
});

function mixedClient(): KintoneClient {
  const base = client();
  const fields: Record<number, KintoneFieldInfo[]> = {
    100: [
      { code: "売上", label: "売上", fieldType: "NUMBER" },
      { code: "顧客No", label: "顧客No", fieldType: "SINGLE_LINE_TEXT" },
    ],
    300: [
      { code: "Key", label: "Key", fieldType: "NUMBER" },
      { code: "Amount", label: "Amount", fieldType: "NUMBER" },
      { code: "grp", label: "grp", fieldType: "SINGLE_LINE_TEXT" },
    ],
  };
  return {
    ...base,
    async getRecords(params) {
      if (params.app === 300) {
        return { records: [
          record({ $id: "1", Key: "9", Amount: "900", grp: "a" }),
          record({ $id: "2", Key: "10", Amount: "1000", grp: "b" }),
        ] };
      }
      return base.getRecords(params);
    },
    async getFields(appId) { return fields[appId] ?? []; },
  };
}

test("B181: 物理アプリが混在する文では未修飾名の物理完全一致が勝つ（CTE の小文字列名へ寄せない）", async () => {
  // t.amount（CTE・小文字）と p.Amount（物理・大文字）が並ぶ。未修飾の Amount は物理フィールドのまま
  const withAlias = await execute(
    "WITH t AS (SELECT 売上 AS Amount FROM APP100) " +
      "SELECT Amount AS pa FROM t INNER JOIN APP300 AS p ON t.amount = p.Key ORDER BY pa",
    mixedClient()
  ) as SelectResult;
  expect(withAlias.rows).toEqual([{ pa: "900" }, { pa: "1000" }]);

  // ORDER BY の未修飾名も同じ規則（B181 以前と同じく曖昧にならない）
  const orderByField = await execute(
    "WITH t AS (SELECT 売上 AS Amount FROM APP100) " +
      "SELECT Amount AS pa FROM t INNER JOIN APP300 AS p ON t.amount = p.Key ORDER BY Amount DESC",
    mixedClient()
  ) as SelectResult;
  expect(orderByField.rows).toEqual([{ pa: "1000" }, { pa: "900" }]);
});

test("B181: 物理アプリが混在しても物理側に同名が無ければ未修飾名を CTE 列へ束縛する（空文字で静かに通さない）", async () => {
  const cte = "WITH t AS (SELECT 売上 AS Amount, 顧客No AS k FROM APP100) ";
  const select = await execute(
    cte + "SELECT Amount AS pa, q.売上 FROM t INNER JOIN APP100 AS q ON t.k = q.顧客No ORDER BY pa",
    mixedClient()
  ) as SelectResult;
  expect(select.rows).toEqual([{ pa: "9", 売上: "9" }, { pa: "10", 売上: "10" }]);

  const where = await execute(
    cte + "SELECT t.k FROM t INNER JOIN APP100 AS q ON t.k = q.顧客No WHERE Amount > 9",
    mixedClient()
  ) as SelectResult;
  expect(where.rows).toEqual([{ k: "C2" }]);
});

test("B181: HAVING の集計引数は別名へ束縛せず物理フィールドを読む", async () => {
  // COUNT(*) AS Amount（別名 amount）と物理 Amount が並ぶ。SUM(Amount) は物理の合計
  // （HAVING の集計は SELECT に同じ集計がある場合だけ評価される既存契約に従い、SELECT にも置く）
  const result = await execute(
    "SELECT grp, COUNT(*) AS Amount, SUM(Amount) AS total FROM APP300 GROUP BY grp " +
      "HAVING SUM(Amount) > 950 ORDER BY grp",
    mixedClient()
  ) as SelectResult;
  expect(result.rows).toEqual([{ grp: "b", amount: "1", total: "1000" }]);
});

test("B181: EXPLAIN は実行と同じ実体化 alias を解決する", async () => {
  await expect(execute(
    "EXPLAIN WITH t AS (SELECT 売上 AS Amount FROM APP100) SELECT Amount FROM t ORDER BY Amount",
    client()
  )).resolves.toMatchObject({ type: "SELECT" });
  // 物理アプリ混在の未修飾参照も EXPLAIN と実行で同じ束縛（物理定義を見て CTE 列へ寄せる）。
  await expect(execute(
    "EXPLAIN WITH t AS (SELECT 売上 AS Amount, 顧客No AS k FROM APP100) " +
      "SELECT Amount AS pa FROM t INNER JOIN APP100 AS q ON t.k = q.顧客No WHERE amount > 9 ORDER BY pa",
    mixedClient()
  )).resolves.toMatchObject({ type: "SELECT" });
});

test("B181: 実体化列だけの文と物理だけの文では束縛のためにフォーム定義を追加取得しない", async () => {
  const base = client();
  let getFieldsCalls = 0;
  const counting: KintoneClient = {
    ...base,
    async getFields(appId) { getFieldsCalls += 1; return base.getFields(appId); },
  };
  await execute("WITH t AS (SELECT 売上 AS Amount FROM APP100) SELECT Amount FROM t ORDER BY Amount", counting);
  const afterCte = getFieldsCalls;
  await execute("SELECT 売上 AS Amount FROM APP100 ORDER BY Amount", counting);
  const afterPhysical = getFieldsCalls;
  // 束縛が独自に定義を取りに行かないことの上限: CTE の実体化・ORDER BY 意味型の取得分（各 1 回・キャッシュ）を超えない
  expect(afterCte).toBeLessThanOrEqual(1);
  expect(afterPhysical - afterCte).toBeLessThanOrEqual(1);
});
