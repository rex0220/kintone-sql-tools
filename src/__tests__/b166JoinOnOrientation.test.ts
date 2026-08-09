import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

function record(values: Readonly<Record<string, string>>): KintoneRecord {
  return Object.fromEntries(Object.entries(values).map(([code, value]) => [code, { value }]));
}

const rowsByApp: Readonly<Record<number, readonly KintoneRecord[]>> = {
  1: [
    record({ pkey: "K1", pvalue: "P1" }),
    record({ pkey: "K2", pvalue: "P2" }),
  ],
  2: [
    record({ ckey: "K1", cvalue: "C1" }),
    record({ ckey: "K3", cvalue: "C3" }),
  ],
  3: [
    record({ parent: "ROOT", child: "A" }),
    record({ parent: "A", child: "B" }),
  ],
};

function makeClient(): KintoneClient & { readonly calls: Array<{ app: number; query: string }> } {
  const calls: Array<{ app: number; query: string }> = [];
  return {
    calls,
    async getRecords(params) {
      calls.push({ app: params.app, query: params.query });
      return { records: [...(rowsByApp[params.app] ?? [])] };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { return { ids: [] }; },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields(appId) {
      const codes = new Set((rowsByApp[appId] ?? []).flatMap((row) => Object.keys(row)));
      return [...codes].map((code): KintoneFieldInfo => ({
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

type Route = {
  readonly name: string;
  readonly run: (joinType: "INNER" | "LEFT" | "RIGHT", reversed: boolean) => Promise<SelectResult>;
};

function selectSql(
  from: string,
  join: string,
  joinType: "INNER" | "LEFT" | "RIGHT",
  reversed: boolean,
  prefix = ""
): string {
  const on = reversed ? "c.ckey = p.pkey" : "p.pkey = c.ckey";
  return `${prefix}SELECT p.pvalue, c.cvalue FROM ${from} ${joinType} JOIN ${join} ON ${on}`;
}

function routes(): Route[] {
  return [
    {
      name: "物理×物理",
      run: async (joinType, reversed) => execute(
        selectSql("APP1 p", "APP2 c", joinType, reversed),
        makeClient(),
        { cacheContext: `b166-physical-${joinType}-${reversed}` }
      ) as Promise<SelectResult>,
    },
    {
      name: "CTE×CTE",
      run: async (joinType, reversed) => execute(
        selectSql(
          "parents p",
          "children c",
          joinType,
          reversed,
          "WITH parents AS (SELECT pkey,pvalue FROM APP1), " +
            "children AS (SELECT ckey,cvalue FROM APP2) "
        ),
        makeClient(),
        { cacheContext: `b166-cte-cte-${joinType}-${reversed}` }
      ) as Promise<SelectResult>,
    },
    {
      name: "CTE×物理",
      run: async (joinType, reversed) => execute(
        selectSql(
          "parents p",
          "APP2 c",
          joinType,
          reversed,
          "WITH parents AS (SELECT pkey,pvalue FROM APP1) "
        ),
        makeClient(),
        { cacheContext: `b166-cte-physical-${joinType}-${reversed}` }
      ) as Promise<SelectResult>,
    },
    {
      name: "一時テーブル×物理",
      run: async (joinType, reversed) => {
        const batch = await executeBatch(
          "CREATE TEMP TABLE #parents AS SELECT pkey,pvalue FROM APP1;" +
            selectSql("#parents p", "APP2 c", joinType, reversed),
          makeClient(),
          { cacheContext: `b166-temp-${joinType}-${reversed}` }
        );
        expect(batch.ok).toBe(true);
        return batch.statements[1].result as SelectResult;
      },
    },
  ];
}

describe("B166 JOIN ON orientation", () => {
  test.each(routes().flatMap((route) => (["INNER", "LEFT", "RIGHT"] as const)
    .map((joinType) => [route.name, joinType, route.run] as const)))(
    "逆順 ON の %s %s JOIN は順方向と同じ結果と保存側を保つ",
    async (_route, joinType, run) => {
      const forward = await run(joinType, false);
      const reversed = await run(joinType, true);
      expect(reversed.rows).toEqual(forward.rows);
      expect(reversed.columns).toEqual(forward.columns);
      expect(reversed.rowCount).toBe(forward.rowCount);
      expect(reversed.rowCount).toBe(joinType === "INNER" ? 1 : 2);
      if (joinType === "LEFT") expect(reversed.rows).toContainEqual({ pvalue: "P2", cvalue: "" });
      if (joinType === "RIGHT") expect(reversed.rows).toContainEqual({ pvalue: "", cvalue: "C3" });
    }
  );

  test("B53 再帰項の JOIN 側を ON 左辺に置いても展開できる", async () => {
    const result = await execute(`WITH RECURSIVE tree (parent, child, depth) AS (
      SELECT parent, child, 1 FROM APP3
      UNION ALL
      SELECT b.parent, b.child, e.depth + 1
      FROM tree e INNER JOIN APP3 b ON b.parent = e.child
    ) SELECT parent, child, depth FROM tree`, makeClient(), {
      cacheContext: "b166-recursive-reversed",
    }) as SelectResult;

    expect(result.rows).toEqual([
      { parent: "ROOT", child: "A", depth: "1" },
      { parent: "A", child: "B", depth: "1" },
      { parent: "A", child: "B", depth: "2" },
    ]);
  });

  test("逆順 ON でも B150 targeted IN の向きと内容は変わらない", async () => {
    const run = async (reversed: boolean) => {
      const client = makeClient();
      const result = await execute(
        selectSql("APP1 p", "APP2 c", "INNER", reversed),
        client,
        { cacheContext: `b166-pushdown-${reversed}` }
      ) as SelectResult;
      return {
        rows: result.rows,
        targetQueries: client.calls.filter((call) => call.app === 2).map((call) => call.query),
      };
    };
    const forward = await run(false);
    const reversed = await run(true);
    expect(reversed).toEqual(forward);
    expect(reversed.targetQueries.join("\n")).toContain('ckey in ("K1","K2")');
  });

  test("逆順 ON の実在しない materialized key は従来の JOIN key エラーで拒否する", async () => {
    await expect(execute(
      "WITH parents AS (SELECT pkey,pvalue FROM APP1) " +
        "SELECT p.pvalue,c.cvalue FROM parents p INNER JOIN APP2 c ON c.ckey=p.missing",
      makeClient(),
      { cacheContext: "b166-missing" }
    )).rejects.toThrow("ArgumentError: JOIN key p.missing is not available in the materialized table.");
  });
});
