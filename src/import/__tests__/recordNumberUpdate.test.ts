import { normalizeImportRecordNumber, preflightImportRecordNumbers } from "../recordNumberUpdate";

test("record-number lexical boundary is strict and normalization is exact", () => {
  expect(["1", "001", "0"].map(normalizeImportRecordNumber)).toEqual(["1", "1", "0"]);
  for (const value of ["", "+1", "1.0", "1e2", " 1", "1 ", "APP-1", "-1", "１２"])
    expect(normalizeImportRecordNumber(value)).toBeNull();
});

test("normalized source duplicates are a global preflight error", () => {
  expect(() => preflightImportRecordNumbers(["1", "001"], "recno")).toThrow("ERR_RECORD_NUMBER_DUP_SOURCE");
});
