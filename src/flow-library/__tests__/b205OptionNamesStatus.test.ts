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
/** アプリ 2 は**別の表示名**（アプリごとに引き分けられているかを見るため）。 */
const STATUS_DISPLAY_APP2: Record<string, string> = {
  未処理: "未A", 処理中: "中A", 完了: "済A",
};
const displayMapFor = (app: number) => app === 2 ? STATUS_DISPLAY_APP2 : STATUS_DISPLAY;

const FIELDS = [
  { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
  { code: "メモ", label: "メモ", fieldType: "SINGLE_LINE_TEXT", writable: true },
];

/** プロセス管理の状態は `lang: "user"` で取るので `name` は**表示名**。 */
const processStatesFor = (app: number) => {
  const display = displayMapFor(app);
  return [
    { name: display.未処理, index: 0 },
    { name: display.処理中, index: 1 },
    { name: display.完了, index: 2 },
  ];
};

function mockClient(statusCanonicals: readonly string[], processEnabled = true) {
  const queries: Array<{ app: number; query: string }> = [];
  const processStatusCalls: number[] = [];
  /**
   * kintone に入っている値は**表示名**。
   * **プロセス管理が無効なアプリのレコードには STATUS が入らない**
   * （3 回目の実装レビューの MINOR。B88 の実測 3 アプリと一致）。
   */
  const rowsOfApp = (app: number): Rec[] => {
    const display = displayMapFor(app);
    const base = app === 2
      ? [
          { $id: { value: "11" }, $revision: { value: "1" }, ステータス: { value: display.未処理 }, メモ: { value: "x" } },
          { $id: { value: "12" }, $revision: { value: "1" }, ステータス: { value: display.完了 }, メモ: { value: "y" } },
        ]
      : [
          { $id: { value: "1" }, $revision: { value: "1" }, ステータス: { value: display.未処理 }, メモ: { value: "x" } },
          { $id: { value: "2" }, $revision: { value: "1" }, ステータス: { value: display.処理中 }, メモ: { value: "y" } },
          { $id: { value: "3" }, $revision: { value: "1" }, ステータス: { value: display.完了 }, メモ: { value: "z" } },
        ];
    if (processEnabled) return base;
    return base.map(({ ステータス: _status, ...rest }) => rest) as Rec[];
  };
  /** 既定名がクエリに出たら kintone と同じように突き返す（番人モック）。 */
  const filtered = (app: number, query: string): Rec[] => {
    for (const canonical of Object.keys(STATUS_DISPLAY)) {
      if (query.includes(`"${canonical}"`)) {
        throw new Error(
          `GAIA_CU03: ステータス「${canonical}」が見つかりません（query=${query}）`
        );
      }
    }
    const rows = rowsOfApp(app);
    const match = /ステータス in \(([^)]*)\)/.exec(query);
    if (!match) return rows;
    const wanted = new Set([...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]));
    return rows.filter((record) => wanted.has(String(record.ステータス?.value)));
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
    async getFields() { return FIELDS; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses(appId: number) {
      processStatusCalls.push(appId);
      return processEnabled ? { enable: true, states: processStatesFor(appId) } : { enable: false, states: null };
    },
    async getOptionNames(appId: number) {
      return {
        appId,
        fields: FIELDS,
        processEnabled,
        statusStates: processEnabled
          ? statusCanonicals.map((canonical, index) => ({
              canonical, display: displayMapFor(appId)[canonical], index,
            }))
          : null,
      };
    },
  } as unknown as FlowKintoneClient;
  return { value, queries, processStatusCalls };
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string, statusCanonicals: readonly string[], processEnabled = true) {
  const mock = mockClient(statusCanonicals, processEnabled);
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

// 2 回目の実装レビューの MAJOR: 順序表は **preflight の 1 枚のスナップショット**から作る。
// 同じ endpoint を 2 回取って突き合わせると、取得の間の設定変更で正しい応答同士が落ちる。
test("B205: 順序表は preflight の 1 枚から作る（getProcessStatuses を呼ばない）", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id FROM APP1 WHERE ステータス >= '処理中' ORDER BY $id ASC;`,
    ALL
  );
  expect(results[0].status).toBe("success");
  // preflight が app/status.json を取っているので、改めて取らない
  expect(mock.processStatusCalls).toEqual([]);
  expect(rowsOf(results[0].result)).toEqual([{ $id: "2" }, { $id: "3" }]);
});

// **実 API の形**（2026-11-06 にアプリ 4392 で確認）: プロセス管理を使っていないアプリでも
// form/fields は STATUS 項目を返す。項目の有無で判定すると**ふつうのアプリが全部拒まれる**
// ＝2 回目の実装レビューの BLOCKER。判定は app/status.json の enable で行う。
test("B205: プロセス管理が無効（STATUS 項目はある）でも canonical は通る", async () => {
  const { results } = await run(
    `${header}SELECT $id, メモ FROM APP1 ORDER BY $id ASC;`,
    ALL, false
  );
  expect(results[0].status).toBe("success");
  expect(rowsOf(results[0].result)).toEqual([
    { $id: "1", メモ: "x" }, { $id: "2", メモ: "y" }, { $id: "3", メモ: "z" },
  ]);
});

// 3 回目の調査で見つけた穴（直した）: ORDER BY の項目意味解決が `process.states`（表示名）から
// 順序表を作っていたので、読み戻した既定名が当たらず「未知の帯」に落ちていた。
test("B205: ORDER BY ステータス が定義順になる（既定名の順序表で並ぶ）", async () => {
  const { results } = await run(
    `${header}SELECT $id FROM APP1 ORDER BY ステータス DESC;`,
    ALL
  );
  expect(results[0].status).toBe("success");
  expect(rowsOf(results[0].result)).toEqual([{ $id: "3" }, { $id: "2" }, { $id: "1" }]);
});

test("B205: WHERE ステータス IN は既定名で書いて表示名で押し下がる", async () => {
  const { mock, results } = await run(
    `${header}SELECT $id FROM APP1 WHERE ステータス IN ('未処理');`,
    ALL
  );
  expect(results[0].status).toBe("success");
  expect(mock.queries.some((entry) => entry.query.includes('ステータス in ("みしょり")'))).toBe(true);
  expect(rowsOf(results[0].result)).toEqual([{ $id: "1" }]);
});

test("B205: UPDATE の対象選択にステータスを使える（既定名で書く）", async () => {
  const { mock, results } = await run(
    `${header}UPDATE APP1 SET メモ = 'z' WHERE ステータス IN ('未処理');`,
    ALL
  );
  expect(results[0].status).toBe("success");
  expect(mock.queries.some((entry) => entry.query.includes('ステータス in ("みしょり")'))).toBe(true);
});

test("B205: ステータスの = も既定名で書けて表示名で押し下がる（= は in に正規化される）", async () => {
  const { mock, results } = await run(`${header}SELECT $id FROM APP1 WHERE ステータス = '未処理';`, ALL);
  expect(results[0].status).toBe("success");
  expect(mock.queries.some((entry) => entry.query.includes('ステータス in ("みしょり")'))).toBe(true);
  expect(rowsOf(results[0].result)).toEqual([{ $id: "1" }]);
  // 選択肢の = は DML では WHERE_RESIDUAL になるが、ステータスは in に正規化されるので通る
  const update = await run(`${header}UPDATE APP1 SET メモ = 'z' WHERE ステータス = '未処理';`, ALL);
  expect(update.results[0].status).toBe("success");
});

// 3 回目の実装レビューの MAJOR: typed pushdown の存在集合が表示名のままだと、
// canonical のステータス条件が「実在しない値」と判定されて**押し下げから外れ、全件取得に退行**する
// （JOIN では maxRecords に当たって失敗し得る）。アプリごとの表示名で押し下がることを固定する。
test("B205: 2 アプリ JOIN のステータス条件が、それぞれの表示名で押し下がる", async () => {
  const { mock, results } = await run(
    `${header}SELECT a.$id AS a_id, b.$id AS b_id FROM APP1 a JOIN APP2 b ON a.メモ = b.メモ\n`
    + "WHERE a.ステータス IN ('未処理') AND b.ステータス IN ('未処理') ORDER BY a.$id ASC;",
    ALL
  );
  expect(results[0].status).toBe("success");
  const app1 = mock.queries.filter((entry) => entry.app === 1);
  const app2 = mock.queries.filter((entry) => entry.app === 2);
  // アプリ 1 は「みしょり」、アプリ 2 は「未A」。取り違えたらここで落ちる
  expect(app1.some((entry) => entry.query.includes('ステータス in ("みしょり")'))).toBe(true);
  expect(app2.some((entry) => entry.query.includes('ステータス in ("未A")'))).toBe(true);
  expect(app1.every((entry) => !entry.query.includes('"未A"'))).toBe(true);
  expect(app2.every((entry) => !entry.query.includes('"みしょり"'))).toBe(true);
  expect(rowsOf(results[0].result)).toEqual([{ a_id: "1", b_id: "11" }]);
});

test("B205: プロセス管理が無効ならレコードにステータスが無い（SELECT * にも出ない）", async () => {
  const { results } = await run(`${header}SELECT * FROM APP1 ORDER BY $id ASC;`, ALL, false);
  expect(results[0].status).toBe("success");
  const columns = (results[0].result as { columns: string[] }).columns;
  expect(columns).not.toContain("ステータス");
  expect(columns).toContain("メモ");
});
