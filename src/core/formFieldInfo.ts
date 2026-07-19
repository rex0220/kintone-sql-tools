import type { KintoneFieldInfo } from "../execute";
import { resolveFieldSemantics } from "./fieldSemantics";

/** GET form fields API のうち、ksql が使用する共通部分。 */
export interface FormFieldProperty {
  code: string;
  label: string;
  type: string;
  format?: string;
  options?: Record<string, { index?: string | number }>;
  fields?: Record<string, FormFieldProperty>;
  required?: boolean;
  minValue?: string;
  maxValue?: string;
  minLength?: string;
  maxLength?: string;
  defaultValue?: unknown;
  lookup?: { fieldMappings?: Array<{ field?: string }> };
}

export interface ScopedSubtableFieldIndex {
  readonly table: KintoneFieldInfo;
  readonly children: ReadonlyMap<string, KintoneFieldInfo>;
}

/** Keeps child ownership, which flattenFormFieldProperties intentionally loses. */
export function buildScopedSubtableFieldIndex(
  properties: Record<string, FormFieldProperty>
): ReadonlyMap<string, ScopedSubtableFieldIndex> {
  const lookupCopyFields = collectLookupCopyFields(properties);
  const result = new Map<string, ScopedSubtableFieldIndex>();
  for (const property of Object.values(properties)) {
    if (property.type !== "SUBTABLE") continue;
    const table = flattenFields({ [property.code]: { ...property, fields: undefined } }, lookupCopyFields)[0];
    const children = flattenFields(property.fields ?? {}, lookupCopyFields, true);
    result.set(property.code, { table, children: new Map(children.map((child) => [child.code, child])) });
  }
  return result;
}

/** TABLE.fields を含め、フォームフィールド定義を再帰的にフラット化する。 */
export function flattenFormFieldProperties(
  properties: Record<string, FormFieldProperty>
): KintoneFieldInfo[] {
  return flattenFields(properties, collectLookupCopyFields(properties));
}

function flattenFields(
  properties: Record<string, FormFieldProperty>,
  lookupCopyFields: Set<string>,
  inSubtable = false
): KintoneFieldInfo[] {
  const out: KintoneFieldInfo[] = [];
  for (const field of Object.values(properties)) {
    const optionOrder = toOptionOrderMap(field.options);
    const sortKind = detectSortKind(field.type, field.format);
    const info: KintoneFieldInfo = {
      code: field.code,
      label: field.label,
      fieldType: field.type,
      optionOrder,
      sortKind,
      required: field.required,
      minValue: normalizeConstraintValue(field.minValue),
      maxValue: normalizeConstraintValue(field.maxValue),
      minLength: normalizeConstraintValue(field.minLength),
      maxLength: normalizeConstraintValue(field.maxLength),
      defaultValue: field.defaultValue,
      inSubtable,
      writable: !lookupCopyFields.has(field.code) && !NON_WRITABLE_FIELD_TYPES.has(field.type),
    };
    info.semantics = resolveFieldSemantics(info);
    out.push(info);
    if (field.fields) out.push(...flattenFields(field.fields, lookupCopyFields, true));
  }
  return out;
}

const NON_WRITABLE_FIELD_TYPES = new Set([
  "CALC", "RECORD_NUMBER", "CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME",
  "STATUS", "STATUS_ASSIGNEE", "CATEGORY", "REFERENCE_TABLE", "SUBTABLE",
]);

function collectLookupCopyFields(properties: Record<string, FormFieldProperty>): Set<string> {
  const result = new Set<string>();
  const visit = (fields: Record<string, FormFieldProperty>): void => {
    for (const field of Object.values(fields)) {
      for (const mapping of field.lookup?.fieldMappings ?? []) {
        if (mapping.field) result.add(mapping.field);
      }
      if (field.fields) visit(field.fields);
    }
  };
  visit(properties);
  return result;
}

function normalizeConstraintValue(value?: string): string | undefined {
  return value == null || value === "" ? undefined : value;
}

function toOptionOrderMap(
  options?: Record<string, { index?: string | number }>
): Record<string, number> | undefined {
  if (!options || typeof options !== "object") return undefined;
  const order: Record<string, number> = {};
  let hasAny = false;
  for (const [label, meta] of Object.entries(options)) {
    const n = Number(meta?.index);
    if (!Number.isFinite(n)) continue;
    order[label] = n;
    hasAny = true;
  }
  return hasAny ? order : undefined;
}

function detectSortKind(
  fieldType: string,
  calcFormat?: string
): "number" | "string" | undefined {
  if (fieldType === "NUMBER" || fieldType === "RECORD_NUMBER") return "number";
  if (fieldType === "CALC") {
    if (calcFormat === "NUMBER" || calcFormat === "NUMBER_DIGIT") return "number";
    return "string";
  }
  return undefined;
}
