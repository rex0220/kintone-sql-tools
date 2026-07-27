export type EnginePublicApi = {
  readonly version: string;
  readonly createReadonlyKintoneClient: (...args: never[]) => unknown;
  readonly explainQuery: (...args: never[]) => unknown;
  readonly KsqlEngineError: unknown;
  readonly runBatch: (...args: never[]) => unknown;
  readonly runQuery: (...args: never[]) => unknown;
};

export type EngineRegistry = {
  readonly versions: Record<string, EnginePublicApi>;
  get(requestedVersion: string): EnginePublicApi | undefined;
};

type RegistryHost = {
  ksql?: unknown;
};

type RegistryConsole = Pick<Console, "error" | "warn">;

const hasOwn = (object: object, property: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(object, property);

export function createVersionRegistry(): EngineRegistry {
  const versions: Record<string, EnginePublicApi> = Object.create(null);
  return Object.freeze({
    versions,
    get(requestedVersion: string) {
      return hasOwn(versions, requestedVersion)
        ? versions[requestedVersion]
        : undefined;
    },
  });
}

export function isVersionRegistry(value: unknown): value is EngineRegistry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<EngineRegistry>;
  return (
    candidate.versions !== null &&
    typeof candidate.versions === "object" &&
    !Array.isArray(candidate.versions) &&
    typeof candidate.get === "function"
  );
}

/**
 * Register one immutable UMD public API without replacing any pre-existing
 * global, registry, or version entry. A non-registry collision is fail-closed.
 */
export function registerEngineVersion(
  host: RegistryHost,
  version: string,
  publicApi: EnginePublicApi,
  diagnostics: RegistryConsole = console
): EngineRegistry | undefined {
  let registry: EngineRegistry;
  if (host.ksql === undefined) {
    registry = createVersionRegistry();
    try {
      host.ksql = registry;
    } catch (cause) {
      diagnostics.error(
        `[kSQL engine ${version}] window.ksql registry could not be initialized; loading was aborted.`,
        cause
      );
      return undefined;
    }
  } else if (isVersionRegistry(host.ksql)) {
    registry = host.ksql;
  } else {
    diagnostics.error(
      `[kSQL engine ${version}] window.ksql already exists but is not a compatible { versions, get } registry; loading was aborted.`
    );
    return undefined;
  }

  if (hasOwn(registry.versions, version)) {
    diagnostics.warn(
      `[kSQL engine ${version}] this version is already registered; the first entry was kept.`
    );
    return registry;
  }

  const frozenPublicApi = Object.freeze(publicApi);
  try {
    registry.versions[version] = frozenPublicApi;
  } catch (cause) {
    diagnostics.error(
      `[kSQL engine ${version}] the compatible window.ksql registry rejected registration; loading was aborted.`,
      cause
    );
    return undefined;
  }
  return registry;
}
