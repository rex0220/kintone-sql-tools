import {
  runBatch,
  runQuery,
  type ReadonlyFieldInfo,
  type ReadonlyKintoneClient,
  type ReadonlyKintoneRecord,
} from "../index";

const field = (value: unknown) => ({ value });

function records(count: number): ReadonlyKintoneRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    $id: field(String(index + 1)),
    key: field(`K${index + 1}`),
  }));
}

function clientFor(recordsByApp: Readonly<Record<number, readonly ReadonlyKintoneRecord[]>>):
ReadonlyKintoneClient {
  const fields: ReadonlyFieldInfo[] = [{
    code: "key",
    label: "key",
    fieldType: "SINGLE_LINE_TEXT",
    optionOrder: {},
  }];
  return {
    getRecords: async ({ app, query = "" }) => {
      const source = recordsByApp[app] ?? [];
      const limit = Number(/\blimit\s+(\d+)/i.exec(query)?.[1] ?? source.length);
      const offset = Number(/\boffset\s+(\d+)/i.exec(query)?.[1] ?? 0);
      return { records: source.slice(offset, offset + limit) };
    },
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => fields,
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
}

test("B95: simple truncate exposes the reached app while a complete query returns false and []", async () => {
  const client = clientFor({
    9501: records(3),
    9502: records(2),
  });

  const truncated = await runQuery("SELECT key FROM APP9501", {
    client,
    maxRecords: 2,
    onLimitReached: "truncate",
  });
  expect(truncated.metrics.limitReached).toBe(true);
  expect(truncated.metrics.limitReachedApps).toEqual([9501]);

  const complete = await runQuery("SELECT key FROM APP9502", {
    client,
    maxRecords: 2,
    onLimitReached: "truncate",
  });
  expect(complete.metrics.limitReached).toBe(false);
  expect(complete.metrics.limitReachedApps).toEqual([]);
});

test("B95: JOIN reports only the input app that independently reached maxRecords", async () => {
  const result = await runQuery(
    "SELECT a.key FROM APP4148 a LEFT JOIN APP4149 b ON a.key = b.key",
    {
      client: clientFor({
        4148: records(231),
        4149: records(20),
      }),
      maxRecords: 230,
      onLimitReached: "truncate",
    }
  );

  expect(result.metrics.limitReached).toBe(true);
  expect(result.metrics.limitReachedApps).toEqual([4148]);
});

test("B95: optimized INNER JOIN reports truncation from the keyed join fetch", async () => {
  const result = await runQuery(
    "SELECT a.key FROM APP9501 a INNER JOIN APP9502 b ON a.key = b.key",
    {
      client: clientFor({
        9501: records(1),
        9502: records(3),
      }),
      maxRecords: 2,
      onLimitReached: "truncate",
    }
  );

  expect(result.metrics.limitReached).toBe(true);
  expect(result.metrics.limitReachedApps).toEqual([9502]);
});

test("B95: fetchedRows total exceeding maxRecords does not imply truncation", async () => {
  const result = await runQuery(
    "SELECT a.key FROM APP4148 a LEFT JOIN APP4149 b ON a.key = b.key",
    {
      client: clientFor({
        4148: records(215),
        4149: records(20),
      }),
      maxRecords: 230,
      onLimitReached: "truncate",
    }
  );

  expect(result.metrics.fetchedRows).toBe(235);
  expect(result.metrics.limitReached).toBe(false);
  expect(result.metrics.limitReachedApps).toEqual([]);
});

test("B95: reached app IDs are unique and ascending, including a repeated self JOIN app", async () => {
  const selfJoin = await runQuery(
    "SELECT a.key FROM APP9502 a INNER JOIN APP9502 b ON a.key = b.key",
    {
      client: clientFor({ 9502: records(3) }),
      maxRecords: 2,
      onLimitReached: "truncate",
    }
  );
  expect(selfJoin.metrics.limitReachedApps).toEqual([9502]);

  const reverseOrder = await runQuery(
    "SELECT a.key FROM APP9502 a INNER JOIN APP9501 b ON a.key = b.key",
    {
      client: clientFor({
        9501: records(3),
        9502: records(3),
      }),
      maxRecords: 2,
      onLimitReached: "truncate",
    }
  );
  expect(reverseOrder.metrics.limitReachedApps).toEqual([9501, 9502]);
});

test("B95: runBatch exposes one batch-wide truncation metric on every query result", async () => {
  const result = await runBatch(
    "SELECT key FROM APP9502; SELECT key FROM APP9501",
    {
      client: clientFor({
        9501: records(3),
        9502: records(3),
      }),
      maxRecords: 2,
      onLimitReached: "truncate",
    }
  );

  expect(result.results).toHaveLength(2);
  for (const queryResult of result.results) {
    expect(queryResult.metrics.limitReached).toBe(true);
    expect(queryResult.metrics.limitReachedApps).toEqual([9501, 9502]);
  }
});
