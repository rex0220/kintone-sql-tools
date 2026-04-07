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

type KintoneApiWithUrl = typeof kintone.api & { url(path: string, guest: boolean): string };
const apiUrl = (path: string) => (kintone.api as KintoneApiWithUrl).url(path, true);

export function createKintoneClient(): KintoneClient {
  return {
    async getRecords(params: PageFetchParams) {
      const res = await kintone.api(apiUrl("/k/v1/records.json"), "GET", {
        app:    params.app,
        query:  params.query,
        fields: params.fields.length > 0 ? params.fields : undefined,
      }) as { records: Record<string, { value: string }>[] };
      return { records: res.records };
    },

    async postRecords(params: KintonePostParams) {
      const res = await kintone.api(apiUrl("/k/v1/records.json"), "POST", {
        app:     params.app,
        records: params.records,
      }) as { ids: string[] };
      return { ids: res.ids };
    },

    async putRecords(params: KintonePutParams) {
      await kintone.api(apiUrl("/k/v1/records.json"), "PUT", {
        app:     params.app,
        records: params.records,
      });
    },

    async deleteRecords(params: KintoneDeleteParams) {
      await kintone.api(apiUrl("/k/v1/records.json"), "DELETE", {
        app: params.app,
        ids: params.ids,
      });
    },

    async getApps(): Promise<KintoneAppInfo[]> {
      const PAGE = 100;
      const all: KintoneAppInfo[] = [];
      let offset = 0;
      while (true) {
        const res = await kintone.api(apiUrl("/k/v1/apps.json"), "GET", {
          limit:  PAGE,
          offset,
        }) as { apps: { appId: string; name: string; description: string }[] };
        for (const a of res.apps) {
          all.push({ appId: Number(a.appId), name: a.name, description: a.description });
        }
        if (res.apps.length < PAGE) break;
        offset += PAGE;
      }
      return all;
    },

    async getFields(appId: number): Promise<KintoneFieldInfo[]> {
      const res = await kintone.api(apiUrl("/k/v1/app/form/fields.json"), "GET", {
        app: appId,
      }) as {
        properties: Record<string, {
          code: string;
          label: string;
          type: string;
          format?: string;
          options?: Record<string, { index?: string | number }>;
        }>;
      };
      return Object.values(res.properties).map((f) => ({
        code:      f.code,
        label:     f.label,
        fieldType: f.type,
        optionOrder: toOptionOrderMap(f.options),
        sortKind: detectSortKind(f.type, f.format),
      }));
    },
  };
}

function toOptionOrderMap(
  options?: Record<string, { index?: string | number }>
): Record<string, number> | undefined {
  if (!options || typeof options !== "object") return undefined;
  const order: Record<string, number> = {};
  let hasAny = false;
  for (const [label, meta] of Object.entries(options)) {
    const n = Number(meta?.index);
    if (!Number.isFinite(n)) continue;
    order[label] = n;
    hasAny = true;
  }
  return hasAny ? order : undefined;
}

function detectSortKind(
  fieldType: string,
  calcFormat?: string
): "number" | "string" | undefined {
  if (fieldType === "NUMBER" || fieldType === "RECORD_NUMBER") return "number";
  if (fieldType === "CALC") {
    if (calcFormat === "NUMBER" || calcFormat === "NUMBER_DIGIT") return "number";
    return "string";
  }
  return undefined;
}
