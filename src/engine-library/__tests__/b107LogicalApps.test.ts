import {
  explainQuery,
  runBatch,
  runQuery,
  type ReadonlyKintoneClient,
} from "../index";

function trackedClient(overrides: Partial<ReadonlyKintoneClient> = {}) {
  const client: ReadonlyKintoneClient = {
    getRecords: jest.fn(async () => ({ records: [] })),
    openCursor: jest.fn(async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    })),
    getApps: jest.fn(async () => []),
    getFields: jest.fn(async () => []),
    getNumberPrecision: jest.fn(async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN" as const,
    })),
    getProcessStatuses: jest.fn(async () => ({ enable: false, states: [] })),
    ...overrides,
  };
  return {
    client,
    apiMocks: Object.values(client).filter((value): value is jest.Mock => jest.isMockFunction(value)),
  };
}

describe("B107 engine-library logicalApps", () => {
  test("runQuery resolves a Japanese logical app to the physical app", async () => {
    const getRecords = jest.fn(async () => ({ records: [] }));
    const getFields = jest.fn(async () => []);
    const { client } = trackedClient({ getRecords, getFields });
    await expect(runQuery("SELECT * FROM LAPP_案件管理", {
      client,
      logicalApps: { 案件管理: 4149 },
    })).resolves.toMatchObject({ type: "query" });
    expect(getRecords).toHaveBeenCalledWith(expect.objectContaining({ app: 4149 }));
    expect(getFields).toHaveBeenCalledWith(4149);
  });

  test("runBatch resolves Japanese and ASCII logical apps", async () => {
    const getRecords = jest.fn(async () => ({ records: [] }));
    const { client } = trackedClient({ getRecords });
    await expect(runBatch(
      "SELECT * FROM LAPP_案件管理; SELECT * FROM LAPP_orders",
      { client, logicalApps: { 案件管理: 4149, ORDERS: 4150 } }
    )).resolves.toMatchObject({ type: "batch", statementCount: 2 });
    expect(getRecords).toHaveBeenCalledWith(expect.objectContaining({ app: 4149 }));
    expect(getRecords).toHaveBeenCalledWith(expect.objectContaining({ app: 4150 }));
  });

  test("explainQuery resolves Japanese logical apps without Records GET", async () => {
    const getRecords = jest.fn(async () => ({ records: [] }));
    const getFields = jest.fn(async () => []);
    const { client } = trackedClient({ getRecords, getFields });
    await expect(explainQuery("SELECT * FROM LAPP_案件管理", {
      client,
      logicalApps: { 案件管理: 4149 },
    })).resolves.toMatchObject({ type: "explain" });
    expect(getRecords).not.toHaveBeenCalled();
    expect(getFields).not.toHaveBeenCalled();
  });

  test.each(["runQuery", "runBatch", "explainQuery"] as const)(
    "%s rejects an undefined name before every API call",
    async (surface) => {
      const tracked = trackedClient();
      const invocation = surface === "runQuery"
        ? runQuery("SELECT * FROM LAPP_未定義", { client: tracked.client })
        : surface === "runBatch"
          ? runBatch("SELECT * FROM LAPP_未定義", { client: tracked.client })
          : explainQuery("SELECT * FROM LAPP_未定義", { client: tracked.client });
      await expect(invocation).rejects.toMatchObject({
        message: expect.stringContaining("LAPP_未定義 is not defined"),
      });
      for (const mock of tracked.apiMocks) expect(mock).not.toHaveBeenCalled();
    }
  );

  test.each(["LAPP_案件@prod", "APP4149@prod"])(
    "browser profile suffix is rejected explicitly: %s",
    async (reference) => {
      const tracked = trackedClient();
      await expect(runQuery(`SELECT * FROM ${reference}`, { client: tracked.client }))
        .rejects.toMatchObject({ message: expect.stringContaining("does not support @profile") });
      for (const mock of tracked.apiMocks) expect(mock).not.toHaveBeenCalled();
    }
  );

  test("NFD and fullwidth ASCII option keys canonicalize to the SQL name", async () => {
    const getRecords = jest.fn(async () => ({ records: [] }));
    const { client } = trackedClient({ getRecords });
    await runQuery("SELECT * FROM LAPP_がくせいＡ", {
      client,
      logicalApps: { "か\u3099くせいａ": 4149 },
    });
    expect(getRecords).toHaveBeenCalledWith(expect.objectContaining({ app: 4149 }));
  });

  test("canonical duplicate and invalid values are rejected before every API call", async () => {
    const tracked = trackedClient();
    await expect(runQuery("SELECT 1", {
      client: tracked.client,
      logicalApps: { orders: 1, ORDERS: 2 },
    })).rejects.toMatchObject({ message: expect.stringContaining("duplicates") });
    await expect(runQuery("SELECT 1", {
      client: tracked.client,
      logicalApps: { 注文: 0 },
    })).rejects.toMatchObject({ message: expect.stringContaining("positive safe integer") });
    for (const mock of tracked.apiMocks) expect(mock).not.toHaveBeenCalled();
  });

  test("resolved execution errors retain the logical and physical app mapping", async () => {
    const { client } = trackedClient({
      getRecords: jest.fn(async () => { throw new Error("transport failed"); }),
    });
    await expect(runQuery("SELECT * FROM LAPP_案件管理", {
      client,
      logicalApps: { 案件管理: 4149 },
    })).rejects.toMatchObject({
      message: expect.stringContaining("LAPP_案件管理 -> APP4149"),
    });
  });

  test("SQL without LAPP_ keeps the same engine error code and message", async () => {
    const cause = new Error("same transport failure");
    const { client } = trackedClient({
      getRecords: jest.fn(async () => { throw cause; }),
    });
    const capture = async (logicalApps?: Readonly<Record<string, number>>) => {
      try {
        await runQuery("SELECT * FROM APP4149", { client, logicalApps });
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error("expected rejection");
    };
    const baseline = await capture();
    const withOption = await capture({ 注文: 4149 });
    expect(withOption).toMatchObject({ code: baseline.code, message: baseline.message });
  });
});
