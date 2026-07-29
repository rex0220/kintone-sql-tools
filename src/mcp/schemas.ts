import { z } from "zod";
import { KINTONE_METADATA_LANGS, KINTONE_METADATA_RESOURCES } from "../node/kintoneMetadata";
import { MCP_IMPORT_MAX_SOURCES } from "./stdioLimits";

// パラメータ説明は .describe() に書く(MCP の tools/list で JSON Schema の
// description としてクライアントの LLM に渡る。TypeScript コメントは渡らない)
const profile = z.string().min(1)
  .describe("kintone connection profile name from ksql.config.json (default: the server's default profile).")
  .optional();
const kintoneMetadataResource = z.enum(KINTONE_METADATA_RESOURCES);
const kintoneMetadataLang = z.enum(KINTONE_METADATA_LANGS);
const kintoneMetadataAppRef = z.union([
  z.number().int().positive(),
  z.string().regex(/^LAPP_[A-Za-z][A-Za-z0-9_]{0,63}$/i),
]).describe("Positive kintone app ID or logical app name LAPP_<NAME>.");
const maxRecords = z.number().int().positive()
  .describe("Maximum records fetched per SELECT (default 500).")
  .optional();
const fetchParallel = z.number().int().min(1).max(10)
  .describe("Number of parallel kintone record-fetch requests (1-10).")
  .optional();
const onLimit = z.enum(["error", "truncate"])
  .describe("Behavior when maxRecords is exceeded: 'error' rejects, 'truncate' returns the first maxRecords rows (default 'error'). Local ORDER BY plans require complete input and fail instead of returning a truncated top-N; REST top-N and KORDER_NATIVE do not fetch a partial candidate set. Leading VALIDATE and DML VALIDATE ONLY always override 'truncate' to 'error'.")
  .optional();
const tempTableMaxRows = z.number().int().positive()
  .describe("Per-temp-table cap on materialized rows for CREATE TEMP TABLE ... AS SELECT (default 10000). Overflow always errors — 'truncate' never applies to temp tables, so downstream statements never see silently truncated data. Raising this increases memory use (up to 16 temp tables per batch); prefer narrowing the SELECT with WHERE.")
  .optional();
const timeout = z.number().int().positive()
  .describe("Request timeout in milliseconds. For multi-statement batches this also acts as the total batch deadline.")
  .optional();
const cursorMaxActive = z.number().int().min(1).max(5)
  .describe("Maximum active Cursor API handles per kintone host in this process (1-5, default 2). Later calls update the host limit; lowering it keeps existing cursors and delays new ones until active usage falls below the new limit. Create/Get are never automatically retried; capacity waits up to 30 seconds.")
  .optional();
const savedQueryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe("Saved query name (alphanumeric, '_' and '-', up to 64 chars).");
const savedQueryTags = z.array(z.string().min(1))
  .describe("Tags for organizing saved queries.")
  .optional();
const importSources = z.array(z.object({
  name: z.string().min(1).describe("Source name referenced after FROM CSV."),
  text: z.string().describe("Inline CSV text. Mutually exclusive with base64.").optional(),
  base64: z.string().describe("Inline CSV bytes encoded as base64. Mutually exclusive with text.").optional(),
  encoding: z.enum(["utf8", "sjis"]).describe("Optional source encoding metadata; SQL ENCODING takes precedence.").optional(),
}).superRefine((source, ctx) => {
  if ((source.text === undefined) === (source.base64 === undefined)) {
    ctx.addIssue({ code: "custom", message: "Exactly one of text or base64 is required." });
  }
})).max(MCP_IMPORT_MAX_SOURCES)
  .describe("IMPORT CSV/JSON named inline sources (maximum 16). Nested subtable VALIDATE ONLY/EXPLAIN is supported, but mutation is fail-closed because MCP cannot interactively display and approve parent/table delete detail. JSON drops child IDs and renumbers; cli-kintone CSV preserves matching IDs and requires REPLACE SUBTABLES. Paths are not accepted; each source is limited to 10 MiB.")
  .optional();

export const validateInputSchema = z.object({
  sql: z.string().min(1)
    .describe("kSQL text to validate. May contain multiple ;-separated statements (batch), temp tables (#name), and every APPLY form (UPDATE/INSERT/UPSERT/multi-value); validation never enables APPLY mutation. Relative-date functions are checked for syntax and argument shape only here; ksql_query/ksql_explain/runtime performs the final schema-aware decision."),
  profile,
  importSources,
});

export const explainInputSchema = z.object({
  sql: z.string().min(1)
    .describe("kSQL text to explain. May contain multiple ;-separated statements (batch), temp tables (#name), and every APPLY form (UPDATE/INSERT/UPSERT/multi-value); EXPLAIN performs no record or mutation API calls."),
  profile,
  maxRecords,
  cursorMaxActive,
  importSources,
});

export const queryInputSchema = z.object({
  sql: z.string().min(1)
    .describe("Read-only kSQL text. May contain multiple ;-separated statements (batch) with temp tables, e.g. CREATE TEMP TABLE #t AS SELECT ...; SELECT ... FROM #t. UPDATE/INSERT/UPSERT/multi-value APPLY VALIDATE ONLY is allowed with the fixed dmlMaxSubtableRows default 500; this schema exposes no override and never enables APPLY mutation."),
  profile,
  maxRecords,
  fetchParallel,
  onLimit,
  tempTableMaxRows,
  timeout,
  cursorMaxActive,
  importSources,
  continueOnError: z.boolean()
    .describe("Batch (multi-statement) only: keep executing subsequent statements after a runtime error (default false = fail-fast).")
    .optional(),
  maxTotalRecords: z.number().int().positive()
    .describe("Batch (multi-statement) only: cap on total rows returned across all result sets (default: unlimited).")
    .optional(),
  variables: z.record(z.string(), z.string())
    .describe("Batch only: string values for variables declared with DECLARE. Keys omit @ and are case-insensitive.")
    .optional(),
});

export const mutateInputSchema = z.object({
  sql: z.string().min(1)
    .describe("DML kSQL text. May contain multiple ;-separated statements (batch) with temp tables, e.g. CREATE TEMP TABLE #t AS SELECT ...; INSERT INTO APPx (...) SELECT ... FROM #t. Every APPLY mutation form (UPDATE/INSERT/UPSERT/multi-value) is rejected by MCP v3.8.0 before runtime or records API creation."),
  profile,
  allowDml: z.literal(true)
    .describe("Must be true to acknowledge that this call writes to kintone."),
  confirmText: z.literal("yes")
    .describe('Must be the literal string "yes" to confirm execution.'),
  dmlMaxRows: z.number().int().positive()
    .describe("Per-statement cap on affected rows. The call fails before writing if any statement would exceed it; for UPSERT it counts inserts + updates. It does NOT limit source reads of INSERT/UPSERT ... SELECT: those follow the runtime maxRecords resolution (KSQL_MAX_RECORDS / profile query.maxRecords, default 500; temp tables hold at most 10000 rows by default, adjustable via tempTableMaxRows), so choose it by intended write count only."),
  dmlMaxSubtableRows: z.number().int().positive().default(500)
    .describe("APPLY changed-subtable-row cap (default 500). Every APPLY mutation form (UPDATE/INSERT/UPSERT/multi-value) is always rejected by MCP v3.8.0 before runtime or records API creation; allowDml and increasing dmlMaxSubtableRows do not enable it."),
  fetchParallel,
  tempTableMaxRows,
  timeout,
  cursorMaxActive,
  importSources,
  dmlTotalMaxRows: z.number().int().positive()
    .describe("Batch (multi-statement) only: cap on total affected rows across the whole batch (default: per-statement dmlMaxRows only). DML batches always run fail-fast.")
    .optional(),
  variables: z.record(z.string(), z.string())
    .describe("Batch only: string values for variables declared with DECLARE. Keys omit @ and are case-insensitive.")
    .optional(),
});

export const describeAppInputSchema = z.object({
  app: z.number().int().positive()
    .describe("kintone app ID to describe."),
  profile,
  maxRecords,
  fetchParallel,
  onLimit,
  timeout,
});

export const showAppsInputSchema = z.object({
  profile,
  maxRecords,
  fetchParallel,
  onLimit,
  timeout,
});

export const ksqlDocsInputSchema = z.object({
  section: z.string().max(128).optional(),
}).strict();

// Pass the strict root schema itself to McpServer so unknown properties are rejected.
export const ksqlDocsInputShape = ksqlDocsInputSchema;

export const ksqlAppMetadataInputSchema = z.discriminatedUnion("resource", [
  z.object({
    resource: kintoneMetadataResource.extract(["app"]),
    app: kintoneMetadataAppRef,
    profile,
    preview: z.literal(false).optional(),
  }).strict(),
  z.object({
    resource: kintoneMetadataResource.extract(["layout", "customize"]),
    app: kintoneMetadataAppRef,
    profile,
    preview: z.boolean().optional(),
  }).strict(),
  z.object({
    resource: kintoneMetadataResource.extract(["fields", "settings", "status", "views", "reports"]),
    app: kintoneMetadataAppRef,
    profile,
    preview: z.boolean().optional(),
    lang: kintoneMetadataLang.optional(),
  }).strict(),
]);

// McpServer 1.29 publishes only root object schemas in tools/list. Keep the
// discriminated union above as the branch contract, and mirror its public keys
// in a strict root object whose refinement delegates to that union.
export const ksqlAppMetadataInputShape = z.object({
  resource: kintoneMetadataResource,
  app: kintoneMetadataAppRef,
  profile,
  preview: z.boolean().optional(),
  lang: kintoneMetadataLang.optional(),
}).strict().superRefine((input, ctx) => {
  const parsed = ksqlAppMetadataInputSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  }
});

export const listQueriesInputSchema = z.object({});

export const saveQueryInputSchema = z.object({
  name: savedQueryName,
  title: z.string().min(1).describe("Human-readable title.").optional(),
  description: z.string().min(1).describe("What the query does and when to use it.").optional(),
  sql: z.string().min(1)
    .describe("kSQL text to save (single statement only)."),
  defaultProfile: z.string().min(1)
    .describe("Profile the saved query runs against by default."),
  readOnly: z.boolean()
    .describe("true for read-only queries; false marks the saved query as DML (requires mutate safety inputs at run time)."),
  allowProfileOverride: z.boolean()
    .describe("Allow overriding the profile at run time (default false).")
    .optional(),
  tags: savedQueryTags,
});

export const savedQueryNameInputSchema = z.object({
  name: savedQueryName,
});

export const runSavedQueryInputSchema = z.object({
  name: savedQueryName,
  profile,
  maxRecords,
  fetchParallel,
  onLimit,
  timeout,
  allowDml: z.literal(true)
    .describe("Required for DML saved queries: must be true to acknowledge writes.")
    .optional(),
  confirmText: z.literal("yes")
    .describe('Required for DML saved queries: must be the literal string "yes".')
    .optional(),
  dmlMaxRows: z.number().int().positive()
    .describe("Required for DML saved queries: per-statement cap on affected rows; for UPSERT it counts inserts + updates. It does NOT limit source reads of INSERT/UPSERT ... SELECT: those follow the runtime maxRecords resolution (KSQL_MAX_RECORDS / profile query.maxRecords, default 500). Saved queries are single-statement, so temp tables do not apply here. Note: this tool's maxRecords / onLimit inputs apply to read-only saved queries only.")
    .optional(),
});

export const validateInputShape = validateInputSchema.shape;
export const explainInputShape = explainInputSchema.shape;
export const queryInputShape = queryInputSchema.shape;
export const mutateInputShape = mutateInputSchema.shape;
export const describeAppInputShape = describeAppInputSchema.shape;
export const showAppsInputShape = showAppsInputSchema.shape;
export const listQueriesInputShape = listQueriesInputSchema.shape;
export const saveQueryInputShape = saveQueryInputSchema.shape;
export const savedQueryNameInputShape = savedQueryNameInputSchema.shape;
export const runSavedQueryInputShape = runSavedQueryInputSchema.shape;
