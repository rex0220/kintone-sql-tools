import type { KintoneClient } from "../execute";
import { readOnlyViolation, searchAborted } from "./errors";
import type { ReadonlyKintoneClient } from "./publicTypes";

const WRITE_METHODS = new Set<PropertyKey>([
  "postRecords",
  "putRecords",
  "deleteRecords",
]);

export class ClientOperationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "ClientOperationError";
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function clientCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ClientOperationError(error);
  }
}

function blockedWrite(method: PropertyKey): () => never {
  return () => {
    throw readOnlyViolation(`${String(method)} is blocked by the readonly client`);
  };
}

/**
 * Project a BYO readonly client into the exact six-method execution surface.
 * The returned Proxy deliberately reports record-write methods as absent while
 * still trapping a delayed direct GET from execute()'s metrics write closures.
 */
export function projectReadonlyClient(client: ReadonlyKintoneClient): KintoneClient {
  const getRecords = client.getRecords.bind(client);
  const openCursor = client.openCursor.bind(client);
  const getApps = client.getApps.bind(client);
  const getFields = client.getFields.bind(client);
  const getNumberPrecision = client.getNumberPrecision.bind(client);
  const getProcessStatuses = client.getProcessStatuses.bind(client);

  const target = Object.assign(Object.create(null) as Record<PropertyKey, unknown>, {
    getRecords: async (params: Parameters<typeof getRecords>[0]) => {
      const result = await clientCall(() => getRecords(params));
      if (result.searchAborted === true) throw searchAborted();
      return result;
    },
    openCursor: async (params: Parameters<typeof openCursor>[0]) => {
      const handle = await clientCall(() => openCursor(params));
      const nextPage = handle.nextPage.bind(handle);
      const close = handle.close.bind(handle);
      return {
        totalCount: handle.totalCount,
        nextPage: () => clientCall(() => nextPage()),
        close: () => clientCall(() => close()),
      };
    },
    getApps: () => clientCall(() => getApps()),
    getFields: (appId: number) => clientCall(() => getFields(appId)),
    getNumberPrecision: (appId: number) =>
      clientCall(() => getNumberPrecision(appId)),
    getProcessStatuses: (appId: number) =>
      clientCall(() => getProcessStatuses(appId)),
  });

  return new Proxy(target, {
    get(projected, property, receiver) {
      if (WRITE_METHODS.has(property)) return blockedWrite(property);
      return Reflect.get(projected, property, receiver);
    },
    has(projected, property) {
      if (WRITE_METHODS.has(property)) return false;
      return Reflect.has(projected, property);
    },
  }) as unknown as KintoneClient;
}
