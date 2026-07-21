export const KINTONE_METADATA_RESOURCES = [
  "app",
  "fields",
  "layout",
  "settings",
  "status",
  "views",
  "reports",
  "customize",
] as const;

export const KINTONE_METADATA_LANGS = ["default", "user", "ja", "en", "zh"] as const;

export type KintoneMetadataResource = typeof KINTONE_METADATA_RESOURCES[number];
export type Lang = typeof KINTONE_METADATA_LANGS[number];
export type MetadataAuthType = "token" | "userpass";
export type MetadataAuthCapability = "token|userpass" | "userpass-only";
export type MetadataEnvironment = "production" | "preview";

type ProductionOnlyRequest = {
  resource: "app";
  preview?: false;
};

type RequestWithLang = {
  resource: "fields" | "settings" | "status" | "views" | "reports";
  preview?: boolean;
  lang?: Lang;
};

type RequestWithoutLang = {
  resource: "layout" | "customize";
  preview?: boolean;
};

/** Caller-selectable metadata fields. Deliberately contains no HTTP request primitives. */
export type AllowedMetadataRequest =
  | ProductionOnlyRequest
  | RequestWithLang
  | RequestWithoutLang;

export interface KintoneMetadataRequestPlan {
  method: "GET";
  path: string;
  params: URLSearchParams;
  environment: MetadataEnvironment;
  resource: KintoneMetadataResource;
  authCapability: MetadataAuthCapability;
}

export interface RawMetadataResult {
  resource: KintoneMetadataResource;
  environment: MetadataEnvironment;
  /** Allowlisted relative endpoint. It never contains the host or base URL. */
  path: string;
  /** Mapper-produced, normalized query values only. */
  params: Readonly<Record<string, string>>;
  responseBytes: number;
  /** Parsed kintone response, preserved without normalization. */
  data: Record<string, unknown>;
}

export interface KintoneMetadataReader {
  getMetadata(
    request: AllowedMetadataRequest,
    resolvedAppId: number
  ): Promise<RawMetadataResult>;
}

export const KINTONE_METADATA_MAX_RESPONSE_BYTES = 2_097_152;

export class ResponseTooLargeError extends Error {
  constructor(
    readonly maxBytes: number = KINTONE_METADATA_MAX_RESPONSE_BYTES,
    readonly responseBytes?: number
  ) {
    super(`ResponseTooLargeError: kintone metadata response exceeds ${maxBytes} bytes.`);
    this.name = "ResponseTooLargeError";
  }
}

export class InvalidJsonResponseError extends Error {
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    super("InvalidJsonResponseError: kintone metadata response is not valid JSON.");
    this.name = "InvalidJsonResponseError";
    this.cause = cause;
  }
}

export class ArgumentError extends Error {
  constructor(message: string) {
    super(`ArgumentError: ${message}`);
    this.name = "ArgumentError";
  }
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(`CapabilityError: ${message}`);
    this.name = "CapabilityError";
  }
}

interface ResourceDefinition {
  productionPath: string;
  previewPath?: string;
  appParameter: "id" | "app";
  allowsLang: boolean;
  authCapability: MetadataAuthCapability;
}

// This is the sole resource-to-endpoint allowlist. Callers never turn resource text into a path.
const RESOURCE_DEFINITIONS: Record<KintoneMetadataResource, ResourceDefinition> = {
  app: {
    productionPath: "/app.json",
    appParameter: "id",
    allowsLang: false,
    authCapability: "token|userpass",
  },
  fields: {
    productionPath: "/app/form/fields.json",
    previewPath: "/preview/app/form/fields.json",
    appParameter: "app",
    allowsLang: true,
    authCapability: "token|userpass",
  },
  layout: {
    productionPath: "/app/form/layout.json",
    previewPath: "/preview/app/form/layout.json",
    appParameter: "app",
    allowsLang: false,
    authCapability: "token|userpass",
  },
  settings: {
    productionPath: "/app/settings.json",
    previewPath: "/preview/app/settings.json",
    appParameter: "app",
    allowsLang: true,
    authCapability: "token|userpass",
  },
  status: {
    productionPath: "/app/status.json",
    previewPath: "/preview/app/status.json",
    appParameter: "app",
    allowsLang: true,
    authCapability: "token|userpass",
  },
  views: {
    productionPath: "/app/views.json",
    previewPath: "/preview/app/views.json",
    appParameter: "app",
    allowsLang: true,
    authCapability: "token|userpass",
  },
  reports: {
    productionPath: "/app/reports.json",
    previewPath: "/preview/app/reports.json",
    appParameter: "app",
    allowsLang: true,
    authCapability: "token|userpass",
  },
  customize: {
    productionPath: "/app/customize.json",
    previewPath: "/preview/app/customize.json",
    appParameter: "app",
    allowsLang: false,
    authCapability: "userpass-only",
  },
};

const RESOURCE_SET: ReadonlySet<string> = new Set(KINTONE_METADATA_RESOURCES);
const LANG_SET: ReadonlySet<string> = new Set(KINTONE_METADATA_LANGS);
const API_BASE_PATH_PATTERN = /^\/k\/(?:guest\/([1-9]\d*)\/)?v1$/;

function assertResolvedAppId(resolvedAppId: number): void {
  if (!Number.isSafeInteger(resolvedAppId) || resolvedAppId <= 0) {
    throw new ArgumentError("resolved app ID must be a positive safe integer.");
  }
}

function assertApiBasePath(apiBasePath: string): void {
  const match = API_BASE_PATH_PATTERN.exec(apiBasePath);
  if (!match) {
    throw new ArgumentError("apiBasePath must be /k/v1 or /k/guest/<positive safe integer>/v1.");
  }
  if (match[1] !== undefined) {
    const guestSpaceId = Number(match[1]);
    if (!Number.isSafeInteger(guestSpaceId) || guestSpaceId <= 0) {
      throw new ArgumentError("apiBasePath guest space ID must be a positive safe integer.");
    }
  }
}

function validateRequest(request: AllowedMetadataRequest): {
  resource: KintoneMetadataResource;
  preview: boolean;
  lang: Lang | undefined;
  definition: ResourceDefinition;
} {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new ArgumentError("metadata request must be an object.");
  }

  const candidate = request as unknown as Record<string, unknown>;
  const resource = candidate.resource;
  if (typeof resource !== "string" || !RESOURCE_SET.has(resource)) {
    throw new ArgumentError(`unsupported metadata resource: ${String(resource)}.`);
  }
  const typedResource = resource as KintoneMetadataResource;
  const definition = RESOURCE_DEFINITIONS[typedResource];

  const allowedKeys = definition.allowsLang
    ? new Set(["resource", "preview", "lang"])
    : new Set(["resource", "preview"]);
  const unexpectedKey = Object.keys(candidate).find((key) => !allowedKeys.has(key));
  if (unexpectedKey !== undefined) {
    throw new ArgumentError(`parameter "${unexpectedKey}" is not allowed for resource "${resource}".`);
  }

  if (candidate.preview !== undefined && typeof candidate.preview !== "boolean") {
    throw new ArgumentError("preview must be a boolean when specified.");
  }
  const preview = candidate.preview === true;
  if (preview && definition.previewPath === undefined) {
    throw new ArgumentError(`preview is not supported for resource "${resource}".`);
  }

  const rawLang = candidate.lang;
  if (rawLang !== undefined) {
    if (!definition.allowsLang) {
      throw new ArgumentError(`lang is not allowed for resource "${resource}".`);
    }
    if (typeof rawLang !== "string" || !LANG_SET.has(rawLang)) {
      throw new ArgumentError(`unsupported lang: ${String(rawLang)}.`);
    }
  }

  return {
    resource: typedResource,
    preview,
    lang: rawLang as Lang | undefined,
    definition,
  };
}

/**
 * Builds a fixed GET plan only. It performs no I/O and accepts no URL, method,
 * headers, body, RequestInit, or free-form query input.
 */
export function mapKintoneMetadataRequest(
  request: AllowedMetadataRequest,
  resolvedAppId: number,
  apiBasePath: string,
  authType: MetadataAuthType
): KintoneMetadataRequestPlan {
  assertResolvedAppId(resolvedAppId);
  assertApiBasePath(apiBasePath);
  if (authType !== "token" && authType !== "userpass") {
    throw new ArgumentError(`unsupported auth type: ${String(authType)}.`);
  }

  const { resource, preview, lang, definition } = validateRequest(request);
  if (definition.authCapability === "userpass-only" && authType === "token") {
    throw new CapabilityError(`resource "${resource}" requires userpass authentication.`);
  }

  const params = new URLSearchParams();
  params.set(definition.appParameter, String(resolvedAppId));
  if (lang !== undefined) params.set("lang", lang);

  const pathFragment = preview ? definition.previewPath : definition.productionPath;
  if (pathFragment === undefined) {
    // validateRequest rejects this branch; keep path construction fail-closed.
    throw new ArgumentError(`preview is not supported for resource "${resource}".`);
  }

  return {
    method: "GET",
    path: `${apiBasePath}${pathFragment}`,
    params,
    environment: preview ? "preview" : "production",
    resource,
    authCapability: definition.authCapability,
  };
}
