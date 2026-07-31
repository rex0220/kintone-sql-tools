export const LOGICAL_APP_NAME_MAX_UTF16_UNITS = 64;

const LOGICAL_APP_ASCII_LETTERS = "A-Za-z";
const LOGICAL_APP_JAPANESE_RANGES = "\\u3040-\\u30FF\\u3400-\\u9FFF\\uF900-\\uFAFF\\uFF01-\\uFF60";
const LOGICAL_APP_START_CLASS = `${LOGICAL_APP_ASCII_LETTERS}${LOGICAL_APP_JAPANESE_RANGES}`;
const LOGICAL_APP_CONTINUE_CLASS = `${LOGICAL_APP_START_CLASS}0-9_`;

const LOGICAL_APP_NAME_START_RE = new RegExp(`^[${LOGICAL_APP_START_CLASS}]$`, "u");
const LOGICAL_APP_NAME_CONTINUE_RE = new RegExp(`^[${LOGICAL_APP_CONTINUE_CLASS}]$`, "u");
export const LOGICAL_APP_NAME_RE = new RegExp(
  `^[${LOGICAL_APP_START_CLASS}][${LOGICAL_APP_CONTINUE_CLASS}]{0,63}$`,
  "u"
);

export function isLogicalAppNameStart(ch: string): boolean {
  return LOGICAL_APP_NAME_START_RE.test(ch);
}

export function isLogicalAppNameContinue(ch: string): boolean {
  return LOGICAL_APP_NAME_CONTINUE_RE.test(ch);
}

export function canonicalizeLogicalAppName(name: string): string {
  const canonical = name.normalize("NFC").toUpperCase();
  if (!LOGICAL_APP_NAME_RE.test(canonical)) {
    throw new Error(
      `ArgumentError: logical app name "${name}" is invalid; expected 1-${LOGICAL_APP_NAME_MAX_UTF16_UNITS} UTF-16 units starting with an ASCII letter or supported Japanese character.`
    );
  }
  return canonical;
}

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

export type ParsedAppProfileToken = {
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
    if (!isLogicalAppNameStart(sql[i] ?? "")) return null;
    i++;
    while (i < sql.length && isLogicalAppNameContinue(sql[i])) i++;
    referenceValueEnd = i;
    try {
      logicalName = canonicalizeLogicalAppName(sql.slice(referenceValueStart, referenceValueEnd));
    } catch {
      return null;
    }
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

export function collectAppProfileTokens(sql: string): ParsedAppProfileToken[] {
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
  resolutionContext?: { resolveLogicalApp(name: string, profile: string): number }
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

  const usedAppIds = new Set<number>(tokens
    .filter((t): t is Extract<ParsedAppProfileToken, { source: "physical" }> => t.source === "physical")
    .map((t) => t.appId));
  const resolvedLogicalApps = new Map<string, number>();
  for (const t of tokens) {
    if (t.source !== "logical") continue;
    const pLower = normalizedProfile(t.profile).toLowerCase();
    const logicalKey = `logical:${t.logicalName}@${pLower}`;
    if (resolvedLogicalApps.has(logicalKey)) continue;
    if (!resolutionContext) {
      throw new Error(`ArgumentError: logical app LAPP_${t.logicalName}@${pLower} requires logicalApps configuration.`);
    }
    const resolvedAppId = resolutionContext.resolveLogicalApp(t.logicalName, pLower);
    resolvedLogicalApps.set(logicalKey, resolvedAppId);
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
        source: "physical", mappedAppId: mapped, appId, profile: pLower,
      });
    }
  }

  const out: string[] = [];
  const rewriteSegments: SqlRewriteSegment[] = [];
  let normalizedLength = 0;
  let cursor = 0;
  const appendSegment = (
    text: string, sourceStart: number, sourceEnd: number, bindingMappedAppId?: number
  ): void => {
    if (!text && sourceStart === sourceEnd) return;
    const normalizedStart = normalizedLength;
    out.push(text);
    normalizedLength += text.length;
    rewriteSegments.push({
      normalizedStart, normalizedEnd: normalizedLength, sourceStart, sourceEnd,
      ...(bindingMappedAppId === undefined ? {} : { bindingMappedAppId }),
    });
  };

  for (const t of tokens) {
    const pLower = normalizedProfile(t.profile).toLowerCase();
    let binding: AppBinding;
    if (t.source === "physical") {
      const mapped = pairToMapped.get(`physical:${t.appId}@${pLower}`) ?? t.appId;
      binding = { source: "physical", mappedAppId: mapped, appId: t.appId, profile: pLower };
    } else {
      const logicalKey = `logical:${t.logicalName}@${pLower}`;
      let mapped = pairToMapped.get(logicalKey);
      if (mapped === undefined) {
        mapped = nextVirtualAppId(usedAppIds);
        pairToMapped.set(logicalKey, mapped);
      }
      binding = {
        source: "logical", logicalName: t.logicalName, mappedAppId: mapped,
        appId: resolvedLogicalApps.get(logicalKey)!, profile: pLower,
      };
    }
    appBindingByMappedApp.set(binding.mappedAppId, binding);
    appendSegment(sql.slice(cursor, t.start), cursor, t.start);
    const subtableSuffix = sql.slice(t.referenceValueEnd, t.appEnd);
    const normalizedReference = t.source === "physical"
      ? `${sql.slice(t.start, t.referenceValueStart)}${binding.mappedAppId}${subtableSuffix}`
      : `APP${binding.mappedAppId}${subtableSuffix}`;
    appendSegment(normalizedReference, t.start, t.fullEnd, binding.mappedAppId);
    cursor = t.fullEnd;
  }
  appendSegment(sql.slice(cursor), cursor, sql.length);
  return { normalizedSql: out.join(""), hasProfileSyntax, appBindingByMappedApp, rewriteSegments };
}
