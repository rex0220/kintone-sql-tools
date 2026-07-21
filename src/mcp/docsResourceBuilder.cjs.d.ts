export interface KsqlDocSection {
  readonly heading: string;
  readonly text: string;
  readonly uri: string;
}

export interface KsqlDocCollection {
  readonly title: string;
  readonly index: string;
  readonly sections: Readonly<Record<string, KsqlDocSection>>;
}

export interface KsqlDocsResourceMap {
  readonly languageReference: KsqlDocCollection;
  readonly recipes: KsqlDocCollection;
}

export const LANGUAGE_SLUGS: readonly string[];
export function buildDocsResourceMap(
  languageSource: string,
  recipesSource: string
): KsqlDocsResourceMap;
