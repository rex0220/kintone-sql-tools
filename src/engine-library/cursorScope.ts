import type {
  ReadonlyCursorHandle,
  ReadonlyKintoneClient,
} from "./publicTypes";
import { ClientOperationError } from "./readonlyClient";

export interface CursorScope {
  readonly client: ReadonlyKintoneClient;
  close(): Promise<void>;
}

/**
 * A query-local projection that owns only handles opened through this projection.
 * Handles that already existed on the BYO client are never observed or closed.
 */
export function createCursorScope(client: ReadonlyKintoneClient): CursorScope {
  const handles = new Set<ReadonlyCursorHandle>();
  let closePromise: Promise<void> | null = null;

  const scopedClient: ReadonlyKintoneClient = {
    getRecords: client.getRecords.bind(client),
    async openCursor(params) {
      const source = await client.openCursor.call(client, params);
      let handleClosePromise: Promise<void> | null = null;
      const handle: ReadonlyCursorHandle = {
        totalCount: source.totalCount,
        nextPage: source.nextPage.bind(source),
        close() {
          if (handleClosePromise) return handleClosePromise;
          handleClosePromise = Promise.resolve()
            .then(() => source.close())
            .finally(() => {
              handles.delete(handle);
            });
          return handleClosePromise;
        },
      };
      handles.add(handle);
      return handle;
    },
    getApps: client.getApps.bind(client),
    getFields: client.getFields.bind(client),
    getNumberPrecision: client.getNumberPrecision.bind(client),
    getProcessStatuses: client.getProcessStatuses.bind(client),
  };

  return {
    client: scopedClient,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const results = await Promise.allSettled(
          [...handles].map((handle) => handle.close())
        );
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (failed) throw new ClientOperationError(failed.reason);
      })();
      return closePromise;
    },
  };
}

/**
 * Close query-owned cursors on both success and failure. Cleanup failure is
 * observable after success, but never replaces the query's original error.
 */
export async function withCursorScope<T>(
  client: ReadonlyKintoneClient,
  operation: (scopedClient: ReadonlyKintoneClient) => Promise<T>
): Promise<T> {
  const scope = createCursorScope(client);
  let operationFailed = false;
  try {
    return await operation(scope.client);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await scope.close();
    } catch (closeError) {
      if (!operationFailed) throw closeError;
    }
  }
}
