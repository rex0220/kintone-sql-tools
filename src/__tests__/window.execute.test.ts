import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
}

function makeClient(records: KintoneRecord[], fields: KintoneFieldInfo[] = []): KintoneClient & {
  getCalls: Array<{ query: string; fields: string[] }>;
} {
  const getCalls: Array<{ query: string; fields: string[] }> = [];
  return {
    getCalls,
    async getRecords(params) {
      getCalls.push({ query: params.query ?? "", fields: [...(params.fields ?? [])] });
      return { records };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return fields; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() { return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }; },
  };
}

const sales = [
  record({ 顧客ID: "A", 受注日: "2026-01-01", 金額: "100" }),
  record({ 顧客ID: "A", 受注日: "2026-02-01", 金額: "200" }),
  record({ 顧客ID: "B", 受注日: "2026-01-15", 金額: "300" }),
  record({ 顧客ID: "B", 受注日: "2026-01-10", 金額: "250" }),
];

test("CTE 1文形で各グループの最新行を全列付きで取得し、外側 WHERE を押し込まない", async () => {
  const client = makeClient(sales, [
    { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
    { code: "受注日", label: "受注日", fieldType: "DATE", sortKind: "string" },
    { code: "金額", label: "金額", fieldType: "NUMBER", sortKind: "number" },
  ]);
  const result = await execute(
    "WITH ranked AS (" +
      "SELECT 顧客ID, 受注日, 金額, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300" +
    ") SELECT 顧客ID, 受注日, 金額 FROM ranked WHERE rn = 1",
    client,
    { cacheContext: "window-cte-latest" }
  ) as SelectResult;

  expect(result.rows).toEqual([
    { 顧客ID: "A", 受注日: "2026-02-01", 金額: "200" },
    { 顧客ID: "B", 受注日: "2026-01-15", 金額: "300" },
  ]);
  expect(client.getCalls.every((call) => !call.query.includes("rn"))).toBe(true);
});

test("SELECT しないウィンドウ ORDER BY キーを API 取得フィールドへ含める", async () => {
  const client = makeClient(sales, [
    { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "受注日", label: "受注日", fieldType: "DATE" },
  ]);
  await execute(
    "SELECT 顧客ID, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300",
    client,
    { cacheContext: "window-required-fields" }
  );
  expect(client.getCalls[0].fields).toEqual(expect.arrayContaining(["顧客ID", "受注日"]));
});

test("トップレベル ORDER BY なしでも物理 NUMBER メタで数値順位になる", async () => {
  const client = makeClient(
    [record({ 顧客No: "99" }), record({ 顧客No: "214" }), record({ 顧客No: "100" })],
    [{ code: "顧客No", label: "顧客No", fieldType: "NUMBER", sortKind: "number" }]
  );
  const result = await execute(
    "SELECT 顧客No, ROW_NUMBER() OVER (ORDER BY 顧客No DESC) AS rn FROM APP300",
    client,
    { cacheContext: "window-number-meta" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { 顧客No: "99", rn: "3" }, { 顧客No: "214", rn: "1" }, { 顧客No: "100", rn: "2" },
  ]);
});

test("ウィンドウNUMBER ORDER BYは16桁超を非peerとして順位付けする", async () => {
  const client = makeClient(
    [record({ n: "9007199254740993" }), record({ n: "9007199254740992" })],
    [{ code: "n", label: "n", fieldType: "NUMBER", sortKind: "number" }]
  );
  const result = await execute(
    "SELECT n, RANK() OVER (ORDER BY n) AS r FROM APP300",
    client,
    { cacheContext: "window-exact-decimal" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { n: "9007199254740993", r: "2" },
    { n: "9007199254740992", r: "1" },
  ]);
});

test("トップレベル ORDER BY なしでも選択肢定義順で順位付けする", async () => {
  const client = makeClient(
    [record({ 優先度: "中" }), record({ 優先度: "高" }), record({ 優先度: "低" })],
    [{
      code: "優先度", label: "優先度", fieldType: "DROP_DOWN", sortKind: "string",
      optionOrder: { 高: 0, 中: 1, 低: 2 },
    }]
  );
  const result = await execute(
    "SELECT 優先度, ROW_NUMBER() OVER (ORDER BY 優先度) AS rn FROM APP300",
    client,
    { cacheContext: "window-option-meta" }
  ) as SelectResult;
  expect(result.rows).toEqual([
    { 優先度: "中", rn: "2" }, { 優先度: "高", rn: "1" }, { 優先度: "低", rn: "3" },
  ]);
});

test("ウィンドウ評価後に DISTINCT とトップレベル ORDER BY を適用する", async () => {
  const client = makeClient(
    [record({ n: "1" }), record({ n: "1" }), record({ n: "2" })],
    [{ code: "n", label: "n", fieldType: "NUMBER", sortKind: "number" }]
  );
  const result = await execute(
    "SELECT DISTINCT RANK() OVER (ORDER BY n) AS r FROM APP300 ORDER BY r DESC",
    client,
    { cacheContext: "window-distinct-order" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ r: "3" }, { r: "1" }]);
});

test("EXPLAIN はウィンドウ CTE を FULL_SCAN としインライン化しない", async () => {
  const result = await execute(
    "EXPLAIN WITH ranked AS (" +
      "SELECT k, ROW_NUMBER() OVER (ORDER BY d DESC) AS rn FROM APP300" +
    ") SELECT k FROM ranked WHERE rn = 1",
    makeClient([], [
      { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" },
      { code: "d", label: "d", fieldType: "DATE" },
    ]),
    { cacheContext: "window-explain" }
  ) as SelectResult;
  const plan = result.rows.map((row) => row.plan);
  expect(plan.some((line) => line.includes("[cte: ranked]"))).toBe(true);
  expect(plan.some((line) => line.includes("mode") && line.includes("FULL_SCAN"))).toBe(true);
  expect(plan.some((line) => line.includes("ウィンドウ関数あり"))).toBe(true);
  expect(plan.some((line) => line.includes("effective: inlined CTE"))).toBe(false);
});

test("一時テーブルへ実体化したウィンドウ列は数値メタを保持する", async () => {
  const client = makeClient(sales, [
    { code: "顧客ID", label: "顧客ID", fieldType: "SINGLE_LINE_TEXT" },
    { code: "受注日", label: "受注日", fieldType: "DATE" },
  ]);
  const result = await executeBatch(
    "CREATE TEMP TABLE #ranked AS " +
      "SELECT 顧客ID, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日) AS rn FROM APP300;" +
    "SELECT MAX(rn) AS max_rn FROM #ranked",
    client,
    { cacheContext: "window-temp-meta" }
  );
  expect(result.ok).toBe(true);
  expect(result.statements[1].result).toMatchObject({ rows: [{ max_rn: "2" }] });
});

test("FROM なし OVER () は単一行へ 1 を付ける", async () => {
  const result = await execute(
    "SELECT ROW_NUMBER() OVER () AS rn",
    makeClient([]),
    { cacheContext: "window-no-from" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ rn: "1" }]);
});

test("B125: 集計引数を非表示でも取得し、既定 RANGE の peer 末尾値を返す", async () => {
  const client = makeClient([
    record({ product: "A", d: "2026-03-17", amount: "60" }),
    record({ product: "A", d: "2026-03-18", amount: "100" }),
    record({ product: "A", d: "2026-03-18", amount: "-30" }),
    record({ product: "A", d: "2026-03-18", amount: "-20" }),
  ], [
    { code: "product", label: "product", fieldType: "SINGLE_LINE_TEXT" },
    { code: "d", label: "d", fieldType: "DATE" },
    { code: "amount", label: "amount", fieldType: "NUMBER", sortKind: "number" },
  ]);
  const result = await execute(
    "SELECT product, SUM(amount) OVER (PARTITION BY product ORDER BY d) AS total FROM APP300",
    client,
    { cacheContext: "b125-fetch-and-range" }
  ) as SelectResult;
  expect(client.getCalls[0].fields).toEqual(expect.arrayContaining(["product", "d", "amount"]));
  expect(result.rows.map((row) => row.total)).toEqual(["60", "110", "110", "110"]);
});

test("B125: EXPLAIN は既定 RANGE と明示 RANGE を区別して表示する", async () => {
  const result = await execute(
    "EXPLAIN SELECT SUM(amount) OVER (ORDER BY d) AS implicit_frame, " +
      "SUM(amount) OVER (ORDER BY d RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS explicit_frame FROM APP300",
    makeClient([], [
      { code: "d", label: "d", fieldType: "DATE" },
      { code: "amount", label: "amount", fieldType: "NUMBER" },
    ]),
    { cacheContext: "b125-explain-frame" }
  ) as SelectResult;
  const plan = result.rows.map((row) => String(row.plan));
  expect(plan).toContain("    frame: RANGE UNBOUNDED PRECEDING AND CURRENT ROW (既定)");
  expect(plan).toContain("    frame: RANGE UNBOUNDED PRECEDING AND CURRENT ROW");
  expect(plan.filter((line) => line.includes("(既定)"))).toHaveLength(1);
});

test("B125: MIN 集計ウィンドウを一時テーブル化しても文字列メタを保持する", async () => {
  const client = makeClient([
    record({ k: "A", label: "20" }), record({ k: "A", label: "30" }),
    record({ k: "B", label: "3" }), record({ k: "B", label: "4" }),
  ], [
    { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" },
    { code: "label", label: "label", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
  ]);
  const result = await executeBatch(
    "CREATE TEMP TABLE #mins AS SELECT k, MIN(label) OVER (PARTITION BY k) AS min_label FROM APP300;" +
      "SELECT DISTINCT min_label FROM #mins ORDER BY min_label",
    client,
    { cacheContext: "b125-min-window-meta" }
  );
  expect(result.ok).toBe(true);
  expect(result.statements[1].result).toMatchObject({ rows: [{ min_label: "20" }, { min_label: "3" }] });
});

test("B125: ORDER BY 無しの集計ウィンドウは truncate で部分結果を返さない", async () => {
  const records = Array.from({ length: 101 }, (_, index) => record({ k: String(index % 2) }));
  await expect(execute(
    "SELECT k, COUNT(*) OVER (PARTITION BY k) AS n FROM APP300",
    makeClient(records, [{ code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" }]),
    { cacheContext: "b125-complete-input", maxRecords: 100, onLimitReached: "truncate" }
  )).rejects.toThrow(/AGGREGATE_WINDOW/);
});

test("B125: SELECT DISTINCT は集計ウィンドウ値を従来どおりキーへ含める", async () => {
  const result = await execute(
    "SELECT DISTINCT COUNT(*) OVER (PARTITION BY k) AS n FROM APP300 ORDER BY n",
    makeClient([
      record({ k: "A" }), record({ k: "A" }), record({ k: "B" }),
    ], [{ code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" }]),
    { cacheContext: "b125-distinct" }
  ) as SelectResult;
  expect(result.rows).toEqual([{ n: "1" }, { n: "2" }]);
});

test("B125: KORDER BY 併用は parser ではなく planner が拒否する", async () => {
  const client = makeClient([], [
    { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" },
    { code: "x", label: "x", fieldType: "NUMBER" },
  ]);
  await expect(execute(
    "SELECT k, SUM(x) OVER (PARTITION BY k) AS total FROM APP300 KORDER BY k LIMIT 1",
    client,
    { cacheContext: "b125-korder-rejection" }
  )).rejects.toThrow(/KORDER_QUERY_SHAPE_UNSUPPORTED/);
  expect(client.getCalls).toHaveLength(0);
});

describe("B127: aggregate window default RANGE warnings", () => {
  const fields: KintoneFieldInfo[] = [
    { code: "$id", label: "$id", fieldType: "RECORD_NUMBER" },
    { code: "d", label: "d", fieldType: "DATE" },
    { code: "amount", label: "amount", fieldType: "NUMBER" },
    { code: "items", label: "items", fieldType: "SUBTABLE" },
    { code: "itemDate", label: "itemDate", fieldType: "DATE", inSubtable: true, subtableCode: "items" },
    { code: "itemAmount", label: "itemAmount", fieldType: "NUMBER", inSubtable: true, subtableCode: "items" },
  ];
  const warningFor = (alias: string) =>
    `${alias} は既定フレーム（RANGE）で評価されます。ORDER BY の値が同じ行はすべて同じ値になります。` +
    "行ごとの値が必要なら ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示するか、" +
    "ORDER BY にレコード番号などのタイブレークキーを足してください。";

  test("単一物理表の既定 RANGE は alias ごとに警告する", async () => {
    const result = await execute(
      "SELECT SUM(amount) OVER (ORDER BY d) AS cumulative FROM APP300",
      makeClient([], fields),
      { cacheContext: "b127-default-range" }
    ) as SelectResult;
    expect(result.warnings).toEqual([warningFor("cumulative")]);
  });

  test.each([
    ["明示 ROWS", "SUM(amount) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"],
    ["明示 RANGE", "SUM(amount) OVER (ORDER BY d RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"],
    ["ORDER BY なし", "SUM(amount) OVER ()"],
    ["順位系", "RANK() OVER (ORDER BY d)"],
  ])("%s は警告しない", async (_label, expression) => {
    const result = await execute(
      `SELECT ${expression} AS w FROM APP300`,
      makeClient([], fields),
      { cacheContext: `b127-no-warning-${_label}` }
    ) as SelectResult;
    expect(result.warnings).toEqual([]);
  });

  test("単一物理表で $id または RECORD_NUMBER を含む全順序は抑止する", async () => {
    for (const tieBreak of ["$id", "recordNo"]) {
      const result = await execute(
        `SELECT SUM(amount) OVER (ORDER BY d, ${tieBreak}) AS cumulative FROM APP300`,
        makeClient([], [
          ...fields,
          { code: "recordNo", label: "recordNo", fieldType: "RECORD_NUMBER" },
        ]),
        { cacheContext: `b127-total-order-${tieBreak}` }
      ) as SelectResult;
      expect(result.warnings).toEqual([]);
    }
  });

  test.each([
    ["JOIN", "SELECT SUM(a.amount) OVER (ORDER BY a.d, a.$id) AS cumulative FROM APP300 a JOIN APP301 b ON a.$id = b.$id"],
    ["subtable", "SELECT SUM(itemAmount) OVER (ORDER BY itemDate, $id) AS cumulative FROM APP300$items"],
    ["CTE", "WITH x AS (SELECT d, amount, $id FROM APP300) SELECT SUM(amount) OVER (ORDER BY d, $id) AS cumulative FROM x"],
    ["UNION", "SELECT SUM(amount) OVER (ORDER BY d, $id) AS cumulative FROM APP300 UNION ALL SELECT SUM(amount) OVER (ORDER BY d, $id) AS cumulative FROM APP301"],
  ])("%s 経由では全順序に見えても抑止しない", async (_label, sql) => {
    const result = await execute(
      sql,
      makeClient([], fields),
      { cacheContext: `b127-unsafe-source-${_label}` }
    ) as SelectResult;
    // 固定するのは「抑止されないこと」。末尾のタイブレーク助言は経路で変わる（B140-C）ので、
    // 助言そのものは専用のテストで見る。
    expect(result.warnings?.some((warning) =>
      warning.startsWith("cumulative は既定フレーム（RANGE）で評価されます。")
    )).toBe(true);
  });
});

describe("B128: LAG / LEAD execution", () => {
  const fields: KintoneFieldInfo[] = [
    { code: "$id", label: "$id", fieldType: "RECORD_NUMBER", sortKind: "number" },
    { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT", sortKind: "string" },
    { code: "d", label: "d", fieldType: "DATE", sortKind: "string" },
    { code: "x", label: "x", fieldType: "NUMBER", sortKind: "number" },
  ];

  test("境界・offset 0/2/999・パーティション・空セルをそのまま扱う", async () => {
    const result = await execute(
      "SELECT k, d, " +
        "LAG(x) OVER (PARTITION BY k ORDER BY d) AS prev, " +
        "LEAD(x) OVER (PARTITION BY k ORDER BY d) AS next, " +
        "LAG(x, 0) OVER (PARTITION BY k ORDER BY d) AS self, " +
        "LAG(x, 2) OVER (PARTITION BY k ORDER BY d) AS prev2, " +
        "LAG(x, 999) OVER (PARTITION BY k ORDER BY d) AS far FROM APP300",
      makeClient([
        record({ k: "A", d: "2026-01-01", x: "10" }),
        record({ k: "A", d: "2026-02-01", x: "" }),
        record({ k: "A", d: "2026-03-01", x: "30" }),
        record({ k: "B", d: "2026-01-01", x: "40" }),
      ], fields),
      { cacheContext: "b128-value-semantics" }
    ) as SelectResult;
    expect(result.rows).toEqual([
      { k: "A", d: "2026-01-01", prev: "", next: "", self: "10", prev2: "", far: "" },
      { k: "A", d: "2026-02-01", prev: "10", next: "30", self: "", prev2: "", far: "" },
      { k: "A", d: "2026-03-01", prev: "", next: "", self: "30", prev2: "10", far: "" },
      { k: "B", d: "2026-01-01", prev: "", next: "", self: "40", prev2: "", far: "" },
    ]);
  });

  test("引数にしか現れない物理フィールドを取得する", async () => {
    const client = makeClient([
      record({ d: "2026-01-01", x: "10" }), record({ d: "2026-02-01", x: "20" }),
    ], fields);
    const result = await execute(
      "SELECT d, LAG(x) OVER (ORDER BY d) AS prev FROM APP300",
      client,
      { cacheContext: "b128-required-arg" }
    ) as SelectResult;
    expect(client.getCalls[0].fields).toEqual(expect.arrayContaining(["d", "x"]));
    expect(result.rows.map((row) => row.prev)).toEqual(["", "10"]);
  });

  test("LAG(NUMBER) のメタを次段 ORDER BY と MIN/MAX へ伝播する", async () => {
    const client = makeClient([
      record({ d: "2026-01-01", x: "2" }), record({ d: "2026-02-01", x: "10" }),
      record({ d: "2026-03-01", x: "100" }), record({ d: "2026-04-01", x: "20" }),
    ], fields);
    const result = await execute(
      "WITH w AS (SELECT LAG(x) OVER (ORDER BY d) AS prev FROM APP300) " +
        "SELECT prev FROM w ORDER BY prev",
      client,
      { cacheContext: "b128-number-meta" }
    ) as SelectResult;
    expect(result.rows.map((row) => row.prev)).toEqual(["", "2", "10", "100"]);
    const extremes = await execute(
      "WITH w AS (SELECT LAG(x) OVER (ORDER BY d) AS prev FROM APP300) " +
        "SELECT MIN(prev) AS min_prev, MAX(prev) AS max_prev FROM w WHERE prev > 0",
      client,
      { cacheContext: "b128-number-extremes" }
    ) as SelectResult;
    expect(extremes.rows).toEqual([{ min_prev: "2", max_prev: "100" }]);
  });

  test("direct APP の LAG(選択肢) を次段で定義順に並べる", async () => {
    const result = await execute(
      "WITH w AS (SELECT LAG(priority) OVER (ORDER BY d) AS prev FROM APP300) SELECT prev FROM w ORDER BY prev",
      makeClient([
        record({ d: "2026-01-01", priority: "低" }), record({ d: "2026-02-01", priority: "高" }),
        record({ d: "2026-03-01", priority: "中" }), record({ d: "2026-04-01", priority: "低" }),
      ], [
        ...fields,
        { code: "priority", label: "priority", fieldType: "DROP_DOWN", sortKind: "string", optionOrder: { 高: 0, 中: 1, 低: 2 } },
      ]),
      { cacheContext: "b128-option-meta" }
    ) as SelectResult;
    expect(result.rows.map((row) => row.prev)).toEqual(["", "高", "中", "低"]);
  });

  test.each([
    ["DATE", ["2026-01-01", "2024-01-01", "2025-01-01", "2027-01-01"], ["", "2024-01-01", "2025-01-01", "2026-01-01"]],
    ["SINGLE_LINE_TEXT", ["20", "3", "100", "z"], ["", "100", "20", "3"]],
  ] as const)("LAG(%s) のメタを次段 ORDER BY へ伝播する", async (fieldType, values, expected) => {
    const result = await execute(
      "WITH w AS (SELECT LAG(value) OVER (ORDER BY seq) AS prev FROM APP300) SELECT prev FROM w ORDER BY prev",
      makeClient(values.map((value, index) => record({ seq: String(index), value })), [
        { code: "seq", label: "seq", fieldType: "NUMBER", sortKind: "number" },
        { code: "value", label: "value", fieldType, sortKind: "string" },
      ]),
      { cacheContext: `b128-${fieldType.toLowerCase()}-meta` }
    ) as SelectResult;
    expect(result.rows.map((row) => row.prev)).toEqual(expected);
  });

  test("VALUE window は完全入力理由 WINDOW_ORDER を使う", async () => {
    await expect(execute(
      "SELECT LAG(x) OVER (ORDER BY d) AS prev FROM APP300",
      makeClient(Array.from({ length: 101 }, (_, index) => record({ d: String(index), x: String(index) })), fields),
      { cacheContext: "b128-complete-input", maxRecords: 100, onLimitReached: "truncate" }
    )).rejects.toThrow(/WINDOW_ORDER/);
  });

  test("非全順序の VALUE window は同順内未規定を警告する", async () => {
    const result = await execute(
      "SELECT LAG(x) OVER (ORDER BY d) AS prev FROM APP300",
      makeClient([], fields),
      { cacheContext: "b128-warning" }
    ) as SelectResult;
    expect(result.warnings).toEqual([
      "prev の ORDER BY は全順序でないため、同順内の前後関係は未規定です。" +
      "レコード番号等を ORDER BY に追加してください。",
    ]);
  });

  test("direct APP の全順序だけ警告を抑止し、JOIN / CTE では抑止しない", async () => {
    const direct = await execute(
      "SELECT LAG(x) OVER (ORDER BY d, $id) AS prev FROM APP300",
      makeClient([], fields),
      { cacheContext: "b128-warning-direct" }
    ) as SelectResult;
    expect(direct.warnings).toEqual([]);

    const join = await execute(
      "SELECT LAG(a.x) OVER (ORDER BY a.d, a.$id) AS prev " +
        "FROM APP300 a JOIN APP301 b ON a.$id = b.$id",
      makeClient([], fields),
      { cacheContext: "b128-warning-join" }
    ) as SelectResult;
    expect(join.warnings?.[0]).toContain("同順内の前後関係は未規定");

    const cte = await execute(
      "WITH source AS (SELECT x, d, $id FROM APP300) " +
        "SELECT LAG(x) OVER (ORDER BY d, $id) AS prev FROM source",
      makeClient([], fields),
      { cacheContext: "b128-warning-cte" }
    ) as SelectResult;
    expect(cte.warnings?.some((warning) => warning.includes("同順内の前後関係は未規定"))).toBe(true);
  });

  test("B140-C: CTE / 一時テーブル経由では実行できない助言を出さない", async () => {
    // 従来は CTE 経由でも「ORDER BY にレコード番号などのタイブレークキーを足してください」と
    // 案内していたが、CTE には レコード番号 が無いため、従うと
    // unknown field code(s): レコード番号 で落ちる（実測・v3.51.0）。
    // 「読み飛ばされる」より悪く、従うと壊れる助言だった。
    const cteAdvice = "その表の中で一意になる列（元の集約のキーなど）を ORDER BY に含めてください。";
    const directAdvice = "ORDER BY にレコード番号などのタイブレークキーを足してください。";

    const cteValue = await execute(
      "WITH source AS (SELECT x, d FROM APP300) " +
        "SELECT LAG(x) OVER (ORDER BY d) AS prev FROM source",
      makeClient([], fields),
      { cacheContext: "b140c-cte-value" }
    ) as SelectResult;
    expect(cteValue.warnings?.some((w) => w.endsWith(cteAdvice))).toBe(true);
    expect(cteValue.warnings?.some((w) => w.includes("レコード番号"))).toBe(false);

    const cteRange = await execute(
      "WITH source AS (SELECT x, d FROM APP300) " +
        "SELECT SUM(x) OVER (ORDER BY d) AS cumulative FROM source",
      makeClient([], fields),
      { cacheContext: "b140c-cte-range" }
    ) as SelectResult;
    expect(cteRange.warnings?.some((w) => w.endsWith(cteAdvice))).toBe(true);
    expect(cteRange.warnings?.some((w) => w.includes("レコード番号"))).toBe(false);

    // direct APP は レコード番号 が実在するので従来どおり案内する（回帰）。
    const direct = await execute(
      "SELECT SUM(x) OVER (ORDER BY d) AS cumulative FROM APP300",
      makeClient([], fields),
      { cacheContext: "b140c-direct" }
    ) as SelectResult;
    expect(direct.warnings?.some((w) => w.endsWith(directAdvice))).toBe(true);
  });

  test("CASE 引数を各行 1 回評価し、LAG / LEAD と soft keyword フィールドを併用する", async () => {
    const result = await execute(
      "SELECT LAG, LEAD, " +
        "LAG(CASE WHEN flag = 'Y' THEN x ELSE 0 END, 2) OVER (ORDER BY d) AS prev2, " +
        "LEAD(x) OVER (ORDER BY d) AS next FROM APP300",
      makeClient([
        record({ d: "1", x: "10", flag: "Y", LAG: "field-lag-1", LEAD: "field-lead-1" }),
        record({ d: "2", x: "20", flag: "N", LAG: "field-lag-2", LEAD: "field-lead-2" }),
        record({ d: "3", x: "30", flag: "Y", LAG: "field-lag-3", LEAD: "field-lead-3" }),
      ], [
        ...fields,
        { code: "flag", label: "flag", fieldType: "SINGLE_LINE_TEXT" },
        { code: "LAG", label: "LAG", fieldType: "SINGLE_LINE_TEXT" },
        { code: "LEAD", label: "LEAD", fieldType: "SINGLE_LINE_TEXT" },
      ]),
      { cacheContext: "b128-case-soft-keyword" }
    ) as SelectResult;
    expect(result.rows).toEqual([
      { LAG: "field-lag-1", LEAD: "field-lead-1", prev2: "", next: "20" },
      { LAG: "field-lag-2", LEAD: "field-lead-2", prev2: "", next: "30" },
      { LAG: "field-lag-3", LEAD: "field-lead-3", prev2: "10", next: "" },
    ]);
  });

  test("順位・集計・VALUE window を別 ORDER BY で混在させ、DISTINCT を後段適用する", async () => {
    const result = await execute(
      "SELECT DISTINCT " +
        "ROW_NUMBER() OVER (ORDER BY d DESC) AS rn, " +
        "SUM(x) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total, " +
        "LAG(x) OVER (ORDER BY x) AS prev FROM APP300",
      makeClient([
        record({ d: "1", x: "10" }), record({ d: "2", x: "20" }), record({ d: "3", x: "30" }),
      ], fields),
      { cacheContext: "b128-window-mix-distinct" }
    ) as SelectResult;
    expect(result.rows).toEqual([
      { rn: "3", total: "10", prev: "" },
      { rn: "2", total: "30", prev: "10" },
      { rn: "1", total: "60", prev: "20" },
    ]);
  });
});
