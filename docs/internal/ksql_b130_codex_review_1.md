# B130 `DESCRIBE` フラグ追加 仕様 R1 codex レビュー 1

- 対象: `docs/internal/ksql_b130_describe_flags_spec.md` R1
- 実施日: 2026-08-06
- 実施範囲: 現行コード・テスト・文書、および kintone 公式 API 文書の読み取り
- 未実施: コード変更、git 操作、kSQL MCP、`npm test`、実機 API 呼び出し

## 結論

**要修正・9 件（高 3 / 中 5 / 低 1）。現状の R1 のままでは実装着手不可。**

中核の機能要求は妥当だが、次の 3 点は実装前に仕様へ戻す必要がある。

1. 権限不足時の lookup は `null` になり得るため、「lookup オブジェクトが存在する」では lookup を落とす。
2. `KintoneFieldInfo` への必須 boolean 追加は、repo 内の型付き fixture と engine-library の公開 BYO client 型を壊す。
3. `SELECT *` が 3 列から 6 列になる変更は加法ではあるが、結果 schema の互換性としては破壊的である。「破壊的ではない」という R1 の断定は誤り。

なお、`unique === true`、`CALC || expression 非空`、既存 3 列を先頭に保って末尾追加、値を string にする方針は維持してよい。

## 指摘一覧

### H1（高）lookup は権限不足時に `null`。R1 の型と判定では実在する lookup を偽陰性にする

- 該当: R1 §2.3、§3.1、§4.1
- 該当コード: `src/core/formFieldInfo.ts:5-19,86-97`

R1 は `lookup` を「オブジェクトが存在する」と定義し、既存型も object のみを許している。

```ts
// src/core/formFieldInfo.ts:18
lookup?: { fieldMappings?: Array<{ field?: string }> };

// src/core/formFieldInfo.ts:90
for (const mapping of field.lookup?.fieldMappings ?? []) {
```

kintone 公式の Get Form Fields API は、lookup の参照先アプリに必要な権限がない場合、`properties.{fieldcode}.lookup` に **`null` を返す**と明記している。空 object ではない。したがって `Boolean(field.lookup)` / `field.lookup != null` なら、実在する lookup を `""` と誤判定する。

根拠: [Get Form Fields API - lookup response](https://kintone.dev/en/docs/kintone/rest-api/apps/form/get-form-fields/)

提案:

- `FormFieldProperty` を `lookup?: { ... } | null` にする。
- `hasLookup` は値の truthiness ではなく、API 応答に lookup キーがあること（例: `field.lookup !== undefined`、または own-property）で判定する。
- `lookup: null` を `ルックアップ = "YES"` とする受入を追加する。
- 空 object は公式契約で確認できなかったため **未確認**。防御的には lookup キーの存在で YES にすれば `{}` も正しく lookup と扱える。

### H2（高）`KintoneFieldInfo` の必須 3 プロパティ追加は型互換性を壊す

- 該当: R1 §3.1、§5、§6-1
- 該当コード: `src/execute.ts:244-258,291-313`、`src/core/index.ts:41-62`、`src/engine-library/publicTypes.ts:45-70,91-97`、`src/engine-library/readonlyClient.ts:42-48,66-83`

R1 は「公開型に必須プロパティを足さない」と書く一方、直後に `KintoneFieldInfo` へ必須 boolean 3 個を足す。現行型は export され、`KintoneClient.getFields()` の戻り値でもある。

```ts
// src/execute.ts:244,258,291
export interface KintoneClient {
  getFields: (appId: number) => Promise<KintoneFieldInfo[]>;
}
export interface KintoneFieldInfo {
  code: string;
  label: string;
  fieldType: string;
}

// src/core/index.ts:53-55
KintoneClient,
KintoneAppInfo,
KintoneFieldInfo,
```

さらに npm package の `./engine` は別の公開型 `ReadonlyFieldInfo` を BYO client に要求し、現在は 3 必須プロパティだけでも構築できる。

```ts
// src/engine-library/publicTypes.ts:58-61,91-95
export interface ReadonlyFieldInfo {
  code: string;
  label: string;
  fieldType: string;
}
export interface ReadonlyKintoneClient {
  getFields(appId: number): Promise<readonly ReadonlyFieldInfo[]>;
}
```

`KintoneFieldInfo` だけを必須拡張すると `ReadonlyFieldInfo[]` を core client へ投影する構造互換性が崩れる。`ReadonlyFieldInfo` まで必須拡張すると既存 BYO client を破壊する。実際、`acceptance.test.ts:37-47` も 3 プロパティだけの field object を返している。

なお現行 projector は最後に cast しているため、この不一致は projector 自身の compile error では検出されず、BYO metadata の新 3 値が runtime で `undefined` のまま core へ入る。

```ts
// src/engine-library/readonlyClient.ts:42,46,66-67,83
export function projectReadonlyClient(client: ReadonlyKintoneClient): KintoneClient {
  const getFields = client.getFields.bind(client);
  // ...
  getFields: (appId: number) => clientCall(() => getFields(appId)),
  // ...
}) as unknown as KintoneClient;
```

提案:

- 3 フラグは `KintoneFieldInfo` と `ReadonlyFieldInfo` の **optional** とし、公式 browser/CLI/plugin client の正規化では常に埋める。
- `executeDescribe` は `=== true` のときだけ `"YES"`、欠落は互換 fallback として `""` にする。
- BYO client が正確なフラグを返すには新 optional metadata を渡す必要があることを公開型コメントへ書く。
- あるいは DESCRIBE 専用の内部 metadata 型を分離する。ただし現行 `getFields()` だけで DESCRIBE する構造を変えるため、optional 拡張の方が小さい。

#### `KintoneFieldInfo` の全直接消費者

`rg '\bKintoneFieldInfo\b' src --glob '*.ts'` で確認した直接参照は production 17 ファイル、test 32 ファイル。producer は `formFieldInfo.ts`、API client は CLI/UI、残りは schema・DML・validation・import の消費者である。

Production:

- `src/execute.ts`
- `src/core/formFieldInfo.ts`
- `src/core/index.ts`
- `src/cli/nodeKintoneClient.ts`
- `src/ui/kintoneClient.ts`
- `src/core/applyInsertPrepare.ts`
- `src/core/applyMultiValuePlan.ts`
- `src/core/applyPatchPlanner.ts`
- `src/core/applyPatchPrepare.ts`
- `src/core/applyUpsertPrepare.ts`
- `src/core/dmlValidation.ts`
- `src/core/dmlValidationCandidates.ts`
- `src/core/emptyWildcardSchema.ts`
- `src/core/existingRecordValidation.ts`
- `src/core/postImageValidation.ts`
- `src/import/importRecordValidation.ts`
- `src/import/materializeDmlSource.ts`

Tests with direct typed fixtures/usages:

- `src/__tests__/applyPatch.execute.test.ts`
- `src/__tests__/b105UnionCountTotalCount.test.ts`
- `src/__tests__/b114ExplainFetchScope.test.ts`
- `src/__tests__/b123ExplainGroupByMetadata.test.ts`
- `src/__tests__/b126ChoiceEqualityNormalization.test.ts`
- `src/__tests__/b67RelativeDateSurfaces.test.ts`
- `src/__tests__/b71GroupByAliasStep2.test.ts`
- `src/__tests__/b71Step4Regression.test.ts`
- `src/__tests__/b72RelativeDateFullScanExactStep2.test.ts`
- `src/__tests__/b75RelativeDateCteStep1.test.ts`
- `src/__tests__/b75RelativeDateCteStep2.test.ts`
- `src/__tests__/b75RelativeDateTempStep3.test.ts`
- `src/__tests__/b76JoinPushdownStep5.test.ts`
- `src/__tests__/b77B78B75CompositionStep4.test.ts`
- `src/__tests__/b86MaterializedUnknownColumn.test.ts`
- `src/__tests__/b87MetadataCacheScope.test.ts`
- `src/__tests__/b88EmptyWildcardSchemaRestore.test.ts`
- `src/__tests__/b94CountTotalCount.test.ts`
- `src/__tests__/b97IncompleteAggregateFailclosed.test.ts`
- `src/__tests__/dmlWritableFieldCheck.test.ts`
- `src/__tests__/existingRecordValidation.test.ts`
- `src/__tests__/numberPrecision.execute.test.ts`
- `src/__tests__/window.execute.test.ts`
- `src/core/__tests__/applyInsertPrepare.test.ts`
- `src/core/__tests__/applyMultiValuePlan.test.ts`
- `src/core/__tests__/applyMultiValuePrepare.test.ts`
- `src/core/__tests__/applyPatchPlanner.test.ts`
- `src/core/__tests__/applyPatchPrepare.test.ts`
- `src/core/__tests__/applyUpsertPrepare.test.ts`
- `src/core/__tests__/dmlPrevalidation.test.ts`
- `src/core/__tests__/postImageValidation.test.ts`
- `src/import/__tests__/importRecordValidation.test.ts`

このほか engine-library の平行公開型 `ReadonlyFieldInfo` は `publicTypes.ts`、`browserClient.ts`、`index.ts` と `b95TruncationVisibility.test.ts` / `b98OuterJoinTruncation.test.ts` で直接参照される。`FormFieldProperty` は `formFieldInfo.ts` のほか CLI/UI/engine browser client の 3 API adapter が消費する。

### H3（高）「`SELECT *` の 6 列化は破壊的ではない」は誤り。同名衝突と列数依存経路もある

- 該当: R1 §0、§4.2-7、§6-2
- 該当コード: `src/execute.ts:4964-4979`、`src/engine/process.ts:95-110,126-169,1304-1332`、`src/execute.ts:5010-5015,6725-6726,7842-7847,9260-9265`

DESCRIBE の列と行は CTE にそのまま保存される。

```ts
// src/execute.ts:4969-4978
result = await executeDescribe(cte.query, client, cacheContext);
cteCache.set(cte.name, {
  rows: result.rows,
  columns: result.columns,
});
```

単一 wildcard は行の全キーをそのまま出力し、0 行時も保存済み `sourceColumns` を使う。

```ts
// src/engine/process.ts:1313-1332
if (columns.length === 1 && columns[0].type === "WILDCARD") {
  // ...全 entry を out へコピー...
  const cols = projected.length > 0 ? Object.keys(projected[0]) : [...(sourceColumns ?? [])];
  return { rows: projected, columns: cols };
}
```

したがって `WITH d AS (DESCRIBE APP1) SELECT * FROM d` の schema は確実に 3 列から 6 列へ変わる。厳密な column snapshot、CSV header、配列変換、列数検査をする既存利用者には破壊的である。加法変更であっても「非破壊」ではない。

列数・列順依存も `validCodes` 以外に存在する。

```ts
// src/execute.ts:5010-5015 — UNION は左列順へ位置対応
const leftCols = leftResult.columns;
const rightCols = rightResult.columns;
leftCols.forEach((col, i) => { mapped[col] = row[rightCols[i] ?? col] ?? ""; });

// src/execute.ts:7842-7847 — INSERT ... SELECT
if (columns.length !== stmt.fields.length) {
  throw new Error(`SELECT の列数（${columns.length}）と INSERT のフィールド数...`);
}
```

同名衝突もある。alias 付き source は修飾・非修飾の両キーを作り、JOIN merge は右行で同名非修飾キーを上書きする。

```ts
// src/engine/process.ts:103-105
row[`${alias}.${field}`] = strVal;
row[field] = strVal;

// src/engine/process.ts:164
result.push({ ...lRow, ...rRow });
```

よって DESCRIBE CTE と、フィールドコード `ルックアップ` / `重複禁止` / `計算式` を持つ APP/CTE を JOIN して `SELECT *` する形では、非修飾列が衝突する。修飾参照 `d.ルックアップ` は区別できるが wildcard の非修飾値は source 順に依存する。

提案:

- §4.2-7 を「意図した schema 拡張であり、厳密な 3 列 consumer には破壊的」と訂正し、release note / changelog 対象にする。
- direct DESCRIBE、CTE `SELECT *`、0 行 BYO DESCRIBE、UNION の列数不一致、JOIN 同名列（明示修飾は正しいこと）を受入へ追加する。
- 既存 3 列だけ必要な consumer の移行例を `SELECT フィールドコード, ラベル, タイプ FROM d` と明記する。

### M1（中）engine-library の既存受入だけでは core/MCP の「全値 string」を証明できない

- 該当: R1 §0、§2.2、§4.1、§4.2-5
- 該当コード: `src/engine-library/resultMapping.ts:25-28,31-56`、`src/mcp/tools.ts:282-291`、`src/engine/evalWhere.ts:81`

engine-library は公開前に値を無条件で `String(value)` にする。

```ts
// src/engine-library/resultMapping.ts:25-28
return Object.fromEntries(
  Object.entries(row).map(([key, value]) => [key, String(value)])
);
```

したがって `acceptance.test.ts:163-178` は、core が誤って boolean を返しても public result では string に直るため通る。一方 MCP は rows を変換せず返す。

```ts
// src/mcp/tools.ts:282-288
return {
  columns: result.columns,
  rows: result.rows,
};
```

core の型契約自体は `ProcessRow = Record<string, string>`（`evalWhere.ts:81`）なので、R1 の `"YES"` / `""` は正しい。しかし根拠と検査点が足りない。

提案:

- `execute("DESCRIBE ...")` の raw `SelectResult` で全 6 列・全値の `typeof === "string"` を固定する。
- MCP handler payload でも exact rows を固定する。
- engine-library acceptance は公開変換契約の回帰として残す。

### M2（中）言語リファレンスの DESCRIBE 誤記は §14 だけではなく §13 にもある

- 該当: R1 §1、§3.4、§5
- 該当コード/文書: `docs/ksql_language_reference.md:2091-2110,2154-2175`、`src/mcp/docsResources.ts:7-12`、`src/mcp/docsResourceBuilder.cjs:143-153`

R1 は `2163-2175` だけを対象にするが、同じ公開文書の §13 にも実行不能な英語列名がある。

```sql
-- docs/ksql_language_reference.md:2102-2109
WITH フィールド AS (DESCRIBE APP100)
SELECT * FROM フィールド
WHERE type IN ('SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT')

WITH フィールド AS (DESC APP100)
SELECT fieldCode, label FROM フィールド
ORDER BY fieldCode ASC
```

このファイルは MCP docs resource / `ksql_docs` の source そのものである。

```ts
// src/mcp/docsResources.ts:7-11
return buildDocsResourceMap(
  readFileSync(resolve(docsDir, "ksql_language_reference.md"), "utf8"),
  // ...
);
```

§14 内の DESCRIBE は `fieldCode` / `label` / `type`（2165-2167,2175）、SHOW APPS は `appId` / `name` / `description`（2148-2150,2172）で誤っている。さらに §13 と appendix の SHOW APPS 例にも `name` が残る（2099,3834）。

提案:

- B130 で DESCRIBE の全誤記（2104,2108-2109,2165-2167,2175）を直す。
- SHOW APPS の誤記（2099,2148-2150,2172,3834）を B136 に残す分割自体は妥当。ただし B130 のリリース時点でも同一 resource に既知の実行不能例が残ることを明記する。
- docs resource test に `language-reference/13-with-cte` と `14-show-apps-describe` の日本語実列名を固定する assertion を足す。現行 docs tests は section の存在・配信一致を主に見ており、この意味 drift を検出しない。

### M3（中）description の固定箇所は 4 つ。フラグ語の固定を「実装時判断」にすると再 drift を許す

- 該当: R1 §0、§3.3、§4.2、§6-3
- 該当コード: `scripts/mcp-smoke.mjs:216-220,262-268`、`scripts/mcp-pack-smoke.mjs:170-185`、`src/mcp/__tests__/metadataTools.test.ts:79-82`、`src/mcp/__tests__/tools.test.ts:75-76`

R1 が挙げる 2 smoke と `metadataTools.test.ts` に加え、`tools.test.ts` も同じ 4 語を固定する。

```ts
// src/mcp/__tests__/tools.test.ts:75-76
for (const key of ["field code", "label", "type", "ksql_app_metadata"]) {
  expect(registered.ksql_describe_app.description).toContain(key);
}
```

既存語を残すだけなら 4 つとも変更不要で通る。しかし新機能の discoverability を契約にするなら、source unit 2 本と unpacked/packed smoke 2 本の全てで `lookup` / `unique` / `calculated`（最終 wording に合わせる）を固定すべきである。`release/ksql-mcp.js` は生成物なので full build 後の packed smoke で確認する。

提案: §6-3 を未確定から外し、4 箇所すべてへ新しい 3 flag 語を追加することを受入条件にする。

### M4（中）サブテーブル子の受入がなく、flatten の再帰を証明できない

- 該当: R1 §2.4、§4.1、§4.3
- 該当コード: `src/core/formFieldInfo.ts:55-76`

再帰は同じ `flattenFields()` を通るため、実装位置としては正しい。

```ts
// src/core/formFieldInfo.ts:55-76
for (const field of Object.values(properties)) {
  const info: KintoneFieldInfo = { /* ... */ };
  out.push(info);
  if (field.fields) out.push(...flattenFields(field.fields, lookupCopyFields, true, ...));
}
```

公式 Get Form の sample は table child の `SINGLE_LINE_TEXT` に `unique: true` と `expression: ""` が来る形を示す。また公式 Field Types は table row に lookup field が含まれる場合を明記しており、子 lookup も実在する。

根拠: [Get Form API - fields in tables](https://kintone.dev/en/docs/kintone/rest-api/apps/form/get-form/)、[Field Types - table row containing a Lookup field](https://kintone.dev/en/docs/kintone/overview/field-types/)

提案:

- `formFieldInfo` unit test に top-level と child の各 `lookup` / `unique` / nonempty `expression`、親 SUBTABLE は全 false、`inSubtable` / `subtableCode` 非回帰を追加する。
- 実機 §4.3 に child lookup または child unique を持つ app を追加する。APP4228/4229 に該当 fixture がないなら「未確認」として別 app を用意する。

### M5（中）「3 つで打ち止め」と「metadata を引くべきか判断」は一致しない。既に第 4 候補がある

- 該当: R1 §1、§4.1
- 該当コード: `src/core/formFieldInfo.ts:72,86-97`

起票の `仕入先` は lookup copy destination であり、型だけでは素の文字列と区別できない。現行正規化は既にその差を `writable` に持つ。

```ts
// src/core/formFieldInfo.ts:72
writable: !lookupCopyFields.has(field.code)
  && !NON_WRITABLE_FIELD_TYPES.has(field.type),

// src/core/formFieldInfo.ts:89-92
for (const field of Object.values(fields)) {
  for (const mapping of field.lookup?.fieldMappings ?? []) {
    if (mapping.field) result.add(mapping.field);
  }
}
```

R1 の期待では `仕入先` は 3 つとも空なので、利用者は「素の writable text」と「lookup が上書きする non-writable destination」を DESCRIBE だけでは区別できない。それでも「3 つとも空なら metadata 不要」とは判断できない。`required` / length 等も同様である。

提案（いずれかを R2 で選ぶ）:

- A: 3 列の scope は維持し、目的を「lookup / unique / calculation の有無を直接表示」に狭める。「metadata を引くべきか判断」「型だけでは分からない何かの 1 bit」という完全性を示す文言を削る。
- B: 即時の第 4 候補として `書込不可`（または `ルックアップコピー先`）を追加する。ただし停止規則を改めて定義する必要がある。

本レビューでは依頼側が明示した 3 列を尊重し、A を推奨する。

### L1（低）`hasExpression` は出力意味より狭い名前

- 該当: R1 §2.3、§3.1

出力 `計算式` の判定は `fieldType === "CALC" || expression 非空` であり、単なる「expression property の有無」ではない。`hasExpression` は実装者に `Boolean(expression)` だけを連想させ、R1 が避けたい CALC 判定漏れを招く。

提案: 正規化後の名前を `isCalculated`（または `hasCalculation`）にし、`hasLookup` / `isUnique` / `isCalculated` と出力意味を揃える。

## 依頼の 7 点への回答

### 1. 列追加は既存利用者を壊さないか

**壊し得る。R1 の「破壊的ではない」は誤り。**

- direct DESCRIBE と CTE `SELECT *` は 3 列から 6 列になる。`project()` は row keys / `sourceColumns` をそのまま返す（`process.ts:1313-1332`）。
- CTE の有効列は `materialized.columns` から増える（`execute.ts:3562-3574`）だけだが、これは列解決だけの話で、出力 schema・UNION の位置対応・DML source の列数検査は別である。
- UNION は左列順へ右列を位置対応する（`execute.ts:5010-5015`）。INSERT / UPSERT SELECT は列数一致を検査する（`execute.ts:7842-7847,9260-9265`）。
- JOIN は alias 付き source に修飾・非修飾の両方を作り、右 source が同名非修飾キーを上書きする（`process.ts:103-105,164`）。新 3 列と同名の物理 field/CTE column が衝突候補になる。修飾参照は回避可能。
- engine-library の `valueType: "string"` は守れる。ただし `resultMapping` が値を String 化するため、既存 acceptance だけでは raw core/MCP の型を証明しない。core exact test が必要。

### 2. `formFieldInfo` 拡張の波及

**必須追加のままでは広く波及する。optional 追加なら既存 consumer の読み取りは非回帰。**

- 全直接 consumer は H2 に列挙した production 17 / test 32 ファイル。
- `KintoneFieldInfo` とは別に、engine package の公開 `ReadonlyFieldInfo` / BYO `getFields()` 契約がある。
- `FormFieldProperty` は CLI、plugin UI、engine browser client の API response 型として共有される。`unique?` / `expression?` の追加自体は加法だが、lookup は `| null` が必要。
- 子 field は同じ再帰関数を通る。公式資料で child `unique` と child lookup は実在を確認した。child expression の非空実例は今回の repo/実機では **未確認**だが、同じ property 判定を適用する構造でよい。

### 3. 判定条件

- `unique === true`: **正しい。** property 非在・false・lookup のいずれも空にできる。
- `fieldType === "CALC" || (typeof expression === "string" && expression.length > 0)`: **正しい。** 公式 API は `expression` を formula string と定義し、SINGLE_LINE_TEXT / NUMBER の自動計算を扱う。CALC 以外の非空 expression は公式仕様上実在するが、この repo の APP4228/4229 での実例は依頼書どおり **未確認**。
- lookup: **R1 は不正確。** full object だけでなく権限不足時 `null` が来る。lookup キーの存在で判定する必要がある。
- lookup が空 object: 公式契約では full object または `null`。空 object は **未確認**。

### 4. `"YES"` / `""` の表現

**採用可。ただし既存の同種前例は確認できなかった。**

- `src` の行返し結果で boolean を `"YES"` / `""` にする既存例はない。EXPLAIN 文中の `"true"` / `"false"` は表形式フラグ契約ではない。
- `ProcessRow` は `Record<string,string>` なので string 表現が自然。
- CTE 下流の equality は右辺を string に解決して `compareScalarValues()` へ渡す（`evalWhere.ts:127-178`）。型 metadata のない materialized column は string semantics なので `WHERE ルックアップ = 'YES'` は exact string comparison として書ける。
- `"false"` より空文字の方が表・JSON で非該当を短く表現できるという R1 の UI 理由は妥当。ただし kSQL が一般に非空文字列を boolean coercion するコード根拠はないため、「`false` が真に見える」は人間/consumer 側の誤読リスクとして書くべきである。

### 5. ツール説明文と smoke

description の固定は次の 4 箇所。

1. `scripts/mcp-smoke.mjs:216-220,262-268`
2. `scripts/mcp-pack-smoke.mjs:170-185`
3. `src/mcp/__tests__/metadataTools.test.ts:79-82`
4. `src/mcp/__tests__/tools.test.ts:75-76`

既存 4 語を残すだけなら全て通る。ただし新 3 flags を説明の契約にするなら、4 箇所すべてに flag 語を足すべき。質問の `mcp-pack-smoke.mjs:175` と `mcp-smoke.mjs:216-219` は **両方対応が必要**で、unit test 2 本も同時対応が必要。

### 6. 文書食い違いと B136 分割

- `docs/ksql_language_reference.md` は `docsResources.ts:7-12` から読み込まれ、chapter 13 と 14 がそれぞれ `ksql://language-reference/13-with-cte` / `14-show-apps-describe` と `ksql_docs` へ配信される。
- DESCRIBE の誤りは 2163-2175 だけでなく 2102-2109 にもある。B130 は DESCRIBE の全 occurrences を直すべき。
- SHOW APPS の誤りは 2099,2148-2150,2172,3834。これを B136 に回す issue 分割は妥当だが、同一配信 resource に既知の誤りが残る。
- B130/B136 の境界を test 名または tracker に明記し、B130 が SHOW APPS まで直したと誤認しないようにする。

### 7. 受入条件で検出できない穴 / 「3 つで打ち止め」

現行 §4 では次を検出できない。

- `lookup: null` の permission case
- 3 property を省略する既存 BYO client の互換 fallback
- child lookup / child unique / child calculation
- raw core と MCP rows の string 型
- CTE `SELECT *` の exact 6-column order と 0-row schema
- JOIN の新列同名衝突と修飾参照
- UNION / 厳密 column consumer の移行影響
- docs resource の §13 / §14 実列名
- packed/unpacked + unit 4 箇所の description discoverability

「すぐ 4 つ目が欲しくなる形」は既にあり、lookup copy destination の `writable: false` である。R1 の APP4228 `仕入先` がその例なのに、3 flags は全て空になる。したがって 3 列で止めるなら、「metadata を引くべきかの完全な判定面」ではなく「lookup / unique / calculation の 3 情報だけを compact に出す」と目的を狭める必要がある。

## R1 が正しかった点（R2 で消さない）

1. `ksql_describe_app` は `DESCRIBE APP<n>` を `query()` へ渡す wrapper で、別の出力実装を増やさない判断。
2. 既存 3 列の名前・順序・値を維持し、新列を末尾へ置く判断。
3. core の行値を boolean ではなく string にする判断。
4. `unique` は presence / `!== false` ではなく `=== true` とする判断。
5. `expression` は property presence ではなく非空文字列を見る判断。
6. `CALC` と nonempty expression の OR で計算列を判定する判断。
7. system field を個別列挙せず、条件に当たらなければ自然に空にする判断。
8. subtable children を現行 flatten 経路の同一判定へ載せ、親 SUBTABLE 行の扱いを変えない判断。
9. 値の中身（lookup target / formula 本文）を DESCRIBE に載せず `ksql_app_metadata` へ誘導する境界。
10. CLI/plugin renderer を DESCRIBE 専用分岐にせず、共通 `columns` / `rows` 契約で表示する判断。
11. public language reference の DESCRIBE 列名・例を実装へ同期し、例を実行確認する判断。
12. plugin bundle / MCP packed artifact を含む full build が release に必要という判断。

## R2 への最小修正案

1. `lookup?: LookupProperty | null`、lookup key present を `hasLookup` と定義。
2. `KintoneFieldInfo` / `ReadonlyFieldInfo` の新 metadata は optional。official clients は常に埋め、BYO 欠落は空表示。
3. `hasExpression` を `isCalculated` へ改名。
4. schema 3→6 は intentional breaking output change と明記し、3 列固定 consumer の移行例を追加。
5. H1/M1/M4/H3 の負例・境界を unit/acceptance に追加。
6. description の新 3 語を unit 2 + smoke 2 の全箇所で固定。
7. DESCRIBE 文書の 2104,2108-2109,2165-2167,2175 を全て修正し、docs resource assertion を追加。
8. 「metadata を引くべきか判断」を完全性の主張から外し、3 flags の限定目的へ言い換える。
