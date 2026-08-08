import { GENERATED_ROW_MAX_ROWS } from "../generateSeries";

export const CROSS_JOIN_MAX_ROWS = GENERATED_ROW_MAX_ROWS;

export interface CrossJoinRowPlan {
  readonly leftRows: number;
  readonly rightRows: number;
  readonly outputRows: number;
  readonly limit: number;
  readonly allowed: boolean;
}

export function planCrossJoinRows(
  leftRows: number,
  rightRows: number,
  limit = CROSS_JOIN_MAX_ROWS
): CrossJoinRowPlan {
  const outputRows = leftRows === 0 || rightRows === 0 ? 0 : leftRows * rightRows;
  return {
    leftRows,
    rightRows,
    outputRows,
    limit,
    allowed: outputRows <= limit,
  };
}
