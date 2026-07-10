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
  query?: {
    maxRecords?: number;
    fetchParallel?: number;
    onLimit?: OnLimitMode;
    timeout?: number;
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

export function loadKsqlConfig(configPath: string): KsqlConfig {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as KsqlConfig;
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
