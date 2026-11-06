import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowKintoneClient,
} from "../index";

type Rec = Record<string, { value: unknown }>;

/**
 * B205 のステータス（プロセス管理）側。`app/status.json` は **キーが既定名・`name` が表示名**で、
 * `lang` を付けても**キーは変わらない**（依頼 KJ-8 の検算 §2）。
 *
 * ここで固定するのは 2 つ:
 *
 * 1. canonical では**既定名で書いた順序比較**（`ステータス >= '処理中'`）が通り、読み戻す値も既定名。
 * 2. クライアントが**一部のステータスしか**返さないときに**止まる**（実装レビューの MAJOR）。
 *    止めないと「ステータスだけ表示名のまま」という一部だけ canonical な状態になる。
 */
const STATUS_DISPLAY: Record<string, string> = {
  未処理: "みしょり", 処理中: "しょりちゅう", 完了: "かんりょう",
};

const FIELDS = [
  { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
  { code: "メモ", label: "メモ", fieldType: "SINGLE_LINE_TEXT", writable: true },
];

/** プロセス管理の状態は `lang: "user"` で取るので `name` は**表示名**。 */
const PROCESS_STATES = [
  { name: STATUS_DISPLAY.未処理, index: 0 },
  { name: STATUS_DISPLAY.処理中, index: 1 },
  { name: STATUS_DISPLAY.完了, index: 2 },
];

function mockClient(statusCanonicals: readonly string[]) {
  const queries: string[] = [];
  /** kintone に入っている値は**表示名** */
  const rows: Rec[] = [
    { $id: { value: "1" }, $revision: { value: "1" }, ステータス: { value: STATUS_DISPLAY.未処理 }, メモ: { value: "x" } },
    { $id: { value: "2" }, $revision: { value: "1" }, ステータス: { value: STATUS_DISPLAY.処理中 }, メモ: { value: "y" } },
    { $id: { value: "3" }, $revision: { value: "1" }, ステータス: { value: STATUS_DISPLAY.完了 }, メモ: { value: "z" } },
  ];
  const value = {
    async getRecords(params: { query: string; totalCount?: boolean }) {
      queries.push(params.query);
      return params.totalCount ? { records: rows, totalCount: String(rows.length) } : { records: rows };
    },
    async openCursor(params: { query: string }) {
      queries.push(params.query);
      return { totalCount: rows.length, async nextPage() { return { records: rows, next: false }; }, async close() {} };
    },
    async postRecords(params: { records: unknown[] }) {
      return { ids: params.records.map((_, index) => String(900 + index)) };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() { return FIELDS; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: true, states: PROCESS_STATES }; },
    async getOptionNames(appId: number) {
      return {
        appId,
        fields: FIELDS,
        statusStates: statusCanonicals.map((canonical, index) => ({
          canonical, display: STATUS_DISPLAY[canonical], index,
        })),
      };
    },
  } as unknown as FlowKintoneClient;
  return { value, queries };
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string, statusCanonicals: readonly string[]) {
  const mock = mockClient(statusCanonicals);
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

const rowsOf = (result: unknown) => (result as { rows: Array<Record<string, string>> }).rows;
const ALL = ["未処理", "処理中", "完了"] as const;

test("B205: ステータスを既定名で書いて順序比較でき、読み戻す値も既定名", async () => {
  const { results } = await run(
    `${header}SELECT $id, ステータス FROM APP1 WHERE ステータス >= '処理中' ORDER BY $id ASC;`,
    ALL
  );
  expect(results[0].status).toBe("success");
  expect(rowsOf(results[0].result)).toEqual([
    { $id: "2", ステータス: "処理中" },
    { $id: "3", ステータス: "完了" },
  ]);
});

// 対応表の食い違いは文のエラー（結果の中）ではなく **ArgumentError として投げる**
// （設定の誤りなので、`ON ERROR SKIP` などで飲み込ませない）。
test("B205: クライアントが一部のステータスしか返さなければ止まる", async () => {
  await expect(run(
    `${header}SELECT $id FROM APP1 WHERE ステータス >= '処理中';`,
    ["未処理", "処理中"]
  )).rejects.toThrow("is missing from the localized status names");
});

test("B205: ステータスの件数が合わなければ止まる（余計な名称を返すクライアント）", async () => {
  await expect(run(
    `${header}SELECT $id FROM APP1 WHERE ステータス >= '処理中';`,
    [...ALL, "保留"]
  )).rejects.toThrow("process statuses but the client returned");
});
