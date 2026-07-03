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
