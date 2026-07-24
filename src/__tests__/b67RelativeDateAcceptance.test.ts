import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSqlStatement } from "../core/sql";
import { resolveFieldSemantics } from "../core/fieldSemantics";
import { classifyWhereCapability } from "../core/optimization/whereCapability";
import { RELATIVE_DATE_FUNCTION_NAMES } from "../core/relativeDateFunction";
import { whereToKintone } from "../converter/whereToKintone";
import type { SelectStatement } from "../types/ast";

const CALLS = [
  "YESTERDAY()",
  "TOMORROW()",
  "FROM_TODAY(-7, DAYS)",
  "THIS_WEEK(MONDAY)",
  "LAST_WEEK(SUNDAY)",
  "NEXT_WEEK(SATURDAY)",
  "THIS_MONTH(1)",
  "LAST_MONTH(LAST)",
  "NEXT_MONTH(31)",
  "THIS_YEAR()",
  "LAST_YEAR()",
  "NEXT_YEAR()",
] as const;

const FIELD_TYPES = ["DATE", "DATETIME", "CREATED_TIME", "UPDATED_TIME"] as const;
const OPERATORS = ["=", "!=", "<", "<=", ">", ">="] as const;

type AcceptanceMapEntry = {
  id: string;
  requirement: string;
  proof: string;
  anchor: string;
};

/**
 * R2 §10.2〜§10.5 の自動証拠索引。
 *
 * 意味論の詳細は Step 1〜7 の狭い test に残し、この suite は各受入項目が
 * 実行可能な test/evidence に必ず結び付くことと、横断 matrix の代表 byte を固定する。
 */
const ACCEPTANCE_MAP: readonly AcceptanceMapEntry[] = [
  {
    id: "R2-10.2-01",
    requirement: "全12関数の大小文字、全4型、全6比較、引数境界、BETWEEN",
    proof: "src/parser/__tests__/b67RelativeDateFunctions.test.ts",
    anchor: "全12関数を小文字で parse",
  },
  {
    id: "R2-10.2-02",
    requirement: "全12関数と引数形の REST query byte",
    proof: "src/converter/__tests__/b67RelativeDateWhereToKintone.test.ts",
    anchor: "全12関数を byte 比較",
  },
  {
    id: "R2-10.2-03",
    requirement: "SIMPLE SELECT、UPDATE、DELETE、VALIDATE ONLY、KORDER native/cursor",
    proof: "src/__tests__/b67RelativeDateExecutionPaths.test.ts",
    anchor: "許可 %s は対象 query に関数を保持する",
  },
  {
    id: "R2-10.3-01",
    requirement: "全引数エラー、safe integer外、禁止位置、IN/NOT IN/NOT BETWEEN",
    proof: "src/parser/__tests__/b67RelativeDateFunctions.test.ts",
    anchor: "不正な引数を ParseError",
  },
  {
    id: "R2-10.3-02",
    requirement: "TIME、非日付、未知型、subtable、関連レコード、関数左辺",
    proof: "src/core/optimization/__tests__/b67RelativeDateWhereCapability.test.ts",
    anchor: "structural flags",
  },
  {
    id: "R2-10.4-01",
    requirement: "FULL_SCAN/JOIN/aggregate/window/DISTINCT/ORDER/CTE/temp/VALIDATE/DML/APPLY/REORDER API 0",
    proof: "src/__tests__/b67RelativeDateExecutionPaths.test.ts",
    anchor: "metadata 以外の API と confirm の前に拒否する",
  },
  {
    id: "R2-10.4-02",
    requirement: "AND/OR部分exact、KORDER native/cursor、REST errorでfallback 0",
    proof: "src/core/optimization/__tests__/b67RelativeDateKorder.test.ts",
    anchor: "Cursor error でも records/client fallback は0",
  },
  {
    id: "R2-10.4-03",
    requirement: "planner bypass時のruntime backstop",
    proof: "src/engine/__tests__/b67RelativeDateBackstop.test.ts",
    anchor: "planner を bypass",
  },
  {
    id: "R2-10.4-04",
    requirement: "EXPLAINと実行のquery/reason一致",
    proof: "src/__tests__/b67RelativeDateExplain.test.ts",
    anchor: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
  },
  {
    id: "R2-10.5-01",
    requirement: "既存3関数のAST/converter/SELECT/DML/EXPLAIN/resolver byte不変",
    proof: "src/converter/__tests__/b67RelativeDateWhereToKintone.test.ts",
    anchor: "legacy byte baseline",
  },
  {
    id: "R2-10.5-02",
    requirement: "Node/CLI/MCP/plugin shared-engine surface",
    proof: "src/__tests__/b67RelativeDateSurfaces.test.ts",
    anchor: "shared engine",
  },
  {
    id: "R2-10.5-03",
    requirement: "catalog/parser/fixture/docs/instructions drift guard",
    proof: "src/mcp/__tests__/b67RelativeDateDocs.test.ts",
    anchor: "relative-date catalog and documentation",
  },
  {
    id: "R2-10.5-04",
    requirement: "Firefox/Chrome実ブラウザ（Nodeで代替しない）",
    proof: "docs/internal/evidence/b67_relative_date_browser_smoke.md",
    anchor: "ユーザー実施待ち",
  },
] as const;

test("R2 §10.2〜§10.5 の受入IDは重複なく test/evidence の実在anchorへ1対1で対応する", () => {
  const ids = ACCEPTANCE_MAP.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([
    "R2-10.2-01", "R2-10.2-02", "R2-10.2-03",
    "R2-10.3-01", "R2-10.3-02",
    "R2-10.4-01", "R2-10.4-02", "R2-10.4-03", "R2-10.4-04",
    "R2-10.5-01", "R2-10.5-02", "R2-10.5-03", "R2-10.5-04",
  ]);
  for (const entry of ACCEPTANCE_MAP) {
    const content = readFileSync(resolve(process.cwd(), entry.proof), "utf8");
    expect(content).toContain(entry.anchor);
    expect(entry.requirement).not.toHaveLength(0);
  }
});

test.each(
  FIELD_TYPES.flatMap((fieldType) =>
    OPERATORS.flatMap((operator) =>
      CALLS.map((call) => [fieldType, operator, call] as const)
    )
  )
)("acceptance positive: %s × %s × %s はexactかつREST byte保持", (fieldType, operator, call) => {
  const statement = parseSqlStatement(
    `SELECT d FROM APP1 WHERE d ${operator} ${call}`
  ) as SelectStatement;
  const capability = classifyWhereCapability(
    statement.where,
    () => resolveFieldSemantics({ fieldType })
  );
  expect(capability.capability).toBe("EXACT_PUSHDOWN");
  expect(whereToKintone(statement.where!)).toBe(`d ${operator} ${call}`);
});

test("全12関数は大文字・小文字入力が同じ正規化REST byteになる", () => {
  expect(new Set(CALLS.map((call) => call.slice(0, call.indexOf("(")))))
    .toEqual(RELATIVE_DATE_FUNCTION_NAMES);
  for (const call of CALLS) {
    const upper = parseSqlStatement(`SELECT d FROM APP1 WHERE d = ${call}`) as SelectStatement;
    const lower = parseSqlStatement(
      `SELECT d FROM APP1 WHERE d = ${call.toLowerCase()}`
    ) as SelectStatement;
    expect(whereToKintone(lower.where!)).toBe(whereToKintone(upper.where!));
  }
});
