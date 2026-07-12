import { existsSync, readFileSync } from "fs";

export type OutputFormat = "table" | "json" | "jsonl" | "csv" | "markdown";
export type OnLimitMode = "error" | "truncate";
export type AuthMode = "token" | "userpass" | "auto";

export interface KsqlConfig {
  defaultProfile?: string;
  profiles?: Record<string, KsqlProfileConfig>;
  mcp?: {
    savedQueries?: {
      path?: string;
    };
  };
}

export interface KsqlProfileConfig {
  baseUrl?: string;
  guestSpaceId?: number;
  auth?: AuthMode;
  username?: string;
  password?: string;
  passwordEnv?: string;
  app?: number;
  tokenMap?: Record<string, string>;
  /** SQL 内の LAPP_<NAME> から物理アプリ ID への profile 単位 mapping。読込時にキーを ASCII 大文字化する。 */
  logicalApps?: Record<string, number>;
  /** false の場合、この profile に対する物理 APP<id> 参照を禁止する。 */
  allowPhysicalAppRefs?: boolean;
  query?: {
    maxRecords?: number;
    fetchParallel?: number;
    onLimit?: OnLimitMode;
    timeout?: number;
    /** 一時テーブル1個の実体化行数上限（既定 10,000。超過は onLimit 設定によらず常に error） */
    tempTableMaxRows?: number;
    /** kintone API の同時リクエスト数上限（プロセス内グローバル。env KSQL_MAX_CONCURRENT が優先） */
    maxConcurrent?: number;
    /** GET 系リトライ回数（0〜10。0 で無効。env KSQL_RETRY が優先） */
    retry?: number;
    /** リトライバックオフ初期値ミリ秒（既定 500） */
    retryBaseDelayMs?: number;
    /** リトライバックオフ上限ミリ秒（既定 8000） */
    retryMaxDelayMs?: number;
  };
  output?: {
    format?: OutputFormat;
    pretty?: boolean;
    noHeader?: boolean;
    noColor?: boolean;
    quiet?: boolean;
    output?: string;
    exitOnEmpty?: boolean;
    userFormat?: "full" | "name" | "code";
    arrayFormat?: "full" | "join";
    tableFormat?: "full" | "count";
    dateFormat?: "full" | "local";
    attachmentFormat?: "full" | "name" | "fileKey";
  };
  dml?: {
    allowDml?: boolean;
    yes?: boolean;
    allowWithoutWhere?: boolean;
    maxRows?: number;
  };
}

const LOGICAL_APP_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PHYSICAL_APP_KEY_RE = /^APP\d+$/i;
const NUMERIC_APP_KEY_RE = /^\d+$/;
const LOGICAL_SQL_KEY_RE = /^LAPP_/i;

function argumentError(message: string): Error {
  return new Error(`ArgumentError: ${message}`);
}

function normalizeLogicalApps(
  profileName: string,
  value: unknown
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw argumentError(`logicalApps for profile "${profileName}" must be an object.`);
  }

  const normalized: Record<string, number> = {};
  const physicalIdOwners = new Map<number, string>();
  for (const [rawName, rawAppId] of Object.entries(value)) {
    if (
      PHYSICAL_APP_KEY_RE.test(rawName)
      || NUMERIC_APP_KEY_RE.test(rawName)
      || LOGICAL_SQL_KEY_RE.test(rawName)
    ) {
      throw argumentError(
        `logical app key "${rawName}" in profile "${profileName}" must be a logical name without APP, numeric, or LAPP_ syntax.`
      );
    }
    if (!LOGICAL_APP_NAME_RE.test(rawName)) {
      throw argumentError(
        `logical app key "${rawName}" in profile "${profileName}" must match [A-Z][A-Z0-9_]{0,63}.`
      );
    }

    const logicalName = rawName.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(normalized, logicalName)) {
      throw argumentError(
        `logical app name "${logicalName}" is duplicated after case normalization in profile "${profileName}".`
      );
    }
    if (typeof rawAppId !== "number" || !Number.isSafeInteger(rawAppId) || rawAppId <= 0) {
      throw argumentError(
        `physical app ID for logical app "${logicalName}" in profile "${profileName}" must be a positive safe integer.`
      );
    }

    const existingName = physicalIdOwners.get(rawAppId);
    if (existingName !== undefined) {
      throw argumentError(
        `logical apps "${existingName}" and "${logicalName}" in profile "${profileName}" map to the same physical app ID ${rawAppId}; physical app aliases are not supported yet.`
      );
    }
    physicalIdOwners.set(rawAppId, logicalName);
    normalized[logicalName] = rawAppId;
  }
  return normalized;
}

/**
 * 追加の論理アプリ設定を検証し、logicalApps のキーを ASCII 大文字に正規化する。
 * 既存設定項目の受理範囲はこの機能追加で変更しない。
 */
export function validateKsqlConfig(config: KsqlConfig): KsqlConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw argumentError("config must be an object.");
  }
  if (config.profiles === undefined) return config;
  if (config.profiles === null || typeof config.profiles !== "object" || Array.isArray(config.profiles)) {
    throw argumentError("profiles must be an object.");
  }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
      throw argumentError(`profile "${profileName}" must be an object.`);
    }
    if (
      profile.allowPhysicalAppRefs !== undefined
      && typeof profile.allowPhysicalAppRefs !== "boolean"
    ) {
      throw argumentError(`allowPhysicalAppRefs for profile "${profileName}" must be boolean.`);
    }
    const logicalApps = normalizeLogicalApps(profileName, profile.logicalApps);
    if (logicalApps !== undefined) profile.logicalApps = logicalApps;
  }
  return config;
}

export interface AppResolutionContext {
  /** 未定義論理名または未知 profile では undefined を返さず throw する。 */
  resolveLogicalApp(name: string, profile: string): number;
  /** allowPhysicalAppRefs:false の profile への物理参照を拒否する。 */
  assertPhysicalAppAllowed(profile: string): void;
}

/** config snapshot を閉じ込めた CLI/MCP 共通の論理アプリ resolver factory。 */
export function createAppResolutionContext(
  config: Readonly<KsqlConfig>,
  defaultProfile: string
): AppResolutionContext {
  // factory 作成後に呼び出し元の config が書き換わっても解決結果を変えない。
  // token/password などの認証情報はこの resolver にはコピーしない。
  const profiles: Readonly<Record<string, Readonly<KsqlProfileConfig>>> = Object.fromEntries(
    Object.entries(config.profiles ?? {}).map(([name, profile]) => [
      name,
      {
        logicalApps: profile.logicalApps === undefined ? undefined : { ...profile.logicalApps },
        allowPhysicalAppRefs: profile.allowPhysicalAppRefs,
      },
    ])
  );
  const implicitDefaultProfile: Readonly<KsqlProfileConfig> = {};

  function requireProfile(profileName: string): Readonly<KsqlProfileConfig> {
    const profile = profiles[profileName];
    // config 未設定の従来フローでは既定 profile を暗黙に許可する。
    // その場合も logicalApps は空、allowPhysicalAppRefs は既定 true となる。
    if (!profile && profileName === defaultProfile) return implicitDefaultProfile;
    if (!profile) throw argumentError(`profile "${profileName}" is not defined.`);
    return profile;
  }

  return {
    resolveLogicalApp(name, profile) {
      if (!LOGICAL_APP_NAME_RE.test(name)) {
        throw argumentError(`logical app name "${name}" must match [A-Z][A-Z0-9_]{0,63}.`);
      }
      const profileName = profile || defaultProfile;
      const logicalName = name.toUpperCase();
      const appId = requireProfile(profileName).logicalApps?.[logicalName];
      if (appId === undefined) {
        throw argumentError(`logical app LAPP_${logicalName}@${profileName} is not defined.`);
      }
      return appId;
    },
    assertPhysicalAppAllowed(profile) {
      const profileName = profile || defaultProfile;
      if (requireProfile(profileName).allowPhysicalAppRefs === false) {
        throw argumentError(
          `physical app references are not allowed for profile "${profileName}"; use LAPP_<NAME>.`
        );
      }
    },
  };
}

export function loadKsqlConfig(configPath: string): KsqlConfig {
  const raw = readFileSync(configPath, "utf-8");
  return validateKsqlConfig(JSON.parse(raw) as KsqlConfig);
}

export function loadOptionalKsqlConfig(configPath: string): KsqlConfig {
  if (!existsSync(configPath)) return {};
  return loadKsqlConfig(configPath);
}

export function envString(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v : null;
}

export function envInt(name: string): number | null {
  const v = envString(name);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * 0 を有効値として受け付ける整数 env の解決。
 * `KSQL_RETRY=0`（リトライ無効）のように「0 に意味がある」設定に使う
 * （envInt は n <= 0 を無効値として捨てるため 0 を読めない）
 */
export function envNonNegativeInt(name: string): number | null {
  const v = envString(name);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** リクエストゲートに渡す設定（api/requestGate の RequestGateOptions の設定項目部分） */
export interface RequestGateSettings {
  maxConcurrent?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * リクエストゲート設定の env 解決（`KSQL_MAX_CONCURRENT` / `KSQL_RETRY` > base）。
 * base には CLI フラグ > profile 設定のマージ済み値を渡す（優先順は env > CLI > config > 既定）。
 * api/requestGate は browser/plugin にも近い層のため env 解決を持たない — Node 側の
 * 呼び出し元（cli/index.ts / node/runtime.ts）がこの関数を通してから渡す。
 */
export function resolveRequestGateOptions(base: RequestGateSettings): RequestGateSettings {
  return {
    ...base,
    maxConcurrent: envInt("KSQL_MAX_CONCURRENT") ?? base.maxConcurrent,
    // KSQL_RETRY=0（リトライ無効）は有効値のため envNonNegativeInt で読む
    maxRetries: envNonNegativeInt("KSQL_RETRY") ?? base.maxRetries,
  };
}

export function envOnLimit(name: string): OnLimitMode | null {
  const v = envString(name);
  if (v === "error" || v === "truncate") return v;
  return null;
}

export function envAuth(name: string): AuthMode | null {
  const v = envString(name);
  if (v === "token" || v === "userpass" || v === "auto") return v;
  return null;
}

export function resolveTokenValue(raw: string): string {
  if (raw.startsWith("env:")) {
    const envKey = raw.slice(4);
    const envVal = process.env[envKey];
    if (!envVal) throw new Error(`AuthError: environment variable "${envKey}" is not set.`);
    return envVal;
  }
  return raw;
}
