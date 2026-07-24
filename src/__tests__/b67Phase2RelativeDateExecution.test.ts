import {
  execute,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import { resolveFieldSemantics } from "../core/fieldSemantics";
import { decomposeRelativeDatePrefilter } from "../core/optimization/relativeDatePrefilterPlan";
import { parseSqlStatement } from "../core/sql";
import type { SelectStatement, WhereExpr } from "../types/ast";
import * as evalWhereModule from "../engine/evalWhere";

function record(id: number, fields: Record<string, string>): KintoneRecord {
  return {
    $id: { value: String(id) },
    ...Object.fromEntries(
      Object.entries(fields).map(([code, value]) => [code, { value }])
    ),
  };
}

type GetResponse = Awaited<ReturnType<KintoneClient["getRecords"]>>;

function makeClient(
  responder: (
    params: Parameters<KintoneClient["getRecords"]>[0],
    callIndex: number
  ) => GetResponse | Promise<GetResponse>
) {
  let callIndex = 0;
  const getRecords = jest.fn(async (
    params: Parameters<KintoneClient["getRecords"]>[0]
  ): Promise<GetResponse> => responder(params, callIndex++));
  const client: KintoneClient = {
    getRecords,
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords() { throw new Error("unexpected mutation"); },
    async putRecords() { throw new Error("unexpected mutation"); },
    async deleteRecords() { throw new Error("unexpected mutation"); },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "更新日時", label: "更新日時", fieldType: "UPDATED_TIME" },
        { code: "作成日時", label: "作成日時", fieldType: "CREATED_TIME" },
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
        { code: "備考", label: "備考", fieldType: "SINGLE_LINE_TEXT" },
        { code: "金額", label: "金額", fieldType: "NUMBER" },
      ];
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
  };
  return { client, getRecords };
}

function rows(result: unknown): SelectResult {
  return result as SelectResult;
}

test("relative prefilter を GET に載せ、LENGTH residual だけで結果を絞る", async () => {
  const evaluator = jest.spyOn(evalWhereModule, "evalWhere");
  const { client, getRecords } = makeClient(async () => ({
    records: [
      record(1, { 更新日時: "2026-07-24T00:00:00Z", 件名: "A" }),
      record(2, { 更新日時: "2026-07-24T00:00:00Z", 件名: "AB" }),
    ],
  }));

  const result = rows(await execute(
    "SELECT $id, 件名 FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    client
  ));

  expect(result.rows).toEqual([{ $id: "2", 件名: "AB" }]);
  expect(getRecords).toHaveBeenCalledTimes(1);
  expect(getRecords.mock.calls[0][0].query).toBe(
    "更新日時 >= YESTERDAY() order by $id asc limit 500 offset 0"
  );
  expect(evaluator).toHaveBeenCalled();
  for (const [residual] of evaluator.mock.calls) {
    expect(relativeNames(residual)).toEqual([]);
  }
  evaluator.mockRestore();
});

test("複数ページでも relative base predicate を維持する", async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) =>
    record(index + 1, {
      更新日時: "2026-07-24T00:00:00Z",
      件名: "AB",
    })
  );
  const { client, getRecords } = makeClient(async (_params, callIndex) => ({
    records: callIndex === 0
      ? firstPage
      : [record(501, { 更新日時: "2026-07-24T00:00:00Z", 件名: "AB" })],
  }));

  const result = rows(await execute(
    "SELECT $id FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    client,
    { maxRecords: 1_000 }
  ));

  expect(result.rowCount).toBe(501);
  expect(getRecords).toHaveBeenCalledTimes(2);
  expect(getRecords.mock.calls[0][0].query).toBe(
    "更新日時 >= YESTERDAY() order by $id asc limit 500 offset 0"
  );
  expect(getRecords.mock.calls[1][0].query).toBe(
    "更新日時 >= YESTERDAY() order by $id asc limit 500 offset 500"
  );
});

test("relative exact AND 通常 LIKE は LIKE を client residual で評価する", async () => {
  const { client, getRecords } = makeClient(async () => ({
    records: [
      record(1, { 更新日時: "2026-07-24T00:00:00Z", 件名: "Alpha" }),
      record(2, { 更新日時: "2026-07-24T00:00:00Z", 件名: "Beta" }),
    ],
  }));

  const result = rows(await execute(
    "SELECT $id FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND 件名 LIKE 'A%'",
    client
  ));

  expect(result.rows).toEqual([{ $id: "1" }]);
  expect(getRecords.mock.calls[0][0].query).not.toContain("件名 like");
  expect(getRecords.mock.calls[0][0].query).toContain("更新日時 >= YESTERDAY()");
});

test("relative exact AND KLIKE AND LIKE は relative + KLIKE を server に載せる", async () => {
  const { client, getRecords } = makeClient(async () => ({
    records: [
      record(1, {
        更新日時: "2026-07-24T00:00:00Z",
        件名: "至急",
        備考: "対象",
      }),
      record(2, {
        更新日時: "2026-07-24T00:00:00Z",
        件名: "至急",
        備考: "除外",
      }),
    ],
  }));

  const result = rows(await execute(
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
      + "AND 件名 KLIKE '至急' AND 備考 LIKE '対%'",
    client
  ));

  expect(result.rows).toEqual([{ $id: "1" }]);
  expect(getRecords.mock.calls[0][0].query).toContain("更新日時 >= YESTERDAY()");
  expect(getRecords.mock.calls[0][0].query).toContain('件名 like "至急"');
  expect(getRecords.mock.calls[0][0].query).not.toContain("備考 like");
});

test("複数 relative leaf をすべて AND して residual から除く", async () => {
  const { client, getRecords } = makeClient(async () => ({
    records: [
      record(1, {
        更新日時: "2026-07-24T00:00:00Z",
        作成日時: "2026-07-25T00:00:00Z",
        件名: "AB",
      }),
    ],
  }));

  const result = rows(await execute(
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
      + "AND 作成日時 <= TOMORROW() AND LENGTH(件名) > 1",
    client
  ));

  expect(result.rowCount).toBe(1);
  const query = getRecords.mock.calls[0][0].query;
  expect(query).toContain("更新日時 >= YESTERDAY()");
  expect(query).toContain("作成日時 <= TOMORROW()");
});

test("relative-free OR subtree は object identity を保った residual として評価する", async () => {
  const sql =
    "SELECT $id FROM APP100 WHERE 更新日時 >= YESTERDAY() "
    + "AND (件名 LIKE 'A%' OR 備考 LIKE 'B%')";
  const stmt = parseSqlStatement(sql) as SelectStatement;
  if (stmt.where?.type !== "LOGICAL") throw new Error("unexpected fixture AST");
  const originalWhere = stmt.where;
  const originalOr = stmt.where.right;
  const before = JSON.stringify(stmt.where);
  const decomposition = decomposeRelativeDatePrefilter(stmt, (field) => {
    const fieldType = field.field === "更新日時" ? "UPDATED_TIME" : "SINGLE_LINE_TEXT";
    return resolveFieldSemantics({ fieldType });
  });
  if (!decomposition.eligible) throw new Error("eligible decomposition expected");
  expect(decomposition.plan.residualWhere).toBe(originalOr);
  expect(stmt.where).toBe(originalWhere);
  expect(JSON.stringify(stmt.where)).toBe(before);

  const { client } = makeClient(async () => ({
    records: [
      record(1, { 更新日時: "2026-07-24T00:00:00Z", 件名: "Alpha", 備考: "" }),
      record(2, { 更新日時: "2026-07-24T00:00:00Z", 件名: "No", 備考: "Beta" }),
      record(3, { 更新日時: "2026-07-24T00:00:00Z", 件名: "No", 備考: "No" }),
    ],
  }));
  expect(rows(await execute(sql, client)).rows).toEqual([
    { $id: "1" },
    { $id: "2" },
  ]);
});

test("relative query の REST error は空 query retry せず伝播する", async () => {
  const failure = new Error("relative REST failure");
  const { client, getRecords } = makeClient(async () => {
    throw failure;
  });

  await expect(execute(
    "SELECT $id FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    client
  )).rejects.toBe(failure);
  expect(getRecords).toHaveBeenCalledTimes(1);
  expect(getRecords.mock.calls[0][0].query).toContain("YESTERDAY()");
});

test("relative query の検索打ち切りは既存 SELECT 警告契約を保ち retry しない", async () => {
  const { client, getRecords } = makeClient(async () => ({
    records: [record(1, {
      更新日時: "2026-07-24T00:00:00Z",
      件名: "AB",
      金額: "1",
    })],
    searchAborted: true,
  }));

  const result = rows(await execute(
    "SELECT STDDEV_POP(金額) AS sd FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    client
  ));
  expect(result.warnings).toEqual([expect.stringContaining("10 万件で打ち切られ")]);
  expect(getRecords).toHaveBeenCalledTimes(1);
});

test("relative prefilter でも maxRecords / complete-input は fail-closed", async () => {
  const { client, getRecords } = makeClient(async () => ({
    records: [
      record(1, { 更新日時: "2026-07-24T00:00:00Z", 件名: "AB", 金額: "1" }),
      record(2, { 更新日時: "2026-07-24T00:00:00Z", 件名: "ABC", 金額: "2" }),
    ],
  }));

  await expect(execute(
    "SELECT STDDEV_POP(金額) AS sd FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    client,
    { maxRecords: 1, onLimitReached: "truncate" }
  )).rejects.toThrow(/complete input|正しい結果/);
  expect(getRecords).toHaveBeenCalledTimes(1);
});

function relativeNames(where: WhereExpr | null): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const value = node as Record<string, unknown>;
    if (value["type"] === "KINTONE_FUNC" && typeof value["name"] === "string") {
      names.push(value["name"]);
    }
    Object.values(value).forEach(visit);
  };
  visit(where);
  return names;
}

test("eligible plan の residual は relative evaluator 呼び出し対象を0件にする", () => {
  const stmt = parseSqlStatement(
    "SELECT $id FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1"
  ) as SelectStatement;
  const decomposition = decomposeRelativeDatePrefilter(stmt, (field) =>
    resolveFieldSemantics({
      fieldType: field.field === "更新日時" ? "UPDATED_TIME" : "SINGLE_LINE_TEXT",
    })
  );
  if (!decomposition.eligible) throw new Error("eligible decomposition expected");
  expect(relativeNames(decomposition.plan.residualWhere)).toEqual([]);
  expect(relativeNames(decomposition.plan.prefilterWhere)).toEqual(["YESTERDAY"]);
});
