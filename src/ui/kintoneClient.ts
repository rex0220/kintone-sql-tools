// ============================================================
// kintoneClient — kintone.api() を KintoneClient に変換するアダプター
// ============================================================

import type {
  KintoneClient,
  KintoneAppInfo,
  KintoneFieldInfo,
  KintonePostParams,
  KintoneProcessStatuses,
  KintonePutParams,
  KintoneDeleteParams,
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
import { installCursorPageLifecycle, registerCursorHandle } from "./cursorPageLifecycle";
import { parseNumberPrecisionSettings } from "../core/numberPrecision";

type KintoneApiWithUrl = typeof kintone.api & { url(path: string, guest: boolean): string };
const apiUrl = (path: string) => (kintone.api as KintoneApiWithUrl).url(path, true);

/** pluginのkintone.api rejectはHTTP statusを公開しないため、このsurfaceだけcode単独を許可する。 */
export function isPluginAlreadyReleasedCursorError(error: unknown): boolean {
  const shaped = error as { status?: unknown; code?: unknown } | null;
  return shaped?.code === "GAIA_CN01"
    && (shaped.status === 404 || shaped.status === undefined);
}

/**
 * kintone.api() の reject（{code, id, message, errors} 形式のプレーンオブジェクト）を、
 * フィールド単位の詳細（errors）を message に畳み込んだ Error に変換する。
 *
 * バッチ実行では BatchStatementError が code / message しか運ばないため、
 * ここで畳み込まないと「[2] 入力内容が正しくありません。」のような
 * 汎用メッセージだけになり原因が特定できない（実機検証で発覚）。
 * CLI の nodeKintoneClient が response body 全文を message に入れるのと同方針。
 */
export function toDetailedApiError(e: unknown): unknown {
  const shaped = e as { message?: unknown } | null;
  if (e instanceof Error && e.message.trim() !== "") return e;
  if (shaped === null || typeof shaped !== "object"
    || typeof shaped.message !== "string" || shaped.message.trim() === "") {
    const err = new Error("ネットワークエラー: kintone からの応答がありません（オフライン・通信遮断の可能性）");
    Object.assign(err, { cause: e });
    return err;
  }
  const obj = shaped as { code?: unknown; message: string; errors?: unknown; status?: unknown };

  const lines: string[] = [];
  lines.push(
    typeof obj.code === "string" && obj.code !== ""
      ? `${obj.message}（${obj.code}）`
      : obj.message
  );
  if (obj.errors !== null && typeof obj.errors === "object") {
    for (const [key, detail] of Object.entries(obj.errors as Record<string, { messages?: unknown }>)) {
      const msgs = Array.isArray(detail?.messages)
        ? detail.messages.filter((m): m is string => typeof m === "string")
        : [];
      if (msgs.length > 0) lines.push(`${key}: ${msgs.join(" / ")}`);
    }
  }

  const err = new Error(lines.join("\n"));
  // BatchStatementError.code に kintone のエラーコード（CB_VA01 等）を通す
  if (typeof obj.code === "string" && obj.code !== "") err.name = obj.code;
  if (typeof obj.code === "string") Object.assign(err, { code: obj.code });
  if (typeof obj.status === "number") Object.assign(err, { status: obj.status });
  Object.assign(err, { cause: e });
  return err;
}

/** kintone.api() を呼び、reject を詳細込みの Error に変換して投げ直す */
async function api<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  params: Record<string, unknown>
): Promise<T> {
  try {
    return await kintone.api(apiUrl(path), method, params) as T;
  } catch (e) {
    throw toDetailedApiError(e);
  }
}

export function createKintoneClient(options: { cursorMaxActive?: number } = {}): KintoneClient {
  if (typeof window !== "undefined") installCursorPageLifecycle(window);
  return {
    async getRecords(params: PageFetchParams) {
      const res = await api<{ records: Record<string, { value: string }>[] }>(
        "/k/v1/records.json", "GET", {
          app:    params.app,
          query:  params.query,
          fields: params.fields.length > 0 ? params.fields : undefined,
        }
      );
      return { records: res.records };
    },

    async openCursor(params) {
      const cursorUrl = apiUrl("/k/v1/records/cursor.json");
      const host = new URL(cursorUrl, globalThis.location?.href).host;
      const manager = getCursorLeaseManager(host, options.cursorMaxActive);
      const lease = await manager.acquire();
      let created: { id: string; totalCount: string };
      try {
        created = await manager.runCreate(() => api<{ id: string; totalCount: string }>(
          "/k/v1/records/cursor.json", "POST", {
            app: params.app,
            query: params.query,
            size: params.size,
            fields: params.fields && params.fields.length > 0 ? params.fields : undefined,
          }
        ));
      } catch (error) {
        if (typeof (error as { code?: unknown } | null)?.code === "string") {
          lease.release();
          throw error;
        }
        lease.quarantine();
        throw new CursorCreateOutcomeUnknownError(error);
      }
      const cursorId = created.id;
      return registerCursorHandle(createKintoneCursorHandle(Number(created.totalCount), {
        get: () => api("/k/v1/records/cursor.json", "GET", { id: cursorId }),
        delete: () => api("/k/v1/records/cursor.json", "DELETE", { id: cursorId }),
        isAlreadyReleasedError: isPluginAlreadyReleasedCursorError,
        onReleased: () => lease.release(),
        onReleaseUnknown: () => lease.quarantine(),
      }));
    },

    async postRecords(params: KintonePostParams) {
      const res = await api<{ ids: string[] }>("/k/v1/records.json", "POST", {
        app:     params.app,
        records: params.records,
      });
      return { ids: res.ids };
    },

    async putRecords(params: KintonePutParams) {
      await api("/k/v1/records.json", "PUT", {
        app:     params.app,
        records: params.records,
      });
    },

    async deleteRecords(params: KintoneDeleteParams) {
      await api("/k/v1/records.json", "DELETE", {
        app: params.app,
        ids: params.ids,
      });
    },

    async getApps(): Promise<KintoneAppInfo[]> {
      const PAGE = 100;
      const all: KintoneAppInfo[] = [];
      let offset = 0;
      while (true) {
        const res = await api<{ apps: { appId: string; name: string; description: string }[] }>(
          "/k/v1/apps.json", "GET", { limit: PAGE, offset }
        );
        for (const a of res.apps) {
          all.push({ appId: Number(a.appId), name: a.name, description: a.description });
        }
        if (res.apps.length < PAGE) break;
        offset += PAGE;
      }
      return all;
    },

    async getFields(appId: number): Promise<KintoneFieldInfo[]> {
      const res = await api<{ properties: Record<string, FormFieldProperty> }>("/k/v1/app/form/fields.json", "GET", {
        app: appId,
      });
      return flattenFormFieldProperties(res.properties);
    },

    async getNumberPrecision(appId: number) {
      const res = await api<Parameters<typeof parseNumberPrecisionSettings>[0]>(
        "/k/v1/app/settings.json", "GET", { app: appId }
      );
      return parseNumberPrecisionSettings(res);
    },

    async getProcessStatuses(appId: number): Promise<KintoneProcessStatuses> {
      const res = await api<{
        enable: boolean;
        states: Record<string, RawProcessStatusState> | null;
      }>("/k/v1/app/status.json", "GET", { app: appId, lang: "user" });
      return {
        enable: res.enable,
        states: normalizeProcessStatusStates(res.states),
      };
    },
  };
}
