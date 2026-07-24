import type { ReadonlyKintoneClient } from "../publicTypes";
import { projectReadonlyClient } from "../readonlyClient";

const READ_METHODS = [
  "getRecords",
  "openCursor",
  "getApps",
  "getFields",
  "getNumberPrecision",
  "getProcessStatuses",
] as const;
const WRITE_METHODS = ["postRecords", "putRecords", "deleteRecords"] as const;

class ByoClient implements ReadonlyKintoneClient {
  prototypeExtra = "instance extra";

  async getRecords() { return { records: [] }; }
  async openCursor() {
    return {
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    };
  }
  async getApps() { return []; }
  async getFields() { return []; }
  async getNumberPrecision() {
    return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
  }
  async getProcessStatuses() { return { enable: false, states: [] }; }
  async postRecords() { throw new Error("must not be copied"); }
}

test.each([
  ["plain BYO object", {
    getRecords: async () => ({ records: [] }),
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => [],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN" as const,
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    postRecords: async () => ({ ids: [] }),
    putRecords: async () => undefined,
    deleteRecords: async () => undefined,
    extra: true,
  }],
  ["prototype-based BYO client", new ByoClient()],
] as const)("%s is projected to only six read methods", (_label, byo) => {
  const projected = projectReadonlyClient(byo);

  expect(Reflect.ownKeys(projected).sort()).toEqual([...READ_METHODS].sort());
  expect(Object.getPrototypeOf(projected)).toBeNull();
  for (const method of WRITE_METHODS) {
    expect(method in projected).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projected, method)).toBe(false);
    expect(Reflect.getOwnPropertyDescriptor(projected, method)).toBeUndefined();
    expect(Reflect.ownKeys(projected)).not.toContain(method);
    expect(Object.getPrototypeOf(projected)?.[method]).toBeUndefined();
  }
  expect("extra" in projected).toBe(false);
  expect("prototypeExtra" in projected).toBe(false);
});

test("extra symbols and getters are neither copied nor evaluated", () => {
  const extraSymbol = Symbol("extra");
  let getterCalls = 0;
  const byo = new ByoClient() as ByoClient & Record<PropertyKey, unknown>;
  Object.defineProperty(byo, "dangerousGetter", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "secret";
    },
  });
  byo[extraSymbol] = "symbol value";

  const projected = projectReadonlyClient(byo);

  expect(getterCalls).toBe(0);
  expect(Reflect.ownKeys(projected)).not.toContain("dangerousGetter");
  expect(Reflect.ownKeys(projected)).not.toContain(extraSymbol);
  expect(Reflect.get(projected, extraSymbol)).toBeUndefined();
  expect(getterCalls).toBe(0);
});

test("read methods retain their BYO this binding", async () => {
  const byo = new ByoClient();
  const getApps = jest.spyOn(byo, "getApps");
  const projected = projectReadonlyClient(byo);

  await projected.getApps();

  expect(getApps).toHaveBeenCalledTimes(1);
});
