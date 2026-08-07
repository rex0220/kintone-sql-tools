import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  execute,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";

type GetRecordsParams = Parameters<KintoneClient["getRecords"]>[0];

const MASTER = 45201;
const TRANSACTION = 45202;

function record(values: Readonly<Record<string, unknown>>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

const rowsByApp: Readonly<Record<number, readonly KintoneRecord[]>> = {
  [MASTER]: ["EMPTY", "BEFORE", "EQUAL", "AFTER", "QUOTE", "SLASH"].map((key, index) => record({
    $id: String(index + 1),
    キー: key,
  })),
  [TRANSACTION]: [
    record({ $id: "11", キー: "EMPTY", 日付: "", 時刻: "", 日時: "", 作成日時: "", 更新日時: "", 件名: "", リンク: "", 計算値: "-120", レコード番号: "CODE-100", 作成者: { code: "u0", name: "Nobody" }, 更新者: { code: "u0", name: "Nobody" }, ユーザー: [], 組織: [], グループ: [], 作業者: [] }),
    record({ $id: "12", キー: "BEFORE", 日付: "2026-08-06", 時刻: "09:29", 日時: "2026-08-06T23:59:59Z", 作成日時: "2026-08-06T23:59:59Z", 更新日時: "2026-08-06T23:59:59Z", 件名: "A", リンク: "https://a.example", 計算値: "-115", レコード番号: "CODE-101", 作成者: { code: "u1", name: "Display One" }, 更新者: { code: "u1", name: "Display One" }, ユーザー: [{ code: "u1", name: "Display One" }], 組織: [{ code: "u1", name: "Display One" }], グループ: [{ code: "u1", name: "Display One" }], 作業者: [{ code: "u1", name: "Display One" }] }),
    record({ $id: "13", キー: "EQUAL", 日付: "2026-08-07", 時刻: "09:30", 日時: "2026-08-07T00:00:00Z", 作成日時: "2026-08-07T00:00:00Z", 更新日時: "2026-08-07T00:00:00Z", 件名: "B", リンク: "https://b.example", 計算値: "-110", レコード番号: "CODE-102", 作成者: { code: "u2", name: "Display Two" }, 更新者: { code: "u2", name: "Display Two" }, ユーザー: [{ code: "u2", name: "Display Two" }], 組織: [{ code: "u2", name: "Display Two" }], グループ: [{ code: "u2", name: "Display Two" }], 作業者: [{ code: "u2", name: "Display Two" }] }),
    record({ $id: "14", キー: "AFTER", 日付: "2026-08-08", 時刻: "09:31", 日時: "2026-08-07T00:00:01Z", 作成日時: "2026-08-07T00:00:01Z", 更新日時: "2026-08-07T00:00:01Z", 件名: "A\"\\B", リンク: "https://c.example", 計算値: "-108", レコード番号: "CODE-103", 作成者: { code: "u1", name: "Renamed" }, 更新者: { code: "u1", name: "Renamed" }, ユーザー: [{ code: "u1", name: "Renamed" }], 組織: [{ code: "u1", name: "Renamed" }], グループ: [{ code: "u1", name: "Renamed" }], 作業者: [{ code: "u1", name: "Renamed" }] }),
    record({ $id: "15", キー: "QUOTE", 日付: "2026-08-08", 時刻: "09:31", 日時: "2026-08-07T00:00:01Z", 作成日時: "2026-08-07T00:00:01Z", 更新日時: "2026-08-07T00:00:01Z", 件名: "A\"B", リンク: "https://d.example", 計算値: "-105", レコード番号: "105", 作成者: { code: "u3", name: "Display Three" }, 更新者: { code: "u3", name: "Display Three" }, ユーザー: [{ code: "u3", name: "Display Three" }], 組織: [{ code: "u3", name: "Display Three" }], グループ: [{ code: "u3", name: "Display Three" }], 作業者: [{ code: "u3", name: "Display Three" }] }),
    record({ $id: "16", キー: "SLASH", 日付: "2026-08-08", 時刻: "09:31", 日時: "2026-08-07T00:00:01Z", 作成日時: "2026-08-07T00:00:01Z", 更新日時: "2026-08-07T00:00:01Z", 件名: "A\\B", リンク: "https://e.example", 計算値: "-100", レコード番号: "106", 作成者: { code: "u4", name: "Display Four" }, 更新者: { code: "u4", name: "Display Four" }, ユーザー: [], 組織: [], グループ: [], 作業者: [] }),
  ],
};

const dateTimeFields = [
  ["日付", "DATE", "2026-08-07"],
  ["時刻", "TIME", "09:30"],
  ["日時", "DATETIME", "2026-08-07T00:00:00Z"],
  ["作成日時", "CREATED_TIME", "2026-08-07T00:00:00Z"],
  ["更新日時", "UPDATED_TIME", "2026-08-07T00:00:00Z"],
] as const;

const fieldsByApp: Readonly<Record<number, readonly KintoneFieldInfo[]>> = {
  [MASTER]: [{ code: "キー", label: "キー", fieldType: "SINGLE_LINE_TEXT" }],
  [TRANSACTION]: [
    { code: "キー", label: "キー", fieldType: "SINGLE_LINE_TEXT" },
    ...dateTimeFields.map(([code, fieldType]) => ({ code, label: code, fieldType })),
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    { code: "リンク", label: "リンク", fieldType: "LINK" },
    { code: "計算値", label: "計算値", fieldType: "CALC" },
    { code: "レコード番号", label: "レコード番号", fieldType: "RECORD_NUMBER" },
    { code: "作成者", label: "作成者", fieldType: "CREATOR" },
    { code: "更新者", label: "更新者", fieldType: "MODIFIER" },
    { code: "ユーザー", label: "ユーザー", fieldType: "USER_SELECT" },
    { code: "組織", label: "組織", fieldType: "ORGANIZATION_SELECT" },
    { code: "グループ", label: "グループ", fieldType: "GROUP_SELECT" },
    { code: "作業者", label: "作業者", fieldType: "STATUS_ASSIGNEE" },
  ],
};

function withoutPaging(query: string): string {
  return query.replace(/(?:^|\s+)order by \$id asc limit 500 offset \d+$/, "");
}

function decode(value: string): string {
  return JSON.parse(value) as string;
}

function queryPredicate(query: string): ((row: KintoneRecord) => boolean) | null {
  const bare = withoutPaging(query);
  const list = /^([^\s]+)\s+(not in|in)\s+\((.*)\)$/i.exec(bare);
  if (list !== null) {
    const values = (list[3].match(/"(?:\\.|[^"\\])*"|-?(?:\d+(?:\.\d*)?|\.\d+)/g) ?? [])
      .map((value) => value.startsWith('"') ? decode(value) : value);
    return (row) => {
      const raw = row[list[1]]?.value;
      const candidates = Array.isArray(raw)
        ? raw.map((value) => String((value as { code?: unknown }).code ?? value))
        : raw !== null && typeof raw === "object"
          ? [String((raw as { code?: unknown }).code ?? raw)]
          : [String(raw ?? "")];
      const found = candidates.some((value) => values.includes(value));
      return list[2].toLowerCase() === "in" ? found : !found;
    };
  }
  const scalar = /^([^\s]+)\s*(<=|>=|!=|=|<|>)\s*("(?:\\.|[^"\\])*"|-?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(bare);
  if (scalar === null) return null;
  const expected = scalar[3].startsWith('"') ? decode(scalar[3]) : scalar[3];
  return (row) => {
    const value = String(row[scalar[1]]?.value ?? "");
    const compared = value < expected ? -1 : value > expected ? 1 : 0;
    if (scalar[2] === "=") return compared === 0;
    if (scalar[2] === "!=") return compared !== 0;
    if (scalar[2] === "<") return compared < 0;
    if (scalar[2] === "<=") return compared <= 0;
    if (scalar[2] === ">") return compared > 0;
    return compared >= 0;
  };
}

function makeClient(queryError?: Error): KintoneClient & { readonly calls: GetRecordsParams[] } {
  const calls: GetRecordsParams[] = [];
  return {
    calls,
    async getRecords(params) {
      calls.push({ ...params, fields: [...params.fields] });
      if (queryError !== undefined && params.app === TRANSACTION && withoutPaging(params.query) !== "") {
        throw queryError;
      }
      const predicate = params.app === TRANSACTION ? queryPredicate(params.query) : null;
      const rows = (rowsByApp[params.app] ?? []).filter((row) => predicate?.(row) ?? true);
      return {
        records: rows.map((row) => Object.fromEntries(
          params.fields.flatMap((field) => row[field] === undefined ? [] : [[field, row[field]]])
        ) as KintoneRecord),
      };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected write"); },
    async putRecords() { throw new Error("unexpected write"); },
    async deleteRecords() { throw new Error("unexpected write"); },
    async getApps() { return []; },
    async getFields(appId) { return [...(fieldsByApp[appId] ?? [])]; },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
}

function joinSql(condition: string): string {
  return `SELECT t.$id, t.キー FROM APP${MASTER} AS m JOIN APP${TRANSACTION} AS t `
    + `ON m.キー = t.キー WHERE t.${condition} ORDER BY t.$id`;
}

function residualSql(condition: string): string {
  return `SELECT t.$id, t.キー FROM APP${MASTER} AS m JOIN APP${TRANSACTION} AS t `
    + `ON m.キー = t.キー WHERE t.${condition} OR t.キー LIKE '__B152_NO_MATCH__' ORDER BY t.$id`;
}

function singleSql(condition: string): string {
  return `SELECT $id, キー FROM APP${TRANSACTION} WHERE ${condition} ORDER BY $id`;
}

function expectedQuery(condition: string): string {
  return condition
    .replace("<> ", "!= ")
    .replace(" IN (", " in (")
    .replace(" NOT in (", " not in (")
    .replace(/'([^']*)'/g, (_match, value: string) => JSON.stringify(value))
    .replace(/, /g, ",");
}

function resultIds(result: SelectResult): string[] {
  return result.rows.map((row) => String(row.$id));
}

async function expectThreePaths(condition: string, expectedIds?: readonly string[]): Promise<void> {
  const pushed = makeClient();
  const residual = makeClient();
  const single = makeClient();
  const [pushedResult, residualResult, singleResult] = await Promise.all([
    execute(joinSql(condition), pushed, { cacheContext: `b152-push-${condition}` }),
    execute(residualSql(condition), residual, { cacheContext: `b152-residual-${condition}` }),
    execute(singleSql(condition), single, { cacheContext: `b152-single-${condition}` }),
  ]) as SelectResult[];
  expect(pushedResult).toMatchObject({
    columns: residualResult.columns,
    rows: residualResult.rows,
    rowCount: residualResult.rowCount,
  });
  expect(singleResult).toMatchObject({
    columns: pushedResult.columns,
    rows: pushedResult.rows,
    rowCount: pushedResult.rowCount,
  });
  if (expectedIds !== undefined) {
    expect(resultIds(pushedResult)).toEqual(expectedIds);
    expect(resultIds(residualResult)).toEqual(expectedIds);
    expect(resultIds(singleResult)).toEqual(expectedIds);
  }
  const call = pushed.calls.find((candidate) => candidate.app === TRANSACTION)!;
  expect(withoutPaging(call.query)).toBe(expectedQuery(condition));
}

describe("B152 Phase 2+3 mock-client acceptance", () => {
  const dateTimeExpectedIds = {
    "=": ["13"],
    "!=": ["11", "12", "14", "15", "16"],
    "<>": ["11", "12", "14", "15", "16"],
    "<": ["11", "12"],
    ">": ["14", "15", "16"],
    "<=": ["11", "12", "13"],
    ">=": ["13", "14", "15", "16"],
  } as const;

  test.each(dateTimeFields.flatMap(([field, , literal]) =>
    (Object.entries(dateTimeExpectedIds) as Array<
      [keyof typeof dateTimeExpectedIds, readonly string[]]
    >).map(([op, expectedIds]) =>
      [`${field} ${op} '${literal}'`, expectedIds] as const
    )
  ))("Phase 2 three paths, fixed empty-cell IDs, and serializer: %s", async (condition, expectedIds) => {
    await expectThreePaths(condition, expectedIds);
  });

  test.each([
    ["件名 = 'B'", ["13"]],
    ["件名 != 'B'", ["11", "12", "14", "15", "16"]],
    ["件名 <> 'B'", ["11", "12", "14", "15", "16"]],
    ["件名 IN ('A', 'B')", ["12", "13"]],
    ["件名 NOT IN ('A', 'B')", ["11", "14", "15", "16"]],
    ["リンク = 'https://b.example'", ["13"]],
    ["リンク != 'https://b.example'", ["11", "12", "14", "15", "16"]],
    ["リンク <> 'https://b.example'", ["11", "12", "14", "15", "16"]],
    ["リンク IN ('https://a.example', 'https://b.example')", ["12", "13"]],
    ["リンク NOT IN ('https://a.example', 'https://b.example')", ["11", "14", "15", "16"]],
  ] as const)(
    "Phase 3 three paths, fixed empty-cell IDs, and serializer: %s",
    async (condition, expectedIds) => {
      await expectThreePaths(condition, expectedIds);
    }
  );

  test.each([
    "件名 = 'A\"B'",
    "件名 = 'A\\B'",
    "件名 = 'A\"\\B'",
  ])("Phase 3 three paths and escape serializer: %s", async (condition) => {
    await expectThreePaths(condition);
  });

  test("EXPLAIN は exact/EXACT、escape、canonical 外の非適用を表示する", async () => {
    const exact = await execute(`EXPLAIN ${joinSql("件名 = 'A\"\\B'")}`, makeClient()) as SelectResult;
    const exactText = exact.rows.map((row) => String(row.plan)).join("\n");
    expect(exactText).toContain('kintone query: 件名 = "A\\"\\\\B"');
    expect(exactText).toContain('pushdown applied: 件名 = "A\\"\\\\B"');
    expect(exactText).toContain("relation: exact");
    expect(exactText).toMatch(/fetch:\s+EXACT/);
    expect(exactText).toContain("client residual: t.件名 = 'A\"\\B'");

    for (const condition of [
      "日時 = '2026-08-07T09:00:00+09:00'",
      "日時 = '2026-08-07T00:00Z'",
      "日時 = '2026-08-07T00:00:00.000Z'",
      "日時 = '2026-08-07 00:00:00Z'",
    ]) {
      const result = await execute(`EXPLAIN ${joinSql(condition)}`, makeClient()) as SelectResult;
      const text = result.rows.map((row) => String(row.plan)).join("\n");
      expect(text).toContain("join pushdown not applied:");
      expect(text).not.toContain("pushdown applied: 日時");
    }
  });

  test.each(["LEFT", "RIGHT"] as const)(
    "%s JOIN では B152 leaf を押し下げない",
    async (joinType) => {
      const sql = `EXPLAIN SELECT t.$id FROM APP${MASTER} AS m ${joinType} JOIN `
        + `APP${TRANSACTION} AS t ON m.キー = t.キー WHERE t.日付 >= '2026-08-07' `
        + "ORDER BY t.$id";
      const result = await execute(sql, makeClient()) as SelectResult;
      const text = result.rows.map((row) => String(row.plan)).join("\n");
      expect(text).toContain("OUTER_JOIN");
      expect(text).not.toContain("pushdown applied: 日付");
    }
  );

  test("CALC 数値書式は {-108,-115,-105} の3経路を一致させる", async () => {
    await expectThreePaths("計算値 IN (-108, -115, -105)", ["12", "14", "15"]);
  });

  test.each([
    ["レコード番号 = 105", ["15"]],
    ["レコード番号 = 'CODE-101'", ["12"]],
  ] as const)("RECORD_NUMBER の数値・文字列 literal を3経路で一致させる: %s", async (condition, ids) => {
    await expectThreePaths(condition, ids);
  });

  test.each([
    "作成者", "更新者", "ユーザー", "組織", "グループ", "作業者",
  ])("ユーザー系 %s は code の IN を3経路で一致させ、name を使わない", async (field) => {
    await expectThreePaths(`${field} IN ('u1')`, ["12", "14"]);
    await expectThreePaths(`${field} IN ('Display One')`, []);
  });

  test("ユーザー選択の NOT IN は空配列を含む", async () => {
    await expectThreePaths("ユーザー NOT IN ('u1')", ["11", "13", "15", "16"]);
  });

  test("CALC / RECORD_NUMBER は superset PREFILTERED と残余を EXPLAIN へ固定する", async () => {
    for (const condition of ["計算値 >= -108", "レコード番号 >= 'CODE-101'"]) {
      const result = await execute(`EXPLAIN ${joinSql(condition)}`, makeClient()) as SelectResult;
      const text = result.rows.map((row) => String(row.plan)).join("\n");
      expect(text).toContain("relation: superset");
      expect(text).toMatch(/fetch:\s+PREFILTERED/);
      expect(text).toContain(`client residual: t.${condition}`);
    }
  });

  test("prefilter の kintone query error を silent retry せず表面化する", async () => {
    const error = new Error("GAIA_IL26: invalid query literal");
    await expect(execute(joinSql("作成者 IN ('missing')"), makeClient(error)))
      .rejects.toThrow("GAIA_IL26: invalid query literal");
  });
});
