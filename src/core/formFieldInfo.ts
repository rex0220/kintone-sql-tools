import type { KintoneFieldInfo } from "../execute";

/** GET form fields API のうち、ksql が使用する共通部分。 */
export interface FormFieldProperty {
  code: string;
  label: string;
  type: string;
  format?: string;
  options?: Record<string, { index?: string | number }>;
  fields?: Record<string, FormFieldProperty>;
}

/** TABLE.fields を含め、フォームフィールド定義を再帰的にフラット化する。 */
export function flattenFormFieldProperties(
  properties: Record<string, FormFieldProperty>
): KintoneFieldInfo[] {
  const out: KintoneFieldInfo[] = [];
  for (const field of Object.values(properties)) {
    out.push({
      code: field.code,
      label: field.label,
      fieldType: field.type,
      optionOrder: toOptionOrderMap(field.options),
      sortKind: detectSortKind(field.type, field.format),
    });
    if (field.fields) out.push(...flattenFormFieldProperties(field.fields));
  }
  return out;
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
