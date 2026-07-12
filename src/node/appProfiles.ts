import { readFileSync } from "fs";
import type { AppResolutionContext } from "./config";

export type AppBinding =
  | {
      source: "physical";
      mappedAppId: number;
      appId: number;
      profile: string;
    }
  | {
      source: "logical";
      logicalName: string;
      mappedAppId: number;
      appId: number;
      profile: string;
    };

export interface SqlRewriteSegment {
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  bindingMappedAppId?: number;
}

export interface SqlProfileParseResult {
  normalizedSql: string;
  hasProfileSyntax: boolean;
  appBindingByMappedApp: Map<number, AppBinding>;
  rewriteSegments: SqlRewriteSegment[];
}

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

function isSqlIdentContinue(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0x30 && cp <= 0x39) ||
    cp === 0x5f ||
    cp === 0x24 ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff01 && cp <= 0xff60)
  );
}

function isProfileNameChar(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0x30 && cp <= 0x39) ||
    ch === "_" || ch === "-" || ch === "." || ch === "$"
  );
}

type ParsedAppProfileToken = {
  source: "physical";
  appId: number;
  logicalName?: never;
  referenceValueStart: number;
  referenceValueEnd: number;
  profile: string | null;
  start: number;
  appEnd: number;
  fullEnd: number;
} | {
  source: "logical";
  appId?: never;
  logicalName: string;
  referenceValueStart: number;
  referenceValueEnd: number;
  profile: string | null;
  start: number;
  appEnd: number;
  fullEnd: number;
};

function isAsciiLogicalNameStart(ch: string): boolean {
  return /^[A-Za-z]$/.test(ch);
}

function isAsciiLogicalNameContinue(ch: string): boolean {
  return /^[A-Za-z0-9_]$/.test(ch);
}

function tryParseAppProfileToken(sql: string, start: number): ParsedAppProfileToken | null {
  const prev = start > 0 ? sql[start - 1] : "";
  if (isSqlIdentContinue(prev)) return null;

  let source: "physical" | "logical";
  let appId: number | undefined;
  let logicalName: string | undefined;
  let referenceValueStart: number;
  let referenceValueEnd: number;
  let i: number;

  if (sql.slice(start, start + 5).toUpperCase() === "LAPP_") {
    source = "logical";
    i = start + 5;
    referenceValueStart = i;
    if (!isAsciiLogicalNameStart(sql[i] ?? "")) return null;
    i++;
    while (i < sql.length && isAsciiLogicalNameContinue(sql[i])) i++;
    referenceValueEnd = i;
    if (referenceValueEnd - referenceValueStart > 64) return null;
    logicalName = sql.slice(referenceValueStart, referenceValueEnd).toUpperCase();
  } else if (sql.slice(start, start + 3).toUpperCase() === "APP") {
    source = "physical";
    i = start + 3;
    referenceValueStart = i;
    while (i < sql.length && /[0-9]/.test(sql[i])) i++;
    referenceValueEnd = i;
    if (referenceValueEnd === referenceValueStart) return null;
    appId = Number(sql.slice(referenceValueStart, referenceValueEnd));
  } else {
    return null;
  }

  if (sql[i] === "$") {
    i++;
    const subStart = i;
    while (i < sql.length && isSqlIdentContinue(sql[i])) i++;
    if (i === subStart) return null;
  }

  const appEnd = i;
  let profile: string | null = null;
  if (sql[i] === "@") {
    i++;
    const pStart = i;
    while (i < sql.length && isProfileNameChar(sql[i])) i++;
    if (i === pStart) return null;
    profile = sql.slice(pStart, i);
  }

  const next = i < sql.length ? sql[i] : "";
  if (isSqlIdentContinue(next)) return null;

  const common = {
    profile,
    start,
    referenceValueStart,
    referenceValueEnd,
    appEnd,
    fullEnd: i,
  };
  return source === "physical"
    ? { ...common, source, appId: appId! }
    : { ...common, source, logicalName: logicalName! };
}

function collectAppProfileTokens(sql: string): ParsedAppProfileToken[] {
  const tokens: ParsedAppProfileToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          i++;
          if (i < sql.length && sql[i] === "'") { i++; continue; }
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "`") {
      i++;
      while (i < sql.length && sql[i] !== "`") i++;
      if (i < sql.length) i++;
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") { i += 2; break; }
        i++;
      }
      continue;
    }

    const parsed = tryParseAppProfileToken(sql, i);
    if (!parsed) {
      i++;
      continue;
    }
    tokens.push(parsed);
    i = parsed.fullEnd;
  }
  return tokens;
}

function nextVirtualAppId(used: Set<number>): number {
  let id = 900_000_000;
  while (used.has(id)) id++;
  used.add(id);
  return id;
}

export function normalizeSqlAppProfiles(
  sql: string,
  defaultProfile = "dev",
  resolutionContext?: Pick<AppResolutionContext, "resolveLogicalApp">
): SqlProfileParseResult {
  const tokens = collectAppProfileTokens(sql);
  const hasProfileSyntax = tokens.some((t) => t.profile !== null);

  const profilesByApp = new Map<number, Set<string>>();
  const normalizedProfile = (profile: string | null): string => profile ?? defaultProfile;
  for (const t of tokens) {
    if (t.source !== "physical") continue;
    const p = normalizedProfile(t.profile);
    let set = profilesByApp.get(t.appId);
    if (!set) {
      set = new Set<string>();
      profilesByApp.set(t.appId, set);
    }
    set.add(p.toLowerCase());
  }

  const usedAppIds = new Set<number>(
    tokens.filter((t): t is Extract<ParsedAppProfileToken, { source: "physical" }> => t.source === "physical")
      .map((t) => t.appId)
  );
  const resolvedLogicalApps = new Map<string, number>();
  for (const t of tokens) {
    if (t.source !== "logical") continue;
    const pLower = normalizedProfile(t.profile).toLowerCase();
    const logicalKey = `logical:${t.logicalName}@${pLower}`;
    if (resolvedLogicalApps.has(logicalKey)) continue;
    if (!resolutionContext) {
      throw new Error(
        `ArgumentError: logical app LAPP_${t.logicalName}@${pLower} requires logicalApps configuration.`
      );
    }
    const resolvedAppId = resolutionContext.resolveLogicalApp(t.logicalName, pLower);
    resolvedLogicalApps.set(logicalKey, resolvedAppId);
    // mapped ID は SQL に直接現れる物理 ID だけでなく、論理解決先とも衝突させない。
    usedAppIds.add(resolvedAppId);
  }
  const pairToMapped = new Map<string, number>();
  const appBindingByMappedApp = new Map<number, AppBinding>();

  for (const [appId, pSet] of profilesByApp.entries()) {
    const profiles = [...pSet].sort();
    if (profiles.length <= 1) continue;
    for (const pLower of profiles) {
      const mapped = nextVirtualAppId(usedAppIds);
      pairToMapped.set(`physical:${appId}@${pLower}`, mapped);
      appBindingByMappedApp.set(mapped, {
        source: "physical",
        mappedAppId: mapped,
        appId,
        profile: pLower,
      });
    }
  }

  const out: string[] = [];
  const rewriteSegments: SqlRewriteSegment[] = [];
  let normalizedLength = 0;
  let cursor = 0;

  const appendSegment = (
    text: string,
    sourceStart: number,
    sourceEnd: number,
    bindingMappedAppId?: number
  ): void => {
    if (!text && sourceStart === sourceEnd) return;
    const normalizedStart = normalizedLength;
    out.push(text);
    normalizedLength += text.length;
    rewriteSegments.push({
      normalizedStart,
      normalizedEnd: normalizedLength,
      sourceStart,
      sourceEnd,
      ...(bindingMappedAppId === undefined ? {} : { bindingMappedAppId }),
    });
  };

  for (const t of tokens) {
    const p = normalizedProfile(t.profile);
    const pLower = p.toLowerCase();
    let binding: AppBinding;

    if (t.source === "physical") {
      const mapped = pairToMapped.get(`physical:${t.appId}@${pLower}`) ?? t.appId;
      binding = {
        source: "physical",
        mappedAppId: mapped,
        appId: t.appId,
        profile: pLower,
      };
    } else {
      const logicalKey = `logical:${t.logicalName}@${pLower}`;
      let mapped = pairToMapped.get(logicalKey);
      if (mapped === undefined) {
        mapped = nextVirtualAppId(usedAppIds);
        pairToMapped.set(logicalKey, mapped);
      }
      binding = {
        source: "logical",
        logicalName: t.logicalName,
        mappedAppId: mapped,
        appId: resolvedLogicalApps.get(logicalKey)!,
        profile: pLower,
      };
    }
    appBindingByMappedApp.set(binding.mappedAppId, binding);

    appendSegment(sql.slice(cursor, t.start), cursor, t.start);
    const subtableSuffix = sql.slice(t.referenceValueEnd, t.appEnd);
    const normalizedReference = t.source === "physical"
      ? `${sql.slice(t.start, t.referenceValueStart)}${binding.mappedAppId}${subtableSuffix}`
      : `APP${binding.mappedAppId}${subtableSuffix}`;
    appendSegment(
      normalizedReference,
      t.start,
      t.fullEnd,
      binding.mappedAppId
    );
    cursor = t.fullEnd;
  }
  appendSegment(sql.slice(cursor), cursor, sql.length);

  return {
    normalizedSql: out.join(""),
    hasProfileSyntax,
    appBindingByMappedApp,
    rewriteSegments,
  };
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
