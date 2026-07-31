import { readFileSync } from "fs";
import type { AppResolutionContext } from "./config";
import {
  collectAppProfileTokens,
  normalizeSqlAppProfiles,
  type AppBinding,
} from "../core/logicalApps";

export {
  collectAppProfileTokens,
  normalizeSqlAppProfiles,
  type AppBinding,
  type ParsedAppProfileToken,
  type SqlProfileParseResult,
  type SqlRewriteSegment,
} from "../core/logicalApps";

export function parseTokenMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.trim()) return out;
  const pairs = raw.split(",");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) throw new Error("ArgumentError: --token-map must be APPxxx=token pairs.");
    const key = normalizeAppKey(pair.slice(0, idx).trim());
    const value = pair.slice(idx + 1).trim();
    if (!value) throw new Error(`ArgumentError: token is empty for ${key}.`);
    out[key] = value;
  }
  return out;
}

export function parseTokenFile(path: string): Record<string, string> {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) out[normalizeAppKey(k)] = String(v);
  return out;
}

export function normalizeAppKey(v: string): string {
  const m1 = v.match(/^APP(\d+)$/i);
  if (m1) return `APP${m1[1]}`;
  const m2 = v.match(/^(\d+)$/);
  if (m2) return `APP${m2[1]}`;
  throw new Error(`ArgumentError: invalid app key "${v}"`);
}

export function extractAppIds(sql: string): number[] {
  // collectAppProfileTokens は文字列リテラル・バッククォート識別子・行/ブロック
  // コメントをスキップしてから APP 参照を拾う。素の正規表現で生 SQL をなめると
  // コメントや文字列中の "APPxxxx" まで認可判定に混入するため（token is missing
  // 誤検知の原因）、@profile 正規化と同じスキャナに統一する。
  const out = new Set<number>();
  for (const t of collectAppProfileTokens(sql)) {
    if (t.source === "physical") out.add(t.appId);
  }
  return [...out];
}


export function buildCacheContext(
  defaultProfile: string,
  appBindingByMappedApp: ReadonlyMap<number, AppBinding>
): string {
  if (appBindingByMappedApp.size === 0) return `default:${defaultProfile.toLowerCase()}`;
  const pairs = [...appBindingByMappedApp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mappedAppId, b]) => b.source === "logical"
      ? `M${mappedAppId}=logical:${b.logicalName}:APP${b.appId}@${b.profile}`
      : `M${mappedAppId}=physical:APP${b.appId}@${b.profile}`);
  return `apps:${pairs.join(",")}`;
}

export function formatResolvedAppProfiles(
  sql: string,
  defaultProfile: string,
  resolutionContext?: Pick<AppResolutionContext, "resolveLogicalApp">
): string {
  const parsed = normalizeSqlAppProfiles(sql, defaultProfile, resolutionContext);
  if (parsed.appBindingByMappedApp.size === 0) return "(none)";
  return [...parsed.appBindingByMappedApp.values()]
    .map((b) => b.source === "logical"
      ? `LAPP_${b.logicalName}@${b.profile}->APP${b.appId}@${b.profile}`
      : `APP${b.appId}->${b.profile}`)
    .join(", ");
}
