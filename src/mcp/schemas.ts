import { z } from "zod";

// パラメータ説明は .describe() に書く(MCP の tools/list で JSON Schema の
// description としてクライアントの LLM に渡る。TypeScript コメントは渡らない)
const profile = z.string().min(1)
  .describe("kintone connection profile name from ksql.config.json (default: the server's default profile).")
  .optional();
const maxRecords = z.number().int().positive()
  .describe("Maximum records fetched per SELECT (default 500).")
  .optional();
const fetchParallel = z.number().int().min(1).max(10)
  .describe("Number of parallel kintone record-fetch requests (1-10).")
  .optional();
const onLimit = z.enum(["error", "truncate"])
  .describe("Behavior when maxRecords is exceeded: 'error' rejects, 'truncate' returns the first maxRecords rows (default 'error'). VALIDATE ONLY always requires complete input and therefore overrides 'truncate' to 'error'.")
  .optional();
const tempTableMaxRows = z.number().int().positive()
  .describe("Per-temp-table cap on materialized rows for CREATE TEMP TABLE ... AS SELECT (default 10000). Overflow always errors — 'truncate' never applies to temp tables, so downstream statements never see silently truncated data. Raising this increases memory use (up to 16 temp tables per batch); prefer narrowing the SELECT with WHERE.")
  .optional();
const timeout = z.number().int().positive()
  .describe("Request timeout in milliseconds. For multi-statement batches this also acts as the total batch deadline.")
  .optional();
const savedQueryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe("Saved query name (alphanumeric, '_' and '-', up to 64 chars).");
const savedQueryTags = z.array(z.string().min(1))
  .describe("Tags for organizing saved queries.")
  .optional();

export const validateInputSchema = z.object({
  sql: z.string().min(1)
    .describe("kSQL text to validate. May contain multiple ;-separated statements (batch) and temp tables (#name)."),
  profile,
});

export const explainInputSchema = z.object({
  sql: z.string().min(1)
    .describe("kSQL text to explain. May contain multiple ;-separated statements (batch) and temp tables (#name)."),
  profile,
});

export const queryInputSchema = z.object({
  sql: z.string().min(1)
    .describe("Read-only kSQL text. May contain multiple ;-separated statements (batch) with temp tables, e.g. CREATE TEMP TABLE #t AS SELECT ...; SELECT ... FROM #t;"),
  profile,
  maxRecords,
  fetchParallel,
  onLimit,
  tempTableMaxRows,
  timeout,
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
    .describe("DML kSQL text. May contain multiple ;-separated statements (batch) with temp tables, e.g. CREATE TEMP TABLE #t AS SELECT ...; INSERT INTO APPx (...) SELECT ... FROM #t;"),
  profile,
  allowDml: z.literal(true)
    .describe("Must be true to acknowledge that this call writes to kintone."),
  confirmText: z.literal("yes")
    .describe('Must be the literal string "yes" to confirm execution.'),
  dmlMaxRows: z.number().int().positive()
    .describe("Per-statement cap on affected rows. The call fails before writing if any statement would exceed it; for UPSERT it counts inserts + updates. It does NOT limit source reads of INSERT/UPSERT ... SELECT: those follow the runtime maxRecords resolution (KSQL_MAX_RECORDS / profile query.maxRecords, default 500; temp tables hold at most 10000 rows by default, adjustable via tempTableMaxRows), so choose it by intended write count only."),
  fetchParallel,
  tempTableMaxRows,
  timeout,
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
