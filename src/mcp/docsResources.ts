import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDocsResourceMap, type KsqlDocsResourceMap } from "./docsResourceBuilder.cjs";

declare const __KSQL_DOCS__: KsqlDocsResourceMap;

function loadFromRepoDocs(): KsqlDocsResourceMap {
  const docsDir = resolve(__dirname, "../../docs");
  return buildDocsResourceMap(
    readFileSync(resolve(docsDir, "ksql_language_reference.md"), "utf8"),
    readFileSync(resolve(docsDir, "ksql_batch_recipes.md"), "utf8")
  );
}

function freezeEmbeddedMap(map: KsqlDocsResourceMap): KsqlDocsResourceMap {
  for (const collection of [map.languageReference, map.recipes]) {
    for (const section of Object.values(collection.sections)) Object.freeze(section);
    Object.freeze(collection.sections);
    Object.freeze(collection);
  }
  return Object.freeze(map);
}

/** Production uses the build-time define. ts-jest and other non-bundle callers use repo docs. */
export const KSQL_DOCS: KsqlDocsResourceMap =
  typeof __KSQL_DOCS__ !== "undefined" ? freezeEmbeddedMap(__KSQL_DOCS__) : loadFromRepoDocs();

export const LANGUAGE_SECTION_KEYS = Object.freeze(Object.keys(KSQL_DOCS.languageReference.sections));
export const RECIPE_KEYS = Object.freeze(Object.keys(KSQL_DOCS.recipes.sections));

function frozenList<const T extends readonly string[]>(values: T): T {
  return Object.freeze(values);
}

export const KSQL_FUNCTION_CATALOG = Object.freeze({
  scalar: frozenList([
    "UPPER", "LOWER", "TRIM", "LTRIM", "RTRIM", "LENGTH", "LENGTH_CHAR", "SUBSTRING",
    "LEFT", "RIGHT", "INSTR", "CONCAT", "REPLACE", "REGEXP_LIKE", "REGEXP_REPLACE",
    "REGEXP_SUBSTR", "TRANSLATE", "COALESCE", "ISNULL", "NULLIF", "GREATEST", "LEAST",
    "LPAD", "RPAD", "ROUND", "FLOOR", "CEIL", "TRUNCATE", "ABS", "MOD", "POWER", "SQRT",
    "FORMAT", "CAST", "YEAR", "MONTH", "DAY", "DAYOFWEEK", "QUARTER", "WEEK",
    "DATE_FORMAT", "DATEDIFF", "DATE_ADD",
    "LAST_DAY", "CURRENT_DATE", "CURRENT_TIMESTAMP",
  ] as const),
  aggregate: frozenList([
    "COUNT", "SUM", "AVG", "MIN", "MAX", "GROUP_CONCAT",
    "STDDEV_POP", "STDDEV_SAMP", "VAR_POP", "VAR_SAMP", "MEDIAN", "MODE",
  ] as const),
  window: frozenList(["ROW_NUMBER", "RANK", "DENSE_RANK", "SUM", "COUNT", "AVG", "MIN", "MAX"] as const),
  contextual: frozenList([
    "TODAY", "NOW", "LOGINUSER", "PRIMARY_ORGANIZATION",
    "YESTERDAY", "TOMORROW", "FROM_TODAY",
    "THIS_WEEK", "LAST_WEEK", "NEXT_WEEK",
    "THIS_MONTH", "LAST_MONTH", "NEXT_MONTH",
    "THIS_YEAR", "LAST_YEAR", "NEXT_YEAR",
  ] as const),
  aliases: frozenList([
    "SUBSTR→SUBSTRING", "CONVERT→CAST", "CEILING→CEIL", "TRUNC→TRUNCATE", "POW→POWER",
  ] as const),
  syntax: frozenList([
    "IF(cond, then, else)", "||", "LIKE", "KLIKE", "IN", "BETWEEN", "IS NULL", "CASE WHEN",
  ] as const),
});

export const KSQL_DOCS_SECTION_KEYS = Object.freeze([
  "language-reference",
  ...LANGUAGE_SECTION_KEYS.map((key) => `language-reference/${key}`),
  "recipes",
  ...RECIPE_KEYS.map((key) => `recipes/${key}`),
]);

export function buildKsqlDocsIndex(): string {
  return [
    KSQL_DOCS.languageReference.index.trimEnd(),
    'Tool fallback example: ksql_docs {"section":"language-reference/05-string-number-functions"}',
    KSQL_DOCS.recipes.index.trimEnd(),
    'Tool fallback example: ksql_docs {"section":"recipes/r1"}',
    "## ksql_docs section keys",
    ...KSQL_DOCS_SECTION_KEYS.map((key) => `- ${key}`),
  ].join("\n\n");
}

export const KSQL_DOCS_INDEX = buildKsqlDocsIndex();

const VALID_KEY_HINT =
  "Valid keys: language-reference, language-reference/<key>, recipes, recipes/r1..r14. "
  + "Call ksql_docs without arguments for the full key list.";

/**
 * 旧キーの互換エイリアス（B132）。索引には出さず、解決だけ受け付ける。
 * v3.45.0 で `window-functions` を番号なしで追加したため、他の 26 セクションと表記が
 * 揃っていなかった。番号つきへ改めたが、旧キーを参照している利用側を壊さない。
 */
const LANGUAGE_SECTION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "window-functions": "10-1-window-functions",
});

export function resolveKsqlDocsSection(section?: string): string {
  if (section === undefined) return KSQL_DOCS_INDEX;
  const key = section.trim().replace(/^ksql:\/\//, "");
  if (key === "language-reference") return KSQL_DOCS.languageReference.index;
  if (key === "recipes") return KSQL_DOCS.recipes.index;
  if (key.startsWith("language-reference/")) {
    const rawKey = key.slice("language-reference/".length);
    const resolvedKey = LANGUAGE_SECTION_ALIASES[rawKey] ?? rawKey;
    const text = KSQL_DOCS.languageReference.sections[resolvedKey]?.text;
    if (text !== undefined) return text;
  }
  if (key.startsWith("recipes/")) {
    const text = KSQL_DOCS.recipes.sections[key.slice("recipes/".length)]?.text;
    if (text !== undefined) return text;
  }
  throw new Error(`ArgumentError: Unknown ksql_docs section key: ${key}. ${VALID_KEY_HINT}`);
}
