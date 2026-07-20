import { renderValidationValue } from "./dmlValidationCandidates";
import { isEmptyDmlValue, normalizeRaw } from "./dmlValidation";
import type { KintoneFieldInfo } from "../execute";
import type { ValidateStatement } from "../types/ast";

export interface ExistingValidationTarget {
  field: KintoneFieldInfo;
  subtableCode?: string;
}

export interface ValidationCellLocator {
  subtable: string;
  subrow: number;
  subrowId: string;
}

export interface ValidationFieldMetadataIndex {
  readonly topLevel: readonly KintoneFieldInfo[];
  readonly topByCode: ReadonlyMap<string, KintoneFieldInfo>;
  readonly childrenByTable: ReadonlyMap<string, readonly KintoneFieldInfo[]>;
}

/** B42/B44 共通の form metadata ownership index。 */
export function buildValidationFieldMetadataIndex(
  fieldInfos: readonly KintoneFieldInfo[]
): ValidationFieldMetadataIndex {
  const topLevel = fieldInfos.filter((field) => !field.inSubtable);
  const childrenByTable = new Map<string, KintoneFieldInfo[]>();
  for (const field of fieldInfos) {
    if (!field.inSubtable || !field.subtableCode) continue;
    const children = childrenByTable.get(field.subtableCode) ?? [];
    children.push(field);
    childrenByTable.set(field.subtableCode, children);
  }
  return {
    topLevel,
    topByCode: new Map(topLevel.map((field) => [field.code, field])),
    childrenByTable,
  };
}

export function hasAuditableConstraint(field: KintoneFieldInfo): boolean {
  return field.required === true
    || field.minValue !== undefined
    || field.maxValue !== undefined
    || field.minLength !== undefined
    || field.maxLength !== undefined
    || field.optionOrder !== undefined;
}

export function isExistingValidationAuditable(field: KintoneFieldInfo): boolean {
  return field.fieldType === "NUMBER" || hasAuditableConstraint(field);
}

/** B42/B44 共通の 1-based subtable row locator。 */
export function buildValidationCellLocator(
  subtable: string,
  rowIndex: number,
  row: { id?: string | number }
): ValidationCellLocator {
  return { subtable, subrow: rowIndex + 1, subrowId: String(row.id ?? "") };
}

/** B42 の target metadata 解決。B44 は同じ field metadata を全 post-image 走査に使う。 */
export function resolveExistingValidationTargets(
  stmt: ValidateStatement,
  fieldInfos: readonly KintoneFieldInfo[]
): ExistingValidationTarget[] {
  const { topByCode, childrenByTable } = buildValidationFieldMetadataIndex(fieldInfos);
  const auditable = isExistingValidationAuditable;
  if (stmt.targets === undefined) return [
    ...fieldInfos.filter((field) => !field.inSubtable && field.fieldType !== "SUBTABLE" && auditable(field)),
    ...fieldInfos.filter((field) => field.inSubtable && !!field.subtableCode && auditable(field)),
  ].map((field) => ({ field, ...(field.subtableCode ? { subtableCode: field.subtableCode } : {}) }));

  const result: ExistingValidationTarget[] = [];
  const seen = new Set<string>();
  const add = (field: KintoneFieldInfo, subtableCode?: string): void => {
    const key = subtableCode ? `${subtableCode}\u0000${field.code}` : field.code;
    if (seen.has(key)) throw new Error(`ArgumentError: VALIDATE のフィールド ${field.code} が重複しています。`);
    seen.add(key);
    if (!auditable(field)) throw new Error(`ArgumentError: VALIDATE のフィールド ${field.code} には監査可能な制約がありません。`);
    result.push({ field, ...(subtableCode ? { subtableCode } : {}) });
  };
  for (const target of stmt.targets) {
    if (target.kind === "SUBTABLE") {
      const children = childrenByTable.get(target.subtableCode);
      if (!children) throw new Error(`ArgumentError: VALIDATE のサブテーブル ${target.subtableCode} は存在しません。`);
      if (target.children.length === 0) throw new Error(`ArgumentError: VALIDATE のサブテーブル ${target.subtableCode} には1つ以上の子フィールドが必要です。`);
      for (const code of target.children) {
        const child = children.find((field) => field.code === code);
        if (!child) {
          const belongsElsewhere = [...childrenByTable.entries()].some(([table, fields]) => table !== target.subtableCode && fields.some((field) => field.code === code));
          throw new Error(belongsElsewhere
            ? `ArgumentError: VALIDATE の子フィールド ${code} はサブテーブル ${target.subtableCode} に属していません。`
            : `ArgumentError: VALIDATE の子フィールド ${code} はサブテーブル ${target.subtableCode} に存在しません。`);
        }
        add(child, target.subtableCode);
      }
      continue;
    }
    const code = target.field;
    if (code === "$id") throw new Error("ArgumentError: VALIDATE ではシステムフィールド $id を監査できません。");
    const top = topByCode.get(code);
    if (top?.fieldType === "SUBTABLE") {
      const children = (childrenByTable.get(code) ?? []).filter(auditable);
      if (children.length === 0) throw new Error(`ArgumentError: VALIDATE のサブテーブル ${code} には監査可能な子フィールドがありません。`);
      children.forEach((child) => add(child, code));
      continue;
    }
    if (top) { add(top); continue; }
    if ([...childrenByTable.values()].some((children) => children.some((field) => field.code === code))) {
      throw new Error(`ArgumentError: VALIDATE の子フィールド ${code} は所有サブテーブルを含む T(${code}) 形式で指定してください。`);
    }
    throw new Error(`ArgumentError: VALIDATE のフィールド ${code} は存在しません。`);
  }
  return result;
}

/** B41 $err_value contract: empty raw selections stay empty; non-empty arrays are code-only JSON. */
export function renderExistingValidationValue(raw: unknown, fieldType: string): string {
  return isEmptyDmlValue(raw) ? "" : renderValidationValue(normalizeRaw(raw, fieldType));
}
