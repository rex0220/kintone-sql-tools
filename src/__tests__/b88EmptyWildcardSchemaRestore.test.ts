import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  execute,
  executeBatch,
  type KintoneClient,
  type KintoneFieldInfo,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";
import {
  deriveEmptyWildcardColumns,
  EMPTY_WILDCARD_FIELD_TYPE_POLICY,
} from "../core/emptyWildcardSchema";
import * as processEngine from "../engine/process";

function record(fields: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

function makeClient(options: {
  records?: Record<number, KintoneRecord[]>;
  fields?: Record<number, KintoneFieldInfo[]>;
  processEnabled?: Record<number, boolean>;
} = {}) {
  const getRecords = jest.fn(async (params: { app: number }) => ({
    records: options.records?.[params.app] ?? [],
  }));
  const getFields = jest.fn(async (appId: number) => options.fields?.[appId] ?? []);
  const getProcessStatuses = jest.fn(async (appId: number) => ({
    enable: options.processEnabled?.[appId] ?? false,
    states: [],
  }));
  const postRecords = jest.fn(async () => ({ ids: [] }));
  const client: KintoneClient = {
    getRecords,
    getFields,
    getProcessStatuses,
    postRecords,
    async openCursor() { throw new Error("unexpected cursor"); },
    async putRecords() {},
    async deleteRecords() {},
    async getApps() { return []; },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const };
    },
  };
  return { client, getRecords, getFields, getProcessStatuses, postRecords };
}

const parentFields: KintoneFieldInfo[] = [
  { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
  { code: "Category", label: "Category", fieldType: "CATEGORY" },
  { code: "関連", label: "関連", fieldType: "REFERENCE_TABLE" },
  { code: "Group", label: "Group", fieldType: "GROUP" },
  { code: "明細", label: "明細", fieldType: "SUBTABLE" },
  { code: "数量", label: "数量", fieldType: "NUMBER", inSubtable: true, subtableCode: "明細" },
  { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
  { code: "作業者", label: "作業者", fieldType: "STATUS_ASSIGNEE" },
];

test.each([
  ["SIMPLE", "SELECT * FROM APP100"],
  ["FULL_SCAN", "SELECT DISTINCT * FROM APP100"],
])("B88: %s の 0 行 SELECT * は物理アプリ定義から列を復元する", async (_mode, sql) => {
  const mock = makeClient({ fields: { 100: parentFields }, processEnabled: { 100: false } });
  const result = await execute(sql, mock.client, { cacheContext: `b88-empty-${_mode}` }) as SelectResult;

  expect(result).toMatchObject({
    rows: [],
    columns: ["件名", "明細", "$revision", "$id"],
    rowCount: 0,
  });
});

test("B88: 空の物理 SELECT * の列を temp・二段 temp・CTE へ保存して伝播する", async () => {
  const mock = makeClient({ fields: { 100: parentFields } });
  const batch = await executeBatch(
    "CREATE TEMP TABLE #e AS SELECT * FROM APP100;" +
      "SELECT * FROM #e;" +
      "CREATE TEMP TABLE #f AS SELECT * FROM #e;" +
      "SELECT * FROM #f;" +
      "WITH e AS (SELECT * FROM APP100), spare AS (SELECT * FROM APP100) SELECT * FROM e",
    mock.client,
    { cacheContext: "b88-empty-materialized-chain" }
  );

  expect(batch.ok).toBe(true);
  for (const index of [1, 3, 4]) {
    expect((batch.statements[index].result as SelectResult).columns)
      .toEqual(["件名", "明細", "$revision", "$id"]);
  }
});

test("B88: 空のサブテーブル仮想テーブルは system 3 列と当該表の子だけを返す", async () => {
  const fields: KintoneFieldInfo[] = [
    { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT" },
    { code: "明細", label: "明細", fieldType: "SUBTABLE" },
    { code: "品名", label: "品名", fieldType: "SINGLE_LINE_TEXT", inSubtable: true, subtableCode: "明細" },
    { code: "数量", label: "数量", fieldType: "NUMBER", inSubtable: true, subtableCode: "明細" },
    { code: "別表", label: "別表", fieldType: "SUBTABLE" },
    { code: "備考", label: "備考", fieldType: "MULTI_LINE_TEXT", inSubtable: true, subtableCode: "別表" },
  ];
  const mock = makeClient({ fields: { 100: fields } });
  const result = await execute(
    "SELECT * FROM APP100$明細",
    mock.client,
    { cacheContext: "b88-empty-subtable" }
  ) as SelectResult;

  expect(result).toMatchObject({
    rows: [],
    columns: ["_pid", "_rid", "_idx", "品名", "数量"],
    rowCount: 0,
  });
  expect(mock.getProcessStatuses).not.toHaveBeenCalled();
});

test.each([
  {
    label: "process disabled",
    enabled: false,
    actual: record({
      件名: "A",
      明細: [],
      $revision: "7",
      $id: "1",
    }),
  },
  {
    label: "process enabled",
    enabled: true,
    actual: record({
      件名: "A",
      明細: [],
      ステータス: "未処理",
      作業者: [],
      $revision: "7",
      $id: "1",
    }),
  },
])("B88: 導出列は 1 行 SELECT * の実列と一致する ($label)", async ({ label, enabled, actual }) => {
  const empty = makeClient({ fields: { 100: parentFields }, processEnabled: { 100: enabled } });
  const derived = await execute(
    "SELECT * FROM APP100",
    empty.client,
    { cacheContext: `b88-derived-${label}` }
  ) as SelectResult;
  const nonempty = makeClient({
    records: { 100: [actual] },
    fields: { 100: parentFields },
    processEnabled: { 100: enabled },
  });
  const observed = await execute(
    "SELECT * FROM APP100",
    nonempty.client,
    { cacheContext: `b88-observed-${label}` }
  ) as SelectResult;

  const withoutRecordSystem = (columns: string[]) =>
    columns.filter((column) => column !== "$revision" && column !== "$id");
  expect(withoutRecordSystem(derived.columns)).toEqual(withoutRecordSystem(observed.columns));
  expect(derived.columns.slice(-2)).toEqual(["$revision", "$id"]);
  expect(nonempty.getFields).not.toHaveBeenCalled();
});

test("B88: 0 行の system 列は末尾、1 行以上はレコード中の元位置を維持する", async () => {
  const fields = [
    { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
    { code: "金額", label: "金額", fieldType: "NUMBER" },
  ];
  const empty = makeClient({ fields: { 100: fields } });
  const emptyResult = await execute(
    "SELECT * FROM APP100",
    empty.client,
    { cacheContext: "b88-system-empty" }
  ) as SelectResult;
  expect(emptyResult.columns).toEqual(["件名", "金額", "$revision", "$id"]);

  const nonempty = makeClient({
    records: { 100: [record({ 件名: "A", $revision: "2", 金額: "10", $id: "1" })] },
    fields: { 100: fields },
  });
  const nonemptyResult = await execute(
    "SELECT * FROM APP100",
    nonempty.client,
    { cacheContext: "b88-system-nonempty" }
  ) as SelectResult;
  expect(nonemptyResult.columns).toEqual(["件名", "$revision", "金額", "$id"]);
  expect(nonempty.getFields).not.toHaveBeenCalled();
});

test("B88: STATUS 系が無いアプリは process settings API を呼ばない", async () => {
  const mock = makeClient({
    fields: {
      100: [
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
        { code: "金額", label: "金額", fieldType: "NUMBER" },
      ],
    },
  });
  const result = await execute(
    "SELECT * FROM APP100",
    mock.client,
    { cacheContext: "b88-no-process-fields" }
  ) as SelectResult;

  expect(result.columns).toEqual(["件名", "金額", "$revision", "$id"]);
  expect(mock.getProcessStatuses).not.toHaveBeenCalled();
});

test("B88: ローカル WHERE と DISTINCT LIMIT 0 は最終 0 行を復元し runFullScan は各 1 回", async () => {
  const fields = [{ code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" }];
  const mock = makeClient({
    records: { 100: [record({ 件名: "存在する値", $revision: "1", $id: "1" })] },
    fields: { 100: fields },
  });
  const runFullScan = jest.spyOn(processEngine, "runFullScan");

  const localWhere = await execute(
    "SELECT * FROM APP100 WHERE UPPER(件名) = '存在しない値'",
    mock.client,
    { cacheContext: "b88-local-where" }
  ) as SelectResult;
  expect(localWhere.columns).toEqual(["件名", "$revision", "$id"]);
  expect(runFullScan).toHaveBeenCalledTimes(1);

  runFullScan.mockClear();
  const limitZero = await execute(
    "SELECT DISTINCT * FROM APP100 LIMIT 0",
    mock.client,
    { cacheContext: "b88-local-limit-zero" }
  ) as SelectResult;
  expect(limitZero.columns).toEqual(["件名", "$revision", "$id"]);
  expect(runFullScan).toHaveBeenCalledTimes(1);
  runFullScan.mockRestore();
});

test("B88: INSERT SELECT * は復元列数が一致すれば 0 行 no-op、POST 0 回", async () => {
  const mock = makeClient({
    fields: {
      100: [{ code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" }],
      200: [
        { code: "a", label: "a", fieldType: "SINGLE_LINE_TEXT" },
        { code: "b", label: "b", fieldType: "SINGLE_LINE_TEXT" },
        { code: "c", label: "c", fieldType: "SINGLE_LINE_TEXT" },
      ],
    },
  });
  const result = await execute(
    "INSERT INTO APP200 (a, b, c) SELECT * FROM APP100",
    mock.client,
    { cacheContext: "b88-empty-insert-select" }
  );

  expect(result).toMatchObject({ type: "INSERT", insertedCount: 0 });
  expect(mock.postRecords).not.toHaveBeenCalled();
});

test("B88: 復元済み二段 temp は JOIN の schema-unavailable を解消する", async () => {
  const mock = makeClient({
    fields: {
      100: [{ code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" }],
      200: [
        { code: "k", label: "k", fieldType: "SINGLE_LINE_TEXT" },
        { code: "z", label: "z", fieldType: "SINGLE_LINE_TEXT" },
      ],
    },
  });
  const batch = await executeBatch(
    "CREATE TEMP TABLE #e AS SELECT * FROM APP100;" +
      "CREATE TEMP TABLE #f AS SELECT * FROM #e;" +
      "SELECT p.z FROM #f AS f INNER JOIN APP200 AS p ON f.k = p.k",
    mock.client,
    { cacheContext: "b88-join-materialized-schema" }
  );

  expect(batch.ok).toBe(true);
  expect(batch.statements[2].result).toMatchObject({
    type: "SELECT",
    rows: [],
    columns: ["z"],
  });
});

test("B88: 適用条件外は復元用 metadata API を追加しない", async () => {
  const fields = {
    100: [
      { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
      { code: "x", label: "x", fieldType: "SINGLE_LINE_TEXT" },
      { code: "ステータス", label: "ステータス", fieldType: "STATUS" },
    ],
    200: [{ code: "x", label: "x", fieldType: "SINGLE_LINE_TEXT" }],
  };

  const nonempty = makeClient({ records: { 100: [record({ 件名: "A" })] }, fields });
  await execute("SELECT * FROM APP100", nonempty.client, { cacheContext: "b88-skip-nonempty" });
  expect(nonempty.getFields).not.toHaveBeenCalled();
  expect(nonempty.getProcessStatuses).not.toHaveBeenCalled();

  const explicit = makeClient({ fields });
  await execute("SELECT 件名 FROM APP100", explicit.client, { cacheContext: "b88-skip-explicit" });
  expect(explicit.getFields).toHaveBeenCalledTimes(1);
  expect(explicit.getProcessStatuses).not.toHaveBeenCalled();

  const mixed = makeClient({ fields });
  await execute("SELECT *, x FROM APP100", mixed.client, { cacheContext: "b88-skip-mixed" });
  expect(mixed.getFields).not.toHaveBeenCalled();
  expect(mixed.getProcessStatuses).not.toHaveBeenCalled();

  const joined = makeClient({ fields });
  await execute(
    "SELECT * FROM APP100 a INNER JOIN APP200 b ON a.x = b.x",
    joined.client,
    { cacheContext: "b88-skip-join" }
  );
  expect(joined.getProcessStatuses).not.toHaveBeenCalled();
});

function sourceText(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function enclosingVariableName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function collectStrings(node: ts.Node, output: Set<string>): void {
  if (ts.isStringLiteral(node)) output.add(node.text);
  node.forEachChild((child) => collectStrings(child, output));
}

function fieldTypesFromClassifierSources(): readonly string[] {
  const candidates = new Set<string>();
  for (const relativePath of [
    "src/core/optimization/whereCapability.ts",
    "src/core/optimization/joinPredicatePushdown.ts",
  ]) {
    const file = ts.createSourceFile(
      relativePath,
      sourceText(relativePath),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "Set"
        && enclosingVariableName(node)?.includes("TYPE")
      ) {
        collectStrings(node, candidates);
      }
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === "NATIVE_OPERATORS"
        && node.initializer !== undefined
      ) {
        node.initializer.forEachChild(function collectNativeOperatorKeys(child): void {
          if (
            ts.isArrayLiteralExpression(child)
            && child.elements.length === 2
            && ts.isStringLiteral(child.elements[0])
            && ts.isNewExpression(child.elements[1])
          ) {
            candidates.add(child.elements[0].text);
          }
          child.forEachChild(collectNativeOperatorKeys);
        });
      }
      if (
        ts.isBinaryExpression(node)
        && (
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
        )
      ) {
        const pair = [node.left, node.right] as const;
        const literal = pair.find(ts.isStringLiteral);
        const expression = pair.find((part) => !ts.isStringLiteral(part));
        if (
          literal !== undefined
          && expression !== undefined
          && /fieldType$/i.test(expression.getText(file))
        ) {
          candidates.add(literal.text);
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
  return [...candidates]
    .filter((value) => /^[A-Z][A-Z0-9_]*$/.test(value) && !value.startsWith("KSQL_"))
    .sort();
}

test("B88: 既知の全フィールド型に record/non-record/process の判定がある", () => {
  const knownTypes = [
    ...fieldTypesFromClassifierSources(),
    "GROUP",
    "REFERENCE_TABLE",
    "SUBTABLE",
  ].sort();
  expect(Object.keys(EMPTY_WILDCARD_FIELD_TYPE_POLICY).sort()).toEqual(knownTypes);
});

test("B88: 未分類の将来フィールド型は空 schema を推測せず fail-closed", async () => {
  await expect(deriveEmptyWildcardColumns(
    [{ code: "future", label: "future", fieldType: "FUTURE_FIELD" }],
    undefined,
    async () => ({ enable: false, states: [] })
  )).rejects.toThrow(/policy is not defined for field type FUTURE_FIELD/);
});
