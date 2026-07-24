import { resolveFieldSemantics } from "../../fieldSemantics";
import { parseSqlStatement } from "../../sql";
import type {
  DeleteStatement,
  SelectStatement,
  Statement,
  UpdateStatement,
} from "../../../types/ast";
import {
  decomposeRelativeDatePrefilter,
  type RelativeDatePrefilterDecomposition,
} from "../relativeDatePrefilterPlan";
import {
  allowRelativeDatePrefilterPlan,
  assertRelativeDatePushdownPlan,
  buildRelativeDatePushdownPlan,
  type RelativeDateCapabilityResolver,
} from "../relativeDatePushdownGuard";
import { classifyWhereCapability } from "../whereCapability";

const FIELD_TYPES = new Map<string, string>([
  ["日付", "DATE"],
  ["更新日時", "UPDATED_TIME"],
  ["件名", "SINGLE_LINE_TEXT"],
  ["状態", "SINGLE_LINE_TEXT"],
  ["$id", "__ID__"],
]);

function select(sql: string): SelectStatement {
  return parseSqlStatement(sql) as SelectStatement;
}

function resolveField(field: { field: string }) {
  const fieldType = FIELD_TYPES.get(field.field);
  return fieldType ? resolveFieldSemantics({ fieldType }) : undefined;
}

function capability(
  statement: SelectStatement | UpdateStatement | DeleteStatement
) {
  return classifyWhereCapability(statement.where, resolveField);
}

function decomposition(stmt: SelectStatement): RelativeDatePrefilterDecomposition {
  return decomposeRelativeDatePrefilter(stmt, resolveField);
}

function resolver(withPrefilter = true): RelativeDateCapabilityResolver {
  return {
    select: async (stmt) => capability(stmt),
    dml: async (stmt) => capability(stmt),
    ...(withPrefilter
      ? { prefilterDecomposition: async (stmt: SelectStatement) => decomposition(stmt) }
      : {}),
  };
}

const MIXED_SQL =
  "SELECT 更新日時 FROM APP100 "
  + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1";

test.each([
  ["eligible FULL_SCAN", "eligible", true],
  ["ineligible decomposition", "ineligible", false],
  ["KORDER", "korder", false],
  ["SIMPLE mode", "simple", false],
  ["JOIN", "join", false],
  ["subtable", "subtable", false],
  ["cteName", "cte", false],
] as const)(
  "allowRelativeDatePrefilterPlan: %s => %s",
  (_label, fixture, expected) => {
    const base = select(MIXED_SQL);
    const eligible = decomposition(base);
    if (!eligible.eligible) throw new Error("eligible fixture expected");

    let stmt = base;
    let result: RelativeDatePrefilterDecomposition = eligible;
    switch (fixture) {
      case "ineligible":
        result = {
          eligible: false,
          disposition: "INELIGIBLE",
          reasonCodes: ["RELATIVE_DATE_CONTEXT_UNSUPPORTED"],
          capability: "SUPERSET_PREFILTER",
          reasons: eligible.plan.reasons,
        };
        break;
      case "korder":
        stmt = { ...base, orderMode: "KINTONE_NATIVE" };
        break;
      case "simple":
        stmt = select(
          "SELECT 更新日時 FROM APP100 WHERE 更新日時 >= YESTERDAY()"
        );
        break;
      case "join": {
        const joined = select(
          "SELECT a.更新日時 FROM APP100 a JOIN APP200 b ON a.$id = b.$id"
        );
        stmt = { ...base, joins: joined.joins };
        break;
      }
      case "subtable":
        stmt = {
          ...base,
          from: { ...base.from, subtableCode: "明細" },
        };
        break;
      case "cte":
        stmt = {
          ...base,
          from: { ...base.from, cteName: "materialized" },
        };
        break;
    }

    expect(allowRelativeDatePrefilterPlan(stmt, result)).toBe(expected);
  }
);

test("eligible mixed SELECT は候補 plan を保持するが outer assert は拒否を維持する", async () => {
  const result = await buildRelativeDatePushdownPlan(
    select(MIXED_SQL),
    resolver()
  );

  expect(result.allowed).toBe(false);
  expect(result.nodes).toHaveLength(1);
  expect(result.nodes[0]).toMatchObject({
    allowed: false,
    clientWhereEvaluation: true,
    phase2PrefilterEligible: true,
    capability: { capability: "SUPERSET_PREFILTER" },
  });
  expect(result.nodes[0].prefilterPlan).toBeDefined();
  expect(() => assertRelativeDatePushdownPlan(result))
    .toThrow(/YESTERDAY: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN/);
});

test.each([
  [
    "KORDER mixed",
    `${MIXED_SQL} KORDER BY $id LIMIT 10`,
    false,
  ],
  [
    "JOIN",
    "SELECT a.更新日時 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
      + "WHERE a.更新日時 >= YESTERDAY() AND LENGTH(a.件名) > 1",
    false,
  ],
  [
    "subtable",
    "SELECT 更新日時 FROM APP100$明細 "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    false,
  ],
  [
    "OR relative",
    "SELECT 更新日時 FROM APP100 "
      + "WHERE 更新日時 >= YESTERDAY() OR LENGTH(件名) > 1",
    false,
  ],
  [
    "NOT relative",
    "SELECT 更新日時 FROM APP100 "
      + "WHERE NOT (更新日時 >= YESTERDAY()) AND LENGTH(件名) > 1",
    false,
  ],
  [
    "pure exact SIMPLE",
    "SELECT 更新日時 FROM APP100 WHERE 更新日時 >= YESTERDAY()",
    true,
  ],
  [
    "DML mixed",
    "UPDATE APP100 SET 状態 = '完了' "
      + "WHERE 更新日時 >= YESTERDAY() AND LENGTH(件名) > 1",
    false,
  ],
] as const)(
  "%s は Phase2 候補を付けず既存 allow/reject を維持する",
  async (_label, sql, expectedAllowed) => {
    const result = await buildRelativeDatePushdownPlan(
      parseSqlStatement(sql) as Statement,
      resolver()
    );

    expect(result.allowed).toBe(expectedAllowed);
    expect(result.nodes.every((node) => !node.phase2PrefilterEligible)).toBe(true);
    expect(result.nodes.every((node) => node.prefilterPlan === undefined)).toBe(true);
  }
);

test("prefilterDecomposition 未提供時は従来結果と同一になる", async () => {
  const statement = select(MIXED_SQL);
  const withoutMethod = await buildRelativeDatePushdownPlan(
    statement,
    resolver(false)
  );
  const nullMethod = await buildRelativeDatePushdownPlan(statement, {
    ...resolver(false),
    prefilterDecomposition: async () => null,
  });

  expect(withoutMethod).toEqual(nullMethod);
  expect(withoutMethod.allowed).toBe(false);
  expect(withoutMethod.nodes[0]).not.toHaveProperty("prefilterPlan");
  expect(withoutMethod.nodes[0]).not.toHaveProperty("phase2PrefilterEligible");
});
