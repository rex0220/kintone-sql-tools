import { z } from "zod";

const profile = z.string().min(1).optional();
const maxRecords = z.number().int().positive().optional();
const fetchParallel = z.number().int().min(1).max(10).optional();
const onLimit = z.enum(["error", "truncate"]).optional();
const timeout = z.number().int().positive().optional();
const dmlMaxRows = z.number().int().positive();
const savedQueryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const savedQueryTags = z.array(z.string().min(1)).optional();

export const validateInputSchema = z.object({
  sql: z.string().min(1),
  profile,
});

export const explainInputSchema = z.object({
  sql: z.string().min(1),
  profile,
});

export const queryInputSchema = z.object({
  sql: z.string().min(1),
  profile,
  maxRecords,
  fetchParallel,
  onLimit,
  timeout,
  /** バッチ(複文)専用: 実行時エラー後も後続文を実行する(既定 false = fail-fast) */
  continueOnError: z.boolean().optional(),
  /** バッチ(複文)専用: 返却する結果セットの合計行数上限(既定なし) */
  maxTotalRecords: z.number().int().positive().optional(),
});

export const mutateInputSchema = z.object({
  sql: z.string().min(1),
  profile,
  allowDml: z.literal(true),
  confirmText: z.literal("yes"),
  dmlMaxRows,
  fetchParallel,
  timeout,
});

export const describeAppInputSchema = z.object({
  app: z.number().int().positive(),
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
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  sql: z.string().min(1),
  defaultProfile: z.string().min(1),
  readOnly: z.boolean(),
  allowProfileOverride: z.boolean().optional(),
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
  allowDml: z.literal(true).optional(),
  confirmText: z.literal("yes").optional(),
  dmlMaxRows: dmlMaxRows.optional(),
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
