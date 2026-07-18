import type { KintoneCursorHandle } from "../api/kintoneCursor";

const activeHandles = new Set<KintoneCursorHandle>();
let installed = false;

export function registerCursorHandle(handle: KintoneCursorHandle): KintoneCursorHandle {
  activeHandles.add(handle);
  const remove = () => activeHandles.delete(handle);
  return {
    totalCount: handle.totalCount,
    async nextPage() {
      const page = await handle.nextPage();
      if (!page.next) remove();
      return page;
    },
    async close() {
      try {
        await handle.close();
      } finally {
        remove();
      }
    },
  };
}

export function closeActiveCursorHandles(): void {
  for (const handle of [...activeHandles]) {
    void handle.close()
      .catch(() => undefined)
      .finally(() => activeHandles.delete(handle));
  }
}

export function installCursorPageLifecycle(
  target: Pick<Window, "addEventListener"> = window
): void {
  if (installed) return;
  installed = true;
  target.addEventListener("pagehide", closeActiveCursorHandles);
  target.addEventListener("beforeunload", closeActiveCursorHandles);
}

export function activeCursorHandleCount(): number {
  return activeHandles.size;
}

export function resetCursorPageLifecycleForTest(): void {
  activeHandles.clear();
  installed = false;
}
