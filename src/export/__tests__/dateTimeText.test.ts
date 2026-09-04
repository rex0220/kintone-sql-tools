import { createDateTimeFormatter, formatDateTimeInTimezone } from "../dateTimeText";

const inZone = (value: string, timezone: string): string =>
  formatDateTimeInTimezone(value, createDateTimeFormatter(timezone));

describe("B179 DATETIME timezone formatting", () => {
  test("uses the fixed Asia/Tokyo offset and retains milliseconds", () => {
    expect(inZone("2026-09-04T01:02:03.007Z", "Asia/Tokyo"))
      .toBe("2026-09-04T10:02:03.007+09:00");
  });

  test.each([
    ["2026-03-08T06:59:59.123Z", "2026-03-08T01:59:59.123-05:00"],
    ["2026-03-08T07:00:00.456Z", "2026-03-08T03:00:00.456-04:00"],
    ["2026-11-01T05:59:59.789Z", "2026-11-01T01:59:59.789-04:00"],
    ["2026-11-01T06:00:00.001Z", "2026-11-01T01:00:00.001-05:00"],
  ])("uses the instant-specific offset at New York DST boundaries", (input, expected) => {
    expect(inZone(input, "America/New_York")).toBe(expected);
  });

  test("retains the input fractional-second spelling", () => {
    expect(inZone("2026-01-01T00:00:00.1Z", "UTC"))
      .toBe("2026-01-01T00:00:00.1+00:00");
    expect(inZone("2026-01-01T00:00:00.123456Z", "UTC"))
      .toBe("2026-01-01T00:00:00.123456+00:00");
  });

  test("rejects an invalid timezone with a stable error code and prefixed message", () => {
    expect(() => createDateTimeFormatter("Invalid/Nowhere")).toThrow(expect.objectContaining({
      name: "ExportSinkInvalidTimezoneError",
      code: "ExportSinkInvalidTimezoneError",
      message: expect.stringMatching(/^ExportSinkInvalidTimezoneError: /),
    }));
  });

  test.each([
    "2026-02-30T00:00:00Z",
    "2026-01-01 00:00:00Z",
    "2026-01-01T00:00:00+00:00",
    "not-a-date",
  ])("rejects invalid UTC DATETIME %s", (input) => {
    expect(() => inZone(input, "UTC")).toThrow(expect.objectContaining({
      name: "ExportSinkInvalidValueError",
    }));
  });
});
