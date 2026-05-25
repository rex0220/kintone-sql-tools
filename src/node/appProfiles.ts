import { readFileSync } from "fs";

export interface SqlProfileParseResult {
  normalizedSql: string;
  hasProfileSyntax: boolean;
  appBindingByMappedApp: Map<number, { appId: number; profile: string }>;
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
  const out = new Set<number>();
  for (const m of sql.matchAll(/\bAPP(\d+)\b/gi)) out.add(Number(m[1]));
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

interface ParsedAppProfileToken {
  appId: number;
  profile: string | null;
  start: number;
  digitStart: number;
  digitEnd: number;
  appEnd: number;
  fullEnd: number;
}

function tryParseAppProfileToken(sql: string, start: number): ParsedAppProfileToken | null {
  const head = sql.slice(start, start + 3);
  if (head.toUpperCase() !== "APP") return null;

  const prev = start > 0 ? sql[start - 1] : "";
  if (isSqlIdentContinue(prev)) return null;

  let i = start + 3;
  const digitStart = i;
  while (i < sql.length && /[0-9]/.test(sql[i])) i++;
  const digitEnd = i;
  if (digitEnd === digitStart) return null;

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

  return {
    appId: Number(sql.slice(digitStart, digitEnd)),
    profile,
    start,
    digitStart,
    digitEnd,
    appEnd,
    fullEnd: i,
  };
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

export function normalizeSqlAppProfiles(sql: string, defaultProfile = "dev"): SqlProfileParseResult {
  const tokens = collectAppProfileTokens(sql);
  const hasProfileSyntax = tokens.some((t) => t.profile !== null);

  const profilesByApp = new Map<number, Set<string>>();
  const normalizedProfile = (profile: string | null): string => profile ?? defaultProfile;
  for (const t of tokens) {
    const p = normalizedProfile(t.profile);
    let set = profilesByApp.get(t.appId);
    if (!set) {
      set = new Set<string>();
      profilesByApp.set(t.appId, set);
    }
    set.add(p.toLowerCase());
  }

  const usedAppIds = new Set<number>(tokens.map((t) => t.appId));
  const pairToMapped = new Map<string, number>();
  const appBindingByMappedApp = new Map<number, { appId: number; profile: string }>();

  for (const [appId, pSet] of profilesByApp.entries()) {
    const profiles = [...pSet].sort();
    if (profiles.length <= 1) continue;
    for (const pLower of profiles) {
      const mapped = nextVirtualAppId(usedAppIds);
      pairToMapped.set(`${appId}@${pLower}`, mapped);
      appBindingByMappedApp.set(mapped, { appId, profile: pLower });
    }
  }

  const out: string[] = [];
  let cursor = 0;
  for (const t of tokens) {
    const p = normalizedProfile(t.profile);
    const pLower = p.toLowerCase();
    const mapped = pairToMapped.get(`${t.appId}@${pLower}`) ?? t.appId;
    appBindingByMappedApp.set(mapped, { appId: t.appId, profile: pLower });

    out.push(sql.slice(cursor, t.start));
    out.push(sql.slice(t.start, t.digitStart));
    out.push(String(mapped));
    out.push(sql.slice(t.digitEnd, t.appEnd));
    cursor = t.fullEnd;
  }
  out.push(sql.slice(cursor));

  return {
    normalizedSql: out.join(""),
    hasProfileSyntax,
    appBindingByMappedApp,
  };
}

export function buildCacheContext(
  defaultProfile: string,
  appBindingByMappedApp: Map<number, { appId: number; profile: string }>
): string {
  if (appBindingByMappedApp.size === 0) return `default:${defaultProfile.toLowerCase()}`;
  const pairs = [...appBindingByMappedApp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mappedAppId, b]) => `M${mappedAppId}=APP${b.appId}@${b.profile}`);
  return `apps:${pairs.join(",")}`;
}

export function formatResolvedAppProfiles(sql: string, defaultProfile: string): string {
  const parsed = normalizeSqlAppProfiles(sql, defaultProfile);
  if (parsed.appBindingByMappedApp.size === 0) return "(none)";
  return [...parsed.appBindingByMappedApp.values()]
    .map((b) => `APP${b.appId}->${b.profile}`)
    .join(", ");
}
