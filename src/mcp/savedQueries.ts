import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { envString } from "../node/config";

export const SAVED_QUERY_CATALOG_VERSION = 1;
export const DEFAULT_SAVED_QUERY_CATALOG_PATH = ".ksql/queries.json";
export const SAVED_QUERY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface SavedQuery {
  name: string;
  title?: string;
  description?: string;
  sql: string;
  defaultProfile: string;
  readOnly: boolean;
  allowProfileOverride?: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

export interface SavedQueryCatalog {
  version: 1;
  queries: SavedQuery[];
}

export interface SaveQueryInput {
  name: string;
  title?: string;
  description?: string;
  sql: string;
  defaultProfile: string;
  readOnly: boolean;
  allowProfileOverride?: boolean;
  tags?: string[];
}

export interface SavedQuerySafety {
  isDml: boolean;
  statementType: string;
}

export interface SavedQueryCatalogPathOptions {
  inputPath?: string;
  configPath?: string;
  configSavedQueriesPath?: string;
  cwd?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeTags(tags?: string[]): string[] | undefined {
  if (!tags) return undefined;
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function resolvePath(path: string, baseDir: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

export function resolveSavedQueryCatalogPath(options: SavedQueryCatalogPathOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const envPath = envString("KSQL_SAVED_QUERIES");
  if (options.inputPath) return resolvePath(options.inputPath, cwd);
  if (envPath) return resolvePath(envPath, cwd);

  const configBaseDir = options.configPath ? dirname(resolve(cwd, options.configPath)) : cwd;
  const configured = options.configSavedQueriesPath ?? DEFAULT_SAVED_QUERY_CATALOG_PATH;
  return resolvePath(configured, configBaseDir);
}

export function emptySavedQueryCatalog(): SavedQueryCatalog {
  return {
    version: SAVED_QUERY_CATALOG_VERSION,
    queries: [],
  };
}

export function validateSavedQueryName(name: string): void {
  if (!SAVED_QUERY_NAME_PATTERN.test(name)) {
    throw new Error(
      "ArgumentError: saved query name must start with an ASCII letter or digit and contain only letters, digits, underscores, or hyphens, up to 64 characters."
    );
  }
}

export function assertSavedQuerySafety(input: SaveQueryInput, safety: SavedQuerySafety): void {
  if (input.readOnly && safety.isDml) {
    throw new Error(`ArgumentError: readOnly saved query cannot contain ${safety.statementType}.`);
  }
  if (!input.readOnly && !safety.isDml) {
    throw new Error("ArgumentError: readOnly: false is only allowed for DML saved queries.");
  }
}

export function assertProfileOverrideAllowed(query: SavedQuery, requestedProfile?: string): void {
  if (!requestedProfile || requestedProfile === query.defaultProfile) return;
  if (!query.allowProfileOverride) {
    throw new Error(`ArgumentError: saved query ${query.name} does not allow profile override.`);
  }
}

export function parseSavedQueryCatalog(raw: string): SavedQueryCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ArgumentError: saved query catalog JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isPlainObject(parsed) || parsed.version !== SAVED_QUERY_CATALOG_VERSION || !Array.isArray(parsed.queries)) {
    throw new Error("ArgumentError: saved query catalog must be an object with version: 1 and queries array.");
  }

  const queries = parsed.queries.map((item): SavedQuery => {
    if (!isPlainObject(item)) {
      throw new Error("ArgumentError: saved query catalog contains a non-object query.");
    }
    const name = item.name;
    const sql = item.sql;
    const defaultProfile = item.defaultProfile;
    const readOnly = item.readOnly;
    const createdAt = item.createdAt;
    const updatedAt = item.updatedAt;
    if (typeof name !== "string" || typeof sql !== "string" || typeof defaultProfile !== "string") {
      throw new Error("ArgumentError: saved query catalog query requires name, sql, and defaultProfile strings.");
    }
    if (typeof readOnly !== "boolean" || typeof createdAt !== "string" || typeof updatedAt !== "string") {
      throw new Error("ArgumentError: saved query catalog query requires readOnly boolean and timestamp strings.");
    }
    validateSavedQueryName(name);
    const tags = Array.isArray(item.tags)
      ? normalizeTags(item.tags.filter((tag): tag is string => typeof tag === "string"))
      : undefined;
    return {
      name,
      title: optionalString(item.title),
      description: optionalString(item.description),
      sql,
      defaultProfile,
      readOnly,
      allowProfileOverride: item.allowProfileOverride === true ? true : undefined,
      createdAt,
      updatedAt,
      tags,
    };
  });

  const names = new Set<string>();
  for (const query of queries) {
    if (names.has(query.name)) {
      throw new Error(`ArgumentError: duplicate saved query name ${query.name}.`);
    }
    names.add(query.name);
  }

  return {
    version: SAVED_QUERY_CATALOG_VERSION,
    queries,
  };
}

export async function loadSavedQueryCatalog(filePath: string): Promise<SavedQueryCatalog> {
  try {
    return parseSavedQueryCatalog(await readFile(filePath, "utf8"));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return emptySavedQueryCatalog();
    }
    throw err;
  }
}

export async function saveSavedQueryCatalog(filePath: string, catalog: SavedQueryCatalog): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const sorted: SavedQueryCatalog = {
    version: SAVED_QUERY_CATALOG_VERSION,
    queries: [...catalog.queries].sort((a, b) => a.name.localeCompare(b.name)),
  };
  await writeFile(filePath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

export function upsertSavedQuery(
  catalog: SavedQueryCatalog,
  input: SaveQueryInput,
  now = new Date()
): { catalog: SavedQueryCatalog; query: SavedQuery; created: boolean } {
  validateSavedQueryName(input.name);
  if (!input.sql.trim()) {
    throw new Error("ArgumentError: saved query sql must not be empty.");
  }
  if (!input.defaultProfile.trim()) {
    throw new Error("ArgumentError: saved query defaultProfile must not be empty.");
  }

  const nowIso = now.toISOString();
  const existing = catalog.queries.find((query) => query.name === input.name);
  const query: SavedQuery = {
    name: input.name,
    title: optionalString(input.title),
    description: optionalString(input.description),
    sql: input.sql,
    defaultProfile: input.defaultProfile,
    readOnly: input.readOnly,
    allowProfileOverride: input.allowProfileOverride === true ? true : undefined,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    tags: normalizeTags(input.tags),
  };
  const queries = existing
    ? catalog.queries.map((item) => item.name === input.name ? query : item)
    : [...catalog.queries, query];

  return {
    catalog: {
      version: SAVED_QUERY_CATALOG_VERSION,
      queries,
    },
    query,
    created: !existing,
  };
}

export function getSavedQuery(catalog: SavedQueryCatalog, name: string): SavedQuery {
  const query = catalog.queries.find((item) => item.name === name);
  if (!query) {
    throw new Error(`ArgumentError: saved query ${name} was not found.`);
  }
  return query;
}

export function deleteSavedQuery(
  catalog: SavedQueryCatalog,
  name: string
): { catalog: SavedQueryCatalog; deleted: boolean } {
  const queries = catalog.queries.filter((query) => query.name !== name);
  return {
    catalog: {
      version: SAVED_QUERY_CATALOG_VERSION,
      queries,
    },
    deleted: queries.length !== catalog.queries.length,
  };
}
