import { buildImportRecordPayload } from "../subtablePayload";

test("builds one recursive parent payload with multiple tables", () => {
  expect(buildImportRecordPayload(
    new Map([["code", "A"]]),
    new Map([
      ["Lines", [{ rowId: "10", values: new Map([["name", "x"], ["qty", "1"]]) }]],
      ["Notes", [{ values: new Map([["body", "n"]]) }]],
    ]), "PRESERVE"
  )).toEqual({
    code: { value: "A" },
    Lines: { value: [{ id: "10", value: { name: { value: "x" }, qty: { value: "1" } } }] },
    Notes: { value: [{ value: { body: { value: "n" } } }] },
  });
});

test("JSON replacement drops every supplied row ID and represents [] deletion", () => {
  expect(buildImportRecordPayload(
    new Map(), new Map([
      ["Lines", [{ rowId: "unsafe", values: new Map([["name", "x"]]) }]],
      ["Empty", []],
    ]), "DROP"
  )).toEqual({
    Lines: { value: [{ value: { name: { value: "x" } } }] },
    Empty: { value: [] },
  });
});
