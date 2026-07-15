// ============================================================
// kintoneClient — kintone.api() を KintoneClient に変換するアダプター
// ============================================================

import type {
  KintoneClient,
  KintoneAppInfo,
  KintoneFieldInfo,
  KintonePostParams,
  KintonePutParams,
  KintoneDeleteParams,
  PageFetchParams,
} from "../core";
import {
  flattenFormFieldProperties,
  type FormFieldProperty,
} from "../core/formFieldInfo";

type KintoneApiWithUrl = typeof kintone.api & { url(path: string, guest: boolean): string };
const apiUrl = (path: string) => (kintone.api as KintoneApiWithUrl).url(path, true);

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
  if (e instanceof Error || e === null || typeof e !== "object") return e;
  const obj = e as { code?: unknown; message?: unknown; errors?: unknown };
  if (typeof obj.message !== "string" || obj.message === "") return e;

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

export function createKintoneClient(): KintoneClient {
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
  };
}
