import { analyzeBatch } from "../core/batch";
import type { ManagedStatementExecutionContext } from "../execute";
import { KsqlFlowError } from "./errors";
import type {
  ExecutionContext,
  FlowNamedExportSink,
  Statement,
} from "./publicTypes";

const managedByPublicContext = new WeakMap<object, ManagedStatementExecutionContext>();

export function registerExportSinkContext(
  context: ExecutionContext,
  managed: ManagedStatementExecutionContext
): void {
  managedByPublicContext.set(context as object, managed);
}

export function unregisterExportSinkContext(context: ExecutionContext): void {
  managedByPublicContext.delete(context as object);
}

function exportError(code: string, message: string): KsqlFlowError {
  return new KsqlFlowError(code, `${code}: ${message}`);
}

function isIdentifierStart(codePoint: number): boolean {
  return (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a)
    || codePoint === 0x5f
    || codePoint === 0x24
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x3400 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xff01 && codePoint <= 0xff60);
}

/** Sink name rule shared with the CLI `--export-csv <name>=<path>` parser. */
export function isExportSinkName(name: string): boolean {
  return !name.startsWith("#") && isTempIdentifier(name);
}

function isTempIdentifier(name: string): boolean {
  const characters = Array.from(name);
  return characters.length > 0
    && isIdentifierStart(characters[0].codePointAt(0)!)
    && characters.slice(1).every((character) => {
      const codePoint = character.codePointAt(0)!;
      return isIdentifierStart(codePoint) || (codePoint >= 0x30 && codePoint <= 0x39);
    });
}

/** Validate declarations synchronously before any statement or API call. */
export function normalizeExportSinkDeclarations(
  statements: readonly Statement[],
  declarations: readonly FlowNamedExportSink[] | undefined
): ReadonlySet<string> {
  if (declarations === undefined || declarations.length === 0) return new Set();

  const names = new Set<string>();
  for (const declaration of declarations) {
    const name = declaration?.name;
    if (typeof name !== "string" || name.startsWith("#") || !isTempIdentifier(name)) {
      throw exportError(
        "ExportSinkInvalidNameError",
        "an export sink name must be a valid temp-table identifier without a leading #."
      );
    }
    if (names.has(name)) {
      throw exportError(
        "ExportSinkDuplicateError",
        "an export sink name is declared more than once."
      );
    }
    names.add(name);
  }

  const tempNames = new Set([...names].map((name) => `#${name}`));
  for (const tempName of tempNames) {
    const creates = statements.filter(
      (statement) => statement.type === "CREATE_TEMP_TABLE" && statement.name === tempName
    );
    if (creates.length > 1) {
      throw exportError(
        "ExportSinkDuplicateError",
        "an export sink must correspond to exactly one CREATE TEMP TABLE statement."
      );
    }
  }

  const analysis = analyzeBatch([...statements]);
  for (const tempName of tempNames) {
    const createIndexes = analysis.statements
      .filter((item) => item.tempTablesCreated.includes(tempName))
      .map((item) => item.index);
    const explicitCreate = createIndexes.find(
      (index) => statements[index]?.type === "CREATE_TEMP_TABLE"
    );
    if (explicitCreate === undefined) {
      if (createIndexes.length > 0) {
        throw exportError(
          "ExportSinkInvalidTargetError",
          "an export sink cannot target a DML or validation result."
        );
      }
      throw exportError(
        "ExportSinkNotFoundError",
        "an export sink has no corresponding CREATE TEMP TABLE statement."
      );
    }

    let live = false;
    for (const item of analysis.statements) {
      if (item.tempTablesCreated.includes(tempName)) live = true;
      if (item.tempTablesDropped.includes(tempName)) live = false;
    }
    if (!live) {
      throw exportError(
        "ExportSinkNotFoundError",
        "the export sink temp table does not exist in the final batch state."
      );
    }
  }
  return tempNames;
}

export function getManagedExportSinkContext(
  context: ExecutionContext
): ManagedStatementExecutionContext | undefined {
  return managedByPublicContext.get(context as object);
}
