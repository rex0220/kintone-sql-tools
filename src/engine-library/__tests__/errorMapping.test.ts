import { FetchAllLimitError } from "../../api/fetchAll";
import { SearchAbortedError } from "../../execute";
import { LexError } from "../../lexer/lexer";
import {
  KsqlEngineError,
  normalizeEngineError,
  readOnlyViolation,
} from "../errors";

test.each([
  [
    "PARSE_ERROR",
    new LexError("bad token", 0, "!"),
  ],
  [
    "SEARCH_ABORTED",
    new SearchAbortedError(),
  ],
  [
    "FETCH_LIMIT_EXCEEDED",
    new FetchAllLimitError("too many rows"),
  ],
  [
    "CLIENT_ERROR",
    Object.assign(new Error("request failed"), { status: 503, code: "GAIA_TM01" }),
  ],
  [
    "EXECUTION_ERROR",
    new Error("planner failed"),
  ],
] as const)("%s preserves the internal cause", (code, cause) => {
  const mapped = normalizeEngineError(cause);
  expect(mapped).toBeInstanceOf(KsqlEngineError);
  expect(mapped.name).toBe("KsqlEngineError");
  expect(mapped.code).toBe(code);
  expect(mapped.cause).toBe(cause);
  expect(mapped.message.length).toBeGreaterThan(0);
});

test("READ_ONLY_VIOLATION remains stable and is not wrapped twice", () => {
  const error = readOnlyViolation("write statement is not allowed");
  expect(normalizeEngineError(error)).toBe(error);
  expect(error).toMatchObject({
    name: "KsqlEngineError",
    code: "READ_ONLY_VIOLATION",
  });
});

test("client classification accepts response status without depending on one SDK class", () => {
  const cause = { message: "proxy failed", response: { status: 502 } };
  const mapped = normalizeEngineError(cause);
  expect(mapped.code).toBe("CLIENT_ERROR");
  expect(mapped.cause).toBe(cause);
});

test("KsqlEngineError preserves an explicit cause", () => {
  const cause = new Error("blocked");
  const error = new KsqlEngineError(
    "READ_ONLY_VIOLATION",
    "read-only boundary rejected the statement",
    cause
  );
  expect(error.cause).toBe(cause);
});
