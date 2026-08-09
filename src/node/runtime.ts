import type { KintoneClient } from "../core";
import { getGlobalRequestGate, withRequestGate } from "../api/requestGate";
import {
  createNodeKintoneConnection,
  type NodeKintoneConnection,
  type TokenResolver,
} from "../cli/nodeKintoneClient";
import type {
  AllowedMetadataRequest,
  KintoneMetadataReader,
  MetadataEnvironment,
  RawMetadataResult,
} from "./kintoneMetadata";
import {
  type AppBinding,
  type SqlRewriteSegment,
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
  createAppResolutionContext,
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
  recursiveCteMaxDepth?: number;
  recursiveCteMaxRows?: number;
  recursiveCteMaxExpansions?: number;
  fetchParallel?: number;
  onLimit?: OnLimitMode;
  timeout?: number;
  tempTableMaxRows?: number;
  cursorMaxActive?: number;
  debug?: boolean;
  debugHeaders?: boolean;
  log?: (line: string) => void;
  /** validate/explain で確定済みの SQL/config snapshot。指定時は config を再読込しない。 */
  sqlContext?: ResolvedSqlContext;
}

export interface ResolvedConfigProfileView {
  baseUrl?: string;
  logicalApps?: Readonly<Record<string, number>>;
  allowPhysicalAppRefs?: boolean;
  tokenMapSources?: Readonly<Record<string, "inline" | string>>;
  passwordEnv?: string;
}

export interface ResolvedConfigView {
  defaultProfile?: string;
  profiles: Readonly<Record<string, Readonly<ResolvedConfigProfileView>>>;
}

export interface ResolvedSqlContext {
  normalizedSql: string;
  bindings: ReadonlyMap<number, AppBinding>;
  cacheContext: string;
  profileName: string;
  rewriteSegments: ReadonlyArray<Readonly<SqlRewriteSegment>>;
  hasProfileSyntax: boolean;
  configSnapshot: Readonly<ResolvedConfigView>;
  /** logical binding 欠落を fallback させないための内部整合性情報。 */
  logicalBindingLabels: ReadonlyMap<number, string>;
}

export interface ResolvedRuntimeContext {
  sqlContext: ResolvedSqlContext;
  tokenByMappedApp: Map<number, string>;
  clientsByProfile: Map<string, KintoneClient>;
  metadataReaderByProfile: Map<string, KintoneMetadataReader>;
}

// ResolvedSqlContext の公開型・列挙プロパティに token/password を含めず、
// 同一プロセス内の runtime だけが秘密値付き snapshot を取得できるようにする。
const privateConfigSnapshots = new WeakMap<ResolvedSqlContext, KsqlConfig>();

function cloneConfigSnapshot(config: KsqlConfig): KsqlConfig {
  return JSON.parse(JSON.stringify(config)) as KsqlConfig;
}

function toConfigView(config: KsqlConfig): ResolvedConfigView {
  const profiles = Object.fromEntries(Object.entries(config.profiles ?? {}).map(([name, p]) => [name, {
    baseUrl: p.baseUrl,
    logicalApps: p.logicalApps === undefined ? undefined : Object.freeze({ ...p.logicalApps }),
    allowPhysicalAppRefs: p.allowPhysicalAppRefs,
    passwordEnv: p.passwordEnv,
    tokenMapSources: p.tokenMap === undefined ? undefined : Object.freeze(Object.fromEntries(
      Object.entries(p.tokenMap).map(([key, value]) => [key, String(value).startsWith("env:") ? String(value).slice(4) : "inline"])
    )),
  }]));
  return Object.freeze({ defaultProfile: config.defaultProfile, profiles: Object.freeze(profiles) });
}

export function resolveSqlContext(
  serverOptions: KsqlRuntimeServerOptions,
  sql: string,
  inputProfile?: string
): ResolvedSqlContext {
  const configPath = serverOptions.configPath ?? envString("KSQL_CONFIG") ?? "./ksql.config.json";
  const config = cloneConfigSnapshot(loadOptionalKsqlConfig(configPath));
  const profileName = resolveDefaultProfile(config, serverOptions, inputProfile);
  const resolutionContext = createAppResolutionContext(config, profileName);
  const normalized = normalizeSqlAppProfiles(sql, profileName, resolutionContext);
  const bindings = normalized.appBindingByMappedApp;
  // rewrite 後の APP<id> ではなく、scanner が付与した source で物理参照を判定する。
  for (const binding of bindings.values()) {
    if (binding.source === "physical") resolutionContext.assertPhysicalAppAllowed(binding.profile);
  }
  const context: ResolvedSqlContext = {
    normalizedSql: normalized.normalizedSql,
    bindings,
    cacheContext: buildCacheContext(profileName, bindings),
    profileName,
    rewriteSegments: Object.freeze(normalized.rewriteSegments.map((segment) => Object.freeze({ ...segment }))),
    hasProfileSyntax: normalized.hasProfileSyntax,
    configSnapshot: toConfigView(config),
    logicalBindingLabels: new Map(
      [...bindings.values()]
        .filter((b): b is Extract<AppBinding, { source: "logical" }> => b.source === "logical")
        .map((b) => [b.mappedAppId, `LAPP_${b.logicalName}@${b.profile}`])
    ),
  };
  Object.freeze(context);
  privateConfigSnapshots.set(context, config);
  return context;
}

export function resolveTokenByMappedApp(args: {
  mappedAppIds: readonly number[];
  profileName: string;
  bindings: ReadonlyMap<number, AppBinding>;
  logicalBindingLabels: ReadonlyMap<number, string>;
  effectiveTokenMap: Readonly<Record<string, string>>;
  singleToken: string | null;
}): {
  tokenByMappedApp: Map<number, string>;
  tokenByPhysicalApp: Map<number, string>;
  missing: string[];
} {
  const tokenByMappedApp = new Map<number, string>();
  const tokenByPhysicalApp = new Map<number, string>();
  const missing: string[] = [];
  for (const mappedAppId of args.mappedAppIds) {
    const binding = args.bindings.get(mappedAppId);
    if (!binding && args.logicalBindingLabels.has(mappedAppId)) {
      throw new Error(`InternalError: binding is missing for logical app ${args.logicalBindingLabels.get(mappedAppId)}.`);
    }
    const appId = binding?.appId ?? mappedAppId;
    const profile = binding?.profile ?? args.profileName;
    const fromMap = args.effectiveTokenMap[`APP${appId}`];
    if (fromMap) {
      const token = resolveTokenValue(fromMap);
      tokenByMappedApp.set(mappedAppId, token);
      tokenByPhysicalApp.set(appId, token);
      continue;
    }
    // logical sourceは物理 tokenMap の明示的な binding のみ許可し、single token へ逃がさない。
    if (binding?.source !== "logical" && args.mappedAppIds.length === 1 && args.singleToken) {
      tokenByMappedApp.set(mappedAppId, args.singleToken);
      tokenByPhysicalApp.set(appId, args.singleToken);
      continue;
    }
    missing.push(binding?.source === "logical"
      ? `LAPP_${binding.logicalName} (APP${appId})@${profile}`
      : `APP${appId}@${profile}`);
  }
  return { tokenByMappedApp, tokenByPhysicalApp, missing };
}

function resolveRuntimeBinding(
  context: ResolvedSqlContext,
  mappedAppId: number
): Pick<AppBinding, "appId" | "profile"> {
  const binding = context.bindings.get(mappedAppId);
  if (binding) return binding;
  const logicalLabel = context.logicalBindingLabels.get(mappedAppId);
  if (logicalLabel) {
    throw new Error(`InternalError: binding is missing for logical app ${logicalLabel}.`);
  }
  return { appId: mappedAppId, profile: context.profileName.toLowerCase() };
}

export interface KsqlRuntime {
  sql: string;
  profileName: string;
  client: KintoneClient;
  cacheContext: string;
  maxRecords: number;
  /** Resolved by the built-in runtime; optional for backward-compatible runtime mocks. */
  recursiveCteMaxDepth?: number;
  recursiveCteMaxRows?: number;
  recursiveCteMaxExpansions?: number;
  fetchParallel: number;
  onLimit: OnLimitMode;
  timeout: number;
  /** 実runtimeでは解決済み。外部から差し替えるlegacy runtime mockでは省略可。 */
  cursorMaxActive?: number;
  /** 一時テーブル実体化上限。undefined = エンジン既定（TEMP_TABLE_MAX_ROWS = 10,000）に委ねる */
  tempTableMaxRows?: number;
}

export type KintoneMetadataAppRef = number | `LAPP_${string}`;

export interface CreateKintoneMetadataRuntimeInput {
  app: KintoneMetadataAppRef;
  profile?: string;
  request: AllowedMetadataRequest;
  timeout?: number;
  cursorMaxActive?: number;
  debug?: boolean;
  debugHeaders?: boolean;
  log?: (line: string) => void;
}

export interface KintoneMetadataRuntime {
  sourceApp: KintoneMetadataAppRef;
  mappedAppId: number;
  resolvedAppId: number;
  profileName: string;
  environment: MetadataEnvironment;
  cacheContext: string;
  metadata: RawMetadataResult;
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

interface ConnectionBuildInput {
  sqlContext: ResolvedSqlContext;
  config: KsqlConfig;
  mappedAppIds: readonly number[];
  appProfileByApp: ReadonlyMap<number, string>;
  usedProfiles: ReadonlySet<string>;
  timeout: number;
  cursorMaxActive: number;
  debug?: boolean;
  debugHeaders?: boolean;
  log?: (line: string) => void;
}

function buildRuntimeConnections(input: ConnectionBuildInput): {
  tokenByMappedApp: Map<number, string>;
  clientsByProfile: Map<string, KintoneClient>;
  metadataReaderByProfile: Map<string, KintoneMetadataReader>;
} {
  const profileName = input.sqlContext.profileName;
  const defaultProfile = input.config.profiles?.[profileName] ?? {};
  const allTokenByMappedApp = new Map<number, string>();
  const missingAppProfiles: string[] = [];
  const tokenMapEnv = envString("KSQL_TOKEN_MAP");
  const mapFromEnv = tokenMapEnv ? parseTokenMap(tokenMapEnv) : {};
  const singleToken = envString("KSQL_TOKEN");
  const pendingConnections: Array<{
    profileName: string;
    baseUrl: string;
    resolver: TokenResolver;
  }> = [];

  for (const pName of input.usedProfiles) {
    const profile = pName === profileName
      ? defaultProfile
      : (input.config.profiles?.[pName] ?? null);
    if (!profile) throw new Error(`ArgumentError: profile "${pName}" is not defined.`);

    const baseUrl = envString("KSQL_BASE_URL") ?? profile.baseUrl ?? "";
    const guestSpaceId = envInt("KSQL_GUEST_SPACE_ID") ?? profile.guestSpaceId ?? null;
    if (!baseUrl) {
      throw new Error(`AuthError: --base-url is required for profile "${pName}".`);
    }

    const authReq = envAuth("KSQL_AUTH") ?? profile.auth ?? "auto";
    const username = envString("KSQL_USERNAME") ?? profile.username ?? null;
    const passwordFromEnvRef = profile.passwordEnv ? envString(profile.passwordEnv) : null;
    const password = envString("KSQL_PASSWORD") ?? passwordFromEnvRef ?? profile.password ?? null;
    const hasUserPass = Boolean(username && password);
    const auth = authReq === "auto" ? (hasUserPass ? "userpass" : "token") : authReq;
    const common = {
      guestSpaceId,
      cursorMaxActive: input.cursorMaxActive,
      timeoutMs: input.timeout,
      debug: input.debug,
      debugHeaders: input.debugHeaders,
      log: input.log,
    };

    if (auth === "userpass") {
      if (!username || !password) {
        throw new Error(`AuthError: username/password are required for profile "${pName}".`);
      }
      pendingConnections.push({
        profileName: pName,
        baseUrl,
        resolver: { ...common, auth: { type: "userpass", username, password } },
      });
      continue;
    }

    const mapFromConfig = Object.fromEntries(
      Object.entries(profile.tokenMap ?? {}).map(([k, v]) => [
        normalizeAppKey(k),
        resolveTokenValue(String(v)),
      ])
    );
    const effectiveTokenMap: Record<string, string> = { ...mapFromConfig, ...mapFromEnv };
    const assignedAppIds = input.mappedAppIds.filter(
      (appId) => input.appProfileByApp.get(appId) === pName
    );
    const resolvedTokens = resolveTokenByMappedApp({
      mappedAppIds: assignedAppIds,
      profileName: pName,
      bindings: input.sqlContext.bindings,
      logicalBindingLabels: input.sqlContext.logicalBindingLabels,
      effectiveTokenMap,
      singleToken,
    });
    const tokenByApp = resolvedTokens.tokenByPhysicalApp;
    for (const [mappedAppId, token] of resolvedTokens.tokenByMappedApp) {
      allTokenByMappedApp.set(mappedAppId, token);
    }
    missingAppProfiles.push(...resolvedTokens.missing);
    if (assignedAppIds.length === 0 && singleToken) tokenByApp.set(0, singleToken);

    pendingConnections.push({
      profileName: pName,
      baseUrl,
      resolver: {
        ...common,
        auth: {
          type: "token",
          resolveToken(appId: number): string {
            const token = tokenByApp.get(appId) ?? tokenByApp.get(0);
            if (!token) {
              throw new Error(`AuthError: token is not resolved for APP${appId}@${pName}.`);
            }
            return token;
          },
        },
      },
    });
  }

  if (missingAppProfiles.length > 0) {
    throw new Error(`AuthError: token is missing for ${missingAppProfiles.join(", ")}.`);
  }

  const connectionsByProfile = new Map<string, NodeKintoneConnection>();
  for (const pending of pendingConnections) {
    connectionsByProfile.set(
      pending.profileName,
      createNodeKintoneConnection(pending.baseUrl, pending.resolver)
    );
  }
  return {
    tokenByMappedApp: allTokenByMappedApp,
    clientsByProfile: new Map(
      [...connectionsByProfile].map(([name, connection]) => [name, connection.client])
    ),
    metadataReaderByProfile: new Map(
      [...connectionsByProfile].map(([name, connection]) => [name, connection.metadataReader])
    ),
  };
}

export async function createKsqlRuntime(
  serverOptions: KsqlRuntimeServerOptions,
  input: CreateKsqlRuntimeInput
): Promise<KsqlRuntime> {
  const sqlContext = input.sqlContext ?? resolveSqlContext(serverOptions, input.sql, input.profile);
  const config = privateConfigSnapshots.get(sqlContext);
  if (!config) {
    throw new Error("InternalError: private config snapshot is missing for resolved SQL context.");
  }
  const profileName = sqlContext.profileName;
  const profile = config.profiles?.[profileName] ?? {};

  const sql = sqlContext.normalizedSql;
  const maxRecords = input.maxRecords
    ?? envInt("KSQL_MAX_RECORDS")
    ?? profile.query?.maxRecords
    ?? 500;
  const recursiveCteMaxDepth = input.recursiveCteMaxDepth
    ?? envInt("KSQL_RECURSIVE_CTE_MAX_DEPTH")
    ?? profile.query?.recursiveCteMaxDepth
    ?? 100;
  const recursiveCteMaxRows = input.recursiveCteMaxRows
    ?? envInt("KSQL_RECURSIVE_CTE_MAX_ROWS")
    ?? profile.query?.recursiveCteMaxRows
    ?? 10_000;
  const recursiveCteMaxExpansions = input.recursiveCteMaxExpansions
    ?? envInt("KSQL_RECURSIVE_CTE_MAX_EXPANSIONS")
    ?? profile.query?.recursiveCteMaxExpansions
    ?? 100_000;
  for (const [name, value] of [
    ["recursiveCteMaxDepth", recursiveCteMaxDepth],
    ["recursiveCteMaxRows", recursiveCteMaxRows],
    ["recursiveCteMaxExpansions", recursiveCteMaxExpansions],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`ArgumentError: ${name} must be a positive safe integer.`);
    }
  }
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
  const cursorMaxActive = input.cursorMaxActive
    ?? envInt("KSQL_CURSOR_MAX_ACTIVE")
    ?? profile.query?.cursorMaxActive
    ?? 2;
  if (!Number.isSafeInteger(cursorMaxActive) || cursorMaxActive < 1 || cursorMaxActive > 5) {
    throw new Error("ArgumentError: cursorMaxActive must be an integer from 1 to 5.");
  }

  const appIds = extractAppIds(sql);
  const defaultApp = envInt("KSQL_APP") ?? profile.app ?? null;
  if (appIds.length === 0 && defaultApp !== null) appIds.push(defaultApp);

  const appProfileByApp = new Map<number, string>();
  for (const appId of appIds) {
    appProfileByApp.set(
      appId,
      sqlContext.bindings.get(appId)?.profile ?? profileName.toLowerCase()
    );
  }

  const usedProfiles = new Set<string>([...appProfileByApp.values(), profileName]);
  const connections = buildRuntimeConnections({
    sqlContext,
    config,
    mappedAppIds: appIds,
    appProfileByApp,
    usedProfiles,
    timeout,
    cursorMaxActive,
    debug: input.debug,
    debugHeaders: input.debugHeaders,
    log: input.log,
  });

  const runtimeContext: ResolvedRuntimeContext = {
    sqlContext,
    tokenByMappedApp: connections.tokenByMappedApp,
    clientsByProfile: connections.clientsByProfile,
    metadataReaderByProfile: connections.metadataReaderByProfile,
  };

  const defaultClient = runtimeContext.clientsByProfile.get(profileName);
  if (!defaultClient) {
    throw new Error(`AuthError: profile client is not resolved for "${profileName}".`);
  }

  const routedClient: KintoneClient = {
    getRecords: (params) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, params.app);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.getRecords({ ...params, app: binding.appId });
    },
    openCursor: (params) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, params.app);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.openCursor({ ...params, app: binding.appId });
    },
    postRecords: (params) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, params.app);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.postRecords({ ...params, app: binding.appId });
    },
    putRecords: (params) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, params.app);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.putRecords({ ...params, app: binding.appId });
    },
    deleteRecords: (params) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, params.app);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${params.app}.`);
      return routed.deleteRecords({ ...params, app: binding.appId });
    },
    getFields: (appId) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, appId);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${appId}.`);
      return routed.getFields(binding.appId);
    },
    getNumberPrecision: (appId) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, appId);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${appId}.`);
      return routed.getNumberPrecision(binding.appId);
    },
    getProcessStatuses: (appId) => {
      const binding = resolveRuntimeBinding(runtimeContext.sqlContext, appId);
      const routed = runtimeContext.clientsByProfile.get(binding.profile);
      if (!routed) throw new Error(`AuthError: profile "${binding.profile}" is not resolved for APP${appId}.`);
      return routed.getProcessStatuses(binding.appId);
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
    cacheContext: sqlContext.cacheContext,
    maxRecords,
    recursiveCteMaxDepth,
    recursiveCteMaxRows,
    recursiveCteMaxExpansions,
    fetchParallel,
    onLimit,
    timeout,
    cursorMaxActive,
    tempTableMaxRows,
  };
}

const LOGICAL_METADATA_APP_REF_RE = /^LAPP_[A-Za-z][A-Za-z0-9_]{0,63}$/i;

function metadataAppRefSql(app: KintoneMetadataAppRef): string {
  if (typeof app === "number") {
    if (!Number.isSafeInteger(app) || app <= 0) {
      throw new Error("ArgumentError: app must be a positive safe integer or LAPP_<NAME>.");
    }
    return `SELECT * FROM APP${app}`;
  }
  if (!LOGICAL_METADATA_APP_REF_RE.test(app)) {
    throw new Error("ArgumentError: app must be a positive safe integer or LAPP_<NAME>.");
  }
  return `SELECT * FROM ${app}`;
}

/**
 * Resolves one allowlisted metadata request through the same config, app binding,
 * token, connection, and process-global read-only gate used by the SQL runtime.
 * This path intentionally does not invoke the SQL parser or executor.
 */
export async function createKintoneMetadataRuntime(
  serverOptions: KsqlRuntimeServerOptions,
  input: CreateKintoneMetadataRuntimeInput
): Promise<KintoneMetadataRuntime> {
  const syntheticSql = metadataAppRefSql(input.app);
  const sqlContext = resolveSqlContext(serverOptions, syntheticSql, input.profile);
  const config = privateConfigSnapshots.get(sqlContext);
  if (!config) {
    throw new Error("InternalError: private config snapshot is missing for resolved SQL context.");
  }
  if (input.profile !== undefined && config.profiles?.[sqlContext.profileName] === undefined) {
    throw new Error(`ArgumentError: profile "${sqlContext.profileName}" is not defined.`);
  }

  const mappedAppIds = extractAppIds(sqlContext.normalizedSql);
  if (mappedAppIds.length !== 1) {
    throw new Error("InternalError: metadata app resolution must produce exactly one app binding.");
  }
  const mappedAppId = mappedAppIds[0];
  const binding = resolveRuntimeBinding(sqlContext, mappedAppId);
  const profile = binding.profile === sqlContext.profileName
    ? (config.profiles?.[sqlContext.profileName] ?? {})
    : config.profiles?.[binding.profile];
  if (!profile) {
    throw new Error(`ArgumentError: profile "${binding.profile}" is not defined.`);
  }

  const timeout = input.timeout
    ?? envInt("KSQL_TIMEOUT")
    ?? profile.query?.timeout
    ?? 30000;
  const cursorMaxActive = input.cursorMaxActive
    ?? envInt("KSQL_CURSOR_MAX_ACTIVE")
    ?? profile.query?.cursorMaxActive
    ?? 2;
  if (!Number.isSafeInteger(cursorMaxActive) || cursorMaxActive < 1 || cursorMaxActive > 5) {
    throw new Error("ArgumentError: cursorMaxActive must be an integer from 1 to 5.");
  }

  const connections = buildRuntimeConnections({
    sqlContext,
    config,
    mappedAppIds,
    appProfileByApp: new Map([[mappedAppId, binding.profile]]),
    usedProfiles: new Set([binding.profile]),
    timeout,
    cursorMaxActive,
    debug: input.debug,
    debugHeaders: input.debugHeaders,
    log: input.log,
  });
  const reader = connections.metadataReaderByProfile.get(binding.profile);
  if (!reader) {
    throw new Error(
      `AuthError: metadata reader for profile "${binding.profile}" is not resolved for APP${mappedAppId}.`
    );
  }

  const gate = getGlobalRequestGate(resolveRequestGateOptions({
    maxConcurrent: profile.query?.maxConcurrent,
    maxRetries: profile.query?.retry,
    baseDelayMs: profile.query?.retryBaseDelayMs,
    maxDelayMs: profile.query?.retryMaxDelayMs,
  }));
  const metadata = await gate.runReadOnly(
    () => reader.getMetadata(input.request, binding.appId)
  );
  return {
    sourceApp: input.app,
    mappedAppId,
    resolvedAppId: binding.appId,
    profileName: binding.profile,
    environment: metadata.environment,
    cacheContext: sqlContext.cacheContext,
    metadata,
  };
}
