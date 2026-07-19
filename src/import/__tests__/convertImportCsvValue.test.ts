import { convertImportCsvValue } from "../convertImportCsvValue";

describe("cli-kintone BY NAME multiple-value cells", () => {
  test.each(["CHECK_BOX", "MULTI_SELECT"])("%s splits LF and CRLF", (type) => {
    expect(convertImportCsvValue("a\nb\r\nc", type, { cliKintone: true })).toEqual(["a", "b", "c"]);
    expect(convertImportCsvValue("", type, { cliKintone: true })).toEqual([]);
  });
  test.each(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"])("%s maps codes", (type) => {
    expect(convertImportCsvValue("u1\nu2", type, { cliKintone: true })).toEqual([{ code: "u1" }, { code: "u2" }]);
  });
  test.each(["a\n", "a\n\nb", "\na"])("rejects empty non-empty-cell item: %j", (raw) => {
    expect(() => convertImportCsvValue(raw, "CHECK_BOX", { cliKintone: true })).toThrow("empty LF-delimited item");
  });
  test("does not reinterpret scalar or comma cells", () => {
    expect(convertImportCsvValue("a,b", "CHECK_BOX", { cliKintone: true })).toEqual(["a,b"]);
    expect(convertImportCsvValue("123456789012345678901234567890", "NUMBER", { cliKintone: true }))
      .toBe("123456789012345678901234567890");
  });
});
