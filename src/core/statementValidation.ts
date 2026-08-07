import type { Statement, StringFuncExpr } from "../types/ast";
import { validateKlikeStatement } from "./klikeValidation";
import { validatePrimaryOrganizationDmlStatement } from "./primaryOrganizationDmlValidation";
import { assertStringFunctionArity } from "./functionArity";
import { validateGenerateSeriesInStatement } from "./generateSeries";

/** パース後、API 呼び出し前に全実行面で共有する静的検証。 */
export function validateStatementStatic(stmt: Statement): void {
  validateStringFunctionArities(stmt);
  validatePrimaryOrganizationDmlStatement(stmt);
  validateKlikeStatement(stmt);
  validateGenerateSeriesInStatement(stmt);
}

function validateStringFunctionArities(stmt: Statement): void {
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "STRING_FUNC") {
      const expr = node as unknown as StringFuncExpr;
      assertStringFunctionArity(expr.func, expr.args);
    }
    Object.values(node).forEach(visit);
  };
  visit(stmt);
}
