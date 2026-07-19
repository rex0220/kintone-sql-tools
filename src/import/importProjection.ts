import type { SelectStatement } from "../types/ast";

/** Projection is evaluated by the existing SELECT scalar engine over this private source name. */
export const IMPORT_PROJECTION_SOURCE = "#__import_source";

export function bindImportProjection(projection: SelectStatement): SelectStatement {
  return { ...projection, from: { appId: 0, alias: null, cteName: IMPORT_PROJECTION_SOURCE } };
}
