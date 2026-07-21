export const RESOURCE_INDEX_URIS = [
  "ksql://language-reference",
  "ksql://recipes",
];

export const RESOURCE_TEMPLATE_URIS = [
  "ksql://language-reference/{section}",
  "ksql://recipes/{recipe}",
];

export function textResource(result, expectedUri, assert, label = expectedUri) {
  const content = result?.contents?.[0];
  assert(result?.contents?.length === 1, `${label} must return exactly one content item.`);
  assert(content?.uri === expectedUri, `${label} returned an unexpected URI.`);
  assert(content?.mimeType === "text/markdown", `${label} must be text/markdown.`);
  assert(typeof content?.text === "string" && content.text.length > 0, `${label} text is missing.`);
  return content.text;
}

export function indexedUris(indexText, baseUri, keyPattern, assert, label) {
  const escapedBase = baseUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const uris = [...indexText.matchAll(new RegExp(`${escapedBase}/([^\\s)]+)`, "g"))]
    .map((match) => ({ uri: match[0], key: match[1] }));
  assert(uris.length > 0, `${label} index contains no section URIs.`);
  assert(
    uris.every(({ key }) => keyPattern.test(key)),
    `${label} index contains a key outside the P2 generation rule.`
  );
  return uris;
}

export function chapterUri(indexed, prefix, assert, label) {
  const match = indexed.find(({ key }) => key.startsWith(prefix));
  assert(match, `${label} is missing from the resource index.`);
  return match.uri;
}

export async function assertResourceCatalog(client, assert, options = {}) {
  const listed = await client.listResources();
  assert(
    JSON.stringify(listed.resources.map(({ uri }) => uri)) === JSON.stringify(RESOURCE_INDEX_URIS),
    `Unexpected resource list: ${listed.resources.map(({ uri }) => uri).join(", ")}`
  );
  assert(
    listed.resources.every(({ mimeType }) => mimeType === "text/markdown"),
    "Every resource index must be text/markdown."
  );

  const templates = await client.listResourceTemplates();
  assert(
    JSON.stringify(templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate))
      === JSON.stringify(RESOURCE_TEMPLATE_URIS),
    `Unexpected resource template list: ${templates.resourceTemplates
      .map(({ uriTemplate }) => uriTemplate).join(", ")}`
  );

  const languageIndexResult = await client.readResource({ uri: RESOURCE_INDEX_URIS[0] });
  const languageIndex = textResource(languageIndexResult, RESOURCE_INDEX_URIS[0], assert);
  assert(languageIndex.includes("## Sections"), "Language index must contain its table of contents.");
  const languageUris = indexedUris(
    languageIndex,
    RESOURCE_INDEX_URIS[0],
    /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/,
    assert,
    "Language"
  );

  const recipesIndexResult = await client.readResource({ uri: RESOURCE_INDEX_URIS[1] });
  const recipesIndex = textResource(recipesIndexResult, RESOURCE_INDEX_URIS[1], assert);
  const recipeUris = indexedUris(recipesIndex, RESOURCE_INDEX_URIS[1], /^r\d+$/, assert, "Recipe");

  const representative = [
    [chapterUri(languageUris, "02-", assert, "SELECT chapter"), ["## 2. SELECT"]],
  ];
  if (options.extended !== false) {
    representative.push(
      [chapterUri(languageUris, "17-", assert, "VALIDATE ONLY chapter"), ["## 17.1 VALIDATE ONLY"]],
      [chapterUri(languageUris, "22-", assert, "limitations chapter"), ["## 22. 制限事項"]],
      [chapterUri(recipeUris, "r6", assert, "R6 recipe"), ["## R6.", "ON ERROR SKIP"]]
    );
  }

  for (const [uri, needles] of representative) {
    const text = textResource(await client.readResource({ uri }), uri, assert);
    for (const needle of needles) {
      assert(text.includes(needle), `${uri} must contain source text "${needle}".`);
    }
  }

  return { languageIndex, languageUris, recipesIndex, recipeUris };
}

