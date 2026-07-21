import type {
  KintoneAppInfo,
  KintoneClient,
  KintoneDeleteParams,
  KintoneFieldInfo,
  KintonePostParams,
  KintoneProcessStatuses,
  KintonePutParams,
  PageFetchParams,
} from "../core";
import {
  flattenFormFieldProperties,
  type FormFieldProperty,
} from "../core/formFieldInfo";
import { normalizeProcessStatusStates, type RawProcessStatusState } from "../core/processStatus";
import { createKintoneCursorHandle } from "../api/kintoneCursor";
import { getCursorLeaseManager } from "../api/cursorLeaseManager";
import { CursorCreateOutcomeUnknownError } from "../core/errors/cursorErrors";
import { parseNumberPrecisionSettings } from "../core/numberPrecision";
import {
  InvalidJsonResponseError,
  KINTONE_METADATA_MAX_RESPONSE_BYTES,
  type KintoneMetadataReader,
  type RawMetadataResult,
  ResponseTooLargeError,
  mapKintoneMetadataRequest,
} from "../node/kintoneMetadata";

export class KintoneApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, bodyText: string) {
    super(`kintone API error ${status}: ${bodyText}`);
    this.name = "KintoneApiError";
  }
}

export interface TokenResolver {
  guestSpaceId?: number | null;
  timeoutMs?: number;
  cursorMaxActive?: number;
  debug?: boolean;
  debugHeaders?: boolean;
  log?: (line: string) => void;
  auth:
    | { type: "token"; resolveToken: (appId: number) => string }
    | { type: "userpass"; username: string; password: string };
}

const SEARCH_ABORTED_HEADER_VALUE = "Filter aborted because of too many search results";

interface JsonResponse<T> {
  body: T;
  searchAborted: boolean;
}

export interface NodeKintoneConnection {
  client: KintoneClient;
  metadataReader: KintoneMetadataReader;
}

export function createNodeKintoneConnection(
  baseUrl: string,
  tokenResolver: TokenResolver
): NodeKintoneConnection {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const apiBasePath = tokenResolver.guestSpaceId && tokenResolver.guestSpaceId > 0
    ? `/k/guest/${tokenResolver.guestSpaceId}/v1`
    : "/k/v1";

  async function requestResponse(
    path: string,
    init: RequestInit,
    appIdForToken: number
  ): Promise<{ response: Response; searchAborted: boolean }> {
    const headers = new Headers(init.headers ?? {});
    if (tokenResolver.auth.type === "token") {
      headers.set("X-Cybozu-API-Token", tokenResolver.auth.resolveToken(appIdForToken));
    } else {
      const credentials = `${tokenResolver.auth.username}:${tokenResolver.auth.password}`;
      const encoded = Buffer.from(credentials, "utf-8").toString("base64");
      headers.set("X-Cybozu-Authorization", encoded);
    }
    headers.set("Accept", "application/json");
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      headers.set("Content-Type", "application/json");
    }

    const timeoutMs = tokenResolver.timeoutMs ?? 30000;
    const url = `${normalizedBaseUrl}${path}`;
    if (tokenResolver.debug) {
      tokenResolver.log?.(`[debug] request ${String(init.method ?? "GET")} ${url}`);
      if (tokenResolver.debugHeaders) {
        const authHeader = headers.get("X-Cybozu-API-Token")
          ? "X-Cybozu-API-Token=***"
          : headers.get("X-Cybozu-Authorization")
            ? "X-Cybozu-Authorization=***"
            : "Auth=(none)";
        tokenResolver.log?.(
          `[debug] request-headers ${authHeader} Content-Type=${headers.get("Content-Type") ?? "(none)"} Accept=${headers.get("Accept") ?? "(none)"}`
        );
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // CLI/MCP worker の終了をタイムアウト期限まで阻害しない。
    timeout.unref?.();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const bodyText = await res.text();
      if (tokenResolver.debug) {
        tokenResolver.log?.(`[debug] response status=${res.status} body=${bodyText}`);
      }
      let code: string | undefined;
      try {
        const body = JSON.parse(bodyText) as { code?: unknown };
        if (typeof body.code === "string") code = body.code;
      } catch { /* non-JSON error body */ }
      throw new KintoneApiError(res.status, code, bodyText);
    }
    if (tokenResolver.debug) {
      tokenResolver.log?.(`[debug] response status=${res.status}`);
    }
    const warning = res.headers.get("X-Cybozu-Warning") ?? "";
    return {
      response: res,
      searchAborted: warning.includes(SEARCH_ABORTED_HEADER_VALUE),
    };
  }

  async function requestJsonResponse<T>(
    path: string,
    init: RequestInit,
    appIdForToken: number
  ): Promise<JsonResponse<T>> {
    const { response, searchAborted } = await requestResponse(path, init, appIdForToken);
    return {
      body: await response.json() as T,
      searchAborted,
    };
  }

  async function requestJson<T>(
    path: string,
    init: RequestInit,
    appIdForToken: number
  ): Promise<T> {
    return (await requestJsonResponse<T>(path, init, appIdForToken)).body;
  }

  async function requestCappedMetadataJson(
    path: string,
    init: { method: "GET" },
    appIdForToken: number
  ): Promise<{ data: Record<string, unknown>; responseBytes: number }> {
    const { response } = await requestResponse(path, init, appIdForToken);
    const contentLength = response.headers.get("Content-Length");
    if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
      const declaredBytes = Number(contentLength);
      if (declaredBytes > KINTONE_METADATA_MAX_RESPONSE_BYTES) {
        try {
          await response.body?.cancel();
        } catch { /* cancellation failure must not mask the deterministic size error */ }
        throw new ResponseTooLargeError(KINTONE_METADATA_MAX_RESPONSE_BYTES, declaredBytes);
      }
    }

    const chunks: Uint8Array[] = [];
    let responseBytes = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > KINTONE_METADATA_MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch { /* cancellation failure must not mask the deterministic size error */ }
          throw new ResponseTooLargeError(KINTONE_METADATA_MAX_RESPONSE_BYTES, responseBytes);
        }
        chunks.push(value);
      }
    }

    const bytes = new Uint8Array(responseBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch (cause) {
      throw new InvalidJsonResponseError(cause);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new InvalidJsonResponseError();
    }
    return { data: data as Record<string, unknown>, responseBytes };
  }

  function shouldRetryWithRecordNumberOrder(path: string, bodyText: string): boolean {
    if (!path.includes("/v1/records.json?")) return false;
    if (!bodyText.includes("\"code\":\"CB_IL02\"")) return false;
    const queryPart = path.split("query=")[1] ?? "";
    const query = decodeURIComponent(queryPart.split("&")[0] ?? "");
    if (!query.includes("limit")) return false;
    if (!query.includes("offset")) return false;
    if (query.toLowerCase().includes("order by")) return false;
    return true;
  }

  function rewriteQueryWithRecordNumberOrder(path: string): string {
    const [base, rest] = path.split("query=");
    if (!rest) return path;
    const [encodedQuery, ...tail] = rest.split("&");
    const query = decodeURIComponent(encodedQuery ?? "");
    const rewritten = `order by レコード番号 asc ${query}`.trim();
    const nextQuery = encodeURIComponent(rewritten);
    return `${base}query=${nextQuery}${tail.length > 0 ? `&${tail.join("&")}` : ""}`;
  }

  const client: KintoneClient = {
    async getRecords(params: PageFetchParams) {
      const queryPart = `query=${encodeURIComponent(params.query)}`;
      const appPart = `app=${encodeURIComponent(String(params.app))}`;
      const fieldParts = params.fields.map((f) => `fields[]=${encodeURIComponent(f)}`);
      const qs = [appPart, queryPart, ...fieldParts].join("&");
      if (tokenResolver.debug) {
        tokenResolver.log?.(
          `[debug] getRecords app=${params.app} query="${params.query}" fields=${params.fields.length > 0 ? params.fields.join(",") : "(all)"} auth=${tokenResolver.auth.type}`
        );
      }
      const path = `${apiBasePath}/records.json?${qs}`;
      try {
        const response = await requestJsonResponse<{ records: Record<string, { value: string }>[] }>(
          path,
          { method: "GET" },
          params.app
        );
        return response.searchAborted
          ? { ...response.body, searchAborted: true }
          : response.body;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!shouldRetryWithRecordNumberOrder(path, msg)) throw err;
        const retryPath = rewriteQueryWithRecordNumberOrder(path);
        if (tokenResolver.debug) {
          tokenResolver.log?.("[debug] retry with fallback query order by レコード番号 asc");
        }
        const response = await requestJsonResponse<{ records: Record<string, { value: string }>[] }>(
          retryPath,
          { method: "GET" },
          params.app
        );
        return response.searchAborted
          ? { ...response.body, searchAborted: true }
          : response.body;
      }
    },

    async openCursor(params) {
      const manager = getCursorLeaseManager(new URL(normalizedBaseUrl).host, tokenResolver.cursorMaxActive);
      const lease = await manager.acquire();
      let created: { id: string; totalCount: string };
      try {
        created = await manager.runCreate(() => requestJson<{ id: string; totalCount: string }>(
          `${apiBasePath}/records/cursor.json`,
          {
            method: "POST",
            body: JSON.stringify({
              app: params.app,
              query: params.query,
              size: params.size,
              fields: params.fields && params.fields.length > 0 ? params.fields : undefined,
            }),
          },
          params.app
        ));
      } catch (error) {
        if (error instanceof KintoneApiError) {
          lease.release();
          throw error;
        }
        lease.quarantine();
        throw new CursorCreateOutcomeUnknownError(error);
      }
      const cursorId = created.id;
      return createKintoneCursorHandle(Number(created.totalCount), {
        get: () => requestJson(
          `${apiBasePath}/records/cursor.json?id=${encodeURIComponent(cursorId)}`,
          { method: "GET" },
          params.app
        ),
        delete: () => requestJson(
          `${apiBasePath}/records/cursor.json`,
          { method: "DELETE", body: JSON.stringify({ id: cursorId }) },
          params.app
        ),
        onReleased: () => lease.release(),
        onReleaseUnknown: () => lease.quarantine(),
      });
    },

    async postRecords(_params: KintonePostParams) {
      const res = await requestJson<{ ids: string[] }>(
        `${apiBasePath}/records.json`,
        {
          method: "POST",
          body: JSON.stringify({
            app: _params.app,
            records: _params.records,
          }),
        },
        _params.app
      );
      return { ids: res.ids };
    },

    async putRecords(_params: KintonePutParams) {
      await requestJson<unknown>(
        `${apiBasePath}/records.json`,
        {
          method: "PUT",
          body: JSON.stringify({
            app: _params.app,
            records: _params.records,
          }),
        },
        _params.app
      );
    },

    async deleteRecords(_params: KintoneDeleteParams) {
      await requestJson<unknown>(
        `${apiBasePath}/records.json`,
        {
          method: "DELETE",
          body: JSON.stringify({
            app: _params.app,
            ids: _params.ids,
          }),
        },
        _params.app
      );
    },

    async getApps(): Promise<KintoneAppInfo[]> {
      const PAGE = 100;
      const all: KintoneAppInfo[] = [];
      let offset = 0;
      while (true) {
        const qs = new URLSearchParams();
        qs.set("limit", String(PAGE));
        qs.set("offset", String(offset));
        const res = await requestJson<{ apps: { appId: string; name: string; description: string }[] }>(
          `${apiBasePath}/apps.json?${qs.toString()}`,
          { method: "GET" },
          0
        );
        for (const app of res.apps) {
          all.push({
            appId: Number(app.appId),
            name: app.name,
            description: app.description,
          });
        }
        if (res.apps.length < PAGE) break;
        offset += PAGE;
      }
      return all;
    },

    async getFields(appId: number): Promise<KintoneFieldInfo[]> {
      const qs = new URLSearchParams();
      qs.set("app", String(appId));
      const res = await requestJson<{ properties: Record<string, FormFieldProperty> }>(
        `${apiBasePath}/app/form/fields.json?${qs.toString()}`,
        { method: "GET" },
        appId
      );

      return flattenFormFieldProperties(res.properties);
    },

    async getNumberPrecision(appId: number) {
      const qs = new URLSearchParams();
      qs.set("app", String(appId));
      const res = await requestJson<Parameters<typeof parseNumberPrecisionSettings>[0]>(
        `${apiBasePath}/app/settings.json?${qs.toString()}`,
        { method: "GET" },
        appId
      );
      return parseNumberPrecisionSettings(res);
    },

    async getProcessStatuses(appId: number): Promise<KintoneProcessStatuses> {
      const qs = new URLSearchParams();
      qs.set("app", String(appId));
      qs.set("lang", "user");
      const res = await requestJson<{
        enable: boolean;
        states: Record<string, RawProcessStatusState> | null;
      }>(`${apiBasePath}/app/status.json?${qs.toString()}`, { method: "GET" }, appId);
      return {
        enable: res.enable,
        states: normalizeProcessStatusStates(res.states),
      };
    },
  };

  const metadataReader: KintoneMetadataReader = {
    async getMetadata(request, resolvedAppId): Promise<RawMetadataResult> {
      const plan = mapKintoneMetadataRequest(
        request,
        resolvedAppId,
        apiBasePath,
        tokenResolver.auth.type
      );
      const query = plan.params.toString();
      const { data, responseBytes } = await requestCappedMetadataJson(
        `${plan.path}${query.length > 0 ? `?${query}` : ""}`,
        { method: "GET" },
        resolvedAppId
      );
      return {
        resource: plan.resource,
        environment: plan.environment,
        path: plan.path,
        params: Object.fromEntries(plan.params.entries()),
        responseBytes,
        data,
      };
    },
  };

  return { client, metadataReader };
}

export function createNodeKintoneClient(
  baseUrl: string,
  tokenResolver: TokenResolver
): KintoneClient {
  return createNodeKintoneConnection(baseUrl, tokenResolver).client;
}
