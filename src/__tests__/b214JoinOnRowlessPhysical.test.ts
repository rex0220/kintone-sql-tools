import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import { applyJoin, type ProcessRow } from "../engine/process";
import type { JoinClause } from "../types/ast";

// B214（KJ-12）: ON を「JOIN 先の列 = FROM 側の列」の順に書くと、JOIN 先の物理 APP の取得が
// 0 件のときに「JOIN key … is not available in the materialized table」で止まっていた。
// B166 の試験は `in (...)` を無視して全件を返す代役だったので 0 件の形が出なかった。
// ここでは代役を本物に寄せる: `in (...)` で絞り、`fields` で列を絞り、limit / offset で切る。

const FIELDS: Readonly<Record<number, readonly string[]>> = {
  1: ["キー", "名"],
  2: ["明細キー", "数"],
  3: ["コード", "値"],
  4: ["区分"],
};

function record(id: number, values: Readonly<Record<string, string>>): KintoneRecord {
  return {
    $id: { value: String(id) },
    ...Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }])),
  } as KintoneRecord;
}

type Data = Readonly<Record<number, readonly KintoneRecord[]>>;

function strictClient(
  data: Data,
  options: { readonly emptyFieldsApps?: readonly number[] } = {}
): KintoneClient & { readonly posted: KintoneRecord[]; readonly queries: Array<{ app: number; query: string }> } {
  const posted: KintoneRecord[] = [];
  const queries: Array<{ app: number; query: string }> = [];
  return {
    posted,
    queries,
    async getRecords(params) {
      let rows = [...(data[params.app] ?? [])];
      const query = params.query ?? "";
      queries.push({ app: params.app, query });
      for (const match of query.matchAll(/([^\s()"]+) in \(([^)]*)\)/g)) {
        const field = match[1];
        const values = [...match[2].matchAll(/"([^"]*)"/g)].map((value) => value[1]);
        rows = rows.filter((row) => values.includes(String((row[field] as { value: unknown })?.value ?? "")));
      }
      const offset = Number(/offset (\d+)/.exec(query)?.[1] ?? 0);
      const limit = /limit (\d+)/.exec(query);
      rows = rows.slice(offset, limit ? offset + Number(limit[1]) : undefined);
      const fields = params.fields ?? [];
      const records = fields.length === 0
        ? rows
        : rows.map((row) => Object.fromEntries(
          Object.entries(row).filter(([code]) => fields.includes(code))
        ) as KintoneRecord);
      return { records };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      posted.push(...params.records);
      return { ids: params.records.map((_, index) => String(index + 1)) };
    },
    async putRecords() { /* noop */ },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields(appId) {
      if (options.emptyFieldsApps?.includes(appId)) return [];
      return (FIELDS[appId] ?? []).map((code): KintoneFieldInfo => ({
        code,
        label: code,
        fieldType: "SINGLE_LINE_TEXT",
      }));
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

const LEFT_ROWS = [record(1, { キー: "A", 名: "a" }), record(2, { キー: "B", 名: "b" })];
const RIGHT_STATES: ReadonlyArray<readonly [string, readonly KintoneRecord[]]> = [
  ["空", []],
  ["当たらない", [record(11, { 明細キー: "Z", 数: "9" })]],
  ["当たる", [record(11, { 明細キー: "A", 数: "1" }), record(12, { 明細キー: "Z", 数: "9" })]],
];
const LEFT_STATES: ReadonlyArray<readonly [string, readonly KintoneRecord[]]> = [
  ["左あり", LEFT_ROWS],
  ["左が空", []],
];
const JOIN_TYPES = ["INNER", "LEFT", "RIGHT"] as const;
type JoinType = typeof JOIN_TYPES[number];

let counter = 0;
const ctx = (name: string) => `b214-${name}-${counter++}`;

type Route = {
  readonly name: string;
  readonly run: (data: Data, joinType: JoinType, reversed: boolean) => Promise<SelectResult>;
};

function on(reversed: boolean): string {
  return reversed ? "o.明細キー = t.キー" : "t.キー = o.明細キー";
}

const ROUTES: readonly Route[] = [
  {
    name: "物理→物理",
    run: async (data, joinType, reversed) => execute(
      `SELECT t.キー, o.明細キー, o.数 FROM APP1 AS t ${joinType} JOIN APP2 AS o ON ${on(reversed)}`,
      strictClient(data),
      { cacheContext: ctx("physical") }
    ) as Promise<SelectResult>,
  },
  {
    name: "一時テーブル→物理",
    run: async (data, joinType, reversed) => {
      const batch = await executeBatch(
        "CREATE TEMP TABLE #t AS SELECT キー FROM APP1;" +
          `SELECT t.キー, o.明細キー, o.数 FROM #t AS t ${joinType} JOIN APP2 AS o ON ${on(reversed)}`,
        strictClient(data),
        { cacheContext: ctx("temp") }
      );
      if (!batch.ok) throw new Error(batch.statements.find((s) => s.error)?.error?.message ?? "batch failed");
      return batch.statements[1].result as SelectResult;
    },
  },
  {
    name: "CTE→物理",
    run: async (data, joinType, reversed) => execute(
      "WITH k AS (SELECT キー FROM APP1) " +
        `SELECT t.キー, o.明細キー, o.数 FROM k AS t ${joinType} JOIN APP2 AS o ON ${on(reversed)}`,
      strictClient(data),
      { cacheContext: ctx("cte") }
    ) as Promise<SelectResult>,
  },
];

describe("B214 JOIN ON の向きと 0 件の物理 APP", () => {
  const cases = ROUTES.flatMap((route) => JOIN_TYPES.flatMap((joinType) => LEFT_STATES.flatMap(
    ([leftLabel, leftRows]) => RIGHT_STATES.map(([rightLabel, rightRows]) =>
      [route.name, joinType, leftLabel, rightLabel, route, { 1: leftRows, 2: rightRows }] as const)
  )));

  test.each(cases)(
    "%s %s JOIN・%s・右 %s: 逆順 ON でも止まらず順方向と同じ結果",
    async (_route, joinType, _leftLabel, _rightLabel, route, data) => {
      const forward = await route.run(data, joinType, false);
      const reversed = await route.run(data, joinType, true);
      expect(reversed.rows).toEqual(forward.rows);
      expect(reversed.columns).toEqual(forward.columns);
    }
  );

  test("依頼の形: 新しい受注だけ（当たらない）でも INNER JOIN は 0 行で続く", async () => {
    const result = await ROUTES[1].run({ 1: LEFT_ROWS, 2: RIGHT_STATES[1][1] }, "INNER", true);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual(["キー", "明細キー", "数"]);
  });

  test("依頼の形: 右が空（最初の取り込み）の LEFT JOIN は左の行が空文字で残る", async () => {
    const result = await ROUTES[1].run({ 1: LEFT_ROWS, 2: [] }, "LEFT", true);
    expect(result.rows).toEqual([
      { キー: "A", 明細キー: "", 数: "" },
      { キー: "B", 明細キー: "", 数: "" },
    ]);
  });

  describe("3 表の連鎖: 真ん中の物理 APP が 0 件で、次の ON が真ん中を指す", () => {
    const sql = (reversed: boolean) =>
      "SELECT t.キー, o.明細キー, p.値 FROM APP1 AS t " +
      "LEFT JOIN APP2 AS o ON t.キー = o.明細キー " +
      `LEFT JOIN APP3 AS p ON ${reversed ? "p.コード = o.明細キー" : "o.明細キー = p.コード"}`;
    const third = [record(21, { コード: "A", 値: "pa" })];

    test.each([false, true])("逆順 %s: 真ん中が「当たらない」ときと同じ結果", async (reversed) => {
      const empty = await execute(sql(reversed), strictClient({ 1: LEFT_ROWS, 2: [], 3: third }), {
        cacheContext: ctx("chain-empty"),
      }) as SelectResult;
      const unmatched = await execute(sql(reversed), strictClient({
        1: LEFT_ROWS, 2: [record(11, { 明細キー: "Z", 数: "9" })], 3: third,
      }), { cacheContext: ctx("chain-unmatched") }) as SelectResult;
      expect(empty.rows).toEqual(unmatched.rows);
      expect(empty.rows).toEqual([
        { キー: "A", 明細キー: "", 値: "" },
        { キー: "B", 明細キー: "", 値: "" },
      ]);
    });

    test.each([false, true])("逆順 %s: 3 つ目に空のキーの行があれば、空文字どうしで当たる（B153）", async (reversed) => {
      const withEmpty = [...third, record(22, { コード: "", 値: "pe" })];
      const empty = await execute(sql(reversed), strictClient({ 1: LEFT_ROWS, 2: [], 3: withEmpty }), {
        cacheContext: ctx("chain-empty-key"),
      }) as SelectResult;
      const unmatched = await execute(sql(reversed), strictClient({
        1: LEFT_ROWS, 2: [record(11, { 明細キー: "Z", 数: "9" })], 3: withEmpty,
      }), { cacheContext: ctx("chain-empty-key-unmatched") }) as SelectResult;
      expect(empty.rows).toEqual(unmatched.rows);
      expect(empty.rows).toEqual([
        { キー: "A", 明細キー: "", 値: "pe" },
        { キー: "B", 明細キー: "", 値: "pe" },
      ]);
    });

    test("次の ON が 0 件の表の存在しない列（$ で始まる）を指すと、従来どおり止まる", async () => {
      await expect(execute(
        "SELECT t.キー FROM APP1 AS t LEFT JOIN APP2 AS o ON t.キー = o.明細キー " +
          "LEFT JOIN APP3 AS p ON o.$typo = p.コード",
        strictClient({ 1: LEFT_ROWS, 2: [], 3: third }),
        { cacheContext: ctx("chain-typo") }
      )).rejects.toThrow(/JOIN key o\.\$typo is not available/);
    });

    test("0 件の表の項目定義が取れない（空）なら、行の検査を飛ばさず従来どおり止まる", async () => {
      await expect(execute(
        sql(false),
        strictClient({ 1: LEFT_ROWS, 2: [], 3: third }, { emptyFieldsApps: [2] }),
        { cacheContext: ctx("chain-no-defs") }
      )).rejects.toThrow(/JOIN key o\.明細キー is not available/);
    });
  });

  describe("B215: 前の外部結合で空文字に埋まる表のキーで、次の INNER JOIN の相手を絞る", () => {
    const empty = [record(31, { コード: "", 値: "empty-match" })];
    const rightThenInner =
      "SELECT o.明細キー, p.値 FROM APP1 AS t RIGHT JOIN APP2 AS o ON t.キー = o.明細キー " +
      "INNER JOIN APP3 AS p ON t.キー = p.コード";

    test.each([
      ["APP1 が 0 件", [] as readonly KintoneRecord[]],
      ["APP1 に当たらない行がある", [record(1, { キー: "Q", 名: "q" })]],
    ])("RIGHT → INNER（%s）: 埋めた空文字が 3 つ目の空のキーと当たる（RIGHT → LEFT と同じ）", async (_label, left) => {
      const data: Data = { 1: left, 2: [record(11, { 明細キー: "Z", 数: "9" })], 3: empty };
      const inner = await execute(rightThenInner, strictClient(data), { cacheContext: ctx("right-inner") }) as SelectResult;
      const outer = await execute(rightThenInner.replace("INNER JOIN APP3", "LEFT JOIN APP3"), strictClient(data), {
        cacheContext: ctx("right-left"),
      }) as SelectResult;
      expect(inner.rows).toEqual([{ 明細キー: "Z", 値: "empty-match" }]);
      expect(inner.rows).toEqual(outer.rows);
    });

    test("LEFT → INNER（真ん中が一時テーブル）: 絞り込みの in に空文字を足す", async () => {
      const client = strictClient({
        1: LEFT_ROWS, 2: [record(11, { 明細キー: "Z", 数: "9" })], 3: [...empty, record(32, { コード: "Q", 値: "q" })],
      });
      const batch = await executeBatch(
        "CREATE TEMP TABLE #o AS SELECT 明細キー FROM APP2;" +
          "SELECT t.キー, p.値 FROM APP1 AS t LEFT JOIN #o AS o ON t.キー = o.明細キー " +
          "INNER JOIN APP3 AS p ON o.明細キー = p.コード",
        client,
        { cacheContext: ctx("left-inner-temp") }
      );
      expect(batch.ok).toBe(true);
      expect((batch.statements[1].result as SelectResult).rows).toEqual([
        { キー: "A", 値: "empty-match" },
        { キー: "B", 値: "empty-match" },
      ]);
      expect(client.queries.filter((call) => call.app === 3).map((call) => call.query).join("\n"))
        .toContain('コード in ("Z","")');
    });

    test("外部結合が前に無ければ空文字を足さない（従来どおりの絞り込み）", async () => {
      const client = strictClient({ 1: LEFT_ROWS, 2: RIGHT_STATES[2][1] });
      await execute(
        "SELECT t.キー, o.数 FROM APP1 AS t INNER JOIN APP2 AS o ON o.明細キー = t.キー",
        client,
        { cacheContext: ctx("no-outer") }
      );
      const query = client.queries.filter((call) => call.app === 2).map((call) => call.query).join("\n");
      expect(query).toContain('明細キー in ("A","B")');
      expect(query).not.toContain('""');
    });

    test("外部結合の後に空の CROSS JOIN で行が消えたら空文字を足さない（要らない全件取得をしない）", async () => {
      const client = strictClient({
        1: [record(1, { キー: "A", 名: "a" })], 2: [], 4: [],
        3: [record(31, { コード: "x", 値: "x" }), record(32, { コード: "y", 値: "y" })],
      });
      const batch = await executeBatch(
        "CREATE TEMP TABLE #o AS SELECT 明細キー FROM APP2;" +
          "CREATE TEMP TABLE #q AS SELECT 区分 FROM APP4;" +
          "SELECT t.キー FROM APP1 AS t LEFT JOIN #o AS o ON t.キー = o.明細キー " +
          "CROSS JOIN #q AS q INNER JOIN APP3 AS p ON o.明細キー = p.$id",
        client,
        { cacheContext: ctx("empty-cross"), maxRecords: 1 }
      );
      expect(batch.ok).toBe(true);
      expect((batch.statements[2].result as SelectResult).rows).toEqual([]);
      expect(client.queries.filter((call) => call.app === 3)).toEqual([]);
    });

    test("空の CROSS JOIN の後でも、RIGHT JOIN で行が戻れば空文字を足して当てる", async () => {
      const client = strictClient({
        1: [record(1, { キー: "A", 名: "a" })], 2: [],
        4: [record(41, { 区分: "R" })],
        3: [...empty, record(32, { コード: "y", 値: "y" })],
      });
      const batch = await executeBatch(
        "CREATE TEMP TABLE #o AS SELECT 明細キー FROM APP2;" +
          "CREATE TEMP TABLE #q AS SELECT 区分 FROM APP4 WHERE 区分 in ('none');" +
          "CREATE TEMP TABLE #r AS SELECT 区分 FROM APP4;" +
          "SELECT r.区分, p.値 FROM APP1 AS t LEFT JOIN #o AS o ON t.キー = o.明細キー " +
          "CROSS JOIN #q AS q RIGHT JOIN #r AS r ON q.区分 = r.区分 " +
          "INNER JOIN APP3 AS p ON o.明細キー = p.コード",
        client,
        { cacheContext: ctx("cross-then-right") }
      );
      expect(batch.ok).toBe(true);
      expect((batch.statements[3].result as SelectResult).rows).toEqual([{ 区分: "R", 値: "empty-match" }]);
      expect(client.queries.filter((call) => call.app === 3).map((call) => call.query).join("\n"))
        .toContain('コード in ("")');
    });

    test("in (\"\") を受けない型（$id）は、空文字を足すと JOIN 先を全件読む", async () => {
      const client = strictClient({
        1: LEFT_ROWS, 2: [record(11, { 明細キー: "31", 数: "1" })], 3: empty,
      });
      const batch = await executeBatch(
        "CREATE TEMP TABLE #o AS SELECT 明細キー FROM APP2;" +
          "SELECT t.キー FROM APP1 AS t LEFT JOIN #o AS o ON t.キー = o.明細キー " +
          "INNER JOIN APP3 AS p ON o.明細キー = p.$id",
        client,
        { cacheContext: ctx("id-fallback") }
      );
      expect(batch.ok).toBe(true);
      const queries = client.queries.filter((call) => call.app === 3).map((call) => call.query);
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.join("\n")).not.toContain(" in (");
    });

    test.each([
      ["300 個の空でないキー", 300, false, true],
      ["299 個の空でないキー ＋ 空のキー", 299, true, false],
    ])("%s に空文字を足すと、空文字も 1 キーとして 300 の上限に数える", async (_label, count, withEmpty, overLimit) => {
      const keys = Array.from({ length: count }, (_, index) => `K${String(index + 1).padStart(3, "0")}`);
      const middle = [
        ...keys.map((key, index) => record(100 + index, { 明細キー: key, 数: "1" })),
        ...(withEmpty ? [record(999, { 明細キー: "", 数: "1" })] : []),
      ];
      const client = strictClient({ 1: LEFT_ROWS, 2: middle, 3: empty });
      const batch = await executeBatch(
        "CREATE TEMP TABLE #o AS SELECT 明細キー FROM APP2;" +
          "SELECT t.キー, p.値 FROM APP1 AS t LEFT JOIN #o AS o ON t.キー = o.明細キー " +
          "INNER JOIN APP3 AS p ON o.明細キー = p.コード",
        client,
        { cacheContext: ctx(`limit-${count}`) }
      );
      expect(batch.ok).toBe(true);
      const result = batch.statements[1].result as SelectResult;
      const queries = client.queries.filter((call) => call.app === 3).map((call) => call.query).join("\n");
      if (overLimit) {
        expect(result.warnings?.join("\n") ?? "").toContain("JOINキーが 301 件");
        expect(queries).not.toContain(" in (");
      } else {
        expect(result.warnings?.join("\n") ?? "").not.toContain("JOINキーが");
        expect(queries).toContain('""');
      }
      expect(result.rows).toEqual([
        { キー: "A", 値: "empty-match" },
        { キー: "B", 値: "empty-match" },
      ]);
    });

    test("EXPLAIN: 元が物理 APP なら実行時に決まる（runtime candidate のまま・records API 0 回）", async () => {
      const client = strictClient({ 1: LEFT_ROWS, 2: [], 3: empty });
      const result = await execute(
        "EXPLAIN SELECT t.キー, p.値 FROM APP1 AS t LEFT JOIN APP2 AS o ON t.キー = o.明細キー " +
          "INNER JOIN APP3 AS p ON o.明細キー = p.コード",
        client,
        { cacheContext: ctx("explain-runtime") }
      ) as SelectResult;
      const text = result.rows.map((row) => row.plan).join("\n");
      expect(text).toContain("join key prefilter reason: JOIN_KEY_VALUES_RUNTIME");
      expect(client.queries).toEqual([]);
    });

    test("EXPLAIN も実行と同じく空文字を足した in を表示する（records API 0 回）", async () => {
      const client = strictClient({ 1: LEFT_ROWS, 3: empty });
      const result = await execute(
        "EXPLAIN WITH s AS (GENERATE_SERIES(1,2) AS 数) " +
          "SELECT t.キー, p.値 FROM APP1 AS t LEFT JOIN s ON t.キー = s.数 INNER JOIN APP3 AS p ON s.数 = p.コード",
        client,
        { cacheContext: ctx("explain") }
      ) as SelectResult;
      const text = result.rows.map((row) => row.plan).join("\n");
      expect(text).toContain('コード in ("1","2","")');
      expect(client.queries).toEqual([]);
    });
  });

  describe("文としての SELECT 以外の入口も同じ口を通る", () => {
    const data: Data = { 1: LEFT_ROWS, 2: [] };

    test("CREATE TEMP TABLE の元", async () => {
      const batch = await executeBatch(
        "CREATE TEMP TABLE #t AS SELECT キー FROM APP1;" +
          "CREATE TEMP TABLE #j AS SELECT t.キー, o.明細キー AS 既存 FROM #t AS t INNER JOIN APP2 AS o ON o.明細キー = t.キー;" +
          "SELECT COUNT(*) AS n FROM #j",
        strictClient(data),
        { cacheContext: ctx("ctas") }
      );
      expect(batch.ok).toBe(true);
      expect((batch.statements[2].result as SelectResult).rows).toEqual([{ n: "0" }]);
    });

    test("ASSERT のサブクエリ", async () => {
      const batch = await executeBatch(
        "-- @ksql dialect: 1\n" +
          "CREATE TEMP TABLE #t AS SELECT キー FROM APP1;\n" +
          "ASSERT (SELECT COUNT(*) FROM #t AS t INNER JOIN APP2 AS o ON o.明細キー = t.キー) = 0, 'x';\n" +
          "SELECT 1 AS ok",
        strictClient(data),
        { cacheContext: ctx("assert") }
      );
      expect(batch.ok).toBe(true);
    });

    test("IN (SELECT …) の中の JOIN", async () => {
      const result = await execute(
        "SELECT コード FROM APP3 WHERE コード IN " +
          "(SELECT t.キー FROM APP1 AS t INNER JOIN APP2 AS o ON o.明細キー = t.キー)",
        strictClient({ ...data, 3: [record(21, { コード: "A", 値: "pa" })] }),
        { cacheContext: ctx("in-subquery") }
      ) as SelectResult;
      expect(result.rows).toEqual([]);
    });

    test("INSERT … SELECT の元", async () => {
      const client = strictClient(data);
      const batch = await executeBatch(
        "INSERT INTO APP3 (コード) SELECT t.キー FROM APP1 AS t LEFT JOIN APP2 AS o ON o.明細キー = t.キー",
        client,
        { cacheContext: ctx("insert") }
      );
      expect(batch.ok).toBe(true);
      expect(client.posted.map((row) => (row["コード"] as { value: string }).value)).toEqual(["A", "B"]);
    });
  });

  describe("存在しない列は従来どおり止まる", () => {
    test("物理 APP の列は取得の前に項目定義で拒否する（右が 0 件でも）", async () => {
      await expect(execute(
        "SELECT t.キー FROM APP1 AS t INNER JOIN APP2 AS o ON o.無い列 = t.キー",
        strictClient({ 1: LEFT_ROWS, 2: [] }),
        { cacheContext: ctx("typo-physical") }
      )).rejects.toThrow("ArgumentError: unknown field code(s): 無い列 (APP2)");
    });

    test("実体化した表の列は 0 行でも保存済みの列で拒否する", async () => {
      const batch = await executeBatch(
        "CREATE TEMP TABLE #t AS SELECT キー FROM APP1;" +
          "SELECT t.キー FROM #t AS t LEFT JOIN APP2 AS o ON o.明細キー = t.無い列",
        strictClient({ 1: [], 2: RIGHT_STATES[2][1] }),
        { cacheContext: ctx("typo-materialized") }
      );
      expect(batch.ok).toBe(false);
      expect(batch.statements[1].error?.message).toContain("t.無い列");
    });
  });
});

describe("B214 applyJoin の単体", () => {
  const reversedJoin: JoinClause = {
    type: "INNER",
    table: { appId: 2, alias: "o", cteName: null },
    on: {
      left: { tableAlias: "o", field: "明細キー" },
      right: { tableAlias: "t", field: "キー" },
    },
  } as JoinClause;
  const leftRows: ProcessRow[] = [{ "t.キー": "A", キー: "A" }];

  test("右が 0 行でも sideAliases で向きを決める", () => {
    expect(() => applyJoin(leftRows, [], reversedJoin)).toThrow(/JOIN key o\.明細キー is not available/);
    expect(applyJoin(leftRows, [], reversedJoin, {
      sideAliases: { left: new Set(["t"]), right: new Set(["o"]) },
    })).toEqual([]);
    expect(applyJoin(leftRows, [], { ...reversedJoin, type: "LEFT" } as JoinClause, {
      sideAliases: { left: new Set(["t"]), right: new Set(["o"]) },
    })).toEqual(leftRows);
  });

  test("行の無い物理 APP の、項目定義で確かめた列だけ行で検査しない", () => {
    const chainJoin: JoinClause = {
      type: "LEFT",
      table: { appId: 3, alias: "p", cteName: null },
      on: {
        left: { tableAlias: "o", field: "明細キー" },
        right: { tableAlias: "p", field: "コード" },
      },
    } as JoinClause;
    const right: ProcessRow[] = [{ "p.コード": "A", コード: "A" }];
    const sides = { left: new Set(["t", "o"]), right: new Set(["p"]) };
    expect(() => applyJoin(leftRows, right, chainJoin, { sideAliases: sides }))
      .toThrow(/JOIN key o\.明細キー is not available/);
    expect(applyJoin(leftRows, right, chainJoin, {
      sideAliases: sides,
      rowlessVerifiedFields: new Map([["o", new Set(["明細キー"])]]),
    })).toEqual([{ ...leftRows[0], "p.コード": "", コード: "" }]);
    expect(() => applyJoin(leftRows, right, chainJoin, {
      sideAliases: sides,
      rowlessVerifiedFields: new Map([["o", new Set(["別の列"])]]),
    })).toThrow(/JOIN key o\.明細キー is not available/);
  });
});
