# B133 保存クエリ複文対応 仕様 R1 codex レビュー

- 対象: `docs/internal/ksql_b133_saved_query_batch_spec.md` R1
- 判定: **要修正（8 件: 高 1 / 中 5 / 低 2）**
- 実施範囲: 仕様・現行コード・既存テストの静的レビューのみ。コード変更、git 操作、kSQL MCP 呼び出し、`npm test` は実施していない。

## 1. 結論

**R1 のままでは実装着手不可。** 最優先で、実需として掲げた「保存した複文パラメータを実行時に上書きする」ための入力契約を追加する必要がある。

現行の外部注入は `DECLARE` 専用だが、`ksql_run_saved_query` の schema には `variables` がない。さらに R1 の代表 SQL は `SET` であり、`SET` は注入対象ではない。このため、R1 §3 の「同上を実行時に `@d90` を上書き」は、§2 の変更だけでは実現しない。

DML の実書き込みが `query()` に漏れる直接の経路は確認できなかった。`containsDml` は全文をパースした各トップレベル文の `writesKintone()` を `some()` しており、通常 DML、`INSERT ... SELECT`、`ON ERROR SKIP`、APPLY mutation を捕捉する。ただし `containsDml` は「DML 構文を含む」ではなく「kintone へ実際に書く文を含む」の意味で、`VALIDATE ONLY` 付き DML は意図的に `false` となる。R1 の「1 文でも DML があれば拒否」という文言とは一致しない。また、保存クエリの read-only 可否には、既に公開されている fail-closed な `canRunWithQueryTool`（=`isReadOnlyBatch`）を使う方が契約に合う。

## 2. 指摘

### 2.1 [高] 実需の「実行時変数上書き」を実現する変更が仕様にない

- 該当: R1 §0、§3、§4
- 根拠: `src/mcp/schemas.ts:210-226`、`src/mcp/tools.ts:1082-1090`、`src/core/batchVariables.ts:31-47`、`src/execute.ts:1670-1739`

R1 の代表 SQL は `SET` で、受入条件は実行時の `@d90` 上書きを要求している。しかし `runSavedQueryInputSchema` は `name/profile/maxRecords/fetchParallel/onLimit/timeout` と DML 承認入力だけで、`variables` を持たない。

```ts
// src/mcp/schemas.ts:210-226
export const runSavedQueryInputSchema = z.object({
  name: savedQueryName,
  profile,
  maxRecords,
  fetchParallel,
  onLimit,
  timeout,
  ...
});
```

実行委譲でも変数を渡していない。

```ts
// src/mcp/tools.ts:1082-1090
const result = await query({
  sql: saved.sql,
  profile,
  maxRecords: input.maxRecords,
  fetchParallel: input.fetchParallel,
  onLimit: input.onLimit,
  timeout: input.timeout,
}, validation);
```

さらに、既存の注入機構は `DECLARE_VARIABLE` のみを明示的に対象にする。

```ts
// src/core/batchVariables.ts:31-45
/** 注入先を DECLARE 文だけに限定し、実行開始前にタイポを拒否する。 */
export function validateDeclaredBatchVariables(...) {
  ...
  const declared = new Set(
    statements
      .filter((stmt) => stmt.type === "DECLARE_VARIABLE")
      .map((stmt) => stmt.name)
  );
  ...
  if (!declared.has(name)) {
    throw new Error(`ArgumentError: injected variable @${name} is not declared.`);
  }
}
```

実行器も `SET` は式をそのまま評価し、外部注入を参照するのは `DECLARE` 分岐だけである。

```ts
// src/execute.ts:1670-1720, 1725-1737
if (stmt.type === "SET_VARIABLE") {
  ...
  variables.set(stmt.name, evaluateScalarExpr(resolvedStmt.expr));
}
...
if (stmt.type === "DECLARE_VARIABLE") {
  const injected = options.variables ?? {};
  if (Object.prototype.hasOwnProperty.call(injected, stmt.name)) {
    variables.set(stmt.name, { type: "string", value: injected[stmt.name] });
  }
}
```

**提案**:

1. 実需 SQL を `DECLARE @d90 = ...; DECLARE @d30 = ...; SELECT ...` に直す。
2. `runSavedQueryInputSchema` に、`queryInputSchema.variables` と同じ `variables: Record<string,string>` を追加する。
3. `runSavedQuery` から `query()` へ `variables: input.variables` を渡す。
4. 受入条件に「未宣言名、大小文字重複、`SET` 名への注入を実行開始前に拒否」を追加する。
5. これを Phase 1 の中核変更として §4 影響範囲に明記する。

### 2.2 [中] `containsDml` の意味と Phase 1 の拒否規則が不一致。read-only 判定は `canRunWithQueryTool` を使うべき

- 該当: R1 §1、§2.2、§3、§6-2
- 根拠: `src/core/dmlGuard.ts:25-60`、`src/core/batch.ts:470-505`、`src/mcp/tools.ts:567-576`、`src/core/__tests__/batch.test.ts:35-54`

`containsDml` は構文上の DML 型ではなく、各文の `writesKintone()` の集約である。

```ts
// src/core/dmlGuard.ts:25-33, 55-60
export function isDmlType(type: string): boolean {
  return type === "INSERT"
    || type === "INSERT_SELECT"
    || type === "UPDATE"
    || type === "DELETE"
    || type === "UPSERT"
    || type === "UPSERT_SELECT"
    || type === "REORDER"
    || type === "IMPORT";
}
export function writesKintone(stmt: Statement): boolean {
  return isDmlType(stmt.type) && !("validateOnly" in stmt && stmt.validateOnly === true);
}
export function isReadOnlyStatement(stmt: Statement): boolean {
  return !writesKintone(stmt) && (isReadOnlyType(stmt.type) || isDmlType(stmt.type));
}
```

```ts
// src/core/batch.ts:470-505
results.push({
  ...
  isDml: writesKintone(stmt),
  isReadOnly: isReadOnlyStatement(stmt),
  ...
});
...
const containsDml = results.some((r) => r.isDml);
return {
  ...
  isReadOnlyBatch: !containsDml && results.every((r) => r.isReadOnly),
  containsDml,
};
```

したがって `INSERT ... VALIDATE ONLY` や APPLY 付き `UPDATE ... VALIDATE ONLY` は `containsDml === false` であり、既存テストもその契約を固定している。

```ts
// src/core/__tests__/batch.test.ts:35-41
const a = analyze("INSERT INTO APP100 (x) VALUES ('a') VALIDATE ONLY");
expect(a.isReadOnlyBatch).toBe(true);
expect(a.containsDml).toBe(false);
expect(a.statements[0]).toMatchObject({ isDml: false, isReadOnly: true, isValidationOnly: true });
```

一方、MCP validation は既に実行ツールとの適合性を返している。

```ts
// src/mcp/tools.ts:567-576
const common = {
  ...
  isReadOnlyBatch: analysis.isReadOnlyBatch,
  containsDml: analysis.containsDml,
  ...
  canRunWithQueryTool: analysis.isReadOnlyBatch,
  requiresMutationTool: analysis.containsDml,
};
```

**提案**: `readOnly: true` は `validation.canRunWithQueryTool === true` を要求する。`containsDml` は診断・エラーメッセージ用に併用してよいが、単独の許可条件にしない。仕様文言は次のどちらかに確定する。

- 推奨: 「実書き込みを行う文を 1 文でも含むバッチを拒否。`VALIDATE ONLY` 付き DML は既存 `ksql_query` 契約どおり許可」
- 本当に構文上の DML をすべて拒否するなら、`statements.some(s => isDmlType(s.statementType))` 相当の別判定が必要であり、`containsDml` は使えない。

### 2.3 [中] 手編集カタログに対する `runSavedQuery` 側の Phase 1 防御を確定事項にする必要がある

- 該当: R1 §2.2、§2.3、§6-4
- 根拠: `src/mcp/savedQueries.ts:110-153`、`src/mcp/tools.ts:1065-1082`

カタログ parser は SQL と `readOnly` の型しか検証せず、SQL の単複・安全性は検査しない。

```ts
// src/mcp/savedQueries.ts:122-153
const sql = item.sql;
const readOnly = item.readOnly;
...
if (typeof name !== "string" || typeof sql !== "string" || typeof defaultProfile !== "string") {
  throw new Error(...);
}
...
return { ... sql, ... readOnly, ... };
```

現在の `runSavedQuery` は毎回 `validate()` し、その結果を `assertSavedQuerySafety()` へ渡してから経路分岐する。この再検証は防御境界である。

```ts
// src/mcp/tools.ts:1065-1082
const saved = getSavedQuery(catalog, input.name);
...
const validation = requireSingleStatement(
  await validate({ sql: saved.sql, profile }),
  "ksql_run_saved_query"
);
assertSavedQuerySafety(saved, {
  isDml: validation.isDml,
  statementType: validation.statementType,
});
if (saved.readOnly) {
  const result = await query(..., validation);
```

**提案**: §6 の未確定から外し、保存時と実行時の両方で同一の Phase 1 safety 判定を必須にする。特に手編集された以下を `runSavedQuery` で拒否する受入を追加する。

- `readOnly: true` + 実書き込み DML 混在バッチ（`query()` 呼出 0、mutation API 0）
- `readOnly: false` + 複文（DML の有無を問わず Phase 1 では拒否、`mutate()` 呼出 0）
- `readOnly: false` + 単文 SELECT（従来どおり拒否）

### 2.4 [中] 返却規約は「最後の結果セット」ではなくバッチエンベロープ

- 該当: R1 §2.3、§3
- 根拠: `src/mcp/tools.ts:703-736`、`src/output/batchEnvelope.ts:102-186`

`query()` の複文経路は `executeBatchSql()` の後に `buildBatchEnvelope()` をそのまま返す。

```ts
// src/mcp/tools.ts:703-736
let batchResult = await executeBatchSql(...);
...
return { ...buildBatchEnvelope(batchResult, { maxTotalRecords: input.maxTotalRecords }) };
```

エンベロープは最後の結果だけではなく、すべての結果セットを `results[]` に入れ、各文を `statements[]` の `resultIndex` で対応づける。

```ts
// src/output/batchEnvelope.ts:102-108, 129-144, 178-186
* - results には結果セットを返した read-only 文の結果のみ入れる
...
entry.resultIndex = results.length;
results.push({
  type: "SELECT",
  columns: s.result.columns,
  rows: s.result.rows,
  rowCount: s.result.rowCount,
  ...
});
...
return {
  ok: batch.ok,
  batch: true,
  statementCount: batch.statementCount,
  statements,
  results,
  warnings: [],
};
```

`runSavedQuery` はさらにこれを `{ ok, name, result }` で包む。**提案**: 「`ksql_query` と同じバッチエンベロープを `result` に返す。最終 SELECT は対応する `statements[].resultIndex` から `results[]` を参照できる」に修正し、最後の結果だけへ変換する新処理は作らない。

### 2.5 [中] `ksql_list_queries` は SQL を返さない。表示仕様と受入条件が誤っている

- 該当: R1 §2.4、§3 回帰 3
- 根拠: `src/mcp/tools.ts:1039-1062`、`src/mcp/__tests__/tools.test.ts:1573-1581`

`listQueries` はメタデータのみを再構築し、`sql` を意図的に含めない。`getQuery` は `SavedQuery` をそのまま返すため SQL 全文を含む。

```ts
// src/mcp/tools.ts:1039-1062
queries: catalog.queries.map((query) => ({
  name: query.name,
  title: query.title,
  description: query.description,
  defaultProfile: query.defaultProfile,
  readOnly: query.readOnly,
  ...
})),
...
query: getSavedQuery(catalog, input.name),
```

```ts
// src/mcp/__tests__/tools.test.ts:1573-1581
const querySummaries = listed.queries as Array<{ name: string; sql?: string }>;
...
expect(querySummaries[0]).not.toHaveProperty("sql");
expect(got.query).toEqual(expect.objectContaining({
  name: "hello_query",
  sql: "SELECT 'ok' AS result",
```

**提案**: §2.4 を「list は従来どおり SQL を返さない。get は改行・セミコロンを含む SQL 全文をそのまま返す」に修正する。受入条件は list の非公開維持と get の byte-for-byte 相当の往復を別々に固定する。

### 2.6 [中] 影響範囲と受入テストが不足しており、既存 smoke が確実に破綻する

- 該当: R1 §3、§4
- 根拠: `src/mcp/schemas.ts:223-225`、`src/mcp/index.ts:199-202`、`scripts/mcp-smoke.mjs:138-154,316-333`、`docs/internal/ksql_mcp_changes.md:299-303,408-416`

R1 §4 は `saveQueryInputSchema.sql` の文言しか挙げていないが、`runSavedQueryInputSchema.dmlMaxRows` にも単文限定の説明がある。

```ts
// src/mcp/schemas.ts:223-225
dmlMaxRows: z.number().int().positive()
  .describe("... Saved queries are single-statement, so temp tables do not apply here. ...")
```

ツール description も `statement` 単数形である。

```ts
// src/mcp/index.ts:199-202
description: "Save a validated kSQL statement into the local saved query catalog.",
```

さらに smoke は `ksql_run_saved_query` に `tempTableMaxRows` が無く、description が `single-statement` を含むことを固定している。

```js
// scripts/mcp-smoke.mjs:150-154, 330-332
assert(!("tempTableMaxRows" in runSavedQueryProps), ...);
...
assert(
  savedDmlMaxRowsDesc.includes("single-statement"),
  "ksql_run_saved_query.dmlMaxRows description must state saved queries are single-statement."
);
```

**提案**: §4 に少なくとも次を追加する。

- `src/mcp/schemas.ts`: `runSavedQueryInputSchema.variables`、save SQL description、run `dmlMaxRows` description
- `src/mcp/index.ts`: save/run の複文 read-only 契約
- `src/mcp/__tests__/tools.test.ts`、`src/mcp/__tests__/savedQueries.test.ts`: 保存・手編集カタログ・実行経路・出力・変数注入
- `scripts/mcp-smoke.mjs`（必要なら pack smoke も）: schema/description 回帰
- `docs/internal/ksql_mcp_changes.md` など、現行契約として「保存 SQL は単文のみ」と明記する文書

機械的な DML 漏れ防止は、モックの `query/executeBatchSql` 呼出だけでなく、書き込み client (`postRecords/putRecords/deleteRecords`) が 0 回であることまで固定する。通常 DML、`INSERT_SELECT`、`UPSERT_SELECT`、`ON ERROR SKIP`、各 APPLY mutation、各 `VALIDATE ONLY` を表形式で網羅する。

### 2.7 [低] `requireSingleStatement` の利用者は 2 箇所だけなので、関数を残す条件は不要

- 該当: R1 §2.1、§6-1
- 根拠: `src/mcp/tools.ts:163-173,1015-1022,1065-1076`

リポジトリ内の呼び出しは `saveQuery` と `runSavedQuery` の 2 箇所だけである。

```ts
// src/mcp/tools.ts:1015-1022
const validation = requireSingleStatement(..., "ksql_save_query");
// src/mcp/tools.ts:1065-1076
const validation = requireSingleStatement(..., "ksql_run_saved_query");
```

**提案**: §6-1 を確認済みにし、両呼び出しを外した時点で dead code になるため関数自体を削除する、と仕様に確定する。

### 2.8 [低] 一時テーブル対応を掲げるなら、保存実行で非公開の batch options を制限として明記する

- 該当: R1 §1、§3
- 根拠: `src/mcp/schemas.ts:72-91,210-226`、`src/mcp/tools.ts:703-718,1082-1090`

`ksql_query` は `tempTableMaxRows/cursorMaxActive/continueOnError/maxTotalRecords/variables` を持つが、現行 `ksql_run_saved_query` はどれも持たない。R1 が明記した `maxRecords/onLimit/profile`（および現行 `fetchParallel/timeout`）は委譲されるが、保存した一時テーブル query は `tempTableMaxRows` を呼出単位で変更できない。

**提案**: Phase 1 で `variables` は高指摘 2.1 により必須追加とする。他の batch options は追加するか、`ksql_query` との差として明記して意図的にスコープ外とする。特に一時テーブルを対象に残すなら `tempTableMaxRows` 非公開を無言にしない。

## 3. 依頼の 7 点への回答

### 3.1 `readOnly: true` で `containsDml === false` は十分か

**NEEDS-CLARIFICATION。実書き込み DML の遮断には現在の AST では機能するが、保存クエリの許可条件としては `canRunWithQueryTool === true` を使うべき。**

- 全文性: `validate()` は `parseSqlStatements()` で全文を AST 化し、`analyzeBatch()` の全 `results` に対する `some(r => r.isDml)` を `containsDml` とする（`src/mcp/tools.ts:527-536`、`src/core/batch.ts:470-505`）。
- 通常 DML / `INSERT_SELECT` / `UPSERT_SELECT` / `ON ERROR SKIP` / APPLY mutation: 外側の statement type が DML で `validateOnly !== true` なら `writesKintone()` が true。`ON ERROR SKIP` も既存テストで `containsDml: true`（`src/core/__tests__/batch.test.ts:121-131`）。
- `VALIDATE ONLY`: 意図的に `writesKintone() === false` であり、`containsDml === false`。これは現行 `ksql_query` の対応能力で、漏れではない（`src/mcp/__tests__/tools.test.ts:316-339`）。R1 の文言だけが不一致。
- APPLY: mutation は DML として捕捉。APPLY `VALIDATE ONLY` は read-only として既存 `ksql_query` が明示的に許す（`src/core/__tests__/batch.test.ts:44-54`、`src/mcp/__tests__/tools.test.ts:342-374`）。
- DML サブクエリ: **現行 grammar では作れない。** スカラーサブクエリ AST は `query: SelectStatement`（`src/types/ast.ts:384-388`）で、parser も `(` の直後が `SELECT` の場合に `parseSelect()` だけを呼ぶ（`src/parser/parser.ts:519-539`）。`INSERT ... SELECT` はサブクエリではなく外側が `INSERT_SELECT`（`src/types/ast.ts:828-833`）。
- `isReadOnlyBatch`: `!containsDml && every(isReadOnly)` で、`containsDml` 単独より fail-closed（`src/core/batch.ts:494-505`）。
- 既存フィールド: `canRunWithQueryTool` は `isReadOnlyBatch`、`requiresMutationTool` は `containsDml` の別名（`src/mcp/tools.ts:567-576`）。保存クエリでは前者を許可条件にするのが直接的。

### 3.2 単文で `containsDml === isDml` は常に成り立つか

**CORRECT（現行実装では成り立つ）。** 単文結果の `isDml` は `statementValidations[0].isDml`、共通の `containsDml` は同じ analysis 結果の `some()` で生成される（`src/mcp/tools.ts:548-576,589-607`）。1 要素なので一致する。

ただし両方とも「DML 構文か」ではなく `writesKintone()` である。したがって単文 `INSERT ... VALIDATE ONLY` は両方 false で、既存保存クエリの read-only safety と整合する。この意味を R2 に明記する必要がある。

### 3.3 `requireSingleStatement` の他の利用者

**CORRECT: 他の利用者はない。** 定義 1、呼出 2（save/run）のみ（`src/mcp/tools.ts:163,1016,1070`）。両方から外すなら関数は削除可能。

### 3.4 既存カタログに複文が入り得るか、防御はどこか

**FLAWED: 手編集で入り得るため、save と run の両方に防御が必要。** catalog parser は `sql: string` としか検証しない（`src/mcp/savedQueries.ts:122-153`）。現行 run は毎回 validate と safety check を行う（`src/mcp/tools.ts:1065-1080`）。この再検証を維持し、Phase 1 の `readOnly:false + batch` 拒否も run 側で明示すること。

### 3.5 一時テーブル・変数のスコープ

**CORRECT。`runSavedQuery` が read-only batch を `query()` に渡せるようになれば、各呼出は別の Map を持つ。** 経路は `runSavedQuery` → `query(..., validation)`（`src/mcp/tools.ts:1082-1090`）→ batch 分岐の `executeBatchSql()`（`src/mcp/tools.ts:685-719`）→ `executeBatch()`（dependency default は `src/mcp/tools.ts:520-521`）。`executeBatch()` 呼出ごとの `try` 内で `tempTables` と `variables` を新規生成する。

```ts
// src/execute.ts:1530-1533
try {
  const tempTables = new Map<string, MaterializedTable>();
  const variables = new Map<string, VarValue>();
  const results: BatchStatementResult[] = [];
```

共有されるのは同一 batch 内だけで、並行する別呼出との衝突はない。受入条件は DI した `executeBatchSql` を barrier で同時進行させる形か、実 `executeBatch` の並行テストで固定できる。

### 3.6 `ksql_list_queries` / `ksql_get_query` の表示

**FLAWED。list は SQL を返さず、get は全文を返す。** list の SQL 非公開は既存テストで固定済み（`src/mcp/__tests__/tools.test.ts:1573-1578`）。get は catalog entry をそのまま返す（`src/mcp/tools.ts:1057-1062`）。改行・`;` の整形処理はない。

JSON 往復自体は `sql: input.sql` のまま保持し、`JSON.stringify` / `JSON.parse` するので構造上問題ない（`src/mcp/savedQueries.ts:182-188,206-216`）。ただし既存 round-trip test は単文だけ（`src/mcp/__tests__/savedQueries.test.ts:138-160`）なので、複文・改行・コメントを含む完全一致テストを追加すべき。

### 3.7 受入条件で検出できない穴

**FLAWED。少なくとも次が不足する。**

1. `runSavedQuery.variables` の schema 公開、`DECLARE` 既定値の上書き、`SET` への注入拒否。
2. 手編集カタログの `readOnly:true + DML batch` と `readOnly:false + batch` の実行時拒否。
3. safety matrix で `query()` / `mutate()` / `executeBatchSql()` / mutation client API の呼出回数を 0/1 で固定。
4. `VALIDATE ONLY` を許可するのか、構文 DML として拒否するのかの明示テスト。
5. 通常 DML、SELECT-based DML、`ON ERROR SKIP`、APPLY mutation、各 `VALIDATE ONLY` の分類行列。
6. バッチエンベロープ全体（複数 `results[]` と `resultIndex`）を `runSavedQuery.result` が保持する回帰。
7. list は SQL 非公開、get は複文 SQL 完全一致、catalog JSON 保存・再読込後も完全一致。
8. `maxRecords/onLimit/fetchParallel/timeout/profile/allowProfileOverride` の batch 委譲。追加する `variables` も含める。
9. 同一保存クエリの並行実行で temp/variable state が混ざらないこと。
10. schema/description/smoke の旧 `single-statement` 文言が残らないこと。

## 4. 仕様が正しかった点（R2 で消さない）

1. **単文制約が暫定ガードであるという読みは正しい。** コメントは「対応時にこのガードを外す」と明記する（`src/mcp/tools.ts:162-173`）。
2. **ガードの呼出箇所が save/run の 2 箇所だけという確認は正しい。** 他ツールへの波及はない。
3. **validation がバッチ全体と文ごとの判定を既に持つという整理は正しい。** `isReadOnlyBatch/containsDml/statements[]` は既存値であり、SQL 文字列の再走査は不要（`src/mcp/tools.ts:548-587`）。
4. **単文 `containsDml === isDml` は現行実装で成立し、同じ classifier を使えば回帰を避けられる。** ただし両者の意味は「実書き込み」である。
5. **`runSavedQuery` が実行時に保存 SQL を再 validate するという観察は正しい。** 手編集カタログへの防御として維持すべき。
6. **catalog の SQL 文字列に構造的な単文制約がないという観察は正しい。** JSON は改行・`;` を文字列として保持できる（`src/mcp/savedQueries.ts:110-153,182-188`）。
7. **一時テーブル・変数が batch invocation ごとの Map であるという観察は正しい。** 同時実行でも state は共有されない（`src/execute.ts:1530-1533`）。
8. **`saved.readOnly` による query/mutate 分岐と profile override 判定を維持する方針は正しい。** ただし分岐前の実行時 safety 再検証を必須にする。
9. **Phase 1 を read-only batch に限定する方針は保守的で妥当。** DML batch の名前一発実行を別フェーズにする判断は維持できる。
10. **単文 SELECT / 単文 DML の既存挙動を不変にする受入方針は正しい。** 既存の safety helper と同一 classifier を通すことが前提となる。

## 5. R2 への最小修正順

1. 実需例を `SET` から `DECLARE` に直し、`runSavedQuery.variables` の schema・委譲・受入を追加する。
2. read-only batch の許可条件を `canRunWithQueryTool` にし、`VALIDATE ONLY` の扱いを明文化する。
3. save/run 双方の safety 判定と `readOnly:false + batch` の実行時拒否を確定する。
4. 返却規約を「batch envelope」に、list/get 規約を実装どおりに直す。
5. schema description、tool description、smoke、契約文書を影響範囲へ追加する。
6. 上記の safety matrix と手編集 catalog 回帰を受入条件へ落とす。

