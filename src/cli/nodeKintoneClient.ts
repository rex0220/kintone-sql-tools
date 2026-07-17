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

export interface TokenResolver {
  guestSpaceId?: number | null;
  timeoutMs?: number;
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

export function createNodeKintoneClient(
  baseUrl: string,
  tokenResolver: TokenResolver
): KintoneClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const apiBasePath = tokenResolver.guestSpaceId && tokenResolver.guestSpaceId > 0
    ? `/k/guest/${tokenResolver.guestSpaceId}/v1`
    : "/k/v1";

  async function requestJsonResponse<T>(
    path: string,
    init: RequestInit,
    appIdForToken: number
  ): Promise<JsonResponse<T>> {
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
      throw new Error(`kintone API error ${res.status}: ${bodyText}`);
    }
    if (tokenResolver.debug) {
      tokenResolver.log?.(`[debug] response status=${res.status}`);
    }
    const warning = res.headers.get("X-Cybozu-Warning") ?? "";
    return {
      body: await res.json() as T,
      searchAborted: warning.includes(SEARCH_ABORTED_HEADER_VALUE),
    };
  }

  async function requestJson<T>(
    path: string,
    init: RequestInit,
    appIdForToken: number
  ): Promise<T> {
    return (await requestJsonResponse<T>(path, init, appIdForToken)).body;
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

  return {
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
}
