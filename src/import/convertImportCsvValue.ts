const LF_MULTI_TYPES = new Set([
  "CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT",
]);
const USER_TYPES = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"]);

export class ImportCsvValueError extends Error {
  readonly code = "ERR_IMPORT_MULTI_EMPTY_ITEM";
  constructor() {
    super("multiple-value CSV cell contains an empty LF-delimited item");
    this.name = "ImportCsvValueError";
  }
}

/** cli-kintone CSV cells only. Existing JSON/comma conversion is intentionally separate. */
export function convertImportCsvValue(
  raw: string,
  type: string | undefined,
  options: { cliKintone: true }
): string | string[] | Array<{ code: string }> {
  void options;
  if (!LF_MULTI_TYPES.has(type ?? "")) return raw;
  if (raw === "") return [];
  const items = raw.split(/\r\n|\n/);
  if (items.some((item) => item === "")) throw new ImportCsvValueError();
  return USER_TYPES.has(type ?? "") ? items.map((code) => ({ code })) : items;
}
