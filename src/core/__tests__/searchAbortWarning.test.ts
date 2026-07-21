import {
  SEARCH_ABORTED_HEADER_VALUE,
  isSearchAbortedWarning,
} from "../searchAbortWarning";

test.each([
  ["exact match", SEARCH_ABORTED_HEADER_VALUE, true],
  [
    "known message among multiple warnings",
    `another warning; ${SEARCH_ABORTED_HEADER_VALUE}; final warning`,
    true,
  ],
  ["null", null, false],
  ["undefined", undefined, false],
  ["empty string", "", false],
  ["unrelated warning", "another warning", false],
  ["case-changed known message", "filter aborted because of too many search results", false],
] as const)("%s", (_label, value, expected) => {
  expect(isSearchAbortedWarning(value)).toBe(expected);
});
