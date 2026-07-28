import type { KintoneFieldInfo, KintoneProcessStatuses } from "../execute";

export type EmptyWildcardFieldPolicy = "RECORD" | "NON_RECORD" | "PROCESS";

/**
 * GET form fields API が返す全フィールド型を、レコード直下への出現規則で分類する。
 * 新しい型を暗黙に含めない。API の型追加時は実測してこの表を更新する。
 */
export const EMPTY_WILDCARD_FIELD_TYPE_POLICY = {
  CALC: "RECORD",
  CATEGORY: "NON_RECORD",
  CHECK_BOX: "RECORD",
  CREATED_TIME: "RECORD",
  CREATOR: "RECORD",
  DATE: "RECORD",
  DATETIME: "RECORD",
  DROP_DOWN: "RECORD",
  FILE: "RECORD",
  GROUP: "NON_RECORD",
  GROUP_SELECT: "RECORD",
  LINK: "RECORD",
  MODIFIER: "RECORD",
  MULTI_LINE_TEXT: "RECORD",
  MULTI_SELECT: "RECORD",
  NUMBER: "RECORD",
  ORGANIZATION_SELECT: "RECORD",
  RADIO_BUTTON: "RECORD",
  RECORD_NUMBER: "RECORD",
  REFERENCE_TABLE: "NON_RECORD",
  RICH_TEXT: "RECORD",
  SINGLE_LINE_TEXT: "RECORD",
  STATUS: "PROCESS",
  STATUS_ASSIGNEE: "PROCESS",
  SUBTABLE: "RECORD",
  TIME: "RECORD",
  UPDATED_TIME: "RECORD",
  USER_SELECT: "RECORD",
} as const satisfies Record<string, EmptyWildcardFieldPolicy>;

/**
 * 未知の型は client 契約の違反として報告する（B93）。
 * InternalError は「到達しないはずの不変条件が破れた＝エンジンのバグ」に使う接頭辞であり、
 * client が返した値が原因のときに使うと、利用者が回帰と誤認して報告することになる
 * （Pro が擬似フィールド `$id: __ID__` を注入して実際にそうなった）。
 * どのフィールドが原因かと、期待する契約を文面に含める。
 */
function fieldPolicy(fieldType: string, fieldCode: string): EmptyWildcardFieldPolicy {
  const policy = (EMPTY_WILDCARD_FIELD_TYPE_POLICY as Record<string, EmptyWildcardFieldPolicy | undefined>)[fieldType];
  if (policy === undefined) {
    throw new Error(
      `ArgumentError: getFields returned unknown fieldType "${fieldType}" for field "${fieldCode}". `
      + "getFields must return only the fields from /k/v1/app/form/fields.json; "
      + "$id and $revision are synthesized by the engine and must not be added."
    );
  }
  return policy;
}

export async function deriveEmptyWildcardColumns(
  fields: readonly KintoneFieldInfo[],
  subtableCode: string | null | undefined,
  loadProcessStatuses: () => Promise<KintoneProcessStatuses>
): Promise<string[]> {
  if (subtableCode != null) {
    return [
      "_pid",
      "_rid",
      "_idx",
      ...fields
        .filter((field) => field.inSubtable === true && field.subtableCode === subtableCode)
        .map((field) => field.code),
    ];
  }

  const topLevel = fields.filter((field) => !field.inSubtable);
  const needsProcessSettings = topLevel.some((field) => fieldPolicy(field.fieldType, field.code) === "PROCESS");
  const processEnabled = needsProcessSettings
    ? (await loadProcessStatuses()).enable
    : false;
  const columns = topLevel
    .filter((field) => {
      const policy = fieldPolicy(field.fieldType, field.code);
      return policy === "RECORD" || (policy === "PROCESS" && processEnabled);
    })
    .map((field) => field.code);
  return [...columns, "$revision", "$id"];
}
