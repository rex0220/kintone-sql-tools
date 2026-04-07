import { formatDisplayText } from "../displayFormat";

describe("display format", () => {
  test("user object as name", () => {
    const raw = JSON.stringify({ code: "u001", name: "田中" });
    expect(formatDisplayText(raw, { userFormat: "name" })).toBe("田中");
  });

  test("array join", () => {
    const raw = JSON.stringify(["A", "B", "C"]);
    expect(formatDisplayText(raw, { arrayFormat: "join" })).toBe("A, B, C");
  });

  test("subtable count", () => {
    const raw = JSON.stringify([{ id: "1", value: { a: { value: "x" } } }, { id: "2", value: { a: { value: "y" } } }]);
    expect(formatDisplayText(raw, { tableFormat: "count" })).toBe("2 行");
  });
});
