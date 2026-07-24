import {
  createVersionRegistry,
  registerEngineVersion,
  type EnginePublicApi,
  type EngineRegistry,
} from "../versionRegistry";

function api(version: string, marker = version): EnginePublicApi {
  return {
    version,
    createReadonlyKintoneClient: (() => marker) as (...args: never[]) => unknown,
    explainQuery: (() => marker) as (...args: never[]) => unknown,
    KsqlEngineError: class extends Error {},
    runQuery: (() => marker) as (...args: never[]) => unknown,
  };
}

function diagnostics() {
  return {
    error: jest.fn(),
    warn: jest.fn(),
  };
}

test("window.ksql 不在時に exact-get registry を新規作成する", () => {
  const host: { ksql?: unknown } = {};
  const messages = diagnostics();
  const first = api("3.19.0");

  const registry = registerEngineVersion(host, "3.19.0", first, messages);

  expect(host.ksql).toBe(registry);
  expect(registry).toEqual(expect.objectContaining({
    versions: expect.any(Object),
    get: expect.any(Function),
  }));
  expect(registry?.get("3.19.0")).toBe(first);
  expect(registry?.get("3.19")).toBeUndefined();
  expect(registry?.get("v3.19.0")).toBeUndefined();
  expect(registry?.get("3.19.0 ")).toBeUndefined();
  expect(registry?.get("missing")).toBeUndefined();
  expect(Object.isFrozen(first)).toBe(true);
  expect(messages.error).not.toHaveBeenCalled();
  expect(messages.warn).not.toHaveBeenCalled();
});

test("既存の registry object と get function を上書きせず再利用する", () => {
  const registry = createVersionRegistry();
  const originalGet = registry.get;
  const host = { ksql: registry };
  const second = api("4.0.0");

  expect(registerEngineVersion(host, "4.0.0", second)).toBe(registry);
  expect(host.ksql).toBe(registry);
  expect(registry.get).toBe(originalGet);
  expect(registry.get("4.0.0")).toBe(second);
});

test.each([
  null,
  "other library",
  {},
  { versions: {} },
  { get: (): undefined => undefined },
  { versions: [], get: (): undefined => undefined },
])("非 registry の既存 window.ksql=%p は非上書きで fail-closed", (collision) => {
  const host = { ksql: collision };
  const messages = diagnostics();

  expect(
    registerEngineVersion(host, "3.19.0", api("3.19.0"), messages)
  ).toBeUndefined();
  expect(host.ksql).toBe(collision);
  expect(messages.error).toHaveBeenCalledTimes(1);
  expect(messages.warn).not.toHaveBeenCalled();
});

test("別 version は既存 entry を上書きせず両方を保持する", () => {
  const host: { ksql?: EngineRegistry } = {};
  const first = api("3.19.0", "first");
  const second = api("4.0.0", "second");

  registerEngineVersion(host, first.version, first);
  registerEngineVersion(host, second.version, second);

  expect(host.ksql?.versions["3.19.0"]).toBe(first);
  expect(host.ksql?.versions["4.0.0"]).toBe(second);
  expect(host.ksql?.get("3.19.0")).toBe(first);
  expect(host.ksql?.get("4.0.0")).toBe(second);
});

test("同一 version の重複 load は先着 entry を維持して warn 1回", () => {
  const host: { ksql?: EngineRegistry } = {};
  const first = api("3.19.0", "first");
  const later = api("3.19.0", "later");
  const messages = diagnostics();
  registerEngineVersion(host, first.version, first, messages);

  expect(
    registerEngineVersion(host, later.version, later, messages)
  ).toBe(host.ksql);
  expect(host.ksql?.versions["3.19.0"]).toBe(first);
  expect(host.ksql?.get("3.19.0")).toBe(first);
  expect(Object.isFrozen(later)).toBe(false);
  expect(messages.warn).toHaveBeenCalledTimes(1);
  expect(messages.error).not.toHaveBeenCalled();
});
