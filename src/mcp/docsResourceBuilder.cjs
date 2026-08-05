"use strict";

const LANGUAGE_SLUGS = Object.freeze([
  "basic-rules",
  "select",
  "arithmetic-expressions",
  "case-when",
  "string-number-functions",
  "where",
  "join",
  "group-by-aggregates",
  "having",
  "order-by",
  "limit-offset",
  "union",
  "with-cte",
  "show-apps-describe",
  "insert",
  "update",
  "upsert",
  "delete",
  "subtable-virtual-table",
  "reorder",
  "subqueries",
  "limitations",
  "ui-features",
  "explain",
  "batch-temp-tables",
  "assert",
]);

function fail(message) {
  throw new Error(`DocsResourceBuildError: ${message}`);
}

function documentTitle(source, label) {
  const match = /^#\s+(.+)$/m.exec(source);
  if (!match) fail(`${label}: H1 title is missing`);
  return match[1].trim();
}

function allH2Offsets(source) {
  const offsets = [];
  const regex = /^##\s+.+$/gm;
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    offsets.push(match.index);
  }
  return offsets;
}

function nextBoundary(source, start, shouldIgnoreHeading) {
  const regex = /^##\s+(.+)$/gm;
  regex.lastIndex = start;
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    if (!shouldIgnoreHeading(match[1])) return match.index;
  }
  return source.length;
}

function parseRequiredSections(source, options) {
  const { label, count, headingPattern, keyFor, uriBase, ignoreBoundary } = options;
  if (typeof source !== "string" || source.trim() === "") fail(`${label}: document is empty`);
  if (allH2Offsets(source).length === 0) fail(`${label}: H2 parse failed`);

  const found = new Map();
  const keys = new Set();
  for (let match = headingPattern.exec(source); match; match = headingPattern.exec(source)) {
    const number = Number(match[1]);
    const key = keyFor(number, match[2]);
    if (keys.has(key)) fail(`${label}: duplicate section key ${key}`);
    if (found.has(number)) fail(`${label}: duplicate chapter ${match[1]}`);
    const headingEnd = source.indexOf("\n", match.index);
    const contentStart = headingEnd < 0 ? source.length : headingEnd + 1;
    const end = nextBoundary(source, contentStart, ignoreBoundary);
    const body = source.slice(contentStart, end).trim();
    if (body === "") fail(`${label}: section ${key} is empty`);
    found.set(number, {
      key,
      heading: match[0].replace(/^##\s+/, "").trim(),
      text: source.slice(match.index, end).trimEnd(),
      uri: `${uriBase}/${key}`,
    });
    keys.add(key);
  }

  if (found.size === 0) fail(`${label}: required H2 sections could not be parsed`);
  const missing = [];
  for (let number = 1; number <= count; number++) {
    if (!found.has(number)) missing.push(number);
  }
  if (missing.length > 0) fail(`${label}: missing required chapters: ${missing.join(", ")}`);

  const sections = {};
  for (let number = 1; number <= count; number++) {
    const section = found.get(number);
    sections[section.key] = {
      heading: section.heading,
      text: section.text,
      uri: section.uri,
    };
  }
  return sections;
}

function buildIndex(title, sourcePath, uri, summary, sections, overview = "") {
  const lines = [
    `# ${title} index`,
    "",
    summary,
    "",
    `Source: \`${sourcePath}\``,
    "",
  ];
  if (overview) lines.push(overview, "");
  lines.push("## Sections", "");
  for (const section of Object.values(sections)) {
    lines.push(`- [${section.heading}](${section.uri})`);
  }
  lines.push("", `Index URI: ${uri}`);
  return lines.join("\n");
}

function extractH2Section(source, headingText, label) {
  const regex = new RegExp(`^##\\s+${headingText}\\s*$`, "m");
  const match = regex.exec(source);
  if (!match) fail(`${label}: required overview H2 is missing`);
  const headingEnd = source.indexOf("\n", match.index);
  const contentStart = headingEnd < 0 ? source.length : headingEnd + 1;
  const end = nextBoundary(source, contentStart, () => false);
  const body = source.slice(contentStart, end).trim();
  if (!body) fail(`${label}: required overview H2 is empty`);
  return source.slice(match.index, end).trimEnd();
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function buildDocsResourceMap(languageSource, recipesSource) {
  const languageUri = "ksql://language-reference";
  const recipesUri = "ksql://recipes";
  const baseLanguageSections = parseRequiredSections(languageSource, {
    label: "language reference",
    count: 26,
    headingPattern: /^##\s+([1-9]|1\d|2[0-6])\.\s+(.+)$/gm,
    keyFor: (number) => `${String(number).padStart(2, "0")}-${LANGUAGE_SLUGS[number - 1]}`,
    uriBase: languageUri,
    // Decimal H2 headings (10.1, 17.1, etc.) belong to their integer parent chapter.
    ignoreBoundary: (heading) => /^\d+\.\d+\s+/.test(heading)
      && !/^10\.1\s+ウィンドウ関数\s*$/.test(heading),
  });
  const windowText = extractH2Section(
    languageSource,
    "10\\.1 ウィンドウ関数",
    "language reference"
  );
  const languageSections = {};
  for (const [key, section] of Object.entries(baseLanguageSections)) {
    languageSections[key] = section;
    if (key === "10-order-by") {
      // 章番号つきキーで他セクション（01-basic-rules 〜 26-assert）と表記を揃える。
      // 旧キー window-functions は docsResources.ts のエイリアスで引き続き解決する。
      languageSections["10-1-window-functions"] = {
        heading: "10.1 ウィンドウ関数",
        text: windowText,
        uri: `${languageUri}/10-1-window-functions`,
      };
    }
  }
  const recipeSections = parseRequiredSections(recipesSource, {
    label: "recipes",
    count: 17,
    headingPattern: /^##\s+R([1-9]|1\d)\.\s+(.+)$/gm,
    keyFor: (number) => `r${number}`,
    uriBase: recipesUri,
    ignoreBoundary: () => false,
  });

  const languageTitle = documentTitle(languageSource, "language reference");
  const recipesTitle = documentTitle(recipesSource, "recipes");
  const recipePrinciples = extractH2Section(
    recipesSource,
    "設計原則（リラン可能バッチ）",
    "recipes"
  );
  return deepFreeze({
    languageReference: {
      title: languageTitle,
      index: buildIndex(
        languageTitle,
        "docs/ksql_language_reference.md",
        languageUri,
        "Syntax and dialect reference for kSQL. Read only the section needed for the current task.",
        languageSections
      ),
      sections: languageSections,
    },
    recipes: {
      title: recipesTitle,
      index: buildIndex(
        recipesTitle,
        "docs/ksql_batch_recipes.md",
        recipesUri,
        "Safe, rerunnable batch design recipes for CLI, MCP, and the plugin.",
        recipeSections,
        recipePrinciples
      ),
      sections: recipeSections,
    },
  });
}

module.exports = { LANGUAGE_SLUGS, buildDocsResourceMap };
