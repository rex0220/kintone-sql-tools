export interface DisplayOptions {
  userFormat?: "full" | "name" | "code";
  arrayFormat?: "full" | "join";
  tableFormat?: "full" | "count";
  dateFormat?: "full" | "local";
  attachmentFormat?: "full" | "name" | "fileKey";
}

interface UserObj { code: string; name?: string; }
interface AttachmentObj { fileKey?: string; name?: string; }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function formatDisplayText(v: unknown, opts: DisplayOptions = {}): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") {
    try {
      return formatDisplayText(JSON.stringify(v), opts);
    } catch {
      return String(v);
    }
  }
  return formatCellValue(v, opts);
}

function formatCellValue(raw: string, opts: DisplayOptions): string {
  const userFmt = opts.userFormat ?? "full";
  const arrFmt = opts.arrayFormat ?? "full";
  const tblFmt = opts.tableFormat ?? "full";
  const dateFmt = opts.dateFormat ?? "full";
  const attFmt = opts.attachmentFormat ?? "full";

  const trimmed = raw.trim();
  if (dateFmt !== "full" && (DATE_RE.test(trimmed) || DATETIME_RE.test(trimmed))) {
    return fmtDateStr(trimmed);
  }

  if (userFmt === "full" && arrFmt === "full" && tblFmt === "full" && attFmt === "full") {
    return raw;
  }

  if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw;
  }

  if (isUserObj(parsed)) return fmtUser(parsed, userFmt);
  if (!Array.isArray(parsed)) return raw;
  if (parsed.length === 0) return raw;

  if (tblFmt === "count" && parsed.every(isSubtableRow)) {
    return `${parsed.length} 行`;
  }

  if (parsed.every(isUserObj)) {
    const parts = parsed.map((u) => fmtUser(u, userFmt));
    return arrFmt === "join" ? parts.join(", ") : parts.join(" / ");
  }

  if (parsed.every(isAttachmentObj)) {
    if (attFmt === "full") return raw;
    const parts = parsed
      .map((a) => (attFmt === "name" ? a.name ?? "" : a.fileKey ?? ""))
      .filter((x) => x !== "");
    return parts.join(", ");
  }

  if (arrFmt === "join") {
    return parsed.map((x) => String(x)).join(", ");
  }

  return raw;
}

function fmtDateStr(raw: string): string {
  if (DATE_RE.test(raw)) return raw.replace(/-/g, "/");
  if (DATETIME_RE.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return raw;
}

function isUserObj(v: unknown): v is UserObj {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "code" in v
    && typeof (v as Record<string, unknown>).code === "string";
}

function isAttachmentObj(v: unknown): v is AttachmentObj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "fileKey" in obj || "name" in obj;
}

function fmtUser(u: UserObj, fmt: "full" | "name" | "code"): string {
  if (fmt === "name") return u.name ?? u.code;
  if (fmt === "code") return u.code;
  return JSON.stringify(u);
}

function isSubtableRow(v: unknown): v is { id: string; value: Record<string, unknown> } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.value === "object" && obj.value !== null;
}
