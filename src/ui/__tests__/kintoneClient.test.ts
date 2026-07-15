import { createKintoneClient } from "../kintoneClient";

test("plugin クライアントは本文だけを返し searchAborted を推測しない", async () => {
  const api = jest.fn(async () => ({ records: [] })) as jest.Mock & {
    url: (path: string, guest: boolean) => string;
  };
  api.url = (path) => path;
  const root = globalThis as unknown as { kintone?: { api: typeof api } };
  const previous = root.kintone;
  root.kintone = { api };
  try {
    const response = await createKintoneClient().getRecords({ app: 1, query: "", fields: [] });
    expect(response).toEqual({ records: [] });
    expect(response.searchAborted).toBeUndefined();
  } finally {
    if (previous) root.kintone = previous;
    else delete root.kintone;
  }
});
