import type { KintoneRecord } from "../converter/dmlToKintone";

export interface KintoneCursorOpenParams {
  app: number;
  fields?: string[];
  query: string;
  size: 500;
}

export interface KintoneCursorPage {
  records: KintoneRecord[];
  next: boolean;
}

export interface KintoneCursorHandle {
  readonly totalCount: number;
  nextPage(): Promise<KintoneCursorPage>;
  close(): Promise<void>;
}

export interface RawCursorOperations {
  get(): Promise<KintoneCursorPage>;
  delete(): Promise<void>;
  onReleased?(): void;
  onReleaseUnknown?(): void;
  cleanupTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isAlreadyReleasedError?: (error: unknown) => boolean;
}

export interface CursorApiErrorShape {
  status?: number;
  code?: string;
}

export function isAlreadyReleasedCursorError(error: unknown): boolean {
  const shaped = error as CursorApiErrorShape | null;
  return shaped?.status === 404 && shaped.code === "GAIA_CN01";
}

export async function deleteCursorWithConfirmation(
  deleteCursor: () => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isAlreadyReleased: (error: unknown) => boolean = isAlreadyReleasedCursorError
): Promise<void> {
  try {
    await deleteCursor();
    return;
  } catch (firstError) {
    if (isAlreadyReleased(firstError)) return;
  }
  await sleep(250);
  try {
    await deleteCursor();
  } catch (confirmationError) {
    if (isAlreadyReleased(confirmationError)) return;
    throw confirmationError;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`CursorCleanupTimeoutError: cleanup exceeded ${timeoutMs}ms.`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cursor IDを外へ公開せず、Getの直列化とcloseの冪等性を共有実装する。 */
export function createKintoneCursorHandle(
  totalCount: number,
  operations: RawCursorOperations
): KintoneCursorHandle {
  let released = false;
  let closing = false;
  let pageTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;

  const nextPage = (): Promise<KintoneCursorPage> => {
    if (closing || released) return Promise.resolve({ records: [], next: false });
    const result = pageTail.then(async () => {
      if (closing || released) return { records: [], next: false };
      const page = await operations.get();
      if (!page.next) {
        released = true;
        operations.onReleased?.();
      }
      return page;
    });
    pageTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const close = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (closePromise) return closePromise;
    closing = true;
    closePromise = pageTail.then(async () => {
      if (released) return;
      try {
        await withTimeout(
          deleteCursorWithConfirmation(
            operations.delete,
            operations.sleep,
            operations.isAlreadyReleasedError
          ),
          operations.cleanupTimeoutMs ?? 5_000
        );
        released = true;
        operations.onReleased?.();
      } catch (error) {
        operations.onReleaseUnknown?.();
        throw error;
      }
    });
    return closePromise;
  };

  return { totalCount, nextPage, close };
}
