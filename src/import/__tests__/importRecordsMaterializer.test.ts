import { materializeCliKintoneCsvImportRecords, materializeJsonImportRecords } from "../importRecordsMaterializer";

const bytes = (value: string) => new TextEncoder().encode(value);
const targets = [
  { kind: "FIELD" as const, field: "code" },
  { kind: "SUBTABLE" as const, subtableCode: "Lines", children: ["name", "qty"] },
  { kind: "SUBTABLE" as const, subtableCode: "Notes", children: ["body"] },
];

test("materializes nested JSON as parents plus scoped child positions", () => {
  const result = materializeJsonImportRecords(
    { kind: "JSON", sourceName: "src" },
    { bytes: bytes('[{"code":"A","Lines":[{"name":"x","qty":"1"},{"name":"y"}],"Notes":[{"body":"n"}]}]') },
    targets, 10, 10
  );
  expect(result.records[0].rowNumber).toBe(1);
  expect(result.records[0].top.get("code")).toBe("A");
  expect(result.records[0].subtables.get("Lines")?.map((row) => row.childRowNumber)).toEqual([1, 2]);
  expect(result.records[0].replacementTables).toEqual(new Set(["Lines", "Notes"]));
});

test("groups cli-kintone continuation rows and multiple tables on one physical row", () => {
  const csvTargets = [
    { kind: "FIELD" as const, field: "code" },
    { kind: "SUBTABLE" as const, subtableCode: "Lines", children: ["name"], rowIdSourceHeader: "line_id" },
    { kind: "SUBTABLE" as const, subtableCode: "Notes", children: ["body"], rowIdSourceHeader: "note_id" },
  ];
  const result = materializeCliKintoneCsvImportRecords(
    { kind: "CSV", sourceName: "src", hasHeader: true, mappingMode: "BY_NAME", ignoreUnknownColumns: false },
    { bytes: bytes("*,code,line_id,name,note_id,body\n*,A,10,x,20,n\n,,,y,,m\n*,B,,,,\n") },
    csvTargets, ["Lines", "Notes"], 10
  );
  expect(result.records).toHaveLength(2);
  expect(result.records[0].subtables.get("Lines")?.map((row) => row.sourceRowNumber)).toEqual([2, 3]);
  expect(result.records[0].subtables.get("Notes")?.map((row) => row.sourceRowNumber)).toEqual([2, 3]);
  expect(result.records[1].subtables.get("Lines")).toEqual([]);
});

test("cli-kintone grouping rejects leading continuation and parent cells on continuation", () => {
  const csvTargets = [{ kind: "FIELD" as const, field: "code" }, { kind: "SUBTABLE" as const, subtableCode: "T", children: ["v"], rowIdSourceHeader: "rid" }];
  const source = { kind: "CSV" as const, sourceName: "src", hasHeader: true, mappingMode: "BY_NAME" as const, ignoreUnknownColumns: false };
  expect(() => materializeCliKintoneCsvImportRecords(source, { bytes: bytes("*,code,rid,v\n,,1,x\n") }, csvTargets, ["T"], 10)).toThrow("first data row");
  expect(() => materializeCliKintoneCsvImportRecords(source, { bytes: bytes("*,code,rid,v\n*,A,1,x\n,B,2,y\n") }, csvTargets, ["T"], 10)).toThrow("PARENT_VALUE_ON_CONTINUATION");
});

test("distinguishes missing subtable from explicit empty replacement", () => {
  const result = materializeJsonImportRecords(
    { kind: "JSON", sourceName: "src" }, { bytes: bytes('[{"code":"keep"},{"code":"delete","Lines":[]}]') }, targets, 10
  );
  expect(result.records[0].replacementTables.has("Lines")).toBe(false);
  expect(result.records[1].replacementTables.has("Lines")).toBe(true);
  expect(result.records[1].subtables.get("Lines")).toEqual([]);
});

test.each([
  ['[{"code":"A","unknown":[]}]', "unknown key"],
  ['[{"code":"A","Lines":{}}]', "must be an array"],
  ['[{"code":"A","Lines":[1]}]', "childRow=1"],
  ['[{"code":"A","Lines":[{"_rid":"1"}]}]', "unknown child key"],
])("rejects invalid nested shape before mutation", (json, message) => {
  expect(() => materializeJsonImportRecords(
    { kind: "JSON", sourceName: "src" }, { bytes: bytes(json) }, targets, 10
  )).toThrow(message);
});
