import { performance } from "node:perf_hooks";
import { Lexer } from "../src/lexer/lexer";
import { Parser } from "../src/parser/parser";
import {
  B65_MAX_GENERATED_ROWS,
  B65_MAX_GROUPING_ITEMS,
  B65_MAX_GROUPING_SETS,
  resolveGroupingSpec,
} from "../src/core/grouping";
import { enforceGroupingPlanningCandidateLimits } from "../src/core/groupingValidation";
import { applyGroupingSets, type ProcessRow } from "../src/engine/process";
import type { SelectStatement } from "../src/types/ast";

interface Trial {
  elapsedMs: number;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  heapDeltaBytes: number;
  heapMaxBytes: number;
  status: "ok" | "guard";
  outputRows: number;
  errorReason?: string;
}

interface CaseResult {
  name: string;
  inputRows: number;
  sets: number;
  items: number;
  cardinality: "low" | "unique" | "guard";
  aggregateShape: string;
  medianMs: number;
  maxMs: number;
  maxHeapDeltaBytes: number;
  maxHeapUsedBytes: number;
  status: "ok" | "guard";
  outputRows: number;
  errorReason?: string;
}

function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

function groupingSetsSql(setCount: number, items: number): string {
  const itemList = Array.from({ length: items }, (_, index) => `g${index}`).join(",");
  return Array.from({ length: setCount }, () => `(${itemList})`).join(",");
}

function makeRows(count: number, items: number, unique: boolean): ProcessRow[] {
  return Array.from({ length: count }, (_, rowIndex) => {
    const row: ProcessRow = {
      status: rowIndex % 3 === 0 ? "won" : "open",
      amount: String((rowIndex % 97) + 1),
      distinct_value: String(rowIndex % 101),
      // Model a non-trivial record width without putting record contents in diagnostics.
      payload: "x".repeat(256),
    };
    for (let itemIndex = 0; itemIndex < items; itemIndex++) {
      row[`g${itemIndex}`] = unique
        ? `u${rowIndex}-${itemIndex}`
        : `b${(rowIndex + itemIndex) % 4}`;
    }
    return row;
  });
}

function aggregateSql(shape: string): string {
  switch (shape) {
    case "B64_CASE":
      return "SUM(CASE WHEN status='won' THEN amount ELSE 0 END) AS case_sum";
    case "COUNT_DISTINCT":
      return "COUNT(DISTINCT distinct_value) AS distinct_count";
    case "B56_STATISTICS":
      return "STDDEV_POP(amount) AS sd, VAR_POP(amount) AS variance, " +
        "MEDIAN(amount) AS median, MODE(amount) AS mode";
    case "COMBINED":
      return "SUM(CASE WHEN status='won' THEN amount ELSE 0 END) AS case_sum, " +
        "COUNT(DISTINCT distinct_value) AS distinct_count, STDDEV_POP(amount) AS sd, " +
        "VAR_POP(amount) AS variance, MEDIAN(amount) AS median, MODE(amount) AS mode";
    default:
      return "COUNT(*) AS count";
  }
}

function runTrial(config: {
  inputRows: number;
  sets: number;
  items: number;
  unique: boolean;
  aggregateShape: string;
}): Trial {
  const rows = makeRows(config.inputRows, config.items, config.unique);
  const sql = `SELECT ${aggregateSql(config.aggregateShape)} FROM APP1 GROUP BY GROUPING SETS (` +
    `${groupingSetsSql(config.sets, config.items)})`;
  const stmt = parseSelect(sql);
  const spec = resolveGroupingSpec(stmt, (field) => ({
    canonicalId: `APP1:${field.field}`,
    directKey: field.field,
    unqualifiedBridgeKey: field.field,
    physical: true,
  }));
  if (!spec) throw new Error("benchmark setup did not produce a grouping-set spec");

  globalThis.gc?.();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const started = performance.now();
  let outputRows = 0;
  let status: Trial["status"] = "ok";
  let errorReason: string | undefined;
  try {
    const output = applyGroupingSets(rows, spec, stmt.columns, () => "number", {
      maxGeneratedRows: B65_MAX_GENERATED_ROWS,
    });
    outputRows = output.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("GROUPING_OUTPUT_LIMIT_EXCEEDED")) throw error;
    status = "guard";
    errorReason = "GROUPING_OUTPUT_LIMIT_EXCEEDED";
  }
  const elapsedMs = performance.now() - started;
  const heapAfterBytes = process.memoryUsage().heapUsed;
  return {
    elapsedMs,
    heapBeforeBytes,
    heapAfterBytes,
    heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
    heapMaxBytes: Math.max(heapBeforeBytes, heapAfterBytes),
    status,
    outputRows,
    ...(errorReason ? { errorReason } : {}),
  };
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function measure(config: {
  name: string;
  inputRows: number;
  sets: number;
  items: number;
  cardinality: "low" | "unique" | "guard";
  aggregateShape?: string;
}, trials = 5): CaseResult {
  const samples = Array.from({ length: trials }, () => runTrial({
    inputRows: config.inputRows,
    sets: config.sets,
    items: config.items,
    unique: config.cardinality !== "low",
    aggregateShape: config.aggregateShape ?? "COUNT",
  }));
  const first = samples[0];
  if (samples.some((sample) => sample.status !== first.status)) {
    throw new Error(`non-deterministic benchmark status: ${config.name}`);
  }
  return {
    name: config.name,
    inputRows: config.inputRows,
    sets: config.sets,
    items: config.items,
    cardinality: config.cardinality,
    aggregateShape: config.aggregateShape ?? "COUNT",
    medianMs: median(samples.map((sample) => sample.elapsedMs)),
    maxMs: Math.max(...samples.map((sample) => sample.elapsedMs)),
    maxHeapDeltaBytes: Math.max(...samples.map((sample) => sample.heapDeltaBytes)),
    maxHeapUsedBytes: Math.max(...samples.map((sample) => sample.heapMaxBytes)),
    status: first.status,
    outputRows: first.outputRows,
    ...(first.errorReason ? { errorReason: first.errorReason } : {}),
  };
}

function planningGuardEvidence(): Record<string, string> {
  const evidence: Record<string, string> = {};
  for (const [name, facts] of [
    ["65_sets", { expandedSetCount: B65_MAX_GROUPING_SETS + 1, canonicalItemCount: 1 }],
    ["17_items", { expandedSetCount: 1, canonicalItemCount: B65_MAX_GROUPING_ITEMS + 1 }],
  ] as const) {
    try {
      enforceGroupingPlanningCandidateLimits(facts);
      throw new Error(`${name} unexpectedly passed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = message.match(/reason=([A-Z_]+)/)?.[1];
      if (!reason) throw error;
      evidence[name] = reason;
    }
  }
  return evidence;
}

export function runBenchmark(): object {
  const cases: CaseResult[] = [];
  for (const sets of [1, 8, 32, 64]) {
    cases.push(measure({
      name: `sets_${sets}_low`,
      inputRows: 10_000,
      sets,
      items: 1,
      cardinality: "low",
    }));
    cases.push(measure({
      name: `sets_${sets}_unique`,
      inputRows: 10_000,
      sets,
      items: 1,
      cardinality: "unique",
    }));
  }
  for (const items of [1, 2, 4, 8, 16]) {
    cases.push(measure({
      name: `items_${items}_low`,
      inputRows: 10_000,
      sets: 1,
      items,
      cardinality: "low",
    }));
    cases.push(measure({
      name: `items_${items}_unique`,
      inputRows: 10_000,
      sets: 1,
      items,
      cardinality: "unique",
    }));
  }
  for (const aggregateShape of ["B64_CASE", "COUNT_DISTINCT", "B56_STATISTICS", "COMBINED"]) {
    cases.push(measure({
      name: `aggregate_${aggregateShape.toLowerCase()}`,
      inputRows: 10_000,
      sets: 8,
      items: 4,
      cardinality: "low",
      aggregateShape,
    }));
  }
  cases.push(measure({
    name: "generated_50000",
    inputRows: B65_MAX_GENERATED_ROWS,
    sets: 1,
    items: 1,
    cardinality: "unique",
  }, 1));
  cases.push(measure({
    name: "generated_50001",
    inputRows: B65_MAX_GENERATED_ROWS + 1,
    sets: 1,
    items: 1,
    cardinality: "guard",
  }, 1));

  return {
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      gcExposed: typeof globalThis.gc === "function",
    },
    guards: {
      groupingSets: B65_MAX_GROUPING_SETS,
      groupingItems: B65_MAX_GROUPING_ITEMS,
      generatedRows: B65_MAX_GENERATED_ROWS,
    },
    methodology: {
      trials: 5,
      heap: "heapUsed immediately before/after synchronous group stage; max is the larger sample endpoint",
      time: "performance.now wall time around applyGroupingSets",
    },
    planningGuardEvidence: planningGuardEvidence(),
    cases,
  };
}
