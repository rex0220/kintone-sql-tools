import { parseSqlStatement } from "../../sql";
import { resolveFieldSemantics } from "../../fieldSemantics";
import type { KlikeExpr } from "../../like";
import type {
  BinaryExpr,
  SelectStatement,
  WhereExpr,
} from "../../../types/ast";
import {
  decomposeRelativeDatePrefilter,
  type RelativeDatePrefilterDecomposition,
} from "../relativeDatePrefilterPlan";

const FIELD_TYPES = new Map<string, string>([
  ["日付", "DATE"],
  ["日時", "DATETIME"],
  ["件名", "SINGLE_LINE_TEXT"],
  ["備考", "SINGLE_LINE_TEXT"],
  ["金額", "NUMBER"],
  ["$id", "__ID__"],
]);

function select(sql: string): SelectStatement {
  return parseSqlStatement(sql) as SelectStatement;
}

function decompose(
  stmt: SelectStatement,
  seam: Parameters<typeof decomposeRelativeDatePrefilter>[2] = {}
): RelativeDatePrefilterDecomposition {
  return decomposeRelativeDatePrefilter(
    stmt,
    (field) => {
      const fieldType = FIELD_TYPES.get(field.field);
      return fieldType ? resolveFieldSemantics({ fieldType }) : undefined;
    },
    seam
  );
}

function eligible(result: RelativeDatePrefilterDecomposition) {
  expect(result.eligible).toBe(true);
  if (!result.eligible) throw new Error(`plan expected: ${result.reasonCodes.join(",")}`);
  return result.plan;
}

function relativeLeaves(where: WhereExpr | null): BinaryExpr[] {
  if (where === null) return [];
  switch (where.type) {
    case "BINARY":
      return where.right.type === "KINTONE_FUNC"
        && !["TODAY", "NOW", "LOGINUSER"].includes(where.right.name)
        ? [where]
        : [];
    case "LOGICAL":
      return [...relativeLeaves(where.left), ...relativeLeaves(where.right)];
    case "NOT":
    case "GROUP":
      return relativeLeaves(where.expr);
    case "EXISTS":
      return relativeLeaves(where.query.where);
    case "NULL_CHECK":
    case "BOOLEAN":
      return [];
  }
}

function binaryLeaves(where: WhereExpr | null): BinaryExpr[] {
  if (where === null) return [];
  switch (where.type) {
    case "BINARY":
      return [where];
    case "LOGICAL":
      return [...binaryLeaves(where.left), ...binaryLeaves(where.right)];
    case "NOT":
    case "GROUP":
      return binaryLeaves(where.expr);
    case "EXISTS":
      return binaryLeaves(where.query.where);
    case "NULL_CHECK":
    case "BOOLEAN":
      return [];
  }
}

test("relative exact AND LENGTH は exact leaf と同一 identity の residual に分解する", () => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() AND LENGTH(件名) > 1"
  );
  const originalLeaves = binaryLeaves(stmt.where);
  const plan = eligible(decompose(stmt));

  expect(plan.capability).toBe("SUPERSET_PREFILTER");
  expect(plan.reasons).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "WHERE_SUPERSET_PREFILTER" }),
    expect.objectContaining({ code: "WHERE_EXACT", functionName: "YESTERDAY" }),
    expect.objectContaining({ code: "WHERE_EXPRESSION_LOCAL_ONLY" }),
    expect.objectContaining({
      code: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
      functionName: "YESTERDAY",
    }),
  ]));
  expect(plan.exactRelativeLeaves).toEqual([originalLeaves[0]]);
  expect(relativeLeaves(plan.prefilterWhere)).toEqual([originalLeaves[0]]);
  expect(plan.residualWhere).toBe(originalLeaves[1]);
});

test("複数 leaf・透過 GROUP・BETWEEN 展開・relative-free OR residual を順序どおり分解する", () => {
  const stmt = select(
    "SELECT 日付 FROM APP100 "
    + "WHERE (日付 BETWEEN FROM_TODAY(-7, DAYS) AND TOMORROW()) "
    + "AND (LENGTH(件名) > 1 OR 備考 IS NULL)"
  );
  const originalRelative = relativeLeaves(stmt.where);
  if (stmt.where?.type !== "LOGICAL") throw new Error("unexpected fixture AST");
  const originalResidual = stmt.where.right;
  const plan = eligible(decompose(stmt));

  expect(plan.exactRelativeLeaves).toEqual(originalRelative);
  expect(plan.exactRelativeLeaves.map((leaf) => leaf.op)).toEqual([">=", "<="]);
  expect([...plan.relativeFunctionNames]).toEqual(["FROM_TODAY", "TOMORROW"]);
  expect(relativeLeaves(plan.prefilterWhere)).toEqual(originalRelative);
  expect(plan.residualWhere).toBe(originalResidual);
});

test.each([
  [
    "OR 内",
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() OR LENGTH(件名) > 1",
    "RELATIVE_DATE_CONTEXT_UNSUPPORTED",
  ],
  [
    "NOT 配下",
    "SELECT 日付 FROM APP100 WHERE NOT (日付 >= YESTERDAY()) AND LENGTH(件名) > 1",
    "RELATIVE_DATE_CONTEXT_UNSUPPORTED",
  ],
  [
    "非 exact operator",
    "SELECT 日付 FROM APP100 WHERE 日付 LIKE YESTERDAY() AND LENGTH(件名) > 1",
    "RELATIVE_DATE_LEAF_NOT_EXACT",
  ],
  [
    "非対応 field type",
    "SELECT 件名 FROM APP100 WHERE 件名 >= YESTERDAY() AND LENGTH(備考) > 1",
    "RELATIVE_DATE_LEAF_NOT_EXACT",
  ],
  [
    "非対応 left context",
    "SELECT 日付 FROM APP100 WHERE UPPER(日付) >= YESTERDAY() AND LENGTH(件名) > 1",
    "RELATIVE_DATE_LEAF_NOT_EXACT",
  ],
])("%s の相対日付は plan 不成立にする", (_label, sql, reason) => {
  const result = decompose(select(sql));
  expect(result).toMatchObject({
    eligible: false,
    disposition: "INELIGIBLE",
    reasonCodes: [reason],
  });
});

test.each([
  [
    "subtable",
    "SELECT * FROM APP100$明細 WHERE 日付 >= YESTERDAY() AND LENGTH(件名) > 1",
    "SUBTABLE_UNSUPPORTED",
  ],
  [
    "JOIN",
    "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
      + "WHERE a.日付 >= YESTERDAY() AND LENGTH(a.件名) > 1",
    "JOIN_UNSUPPORTED",
  ],
])("%s source は入口で plan 不成立にする", (_label, sql, reason) => {
  expect(decompose(select(sql))).toMatchObject({
    eligible: false,
    reasonCodes: [reason],
  });
});

test("materialized / derived source は直接の物理 APP として扱わない", () => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() AND LENGTH(件名) > 1"
  );
  const materialized: SelectStatement = {
    ...stmt,
    from: { ...stmt.from, appId: 0, cteName: "materialized" },
  };
  expect(decompose(materialized)).toMatchObject({
    eligible: false,
    reasonCodes: ["NOT_DIRECT_PHYSICAL_APP"],
  });
});

test.each([
  [
    "serializer throw",
    { serialize: () => { throw new Error("serializer failure"); } },
    "PREFILTER_SERIALIZATION_FAILED",
  ],
  [
    "missing function regex",
    { containsFunctions: () => false },
    "PREFILTER_FUNCTION_MISSING",
  ],
] as const)("%s は fail-closed にする", (_label, seam, reason) => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() AND LENGTH(件名) > 1"
  );
  expect(decompose(stmt, seam)).toMatchObject({
    eligible: false,
    reasonCodes: [reason],
  });
});

test("surgery 後に相対日付 occurrence が残る seam は fail-closed にする", () => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() AND LENGTH(件名) > 1"
  );
  expect(decompose(stmt, {
    rewriteResidual: (where) => where,
  })).toMatchObject({
    eligible: false,
    reasonCodes: ["RESIDUAL_RELATIVE_DATE_REMAINED"],
  });
});

test("同名関数の full prefilter multiset が不足すれば plan 不成立にする", () => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() "
    + "AND 日付 <= YESTERDAY() AND LENGTH(件名) > 1"
  );
  expect(decompose(stmt, {
    serialize: (where) => where.type === "LOGICAL"
      ? "日付 >= YESTERDAY()"
      : "日付 >= YESTERDAY()",
  })).toMatchObject({
    eligible: false,
    reasonCodes: ["PREFILTER_FUNCTION_MISSING"],
  });
});

test.each([
  ["TRUE AND X", "left"],
  ["X AND TRUE", "right"],
  ["GROUP(TRUE)", "group"],
] as const)("%s だけを局所的に畳む", (_label, shape) => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() AND LENGTH(件名) > 1"
  );
  if (stmt.where?.type !== "LOGICAL") throw new Error("unexpected fixture AST");
  const relative = stmt.where.left;
  const x = stmt.where.right;
  const groupedRelative: WhereExpr = { type: "GROUP", expr: relative };
  stmt.where = shape === "left"
    ? { type: "LOGICAL", op: "AND", left: relative, right: x }
    : shape === "right"
      ? { type: "LOGICAL", op: "AND", left: x, right: relative }
      : { type: "LOGICAL", op: "AND", left: groupedRelative, right: x };

  expect(eligible(decompose(stmt)).residualWhere).toBe(x);
});

test("OR 分配・並べ替え・FALSE を含む一般 constant folding は行わない", () => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() AND LENGTH(件名) > 1"
  );
  if (stmt.where?.type !== "LOGICAL") throw new Error("unexpected fixture AST");
  const relative = stmt.where.left;
  const x = stmt.where.right;
  const falseAndX: WhereExpr = {
    type: "LOGICAL",
    op: "AND",
    left: { type: "BOOLEAN", value: false },
    right: x,
  };
  const trueOrFalseAndX: WhereExpr = {
    type: "LOGICAL",
    op: "OR",
    left: { type: "BOOLEAN", value: true },
    right: falseAndX,
  };
  stmt.where = {
    type: "LOGICAL",
    op: "AND",
    left: relative,
    right: trueOrFalseAndX,
  };

  const residual = eligible(decompose(stmt)).residualWhere;
  expect(residual).toBe(trueOrFalseAndX);
  expect(residual).toMatchObject({
    type: "LOGICAL",
    op: "OR",
    right: { type: "LOGICAL", op: "AND", left: { type: "BOOLEAN", value: false } },
  });
});

test("relative exact AND KLIKE AND LIKE は KLIKE / LIKE identity と applied 集合を保つ", () => {
  const stmt = select(
    "SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY() "
    + "AND 件名 KLIKE '至急' AND 備考 LIKE '%A%'"
  );
  const leaves = binaryLeaves(stmt.where);
  const originalKlike = leaves.find((leaf) => leaf.op === "KLIKE") as KlikeExpr;
  const originalLike = leaves.find((leaf) => leaf.op === "LIKE")!;
  const plan = eligible(decompose(stmt));
  const residualLeaves = binaryLeaves(plan.residualWhere);

  expect(residualLeaves).toContain(originalKlike);
  expect(residualLeaves).toContain(originalLike);
  expect(plan.appliedKlikes.has(originalKlike)).toBe(true);
  expect(binaryLeaves(plan.prefilterWhere)).toContain(originalKlike);
});

test("純 relative exact は Phase 1 に defer し、Phase 2 plan を作らない", () => {
  expect(decompose(
    select("SELECT 日付 FROM APP100 WHERE 日付 >= YESTERDAY()")
  )).toMatchObject({
    eligible: false,
    disposition: "DEFER_PHASE1",
    reasonCodes: ["DEFER_TO_PHASE1"],
    capability: "EXACT_PUSHDOWN",
  });
});
