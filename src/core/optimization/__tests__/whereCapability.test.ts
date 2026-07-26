import { parseSqlStatement } from "../../sql";
import { resolveFieldSemantics } from "../../fieldSemantics";
import {
  classifyWhereCapability,
  nativeWhereOperatorsForType,
} from "../whereCapability";
import type { CompareOp, SelectStatement } from "../../../types/ast";

function whereOf(sql: string) {
  return (parseSqlStatement(sql) as SelectStatement).where;
}

function classify(sql: string, fields: Record<string, {
  fieldType: string;
  inSubtable?: boolean;
  requiresCollectionOperators?: boolean;
}>) {
  return classifyWhereCapability(whereOf(sql), (field) => {
    const source = fields[field.field];
    return source ? resolveFieldSemantics(source) : undefined;
  });
}

test.each([
  ["RECORD_NUMBER", ["=", "!=", ">", "<", ">=", "<=", "in", "not in"]],
  ["SINGLE_LINE_TEXT", ["=", "!=", "in", "not in", "like", "not like"]],
  ["NUMBER", ["=", "!=", ">", "<", ">=", "<=", "in", "not in"]],
  ["MULTI_LINE_TEXT", ["like", "not like"]],
  ["DROP_DOWN", ["in", "not in"]],
  ["STATUS", ["=", "!=", "in", "not in"]],
  ["STATUS_ASSIGNEE", []],
  ["FUTURE_FIELD", []],
] as const)("native capability matrix: %s", (fieldType, operators) => {
  expect([...nativeWhereOperatorsForType(fieldType)]).toEqual(operators);
});

test.each([
  ["SELECT x FROM APP1 WHERE x > '100'", "SINGLE_LINE_TEXT", "LOCAL_ONLY"],
  ["SELECT x FROM APP1 WHERE x = '100'", "SINGLE_LINE_TEXT", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x > 100", "NUMBER", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x IN ('A')", "DROP_DOWN", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x LIKE '%A%'", "SINGLE_LINE_TEXT", "LOCAL_ONLY"],
  ["SELECT x FROM APP1 WHERE x KLIKE 'A'", "SINGLE_LINE_TEXT", "EXACT_PUSHDOWN"],
  ["SELECT x FROM APP1 WHERE x > 1", "CHECK_BOX", "UNSUPPORTED"],
  ["SELECT x FROM APP1 WHERE x = 'A'", "DROP_DOWN", "LOCAL_ONLY"],
] as const)("%s / %s => %s", (sql, fieldType, expected) => {
  expect(classify(sql, { x: { fieldType } }).capability).toBe(expected);
});

describe("B78 local-valid operator partial policy", () => {
  test.each([
    "CREATOR",
    "MODIFIER",
    "CHECK_BOX",
    "MULTI_SELECT",
  ] as const)("%s は IN / NOT IN 以外を新 reason で拒否する", (fieldType) => {
    for (const sql of [
      "SELECT x FROM APP1 WHERE x = 'A'",
      "SELECT x FROM APP1 WHERE x != 'A'",
      "SELECT x FROM APP1 WHERE x LIKE 'A'",
      "SELECT x FROM APP1 WHERE x IS NULL",
    ]) {
      const result = classify(sql, { x: { fieldType } });
      expect(result.capability).toBe("UNSUPPORTED");
      expect(result.reasons).toContainEqual(expect.objectContaining({
        code: "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE",
        field: "x",
        fieldType,
      }));
    }

    expect(classify("SELECT x FROM APP1 WHERE x IN ('A')", { x: { fieldType } }).capability)
      .toBe("EXACT_PUSHDOWN");
    expect(classify("SELECT x FROM APP1 WHERE x NOT IN ('A')", { x: { fieldType } }).capability)
      .toBe("EXACT_PUSHDOWN");
  });

  test.each([
    ["USER_SELECT", "LOCAL_ONLY"],
    ["ORGANIZATION_SELECT", "LOCAL_ONLY"],
    ["GROUP_SELECT", "LOCAL_ONLY"],
    ["STATUS_ASSIGNEE", "LOCAL_ONLY"],
    ["STATUS", "EXACT_PUSHDOWN"],
    ["DROP_DOWN", "LOCAL_ONLY"],
    ["RADIO_BUTTON", "LOCAL_ONLY"],
  ] as const)("%s の = は B78 partial policy の対象外", (fieldType, capability) => {
    const result = classify("SELECT x FROM APP1 WHERE x = 'A'", { x: { fieldType } });
    expect(result.capability).toBe(capability);
    expect(result.reasons).not.toContainEqual(expect.objectContaining({
      code: "WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE",
    }));
  });
});

test("AND は exact leaf を上位集合prefilterとして残し、OR は全体をlocalにする", () => {
  const fields = { n: { fieldType: "NUMBER" }, s: { fieldType: "SINGLE_LINE_TEXT" } };
  expect(classify("SELECT n FROM APP1 WHERE n > 1 AND s > '1'", fields).capability)
    .toBe("SUPERSET_PREFILTER");
  expect(classify("SELECT n FROM APP1 WHERE n > 1 OR s > '1'", fields).capability)
    .toBe("LOCAL_ONLY");
});

test("NOT は内側の上位集合prefilterをLOCAL_ONLYへ落とす", () => {
  const fields = { n: { fieldType: "NUMBER" }, s: { fieldType: "SINGLE_LINE_TEXT" } };
  const result = classify("SELECT n FROM APP1 WHERE NOT (n > 1 AND s > '1')", fields);
  expect(result.capability).toBe("LOCAL_ONLY");
  expect(result.reasons).toEqual([{ code: "WHERE_EXPRESSION_LOCAL_ONLY" }]);
});

test("サブテーブル内の = はnative不可、INは基底型能力を使う", () => {
  const fields = { x: { fieldType: "SINGLE_LINE_TEXT", inSubtable: true } };
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", fields).capability).toBe("LOCAL_ONLY");
  expect(classify("SELECT x FROM APP1 WHERE x IN ('A')", fields).capability).toBe("EXACT_PUSHDOWN");
});

test("関連レコード参照先も = を使わずIN系の構造制約を優先する", () => {
  const fields = { x: { fieldType: "SINGLE_LINE_TEXT", requiresCollectionOperators: true } };
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", fields).capability).toBe("LOCAL_ONLY");
  expect(classify("SELECT x FROM APP1 WHERE x IN ('A')", fields).capability).toBe("EXACT_PUSHDOWN");
});

test("未知フィールド・未知型はfail-closedにする", () => {
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", {}).capability).toBe("UNSUPPORTED");
  expect(classify("SELECT x FROM APP1 WHERE x = 'A'", { x: { fieldType: "FUTURE_FIELD" } }).capability)
    .toBe("UNSUPPORTED");
});

function classifyLegacy(
  name: "TODAY" | "NOW" | "LOGINUSER",
  fieldType: string,
  op: CompareOp,
  field = "x"
) {
  return classifyWhereCapability(
    {
      type: "BINARY",
      op,
      left: { type: "FIELD", tableAlias: null, field },
      right: { type: "KINTONE_FUNC", name },
    },
    () => resolveFieldSemantics({ fieldType })
  );
}

describe("B77 legacy kintone function field type × operator classifier", () => {
  test.each([
    ["TODAY", "DATE"],
    ["TODAY", "DATETIME"],
    ["TODAY", "CREATED_TIME"],
    ["TODAY", "UPDATED_TIME"],
    ["NOW", "DATETIME"],
    ["NOW", "CREATED_TIME"],
    ["NOW", "UPDATED_TIME"],
  ] as const)("%s × %s は比較6演算子だけ exact", (name, fieldType) => {
    for (const op of ["=", "!=", ">", "<", ">=", "<="] as const) {
      expect(classifyLegacy(name, fieldType, op)).toEqual({
        capability: "EXACT_PUSHDOWN",
        reasons: [{
          code: "WHERE_EXACT",
          functionName: name,
          field: "x",
          fieldType,
          operator: op,
        }],
      });
    }
    const invalid = classifyLegacy(name, fieldType, "LIKE");
    expect(invalid.capability).toBe("UNSUPPORTED");
    expect(invalid.reasons[0]).toMatchObject({
      code: "WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED",
      functionName: name,
      fieldType,
      operator: "like",
    });
  });

  test.each([
    "CREATOR",
    "MODIFIER",
    "USER_SELECT",
  ] as const)("LOGINUSER × %s は IN / NOT IN だけ exact", (fieldType) => {
    for (const op of ["IN", "NOT_IN"] as const) {
      expect(classifyLegacy("LOGINUSER", fieldType, op).capability).toBe("EXACT_PUSHDOWN");
    }
    const invalid = classifyLegacy("LOGINUSER", fieldType, "=");
    expect(invalid.capability).toBe("UNSUPPORTED");
    expect(invalid.reasons[0]).toMatchObject({
      code: "WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED",
      functionName: "LOGINUSER",
      fieldType,
      operator: "=",
    });
  });

  test("GROUP_SELECT × LOGINUSER は field type unsupported", () => {
    const result = classifyLegacy("LOGINUSER", "GROUP_SELECT", "IN");
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toMatchObject({
      code: "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
      functionName: "LOGINUSER",
      fieldType: "GROUP_SELECT",
      operator: "in",
    });
  });

  test("DATE × NOW は field type unsupported", () => {
    const result = classify("SELECT x FROM APP1 WHERE x = NOW()", { x: { fieldType: "DATE" } });
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toMatchObject({
      code: "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
      functionName: "NOW",
      fieldType: "DATE",
      operator: "=",
    });
  });

  test("$id × TODAY は field type unsupported", () => {
    const result = classify(
      "SELECT $id FROM APP1 WHERE $id >= TODAY()",
      { $id: { fieldType: "__ID__" } }
    );
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toMatchObject({
      code: "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
      functionName: "TODAY",
      field: "$id",
      fieldType: "__ID__",
      operator: ">=",
    });
  });

  test("式左辺は context unsupported", () => {
    const result = classify(
      "SELECT x FROM APP1 WHERE UPPER(x) = TODAY()",
      { x: { fieldType: "DATE" } }
    );
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toMatchObject({
      code: "WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED",
      functionName: "TODAY",
      operator: "=",
    });
  });

  test("legacy 関数の拒否は specific reason と requires-exact reason を保持する", () => {
    const result = classify("SELECT x FROM APP1 WHERE x = NOW()", { x: { fieldType: "DATE" } });
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED",
      "WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN",
    ]);
  });
});
