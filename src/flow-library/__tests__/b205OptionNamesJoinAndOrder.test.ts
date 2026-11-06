import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

/**
 * B205 の受入基準のうち、**JOIN キーの押し下げ（AC9）**・**並び順（AC8）**・
 * **利用者の言語を変えても同じ（AC6）** を固定する。
 *
 * AC9 は設計レビューの **BLOCKER の芯**＝JOIN キーの押し下げは読んだ値から
 * `選択 in ("…")` を**直接組み立てる**ので、AST だけを変換する設計だと
 * 「ローカルのキーは既定名・押し下げだけ既定名で送信」という中間状態になる。
 */

/** アプリ 1 と 2 の両方に、言語ごとの表示名を設定した `選択` がある。 */
const DISPLAY_BY_LANG: Record<"ja" | "en", Record<string, string>> = {
  ja: { a1: "甲", a2: "乙" },
  en: { a1: "ALPHA", a2: "BETA" },
};

const fieldsFor = (display?: Record<string, string>) => {
  const name = (canonical: string) => display?.[canonical] ?? canonical;
  return [
    {
      code: "選択", label: "選択", fieldType: "DROP_DOWN", writable: true,
      optionOrder: { [name("a1")]: 0, [name("a2")]: 1 },
    },
    { code: "メモ", label: "メモ", fieldType: "SINGLE_LINE_TEXT", writable: true },
  ];
};

function mockClient(lang: "ja" | "en") {
  const display = DISPLAY_BY_LANG[lang];
  const queries: Array<{ app: number; query: string }> = [];
  /** kintone に入っている値は**表示名** */
  const rowsOf = (app: number): Rec[] => app === 1
    ? [
        { $id: { value: "1" }, $revision: { value: "1" }, 選択: { value: display.a2 }, メモ: { value: "x" } },
        { $id: { value: "2" }, $revision: { value: "1" }, 選択: { value: display.a1 }, メモ: { value: "y" } },
      ]
    : [
        { $id: { value: "11" }, $revision: { value: "1" }, 選択: { value: display.a1 }, メモ: { value: "P" } },
        { $id: { value: "12" }, $revision: { value: "1" }, 選択: { value: display.a2 }, メモ: { value: "Q" } },
      ];
  /** kintone は**表示名でしか**一致しない */
  const filtered = (app: number, query: string): Rec[] => {
    const match = /選択 in \(([^)]*)\)/.exec(query);
    if (!match) return rowsOf(app);
    const wanted = new Set([...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]));
    return rowsOf(app).filter((record) => wanted.has(String(record.選択.value)));
  };
  const value = {
    async getRecords(params: { app: number; query: string; totalCount?: boolean }) {
      queries.push({ app: params.app, query: params.query });
      const records = filtered(params.app, params.query);
      return params.totalCount ? { records, totalCount: String(records.length) } : { records };
    },
    async openCursor(params: { app: number; query: string }) {
      queries.push({ app: params.app, query: params.query });
      const records = filtered(params.app, params.query);
      return { totalCount: records.length, async nextPage() { return { records, next: false }; }, async close() {} };
    },
    async postRecords(params: { records: unknown[] }) {
      return { ids: params.records.map((_, index) => String(900 + index)) };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return fieldsFor(); },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
    async getOptionNames(appId: number) {
      return { appId, fields: fieldsFor(display), statusStates: null };
    },
  } as unknown as FlowKintoneClient;
  return { value, queries };
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string, lang: "ja" | "en", canonical: boolean) {
  const mock = mockClient(lang);
  const parsed = parseScript(sql);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    ...(canonical ? { optionNames: "canonical" as const } : {}),
  });
  const results = [];
  for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  await disposeExecutionContext(context);
  return { mock, results };
}

const rowsOf = (result: unknown) => (result as { rows: Array<Record<string, string>> }).rows;

test("B205 AC9: 選択肢を JOIN のキーにしても、押し下げは表示名で送る（BLOCKER の芯）", async () => {
  const { mock, results } = await run(
    `${header}SELECT a.メモ AS 親, b.メモ AS 子 FROM APP1 a JOIN APP2 b ON a.選択 = b.選択 ORDER BY a.$id ASC;`,
    "ja", true
  );
  expect(results[0].status).toBe("success");
  // JOIN 先（アプリ 2）へ送ったクエリは**表示名**（既定名で送ると kintone が 0 件になる）
  const joinQueries = mock.queries.filter((entry) => entry.app === 2);
  expect(joinQueries.length).toBeGreaterThan(0);
  expect(joinQueries.some((entry) => entry.query.includes('選択 in ("甲"')
    || entry.query.includes('選択 in ("乙"') || entry.query.includes("\"甲\"") || entry.query.includes("\"乙\""))).toBe(true);
  // 既定名が押し下げに混ざっていない
  expect(joinQueries.every((entry) => !entry.query.includes('"a1"') && !entry.query.includes('"a2"'))).toBe(true);
  // 結合の結果（ローカルのキーも既定名で一貫しているので当たる）
  expect(rowsOf(results[0].result)).toEqual([
    { 親: "x", 子: "Q" },
    { 親: "y", 子: "P" },
  ]);
});

test("B205 AC8: ORDER BY 選択 が定義順になる（raw では定義順にならない）", async () => {
  const sql = `${header}SELECT $id FROM APP1 ORDER BY 選択 ASC, $id ASC;`;
  const { results } = await run(sql, "ja", true);
  // 既定名が optionOrder に揃うので、定義順（a1 → a2）＝$id 2, 1
  expect(rowsOf(results[0].result)).toEqual([{ $id: "2" }, { $id: "1" }]);

  const raw = await run(sql, "ja", false);
  // raw は読んだ値（表示名）が optionOrder（既定名）に無く「未知の帯」に落ちるので、
  // 定義順ではなくラベルの文字列順（甲 → 乙 の順になるとは限らない）
  expect(rowsOf(raw.results[0].result)).not.toEqual([{ $id: "2" }, { $id: "1" }]);
});

test("B205 AC6: 利用者の言語が変わっても SQL と結果は同じ（日本語と英語）", async () => {
  const sql = `${header}SELECT $id, 選択 FROM APP1 WHERE 選択 = 'a1';`;
  const ja = await run(sql, "ja", true);
  const en = await run(sql, "en", true);
  // 読み戻す値は既定名なので、どちらの言語でも同じ
  expect(rowsOf(ja.results[0].result)).toEqual([{ $id: "2", 選択: "a1" }]);
  expect(rowsOf(en.results[0].result)).toEqual(rowsOf(ja.results[0].result));
  // kintone へ送るクエリは、その利用者の言語の名称
  expect(ja.mock.queries[0].query).toContain('選択 in ("甲")');
  expect(en.mock.queries[0].query).toContain('選択 in ("ALPHA")');
});
