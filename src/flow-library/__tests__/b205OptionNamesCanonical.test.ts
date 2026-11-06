import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  explainScript,
  parseScript,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

/**
 * B205 の受入試験（依頼 KJ-8 §6）。
 *
 * アプリ 1 は「言語ごとの表示名」を設定した `ラジオボタン`（既定名 sample1 / sample2 ⇄ 表示名
 * サンプル１ / サンプル２）と、設定していない `処理状況` を持つ。アプリ 2 は JOIN 先。
 * **kintone 側は表示名しか受け付けない**ので、モックも表示名でしか一致させない。
 */
const CHOICE_DISPLAY: Record<string, string> = { sample1: "サンプル１", sample2: "サンプル２" };

const fieldsFor = (lang: "default" | "user") => {
  const option = (canonical: string, index: number) => ({
    name: lang === "user" ? CHOICE_DISPLAY[canonical] : canonical, index,
  });
  const radioOrder = Object.fromEntries(
    [option("sample1", 0), option("sample2", 1)].map(({ name, index }) => [name, index])
  );
  return [
    { code: "ラジオボタン", label: "ラジオボタン", fieldType: "RADIO_BUTTON", writable: true, optionOrder: radioOrder },
    { code: "処理状況", label: "処理状況", fieldType: "DROP_DOWN", writable: true, optionOrder: { 未処理: 0, 処理済: 1 } },
    { code: "担当者", label: "担当者", fieldType: "SINGLE_LINE_TEXT", writable: true },
    { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
  ];
};

function mockClient() {
  const queries: Array<{ app: number; query: string }> = [];
  const writes: Array<{ app: number; records: unknown[] }> = [];
  const optionNameCalls: number[] = [];
  /** kintone に入っている値は**表示名**（レコードの実体） */
  const rows = (): Rec[] => [
    { $id: { value: "1" }, $revision: { value: "1" }, ラジオボタン: { value: "サンプル１" }, 処理状況: { value: "未処理" }, 担当者: { value: "山田" }, ステータス: { value: "みしょり" } },
    { $id: { value: "2" }, $revision: { value: "1" }, ラジオボタン: { value: "サンプル２" }, 処理状況: { value: "処理済" }, 担当者: { value: "佐藤" } },
    { $id: { value: "3" }, $revision: { value: "1" }, ラジオボタン: { value: "sample9" }, 処理状況: { value: "未処理" }, 担当者: { value: "鈴木" } },
  ];
  /** kintone の `in (…)` は**表示名でしか**一致しない（既定名で来たら 0 件） */
  const filtered = (query: string): Rec[] => {
    const match = /ラジオボタン in \(([^)]*)\)/.exec(query);
    if (!match) return rows();
    const wanted = new Set([...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]));
    return rows().filter((record) => wanted.has(String(record.ラジオボタン.value)));
  };
  const value = {
    async getRecords(params: { app: number; query: string; totalCount?: boolean }) {
      queries.push({ app: params.app, query: params.query });
      const records = filtered(params.query);
      return params.totalCount ? { records, totalCount: String(records.length) } : { records };
    },
    async openCursor(params: { app: number; query: string }) {
      queries.push({ app: params.app, query: params.query });
      const records = filtered(params.query);
      return { totalCount: records.length, async nextPage() { return { records, next: false }; }, async close() {} };
    },
    async postRecords(params: { app: number; records: unknown[] }) {
      writes.push({ app: params.app, records: params.records });
      return { ids: params.records.map((_, index) => String(900 + index)) };
    },
    async putRecords(params: { app: number; records: Array<{ record: unknown }> }) {
      writes.push({ app: params.app, records: params.records.map((entry) => entry.record) });
    },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return fieldsFor("default"); },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() {
      // raw の正本は表示名（エンジンは lang: "user" で取る）
      return { enable: true, states: [{ name: "みしょり", index: 0 }, { name: "かんりょう", index: 1 }] };
    },
    async getOptionNames(appId: number) {
      optionNameCalls.push(appId);
      return {
        appId,
        fields: fieldsFor("user"),
        processEnabled: true,
        statusStates: [
          { canonical: "未処理", display: "みしょり", index: 0 },
          { canonical: "完了", display: "かんりょう", index: 1 },
        ],
      };
    },
  } as unknown as FlowKintoneClient;
  return { value, queries, writes, optionNameCalls };
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string, options: Record<string, unknown> = {}) {
  const mock = mockClient();
  const parsed = parseScript(sql);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, ...options,
  });
  const results = [];
  for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  await disposeExecutionContext(context);
  return { mock, results };
}

const canonical = { optionNames: "canonical" as const };

test("B205 AC1: WHERE に既定名を書くと、表示名へ直して押し下げる", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id, ラジオボタン FROM APP1 WHERE ラジオボタン = 'sample1';`, canonical
  );
  expect(results[0].status).toBe("success");
  // kintone へ送ったクエリは表示名
  expect(mock.queries[0].query).toContain('ラジオボタン in ("サンプル１")');
  // 読み戻した値は既定名
  expect((results[0].result as { rows: Array<Record<string, string>> }).rows)
    .toEqual([{ $id: "1", ラジオボタン: "sample1" }]);
});

test("B205 AC3: GROUP BY のキーも既定名になる", async () => {
  const { results } = await run(
    `${header}SELECT ラジオボタン, COUNT(*) AS 件数 FROM APP1 GROUP BY ラジオボタン ORDER BY ラジオボタン ASC;`,
    canonical
  );
  const rows = (results[0].result as { rows: Array<Record<string, string>> }).rows;
  // 定義順（sample1, sample2）に並び、表示名を設定する前に入った値（sample9）は未知として後ろ
  expect(rows.map((row) => row.ラジオボタン)).toEqual(["sample1", "sample2", "sample9"]);
});

test("B205 AC2: SET に既定名を書くと、検査を通ってから表示名で書き込む", async () => {
  const { mock, results } = await run(
    `${header}UPDATE APP1 SET ラジオボタン = 'sample2' WHERE $id = 1;`, canonical
  );
  expect(results[0].status).toBe("success");
  expect(mock.writes).toHaveLength(1);
  expect(mock.writes[0].records[0]).toMatchObject({ ラジオボタン: { value: "サンプル２" } });
});

test("B205 AC5: どちらの表にも無い値はそのまま通す（表示名を設定する前に入った値）", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id FROM APP1 WHERE ラジオボタン = 'sample9';`, canonical
  );
  // 選択肢の定義に無い値は元から押し下げない（optionOrder に無い＝JS 評価に落ちる既存の動き）。
  // 大事なのは「例外にならず、読んだ値（既定名）に対して正しく当たる」こと。
  expect(mock.queries[0].query).not.toContain("ラジオボタン");
  expect((results[0].result as { rows: unknown[] }).rows).toEqual([{ $id: "3" }]);
});

test("B205: 言語ごとの表示名が無い項目は何も変わらない", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id FROM APP1 WHERE 処理状況 = '未処理';`, canonical
  );
  // 恒等の項目は値も並びもそのまま押し下がる（モックは 処理状況 を絞らないので件数は見ない）
  expect(mock.queries[0].query).toContain('処理状況 in ("未処理")');
  expect(results[0].status).toBe("success");
});

test("B205 AC4: optionNames を渡さなければ今までとまったく同じ（raw）", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id, ラジオボタン FROM APP1 WHERE ラジオボタン = 'サンプル１';`
  );
  // raw では getOptionNames を 1 回も呼ばない
  expect(mock.optionNameCalls).toEqual([]);
  // 表示名は optionOrder（既定名）に無いので押し下がらない＝JS 評価に落ちる（今までどおり）
  expect(mock.queries[0].query).not.toContain("ラジオボタン");
  // 読んだ値は変換しないので表示名のまま返る
  expect((results[0].result as { rows: Array<Record<string, string>> }).rows)
    .toEqual([{ $id: "1", ラジオボタン: "サンプル１" }]);
});

test("B205: 対応表はアプリごとに 1 回だけ取る", async () => {
  const { mock } = await run(
    `${header}SELECT $id FROM APP1 WHERE ラジオボタン = 'sample1';\nSELECT $id FROM APP1 WHERE ラジオボタン = 'sample2';`,
    canonical
  );
  expect(mock.optionNameCalls).toEqual([1]);
});

test("B205: getOptionNames が無いクライアントに canonical を渡すと createExecutionContext が拒む", () => {
  const mock = mockClient();
  const client = { ...(mock.value as unknown as Record<string, unknown>) };
  delete client.getOptionNames;
  const parsed = parseScript(`${header}SELECT $id FROM APP1;`);
  expect(() => createExecutionContext({
    client: client as unknown as FlowKintoneClient,
    statements: parsed.statements, meta: parsed.meta, ...canonical,
  })).toThrow("requires a client with getOptionNames");
});

test("B205: 一意に決まらない対応表は実行開始前に拒む（レコードを 1 件も読まない）", async () => {
  const mock = mockClient();
  const broken = {
    ...(mock.value as unknown as Record<string, unknown>),
    async getOptionNames(appId: number) {
      // 2 つの選択肢が同じ表示名（逆変換が多対一）
      return {
        appId,
        fields: [{
          code: "ラジオボタン", label: "", fieldType: "RADIO_BUTTON",
          optionOrder: { 同じ名前: 0, もう一つ: 1 },
        }],
        processEnabled: false,
        statusStates: null,
      };
    },
  } as unknown as FlowKintoneClient;
  const parsed = parseScript(`${header}SELECT $id FROM APP1 WHERE ラジオボタン = 'sample1';`);
  const context = createExecutionContext({
    client: broken, statements: parsed.statements, meta: parsed.meta, ...canonical,
  });
  await expect(executeStatement(parsed.statements[0], context)).rejects.toThrow("ArgumentError");
  await disposeExecutionContext(context);
  expect(mock.queries).toEqual([]);
});

test("B205: explainScript は canonical との併用を拒む（計画と実行がずれるため）", async () => {
  const mock = mockClient();
  await expect(explainScript(`${header}SELECT $id FROM APP1 WHERE ラジオボタン = 'sample1';`, {
    client: mock.value, optionNames: "canonical",
  } as never)).rejects.toThrow("does not support optionNames");
});

test("B205 AC7: ステータスも既定名で書ける（canonical では正本がキー側に変わる）", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id, ステータス FROM APP1 WHERE ステータス = '未処理';`, canonical
  );
  expect(results[0].status).toBe("success");
  // kintone へ送るのは表示名
  expect(mock.queries[0].query).toContain('ステータス in ("みしょり")');
  // 読み戻す値は既定名
  const rows = (results[0].result as { rows: Array<Record<string, string>> }).rows;
  expect(rows[0]).toMatchObject({ $id: "1", ステータス: "未処理" });
});

test("B205: raw のステータスは今までどおり表示名が正本", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id FROM APP1 WHERE ステータス = 'みしょり';`
  );
  expect(results[0].status).toBe("success");
  expect(mock.queries[0].query).toContain('ステータス in ("みしょり")');
});

test("B205: EXPLAIN 文を含むバッチは createExecutionContext が拒む（実行前に分かるから）", () => {
  const mock = mockClient();
  const parsed = parseScript(`${header}EXPLAIN SELECT $id FROM APP1 WHERE ラジオボタン = 'sample1';`);
  expect(() => createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, ...canonical,
  })).toThrow("EXPLAIN is not available with optionNames");
  // 弾いた時点でメタデータも取りに行かない
  expect(mock.optionNameCalls).toEqual([]);
});

test("B205: previewStatement も canonical を通る（差分の前後が既定名で揃う）", async () => {
  const { previewStatement } = await import("../index");
  const mock = mockClient();
  // 対象の絞りは $id で（選択肢の = は DML の押し下げ要件を満たさず preview 自体が使えない＝既存の動き）
  const parsed = parseScript(`${header}UPDATE APP1 SET ラジオボタン = 'sample2' WHERE $id = 1;`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, ...canonical,
  });
  const preview = await previewStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  // 差分の前後はどちらも既定名（読んだ値も SQL の値も canonical で揃う）
  // モックは $id を絞らないので 3 件（件数そのものはここでは見ない）
  expect(preview.counts.update).toBeGreaterThan(0);
  expect(preview.samples[0]).toMatchObject({
    kind: "update",
    before: { ラジオボタン: "sample1" },
    after: { ラジオボタン: "sample2" },
  });
  // 書き込みは 1 回も起きない
  expect(mock.writes).toEqual([]);
});
