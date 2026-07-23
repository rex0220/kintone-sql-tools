import {
  createCursorScope,
  withCursorScope,
} from "../cursorScope";
import type {
  ReadonlyCursorHandle,
  ReadonlyKintoneClient,
} from "../publicTypes";

function makeClient(
  openCursor: () => Promise<ReadonlyCursorHandle>
): ReadonlyKintoneClient {
  return {
    getRecords: async () => ({ records: [] }),
    openCursor,
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: null }),
  };
}

function handleFixture(options: {
  nextError?: Error;
  closeError?: Error;
} = {}): { handle: ReadonlyCursorHandle; close: jest.Mock } {
  const close = jest.fn(async () => {
    if (options.closeError) throw options.closeError;
  });
  return {
    close,
    handle: {
      totalCount: 1,
      async nextPage() {
        if (options.nextError) throw options.nextError;
        return { records: [], next: false };
      },
      close,
    },
  };
}

test("KORDER Cursor success はfinallyで自分のhandleだけをcloseしcloseは冪等", async () => {
  const opened = handleFixture();
  const preexisting = handleFixture();
  const client = makeClient(async () => opened.handle);

  await withCursorScope(client, async (scoped) => {
    const handle = await scoped.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    await handle.nextPage();
    await Promise.all([handle.close(), handle.close()]);
  });

  expect(opened.close).toHaveBeenCalledTimes(1);
  expect(preexisting.close).not.toHaveBeenCalled();
});

test("KORDER nextPage errorでもfinally closeする", async () => {
  const nextError = new Error("next failed");
  const opened = handleFixture({ nextError });
  const client = makeClient(async () => opened.handle);

  await expect(withCursorScope(client, async (scoped) => {
    const handle = await scoped.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    await handle.nextPage();
  })).rejects.toBe(nextError);
  expect(opened.close).toHaveBeenCalledTimes(1);
});

test("query errorをclose errorで上書きしない", async () => {
  const queryError = new Error("query failed");
  const opened = handleFixture({ closeError: new Error("close failed") });
  const client = makeClient(async () => opened.handle);

  await expect(withCursorScope(client, async (scoped) => {
    await scoped.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
    throw queryError;
  })).rejects.toBe(queryError);
  expect(opened.close).toHaveBeenCalledTimes(1);
});

test("成功後のclose errorはClientOperationErrorとして観測する", async () => {
  const closeError = new Error("close failed");
  const opened = handleFixture({ closeError });
  const client = makeClient(async () => opened.handle);

  await expect(withCursorScope(client, async (scoped) => {
    await scoped.openCursor({
      app: 1,
      query: "order by $id",
      size: 500,
    });
  })).rejects.toMatchObject({
    name: "ClientOperationError",
    cause: closeError,
  });
});

test("scope instance間でhandle集合を共有しない", async () => {
  const first = handleFixture();
  const second = handleFixture();
  const firstScope = createCursorScope(makeClient(async () => first.handle));
  const secondScope = createCursorScope(makeClient(async () => second.handle));
  await firstScope.client.openCursor({
    app: 1,
    query: "order by $id",
    size: 500,
  });
  await secondScope.client.openCursor({
    app: 1,
    query: "order by $id",
    size: 500,
  });

  await firstScope.close();
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(second.close).not.toHaveBeenCalled();
  await secondScope.close();
  expect(second.close).toHaveBeenCalledTimes(1);
});
