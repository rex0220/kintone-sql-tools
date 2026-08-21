export class KsqlFlowError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "KsqlFlowError";
    this.code = code;
    this.cause = cause;
  }
}

export function normalizeFlowError(error: unknown): KsqlFlowError {
  if (error instanceof KsqlFlowError) return error;
  if (error instanceof Error) {
    const code = error.name !== "Error"
      ? error.name
      : error.message.match(/^([A-Za-z][A-Za-z0-9]*Error):/)?.[1] ?? "FLOW_ERROR";
    return new KsqlFlowError(code, error.message, error);
  }
  const shaped = error as { code?: unknown; message?: unknown } | null;
  const code = typeof shaped?.code === "string" ? shaped.code : "FLOW_ERROR";
  const message = typeof shaped?.message === "string" ? shaped.message : String(error);
  return new KsqlFlowError(code, message, error);
}
