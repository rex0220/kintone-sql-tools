import type { Statement } from "../types/ast";
import { validateKlikeStatement } from "./klikeValidation";
import { validatePrimaryOrganizationDmlStatement } from "./primaryOrganizationDmlValidation";

/** パース後、API 呼び出し前に全実行面で共有する静的検証。 */
export function validateStatementStatic(stmt: Statement): void {
  validatePrimaryOrganizationDmlStatement(stmt);
  validateKlikeStatement(stmt);
}
