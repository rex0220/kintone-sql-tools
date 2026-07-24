import { parseSqlStatement } from "../../sql";
import { resolveFieldSemantics } from "../../fieldSemantics";
import { classifyWhereCapability } from "../whereCapability";
import type {
  CompareOp,
  RelativeDateFunction,
  SelectStatement,
  WhereExpr,
} from "../../../types/ast";

const RELATIVE_FUNCTIONS = [
  "YESTERDAY()",
  "TOMORROW()",
  "FROM_TODAY(-7, DAYS)",
  "THIS_WEEK()",
  "LAST_WEEK(MONDAY)",
  "NEXT_WEEK(SUNDAY)",
  "THIS_MONTH()",
  "LAST_MONTH(LAST)",
  "NEXT_MONTH(31)",
  "THIS_YEAR()",
  "LAST_YEAR()",
  "NEXT_YEAR()",
] as const;

const DATE_FIELD_TYPES = ["DATE", "DATETIME", "CREATED_TIME", "UPDATED_TIME"] as const;
const COMPARISON_OPERATORS = ["=", "!=", "<", "<=", ">", ">="] as const;

type FieldSource = {
  fieldType: string;
  inSubtable?: boolean;
  requiresCollectionOperators?: boolean;
};

function whereOf(sql: string): WhereExpr | null {
  return (parseSqlStatement(sql) as SelectStatement).where;
}

function classify(
  where: WhereExpr | null,
  fields: Record<string, FieldSource>
) {
  return classifyWhereCapability(where, (field) => {
    const source = fields[field.field];
    return source ? resolveFieldSemantics(source) : undefined;
  });
}

function relativeFunctionFrom(sql: string): RelativeDateFunction {
  const where = whereOf(`SELECT d FROM APP1 WHERE d = ${sql}`);
  if (where?.type !== "BINARY" || where.right.type !== "KINTONE_FUNC" || !("args" in where.right)) {
    throw new Error(`relative function fixture could not be parsed: ${sql}`);
  }
  return where.right;
}

function binary(
  op: CompareOp,
  right: RelativeDateFunction,
  field = "d"
): WhereExpr {
  return {
    type: "BINARY",
    op,
    left: { type: "FIELD", tableAlias: null, field },
    right,
  };
}

describe("B67 relative-date exact pushdown allowlist", () => {
  test.each(
    DATE_FIELD_TYPES.flatMap((fieldType) =>
      COMPARISON_OPERATORS.flatMap((operator) =>
        RELATIVE_FUNCTIONS.map((fn) => [fieldType, operator, fn] as const)
      )
    )
  )("%s × %s × %s is exact", (fieldType, operator, fn) => {
    const result = classify(
      whereOf(`SELECT d FROM APP1 WHERE d ${operator} ${fn}`),
      { d: { fieldType } }
    );
    expect(result).toEqual({
      capability: "EXACT_PUSHDOWN",
      reasons: [{
        code: "WHERE_EXACT",
        functionName: fn.slice(0, fn.indexOf("(")),
        field: "d",
        fieldType,
        operator,
      }],
    });
  });

  test.each(
    ([
      ["TIME", {}],
      ["NUMBER", {}],
      ["SINGLE_LINE_TEXT", {}],
      ["CHECK_BOX", {}],
      ["FUTURE_FIELD", {}],
      ["DATE", { inSubtable: true }],
      ["DATETIME", { requiresCollectionOperators: true }],
      ["KSQL_STRING", {}],
    ] as const).flatMap(([fieldType, flags]) =>
      RELATIVE_FUNCTIONS.map((fn) => [fieldType, flags, fn] as const)
    )
  )("%s / structural flags × %s are rejected as field type unsupported", (fieldType, flags, fn) => {
    const functionName = fn.slice(0, fn.indexOf("("));
    const result = classify(
      whereOf(`SELECT d FROM APP1 WHERE d = ${fn}`),
      { d: { fieldType, ...flags } }
    );
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toEqual({
      code: "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED",
      functionName,
      field: "d",
      fieldType,
      operator: "=",
    });
    expect(result.reasons).toContainEqual({
      code: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
      functionName,
      field: "d",
      fieldType,
      operator: "=",
    });
  });

  test.each(RELATIVE_FUNCTIONS)(
    "unresolved field × %s is rejected with the relative-date field-type reason",
    (fn) => {
    const functionName = fn.slice(0, fn.indexOf("("));
    const result = classify(
      whereOf(`SELECT missing FROM APP1 WHERE missing = ${fn}`),
      {}
    );
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toEqual({
      code: "WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED",
      functionName,
      field: "missing",
      fieldType: undefined,
      operator: "=",
    });
  });

  test.each(
    ([
      ["IN", "in"],
      ["NOT_IN", "not in"],
      ["LIKE", "like"],
      ["NOT_LIKE", "not like"],
      ["KLIKE", "like"],
      ["NOT_KLIKE", "not like"],
    ] as const).flatMap(([operator, normalized]) =>
      RELATIVE_FUNCTIONS.map((fn) => [operator, normalized, fn] as const)
    )
  )("operator %s × %s is rejected", (operator, normalized, fn) => {
    const functionName = fn.slice(0, fn.indexOf("("));
    const result = classify(
      binary(operator, relativeFunctionFrom(fn)),
      { d: { fieldType: "DATE" } }
    );
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toEqual({
      code: "WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED",
      functionName,
      field: "d",
      fieldType: "DATE",
      operator: normalized,
    });
  });

  test("expression/function left context is rejected", () => {
    const result = classify(
      whereOf("SELECT d FROM APP1 WHERE UPPER(d) = YESTERDAY()"),
      { d: { fieldType: "DATE" } }
    );
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0]).toEqual({
      code: "WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED",
      functionName: "YESTERDAY",
      field: undefined,
      fieldType: undefined,
      operator: "=",
    });
  });

  test("malformed relative-date AST is rejected with the argument reason", () => {
    const malformed = {
      type: "KINTONE_FUNC",
      name: "FROM_TODAY",
      args: {
        kind: "FROM_TODAY",
        offset: 1.5,
        offsetText: "1.5",
        unit: "DAYS",
      },
    } as unknown as RelativeDateFunction;
    const result = classify(binary("=", malformed), { d: { fieldType: "DATE" } });
    expect(result.capability).toBe("UNSUPPORTED");
    expect(result.reasons[0].code).toBe("WHERE_RELATIVE_DATE_ARGUMENT_INVALID");
    expect(result.reasons[0]).toMatchObject({
      functionName: "FROM_TODAY",
      field: "d",
      fieldType: "DATE",
      operator: "=",
    });
  });
});

describe("B67 logical composition keeps whole-WHERE capability and reasons", () => {
  const fields = {
    d: { fieldType: "DATE" },
    s: { fieldType: "SINGLE_LINE_TEXT" },
  };

  test("AND with one exact relative leaf is a superset, not exact", () => {
    const result = classify(
      whereOf("SELECT d FROM APP1 WHERE d = YESTERDAY() AND s > 'A'"),
      fields
    );
    expect(result.capability).toBe("SUPERSET_PREFILTER");
    expect(result.reasons).toContainEqual(expect.objectContaining({
      code: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
      functionName: "YESTERDAY",
      field: "d",
      fieldType: "DATE",
      operator: "=",
    }));
  });

  test("OR with one exact relative leaf is local, not exact", () => {
    const result = classify(
      whereOf("SELECT d FROM APP1 WHERE d = YESTERDAY() OR s > 'A'"),
      fields
    );
    expect(result.capability).toBe("LOCAL_ONLY");
    expect(result.reasons).toContainEqual(expect.objectContaining({
      code: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
      functionName: "YESTERDAY",
    }));
  });

  test("BETWEEN expansion is exact only when both expanded comparisons are exact", () => {
    const exact = classify(
      whereOf("SELECT d FROM APP1 WHERE d BETWEEN FROM_TODAY(-7, DAYS) AND TODAY()"),
      fields
    );
    expect(exact.capability).toBe("EXACT_PUSHDOWN");

    const partial = classify(
      whereOf("SELECT d FROM APP1 WHERE d BETWEEN FROM_TODAY(-7, DAYS) AND @high"),
      fields
    );
    expect(partial.capability).toBe("SUPERSET_PREFILTER");
    expect(partial.reasons).toContainEqual(expect.objectContaining({
      code: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
      functionName: "FROM_TODAY",
      operator: ">=",
    }));
  });

  test("an unsupported relative leaf keeps its reason through AND/OR combination", () => {
    for (const logical of ["AND", "OR"] as const) {
      const result = classify(
        whereOf(`SELECT d FROM APP1 WHERE d LIKE YESTERDAY() ${logical} d = TODAY()`),
        fields
      );
      expect(result.capability).toBe("UNSUPPORTED");
      expect(result.reasons).toContainEqual(expect.objectContaining({
        code: "WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED",
        functionName: "YESTERDAY",
        operator: "like",
      }));
      expect(result.reasons).toContainEqual(expect.objectContaining({
        code: "WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN",
        functionName: "YESTERDAY",
      }));
    }
  });
});
