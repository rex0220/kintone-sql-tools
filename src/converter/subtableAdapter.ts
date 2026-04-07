import type { KintoneRecord } from "./dmlToKintone";

interface KintoneTableRow {
  id?: string;
  value?: Record<string, { value?: unknown }>;
}

/**
 * 親レコード配列からサブテーブル仮想レコード配列を構築する。
 * 各行に _pid / _rid / _idx と _p.<親項目> を付与する。
 */
export function expandSubtableRecords(
  parents: KintoneRecord[],
  subtableCode: string
): KintoneRecord[] {
  const rows: KintoneRecord[] = [];

  for (const parent of parents) {
    const parentId = toFlatString(parent["$id"]?.value);
    const tableValue = readTableRows(parent[subtableCode]?.value);
    if (tableValue.length === 0) continue;

    for (let i = 0; i < tableValue.length; i++) {
      const row = tableValue[i];
      const out: KintoneRecord = {
        _pid: { value: parentId },
        _rid: { value: row.id ?? "" },
        _idx: { value: String(i) },
      };

      // 親項目ショートカット
      for (const [field, fieldValue] of Object.entries(parent)) {
        if (field === subtableCode) continue;
        const flat = toFlatString(fieldValue?.value);
        out[`_p.${field}`] = { value: flat };
      }

      // サブテーブル行の各項目
      for (const [field, cell] of Object.entries(row.value ?? {})) {
        out[field] = { value: toFlatString(cell?.value) };
      }

      rows.push(out);
    }
  }

  return rows;
}

function readTableRows(value: unknown): KintoneTableRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is KintoneTableRow => !!item && typeof item === "object");
}

function toFlatString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
