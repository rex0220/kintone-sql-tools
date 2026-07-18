import type { CheckGroup, FieldRef, ScalarValueExpr, WhereExpr } from "../types/ast";
import type { ProcessRow } from "../engine/process";
import { evalWhere } from "../engine/evalWhere";
import { evalScalarValueExpr } from "../engine/evalFunc";
import { ParseError } from "../parser/parser";
import { TokenKind } from "../lexer/tokens";

export interface CheckFieldRef {
  tableAlias: string | null;
  field: string;
}

/** CHECK の条件・メッセージを完全走査し、出現順を保った参照一覧を返す。 */
export function collectCheckFieldRefs(groups: readonly CheckGroup[]): CheckFieldRef[] {
  return collectRefs(groups);
}

export function collectCheckComparisonFieldRefs(groups: readonly CheckGroup[]): CheckFieldRef[] {
  return collectRefs(groups.flatMap((group) => group.rules.map((rule) => rule.condition)));
}

function collectRefs(root: unknown): CheckFieldRef[] {
  const refs: CheckFieldRef[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "EXISTS" || obj.type === "SUBQUERY_IN_LIST" || obj.type === "SCALAR_SUBQUERY") {
      throw customCheckParseError("CHECK にサブクエリは使用できません");
    }
    if (obj.type === "FIELD" && typeof obj.field === "string") {
      add(typeof obj.tableAlias === "string" ? obj.tableAlias : null, obj.field);
    } else if (obj.type === "FIELD_REF" && typeof obj.field === "string") {
      const dot = obj.field.indexOf(".");
      add(dot > 0 ? obj.field.slice(0, dot) : null, dot > 0 ? obj.field.slice(dot + 1) : obj.field);
    }
    for (const value of Object.values(obj)) visit(value);
  };
  const add = (tableAlias: string | null, field: string): void => {
    if (/^(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT)\(/i.test(field)) {
      throw customCheckParseError("CHECK に集約関数は使用できません");
    }
    const key = `${tableAlias ?? ""}\u0000${field}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ tableAlias, field }); }
  };
  visit(root);
  return refs;
}

export function customCheckParseError(message: string): ParseError {
  return new ParseError(message, { kind: TokenKind.EOF, value: "CHECK", pos: 0 });
}

export interface CustomCheckEvaluation {
  groupIndex: number;
  message: string;
}

/** グループ内先勝ち、グループ間独立で評価する。例外は呼び出し側へ伝播する。 */
export function evaluateCustomChecks(
  groups: readonly CheckGroup[],
  row: ProcessRow,
  resolveFieldType: (field: FieldRef) => string | undefined
): CustomCheckEvaluation[] {
  const errors: CustomCheckEvaluation[] = [];
  groups.forEach((group, groupIndex) => {
    for (const rule of group.rules) {
      if (!evalWhere(rule.condition as WhereExpr, row, resolveFieldType)) continue;
      const value = evalScalarValueExpr(rule.message as ScalarValueExpr, row);
      errors.push({ groupIndex, message: value == null ? "" : String(value) });
      break;
    }
  });
  return errors;
}
