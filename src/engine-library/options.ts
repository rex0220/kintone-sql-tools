import type {
  RunBatchOptions,
  RunQueryOptions,
} from "./publicTypes";
import { canonicalizeLogicalAppName } from "../core/logicalApps";

type QueryKind = "run" | "explain";

const COMMON_KEYS = new Set([
  "client",
  "logicalApps",
  "maxRecords",
  "recursiveCteMaxDepth",
  "recursiveCteMaxRows",
  "recursiveCteMaxExpansions",
  "fetchParallel",
  "cursorMaxActive",
]);

const RUN_KEYS = new Set([...COMMON_KEYS, "onLimitReached"]);
const BATCH_KEYS = new Set([
  ...RUN_KEYS,
  "variables",
  "tempTableMaxRows",
]);

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

function assertBatchVariables(
  value: unknown
): asserts value is Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("variables must be an object");
  }
  for (const [key, variableValue] of Object.entries(value)) {
    if (typeof variableValue !== "string") {
      throw new TypeError(`variables.${key} must be a string`);
    }
  }
}

function normalizeLogicalApps(
  value: unknown
): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("logicalApps must be an object");
  }
  const normalized: Record<string, number> = {};
  for (const [rawName, rawAppId] of Object.entries(value)) {
    let logicalName: string;
    try {
      logicalName = canonicalizeLogicalAppName(rawName);
    } catch {
      throw new TypeError(`logicalApps key "${rawName}" is invalid`);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, logicalName)) {
      throw new TypeError(
        `logicalApps key "${rawName}" duplicates "${logicalName}" after canonical normalization`
      );
    }
    assertPositiveSafeInteger(rawAppId, `logicalApps.${rawName}`);
    normalized[logicalName] = rawAppId;
  }
  return normalized;
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
  recursiveCteMaxDepth?: number;
  recursiveCteMaxRows?: number;
  recursiveCteMaxExpansions?: number;
} {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`Unknown ${apiName} option: ${String(key)}`);
    }
  }

  if (value.maxRecords !== undefined) {
    assertPositiveSafeInteger(value.maxRecords, "maxRecords");
  }
  for (const name of ["recursiveCteMaxDepth", "recursiveCteMaxRows", "recursiveCteMaxExpansions"] as const) {
    if (value[name] !== undefined) assertPositiveSafeInteger(value[name], name);
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
    ...(value.recursiveCteMaxDepth !== undefined ? { recursiveCteMaxDepth: value.recursiveCteMaxDepth as number } : {}),
    ...(value.recursiveCteMaxRows !== undefined ? { recursiveCteMaxRows: value.recursiveCteMaxRows as number } : {}),
    ...(value.recursiveCteMaxExpansions !== undefined ? { recursiveCteMaxExpansions: value.recursiveCteMaxExpansions as number } : {}),
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
  logicalApps?: Readonly<Record<string, number>>;
  executeOptions: {
    maxRecords?: number;
    onLimitReached?: "error" | "truncate";
    fetchParallel?: number;
    cursorMaxActive?: number;
    recursiveCteMaxDepth?: number;
    recursiveCteMaxRows?: number;
    recursiveCteMaxExpansions?: number;
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
  const logicalApps = normalizeLogicalApps(value.logicalApps);

  return {
    client: value.client,
    ...(logicalApps === undefined ? {} : { logicalApps }),
    executeOptions,
  };
}

export function validateBatchOptions(
  value: RunBatchOptions
): {
  client: RunBatchOptions["client"];
  logicalApps?: Readonly<Record<string, number>>;
  executeOptions: {
    maxRecords?: number;
    onLimitReached?: "error" | "truncate";
    fetchParallel?: number;
    cursorMaxActive?: number;
    variables?: Readonly<Record<string, string>>;
    recursiveCteMaxDepth?: number;
    recursiveCteMaxRows?: number;
    recursiveCteMaxExpansions?: number;
    tempTableMaxRows?: number;
  };
} {
  assertOptionsObject(value);
  assertClient(value.client);
  if (value.variables !== undefined) {
    assertBatchVariables(value.variables);
  }
  if (value.tempTableMaxRows !== undefined) {
    assertPositiveSafeInteger(value.tempTableMaxRows, "tempTableMaxRows");
  }
  const commonOptions = validateExecutionOptions(value, BATCH_KEYS, "runBatch");
  const logicalApps = normalizeLogicalApps(value.logicalApps);
  return {
    client: value.client,
    ...(logicalApps === undefined ? {} : { logicalApps }),
    executeOptions: {
      ...commonOptions,
      ...(value.variables !== undefined ? { variables: value.variables } : {}),
      ...(value.tempTableMaxRows !== undefined
        ? { tempTableMaxRows: value.tempTableMaxRows }
        : {}),
    },
  };
}
