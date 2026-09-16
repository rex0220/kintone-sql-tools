import type { AggregateArgExpr, AggregateRef, FieldRef, StringFuncExpr } from "../types/ast";

export type ExpressionSemanticKind = "number" | "string";
export type ExpressionFieldSemanticResolver =
  (field: FieldRef) => ExpressionSemanticKind | { compareMode: string } | undefined;

export const NUMBER_RETURNING_FUNCTIONS = new Set([
  "LENGTH", "LENGTH_CHAR", "INSTR", "ROUND", "FLOOR", "CEIL", "TRUNCATE",
  "YEAR", "MONTH", "DAY", "DATEDIFF", "ABS", "MOD", "POWER", "SQRT",
  "DAYOFWEEK", "QUARTER", "WEEK",
]);

const ALL_NUMERIC_ARGUMENT_FUNCTIONS = new Set([
  "COALESCE", "ISNULL", "NULLIF", "GREATEST", "LEAST",
]);

function resolvedKind(value: ReturnType<ExpressionFieldSemanticResolver>): ExpressionSemanticKind {
  if (value === "number" || value === "string") return value;
  return value?.compareMode === "number" || value?.compareMode === "recordNumber" ? "number" : "string";
}

function fieldRefFromLegacyName(field: string): FieldRef {
  const dot = field.indexOf(".");
  return dot > 0
    ? { type: "FIELD", tableAlias: field.slice(0, dot), field: field.slice(dot + 1) }
    : { type: "FIELD", tableAlias: null, field };
}

function aggregateResultKind(
  ref: AggregateRef,
  resolveField?: ExpressionFieldSemanticResolver
): ExpressionSemanticKind {
  if (ref.func === "COUNT" || ref.func === "SUM" || ref.func === "AVG"
    || ref.func === "STDDEV_POP" || ref.func === "STDDEV_SAMP"
    || ref.func === "VAR_POP" || ref.func === "VAR_SAMP" || ref.func === "MEDIAN") return "number";
  if (ref.func === "GROUP_CONCAT") return "string";
  return ref.arg.type === "WILDCARD" ? "string" : expressionSemanticKind(ref.arg, resolveField);
}

export function stringFunctionSemanticKind(
  expr: StringFuncExpr,
  resolveField?: ExpressionFieldSemanticResolver
): ExpressionSemanticKind {
  if (expr.func === "CAST") {
    const target = expr.args[1];
    return target?.type === "STRING" && target.value === "NUMBER" ? "number" : "string";
  }
  if (NUMBER_RETURNING_FUNCTIONS.has(expr.func)) return "number";
  if (ALL_NUMERIC_ARGUMENT_FUNCTIONS.has(expr.func)
    && expr.args.length > 0
    && expr.args.every((arg) => expressionSemanticKind(arg, resolveField) === "number")) return "number";
  return "string";
}

export function expressionSemanticKind(
  expr: AggregateArgExpr | AggregateRef | unknown,
  resolveField?: ExpressionFieldSemanticResolver
): ExpressionSemanticKind {
  if (expr === null || typeof expr !== "object") return "string";
  const value = expr as Record<string, unknown>;
  switch (value["type"]) {
    case "NUMBER":
    case "ARITH":
    case "SCALAR_ARITH":
    case "AGG_ARITH":
      return "number";
    case "STRING_FUNC":
      return stringFunctionSemanticKind(expr as StringFuncExpr, resolveField);
    case "AGG_REF":
      return aggregateResultKind(expr as AggregateRef, resolveField);
    case "FIELD":
      return resolvedKind(resolveField?.(expr as FieldRef));
    case "FIELD_REF":
      return resolvedKind(resolveField?.(fieldRefFromLegacyName(value["field"] as string)));
    case "AGG_GROUP_KEY":
      return resolvedKind(resolveField?.({
        type: "FIELD",
        tableAlias: typeof value["tableAlias"] === "string" ? value["tableAlias"] : null,
        field: value["field"] as string,
      }));
    case "CASE_WHEN": {
      const branches = value["branches"] as Array<{ result: unknown }>;
      const elseResult = value["elseResult"];
      const results = [
        ...branches.map((branch) => branch.result),
        ...(elseResult === null || elseResult === undefined ? [] : [elseResult]),
      ];
      return results.length > 0
        && results.every((result) => expressionSemanticKind(result, resolveField) === "number")
        ? "number"
        : "string";
    }
    default:
      return "string";
  }
}
