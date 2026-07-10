// ============================================================
// ksql CLI entrypoint (MVP: SELECT-only)
// ============================================================

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { homedir, tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  execute,
  executeBatch,
  buildBatchExplainPlans,
  formatDisplayText,
  OperationCancelledError,
  parseSqlStatement,
  parseSqlStatements,
  analyzeBatch,
  type BatchAnalysis,
  type BatchExecuteResult,
  type BatchStatementResult,
  type DisplayOptions,
  type AssertResult,
  type ExecuteResult,
  type KintoneClient,
  type SelectResult,
} from "../core";
import { buildBatchEnvelope } from "../output/batchEnvelope";
import { decideConsoleInput, decideRun } from "./consoleInput";
import { getGlobalRequestGate, withRequestGate } from "../api/requestGate";
import { createNodeKintoneClient } from "./nodeKintoneClient";
import {
  buildCacheContext,
  extractAppIds,
  formatResolvedAppProfiles,
  normalizeAppKey,
  normalizeSqlAppProfiles,
  parseTokenFile,
  parseTokenMap,
} from "../node/appProfiles";
import {
  collectDmlTargetFields,
  getInsertValuesCount,
  getStatementType,
  hasWhereClause,
  isDmlType,
  isNoFromSelectStatement,
} from "../node/dmlGuard";

export {
  extractAppIds,
  normalizeAppKey,
  normalizeSqlAppProfiles,
  parseTokenFile,
  parseTokenMap,
} from "../node/appProfiles";

export const HELP_TEXT = `ksql - Execute SQL against kintone apps

Usage:
  ksql [options]
  ksql -e "<SQL>"
  ksql -f <file.sql>

Options:
  -e, --execute <sql>        Execute SQL string
  -f, --file <path>          Execute SQL file
  --console                  Start interactive console mode
  --dry-run                  Parse and show execution plan only
  --format <type>            Output format: table | json | jsonl | csv | markdown | md
                             (batch + json: prints one JSON envelope for the whole batch)
  --max-records <n>          Max records to fetch (default: 500)
  --fetch-parallel <n>       Parallel page fetches per query: 1-10 (default: 3)
  --on-limit <mode>          On record limit: error | truncate
  --timeout <ms>             Request timeout in milliseconds (default: 30000)
  --config <path>            Config file path (default: ./ksql.config.json)
  --profile <name>           Profile name in config
  --base-url <url>           kintone base URL
  --guest-space-id <id>      Guest space ID (uses /k/guest/<id>/v1 APIs)
  --auth <type>              Auth type: token | userpass | auto
  --username <name>          Login username (for userpass auth)
  --password <pass>          Login password (for userpass auth)
  --token <token>            Single-app token
  --token-map <mapping>      App token map (APP100=...,APP101=...)
  --token-file <path>        JSON file for app token map
  --app <id>                 Default app id context
  --diag-record-id <id>      Diagnostic: GET record.json by app+id
  --no-header                Hide table header
  --pretty                   Pretty-print JSON output
  --user-format <mode>       User field format: full | name | code
  --array-format <mode>      Array field format: full | join
  --table-format <mode>      Subtable format: full | count
  --date-format <mode>       Date format: full | local
  --attachment-format <mode> Attachment format: full | name | fileKey
  --output <path>            Write output to file
  --no-color                 Disable ANSI colors
  --quiet                    Suppress non-result logs
  --debug                    Show request/response debug logs
  --debug-url                Show only HTTP request URL debug logs
  --debug-headers            Show request headers in debug logs (masked)
  --exit-on-empty            Return exit code 1 when rowCount is 0
  --allow-dml                Enable UPDATE/DELETE/INSERT/UPSERT/REORDER execution
  --yes                      Skip DML confirmation prompt
  --allow-without-where      Allow UPDATE/DELETE without WHERE
  --dml-max-rows <n>         Max affected rows for DML guard (default: 100)
  --continue-on-error        Batch: keep executing after a statement error (read-only batch only)
  -h, --help                 Show help
  -v, --version              Show version
`;

type OutputFormat = "table" | "json" | "jsonl" | "csv" | "markdown";
type OnLimitMode = "error" | "truncate";
type AuthMode = "token" | "userpass" | "auto";

interface CliConfig {
  defaultProfile?: string;
  profiles?: Record<string, {
    baseUrl?: string;
    guestSpaceId?: number;
    auth?: AuthMode;
    username?: string;
    password?: string;
    passwordEnv?: string;
    app?: number;
    tokenMap?: Record<string, string>;
    query?: {
      maxRecords?: number;
      fetchParallel?: number;
      onLimit?: OnLimitMode;
      timeout?: number;
      /** kintone API の同時リクエスト数上限（プロセス内グローバル。env KSQL_MAX_CONCURRENT が優先） */
      maxConcurrent?: number;
    };
    output?: {
      format?: OutputFormat;
      pretty?: boolean;
      noHeader?: boolean;
      noColor?: boolean;
      quiet?: boolean;
      output?: string;
      exitOnEmpty?: boolean;
      userFormat?: DisplayOptions["userFormat"];
      arrayFormat?: DisplayOptions["arrayFormat"];
      tableFormat?: DisplayOptions["tableFormat"];
      dateFormat?: DisplayOptions["dateFormat"];
      attachmentFormat?: DisplayOptions["attachmentFormat"];
    };
    dml?: {
      allowDml?: boolean;
      yes?: boolean;
      allowWithoutWhere?: boolean;
      maxRows?: number;
    };
  }>;
}

interface ParsedArgs {
  help: boolean;
  version: boolean;
  executeSql: string | null;
  filePath: string | null;
  console: boolean;
  dryRun: boolean;
  format: OutputFormat | null;
  maxRecords: number | null;
  fetchParallel: number | null;
  onLimit: OnLimitMode | null;
  timeout: number | null;
  configPath: string | null;
  profile: string | null;
  baseUrl: string | null;
  guestSpaceId: number | null;
  auth: AuthMode | null;
  username: string | null;
  password: string | null;
  token: string | null;
  tokenMap: Record<string, string>;
  tokenFile: string | null;
  app: number | null;
  diagRecordId: number | null;
  noHeader: boolean;
  pretty: boolean;
  outputPath: string | null;
  noColor: boolean;
  quiet: boolean;
  debug: boolean;
  debugUrl: boolean;
  debugHeaders: boolean;
  exitOnEmpty: boolean;
  allowDml: boolean;
  yes: boolean;
  allowWithoutWhere: boolean;
  continueOnError: boolean;
  dmlMaxRows: number | null;
  userFormat: DisplayOptions["userFormat"] | null;
  arrayFormat: DisplayOptions["arrayFormat"] | null;
  tableFormat: DisplayOptions["tableFormat"] | null;
  dateFormat: DisplayOptions["dateFormat"] | null;
  attachmentFormat: DisplayOptions["attachmentFormat"] | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    version: false,
    executeSql: null,
    filePath: null,
    console: false,
    dryRun: false,
    format: null,
    maxRecords: null,
    fetchParallel: null,
    onLimit: null,
    timeout: null,
    configPath: null,
    profile: null,
    baseUrl: null,
    guestSpaceId: null,
    auth: null,
    username: null,
    password: null,
    token: null,
    tokenMap: {},
    tokenFile: null,
    app: null,
    diagRecordId: null,
    noHeader: false,
    pretty: false,
    outputPath: null,
    noColor: false,
    quiet: false,
    debug: false,
    debugUrl: false,
    debugHeaders: false,
    exitOnEmpty: false,
    allowDml: false,
    yes: false,
    allowWithoutWhere: false,
    continueOnError: false,
    dmlMaxRows: null,
    userFormat: null,
    arrayFormat: null,
    tableFormat: null,
    dateFormat: null,
    attachmentFormat: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "-v" || a === "--version") { out.version = true; continue; }
    if (a === "--console") { out.console = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--no-header") { out.noHeader = true; continue; }
    if (a === "--pretty") { out.pretty = true; continue; }
    if (a === "--no-color") { out.noColor = true; continue; }
    if (a === "--quiet") { out.quiet = true; continue; }
    if (a === "--debug") { out.debug = true; continue; }
    if (a === "--debug-url") { out.debugUrl = true; continue; }
    if (a === "--debug-headers") { out.debugHeaders = true; continue; }
    if (a === "--exit-on-empty") { out.exitOnEmpty = true; continue; }
    if (a === "--allow-dml") { out.allowDml = true; continue; }
    if (a === "--yes") { out.yes = true; continue; }
    if (a === "--allow-without-where") { out.allowWithoutWhere = true; continue; }
    if (a === "--continue-on-error") { out.continueOnError = true; continue; }

    const v = argv[i + 1];
    if (a === "-e" || a === "--execute") { out.executeSql = v ?? ""; i++; continue; }
    if (a === "-f" || a === "--file") { out.filePath = v ?? ""; i++; continue; }
    if (a === "--config") { out.configPath = v ?? ""; i++; continue; }
    if (a === "--profile") { out.profile = v ?? ""; i++; continue; }
    if (a === "--base-url") { out.baseUrl = v ?? ""; i++; continue; }
    if (a === "--guest-space-id") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error("ArgumentError: --guest-space-id must be a positive integer.");
      out.guestSpaceId = n;
      i++;
      continue;
    }
    if (a === "--auth") {
      if (v === "token" || v === "userpass" || v === "auto") out.auth = v;
      else throw new Error("ArgumentError: --auth must be token|userpass|auto.");
      i++;
      continue;
    }
    if (a === "--username") { out.username = v ?? ""; i++; continue; }
    if (a === "--password") { out.password = v ?? ""; i++; continue; }
    if (a === "--token") { out.token = v ?? ""; i++; continue; }
    if (a === "--token-map") { out.tokenMap = parseTokenMap(v ?? ""); i++; continue; }
    if (a === "--token-file") { out.tokenFile = v ?? ""; i++; continue; }
    if (a === "--output") { out.outputPath = v ?? ""; i++; continue; }
    if (a === "--user-format") {
      if (v === "full" || v === "name" || v === "code") out.userFormat = v;
      else throw new Error("ArgumentError: --user-format must be full|name|code.");
      i++;
      continue;
    }
    if (a === "--array-format") {
      if (v === "full" || v === "join") out.arrayFormat = v;
      else throw new Error("ArgumentError: --array-format must be full|join.");
      i++;
      continue;
    }
    if (a === "--table-format") {
      if (v === "full" || v === "count") out.tableFormat = v;
      else throw new Error("ArgumentError: --table-format must be full|count.");
      i++;
      continue;
    }
    if (a === "--date-format") {
      if (v === "full" || v === "local") out.dateFormat = v;
      else throw new Error("ArgumentError: --date-format must be full|local.");
      i++;
      continue;
    }
    if (a === "--attachment-format") {
      if (v === "full" || v === "name" || v === "fileKey") out.attachmentFormat = v;
      else throw new Error("ArgumentError: --attachment-format must be full|name|fileKey.");
      i++;
      continue;
    }
    if (a === "--format") {
      const normalized = normalizeOutputFormat(v ?? "");
      if (normalized) out.format = normalized;
      else throw new Error("ArgumentError: --format must be table|json|jsonl|csv|markdown|md.");
      i++;
      continue;
    }
    if (a === "--on-limit") {
      if (v === "error" || v === "truncate") out.onLimit = v;
      else throw new Error("ArgumentError: --on-limit must be error|truncate.");
      i++;
      continue;
    }
    if (a === "--max-records") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error("ArgumentError: --max-records must be a positive integer.");
      out.maxRecords = n;
      i++;
      continue;
    }
    if (a === "--fetch-parallel") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("ArgumentError: --fetch-parallel must be an integer between 1 and 10.");
      out.fetchParallel = n;
      i++;
      continue;
    }
    if (a === "--timeout") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error("ArgumentError: --timeout must be a positive integer.");
      out.timeout = n;
      i++;
      continue;
    }
    if (a === "--app") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error("ArgumentError: --app must be a positive integer.");
      out.app = n;
      i++;
      continue;
    }
    if (a === "--diag-record-id") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error("ArgumentError: --diag-record-id must be a positive integer.");
      out.diagRecordId = n;
      i++;
      continue;
    }
    if (a === "--dml-max-rows") {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error("ArgumentError: --dml-max-rows must be a positive integer.");
      out.dmlMaxRows = n;
      i++;
      continue;
    }

    throw new Error(`ArgumentError: unknown option ${a}`);
  }

  return out;
}

function getVersion(): string {
  const pkgPath = resolve(__dirname, "../package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function loadConfig(configPath: string): CliConfig {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as CliConfig;
}

function resolveTokenValue(raw: string): string {
  if (raw.startsWith("env:")) {
    const envKey = raw.slice(4);
    const envVal = process.env[envKey];
    if (!envVal) throw new Error(`AuthError: environment variable "${envKey}" is not set.`);
    return envVal;
  }
  return raw;
}

function envString(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v : null;
}

function envInt(name: string): number | null {
  const v = envString(name);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function envBool(name: string): boolean | null {
  const v = envString(name);
  if (v === null) return null;
  if (v === "1" || v.toLowerCase() === "true") return true;
  if (v === "0" || v.toLowerCase() === "false") return false;
  return null;
}

function envFormat(name: string): OutputFormat | null {
  const v = envString(name);
  return normalizeOutputFormat(v);
}

function envOnLimit(name: string): OnLimitMode | null {
  const v = envString(name);
  if (v === "error" || v === "truncate") return v;
  return null;
}

function envAuth(name: string): AuthMode | null {
  const v = envString(name);
  if (v === "token" || v === "userpass" || v === "auto") return v;
  return null;
}

function normalizeUnique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isSystemLikeFieldCode(code: string): boolean {
  return code.startsWith("_") || code.startsWith("$");
}

function getAffectedCount(result: Exclude<ExecuteResult, SelectResult | AssertResult>): number {
  if (result.type === "INSERT") return result.insertedCount;
  if (result.type === "UPDATE") return result.updatedCount;
  if (result.type === "DELETE") return result.deletedCount;
  if (result.type === "UPSERT") return result.insertedCount + result.updatedCount;
  if (result.type === "REORDER") return result.reorderedParentCount;
  return 0;
}

/** 単文 ASSERT 成功時の出力。json / jsonl は MCP と同じ payload、他は1行メッセージ */
function buildAssertOutput(result: AssertResult, format: OutputFormat, pretty: boolean): string {
  const payload = { ok: true, type: result.type, condition: result.condition };
  if (format === "json") return JSON.stringify(payload, null, pretty ? 2 : 0);
  if (format === "jsonl") return JSON.stringify(payload);
  return `assertion ok: ${result.condition}`;
}

function buildMutationOutput(
  result: Exclude<ExecuteResult, SelectResult | AssertResult>,
  format: OutputFormat,
  noHeader: boolean,
  pretty: boolean
): string {
  const row: Record<string, string | number> = { type: result.type };
  if (result.type === "INSERT") {
    row.insertedCount = result.insertedCount;
  } else if (result.type === "UPDATE") {
    row.updatedCount = result.updatedCount;
  } else if (result.type === "DELETE") {
    row.deletedCount = result.deletedCount;
  } else if (result.type === "UPSERT") {
    row.insertedCount = result.insertedCount;
    row.updatedCount = result.updatedCount;
  } else if (result.type === "REORDER") {
    row.reorderedParentCount = result.reorderedParentCount;
  }

  if (format === "json") return JSON.stringify(row, null, pretty ? 2 : 0);
  if (format === "jsonl") return JSON.stringify(row);

  const cols = Object.keys(row);
  if (format === "markdown") {
    const lines: string[] = [];
    lines.push(`| ${cols.map(markdownEscapeCell).join(" | ")} |`);
    lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
    lines.push(`| ${cols.map((k) => markdownEscapeCell(String(row[k]))).join(" | ")} |`);
    return lines.join("\n");
  }
  if (format === "csv") {
    const lines: string[] = [];
    if (!noHeader) lines.push(cols.join(","));
    lines.push(cols.map((k) => csvEscape(String(row[k]))).join(","));
    return lines.join("\n");
  }

  const lines: string[] = [];
  if (!noHeader) lines.push(cols.join("\t"));
  lines.push(cols.map((k) => String(row[k])).join("\t"));
  return lines.join("\n");
}

async function promptDmlConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("ArgumentError: interactive confirmation requires TTY. Use --yes to skip confirmation.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    const answer = await new Promise<string>((resolveQ) => rl.question(`${message}\nProceed? (yes/no): `, resolveQ));
    return parseConfirmAnswer(answer);
  } finally {
    rl.close();
  }
}

export function parseConfirmAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  // 一部端末で同一キーが重複入力される事象対策（例: "yyeess"）
  const deduped = normalized.replace(/(.)\1+/g, "$1");
  return deduped === "yes";
}

export function buildOutput(
  result: SelectResult,
  format: OutputFormat,
  noHeader: boolean,
  pretty: boolean,
  display: DisplayOptions
): string {
  if (format === "json") {
    const obj = {
      columns: result.columns,
      rowCount: result.rowCount,
      warnings: result.warnings ?? [],
      rows: result.rows,
    };
    return JSON.stringify(obj, null, pretty ? 2 : 0);
  }
  if (format === "jsonl") return result.rows.map((r) => JSON.stringify(r)).join("\n");
  if (format === "markdown") {
    const cols = result.columns.length > 0 ? result.columns : Object.keys(result.rows[0] ?? {});
    const lines: string[] = [];
    lines.push(`| ${cols.map(markdownEscapeCell).join(" | ")} |`);
    lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
    for (const row of result.rows) {
      lines.push(`| ${cols.map((c) => markdownEscapeCell(toCellText(row[c], display))).join(" | ")} |`);
    }
    return lines.join("\n");
  }
  if (format === "csv") {
    const cols = result.columns.length > 0 ? result.columns : Object.keys(result.rows[0] ?? {});
    const lines: string[] = [];
    if (!noHeader) lines.push(cols.map(csvEscape).join(","));
    for (const row of result.rows) lines.push(cols.map((c) => csvEscape(toCellText(row[c], display))).join(","));
    return lines.join("\n");
  }

  const cols = result.columns.length > 0 ? result.columns : Object.keys(result.rows[0] ?? {});
  const lines: string[] = [];
  if (!noHeader) lines.push(cols.join("\t"));
  for (const row of result.rows) lines.push(cols.map((c) => toCellText(row[c], display)).join("\t"));
  return lines.join("\n");
}

function toCellText(v: unknown, display: DisplayOptions): string {
  return formatDisplayText(v, display);
}

function csvEscape(v: string): string {
  if (!/[",\n]/.test(v)) return v;
  return `"${v.replace(/"/g, "\"\"")}"`;
}

function markdownEscapeCell(v: string): string {
  return v
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

function normalizeOutputFormat(v: string | null | undefined): OutputFormat | null {
  if (!v) return null;
  const x = v.trim().toLowerCase();
  if (x === "md") return "markdown";
  if (x === "table" || x === "json" || x === "jsonl" || x === "csv" || x === "markdown") return x;
  return null;
}

function toExitCodeFromError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("ArgumentError:")) return 2;
  if (msg.startsWith("AuthError:")) return 3;
  return 1;
}

// ------------------------------------------------------------
// バッチ実行結果の表示（フェーズ1 S7）
//   - 結果セット（素の SELECT 等）は stdout（結果間は空行区切り）
//   - 文ごとのサマリ行は stderr（--quiet で抑止）
// ------------------------------------------------------------

export function buildBatchStatementSummary(s: BatchStatementResult): string {
  const parts = [`[${s.index + 1}] ${s.type}`, s.status];
  if (s.tempTable) parts.push(`temp=${s.tempTable}`);
  if (s.rowCount !== undefined) parts.push(`rows=${s.rowCount}`);
  if (s.status === "success" && s.result?.type === "SELECT") parts.push(`rowCount=${s.result.rowCount}`);
  if (s.status === "success" && s.result && s.result.type !== "SELECT") {
    const r = s.result;
    if (r.type === "INSERT") parts.push(`inserted=${r.insertedCount}`);
    else if (r.type === "UPDATE") parts.push(`updated=${r.updatedCount}`);
    else if (r.type === "DELETE") parts.push(`deleted=${r.deletedCount}`);
    else if (r.type === "UPSERT") parts.push(`inserted=${r.insertedCount} updated=${r.updatedCount}`);
    else if (r.type === "REORDER") parts.push(`reordered=${r.reorderedParentCount}`);
  }
  if (s.status === "error" && s.error) parts.push(s.error.message);
  if (s.status === "skipped" && s.skippedReason) parts.push(`reason=${s.skippedReason}`);
  return parts.join(" ");
}

/**
 * DML バッチの確認プロンプト本文（仕様 §8.3: バッチ全体で1回、
 * 全 DML 文の一覧 — タイプ / 対象アプリ / WHERE 有無 — を表示）
 */
export function buildBatchDmlConfirmMessage(analysis: BatchAnalysis): string {
  const lines = ["[DML Confirm] batch"];
  for (const s of analysis.statements) {
    if (!s.isDml) continue;
    // 表示するのは書き込み対象アプリのみ（appIds は SELECT ソースや
    // サブクエリの参照先も含むため、変更対象と誤認させない）
    const app = s.targetAppId !== null ? `APP${s.targetAppId}` : "-";
    lines.push(`  [${s.index + 1}] ${s.statementType} app=${app} where=${s.hasWhere ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

export function writeBatchOutput(
  batch: BatchExecuteResult,
  opts: {
    format: OutputFormat;
    noHeader: boolean;
    pretty: boolean;
    displayOptions: DisplayOptions;
    outputPath: string | null;
    quiet: boolean;
  }
): number {
  // json はバッチ全体を MCP と同一のエンベロープ（§6.2）で単一 JSON として出力する
  //（v1.10.0。従来の「SELECT 結果 JSON の空行区切り連結」は廃止 — CHANGELOG 参照）。
  // table / csv / markdown / jsonl は従来出力を維持（jsonl は行ストリームの契約を守る）
  const output = opts.format === "json"
    ? JSON.stringify(buildBatchEnvelope(batch), null, opts.pretty ? 2 : 0)
    : buildBatchResultsOutput(batch, opts);
  if (!opts.quiet) {
    for (const s of batch.statements) process.stderr.write(`${buildBatchStatementSummary(s)}\n`);
  }
  if (opts.outputPath) writeFileSync(opts.outputPath, `${output}\n`, "utf-8");
  else if (output) process.stdout.write(`${output}\n`);

  if (batch.ok) return 0;
  const firstError = batch.statements.find((s) => s.status === "error");
  return firstError?.error
    ? toExitCodeFromError(new Error(firstError.error.message))
    : 1;
}

/** 従来のバッチ出力: SELECT 結果を結果セットごとに整形し空行区切りで連結する */
function buildBatchResultsOutput(
  batch: BatchExecuteResult,
  opts: { format: OutputFormat; noHeader: boolean; pretty: boolean; displayOptions: DisplayOptions }
): string {
  const outputs: string[] = [];
  for (const s of batch.statements) {
    if (s.status === "success" && s.result?.type === "SELECT") {
      outputs.push(buildOutput(s.result, opts.format, opts.noHeader, opts.pretty, opts.displayOptions));
    }
  }
  return outputs.join("\n\n");
}

export function shouldExitOnEmpty(
  dryRun: boolean,
  exitOnEmpty: boolean,
  rowCount: number
): boolean {
  if (dryRun) return false;
  return exitOnEmpty && rowCount === 0;
}

function createDryRunClient(): KintoneClient {
  const notUsed = async (): Promise<never> => {
    throw new Error("DryRunError: API call should not happen in dry-run.");
  };
  return {
    getRecords: notUsed,
    postRecords: notUsed,
    putRecords: notUsed,
    deleteRecords: notUsed,
    getApps: notUsed,
    getFields: notUsed,
  };
}

async function runDiagnosticRecordGet(params: {
  baseUrl: string;
  guestSpaceId: number | null;
  appId: number;
  recordId: number;
  timeoutMs: number;
  debug: boolean;
  debugHeaders: boolean;
  debugUrlOnly: boolean;
  auth:
    | { type: "token"; token: string }
    | { type: "userpass"; username: string; password: string };
}): Promise<void> {
  const qs = `app=${encodeURIComponent(String(params.appId))}&id=${encodeURIComponent(String(params.recordId))}`;
  const apiRoot = params.guestSpaceId !== null
    ? `/k/guest/${params.guestSpaceId}/v1`
    : "/k/v1";
  const url = `${params.baseUrl.replace(/\/+$/, "")}${apiRoot}/record.json?${qs}`;
  const headers = new Headers();
  if (params.auth.type === "token") {
    headers.set("X-Cybozu-API-Token", params.auth.token);
  } else {
    const encoded = Buffer.from(`${params.auth.username}:${params.auth.password}`, "utf-8").toString("base64");
    headers.set("X-Cybozu-Authorization", encoded);
  }
  headers.set("Accept", "application/json");

  const shouldLog = params.debug || params.debugUrlOnly;
  if (shouldLog) {
    process.stderr.write(`[debug] request GET ${url}\n`);
    if (params.debugHeaders && !params.debugUrlOnly) {
      const authLine = params.auth.type === "token" ? "X-Cybozu-API-Token=***" : "X-Cybozu-Authorization=***";
      process.stderr.write(`[debug] request-headers ${authLine} Content-Type=(none) Accept=application/json\n`);
    }
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  const bodyText = await res.text();
  if (shouldLog && !params.debugUrlOnly) {
    process.stderr.write(`[debug] response status=${res.status} body=${bodyText}\n`);
  }
  if (!res.ok) {
    throw new Error(`kintone API error ${res.status}: ${bodyText}`);
  }
  process.stdout.write(`${bodyText}\n`);
}

function buildTokenMapArg(map: Record<string, string>): string | null {
  const pairs = Object.entries(map).map(([k, v]) => `${k}=${v}`);
  return pairs.length > 0 ? pairs.join(",") : null;
}

type ConsoleMetaAction =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "run" }
  | { kind: "clear" }
  | { kind: "show-last" }
  | { kind: "show-buffer" }
  | { kind: "edit-buffer" }
  | { kind: "show-config" }
  | { kind: "show-history"; limit: number | null; find: string | null }
  | { kind: "rerun"; index: number }
  | { kind: "save"; path: string; append: boolean }
  | { kind: "set-profile"; profile: string }
  | { kind: "set-format"; format: OutputFormat }
  | { kind: "set-dryrun"; enabled: boolean }
  | { kind: "error"; message: string };

export function parseConsoleMetaCommand(line: string): ConsoleMetaAction {
  const t = line.trim();
  if (!t.startsWith(":")) return { kind: "none" };
  if (t === ":help") return { kind: "help" };
  if (t === ":exit" || t === ":quit") return { kind: "exit" };
  if (t === ":run") return { kind: "run" };
  if (t === ":clear") return { kind: "clear" };
  if (t === ":last") return { kind: "show-last" };
  if (t === ":buffer") return { kind: "show-buffer" };
  if (t === ":edit") return { kind: "edit-buffer" };
  if (t === ":show config") return { kind: "show-config" };
  if (t === ":history") return { kind: "show-history", limit: null, find: null };
  if (t.startsWith(":history ")) {
    const arg = t.slice(9).trim();
    if (!arg) return { kind: "show-history", limit: null, find: null };
    if (arg.startsWith("find ")) {
      const keyword = arg.slice(5).trim();
      if (!keyword) return { kind: "error", message: "ArgumentError: :history find requires a keyword" };
      return { kind: "show-history", limit: null, find: keyword };
    }
    const n = Number(arg);
    if (!Number.isInteger(n) || n <= 0) {
      return { kind: "error", message: "ArgumentError: :history must be ':history', ':history <n>', or ':history find <keyword>'" };
    }
    return { kind: "show-history", limit: n, find: null };
  }
  if (t.startsWith(":rerun ")) {
    const n = Number(t.slice(7).trim());
    if (!Number.isInteger(n) || n <= 0) return { kind: "error", message: "ArgumentError: :rerun requires a positive integer index" };
    return { kind: "rerun", index: n };
  }
  if (t.startsWith(":save ")) {
    const raw = t.slice(6).trim();
    const append = raw.startsWith("--append ");
    const path = append ? raw.slice(9).trim() : raw;
    if (!path) return { kind: "error", message: "ArgumentError: :save requires a file path" };
    return { kind: "save", path, append };
  }
  if (t.startsWith(":profile ")) {
    const profile = t.slice(9).trim();
    if (!profile) return { kind: "error", message: "ArgumentError: :profile requires a profile name" };
    return { kind: "set-profile", profile };
  }
  if (t.startsWith(":format ")) {
    const v = normalizeOutputFormat(t.slice(8).trim());
    if (v) {
      return { kind: "set-format", format: v };
    }
    return { kind: "error", message: "ArgumentError: :format must be table|json|jsonl|csv|markdown|md" };
  }
  if (t.startsWith(":dryrun ")) {
    const v = t.slice(8).trim();
    if (v === "on") return { kind: "set-dryrun", enabled: true };
    if (v === "off") return { kind: "set-dryrun", enabled: false };
    return { kind: "error", message: "ArgumentError: :dryrun must be on|off" };
  }
  return { kind: "error", message: "Unknown command. Type :help" };
}

function pushOpt(argv: string[], key: string, value: string | number | null | undefined): void {
  if (value === null || value === undefined || value === "") return;
  argv.push(key, String(value));
}

function buildReplExecArgv(base: ParsedArgs, sql: string, dryRun: boolean, format: OutputFormat | null): string[] {
  const argv: string[] = ["-e", sql];
  if (dryRun) argv.push("--dry-run");
  if (format) argv.push("--format", format);

  pushOpt(argv, "--config", base.configPath);
  pushOpt(argv, "--profile", base.profile);
  pushOpt(argv, "--base-url", base.baseUrl);
  pushOpt(argv, "--guest-space-id", base.guestSpaceId);
  pushOpt(argv, "--auth", base.auth);
  pushOpt(argv, "--username", base.username);
  pushOpt(argv, "--password", base.password);
  pushOpt(argv, "--token", base.token);
  pushOpt(argv, "--token-file", base.tokenFile);
  pushOpt(argv, "--app", base.app);
  pushOpt(argv, "--max-records", base.maxRecords);
  pushOpt(argv, "--fetch-parallel", base.fetchParallel);
  pushOpt(argv, "--on-limit", base.onLimit);
  pushOpt(argv, "--timeout", base.timeout);
  pushOpt(argv, "--output", base.outputPath);
  pushOpt(argv, "--user-format", base.userFormat);
  pushOpt(argv, "--array-format", base.arrayFormat);
  pushOpt(argv, "--table-format", base.tableFormat);
  pushOpt(argv, "--date-format", base.dateFormat);
  pushOpt(argv, "--attachment-format", base.attachmentFormat);
  pushOpt(argv, "--dml-max-rows", base.dmlMaxRows);

  const tokenMapArg = buildTokenMapArg(base.tokenMap);
  if (tokenMapArg) argv.push("--token-map", tokenMapArg);

  if (base.noHeader) argv.push("--no-header");
  if (base.pretty) argv.push("--pretty");
  if (base.noColor) argv.push("--no-color");
  if (base.quiet) argv.push("--quiet");
  if (base.debug) argv.push("--debug");
  if (base.debugUrl) argv.push("--debug-url");
  if (base.debugHeaders) argv.push("--debug-headers");
  if (base.exitOnEmpty) argv.push("--exit-on-empty");
  // REPL 側で確認済みなので、子実行では再確認を行わない。
  if (base.allowDml) argv.push("--yes");
  if (base.allowDml) argv.push("--allow-dml");
  if (base.allowWithoutWhere) argv.push("--allow-without-where");
  if (base.continueOnError) argv.push("--continue-on-error");
  return argv;
}

function normalizeConsoleInputLine(line: string): string {
  // 端末によっては前回ログ断片が先頭に混入することがあるため、既知パターンを除去する。
  return line
    .replace(/^\(last exit code:\s*\d+\)\s*/i, "")
    .replace(/^ksql>\s*/i, "")
    .replace(/^\.\.\.\s*/, "");
}

function buildReplExecArgvWithProfile(
  base: ParsedArgs,
  sql: string,
  dryRun: boolean,
  format: OutputFormat | null,
  profile: string | null
): string[] {
  const next: ParsedArgs = { ...base, profile };
  return buildReplExecArgv(next, sql, dryRun, format);
}

async function runWithArgv(argv: string[]): Promise<number> {
  const savedArgv = process.argv;
  process.argv = [savedArgv[0], savedArgv[1], ...argv];
  try {
    return await run();
  } finally {
    process.argv = savedArgv;
  }
}

type ConsolePromptResult =
  | { kind: "line"; line: string }
  | { kind: "sigint" }
  | { kind: "eof" };

interface ConsoleEventQueue {
  hasBuffered: () => boolean;
  next: () => Promise<ConsolePromptResult>;
  dispose: () => void;
}

function createConsoleEventQueue(rl: ReturnType<typeof createInterface>): ConsoleEventQueue {
  const queue: ConsolePromptResult[] = [];
  let waiter: ((ev: ConsolePromptResult) => void) | null = null;

  const push = (ev: ConsolePromptResult): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(ev);
      return;
    }
    queue.push(ev);
  };

  const onLine = (line: string): void => push({ kind: "line", line });
  const onSigint = (): void => push({ kind: "sigint" });
  const onClose = (): void => push({ kind: "eof" });

  rl.on("line", onLine);
  rl.on("SIGINT", onSigint);
  rl.on("close", onClose);

  return {
    hasBuffered: (): boolean => queue.length > 0,
    next: async (): Promise<ConsolePromptResult> => {
      if (queue.length > 0) return queue.shift()!;
      return await new Promise<ConsolePromptResult>((resolveEv) => {
        waiter = resolveEv;
      });
    },
    dispose: (): void => {
      rl.off("line", onLine);
      rl.off("SIGINT", onSigint);
      rl.off("close", onClose);
    },
  };
}

async function runWithArgvCapture(argv: string[]): Promise<{ code: number; stdout: string }> {
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  const patched: typeof process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk ?? "");
    captured += text;
    return original(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write;

  process.stdout.write = patched;
  try {
    const code = await runWithArgv(argv);
    return { code, stdout: captured };
  } finally {
    process.stdout.write = original;
  }
}

async function confirmDmlInConsole(
  sql: string,
  opts: { allowDml: boolean; yes: boolean; dryRun: boolean },
  queue?: ConsoleEventQueue,
  defaultProfile = "dev"
): Promise<boolean> {
  if (!opts.allowDml || opts.yes || opts.dryRun) return true;
  try {
    const normalized = normalizeSqlAppProfiles(sql, defaultProfile);
    const statements = parseSqlStatements(normalized.normalizedSql);

    // バッチ: DML を含む場合はバッチ全体で1回の確認（全 DML 文の一覧を表示。仕様 §8.3）
    if (statements.length > 1) {
      const analysis = analyzeBatch(statements);
      if (!analysis.containsDml) return true;
      const message = buildBatchDmlConfirmMessage(analysis);
      if (queue) {
        process.stdout.write(`${message}\nProceed? (yes/no): `);
        const input = await queue.next();
        if (input.kind !== "line") return false;
        return parseConfirmAnswer(input.line);
      }
      return await promptDmlConfirm(message);
    }

    const stmt = statements[0];
    const stmtType = getStatementType(stmt);
    if (!isDmlType(stmtType)) return true;
    const compact = sql.replace(/\s+/g, " ").trim();
    if (queue) {
      process.stdout.write(`[DML Confirm] type=${stmtType}\nquery=${compact}\nProceed? (yes/no): `);
      const input = await queue.next();
      if (input.kind !== "line") return false;
      return parseConfirmAnswer(input.line);
    }
    return await promptDmlConfirm(`[DML Confirm] type=${stmtType}\nquery=${compact}`);
  } catch {
    return true;
  }
}

function getHistoryPath(): string {
  return join(homedir(), ".ksql_history");
}

function loadHistory(maxItems = 200): string[] {
  const p = getHistoryPath();
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return lines.slice(-maxItems);
  } catch {
    return [];
  }
}

function appendHistory(sql: string): void {
  const p = getHistoryPath();
  try {
    appendFileSync(p, `${sql.replace(/\s+/g, " ").trim()}\n`, "utf-8");
  } catch {
    // ignore history write errors
  }
}

function editBufferWithExternalEditor(current: string): string {
  const editor = process.env.KSQL_EDITOR ?? process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");
  const dir = mkdtempSync(join(tmpdir(), "ksql-edit-"));
  const filePath = join(dir, "query.sql");
  try {
    writeFileSync(filePath, current, "utf-8");
    const cmd = `"${editor}" "${filePath}"`;
    const res = spawnSync(cmd, { stdio: "inherit", shell: true });
    if (res.error) throw res.error;
    if ((res.status ?? 0) !== 0) {
      throw new Error(`Editor exited with code ${res.status ?? 1}`);
    }
    return readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runConsole(base: ParsedArgs): Promise<number> {
  if (base.filePath || base.executeSql || base.diagRecordId !== null) {
    process.stderr.write("ArgumentError: --console cannot be combined with -e/-f/--diag-record-id.\n");
    return 2;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let dryRun = base.dryRun;
  let format: OutputFormat | null = base.format;
  let profile = base.profile;
  const history: string[] = loadHistory();
  let lastOutput = "";
  let lastSql = "";
  let lastResolvedProfiles = "(none)";
  let buffer = "";
  let emptyPromptSigintArmed = false;
  const queue = createConsoleEventQueue(rl);

  process.stdout.write("kSQL Console (type :help)\n");
  process.stdout.write(
    [
      "session:",
      `  profile=${profile ?? "(default)"}`,
      `  auth=${base.auth ?? "(auto)"}`,
      `  format=${format ?? "(default)"}`,
      `  dryrun=${dryRun ? "on" : "off"}`,
      `  allow-dml=${base.allowDml ? "on" : "off"}`,
    ].join("\n") + "\n"
  );

  try {
    while (true) {
      if (!queue.hasBuffered()) {
        process.stdout.write(buffer.length > 0 ? "... " : "ksql> ");
      }
      const input = await queue.next();
      if (input.kind === "eof") {
        process.stdout.write("(EOF) console closed\n");
        return 0;
      }
      if (input.kind === "sigint") {
        if (buffer.trim().length > 0) {
          buffer = "";
          emptyPromptSigintArmed = false;
          process.stdout.write("^C\n(input buffer canceled)\n");
          continue;
        }
        if (emptyPromptSigintArmed) {
          process.stdout.write("^C\n");
          return 0;
        }
        emptyPromptSigintArmed = true;
        process.stdout.write("^C\n(press Ctrl+C again to exit)\n");
        continue;
      }

      const line = normalizeConsoleInputLine(input.line);
      const t = line.trim();
      emptyPromptSigintArmed = false;

      // メタコマンドはバッファ非空でも解釈する（SQL としてバッファに混入させない）
      if (t.startsWith(":")) {
        const meta = parseConsoleMetaCommand(t);
        if (meta.kind === "none") {
          // unreachable（":" 始まりは必ずメタとして解釈される）
        } else if (meta.kind === "exit") {
          return 0;
        } else if (meta.kind === "run") {
          const runDecision = decideRun(buffer);
          if (runDecision.kind === "error") {
            // バッファは保持する（:edit / :clear で修正できるように）
            process.stderr.write(`${runDecision.message}\n`);
            continue;
          }
          const sql = runDecision.sql.trim();
          // DML を含むバッチは REPL 側でバッチ全体の確認を行う（子実行には
          // --yes が付与されるため、ここで確認しないと無確認実行になる）。
          // キャンセル時はバッファを保持する（:edit / :clear で修正可能）
          {
            const ok = await confirmDmlInConsole(sql, {
              allowDml: base.allowDml,
              yes: base.yes,
              dryRun,
            }, queue, profile ?? "dev");
            if (!ok) {
              process.stderr.write("DML was cancelled by user.\n");
              continue;
            }
          }
          buffer = "";
          lastSql = sql;
          lastResolvedProfiles = formatResolvedAppProfiles(sql, profile ?? "dev");
          history.push(sql);
          appendHistory(sql);
          const { code, stdout } = await runWithArgvCapture(buildReplExecArgvWithProfile(base, sql, dryRun, format, profile));
          lastOutput = stdout;
          if (code !== 0) process.stderr.write(`(last exit code: ${code})\n`);
          continue;
        } else if (meta.kind === "help") {
          process.stdout.write(
            [
              "console commands:",
              "  :help",
              "  :exit | :quit",
              "  :run",
              "  :clear",
              "  :last",
              "  :buffer",
              "  :edit",
              "  :show config",
              "  :history",
              "  :history <n>",
              "  :history find <keyword>",
              "  :rerun <n>",
              "  :save <path>",
              "  :save --append <path>",
              "  :profile <name>",
              "  :format <table|json|jsonl|csv|markdown|md>",
              "  :dryrun <on|off>",
              "shortcuts:",
              "  Ctrl+C: cancel input buffer; press twice on empty buffer to exit",
              "  Ctrl+D: exit console",
            ].join("\n") + "\n"
          );
          continue;
        } else if (meta.kind === "clear") {
          buffer = "";
          process.stdout.write("(input buffer cleared)\n");
          continue;
        } else if (meta.kind === "show-last") {
          if (!lastSql) process.stdout.write("(last sql is empty)\n");
          else process.stdout.write(`${lastSql}\n`);
          continue;
        } else if (meta.kind === "show-buffer") {
          if (!buffer.trim()) process.stdout.write("(buffer is empty)\n");
          else process.stdout.write(`${buffer}\n`);
          continue;
        } else if (meta.kind === "edit-buffer") {
          const seed = buffer.trim().length > 0 ? buffer : lastSql;
          if (!seed.trim()) {
            process.stdout.write("(buffer is empty)\n");
            continue;
          }
          try {
            buffer = editBufferWithExternalEditor(seed);
            process.stdout.write("(buffer updated from editor)\n");
          } catch (err) {
            process.stderr.write(`EditorError: ${err instanceof Error ? err.message : String(err)}\n`);
          }
          continue;
        } else if (meta.kind === "show-config") {
          const lines = [
            `profile=${profile ?? "(default)"}`,
            `format=${format ?? "(default)"}`,
            `dryrun=${dryRun ? "on" : "off"}`,
            `base-url=${base.baseUrl ?? "(from env/config)"}`,
            `guest-space-id=${base.guestSpaceId ?? "(none)"}`,
            `auth=${base.auth ?? "(auto)"}`,
            `app=${base.app ?? "(from SQL or config)"}`,
            `resolved-app-profiles=${lastResolvedProfiles}`,
            `allow-dml=${base.allowDml ? "on" : "off"}`,
            `dml-max-rows=${base.dmlMaxRows ?? "(default)"}`,
          ];
          process.stdout.write(`${lines.join("\n")}\n`);
          continue;
        } else if (meta.kind === "show-history") {
          let view = history.map((sqlItem, i) => ({ sql: sqlItem, index: i + 1 }));
          if (meta.find) {
            const key = meta.find.toLowerCase();
            view = view.filter((item) => item.sql.toLowerCase().includes(key));
          }
          if (meta.limit !== null) {
            view = view.slice(-meta.limit);
          }

          if (view.length === 0) {
            process.stdout.write("(history is empty)\n");
          } else {
            const lines = view.map((item) => `${item.index}. ${item.sql.replace(/\s+/g, " ").trim()}`);
            process.stdout.write(`${lines.join("\n")}\n`);
          }
          continue;
        } else if (meta.kind === "rerun") {
          if (meta.index > history.length) {
            process.stderr.write(`ArgumentError: :rerun index out of range (1-${history.length})\n`);
            continue;
          }
          const sql = history[meta.index - 1];
          const ok = await confirmDmlInConsole(sql, {
            allowDml: base.allowDml,
            yes: base.yes,
            dryRun,
          }, queue, profile ?? "dev");
          if (!ok) {
            process.stderr.write("DML was cancelled by user.\n");
            continue;
          }
          lastSql = sql;
          lastResolvedProfiles = formatResolvedAppProfiles(sql, profile ?? "dev");
          process.stdout.write(`rerun: ${sql.replace(/\s+/g, " ").trim()}\n`);
          const { code, stdout } = await runWithArgvCapture(buildReplExecArgvWithProfile(base, sql, dryRun, format, profile));
          lastOutput = stdout;
          if (code !== 0) process.stderr.write(`(last exit code: ${code})\n`);
          continue;
        } else if (meta.kind === "save") {
          if (!lastOutput) {
            process.stderr.write("ArgumentError: no previous output to save\n");
            continue;
          }
          try {
            if (meta.append) {
              appendFileSync(meta.path, lastOutput, "utf-8");
              process.stdout.write(`saved (append): ${meta.path}\n`);
            } else {
              writeFileSync(meta.path, lastOutput, "utf-8");
              process.stdout.write(`saved: ${meta.path}\n`);
            }
          } catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          }
          continue;
        } else if (meta.kind === "set-profile") {
          profile = meta.profile;
          process.stdout.write(`profile=${profile}\n`);
          continue;
        } else if (meta.kind === "set-format") {
          format = meta.format;
          process.stdout.write(`format=${meta.format}\n`);
          continue;
        } else if (meta.kind === "set-dryrun") {
          dryRun = meta.enabled;
          process.stdout.write(`dryrun=${meta.enabled ? "on" : "off"}\n`);
          continue;
        } else {
          process.stderr.write(`${meta.message}\n`);
          continue;
        }
      }

      // 6段判定（仕様 §8.2。メタコマンドは上で処理済み）: バッチ構築モード /
      // `;` 終端までの蓄積（従来互換）/ 完結時の単文・複文実行 /
      // 継続可能な失敗の蓄積 / typo の即エラー + バッファ破棄
      const decision = decideConsoleInput(buffer, line);
      if (decision.kind === "ignore") continue;
      if (decision.kind === "continue") {
        buffer = decision.buffer;
        continue;
      }
      if (decision.kind === "error") {
        buffer = "";
        process.stderr.write(`${decision.message}\n(input buffer cleared)\n`);
        continue;
      }
      if (decision.kind === "meta") continue; // unreachable（":" 始まりは上で処理済み）

      const isBatchExec = decision.kind === "execute-batch";
      const sql = isBatchExec
        ? decision.sql.trim()
        : decision.sql.replace(/;\s*$/, "").trim();
      buffer = "";
      if (!sql) continue;
      {
        // DML 確認（単文は従来形式、バッチは全 DML 文の一覧で1回。
        // confirmDmlInConsole が DML を含まない入力には true を返す）
        const ok = await confirmDmlInConsole(sql, {
          allowDml: base.allowDml,
          yes: base.yes,
          dryRun,
        }, queue, profile ?? "dev");
        if (!ok) {
          process.stderr.write("DML was cancelled by user.\n");
          continue;
        }
      }
      lastSql = sql;
      lastResolvedProfiles = formatResolvedAppProfiles(sql, profile ?? "dev");
      history.push(sql);
      appendHistory(sql);

      const { code, stdout } = await runWithArgvCapture(buildReplExecArgvWithProfile(base, sql, dryRun, format, profile));
      lastOutput = stdout;
      if (code !== 0) {
        process.stderr.write(`(last exit code: ${code})\n`);
      }
    }
  } finally {
    queue.dispose();
    rl.close();
  }
}

async function run(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }
  if (args.console) {
    return await runConsole(args);
  }
  if (args.executeSql && args.filePath) {
    process.stderr.write("ArgumentError: -e/--execute and -f/--file cannot be used together.\n");
    return 2;
  }
  if (!args.executeSql && !args.filePath && args.diagRecordId === null) {
    process.stderr.write("ArgumentError: specify -e/--execute or -f/--file. Use --help for details.\n");
    return 2;
  }

  const configPath = args.configPath ?? envString("KSQL_CONFIG") ?? "./ksql.config.json";
  let config: CliConfig = {};
  try { config = loadConfig(configPath); } catch { /* optional */ }

  const profileName = args.profile ?? envString("KSQL_PROFILE") ?? config.defaultProfile ?? "dev";
  const profile = config.profiles?.[profileName] ?? {};

  let sql: string | null = null;
  let hasProfileSyntax = false;
  let appBindingByMappedApp = new Map<number, { appId: number; profile: string }>();
  let parsedStmt: unknown = null;
  let stmtType = "SELECT";
  let hasWhere = true;
  let insertValuesCount: number | null = null;
  let isDmlStatement = false;
  let isBatchSql = false;
  let batchContainsDml = false;
  let batchAnalysis: BatchAnalysis | null = null;
  if (args.diagRecordId === null) {
    sql = args.executeSql;
    if (!sql && args.filePath) sql = readFileSync(args.filePath, "utf-8");
    if (!sql || !sql.trim()) {
      process.stderr.write("ArgumentError: SQL is empty.\n");
      return 2;
    }

    try {
      const normalized = normalizeSqlAppProfiles(sql, profileName);
      sql = normalized.normalizedSql;
      hasProfileSyntax = normalized.hasProfileSyntax;
      appBindingByMappedApp = normalized.appBindingByMappedApp;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }

    try {
      const statements = parseSqlStatements(sql);
      if (statements.length > 1) {
        // 複文バッチ（フェーズ1: read-only のみ。DML バッチはフェーズ2 M2）
        // バッチのガード（--allow-dml / dry-run / 確認プロンプト）は
        // 設定解決後にまとめて判定する（allowDml がここでは未解決のため）
        batchAnalysis = analyzeBatch(statements);
        isBatchSql = true;
        batchContainsDml = batchAnalysis.containsDml;
      } else {
        const stmt = parseSqlStatement(sql);
        parsedStmt = stmt;
        stmtType = getStatementType(stmt);
        isDmlStatement = isDmlType(stmtType);
        hasWhere = hasWhereClause(stmt);
        insertValuesCount = getInsertValuesCount(stmt);

        const supported = stmtType === "SELECT"
          || stmtType === "UNION"
          || stmtType === "WITH"
          || stmtType === "EXPLAIN"
          || stmtType === "SHOW_APPS"
          || stmtType === "DESCRIBE"
          || isDmlStatement;
        if (!supported) {
          process.stderr.write(`ArgumentError: unsupported statement type in CLI: ${stmtType}\n`);
          return 2;
        }
      }
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  const maxRecords = args.maxRecords ?? envInt("KSQL_MAX_RECORDS") ?? profile.query?.maxRecords ?? 500;
  const fetchParallel = args.fetchParallel ?? envInt("KSQL_FETCH_PARALLEL") ?? profile.query?.fetchParallel ?? 3;
  const onLimit = args.onLimit ?? envOnLimit("KSQL_ON_LIMIT") ?? profile.query?.onLimit ?? "error";
  const timeout = args.timeout ?? envInt("KSQL_TIMEOUT") ?? profile.query?.timeout ?? 30000;
  if (!Number.isInteger(fetchParallel) || fetchParallel < 1 || fetchParallel > 10) {
    process.stderr.write("ArgumentError: fetch-parallel must be an integer between 1 and 10.\n");
    return 2;
  }
  const rawFormat = args.format ?? envFormat("KSQL_FORMAT") ?? profile.output?.format ?? "table";
  const format = normalizeOutputFormat(rawFormat);
  if (!format) {
    process.stderr.write("ArgumentError: format must be table|json|jsonl|csv|markdown|md.\n");
    return 2;
  }
  const noHeader = args.noHeader || envBool("KSQL_NO_HEADER") === true || Boolean(profile.output?.noHeader);
  const pretty = args.pretty || envBool("KSQL_PRETTY") === true || Boolean(profile.output?.pretty);
  const noColor = args.noColor || envBool("KSQL_NO_COLOR") === true || Boolean(profile.output?.noColor);
  const quiet = args.quiet || envBool("KSQL_QUIET") === true || Boolean(profile.output?.quiet);
  const debug = args.debug || args.debugUrl || envBool("KSQL_DEBUG") === true || envBool("KSQL_DEBUG_URL") === true;
  const debugHeaders = args.debugHeaders || envBool("KSQL_DEBUG_HEADERS") === true;
  const outputPath = args.outputPath ?? envString("KSQL_OUTPUT") ?? profile.output?.output ?? null;
  const exitOnEmpty = args.exitOnEmpty || envBool("KSQL_EXIT_ON_EMPTY") === true || Boolean(profile.output?.exitOnEmpty);
  const allowDml = args.allowDml || envBool("KSQL_ALLOW_DML") === true || Boolean(profile.dml?.allowDml);
  const yes = args.yes || envBool("KSQL_YES") === true || Boolean(profile.dml?.yes);
  const allowWithoutWhere = args.allowWithoutWhere || envBool("KSQL_ALLOW_WITHOUT_WHERE") === true || Boolean(profile.dml?.allowWithoutWhere);
  const dmlMaxRows = args.dmlMaxRows ?? envInt("KSQL_DML_MAX_ROWS") ?? profile.dml?.maxRows ?? 100;
  if (format === "markdown" && noHeader) {
    process.stderr.write("ArgumentError: --no-header cannot be used with --format markdown|md.\n");
    return 2;
  }
  void noColor; // reserved for future colorized output
  const displayOptions: DisplayOptions = {
    userFormat: args.userFormat ?? profile.output?.userFormat ?? "full",
    arrayFormat: args.arrayFormat ?? profile.output?.arrayFormat ?? "full",
    tableFormat: args.tableFormat ?? profile.output?.tableFormat ?? "full",
    dateFormat: args.dateFormat ?? profile.output?.dateFormat ?? "full",
    attachmentFormat: args.attachmentFormat ?? profile.output?.attachmentFormat ?? "full",
  };

  const appIds = sql ? extractAppIds(sql) : [];
  const defaultApp = args.app ?? envInt("KSQL_APP") ?? profile.app ?? null;
  if (appIds.length === 0 && defaultApp !== null) appIds.push(defaultApp);
  const allowNoFromSelect = isNoFromSelectStatement(parsedStmt) || stmtType === "SHOW_APPS";
  if (appIds.length === 0 && !allowNoFromSelect && !args.dryRun && args.diagRecordId === null) {
    process.stderr.write("ArgumentError: no APPxxx found in SQL and --app is not set.\n");
    return 2;
  }

  if (isBatchSql) {
    // 単文の DML と同じく、DML を含むバッチは dry-run でも --allow-dml を要求する
    if (batchContainsDml && !allowDml) {
      process.stderr.write("ArgumentError: DML is disabled. Use --allow-dml to enable UPDATE/DELETE/INSERT/UPSERT/REORDER.\n");
      return 2;
    }
    if (args.dryRun) {
      // バッチ dry-run: 全文のプランを表示して終了（kintone アクセスなし。DML 込みでも可）
      const plans = buildBatchExplainPlans(sql!);
      const out: string[] = [];
      plans.statements.forEach((p) => {
        if (p.index > 0) out.push("");
        out.push(`[${p.index + 1}] ${p.type}`);
        out.push(...p.plan);
      });
      process.stdout.write(`${out.join("\n")}\n`);
      return 0;
    }
  }

  if (isDmlStatement) {
    if (hasProfileSyntax && stmtType === "DELETE") {
      process.stderr.write("ArgumentError: @profile is not supported for DELETE yet.\n");
      return 2;
    }
    if (!allowDml) {
      process.stderr.write("ArgumentError: DML is disabled. Use --allow-dml to enable UPDATE/DELETE/INSERT/UPSERT/REORDER.\n");
      return 2;
    }
    if ((stmtType === "UPDATE" || stmtType === "DELETE") && !hasWhere && !allowWithoutWhere) {
      process.stderr.write("ArgumentError: UPDATE/DELETE without WHERE is blocked. Use --allow-without-where to override.\n");
      return 2;
    }
    if (insertValuesCount !== null && insertValuesCount > dmlMaxRows) {
      process.stderr.write(`ArgumentError: INSERT rows (${insertValuesCount}) exceed --dml-max-rows (${dmlMaxRows}).\n`);
      return 2;
    }
  }

  let client: KintoneClient;
  const appProfileByApp = new Map<number, string>();
  for (const appId of appIds) {
    appProfileByApp.set(appId, appBindingByMappedApp.get(appId)?.profile ?? profileName.toLowerCase());
  }
  const cacheContext = buildCacheContext(profileName, appBindingByMappedApp);

  if (args.dryRun) {
    client = createDryRunClient();
  } else {
    for (const explicitProfile of appProfileByApp.values()) {
      if (!config.profiles || !config.profiles[explicitProfile]) {
        process.stderr.write(`ArgumentError: profile "${explicitProfile}" is not defined.\n`);
        return 2;
      }
    }

    const mapFromEnv = envString("KSQL_TOKEN_MAP") ? parseTokenMap(envString("KSQL_TOKEN_MAP")!) : {};
    const mapFromFile = args.tokenFile ? parseTokenFile(args.tokenFile) : {};
    const mapFromArg = args.tokenMap;
    const singleToken = args.token ?? envString("KSQL_TOKEN");

    const profileClientMap = new Map<string, KintoneClient>();
    const missingAppProfiles: string[] = [];
    const usedProfiles = new Set<string>([...appProfileByApp.values(), profileName]);

    for (const pName of usedProfiles) {
      const p = pName === profileName ? profile : (config.profiles?.[pName] ?? null);
      if (!p) {
        process.stderr.write(`ArgumentError: profile "${pName}" is not defined.\n`);
        return 2;
      }

      const baseUrl = args.baseUrl ?? envString("KSQL_BASE_URL") ?? p.baseUrl ?? "";
      const guestSpaceId = args.guestSpaceId ?? envInt("KSQL_GUEST_SPACE_ID") ?? p.guestSpaceId ?? null;
      if (!baseUrl) {
        process.stderr.write(`AuthError: --base-url is required for profile "${pName}".\n`);
        return 3;
      }

      const authReq = args.auth ?? envAuth("KSQL_AUTH") ?? p.auth ?? "auto";
      const username = args.username ?? envString("KSQL_USERNAME") ?? p.username ?? null;
      const passwordFromEnvRef = p.passwordEnv ? envString(p.passwordEnv) : null;
      const password = args.password ?? envString("KSQL_PASSWORD") ?? passwordFromEnvRef ?? p.password ?? null;
      const hasUserPass = Boolean(username && password);
      const auth = authReq === "auto" ? (hasUserPass ? "userpass" : "token") : authReq;

      if (auth === "userpass") {
        if (!username || !password) {
          process.stderr.write(`AuthError: username/password are required for profile "${pName}".\n`);
          return 3;
        }
        profileClientMap.set(pName, createNodeKintoneClient(baseUrl, {
          guestSpaceId,
          timeoutMs: timeout,
          debug,
          debugHeaders,
          log: (line) => {
            if (args.debugUrl && !line.startsWith("[debug] request")) return;
            process.stderr.write(`${line}\n`);
          },
          auth: { type: "userpass", username, password },
        }));
        continue;
      }

      const mapFromConfigRaw = p.tokenMap ?? {};
      const mapFromConfig = Object.fromEntries(
        Object.entries(mapFromConfigRaw).map(([k, v]) => [normalizeAppKey(k), resolveTokenValue(String(v))])
      );
      const effectiveTokenMap: Record<string, string> = { ...mapFromConfig, ...mapFromEnv, ...mapFromFile, ...mapFromArg };

      const assignedAppIds = appIds.filter((appId) => appProfileByApp.get(appId) === pName);
      const tokenByApp = new Map<number, string>();
      for (const mappedAppId of assignedAppIds) {
        const realAppId = appBindingByMappedApp.get(mappedAppId)?.appId ?? mappedAppId;
        const key = `APP${realAppId}`;
        const fromMap = effectiveTokenMap[key];
        if (fromMap) {
          tokenByApp.set(mappedAppId, resolveTokenValue(fromMap));
          continue;
        }
        if (assignedAppIds.length === 1 && singleToken) {
          tokenByApp.set(mappedAppId, singleToken);
          continue;
        }
        missingAppProfiles.push(`APP${realAppId}@${pName}`);
      }

      profileClientMap.set(pName, createNodeKintoneClient(baseUrl, {
        guestSpaceId,
        timeoutMs: timeout,
        debug,
        debugHeaders,
        log: (line) => {
          if (args.debugUrl && !line.startsWith("[debug] request")) return;
          process.stderr.write(`${line}\n`);
        },
        auth: {
          type: "token",
          resolveToken(appId: number): string {
            const token = tokenByApp.get(appId) ?? tokenByApp.get(assignedAppIds[0]);
            if (!token) throw new Error(`AuthError: token is not resolved for APP${appId}@${pName}.`);
            return token;
          },
        },
      }));
    }

    if (missingAppProfiles.length > 0) {
      process.stderr.write(`AuthError: token is missing for ${missingAppProfiles.join(", ")}.\n`);
      return 3;
    }

    if (args.diagRecordId !== null) {
      if (defaultApp === null) {
        process.stderr.write("ArgumentError: --app is required when --diag-record-id is specified.\n");
        return 2;
      }
      const diagProfileName = appProfileByApp.get(defaultApp) ?? profileName;
      const diagProfile = diagProfileName === profileName ? profile : config.profiles?.[diagProfileName];
      if (!diagProfile) {
        process.stderr.write(`ArgumentError: profile "${diagProfileName}" is not defined.\n`);
        return 2;
      }
      const baseUrl = args.baseUrl ?? envString("KSQL_BASE_URL") ?? diagProfile.baseUrl ?? "";
      const guestSpaceId = args.guestSpaceId ?? envInt("KSQL_GUEST_SPACE_ID") ?? diagProfile.guestSpaceId ?? null;
      if (!baseUrl) {
        process.stderr.write(`AuthError: --base-url is required for profile "${diagProfileName}".\n`);
        return 3;
      }
      const authReq = args.auth ?? envAuth("KSQL_AUTH") ?? diagProfile.auth ?? "auto";
      const username = args.username ?? envString("KSQL_USERNAME") ?? diagProfile.username ?? null;
      const passwordFromEnvRef = diagProfile.passwordEnv ? envString(diagProfile.passwordEnv) : null;
      const password = args.password ?? envString("KSQL_PASSWORD") ?? passwordFromEnvRef ?? diagProfile.password ?? null;
      const hasUserPass = Boolean(username && password);
      const auth = authReq === "auto" ? (hasUserPass ? "userpass" : "token") : authReq;
      try {
        if (auth === "userpass") {
          if (!username || !password) {
            process.stderr.write(`AuthError: username/password are required for profile "${diagProfileName}".\n`);
            return 3;
          }
          await runDiagnosticRecordGet({
            baseUrl,
            guestSpaceId,
            appId: defaultApp,
            recordId: args.diagRecordId,
            timeoutMs: timeout,
            debug,
            debugHeaders,
            debugUrlOnly: args.debugUrl,
            auth: { type: "userpass", username, password },
          });
        } else {
          const mapFromConfigRaw = diagProfile.tokenMap ?? {};
          const mapFromConfig = Object.fromEntries(
            Object.entries(mapFromConfigRaw).map(([k, v]) => [normalizeAppKey(k), resolveTokenValue(String(v))])
          );
          const effectiveTokenMap: Record<string, string> = { ...mapFromConfig, ...mapFromEnv, ...mapFromFile, ...mapFromArg };
          const diagToken = effectiveTokenMap[`APP${defaultApp}`] ?? (singleToken && appIds.length <= 1 ? singleToken : null);
          if (!diagToken) {
            process.stderr.write(`AuthError: token is missing for APP${defaultApp}@${diagProfileName}.\n`);
            return 3;
          }
          await runDiagnosticRecordGet({
            baseUrl,
            guestSpaceId,
            appId: defaultApp,
            recordId: args.diagRecordId,
            timeoutMs: timeout,
            debug,
            debugHeaders,
            debugUrlOnly: args.debugUrl,
            auth: { type: "token", token: resolveTokenValue(diagToken) },
          });
        }
        return 0;
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return toExitCodeFromError(err);
      }
    }

    const defaultClient = profileClientMap.get(profileName);
    if (!defaultClient) {
      process.stderr.write(`AuthError: profile client is not resolved for "${profileName}".\n`);
      return 3;
    }

    client = {
      getRecords: (params) => {
        const binding = appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
        const pName = binding.profile;
        const routed = profileClientMap.get(pName);
        if (!routed) throw new Error(`AuthError: profile "${pName}" is not resolved for APP${params.app}.`);
        return routed.getRecords({ ...params, app: binding.appId });
      },
      postRecords: (params) => {
        const binding = appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
        const pName = binding.profile;
        const routed = profileClientMap.get(pName);
        if (!routed) throw new Error(`AuthError: profile "${pName}" is not resolved for APP${params.app}.`);
        return routed.postRecords({ ...params, app: binding.appId });
      },
      putRecords: (params) => {
        const binding = appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
        const pName = binding.profile;
        const routed = profileClientMap.get(pName);
        if (!routed) throw new Error(`AuthError: profile "${pName}" is not resolved for APP${params.app}.`);
        return routed.putRecords({ ...params, app: binding.appId });
      },
      deleteRecords: (params) => {
        const binding = appBindingByMappedApp.get(params.app) ?? { appId: params.app, profile: profileName.toLowerCase() };
        const pName = binding.profile;
        const routed = profileClientMap.get(pName);
        if (!routed) throw new Error(`AuthError: profile "${pName}" is not resolved for APP${params.app}.`);
        return routed.deleteRecords({ ...params, app: binding.appId });
      },
      getFields: (appId) => {
        const binding = appBindingByMappedApp.get(appId) ?? { appId, profile: profileName.toLowerCase() };
        const pName = binding.profile;
        const routed = profileClientMap.get(pName);
        if (!routed) throw new Error(`AuthError: profile "${pName}" is not resolved for APP${appId}.`);
        return routed.getFields(binding.appId);
      },
      getApps: () => defaultClient.getApps(),
    };
  }

  // レートゲート（P0-1）: 同時リクエスト上限 + GET 系の 429/5xx リトライ
  if (!args.dryRun) {
    client = withRequestGate(client, getGlobalRequestGate(profile.query?.maxConcurrent));
  }

  try {
    if (isDmlStatement && !args.dryRun) {
      const stmtAppId = (parsedStmt && typeof parsedStmt === "object" && typeof (parsedStmt as { appId?: unknown }).appId === "number")
        ? ((parsedStmt as { appId: number }).appId)
        : appIds[0];
      if (typeof stmtAppId === "number") {
        const targetFields = normalizeUnique(collectDmlTargetFields(parsedStmt));
        if (targetFields.length > 0) {
          const defs = await client.getFields(stmtAppId);
          const validCodes = new Set(defs.map((d) => d.code));
          const unknown = targetFields.filter((f) => !isSystemLikeFieldCode(f) && !validCodes.has(f));
          if (unknown.length > 0) {
            process.stderr.write(`ArgumentError: unknown field code(s): ${unknown.join(", ")}\n`);
            return 2;
          }
        }
      }
    }

    const confirm = async (count: number, operation: "UPDATE" | "DELETE" | "INSERT"): Promise<boolean> => {
      if (count > dmlMaxRows) {
        throw new Error(`ArgumentError: ${operation} affected rows (${count}) exceed --dml-max-rows (${dmlMaxRows}).`);
      }
      if (yes) return true;
      if (args.console) return true;
      const label = sql?.replace(/\s+/g, " ").trim() ?? operation;
      return await promptDmlConfirm(`[DML Confirm] type=${operation} estimatedRows=${count}\nquery=${label}`);
    };

    if (isBatchSql) {
      // DML バッチの確認はバッチ全体で1回（仕様 §8.3。--yes でスキップ。
      // console 子実行は REPL 側で確認済みのため --yes が付与されている）
      if (batchContainsDml && !yes && batchAnalysis) {
        const ok = await promptDmlConfirm(buildBatchDmlConfirmMessage(batchAnalysis));
        if (!ok) {
          process.stderr.write("DML was cancelled by user.\n");
          return 2;
        }
      }
      // バッチ実行。timeout はバッチ合計として扱う（仕様 §5.7）。
      // DML 文には文ごとの --dml-max-rows ガードを confirm 経由で適用
      //（バッチ全体の確認は上で済んでいるため、ここでは件数ガードのみ）
      const batchResult = await executeBatch(sql!, client, {
        maxRecords,
        fetchParallel,
        onLimitReached: onLimit,
        cacheContext,
        continueOnError: args.continueOnError,
        timeoutMs: timeout,
        confirm: batchContainsDml
          ? async (count, operation) => {
            if (count > dmlMaxRows) {
              throw new Error(`ArgumentError: ${operation} affected rows (${count}) exceed --dml-max-rows (${dmlMaxRows}).`);
            }
            return true;
          }
          : undefined,
      });
      return writeBatchOutput(batchResult, { format, noHeader, pretty, displayOptions, outputPath, quiet });
    }

    const result = args.dryRun
      ? await execute(`EXPLAIN ${sql}`, client, { maxRecords, onLimitReached: onLimit, cacheContext })
      : await execute(sql!, client, {
        maxRecords,
        fetchParallel,
        onLimitReached: onLimit,
        confirm: isDmlStatement ? confirm : undefined,
        cacheContext,
      });
    // ASSERT は mutation 出力（affected=）に流さない専用経路（バッチ強化第1弾 §2.5）
    if (result.type === "ASSERT") {
      const output = buildAssertOutput(result, format, pretty);
      if (outputPath) writeFileSync(outputPath, `${output}\n`, "utf-8");
      else if (output) process.stdout.write(`${output}\n`);
      return 0;
    }
    if (result.type !== "SELECT") {
      const output = buildMutationOutput(result, format, noHeader, pretty);
      if (outputPath) writeFileSync(outputPath, `${output}\n`, "utf-8");
      else if (output) process.stdout.write(`${output}\n`);

      if (!quiet) process.stderr.write(`affected=${getAffectedCount(result)}\n`);
      return 0;
    }

    const output = buildOutput(result, format, noHeader, pretty, displayOptions);
    if (outputPath) writeFileSync(outputPath, `${output}\n`, "utf-8");
    else if (output) process.stdout.write(`${output}\n`);

    if (!quiet) process.stderr.write(`rowCount=${result.rowCount}\n`);
    if (shouldExitOnEmpty(args.dryRun, exitOnEmpty, result.rowCount)) return 1;
    return 0;
  } catch (err) {
    if (err instanceof OperationCancelledError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return toExitCodeFromError(err);
  }
}

function isDirectCliRun(): boolean {
  const argv1 = process.argv[1] ?? "";
  return /dist-cli[\\/]+ksql\.js$/i.test(argv1) || /src[\\/]cli[\\/]index\.ts$/i.test(argv1);
}

if (isDirectCliRun()) {
  run().then((code) => {
    process.exitCode = code;
  });
}
