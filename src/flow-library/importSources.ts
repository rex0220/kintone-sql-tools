import { KsqlFlowError } from "./errors";
import type {
  FlowImportProviderErrorCode,
  FlowImportSourceResolver,
  FlowNamedImportSource,
} from "./publicTypes";

export class FlowImportProviderError extends Error {
  readonly code: FlowImportProviderErrorCode;
  declare readonly cause?: unknown;

  constructor(code: FlowImportProviderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = code;
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: cause,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }
}

export function createImportSourceResolver(
  sources: readonly FlowNamedImportSource[]
): FlowImportSourceResolver {
  const byName = new Map<string, FlowNamedImportSource["loader"]>();
  for (const source of sources) {
    if (source.name.length === 0) {
      throw new KsqlFlowError(
        "ArgumentError",
        "ArgumentError: IMPORT source name must not be empty."
      );
    }
    if (byName.has(source.name)) {
      throw new KsqlFlowError(
        "ImportSourceDuplicateError",
        "ImportSourceDuplicateError: an IMPORT source name is registered more than once."
      );
    }
    byName.set(source.name, source.loader);
  }
  return (name) => byName.get(name);
}
