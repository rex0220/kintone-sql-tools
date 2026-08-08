import type { Statement } from "../types/ast";

export type StatementSyntaxId =
  | "select"
  | "with"
  | "union"
  | "insert"
  | "update"
  | "updateFrom"
  | "upsert"
  | "delete"
  | "subtableDml"
  | "apply"
  | "validate"
  | "import"
  | "tempTable"
  | "variables"
  | "assert"
  | "reorder"
  | "showDescribe"
  | "explain";

export interface StatementSyntaxEntry {
  readonly template: string;
  readonly examples: readonly string[];
  readonly expectedTypes: readonly (readonly Statement["type"][])[];
  readonly capabilities?: { readonly import?: boolean };
  readonly batch?: boolean;
}

export const STATEMENT_SYNTAX_CHECKS =
  "CHECKS := [CHECK WHEN cond THEN 'msg' [WHEN ...] ]...";
export const STATEMENT_SYNTAX_CONTROL =
  "CONTROL := [VALIDATE ONLY [INTO #err] | ON ERROR SKIP INTO #err [REJECT LIMIT n]]";

export const STATEMENT_SYNTAX_COMMON_NOTES = [
  "CHECKS precedes CONTROL. VALIDATE ONLY and ON ERROR SKIP are mutually exclusive.",
  "INTO #err requires a multi-statement batch (ON ERROR SKIP always; VALIDATE ONLY / VALIDATE only when INTO is used).",
  "APPLY may precede VALIDATE ONLY but cannot combine with CHECK or ON ERROR SKIP.",
  "Subtable DML does not accept CHECKS/CONTROL.",
  "These are all supported top-level statement families. Bracketed clauses are schematic; before first use, verify the referenced ksql_docs section. Do not invent other statement families or clause orders. UPDATE CHECK sees pre-update values; to test the new value, repeat the SET expression inside CHECK. Variable names start with ASCII letter/_; see ksql_docs for placement rules.",
] as const;

export const STATEMENT_SYNTAX_CATALOG = {
  select: {
    template: "SELECT: SELECT[DISTINCT] cols [FROM APPn|APPn$tbl|#t[alias][INNER|LEFT|RIGHT JOIN t[alias]ON a.x=b.y|CROSS JOIN t[alias]]...][WHERE][GROUP BY][HAVING][ORDER BY|KORDER BY][LIMIT n[OFFSET m]]",
    examples: ["SELECT 1 AS one"],
    expectedTypes: [["SELECT"]],
  },
  with: {
    template: "WITH-CTE: name AS(SELECT|SHOW APPS|DESCRIBE...|GENERATE_SERIES(start,stop[,step])[AS column])[,name2 AS(...)]... SELECT|UNION...",
    examples: [
      "WITH app_list AS (SHOW APPS), field_list AS (DESCRIBE APP1) SELECT * FROM app_list",
      "WITH days AS (GENERATE_SERIES('2026-08-01','2026-08-03') AS series_date) SELECT series_date FROM days",
      "WITH months AS (GENERATE_SERIES('2026-01-01','2026-12-01','1 month') AS month_start) SELECT month_start FROM months",
    ],
    expectedTypes: [["WITH"], ["WITH"], ["WITH"]],
  },
  union: {
    template: "UNION: SELECT... UNION[ALL] SELECT...",
    examples: ["SELECT 1 AS n UNION ALL SELECT 2 AS n"],
    expectedTypes: [["UNION"]],
  },
  insert: {
    template: "INSERT: INSERT INTO APPn(cols){VALUES(...)...|SELECT...} CHECKS CONTROL",
    examples: [
      "CREATE TEMP TABLE #source AS SELECT 'C001' AS code; "
        + "INSERT INTO APP1 (code) SELECT code FROM #source "
        + "CHECK WHEN code = '' THEN 'required' ON ERROR SKIP INTO #err REJECT LIMIT 10; "
        + "SELECT * FROM #err",
    ],
    expectedTypes: [["CREATE_TEMP_TABLE", "INSERT_SELECT", "SELECT"]],
    batch: true,
  },
  update: {
    template: "UPDATE: UPDATE APPn SET col=expr,... WHERE... CHECKS CONTROL",
    examples: [
      "UPDATE APP1 SET status = 'done' WHERE $id = 1 "
        + "CHECK WHEN status = '' THEN 'required' VALIDATE ONLY",
    ],
    expectedTypes: [["UPDATE"]],
  },
  updateFrom: {
    template: "UPDATE-FROM: UPDATE APPn SET col=s.col,... FROM #t|APPm[AS]s WHERE APPn.key=s.key[AND target_condition] CHECKS CONTROL",
    examples: [
      "CREATE TEMP TABLE #source AS SELECT 'C001' AS key, 'done' AS value; "
        + "UPDATE APP1 SET status = s.value FROM #source AS s "
        + "WHERE APP1.key = s.key VALIDATE ONLY; DROP TEMP TABLE #source",
    ],
    expectedTypes: [["CREATE_TEMP_TABLE", "UPDATE", "DROP_TEMP_TABLE"]],
    batch: true,
  },
  upsert: {
    template: "UPSERT: UPSERT INTO APPn(cols){VALUES...|SELECT...} ON DUPLICATE(key[,key]...) CHECKS CONTROL",
    examples: [
      "UPSERT INTO APP1 (key, name) VALUES ('C001', 'Acme') "
        + "ON DUPLICATE (key) VALIDATE ONLY",
      "UPSERT INTO APP1 (key, name) SELECT code, name FROM APP2 "
        + "ON DUPLICATE (key) VALIDATE ONLY",
    ],
    expectedTypes: [["UPSERT"], ["UPSERT_SELECT"]],
  },
  delete: {
    template: "DELETE: DELETE FROM APPn WHERE...",
    examples: ["DELETE FROM APP1 WHERE $id = 1"],
    expectedTypes: [["DELETE"]],
  },
  subtableDml: {
    template: "Subtable-DML: INSERT INTO APPn$tbl(_pid,cols)VALUES...|UPDATE APPn$tbl SET... WHERE _pid=...[AND _rid=...]|DELETE FROM APPn$tbl WHERE...",
    examples: [
      "INSERT INTO APP1$details (_pid, item, qty) VALUES (1, 'A-001', 2)",
      "UPDATE APP1$details SET qty = 5 WHERE _pid = 1 AND _rid = '67890'",
      "DELETE FROM APP1$details WHERE _pid = 1 AND _rid = '67890'",
    ],
    expectedTypes: [["INSERT"], ["UPDATE"], ["DELETE"]],
  },
  apply: {
    template: "APPLY: UPDATE...WHERE...APPLY tbl(ops)[APPLY...][VALIDATE ONLY]|INSERT...VALUES...APPLY tbl(ops)[VALIDATE ONLY]|UPSERT...ON DUPLICATE(...)[ON INSERT APPLY tbl(ops)][ON UPDATE APPLY tbl(ops)][VALIDATE ONLY]",
    examples: [
      "UPDATE APP1 SET status = 'done' WHERE $id = 1 "
        + "APPLY details (PATCH SET qty = 0 WHERE qty < 0) VALIDATE ONLY",
      "INSERT INTO APP1 (name) VALUES ('new') "
        + "APPLY details (APPEND (item, qty) VALUES ('A-001', 1)) VALIDATE ONLY",
      "UPSERT INTO APP1 (key, name) VALUES ('C001', 'Acme') ON DUPLICATE (key) "
        + "ON INSERT APPLY details (APPEND (item) VALUES ('initial')) "
        + "ON UPDATE APPLY details (REMOVE ALL ROWS) VALIDATE ONLY",
    ],
    expectedTypes: [["UPDATE"], ["INSERT"], ["UPSERT"]],
  },
  validate: {
    template: "VALIDATE: VALIDATE APPn[(fields)][SUMMARY][WHERE...] CHECKS[INTO #err]",
    examples: [
      "VALIDATE APP1 (code) SUMMARY WHERE $id > 0 "
        + "CHECK WHEN code = '' THEN 'required' INTO #err; SELECT * FROM #err",
    ],
    expectedTypes: [["VALIDATE", "SELECT"]],
    batch: true,
  },
  import: {
    template: "IMPORT: IMPORT[UPDATE] INTO APPn(cols|tbl(children)) FROM CSV|JSON name[options...]",
    examples: ["IMPORT INTO APP1 (code, name) FROM CSV customers BY NAME VALIDATE ONLY"],
    expectedTypes: [["IMPORT"]],
    capabilities: { import: true },
  },
  tempTable: {
    template: "Temp-table: CREATE TEMP TABLE #t AS SELECT...|AS WITH...|DROP TEMP TABLE #t",
    examples: [
      "CREATE TEMP TABLE #source AS SELECT 1 AS n; SELECT n FROM #source; DROP TEMP TABLE #source",
    ],
    expectedTypes: [["CREATE_TEMP_TABLE", "SELECT", "DROP_TEMP_TABLE"]],
    batch: true,
  },
  variables: {
    template: "Variables: SET @x=scalar_expr|(SELECT...)|['a',...]|DECLARE @x=default",
    examples: ["SET @x = 1; DECLARE @label = 'ready'; SELECT @x AS x, @label AS label"],
    expectedTypes: [["SET_VARIABLE", "DECLARE_VARIABLE", "SELECT"]],
    batch: true,
  },
  assert: {
    template: "ASSERT: ASSERT operand op operand|ASSERT operand BETWEEN a AND b",
    examples: ["ASSERT 2 BETWEEN 1 AND 3"],
    expectedTypes: [["ASSERT"]],
  },
  reorder: {
    template: "REORDER: REORDER APPn$tbl BY... WHERE...|REORDER ALL APPn$tbl BY...",
    examples: [
      "REORDER APP1$details BY item ASC WHERE _pid = 1",
      "REORDER ALL APP1$details BY item ASC",
    ],
    expectedTypes: [["REORDER"], ["REORDER"]],
  },
  showDescribe: {
    template: "SHOW/DESCRIBE: SHOW APPS|DESCRIBE|DESC APPn",
    examples: ["SHOW APPS", "DESCRIBE APP1", "DESC APP1"],
    expectedTypes: [["SHOW_APPS"], ["DESCRIBE"], ["DESCRIBE"]],
  },
  explain: {
    template: "EXPLAIN: EXPLAIN(SELECT|WITH|INSERT|UPSERT|UPDATE|DELETE|REORDER|VALIDATE|IMPORT)...",
    examples: [
      "EXPLAIN SELECT * FROM APP1",
      "EXPLAIN WITH source AS (SELECT * FROM APP1) SELECT * FROM source",
      "EXPLAIN INSERT INTO APP1 (name) VALUES ('Acme')",
      "EXPLAIN UPSERT INTO APP1 (key) VALUES ('C001') ON DUPLICATE (key)",
      "EXPLAIN UPDATE APP1 SET status = 'done' WHERE $id = 1",
      "EXPLAIN DELETE FROM APP1 WHERE $id = 1",
      "EXPLAIN REORDER APP1$details BY item ASC WHERE _pid = 1",
      "EXPLAIN VALIDATE APP1",
      "EXPLAIN IMPORT INTO APP1 (code) FROM JSON payload",
    ],
    expectedTypes: Array.from({ length: 9 }, () => ["EXPLAIN"] as const),
    capabilities: { import: true },
  },
} satisfies Record<StatementSyntaxId, StatementSyntaxEntry>;

export const STATEMENT_SYNTAX_PARAGRAPH = `Statement templates: ${STATEMENT_SYNTAX_CHECKS} ${STATEMENT_SYNTAX_CONTROL}. ${Object.values(STATEMENT_SYNTAX_CATALOG).map((entry) => entry.template).join("; ")}. ${STATEMENT_SYNTAX_COMMON_NOTES.join(" ")}`;
