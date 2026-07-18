import {
  activeCursorHandleCount,
  closeActiveCursorHandles,
  installCursorPageLifecycle,
  registerCursorHandle,
  resetCursorPageLifecycleForTest,
} from "../cursorPageLifecycle";

afterEach(resetCursorPageLifecycleForTest);

test("pagehideとbeforeunloadからactive handleをbest-effort closeする", async () => {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  installCursorPageLifecycle({
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) { listeners.set(type, listener); },
  } as Pick<Window, "addEventListener">);
  let closes = 0;
  registerCursorHandle({
    totalCount: 1,
    async nextPage() { return { records: [], next: true }; },
    async close() { closes += 1; },
  });
  expect(activeCursorHandleCount()).toBe(1);
  const listener = listeners.get("pagehide") as EventListener;
  listener(new Event("pagehide"));
  await Promise.resolve();
  await Promise.resolve();
  expect(closes).toBe(1);
  expect(activeCursorHandleCount()).toBe(0);
  expect(listeners.has("beforeunload")).toBe(true);
});

test("next=falseと通常closeでregistryから除外する", async () => {
  const auto = registerCursorHandle({
    totalCount: 0,
    async nextPage() { return { records: [], next: false }; },
    async close() {},
  });
  await auto.nextPage();
  expect(activeCursorHandleCount()).toBe(0);

  const explicit = registerCursorHandle({
    totalCount: 1,
    async nextPage() { return { records: [], next: true }; },
    async close() {},
  });
  await explicit.close();
  expect(activeCursorHandleCount()).toBe(0);
  closeActiveCursorHandles();
});

test("ページ離脱cleanup失敗を未処理rejectにせずregistryから除外する", async () => {
  registerCursorHandle({
    totalCount: 1,
    async nextPage() { return { records: [], next: true }; },
    async close() { throw new Error("delete failed"); },
  });
  closeActiveCursorHandles();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(activeCursorHandleCount()).toBe(0);
});
