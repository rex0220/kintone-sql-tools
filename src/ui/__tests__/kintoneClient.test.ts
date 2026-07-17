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

test("plugin クライアントは STATUS の name と index を保持し states=null を空配列化しない", async () => {
  const responses = [
    { enable: true, states: { open: { name: "未処理", index: "3" } } },
    { enable: false, states: null },
  ];
  const api = jest.fn(async () => responses.shift()) as jest.Mock & {
    url: (path: string, guest: boolean) => string;
  };
  api.url = (path) => path;
  const root = globalThis as unknown as { kintone?: { api: typeof api } };
  const previous = root.kintone;
  root.kintone = { api };
  try {
    const client = createKintoneClient();
    await expect(client.getProcessStatuses(1)).resolves.toEqual({
      enable: true,
      states: [{ name: "未処理", index: 3 }],
    });
    await expect(client.getProcessStatuses(1)).resolves.toEqual({ enable: false, states: null });
    expect(api).toHaveBeenCalledWith(
      "/k/v1/app/status.json",
      "GET",
      { app: 1, lang: "user" }
    );
  } finally {
    if (previous) root.kintone = previous;
    else delete root.kintone;
  }
});
