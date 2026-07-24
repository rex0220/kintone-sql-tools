import { parseSqlStatement } from "../../sql";
import { resolveFieldSemantics } from "../../fieldSemantics";
import type { DeleteStatement, SelectStatement, Statement, UpdateStatement } from "../../../types/ast";
import {
  buildRelativeDatePushdownPlan,
  relativeDateFunctionNamesInWhere,
} from "../relativeDatePushdownGuard";
import { classifyWhereCapability } from "../whereCapability";

const fieldTypes = new Map<string, string>([
  ["日付", "DATE"],
  ["日時", "DATETIME"],
  ["作成日時", "CREATED_TIME"],
  ["更新日時", "UPDATED_TIME"],
  ["件名", "SINGLE_LINE_TEXT"],
  ["状態", "SINGLE_LINE_TEXT"],
  ["金額", "NUMBER"],
  ["$id", "__ID__"],
]);

function capability(
  statement: SelectStatement | UpdateStatement | DeleteStatement
) {
  return classifyWhereCapability(statement.where, (field) => {
    const fieldType = fieldTypes.get(field.field);
    return fieldType ? resolveFieldSemantics({ fieldType }) : undefined;
  });
}

async function plan(sql: string) {
  return buildRelativeDatePushdownPlan(parseSqlStatement(sql) as Statement, {
    select: async (select) => capability(select),
    dml: async (dml) => capability(dml),
  });
}

test("WHERE walker は同一 node の全相対日付関数を再帰収集する", () => {
  const statement = parseSqlStatement(
    "SELECT * FROM APP100 WHERE (日付 >= FROM_TODAY(-7, DAYS) AND 日付 <= TOMORROW())"
  ) as SelectStatement;
  expect(relativeDateFunctionNamesInWhere(statement.where))
    .toEqual(["FROM_TODAY", "TOMORROW"]);
});

test.each([
  "SELECT * FROM APP100 WHERE 日付 = YESTERDAY()",
  "SELECT * FROM APP100 WHERE 日付 = YESTERDAY() KORDER BY $id",
  "UPDATE APP100 SET 状態 = '完了' WHERE 日付 = YESTERDAY()",
  "DELETE FROM APP100 WHERE 日付 = YESTERDAY()",
])("物理 APP の exact WHERE かつ client WHERE 評価なしだけ許可する: %s", async (sql) => {
  const result = await plan(sql);
  expect(result.allowed).toBe(true);
  expect(result.nodes).toHaveLength(1);
  expect(result.nodes[0]).toMatchObject({
    allowed: true,
    clientWhereEvaluation: false,
    capability: { capability: "EXACT_PUSHDOWN" },
  });
  expect(result.nodes[0].restQuery).toContain("YESTERDAY()");
});

test.each([
  [
    "JOIN",
    "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id WHERE a.日付 = YESTERDAY()",
  ],
  ["aggregate", "SELECT COUNT(*) FROM APP100 WHERE 日付 = YESTERDAY()"],
  [
    "window",
    "SELECT 日付, ROW_NUMBER() OVER (ORDER BY 日付) AS rn FROM APP100 WHERE 日付 = YESTERDAY()",
  ],
  ["DISTINCT", "SELECT DISTINCT 日付 FROM APP100 WHERE 日付 = YESTERDAY()"],
  ["canonical ORDER", "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() ORDER BY 日付"],
  [
    "local expression",
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() AND LENGTH(件名) > 1",
  ],
  [
    "materialized CTE",
    "WITH c AS (SELECT 日付 AS d FROM APP100 WHERE 日付 = YESTERDAY()) SELECT d FROM c",
  ],
  [
    "UPDATE FROM",
    "UPDATE APP100 SET 状態 = s.状態 FROM APP200 AS s "
    + "WHERE APP100.$id = s.$id AND 日付 = YESTERDAY()",
  ],
  ["subtable UPDATE", "UPDATE APP100$明細 SET 状態 = 'x' WHERE 日付 = YESTERDAY()"],
  ["subtable DELETE", "DELETE FROM APP100$明細 WHERE 日付 = YESTERDAY()"],
  ["REORDER", "REORDER APP100$明細 BY 日付 WHERE 日付 = YESTERDAY()"],
  ["existing VALIDATE", "VALIDATE APP100 WHERE 日付 = YESTERDAY()"],
])("%s は plan walk で fail-closed にする", async (_label, sql) => {
  const result = await plan(sql);
  expect(result.allowed).toBe(false);
  expect(result.rejection?.code).toBe("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");
  expect(result.nodes[result.nodes.length - 1]).toMatchObject({
    allowed: false,
    clientWhereEvaluation: true,
  });
});

test("UNION は SELECT node ごとの混在正負を判定する", async () => {
  const positive = await plan(
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() "
    + "UNION ALL SELECT 日付 FROM APP200 WHERE 日付 = TOMORROW()"
  );
  expect(positive.allowed).toBe(true);
  expect(positive.nodes.map((node) => node.functionNames[0]))
    .toEqual(["YESTERDAY", "TOMORROW"]);

  const mixed = await plan(
    "SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() "
    + "UNION ALL SELECT COUNT(*) FROM APP200 WHERE 日付 = TOMORROW()"
  );
  expect(mixed.allowed).toBe(false);
  expect(mixed.nodes).toHaveLength(2);
  expect(mixed.nodes[0].allowed).toBe(true);
  expect(mixed.nodes[1].allowed).toBe(false);
});

test("WITH は inline plan を1物理 SELECTとして判定し、非inline materializationを拒否する", async () => {
  const inlined = await plan(
    "WITH c AS (SELECT * FROM APP100 WHERE 日付 >= FROM_TODAY(-7, DAYS)) "
    + "SELECT 日付 FROM c WHERE 日付 <= TOMORROW()"
  );
  expect(inlined.allowed).toBe(true);
  expect(inlined.nodes).toHaveLength(1);
  expect(inlined.nodes[0].path).toContain("inlined");
  expect(inlined.nodes[0].restQuery).toContain("FROM_TODAY(-7, DAYS)");
  expect(inlined.nodes[0].restQuery).toContain("TOMORROW()");

  const materialized = await plan(
    "WITH c AS (SELECT 日付 AS d FROM APP100 WHERE 日付 = YESTERDAY()) SELECT d FROM c"
  );
  expect(materialized.allowed).toBe(false);
  expect(materialized.rejection?.path).toContain("cte[0]");
});
