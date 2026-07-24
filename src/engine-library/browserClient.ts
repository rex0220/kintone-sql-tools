import { CursorLeaseManager } from "../api/cursorLeaseManager";
import { createKintoneCursorHandle } from "../api/kintoneCursor";
import {
  flattenFormFieldProperties,
  type FormFieldProperty,
} from "../core/formFieldInfo";
import { CursorCreateOutcomeUnknownError } from "../core/errors/cursorErrors";
import { parseNumberPrecisionSettings } from "../core/numberPrecision";
import {
  normalizeProcessStatusStates,
  type RawProcessStatusState,
} from "../core/processStatus";
import { isSearchAbortedWarning } from "../core/searchAbortWarning";
import type {
  CreateReadonlyKintoneClientOptions,
  ReadonlyAppInfo,
  ReadonlyCursorHandle,
  ReadonlyFieldInfo,
  ReadonlyKintoneClient,
  ReadonlyKintoneRecord,
  ReadonlyProcessStatuses,
} from "./publicTypes";

type KintoneApiWithUrl = typeof kintone.api & {
  url(path: string, guest: boolean): string;
  urlForGet(path: string, params: object, isGuestSpace: boolean): string;
};

const RECORDS_PATH = "/k/v1/records.json";
const CURSOR_PATH = "/k/v1/records/cursor.json";
const GET_URL_MAX_BYTES = 4096;
const DEFAULT_CURSOR_MAX_ACTIVE = 2;

const apiUrl = (path: string) =>
  (kintone.api as KintoneApiWithUrl).url(path, true);

function buildRecordsRequest(
  params: Parameters<ReadonlyKintoneClient["getRecords"]>[0]
): { url: string; init: RequestInit } {
  const requestParams: { app: number; query: string; fields?: string[] } = {
    app: params.app,
    query: params.query,
    ...(params.fields.length > 0 ? { fields: params.fields } : {}),
  };
  const apiWithUrl = kintone.api as KintoneApiWithUrl;
  const getUrl = apiWithUrl.urlForGet(RECORDS_PATH, requestParams, true);
  const commonHeaders = { "X-Requested-With": "XMLHttpRequest" };

  if (new TextEncoder().encode(getUrl).byteLength <= GET_URL_MAX_BYTES) {
    return {
      url: getUrl,
      init: {
        method: "GET",
        credentials: "include",
        headers: commonHeaders,
      },
    };
  }

  return {
    url: apiUrl(RECORDS_PATH),
    init: {
      method: "POST",
      credentials: "include",
      headers: {
        ...commonHeaders,
        "X-HTTP-Method-Override": "GET",
        "Content-Type": "application/json",
        "X-Cybozu-Request-Token": kintone.getRequestToken(),
      },
      body: JSON.stringify(requestParams),
    },
  };
}

function toDetailedApiError(error: unknown): unknown {
  const shaped = error as { message?: unknown } | null;
  if (error instanceof Error && error.message.trim() !== "") return error;
  if (
    shaped === null ||
    typeof shaped !== "object" ||
    typeof shaped.message !== "string" ||
    shaped.message.trim() === ""
  ) {
    const detailed = new Error(
      "ネットワークエラー: kintone からの応答がありません（オフライン・通信遮断の可能性）"
    );
    Object.assign(detailed, { cause: error });
    return detailed;
  }

  const source = shaped as {
    code?: unknown;
    message: string;
    errors?: unknown;
    status?: unknown;
  };
  const lines = [
    typeof source.code === "string" && source.code !== ""
      ? `${source.message}（${source.code}）`
      : source.message,
  ];
  if (source.errors !== null && typeof source.errors === "object") {
    for (const [key, detail] of Object.entries(
      source.errors as Record<string, { messages?: unknown }>
    )) {
      const messages = Array.isArray(detail?.messages)
        ? detail.messages.filter(
          (message): message is string => typeof message === "string"
        )
        : [];
      if (messages.length > 0) lines.push(`${key}: ${messages.join(" / ")}`);
    }
  }

  const detailed = new Error(lines.join("\n"));
  if (typeof source.code === "string" && source.code !== "") {
    detailed.name = source.code;
  }
  if (typeof source.code === "string") {
    Object.assign(detailed, { code: source.code });
  }
  if (typeof source.status === "number") {
    Object.assign(detailed, { status: source.status });
  }
  Object.assign(detailed, { cause: error });
  return detailed;
}

async function readRawFetchError(response: Response): Promise<unknown> {
  try {
    const body = await response.json() as unknown;
    if (body !== null && typeof body === "object") {
      const source = body as {
        code?: unknown;
        message?: unknown;
        errors?: unknown;
      };
      return toDetailedApiError({
        code: source.code,
        message: source.message,
        errors: source.errors,
        status: response.status,
      });
    }
    const error = new Error(`kintone API error: HTTP ${response.status}`);
    Object.assign(error, { status: response.status, cause: body });
    return toDetailedApiError(error);
  } catch (cause) {
    const error = new Error(
      `kintone API error: HTTP ${response.status} の応答を JSON として解析できません`
    );
    Object.assign(error, { status: response.status, cause });
    return toDetailedApiError(error);
  }
}

function isPluginAlreadyReleasedCursorError(error: unknown): boolean {
  const shaped = error as { status?: unknown; code?: unknown } | null;
  return shaped?.code === "GAIA_CN01" &&
    (shaped.status === 404 || shaped.status === undefined);
}

async function api<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  params: Record<string, unknown>
): Promise<T> {
  try {
    return await kintone.api(apiUrl(path), method, params) as T;
  } catch (error) {
    throw toDetailedApiError(error);
  }
}

function validateCursorMaxActive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new Error(
      "ArgumentError: cursorMaxActive must be an integer from 1 to 5."
    );
  }
}

export function createReadonlyKintoneClient(
  options: CreateReadonlyKintoneClientOptions = {}
): ReadonlyKintoneClient {
  const cursorMaxActive =
    options.cursorMaxActive ?? DEFAULT_CURSOR_MAX_ACTIVE;
  validateCursorMaxActive(cursorMaxActive);

  let manager: CursorLeaseManager | null = null;
  let managerHost: string | null = null;
  const activeHandles = new Set<ReadonlyCursorHandle>();

  const client: ReadonlyKintoneClient = {
    async getRecords(params) {
      try {
        const request = buildRecordsRequest(params);
        const response = await fetch(request.url, request.init);
        if (!response.ok) throw await readRawFetchError(response);
        const body = await response.json() as {
          records: ReadonlyKintoneRecord[];
        };
        return isSearchAbortedWarning(
          response.headers.get("X-Cybozu-Warning")
        )
          ? { records: body.records, searchAborted: true }
          : { records: body.records };
      } catch (error) {
        throw toDetailedApiError(error);
      }
    },

    async openCursor(params) {
      const cursorUrl = apiUrl(CURSOR_PATH);
      const host = new URL(cursorUrl, globalThis.location?.href).host
        .toLowerCase();
      if (managerHost !== null && managerHost !== host) {
        throw new Error(
          `CursorRouteError: factory route changed from ${managerHost} to ${host}.`
        );
      }
      managerHost = host;
      manager ??= new CursorLeaseManager(host, {
        maxActive: cursorMaxActive,
      });
      if (manager.snapshot().active >= cursorMaxActive) {
        const error = new Error(
          `CursorCapacityError: host=${host} の active cursor 上限 ${cursorMaxActive} に達しています。`
        );
        error.name = "CursorCapacityError";
        throw error;
      }

      const lease = await manager.acquire();
      let created: { id: string; totalCount: string };
      try {
        created = await manager.runCreate(() =>
          api<{ id: string; totalCount: string }>(CURSOR_PATH, "POST", {
            app: params.app,
            query: params.query,
            size: params.size,
            fields:
              params.fields && params.fields.length > 0
                ? params.fields
                : undefined,
          })
        );
      } catch (error) {
        if (typeof (error as { code?: unknown } | null)?.code === "string") {
          lease.release();
          throw error;
        }
        lease.quarantine();
        throw new CursorCreateOutcomeUnknownError(error);
      }

      const cursorId = created.id;
      const source = createKintoneCursorHandle(Number(created.totalCount), {
        get: () => api(CURSOR_PATH, "GET", { id: cursorId }),
        delete: () => api(CURSOR_PATH, "DELETE", { id: cursorId }),
        isAlreadyReleasedError: isPluginAlreadyReleasedCursorError,
        onReleased: () => lease.release(),
        onReleaseUnknown: () => lease.quarantine(),
      });
      let closePromise: Promise<void> | null = null;
      const handle: ReadonlyCursorHandle = {
        totalCount: source.totalCount,
        async nextPage() {
          const page = await source.nextPage();
          if (!page.next) activeHandles.delete(handle);
          return page;
        },
        close() {
          if (closePromise) return closePromise;
          closePromise = source.close().finally(() => {
            activeHandles.delete(handle);
          });
          return closePromise;
        },
      };
      activeHandles.add(handle);
      return handle;
    },

    async getApps(): Promise<readonly ReadonlyAppInfo[]> {
      const pageSize = 100;
      const apps: ReadonlyAppInfo[] = [];
      let offset = 0;
      while (true) {
        const response = await api<{
          apps: Array<{
            appId: string;
            name: string;
            description: string;
          }>;
        }>("/k/v1/apps.json", "GET", { limit: pageSize, offset });
        for (const app of response.apps) {
          apps.push({
            appId: Number(app.appId),
            name: app.name,
            description: app.description,
          });
        }
        if (response.apps.length < pageSize) break;
        offset += pageSize;
      }
      return apps;
    },

    async getFields(appId: number): Promise<readonly ReadonlyFieldInfo[]> {
      const response = await api<{
        properties: Record<string, FormFieldProperty>;
      }>("/k/v1/app/form/fields.json", "GET", { app: appId });
      return flattenFormFieldProperties(response.properties);
    },

    async getNumberPrecision(appId: number) {
      const response = await api<
        Parameters<typeof parseNumberPrecisionSettings>[0]
      >("/k/v1/app/settings.json", "GET", { app: appId });
      return parseNumberPrecisionSettings(response);
    },

    async getProcessStatuses(
      appId: number
    ): Promise<ReadonlyProcessStatuses> {
      const response = await api<{
        enable: boolean;
        states: Record<string, RawProcessStatusState> | null;
      }>("/k/v1/app/status.json", "GET", {
        app: appId,
        lang: "user",
      });
      return {
        enable: response.enable,
        states: normalizeProcessStatusStates(response.states),
      };
    },
  };

  return client;
}
