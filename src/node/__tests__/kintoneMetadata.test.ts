import {
  ArgumentError,
  CapabilityError,
  KINTONE_METADATA_LANGS,
  KINTONE_METADATA_RESOURCES,
  mapKintoneMetadataRequest,
  type AllowedMetadataRequest,
} from "../kintoneMetadata";

const API_BASE_PATH = "/k/v1";
const APP_ID = 9007199254740991;

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, "fetch");
});

afterEach(() => {
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});

const productionCases = [
  ["app", "/k/v1/app.json", "id=9007199254740991"],
  ["fields", "/k/v1/app/form/fields.json", "app=9007199254740991"],
  ["layout", "/k/v1/app/form/layout.json", "app=9007199254740991"],
  ["settings", "/k/v1/app/settings.json", "app=9007199254740991"],
  ["status", "/k/v1/app/status.json", "app=9007199254740991"],
  ["views", "/k/v1/app/views.json", "app=9007199254740991"],
  ["reports", "/k/v1/app/reports.json", "app=9007199254740991"],
  ["customize", "/k/v1/app/customize.json", "app=9007199254740991"],
] as const;

test("production 8 resource は固定 path と resolved app query だけを生成する", () => {
  expect(KINTONE_METADATA_RESOURCES).toEqual(productionCases.map(([resource]) => resource));

  for (const [resource, path, query] of productionCases) {
    const plan = mapKintoneMetadataRequest(
      { resource } as AllowedMetadataRequest,
      APP_ID,
      API_BASE_PATH,
      "userpass"
    );
    expect(plan).toMatchObject({
      method: "GET",
      path,
      environment: "production",
      resource,
    });
    expect(plan.params).toBeInstanceOf(URLSearchParams);
    expect(plan.params.toString()).toBe(query);
  }
});

test("preview 対応7 resource は固定 /preview path、app は fail-closed", () => {
  for (const [resource, productionPath] of productionCases.filter(([resource]) => resource !== "app")) {
    const plan = mapKintoneMetadataRequest(
      { resource, preview: true } as AllowedMetadataRequest,
      123,
      API_BASE_PATH,
      "userpass"
    );
    expect(plan.path).toBe(productionPath.replace("/k/v1/", "/k/v1/preview/"));
    expect(plan.environment).toBe("preview");
  }

  expect(() => mapKintoneMetadataRequest(
    { resource: "app", preview: true } as unknown as AllowedMetadataRequest,
    123,
    API_BASE_PATH,
    "userpass"
  )).toThrow(ArgumentError);

  for (const preview of [undefined, false] as const) {
    const request = preview === undefined
      ? { resource: "app" as const }
      : { resource: "app" as const, preview };
    expect(mapKintoneMetadataRequest(request, 123, API_BASE_PATH, "userpass").path)
      .toBe("/k/v1/app.json");
  }
});

test("lang は公式5値かつ許可された5 resource だけで query 化する", () => {
  expect(KINTONE_METADATA_LANGS).toEqual(["default", "user", "ja", "en", "zh"]);
  for (const resource of ["fields", "settings", "status", "views", "reports"] as const) {
    for (const lang of KINTONE_METADATA_LANGS) {
      const plan = mapKintoneMetadataRequest({ resource, lang }, 123, API_BASE_PATH, "token");
      expect(plan.params.toString()).toBe(`app=123&lang=${lang}`);
    }
  }

  for (const resource of ["app", "layout", "customize"] as const) {
    expect(() => mapKintoneMetadataRequest(
      { resource, lang: "ja" } as unknown as AllowedMetadataRequest,
      123,
      API_BASE_PATH,
      "userpass"
    )).toThrow(`ArgumentError: parameter "lang" is not allowed for resource "${resource}".`);
  }
  for (const lang of ["JA", "fr", "", null, 1]) {
    expect(() => mapKintoneMetadataRequest(
      { resource: "fields", lang } as unknown as AllowedMetadataRequest,
      123,
      API_BASE_PATH,
      "token"
    )).toThrow(ArgumentError);
  }
});

test.each([
  "records", "record", "cursor", "apps", "acl", "space", "file", "api-schema",
  "unknown", "https://evil.example/k/v1/app.json", "//evil.example/path", "..", "fields%2f..%2frecords",
])("allowlist 外 resource %s は path 化できない", (resource) => {
  expect(() => mapKintoneMetadataRequest(
    { resource } as unknown as AllowedMetadataRequest,
    123,
    API_BASE_PATH,
    "token"
  )).toThrow(ArgumentError);
});

test("public request と plan に caller-controlled HTTP primitive や free-form query がない", () => {
  const plan = mapKintoneMetadataRequest({ resource: "fields", lang: "en" }, 123, API_BASE_PATH, "token");
  expect(Object.keys(plan).sort()).toEqual([
    "authCapability", "environment", "method", "params", "path", "resource",
  ]);
  expect(plan.method).toBe("GET");
  expect(plan.params.toString()).toBe("app=123&lang=en");

  for (const forbidden of ["url", "path", "endpoint", "method", "headers", "body", "query", "requestInit"]) {
    expect(() => mapKintoneMetadataRequest(
      { resource: "fields", [forbidden]: "caller-controlled" } as unknown as AllowedMetadataRequest,
      123,
      API_BASE_PATH,
      "token"
    )).toThrow(ArgumentError);
  }
});

test("auth capability は customize だけ userpass-only で token を plan 前に拒否する", () => {
  for (const resource of KINTONE_METADATA_RESOURCES) {
    const plan = mapKintoneMetadataRequest(
      { resource } as AllowedMetadataRequest,
      123,
      API_BASE_PATH,
      "userpass"
    );
    expect(plan.authCapability).toBe(resource === "customize" ? "userpass-only" : "token|userpass");
  }

  expect(() => mapKintoneMetadataRequest(
    { resource: "customize" },
    123,
    API_BASE_PATH,
    "token"
  )).toThrow(CapabilityError);
  expect(() => mapKintoneMetadataRequest(
    { resource: "customize" },
    123,
    API_BASE_PATH,
    "token"
  )).toThrow('CapabilityError: resource "customize" requires userpass authentication.');
});

test("resolved app ID と apiBasePath も fail-closed で検査する", () => {
  for (const appId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    expect(() => mapKintoneMetadataRequest({ resource: "app" }, appId, API_BASE_PATH, "token"))
      .toThrow(/positive safe integer/);
  }
  expect(mapKintoneMetadataRequest({ resource: "app" }, 123, "/k/guest/456/v1", "token").path)
    .toBe("/k/guest/456/v1/app.json");
  for (const apiBasePath of ["https://evil.example/k/v1", "//evil.example/k/v1", "/k/v1/../records", "/k/v1/"]) {
    expect(() => mapKintoneMetadataRequest({ resource: "app" }, 123, apiBasePath, "token"))
      .toThrow(ArgumentError);
  }
});
