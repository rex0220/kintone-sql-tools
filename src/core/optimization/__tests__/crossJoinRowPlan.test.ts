import {
  CROSS_JOIN_MAX_ROWS,
  planCrossJoinRows,
} from "../crossJoinRowPlan";
import { GENERATE_SERIES_MAX_ROWS } from "../../generateSeries";

describe("B158 planCrossJoinRows", () => {
  test.each([
    [0, 20, 0, true],
    [20, 0, 0, true],
    [1, 1, 1, true],
    [100, 100, 10_000, true],
    [101, 100, 10_100, false],
  ])("%i × %i", (left, right, output, allowed) => {
    expect(planCrossJoinRows(left, right)).toEqual({
      leftRows: left,
      rightRows: right,
      outputRows: output,
      limit: 10_000,
      allowed,
    });
  });

  test("GENERATE_SERIES と生成行上限を共有する", () => {
    expect(CROSS_JOIN_MAX_ROWS).toBe(GENERATE_SERIES_MAX_ROWS);
  });
});
