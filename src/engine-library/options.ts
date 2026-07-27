import type {
  RunBatchOptions,
  RunQueryOptions,
} from "./publicTypes";

type QueryKind = "run" | "explain";

const COMMON_KEYS = new Set([
  "client",
  "maxRecords",
  "fetchParallel",
  "cursorMaxActive",
]);

const RUN_KEYS = new Set([...COMMON_KEYS, "onLimitReached"]);
const BATCH_KEYS = RUN_KEYS;

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

function validateExecutionOptions(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  apiName: string
): {
  maxRecords?: number;
  onLimitReached?: "error" | "truncate";
  fetchParallel?: number;
  cursorMaxActive?: number;
} {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`Unknown ${apiName} option: ${String(key)}`);
    }
  }

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
  if (
    value.onLimitReached !== undefined &&
    value.onLimitReached !== "error" &&
    value.onLimitReached !== "truncate"
  ) {
    throw new TypeError('onLimitReached must be "error" or "truncate"');
  }

  return {
    ...(value.maxRecords !== undefined ? { maxRecords: value.maxRecords as number } : {}),
    ...(value.fetchParallel !== undefined ? { fetchParallel: value.fetchParallel as number } : {}),
    ...(value.cursorMaxActive !== undefined ? { cursorMaxActive: value.cursorMaxActive as number } : {}),
    ...(value.onLimitReached !== undefined
      ? { onLimitReached: value.onLimitReached as "error" | "truncate" }
      : {}),
  };
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
  assertClient(value.client);
  const executeOptions = validateExecutionOptions(
    value as unknown as Record<string, unknown>,
    allowed,
    kind === "run" ? "runQuery" : "explainQuery"
  );

  return {
    client: value.client,
    executeOptions,
  };
}

export function validateBatchOptions(
  value: RunBatchOptions
): {
  client: RunBatchOptions["client"];
  executeOptions: {
    maxRecords?: number;
    onLimitReached?: "error" | "truncate";
    fetchParallel?: number;
    cursorMaxActive?: number;
  };
} {
  assertOptionsObject(value);
  assertClient(value.client);
  return {
    client: value.client,
    executeOptions: validateExecutionOptions(value, BATCH_KEYS, "runBatch"),
  };
}
