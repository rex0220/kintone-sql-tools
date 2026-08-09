export const RECURSIVE_CTE_MAX_DEPTH = 100;
export const RECURSIVE_CTE_MAX_ROWS = 10_000;
export const RECURSIVE_CTE_MAX_EXPANSIONS = 100_000;

export interface RecursiveCteLimits {
  readonly depth: number;
  readonly rows: number;
  readonly expansions: number;
}

export function resolveRecursiveCteLimits(options: {
  readonly recursiveCteMaxDepth?: number;
  readonly recursiveCteMaxRows?: number;
  readonly recursiveCteMaxExpansions?: number;
}): RecursiveCteLimits {
  const entries = [
    ["recursiveCteMaxDepth", options.recursiveCteMaxDepth, RECURSIVE_CTE_MAX_DEPTH],
    ["recursiveCteMaxRows", options.recursiveCteMaxRows, RECURSIVE_CTE_MAX_ROWS],
    ["recursiveCteMaxExpansions", options.recursiveCteMaxExpansions, RECURSIVE_CTE_MAX_EXPANSIONS],
  ] as const;
  for (const [name, value] of entries) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return {
    depth: options.recursiveCteMaxDepth ?? RECURSIVE_CTE_MAX_DEPTH,
    rows: options.recursiveCteMaxRows ?? RECURSIVE_CTE_MAX_ROWS,
    expansions: options.recursiveCteMaxExpansions ?? RECURSIVE_CTE_MAX_EXPANSIONS,
  };
}

export type RecursiveCteLimitKind = "DEPTH" | "ROWS" | "EXPANSIONS";

export class RecursiveCteLimitError extends Error {
  readonly kind: RecursiveCteLimitKind;
  readonly limit: number;
  readonly detected: number;
  readonly cteName: string;

  constructor(kind: RecursiveCteLimitKind, limit: number, detected: number, cteName: string) {
    const label = kind === "DEPTH" ? "深さ" : kind === "ROWS" ? "結果行数" : "中間展開数";
    const unit = kind === "DEPTH" ? "" : " 件";
    super(`再帰 CTE「${cteName}」の${label}が上限 ${limit}${unit}を超えました（検出値: ${detected}${unit}）。`);
    this.name = "RecursiveCteLimitError";
    this.kind = kind;
    this.limit = limit;
    this.detected = detected;
    this.cteName = cteName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RecursiveCteLimitCounter {
  private rows = 0;
  private expansions = 0;

  constructor(
    readonly cteName: string,
    readonly limits: RecursiveCteLimits = resolveRecursiveCteLimits({})
  ) {}

  observeDepth(detected: number): void {
    if (detected > this.limits.depth) {
      throw new RecursiveCteLimitError("DEPTH", this.limits.depth, detected, this.cteName);
    }
  }

  addRow(): void {
    this.rows++;
    if (this.rows > this.limits.rows) {
      throw new RecursiveCteLimitError("ROWS", this.limits.rows, this.rows, this.cteName);
    }
  }

  addExpansion(): void {
    this.expansions++;
    if (this.expansions > this.limits.expansions) {
      throw new RecursiveCteLimitError(
        "EXPANSIONS", this.limits.expansions, this.expansions, this.cteName
      );
    }
  }
}
