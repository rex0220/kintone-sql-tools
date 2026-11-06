import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  previewStatement,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

/**
 * B205 の**番人モック**（実装レビューの MAJOR）。
 *
 * 本物の kintone は「言語ごとの表示名」を設定した選択肢を**表示名でしか**受け付けない。
 * そこで、**既定名がクエリや書き込みに現れたら即座に失敗する**モックで、
 * 変換を通っていない経路（REST 窓・KORDER・UPDATE / DELETE の対象選択・VALIDATE・UPDATE … FROM）を
 * 自動的に露出させる。甘いモックだと「送っているのに気づかない」ため。
 */
const CANONICAL = ["a1", "a2"] as const;
const DISPLAY: Record<string, string> = { a1: "甲", a2: "乙" };

const fieldsFor = (lang: "default" | "user") => [
  {
    code: "選択", label: "選択", fieldType: "DROP_DOWN", writable: true,
    optionOrder: lang === "user" ? { 甲: 0, 乙: 1 } : { a1: 0, a2: 1 },
  },
  { code: "メモ", label: "メモ", fieldType: "SINGLE_LINE_TEXT", writable: true },
];

function strictClient() {
  const queries: Array<{ app: number; query: string }> = [];
  const writes: Array<{ app: number; kind: "POST" | "PUT" | "DELETE"; payload: unknown }> = [];
  const rowsOf = (app: number): Rec[] => app === 1
    ? [
        { $id: { value: "1" }, $revision: { value: "1" }, 選択: { value: "甲" }, メモ: { value: "x" } },
        { $id: { value: "2" }, $revision: { value: "1" }, 選択: { value: "乙" }, メモ: { value: "y" } },
      ]
    : [
        { $id: { value: "11" }, $revision: { value: "1" }, 選択: { value: "甲" }, メモ: { value: "P" } },
      ];

  /** 既定名がクエリに出たら kintone と同じように突き返す（これが番人の本体）。 */
  const assertNoCanonicalInQuery = (query: string): void => {
    for (const name of CANONICAL) {
      if (query.includes(`"${name}"`)) {
        throw new Error(
          `GAIA_CU03: 項目名「${name}」が見つかりません。項目名に「言語ごとの名称」を設定している場合、`
          + `画面の表示言語に設定している言語の項目名を指定してください（query=${query}）`
        );
      }
    }
  };
  /** 書き込む値に既定名が出たら 400 を返す（kintone の実際の動き）。 */
  const assertNoCanonicalInRecord = (record: unknown): void => {
    const json = JSON.stringify(record ?? {});
    for (const name of CANONICAL) {
      if (json.includes(`"${name}"`)) {
        throw new Error(`400 入力内容が正しくありません（選択肢「${name}」は定義されていません）`);
      }
    }
  };
  const filtered = (app: number, query: string): Rec[] => {
    assertNoCanonicalInQuery(query);
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
    async postRecords(params: { app: number; records: unknown[] }) {
      params.records.forEach(assertNoCanonicalInRecord);
      writes.push({ app: params.app, kind: "POST", payload: params.records });
      return { ids: params.records.map((_, index) => String(900 + index)) };
    },
    async putRecords(params: { app: number; records: Array<{ record: unknown }> }) {
      params.records.forEach((entry) => assertNoCanonicalInRecord(entry.record));
      writes.push({ app: params.app, kind: "PUT", payload: params.records });
    },
    async deleteRecords(params: { app: number; ids: unknown }) {
      writes.push({ app: params.app, kind: "DELETE", payload: params.ids });
    },
    async getApps() { return []; },
    async getFields() { return fieldsFor("default"); },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
    async getOptionNames(appId: number) {
      return { appId, fields: fieldsFor("user"), statusStates: null };
    },
  } as unknown as FlowKintoneClient;
  return { value, queries, writes };
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string) {
  const mock = strictClient();
  const parsed = parseScript(sql);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta,
    optionNames: "canonical",
  });
  const results = [];
  try {
    for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  } finally {
    await disposeExecutionContext(context);
  }
  return { mock, results };
}

/** 文の結果がエラーなら、その中身を見せて落とす（番人モックの叫びを読めるように）。 */
const expectAllSuccess = (results: Array<{ status: string; error?: { message: string } }>): void => {
  const bad = results.find((result) => result.status === "error");
  if (bad) throw new Error(`statement failed: ${bad.error?.message}`);
};

test("B205 厳格: REST 窓つき SELECT（LIMIT）でも表示名で送る", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id FROM APP1 WHERE 選択 = 'a1' LIMIT 1;`
  );
  expectAllSuccess(results);
  expect(mock.queries.some((entry) => entry.query.includes('選択 in ("甲")'))).toBe(true);
  expect((results[0].result as { rows: unknown[] }).rows).toEqual([{ $id: "1" }]);
});

test("B205 厳格: KORDER BY のカーソルのクエリも表示名で送る", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id FROM APP1 WHERE 選択 = 'a1' KORDER BY $id ASC LIMIT 1;`
  );
  expectAllSuccess(results);
  expect(mock.queries.some((entry) => entry.query.includes('選択 in ("甲")'))).toBe(true);
});

test("B205 厳格: UPDATE の対象選択も表示名で送る", async () => {
  const { mock, results } = await run(
    `${header}UPDATE APP1 SET メモ = 'changed' WHERE 選択 IN ('a1');`
  );
  expectAllSuccess(results);
  expect(mock.queries.some((entry) => entry.query.includes('選択 in ("甲")'))).toBe(true);
  expect(mock.writes.filter((write) => write.kind === "PUT")).toHaveLength(1);
});

test("B205 厳格: DELETE の対象選択も表示名で送る", async () => {
  const { mock, results } = await run(
    `${header}DELETE FROM APP1 WHERE 選択 IN ('a1');`
  );
  expectAllSuccess(results);
  expect(mock.queries.some((entry) => entry.query.includes('選択 in ("甲")'))).toBe(true);
  expect(mock.writes.filter((write) => write.kind === "DELETE")).toHaveLength(1);
});

test("B205 厳格: previewStatement の対象選択も表示名で送る", async () => {
  const mock = strictClient();
  const parsed = parseScript(`${header}UPDATE APP1 SET メモ = 'changed' WHERE 選択 IN ('a1');`);
  const context = createExecutionContext({
    client: mock.value, statements: parsed.statements, meta: parsed.meta, optionNames: "canonical",
  });
  const preview = await previewStatement(parsed.statements[0], context);
  await disposeExecutionContext(context);
  expect(mock.queries.some((entry) => entry.query.includes('選択 in ("甲")'))).toBe(true);
  expect(preview.counts.update).toBe(1);
  // preview では書き込まない
  expect(mock.writes).toEqual([]);
});

test("B205 厳格: VALIDATE ONLY INTO でも対象選択と書き込む値が揃う", async () => {
  const { mock, results } = await run(
    `${header}UPDATE APP1 SET 選択 = 'a2' WHERE 選択 IN ('a1') VALIDATE ONLY INTO #err;\n`
    + "SELECT $err_code FROM #err;"
  );
  expectAllSuccess(results);
  expect(mock.queries.some((entry) => entry.query.includes('選択 in ("甲")'))).toBe(true);
  // VALIDATE ONLY なので書き込まない
  expect(mock.writes).toEqual([]);
});

test("B205 厳格: UPDATE … FROM の対象側の絞り込みも表示名で送る", async () => {
  // 結合キーに選択肢は使えない（下の試験）ので、対象側の絞り込み（targetFilter）で確かめる
  const { mock, results } = await run(
    `${header}UPDATE APP1 SET メモ = s.メモ FROM APP2 s WHERE APP1.メモ = s.メモ AND APP1.選択 IN ('a1');`
  );
  expectAllSuccess(results);
  const app1Queries = mock.queries.filter((entry) => entry.app === 1);
  expect(app1Queries.some((entry) => entry.query.includes('選択 in ("甲")'))).toBe(true);
});

test("B205 厳格（既存の制限の記録）: UPDATE … FROM の結合キーに選択肢は使えない", async () => {
  const { results } = await run(
    `${header}UPDATE APP1 SET メモ = s.メモ FROM APP2 s WHERE APP1.選択 = s.選択;`
  );
  expect(results[0].status).toBe("error");
  expect(results[0].error?.message).toContain("does not support target join field type DROP_DOWN");
});

test("B205 厳格（既存の制限の記録）: DML の対象選択に選択肢の = は raw でも書けない", async () => {
  // WHERE_RESIDUAL で実行前に拒否される（kintone の query が選択肢に = を持たないため）。
  // B205 の穴ではなく元からの制限。IN で書けば押し下がる（上の試験）。
  const { results } = await run(`${header}UPDATE APP1 SET メモ = 'z' WHERE 選択 = 'a1';`);
  expect(results[0].status).toBe("error");
  expect(results[0].error?.message).toContain("WHERE_RESIDUAL");
});

// ============================================================
// canonical でも「表示名で書く」形は通さない（正本は既定名のまま）
// ============================================================

test("B205 厳格: canonical でも SET に表示名を書いたら拒む（検査は既定名のまま）", async () => {
  const { results } = await run(`${header}UPDATE APP1 SET 選択 = '甲' WHERE 選択 IN ('a1');`);
  expect(results[0].status).toBe("error");
  // optionOrder（既定名）に無いので、送る前にエンジンが止める
  expect(results[0].error?.message).toContain("定義外の選択肢があります");
});

test("B205 厳格: canonical では WHERE に表示名を書いても当たらない（0 件）", async () => {
  const { results } = await run(`${header}SELECT $id FROM APP1 WHERE 選択 = '甲';`);
  expectAllSuccess(results);
  // 読み戻す値は既定名（a1）なので、表示名のリテラルとは一致しない
  expect((results[0].result as { rows: unknown[] }).rows).toEqual([]);
});
