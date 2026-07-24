import { performance } from "node:perf_hooks";

const ROW_CAP = 10_000;
const TRIALS = 7;

function makeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    relativeMatch: index % 4 !== 0,
    subject: index % 5 === 0 ? "x" : `subject-${index}`,
  }));
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function measure(name, rows, selectCandidates) {
  const samples = Array.from({ length: TRIALS }, () => {
    const planningStarted = performance.now();
    const plan = selectCandidates === fullScanCandidates
      ? { mode: "FULL_SCAN", serverPredicate: null, residual: residualMatches }
      : {
        mode: "SUPERSET_PREFILTER",
        serverPredicate: relativeMatches,
        residual: residualMatches,
      };
    const planningMs = performance.now() - planningStarted;

    const candidates = selectCandidates(rows);
    const filteringStarted = performance.now();
    const output = candidates.filter(plan.residual);
    const residualFilterMs = performance.now() - filteringStarted;
    return {
      planningMs,
      residualFilterMs,
      candidateCount: candidates.length,
      outputCount: output.length,
      mode: plan.mode,
    };
  });
  const first = samples[0];
  if (samples.some((sample) =>
    sample.candidateCount !== first.candidateCount
    || sample.outputCount !== first.outputCount
    || sample.mode !== first.mode
  )) {
    throw new Error(`non-deterministic benchmark structure: ${name}`);
  }
  return {
    name,
    mode: first.mode,
    inputCount: rows.length,
    candidateCount: first.candidateCount,
    outputCount: first.outputCount,
    medianPlanningMs: median(samples.map((sample) => sample.planningMs)),
    medianResidualFilterMs: median(samples.map((sample) => sample.residualFilterMs)),
    maxResidualFilterMs: Math.max(...samples.map((sample) => sample.residualFilterMs)),
  };
}

function relativeMatches(row) {
  return row.relativeMatch;
}

function residualMatches(row) {
  return row.subject.length > 1;
}

function prefilterCandidates(rows) {
  return rows.filter(relativeMatches);
}

function fullScanCandidates(rows) {
  return rows;
}

const rows = makeRows(ROW_CAP);
const cases = [
  measure("phase2_superset_prefilter", rows, prefilterCandidates),
  measure("relative_free_full_scan_baseline", rows, fullScanCandidates),
];

if (cases[0].candidateCount >= cases[1].candidateCount) {
  throw new Error("benchmark fixture did not reduce the server-prefilter candidate count");
}
if (cases.some((entry) => entry.outputCount > entry.candidateCount)) {
  throw new Error("residual output count exceeded candidate count");
}

// 回帰観測用ベンチマークであり、時間の合否閾値は設けない。
process.stdout.write(`${JSON.stringify({
  benchmark: "B67 Phase2 superset prefilter",
  rowCap: ROW_CAP,
  trials: TRIALS,
  observationOnly: true,
  counts: {
    serverPrefilterCandidates: cases[0].candidateCount,
    clientResidualOutput: cases[0].outputCount,
    relativeFreeFullScanCandidates: cases[1].candidateCount,
  },
  cases,
}, null, 2)}\n`);
