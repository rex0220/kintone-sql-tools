import { resolveFieldSemantics } from "../../fieldSemantics";
import { SERVER_ONLY_WHERE_FUNCTION_NAMES } from "../../relativeDateFunction";
import { parseSqlStatement } from "../../sql";
import type { SelectStatement } from "../../../types/ast";
import { decomposeRelativeDatePrefilter } from "../relativeDatePrefilterPlan";
import {
  buildRelativeDateFullScanExactPlan,
  serverOnlyFunctionOccurrencesInWhere,
} from "../relativeDateFullScanExactPlan";
import { classifyWhereCapability } from "../whereCapability";

function select(sql: string): SelectStatement {
  return parseSqlStatement(sql) as SelectStatement;
}

const resolveField = (field: { field: string }) => resolveFieldSemantics({
  fieldType: field.field === "件名" ? "SINGLE_LINE_TEXT" : "DATE",
});

test("server-only WHERE 集合は legacy 3 + relative-date 12 の15関数", () => {
  expect([...SERVER_ONLY_WHERE_FUNCTION_NAMES]).toEqual([
    "TODAY",
    "NOW",
    "LOGINUSER",
    "YESTERDAY",
    "TOMORROW",
    "FROM_TODAY",
    "THIS_WEEK",
    "LAST_WEEK",
    "NEXT_WEEK",
    "THIS_MONTH",
    "LAST_MONTH",
    "NEXT_MONTH",
    "THIS_YEAR",
    "LAST_YEAR",
    "NEXT_YEAR",
  ]);
});

test("Phase2 serializer が同名 occurrence を1個落としたら plan を許可しない", () => {
  const statement = select(
    "SELECT $id FROM APP100 WHERE 日付 = TODAY() "
      + "AND 期限 = TODAY() AND LENGTH(件名) > 1"
  );
  const decomposition = decomposeRelativeDatePrefilter(
    statement,
    resolveField,
    {
      serialize: () => "日付 = TODAY()",
    }
  );
  expect(decomposition).toMatchObject({
    eligible: false,
    reasonCodes: ["PREFILTER_FUNCTION_MISSING"],
  });
});

test("FULL_SCAN_EXACT も legacy function occurrence multiset の欠落を拒否する", () => {
  const statement = select(
    "SELECT COUNT(*) FROM APP100 WHERE 日付 = TODAY() AND 期限 = TODAY()"
  );
  if (statement.where === null) throw new Error("WHERE fixture expected");
  const capability = classifyWhereCapability(statement.where, resolveField);
  const occurrences = serverOnlyFunctionOccurrencesInWhere(statement.where);
  expect(occurrences).toEqual(["TODAY", "TODAY"]);
  expect(buildRelativeDateFullScanExactPlan({
    select: statement,
    selectMode: "FULL_SCAN",
    capability,
    context: { allowFullScanExact: true },
    serializedWholeWhere: "日付 = TODAY()",
    relativeFunctionNames: occurrences,
  })).toBeNull();
});
