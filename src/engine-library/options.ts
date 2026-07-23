import type { RunQueryOptions } from "./publicTypes";

type QueryKind = "run" | "explain";

const COMMON_KEYS = new Set([
  "client",
  "maxRecords",
  "fetchParallel",
  "cursorMaxActive",
]);

const RUN_KEYS = new Set([...COMMON_KEYS, "onLimitReached"]);

function assertOptionsObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("options must be an object");
  }
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertClient(value: unknown): asserts value is RunQueryOptions["client"] {
  if (value === null || typeof value !== "object") {
    throw new TypeError("client is required");
  }
  const candidate = value as Record<string, unknown>;
  for (const method of [
    "getRecords",
    "openCursor",
    "getApps",
    "getFields",
    "getNumberPrecision",
    "getProcessStatuses",
  ]) {
    if (typeof candidate[method] !== "function") {
      throw new TypeError(`client.${method} must be a function`);
    }
  }
}

export function validateQueryOptions(
  value: RunQueryOptions | Omit<RunQueryOptions, "onLimitReached">,
  kind: QueryKind
): {
  client: RunQueryOptions["client"];
  executeOptions: {
    maxRecords?: number;
    onLimitReached?: "error" | "truncate";
    fetchParallel?: number;
    cursorMaxActive?: number;
  };
} {
  assertOptionsObject(value);
  const allowed = kind === "run" ? RUN_KEYS : COMMON_KEYS;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(
        `Unknown ${kind === "run" ? "runQuery" : "explainQuery"} option: ${String(key)}`
      );
    }
  }

  assertClient(value.client);

  if (value.maxRecords !== undefined) {
    assertPositiveSafeInteger(value.maxRecords, "maxRecords");
  }
  if (value.fetchParallel !== undefined) {
    assertPositiveSafeInteger(value.fetchParallel, "fetchParallel");
  }
  if (value.cursorMaxActive !== undefined) {
    assertPositiveSafeInteger(value.cursorMaxActive, "cursorMaxActive");
    if (value.cursorMaxActive > 5) {
      throw new RangeError("cursorMaxActive must be between 1 and 5");
    }
  }

  const runValue = value as RunQueryOptions;
  if (
    kind === "run" &&
    runValue.onLimitReached !== undefined &&
    runValue.onLimitReached !== "error" &&
    runValue.onLimitReached !== "truncate"
  ) {
    throw new TypeError('onLimitReached must be "error" or "truncate"');
  }

  return {
    client: value.client,
    executeOptions: {
      ...(value.maxRecords !== undefined ? { maxRecords: value.maxRecords } : {}),
      ...(value.fetchParallel !== undefined ? { fetchParallel: value.fetchParallel } : {}),
      ...(value.cursorMaxActive !== undefined ? { cursorMaxActive: value.cursorMaxActive } : {}),
      ...(kind === "run" && runValue.onLimitReached !== undefined
        ? { onLimitReached: runValue.onLimitReached }
        : {}),
    },
  };
}
