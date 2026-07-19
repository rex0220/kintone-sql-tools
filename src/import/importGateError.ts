const IMPORT_CAPABILITY_GATE_MARKER = "capability is disabled";

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

/** parser の IMPORT capability gate だけを面横断で識別する。 */
export function isImportCapabilityGateError(error: unknown): boolean {
  return errorMessage(error)?.includes(IMPORT_CAPABILITY_GATE_MARKER) === true;
}
