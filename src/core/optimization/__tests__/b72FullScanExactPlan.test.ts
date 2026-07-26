import { resolveSelectMode } from "../../../converter/selectToKintone";
import { whereToKintone } from "../../../converter/whereToKintone";
import type { SelectStatement } from "../../../types/ast";
import { parseSqlStatement } from "../../sql";
import {
  buildRelativeDateFullScanExactPlan,
  type RelativeDateFullScanExactContext,
  type RelativeDateFullScanExactPlanInput,
} from "../relativeDateFullScanExactPlan";
import type { PredicateCapabilityResult } from "../whereCapability";

const ALLOWED_CONTEXT: RelativeDateFullScanExactContext = {
  allowFullScanExact: true,
};
const FORBIDDEN_CONTEXT: RelativeDateFullScanExactContext = {
  allowFullScanExact: false,
};
const EXACT: PredicateCapabilityResult = {
  capability: "EXACT_PUSHDOWN",
  reasons: [],
};

function select(sql: string): SelectStatement {
  return parseSqlStatement(sql) as SelectStatement;
}

function input(
  stmt: SelectStatement,
  overrides: Partial<RelativeDateFullScanExactPlanInput> = {}
): RelativeDateFullScanExactPlanInput {
  return {
    select: stmt,
    selectMode: resolveSelectMode(stmt),
    capability: EXACT,
    context: ALLOWED_CONTEXT,
    serializedWholeWhere:
      stmt.where === null ? null : whereToKintone(stmt.where),
    relativeFunctionNames: ["THIS_MONTH"],
    ...overrides,
  };
}

const POSITIVE_CASES = [
  [
    "GROUP BY",
    "SELECT 区分, COUNT(*) AS 件数 FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() GROUP BY 区分",
  ],
  [
    "DISTINCT",
    "SELECT DISTINCT 区分 FROM APP100 WHERE 日付 = THIS_MONTH()",
  ],
  [
    "aggregate",
    "SELECT COUNT(*) AS 件数 FROM APP100 WHERE 日付 = THIS_MONTH()",
  ],
  [
    "window",
    "SELECT 日付, ROW_NUMBER() OVER (ORDER BY 日付) AS rn "
      + "FROM APP100 WHERE 日付 = THIS_MONTH()",
  ],
  [
    "plain canonical ORDER BY",
    "SELECT 日付 FROM APP100 WHERE 日付 = THIS_MONTH() ORDER BY 日付",
  ],
] as const;

test.each(POSITIVE_CASES)(
  "%s の whole-WHERE exact は FULL_SCAN_EXACT plan を作る",
  (_label, sql) => {
    const stmt = select(sql);
    const plan = buildRelativeDateFullScanExactPlan(input(stmt));

    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      allowForm: "FULL_SCAN_EXACT",
      clientWhereEvaluation: false,
      prefilterPlan: {
        capability: "EXACT_PUSHDOWN",
        residualWhere: null,
      },
    });
    expect(plan?.prefilterPlan.prefilterWhere).toBe(stmt.where);
  }
);

test("whole-WHERE exact の OR は分解せず元 WHERE 全体を採用する", () => {
  const stmt = select(
    "SELECT 区分, COUNT(*) AS 件数 FROM APP100 "
      + "WHERE 日付 = THIS_MONTH() OR 日付 = LAST_MONTH() GROUP BY 区分"
  );
  const plan = buildRelativeDateFullScanExactPlan(input(stmt, {
    relativeFunctionNames: ["THIS_MONTH", "LAST_MONTH"],
  }));

  expect(plan).not.toBeNull();
  expect(plan?.prefilterPlan.prefilterWhere).toBe(stmt.where);
  expect(plan?.prefilterPlan.exactRelativeLeaves).toHaveLength(2);
  expect(plan?.prefilterPlan.residualWhere).toBeNull();
});

type NegativeFixture = {
  readonly label: string;
  readonly build: () => RelativeDateFullScanExactPlanInput;
};

const negativeCases: readonly NegativeFixture[] = [
  {
    label: "KORDER",
    build: () => {
      const stmt = select(
        "SELECT 区分, COUNT(*) AS 件数 FROM APP100 "
          + "WHERE 日付 = THIS_MONTH() GROUP BY 区分"
      );
      return input(
        { ...stmt, orderMode: "KINTONE_NATIVE" },
        { selectMode: "FULL_SCAN" }
      );
    },
  },
  {
    label: "JOIN",
    build: () => {
      const stmt = select(
        "SELECT a.日付 FROM APP100 a JOIN APP200 b ON a.$id = b.$id "
          + "WHERE a.日付 = THIS_MONTH()"
      );
      return input(stmt);
    },
  },
  {
    label: "subtable",
    build: () => input(select(
      "SELECT 日付 FROM APP100$明細 WHERE 日付 = THIS_MONTH()"
    )),
  },
  ...(["CTE", "temp", "derived"] as const).map((label): NegativeFixture => ({
    label,
    build: () => {
      const stmt = select(
        "SELECT DISTINCT 日付 FROM APP100 WHERE 日付 = THIS_MONTH()"
      );
      const sourceName = label === "temp" ? "#t" : label.toLowerCase();
      const nonPhysical = {
        ...stmt,
        from: { ...stmt.from, appId: 0, cteName: sourceName },
      };
      return input(nonPhysical, { selectMode: "FULL_SCAN" });
    },
  })),
  {
    label: "materialized source context",
    build: () => input(
      select("SELECT DISTINCT 日付 FROM APP100 WHERE 日付 = THIS_MONTH()"),
      { context: FORBIDDEN_CONTEXT }
    ),
  },
  {
    label: "DML-source context",
    build: () => input(
      select("SELECT DISTINCT 日付 FROM APP100 WHERE 日付 = THIS_MONTH()"),
      { context: FORBIDDEN_CONTEXT }
    ),
  },
  ...(["SUPERSET_PREFILTER", "LOCAL_ONLY"] as const).map(
    (capability): NegativeFixture => ({
      label: capability,
      build: () => input(
        select("SELECT DISTINCT 日付 FROM APP100 WHERE 日付 = THIS_MONTH()"),
        { capability: { capability, reasons: [] } }
      ),
    })
  ),
  {
    label: "serialization failure",
    build: () => input(
      select("SELECT DISTINCT 日付 FROM APP100 WHERE 日付 = THIS_MONTH()"),
      { serializedWholeWhere: null }
    ),
  },
  {
    label: "missing relative function occurrence",
    build: () => {
      const stmt = select(
        "SELECT DISTINCT 日付 FROM APP100 "
          + "WHERE 日付 = THIS_MONTH() OR 日付 != THIS_MONTH()"
      );
      return input(stmt, {
        serializedWholeWhere: "日付 = THIS_MONTH()",
        relativeFunctionNames: ["THIS_MONTH", "THIS_MONTH"],
      });
    },
  },
  {
    label: "no relative-date function",
    build: () => {
      const stmt = select("SELECT DISTINCT 日付 FROM APP100 WHERE 日付 = '2026-07-01'");
      return input(stmt, { relativeFunctionNames: [] });
    },
  },
  {
    label: "SIMPLE without canonical ORDER BY",
    build: () => input(
      select("SELECT 日付 FROM APP100 WHERE 日付 = THIS_MONTH()")
    ),
  },
];

test.each(negativeCases)("$label は plan を作らない", ({ build }) => {
  expect(buildRelativeDateFullScanExactPlan(build())).toBeNull();
});

test.each(POSITIVE_CASES)(
  "invariant: %s の plan は residualWhere を決して保持しない",
  (_label, sql) => {
    const plan = buildRelativeDateFullScanExactPlan(input(select(sql)));
    expect(plan).not.toBeNull();
    expect(plan?.prefilterPlan.residualWhere).toBeNull();
  }
);
