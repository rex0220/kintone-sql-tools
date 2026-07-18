import { createKintoneCursorHandle, deleteCursorWithConfirmation } from "../kintoneCursor";

afterEach(() => jest.useRealTimers());

test("nextPageを直列化し、next=false後のcloseはDELETEしない", async () => {
  const events: string[] = [];
  let page = 0;
  const handle = createKintoneCursorHandle(2, {
    async get() {
      const current = ++page;
      events.push(`get${current}:start`);
      await Promise.resolve();
      events.push(`get${current}:end`);
      return { records: [], next: current < 2 };
    },
    async delete() { events.push("delete"); },
  });

  await Promise.all([handle.nextPage(), handle.nextPage()]);
  await handle.close();
  expect(events).toEqual(["get1:start", "get1:end", "get2:start", "get2:end"]);
});

test("closeの同時呼出しは同じDELETEを共有する", async () => {
  let deletes = 0;
  const handle = createKintoneCursorHandle(10, {
    async get() { return { records: [], next: true }; },
    async delete() { deletes += 1; },
  });
  await Promise.all([handle.close(), handle.close(), handle.close()]);
  expect(deletes).toBe(1);
});

test("進行中GETの間にcloseを始めたら後続nextPageを開始しない", async () => {
  let releaseGet!: () => void;
  const getBlocked = new Promise<void>((resolve) => { releaseGet = resolve; });
  let gets = 0;
  let deletes = 0;
  const handle = createKintoneCursorHandle(1000, {
    async get() {
      gets += 1;
      await getBlocked;
      return { records: [], next: true };
    },
    async delete() { deletes += 1; },
  });

  const firstPage = handle.nextPage();
  await Promise.resolve();
  const closing = handle.close();
  await expect(handle.nextPage()).resolves.toEqual({ records: [], next: false });
  releaseGet();
  await firstPage;
  await closing;
  expect(gets).toBe(1);
  expect(deletes).toBe(1);
});

test("DELETE失敗後の再確認が404+GAIA_CN01なら解放済みと扱う", async () => {
  let calls = 0;
  await expect(deleteCursorWithConfirmation(async () => {
    calls += 1;
    if (calls === 1) throw new Error("network lost");
    throw Object.assign(new Error("gone"), { status: 404, code: "GAIA_CN01" });
  }, async () => undefined)).resolves.toBeUndefined();
  expect(calls).toBe(2);
});

test("404またはGAIA_CN01単独では解放済みと推定しない", async () => {
  await expect(deleteCursorWithConfirmation(async () => {
    throw Object.assign(new Error("wrong pair"), { status: 404, code: "OTHER" });
  }, async () => undefined)).rejects.toThrow("wrong pair");
});

test("cleanup全体budget超過は解放不明callbackへ送る", async () => {
  jest.useFakeTimers();
  let unknown = 0;
  const handle = createKintoneCursorHandle(1, {
    get: async () => ({ records: [], next: true }),
    delete: () => new Promise<void>(() => undefined),
    cleanupTimeoutMs: 50,
    onReleaseUnknown: () => { unknown += 1; },
  });
  const closing = handle.close();
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(50);
  await expect(closing).rejects.toThrow(/CursorCleanupTimeoutError/);
  expect(unknown).toBe(1);
  jest.useRealTimers();
});
