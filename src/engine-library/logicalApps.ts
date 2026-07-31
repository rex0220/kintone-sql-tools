import {
  collectAppProfileTokens,
  normalizeSqlAppProfiles,
  type AppBinding,
} from "../core/logicalApps";
import type { KsqlEngineError } from "./errors";
import type { ReadonlyKintoneClient } from "./publicTypes";

export interface PreparedEngineSql {
  readonly sql: string;
  readonly client: ReadonlyKintoneClient;
  readonly logicalBindings: readonly Extract<AppBinding, { source: "logical" }>[];
}

function formatToken(sql: string, start: number, end: number): string {
  return sql.slice(start, end);
}

export function prepareEngineLogicalApps(
  sql: string,
  client: ReadonlyKintoneClient,
  logicalApps?: Readonly<Record<string, number>>
): PreparedEngineSql {
  const tokens = collectAppProfileTokens(sql);
  const profiled = tokens.find((token) => token.profile !== null);
  if (profiled !== undefined) {
    throw new Error(
      `ArgumentError: browser engine library does not support @profile suffixes (${formatToken(sql, profiled.start, profiled.fullEnd)}).`
    );
  }
  if (!tokens.some((token) => token.source === "logical")) {
    return { sql, client, logicalBindings: [] };
  }

  const normalized = normalizeSqlAppProfiles(sql, "browser", {
    resolveLogicalApp(name) {
      const appId = logicalApps?.[name];
      if (appId === undefined) {
        throw new Error(`ArgumentError: logical app LAPP_${name} is not defined.`);
      }
      return appId;
    },
  });
  const logicalBindings = [...normalized.appBindingByMappedApp.values()]
    .filter((binding): binding is Extract<AppBinding, { source: "logical" }> =>
      binding.source === "logical"
    );
  const mappedAppId = (appId: number): number =>
    normalized.appBindingByMappedApp.get(appId)?.appId ?? appId;
  const routedClient: ReadonlyKintoneClient = {
    getRecords: (params) => client.getRecords({ ...params, app: mappedAppId(params.app) }),
    openCursor: (params) => client.openCursor({ ...params, app: mappedAppId(params.app) }),
    getApps: () => client.getApps(),
    getFields: (appId) => client.getFields(mappedAppId(appId)),
    getNumberPrecision: (appId) => client.getNumberPrecision(mappedAppId(appId)),
    getProcessStatuses: (appId) => client.getProcessStatuses(mappedAppId(appId)),
  };
  return { sql: normalized.normalizedSql, client: routedClient, logicalBindings };
}

export function appendLogicalAppDiagnostics(
  error: KsqlEngineError,
  bindings: readonly Extract<AppBinding, { source: "logical" }>[]
): KsqlEngineError {
  if (bindings.length === 0) return error;
  const mappings = bindings
    .map((binding) => `LAPP_${binding.logicalName} -> APP${binding.appId}`)
    .filter((value, index, values) => values.indexOf(value) === index);
  error.message = `${error.message} [logical apps: ${mappings.join(", ")}]`;
  return error;
}
