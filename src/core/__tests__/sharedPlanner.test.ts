import {
  fetchRecordsForSharedPlan,
  resolveDmlTargetIds,
} from "../optimization/sharedPlanner";

test("fetchRecordsForSharedPlan returns records and metrics", async () => {
  const getRecords = async () => ({
    records: [
      { $id: { value: "1" } },
      { $id: { value: "2" } },
    ],
  });

  const result = await fetchRecordsForSharedPlan(
    getRecords,
    88,
    "$id > 0",
    ["$id"],
    { maxRecords: 100, parallel: 1 }
  );

  expect(result.records.length).toBe(2);
  expect(result.metrics.fetchedRows).toBe(2);
});

test("resolveDmlTargetIds extracts numeric ids", async () => {
  const getRecords = async () => ({
    records: [
      { $id: { value: "10" } },
      { $id: { value: "20" } },
    ],
  });

  const result = await resolveDmlTargetIds(
    getRecords,
    88,
    "$id > 0",
    { maxRecords: 100, parallel: 1 }
  );

  expect(result.ids).toEqual([10, 20]);
  expect(result.metrics.fetchedRows).toBe(2);
});
