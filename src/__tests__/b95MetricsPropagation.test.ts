import {
  __testOnlyMetricsPropagation,
  type KintoneClient,
} from "../execute";

test("B95: metrics sink survives existing wrappers and an arbitrary client spread", () => {
  const {
    createEmptyMetrics,
    markLimitReached,
    wrapClientWithCursorScope,
    wrapClientWithMetrics,
    wrapClientWithSearchAbort,
  } = __testOnlyMetricsPropagation;
  const baseClient = {} as KintoneClient;
  const metrics = createEmptyMetrics();
  const countedClient = wrapClientWithMetrics(baseClient, metrics);

  const searchAbortClient = wrapClientWithSearchAbort(
    countedClient,
    { aborted: false },
    false
  );
  markLimitReached(searchAbortClient, 9501);

  const cursorScopeClient = wrapClientWithCursorScope(searchAbortClient).client;
  markLimitReached(cursorScopeClient, 9502);

  const arbitrarilyWrappedClient = { ...cursorScopeClient };
  markLimitReached(arbitrarilyWrappedClient, 9503);

  expect(metrics.limitReached).toBe(true);
  expect(metrics.limitReachedApps).toEqual([9501, 9502, 9503]);
});
