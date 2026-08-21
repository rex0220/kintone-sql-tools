import { DiagnosticCodes, diagnosticAt, type Diagnostic } from "./diagnostics";

export interface ScriptHeaderMeta {
  name: string | null;
  dependsOn: string[];
  timeout: number | null;
  dialect: 0 | 1;
}

export interface ScriptHeaderParseResult {
  meta: ScriptHeaderMeta;
  diagnostics: Diagnostic[];
  hasDirectives: boolean;
  /** End offset of the leading contiguous comment block. */
  headerEnd: number;
}

type HeaderKey = "name" | "depends_on" | "timeout" | "dialect";

const HEADER_LINE_RE = /^(\s*)--\s*@ksql\s+([^:\s]+)\s*:\s*(.*)$/i;

export function parseScriptHeader(source: string): ScriptHeaderParseResult {
  const meta: ScriptHeaderMeta = { name: null, dependsOn: [], timeout: null, dialect: 0 };
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<HeaderKey>();
  let hasDirectives = false;
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let headerEnd = offset;

  while (offset < source.length) {
    const lineEnd = findLineEnd(source, offset);
    const line = source.slice(offset, lineEnd.contentEnd);
    if (!/^\s*--/.test(line)) break;
    headerEnd = lineEnd.next;

    const match = HEADER_LINE_RE.exec(line);
    if (match) {
      hasDirectives = true;
      const rawKey = match[2];
      const key = rawKey.toLowerCase();
      const rawValue = match[3];
      const commentAt = rawValue.indexOf("#");
      const valuePart = commentAt < 0 ? rawValue : rawValue.slice(0, commentAt);
      const leading = valuePart.match(/^\s*/)?.[0].length ?? 0;
      const value = valuePart.trim();
      const valueOffset = offset + match.index + match[0].length - rawValue.length + leading;

      if (!isHeaderKey(key)) {
        diagnostics.push(diagnosticAt(source, valueOffset, {
          severity: "warning",
          code: DiagnosticCodes.HEADER_UNKNOWN_KEY,
          message: `Unknown @ksql header key "${rawKey}" was ignored.`,
        }));
      } else if (seen.has(key)) {
        diagnostics.push(diagnosticAt(source, valueOffset, {
          severity: "warning",
          code: DiagnosticCodes.HEADER_DUPLICATE_KEY,
          message: `Duplicate @ksql header key "${key}" was ignored; the first value is retained.`,
        }));
      } else {
        seen.add(key);
        applyHeaderValue(meta, key, value, source, valueOffset, diagnostics);
      }
    }
    offset = lineEnd.next;
  }

  return { meta, diagnostics, hasDirectives, headerEnd };
}

function isHeaderKey(value: string): value is HeaderKey {
  return value === "name" || value === "depends_on" || value === "timeout" || value === "dialect";
}

function applyHeaderValue(
  meta: ScriptHeaderMeta,
  key: HeaderKey,
  value: string,
  source: string,
  valueOffset: number,
  diagnostics: Diagnostic[]
): void {
  if (key === "name") {
    if (!value) {
      diagnostics.push(diagnosticAt(source, valueOffset, {
        severity: "error", code: DiagnosticCodes.HEADER_INVALID_NAME,
        message: "@ksql name must not be empty.",
      }));
    } else {
      meta.name = value;
    }
    return;
  }
  if (key === "depends_on") {
    const dependencies = value.split(",").map((item) => item.trim());
    if (!value || dependencies.some((item) => !item)) {
      diagnostics.push(diagnosticAt(source, valueOffset, {
        severity: "error", code: DiagnosticCodes.HEADER_INVALID_DEPENDS_ON,
        message: "@ksql depends_on must be a comma-separated list without empty items.",
      }));
    } else {
      meta.dependsOn = dependencies;
    }
    return;
  }
  if (key === "timeout") {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      diagnostics.push(diagnosticAt(source, valueOffset, {
        severity: "error", code: DiagnosticCodes.HEADER_INVALID_TIMEOUT,
        message: "@ksql timeout must be a positive integer.",
      }));
    } else {
      meta.timeout = Number(value);
    }
    return;
  }
  if (value !== "0" && value !== "1") {
    diagnostics.push(diagnosticAt(source, valueOffset, {
      severity: "error", code: DiagnosticCodes.HEADER_INVALID_DIALECT,
      message: "@ksql dialect must be 0 or 1.",
    }));
  } else {
    meta.dialect = Number(value) as 0 | 1;
  }
}

function findLineEnd(source: string, start: number): { contentEnd: number; next: number } {
  let i = start;
  while (i < source.length && source[i] !== "\r" && source[i] !== "\n") i++;
  const contentEnd = i;
  if (source[i] === "\r" && source[i + 1] === "\n") i += 2;
  else if (i < source.length) i++;
  return { contentEnd, next: i };
}
