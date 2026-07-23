import {
  createReadonlyKintoneClient,
  explainQuery,
  KsqlEngineError,
  runQuery,
  version,
} from "./index";

type EnginePublicApi = {
  readonly version: typeof version;
  readonly createReadonlyKintoneClient: typeof createReadonlyKintoneClient;
  readonly explainQuery: typeof explainQuery;
  readonly KsqlEngineError: typeof KsqlEngineError;
  readonly runQuery: typeof runQuery;
};

type EngineRegistry = {
  readonly versions: Record<string, EnginePublicApi>;
  get(requestedVersion: string): EnginePublicApi | undefined;
};

declare global {
  interface Window {
    ksql?: EngineRegistry;
  }
}

const publicApi: EnginePublicApi = Object.freeze({
  version,
  createReadonlyKintoneClient,
  explainQuery,
  KsqlEngineError,
  runQuery,
});

function createRegistry(): EngineRegistry {
  const versions: Record<string, EnginePublicApi> = Object.create(null);
  return Object.freeze({
    versions,
    get(requestedVersion: string) {
      return versions[requestedVersion];
    },
  });
}

function isRegistry(value: unknown): value is EngineRegistry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<EngineRegistry>;
  return (
    candidate.versions !== null &&
    typeof candidate.versions === "object" &&
    typeof candidate.get === "function"
  );
}

const registry = window.ksql ?? createRegistry();
if (window.ksql === undefined) window.ksql = registry;
if (isRegistry(registry) && registry.versions[version] === undefined) {
  registry.versions[version] = publicApi;
}
