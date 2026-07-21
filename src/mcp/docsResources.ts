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
