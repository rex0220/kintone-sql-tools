import type {
  AggregateArgExpr,
  AggregateFunc,
  AggOperand,
  ArithNode,
  CaseResult,
  FieldValue,
  ScalarValueExpr,
  SqlValue,
  StringFuncArg,
  StringFuncExpr,
  WhereExpr,
  WildcardColumn,
} from "../types/ast";
import { numberLiteralText } from "../types/ast";

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function arithLabel(node: ArithNode, topLevel = false): string {
  if (node.type === "VARIABLE") throw new Error(
    `InternalError: unresolved arithmetic variable @${node.name} reached aggregate expression labeling.`
  );
  if (node.type === "FIELD_REF") return node.field;
  if (node.type === "NUMBER") return numberLiteralText(node);
  if (node.type === "STRING_FUNC") return stringFuncLabel(node);
  const label = `${arithLabel(node.left)}${node.op}${arithLabel(node.right)}`;
  return topLevel ? label : `(${label})`;
}

function fieldValueLabel(value: FieldValue): string {
  if (value.type === "FIELD") return value.tableAlias ? `${value.tableAlias}.${value.field}` : value.field;
  if (value.type === "FUNC_FIELD") return stringFuncLabel(value.expr);
  if (value.type === "ARITH_FIELD") return arithLabel(value.expr);
  if (value.type === "GROUPING_FIELD") {
    const field = value.ref.field;
    return `GROUPING(${field.tableAlias ? `${field.tableAlias}.` : ""}${field.field})`;
  }
  return caseLabel(value.expr);
}

function sqlValueLabel(value: SqlValue): string {
  switch (value.type) {
    case "STRING": return quote(value.value);
    case "NUMBER": return numberLiteralText(value);
    case "VARIABLE": return `@${value.name}`;
    case "VARIABLE_IN_LIST": return `@${value.name}`;
    case "KINTONE_FUNC": return `${value.name}()`;
    case "ARRAY": return `[${value.elements.map((entry) => quote(entry.value)).join(",")}]`;
    case "IN_LIST": return `(${value.values.map(sqlValueLabel).join(",")})`;
    case "ARITH_VALUE": return arithLabel(value.expr);
    case "CASE_VALUE": return caseLabel(value.expr);
    case "SUBQUERY_IN_LIST": return "(SUBQUERY)";
    case "SCALAR_SUBQUERY": return "(SUBQUERY)";
  }
}

function whereLabel(expr: WhereExpr): string {
  switch (expr.type) {
    case "BINARY": return `${fieldValueLabel(expr.left)} ${expr.op.replace("_", " ")} ${sqlValueLabel(expr.right)}`;
    case "NULL_CHECK": return `${fieldValueLabel(expr.field)} IS ${expr.not ? "NOT " : ""}NULL`;
    case "LOGICAL": return `(${whereLabel(expr.left)} ${expr.op} ${whereLabel(expr.right)})`;
    case "NOT": return `NOT (${whereLabel(expr.expr)})`;
    case "GROUP": return `(${whereLabel(expr.expr)})`;
    case "BOOLEAN": return expr.value ? "TRUE" : "FALSE";
    case "EXISTS": return `${expr.not ? "NOT " : ""}EXISTS (SUBQUERY)`;
  }
}

function caseResultLabel(result: CaseResult): string {
  if (result.type === "ARRAY") return `[${result.elements.map((entry) => quote(entry.value)).join(",")}]`;
  if (result.type === "AGG_REF") return aggregateSyntheticName(result.func, result.distinct, result.arg);
  if (result.type === "AGG_ARITH") return aggregateOperandLabel(result);
  if (result.type === "FIELD_REF" || result.type === "ARITH") return arithLabel(result);
  return scalarValueLabel(result);
}

function caseLabel(expr: Extract<ScalarValueExpr, { type: "CASE_WHEN" }>): string {
  const branches = expr.branches
    .map((branch) => `WHEN ${whereLabel(branch.condition)} THEN ${caseResultLabel(branch.result)}`)
    .join(" ");
  const otherwise = expr.elseResult === null ? "" : ` ELSE ${caseResultLabel(expr.elseResult)}`;
  return `CASE ${branches}${otherwise} END`;
}

function stringFuncArgLabel(arg: StringFuncArg): string {
  if (arg.type === "AGG_REF") return aggregateSyntheticName(arg.func, arg.distinct, arg.arg);
  if (arg.type === "AGG_ARITH") return aggregateOperandLabel(arg);
  return scalarValueLabel(arg);
}

function stringFuncLabel(expr: StringFuncExpr): string {
  return `${expr.func}(${expr.args.map(stringFuncArgLabel).join(",")})`;
}

export function scalarValueLabel(expr: ScalarValueExpr): string {
  switch (expr.type) {
    case "STRING": return quote(expr.value);
    case "NUMBER": return numberLiteralText(expr);
    case "VARIABLE": return `@${expr.name}`;
    case "FIELD": return expr.tableAlias ? `${expr.tableAlias}.${expr.field}` : expr.field;
    case "STRING_FUNC": return stringFuncLabel(expr);
    case "CASE_WHEN": return caseLabel(expr);
    case "SCALAR_ARITH": return `(${scalarValueLabel(expr.left)}${expr.op}${scalarValueLabel(expr.right)})`;
    case "CONCAT_OP": return `(${scalarValueLabel(expr.left)}||${scalarValueLabel(expr.right)})`;
  }
}

export function aggregateArgLabel(arg: WildcardColumn | AggregateArgExpr): string {
  if (arg.type === "WILDCARD") return "*";
  if (arg.type === "FIELD_REF" || arg.type === "ARITH") return arithLabel(arg, true);
  return scalarValueLabel(arg);
}

export function aggregateSyntheticName(
  func: AggregateFunc,
  distinct: boolean,
  arg: WildcardColumn | AggregateArgExpr
): string {
  const label = aggregateArgLabel(arg);
  return distinct ? `${func}(DISTINCT ${label})` : `${func}(${label})`;
}

export function aggregateOperandLabel(node: AggOperand): string {
  if (node.type === "NUMBER") return numberLiteralText(node);
  if (node.type === "AGG_REF") return aggregateSyntheticName(node.func, node.distinct, node.arg);
  return `${aggregateOperandLabel(node.left)}${node.op}${aggregateOperandLabel(node.right)}`;
}
