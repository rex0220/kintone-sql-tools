import type { Statement } from "../types/ast";

/** PRIMARY_ORGANIZATION() の DML fail-closed 制約違反。 */
export class PrimaryOrganizationDmlValidationError extends Error {
  constructor() {
    super(
      "ArgumentError: PRIMARY_ORGANIZATION() は DML の WHERE では使用できません"
    );
    this.name = "ArgumentError";
  }
}

/**
 * 優先組織が未設定のときに kintone が条件を無視する契約から DML を保護する。
 * SELECT は対象外。DML 自身と、その入力 SELECT に属する WHERE だけを検査する。
 */
export function validatePrimaryOrganizationDmlStatement(stmt: Statement): void {
  const target = stmt.type === "EXPLAIN" ? stmt.query : stmt;
  switch (target.type) {
    case "UPDATE":
    case "DELETE":
    case "UPSERT":
    case "UPSERT_SELECT":
    case "INSERT_SELECT":
      if (hasPrimaryOrganizationInWhere(target)) {
        throw new PrimaryOrganizationDmlValidationError();
      }
      return;
    default:
      return;
  }
}

function hasPrimaryOrganizationInWhere(node: unknown): boolean {
  let found = false;
  walkObjects(node, (obj) => {
    if (found || !Object.prototype.hasOwnProperty.call(obj, "where")) return;
    if (containsPrimaryOrganization(obj.where)) found = true;
  });
  return found;
}

function containsPrimaryOrganization(node: unknown): boolean {
  let found = false;
  walkObjects(node, (obj) => {
    if (
      obj.type === "KINTONE_FUNC"
      && obj.name === "PRIMARY_ORGANIZATION"
    ) {
      found = true;
    }
  });
  return found;
}

function walkObjects(
  node: unknown,
  visit: (obj: Record<string, unknown>) => void
): void {
  if (Array.isArray(node)) {
    for (const value of node) walkObjects(value, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  visit(obj);
  for (const value of Object.values(obj)) walkObjects(value, visit);
}
