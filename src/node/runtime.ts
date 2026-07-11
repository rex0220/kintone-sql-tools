import type { KintoneClient } from "../core";
import { getGlobalRequestGate, withRequestGate } from "../api/requestGate";
import { createNodeKintoneClient } from "../cli/nodeKintoneClient";
import {
  buildCacheContext,
  extractAppIds,
  normalizeAppKey,
  normalizeSqlAppProfiles,
  parseTokenMap,
} from "./appProfiles";
import {
  envAuth,
  envInt,
  envOnLimit,
  envString,
  loadOptionalKsqlConfig,
  resolveRequestGateOptions,
  resolveTokenValue,
  type KsqlConfig,
  type OnLimitMode,
} from "./config";

export interface KsqlRuntimeServerOptions {
  configPath?: string;
  profile?: string;
}

export interface CreateKsqlRuntimeInput {
  sql: string;
  profile?: string;
  maxRecords?: number;
  fetchParallel?: number;
  onLimit?: OnLimitMode;
  timeout?: number;
  tempTableMaxRows?: number;
  debug?: boolean;
  debugHeaders?: boolean;
  log?: (line: string) => void;
}

export interface KsqlRuntime {
  sql: string;
  profileName: string;
  client: KintoneClient;
  cacheContext: string;
  maxRecords: number;
  fetchParallel: number;
  onLimit: OnLimitMode;
  timeout: number;
  /** 一時テーブル実体化上限。undefined = エンジン既定（TEMP_TABLE_MAX_ROWS = 10,000）に委ねる */
  tempTableMaxRows?: number;
}

export function resolveDefaultProfile(
  config: KsqlConfig,
  serverOptions: KsqlRuntimeServerOptions,
  inputProfile?: string
): string {
  return inputProfile
    ?? serverOptions.profile
    ?? envString("KSQL_PROFILE")
    ?? config.defaultProfile
    ?? "dev";
}

export async function createKsqlRuntime(
  serverOptions: KsqlRuntimeServerOptions,
  input: CreateKsqlRuntimeInput
): Promise<KsqlRuntime> {
  const configPath = serverOptions.configPath ?? envString("KSQL_CONFIG") ?? "./ksql.config.json";
  const config = loadOptionalKsqlConfig(configPath);
  const profileName = resolveDefaultProfile(config, serverOptions, input.profile);
  const profile = config.profiles?.[profileName] ?? {};

  const normalized = normalizeSqlAppProfiles(input.sql, profileName);
  const sql = normalized.normalizedSql;
  const maxRecords = input.maxRecords
    ?? envInt("KSQL_MAX_RECORDS")
    ?? profile.query?.maxRecords
    ?? 500;
  const fetchParallel = input.fetchParallel
    ?? envInt("KSQL_FETCH_PARALLEL")
    ?? profile.query?.fetchParallel
    ?? 3;
  if (!Number.isInteger(fetchParallel) || fetchParallel < 1 || fetchParallel > 10) {
    throw new Error("ArgumentError: fetchParallel must be an integer between 1 and 10.");
  }
  const onLimit = input.onLimit
    ?? envOnLimit("KSQL_ON_LIMIT")
    ?? profile.query?.onLimit
    ?? "error";
  const timeout = input.timeout
    ?? envInt("KSQL_TIMEOUT")
    ?? profile.query?.timeout
    ?? 30000;
  // 一時テーブル実体化上限。既定値（10,000）はエンジン層 TEMP_TABLE_MAX_ROWS の
  // 1箇所に保つため、ここでは undefined のまま流す（?? 10_000 を書かない）
  const tempTableMaxRows = input.tempTableMaxRows
    ?? envInt("KSQL_TEMP_TABLE_MAX_ROWS")
    ?? profile.query?.tempTableMaxRows;

  const appIds = extractAppIds(sql);
  const defaultApp = envInt("KSQL_APP") ?? profile.app ?? null;
  if (appIds.length === 0 && defaultApp !== null) appIds.push(defaultApp);

  const appProfileByApp = new Map<number, string>();
  for (const appId of appIds) {
    appProfileByApp.set(
      appId,
      normalized.appBindingByMappedApp.get(appId)?.profile ?? profileName.toLowerCase()
    );
  }

  const usedProfiles = new Set<string>([...appProfileByApp.values(), profileName]);
  const profileClientMap = new Map<string, KintoneClient>();
  const missingAppProfiles: string[] = [];
  const tokenMapEnv = envString("KSQL_TOKEN_MAP");
  const mapFromEnv = tokenMapEnv ? parseTokenMap(tokenMapEnv) : {};
  const singleToken = envString("KSQL_TOKEN");

  for (const pName of usedProfiles) {
    const p = pName === profileName ? profile : (config.profiles?.[pName] ?? null);
    if (!p) throw new Error(`ArgumentError: profile "${pName}" is not defined.`);

    const baseUrl = envString("KSQL_BASE_URL") ?? p.baseUrl ?? "";
    const guestSpaceId = envInt("KSQL_GUEST_SPACE_ID") ?? p.guestSpaceId ?? null;
    if (!baseUrl) {
      throw new Error(`AuthError: --base-url is required for profile "${pName}".`);
    }

    const authReq = envAuth("KSQL_AUTH") ?? p.auth ?? "auto";
    const username = envString("KSQL_USERNAME") ?? p.username ?? null;
    const passwordFromEnvRef = p.passwordEnv ? envString(p.passwordEnv) : null;
    const password = envString("KSQL_PASSWORD") ?? passwordFromEnvRef ?? p.password ?? null;
    const hasUserPass = Boolean(username && password);
    const auth = authReq === "auto" ? (hasUserPass ? "userpass" : "token") : authReq;

    if (auth === "userpass") {
      if (!username || !password) {
        throw new Error(`AuthError: username/password are required for profile "${pName}".`);
      }
      profileClientMap.set(pName, createNodeKintoneClient(baseUrl, {
        guestSpaceId,
        timeoutMs: timeout,
        debug: input.debug,
        debugHeaders: input.debugHeaders,
        log: input.log,
        auth: { type: "userpass", username, password },
      }));
      continue;
    }

    const mapFromConfig = Object.fromEntries(
      Object.entries(p.tokenMap ?? {}).map(([k, v]) => [normalizeAppKey(k), resolveTokenValue(String(v))])
    );
    const effectiveTokenMap: Record<string, string> = { ...mapFromConfig, ...mapFromEnv };
    const assignedAppIds = appIds.filter((appId) => appProfileByApp.get(appId) === pName);
    const tokenByApp = new Map<number, string>();

    for (const mappedAppId of assignedAppIds) {
      const realAppId = normalized.appBindingByMappedApp.get(mappedAppId)?.appId ?? mappedAppId;
      const key = `APP${realAppId}`;
      const fromMap = effectiveTokenMap[key];
      if (fromMap) {
        tokenByApp.set(mappedAppId, resolveTokenValue(fromMap));
        continue;
      }
      if (assignedAppIds.length === 1 && singleToken) {
        tokenByApp.set(mappedAppId, singleToken);
        continue;
      }
      missingAppProfiles.push(`APP${realAppId}@${pName}`);
    }

    if (assignedAppIds.length === 0 && singleToken) {
      tokenByApp.set(0, singleToken);
    }

    profileClientMap.set(pName, createNodeKintoneClient(baseUrl, {
      guestSpaceId,
      timeoutMs: timeout,
      debug: input.debug,
      debugHeaders: input.debugHeaders,
      log: input.log,
      auth: {
        type: "token",
        resolveToken(appId: number): string {
          const token = tokenByApp.get(appId) ?? tokenByApp.get(0);
          if (!token) throw new Error(`AuthError: token is not resolved for APP${appId}@${pName}.`);
          return token;
        },
      },
    }));
  }

  if (missingAppProfiles.length > 0) {
    throw new Error(`AuthError: token is missing for ${missingAppProfiles.join(", ")}.`);
  }

  const defaultClient = profileClientMap.get(profileName);
  if (!defaultClient) {
    throw new Error(`AuthError: profile client is not resolved for "${profileName}".`);
  }

  const routedClient: KintoneClient = {
    getRecords: (params) => {
      const binding = normalized.appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
      const routed = profileClientMap.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.getRecords({ ...params, app: binding.appId });
    },
    postRecords: (params) => {
      const binding = normalized.appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
      const routed = profileClientMap.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.postRecords({ ...params, app: binding.appId });
    },
    putRecords: (params) => {
      const binding = normalized.appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
      const routed = profileClientMap.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.putRecords({ ...params, app: binding.appId });
    },
    deleteRecords: (params) => {
      const binding = normalized.appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
      const routed = profileClientMap.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.deleteRecords({ ...params, app: binding.appId });
    },
    getFields: (appId) => {
      const binding = normalized.appBindingByMappedApp.get(appId) ?? { appId, profile: profileName.toLowerCase() };
      const routed = profileClientMap.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${appId}.`);
      return routed.getFields(binding.appId);
    },
    getApps: () => defaultClient.getApps(),
  };

  // レートゲート（P0-1）: 同時リクエスト上限 + GET 系の 429/5xx リトライ。
  // プロセス内グローバルのため、設定は最初に解決された値で固定される。
  // env（KSQL_MAX_CONCURRENT / KSQL_RETRY）> profile > 既定は resolveRequestGateOptions で解決。
  // MCP ツール入力には公開しない（設計判断 D4: レート制御は運用者の環境設定）
  const gatedClient = withRequestGate(
    routedClient,
    getGlobalRequestGate(resolveRequestGateOptions({
      maxConcurrent: profile.query?.maxConcurrent,
      maxRetries: profile.query?.retry,
      baseDelayMs: profile.query?.retryBaseDelayMs,
      maxDelayMs: profile.query?.retryMaxDelayMs,
    }))
  );

  return {
    sql,
    profileName,
    client: gatedClient,
    cacheContext: buildCacheContext(profileName, normalized.appBindingByMappedApp),
    maxRecords,
    fetchParallel,
    onLimit,
    timeout,
    tempTableMaxRows,
  };
}
