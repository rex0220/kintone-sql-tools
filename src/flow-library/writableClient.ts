import { CursorLeaseManager } from "../api/cursorLeaseManager";
import { createKintoneCursorHandle } from "../api/kintoneCursor";
import { CursorCreateOutcomeUnknownError } from "../core/errors/cursorErrors";
import {
  flattenFormFieldProperties,
  type FormFieldProperty,
} from "../core/formFieldInfo";
import { parseNumberPrecisionSettings } from "../core/numberPrecision";
import {
  normalizeProcessStatusStates,
  type RawProcessStatusState,
} from "../core/processStatus";
import {
  buildAppOptionNameMap,
  optionNameSourceFrom,
  STATUS_FIELD_TYPE,
  type OptionNameSource as KintoneOptionNameSource,
  type RawLocalizedStatusStates,
} from "../core/optionNameMap";
import { mapRecordOptionValues } from "../core/recordOptionValues";
import { isSearchAbortedWarning } from "../core/searchAbortWarning";
import type {
  KintoneAppInfo,
  KintoneClient,
  KintoneFieldInfo,
  KintoneProcessStatuses,
} from "../execute";
import type {
  BundledKintoneClient,
  CreateKintoneClientConfig,
  NormalizableRecord,
  RecordNormalizer,
} from "./publicTypes";

class KintoneHttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = code ?? "KintoneHttpError";
  }
}

export function createKintoneClient(config: CreateKintoneClientConfig): BundledKintoneClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const apiBase = config.guestSpaceId === undefined
    ? "/k/v1"
    : `/k/guest/${positiveInteger(config.guestSpaceId, "guestSpaceId")}/v1`;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required.");
  const cursorMaxActive = config.cursorMaxActive ?? 2;
  if (!Number.isSafeInteger(cursorMaxActive) || cursorMaxActive < 1 || cursorMaxActive > 5) {
    throw new RangeError("cursorMaxActive must be an integer from 1 to 5.");
  }
  const cursorManager = new CursorLeaseManager(new URL(baseUrl).host, {
    maxActive: cursorMaxActive,
  });

  async function request<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    appId: number,
    body?: unknown
  ): Promise<{ body: T; response: Response }> {
    const headers = new Headers({ Accept: "application/json" });
    if (config.auth.type === "apiToken") {
      const token = typeof config.auth.apiToken === "function"
        ? config.auth.apiToken(appId)
        : config.auth.apiToken;
      headers.set("X-Cybozu-API-Token", token);
    } else {
      headers.set(
        "X-Cybozu-Authorization",
        base64Utf8(`${config.auth.username}:${config.auth.password}`)
      );
    }
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
    timeout.unref?.();
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${apiBase}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const text = await response.text();
      let code: string | undefined;
      let message = `kintone API error: HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === "string") code = parsed.code;
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        if (text !== "") message = `${message}: ${text}`;
      }
      throw new KintoneHttpError(response.status, code, message);
    }
    return { body: await response.json() as T, response };
  }

  const client: KintoneClient = {
    async getRecords(params) {
      const query = new URLSearchParams({
        app: String(params.app),
        query: params.query,
      });
      params.fields.forEach((field) => query.append("fields[]", field));
      if (params.totalCount === true) query.set("totalCount", "true");
      const { body, response } = await request<{
        records: Record<string, { value: string }>[];
        totalCount?: string;
      }>(`/records.json?${query}`, "GET", params.app);
      return isSearchAbortedWarning(response.headers.get("X-Cybozu-Warning"))
        ? { ...body, searchAborted: true }
        : body;
    },

    async openCursor(params) {
      const lease = await cursorManager.acquire();
      let created: { id: string; totalCount: string };
      try {
        created = (await cursorManager.runCreate(() => request<{
          id: string;
          totalCount: string;
        }>("/records/cursor.json", "POST", params.app, {
          app: params.app,
          query: params.query,
          size: params.size,
          ...(params.fields && params.fields.length > 0 ? { fields: params.fields } : {}),
        }))).body;
      } catch (error) {
        if (error instanceof KintoneHttpError) lease.release();
        else lease.quarantine();
        if (error instanceof KintoneHttpError) throw error;
        throw new CursorCreateOutcomeUnknownError(error);
      }
      return createKintoneCursorHandle(Number(created.totalCount), {
        get: async () => (await request(`/records/cursor.json?id=${encodeURIComponent(created.id)}`, "GET", params.app)).body as never,
        delete: async () => {
          await request("/records/cursor.json", "DELETE", params.app, { id: created.id });
        },
        onReleased: () => lease.release(),
        onReleaseUnknown: () => lease.quarantine(),
      });
    },

    async postRecords(params) {
      const response = await request<{ ids: string[] }>("/records.json", "POST", params.app, params);
      return { ids: response.body.ids };
    },
    async putRecords(params) {
      await request("/records.json", "PUT", params.app, params);
    },
    async upsertRecords(params) {
      return (await request<import("./publicTypes").KintoneNativeUpsertResult>(
        "/records.json", "PUT", params.app,
        { app: params.app, upsert: true, records: params.records }
      )).body;
    },
    async deleteRecords(params) {
      await request("/records.json", "DELETE", params.app, params);
    },
    async getApps(): Promise<KintoneAppInfo[]> {
      const apps: KintoneAppInfo[] = [];
      for (let offset = 0; ; offset += 100) {
        const query = new URLSearchParams({ limit: "100", offset: String(offset) });
        const response = await request<{
          apps: Array<{ appId: string; name: string; description: string }>;
        }>(`/apps.json?${query}`, "GET", 0);
        apps.push(...response.body.apps.map((app) => ({
          appId: Number(app.appId),
          name: app.name,
          description: app.description,
        })));
        if (response.body.apps.length < 100) return apps;
      }
    },
    async getFields(appId: number): Promise<KintoneFieldInfo[]> {
      const response = await request<{ properties: Record<string, FormFieldProperty> }>(
        `/app/form/fields.json?app=${encodeURIComponent(String(appId))}`,
        "GET",
        appId
      );
      return flattenFormFieldProperties(response.body.properties);
    },
    async getNumberPrecision(appId: number) {
      const response = await request<Parameters<typeof parseNumberPrecisionSettings>[0]>(
        `/app/settings.json?app=${encodeURIComponent(String(appId))}`,
        "GET",
        appId
      );
      return parseNumberPrecisionSettings(response.body);
    },
    async getProcessStatuses(appId: number): Promise<KintoneProcessStatuses> {
      const response = await request<{
        enable: boolean;
        states: Record<string, RawProcessStatusState> | null;
      }>(`/app/status.json?app=${encodeURIComponent(String(appId))}&lang=user`, "GET", appId);
      return {
        enable: response.body.enable,
        states: normalizeProcessStatusStates(response.body.states),
      };
    },
    /** B205: 利用者の表示言語で見た選択肢とステータス（`optionNames: "canonical"` のときだけ呼ばれる）。 */
    async getOptionNames(appId: number): Promise<KintoneOptionNameSource> {
      const app = encodeURIComponent(String(appId));
      const [form, status] = await Promise.all([
        request<{ properties: Record<string, FormFieldProperty> }>(
          `/app/form/fields.json?app=${app}&lang=user`, "GET", appId
        ),
        request<RawLocalizedStatusStates>(`/app/status.json?app=${app}&lang=user`, "GET", appId),
      ]);
      return optionNameSourceFrom(
        appId, flattenFormFieldProperties(form.body.properties), status.body
      );
    },
  };

  /**
   * B206: 外のレコード（ブラウザーが持っているもの）を**既定の名称にそろえる**正規化器。
   *
   * `optionNames: "canonical"` が**読んだレコードに掛けているのと同じ関数**
   * （`buildAppOptionNameMap` ＋ `mapRecordOptionValues`）を、エンジンを通らないレコードにも使えるようにする。
   * 依頼元（kSQL アクション）の計算式は **kintone がブラウザーに渡したレコード**を評価するので、
   * SQL（既定の名称）と計算式（表示名）で規則が 2 つに割れていた。
   */
  const createRecordNormalizer = async (appId: number): Promise<RecordNormalizer> => {
    const [canonicalFields, source] = await Promise.all([
      client.getFields(appId),
      client.getOptionNames!(appId),
    ]);
    // 一意に決まらない対応表はここで ArgumentError（レコードを 1 件も触る前）
    const map = buildAppOptionNameMap(appId, canonicalFields, source);
    if (map.identity) return (<T extends NormalizableRecord>(record: T) => record) as RecordNormalizer;
    const normalize = <T extends NormalizableRecord>(record: T): T => {
      // ステータスは **type で見つける**（項目コードはアプリの言語で ステータス / Status と変わる）。
      // 1 項目だけのレコード（@_status の変換）でも当たる。
      const statusCode = map.status === undefined
        ? undefined
        : Object.keys(record).find((code) => record[code]?.type === STATUS_FIELD_TYPE);
      const translate = (fieldCode: string, value: string): string => {
        const names = fieldCode === statusCode && map.status !== undefined
          ? map.status
          : map.fields.get(fieldCode);
        return names?.toCanonical.get(value) ?? value;
      };
      return mapRecordOptionValues(record as never, translate) as never as T;
    };
    return normalize as RecordNormalizer;
  };

  return { ...client, createRecordNormalizer } as BundledKintoneClient;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("baseUrl must use http or https.");
  }
  return url.toString().replace(/\/+$/, "");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function base64Utf8(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new TextEncoder().encode(value);
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    result += alphabet[a >> 2];
    result += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    result += index + 1 < bytes.length ? alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)] : "=";
    result += index + 2 < bytes.length ? alphabet[c & 63] : "=";
  }
  return result;
}
