import { CursorLeaseManager, getCursorLeaseManager, resetCursorLeaseManagers } from "../cursorLeaseManager";

afterEach(() => {
  jest.useRealTimers();
  resetCursorLeaseManagers();
});

test("active上限を守り、release後にFIFOでpermitを渡す", async () => {
  const manager = new CursorLeaseManager("example.test", { maxActive: 2, waitTimeoutMs: 1000 });
  const first = await manager.acquire();
  const second = await manager.acquire();
  let acquired = false;
  const thirdPromise = manager.acquire().then((lease) => { acquired = true; return lease; });
  await Promise.resolve();
  expect(acquired).toBe(false);
  expect(manager.snapshot()).toMatchObject({ active: 2, peak: 2, waiting: 1 });
  first.release();
  const third = await thirdPromise;
  expect(acquired).toBe(true);
  second.release();
  third.release();
  expect(manager.snapshot().active).toBe(0);
});

test("permit待機timeoutはAPI前にCursorCapacityErrorとなる", async () => {
  jest.useFakeTimers();
  const manager = new CursorLeaseManager("example.test", { maxActive: 1, waitTimeoutMs: 30 });
  const first = await manager.acquire();
  const waiting = manager.acquire();
  jest.advanceTimersByTime(30);
  await expect(waiting).rejects.toThrow(/CursorCapacityError/);
  first.release();
});

test("quarantine中はpermitを返さず、期限後に返す", async () => {
  jest.useFakeTimers();
  const manager = new CursorLeaseManager("example.test", {
    maxActive: 1, waitTimeoutMs: 1000, quarantineMs: 100,
  });
  const first = await manager.acquire();
  first.quarantine();
  const waiting = manager.acquire();
  expect(manager.snapshot()).toMatchObject({ active: 1, quarantined: 1, waiting: 1 });
  jest.advanceTimersByTime(99);
  await Promise.resolve();
  expect(manager.snapshot().waiting).toBe(1);
  jest.advanceTimersByTime(1);
  const second = await waiting;
  expect(manager.snapshot()).toMatchObject({ active: 1, quarantined: 0, waiting: 0 });
  second.release();
});

test("Add Cursor処理をhost内で直列化する", async () => {
  const manager = new CursorLeaseManager("example.test");
  const events: string[] = [];
  let releaseFirst!: () => void;
  const blocker = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = manager.runCreate(async () => {
    events.push("first:start");
    await blocker;
    events.push("first:end");
  });
  const second = manager.runCreate(async () => { events.push("second"); });
  await Promise.resolve();
  expect(events).toEqual(["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(["first:start", "first:end", "second"]);
});

test("同一hostの上限引上げを即時反映して待機permitを渡す", async () => {
  const manager = getCursorLeaseManager("EXAMPLE.test", 1);
  const first = await manager.acquire();
  let acquired = false;
  const secondPromise = manager.acquire().then((lease) => { acquired = true; return lease; });
  await Promise.resolve();
  expect(acquired).toBe(false);

  expect(getCursorLeaseManager("example.TEST", 2)).toBe(manager);
  const second = await secondPromise;
  expect(manager.snapshot()).toMatchObject({ active: 2, limit: 2, waiting: 0 });
  first.release();
  second.release();
});

test("上限引下げ時は既存activeを維持し自然減まで新規取得を止める", async () => {
  const manager = getCursorLeaseManager("example.test", 3);
  const first = await manager.acquire();
  const second = await manager.acquire();
  const third = await manager.acquire();
  getCursorLeaseManager("example.test", 1);
  const waiting = manager.acquire();
  expect(manager.snapshot()).toMatchObject({ active: 3, limit: 1, waiting: 1 });

  first.release();
  second.release();
  await Promise.resolve();
  expect(manager.snapshot()).toMatchObject({ active: 1, waiting: 1 });
  third.release();
  const fourth = await waiting;
  expect(manager.snapshot()).toMatchObject({ active: 1, waiting: 0 });
  fourth.release();
});
