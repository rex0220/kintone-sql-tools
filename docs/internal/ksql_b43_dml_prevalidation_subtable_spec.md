# B43 — DML 事前検証の既存サブテーブル違反 false pass 解消仕様

- ステータス: **R1 起草（2026-07-21）・未実装・Claude レビュー待ち**
- 対象: プレーン `UPDATE` / `UPSERT` の update branch における `VALIDATE ONLY` / `ON ERROR SKIP`
- 一次情報: [ksql_issue_tracker.md B43](../ksql_issue_tracker.md#L37)
- 関連: [B42 サブテーブル監査](ksql_validate_subtable_audit_spec.md) / [B44 APPLY](ksql_apply_block_spec.md)

## 1. 症状と目的

実機 APP4221 `$id=7` で、次の `VALIDATE ONLY` は `validatedRows=1` / `validRows=1` / `errorCount=0` と合格した。しかし同文の実更新は `CB_VA01` となり、`records[0].テーブル.value[0..1].value.文字列T2` の `minLength` 違反を2行分報告した。`SET` はサブテーブルに触れていない。この実機結果と影響は台帳 B43 行に記録されている（[ksql_issue_tracker.md:37](../ksql_issue_tracker.md#L37)）。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 7
VALIDATE ONLY;
```

言語リファレンスは、kintone が PUT 時にレコード全体を再検証し、`UPDATE ... VALIDATE ONLY` が SET 対象列しか検証しないため、SET 対象外の既存違反（サブテーブル子を含む）で実行が失敗し得ると明記する（[ksql_language_reference.md:2025](../ksql_language_reference.md#L2025)-[2027](../ksql_language_reference.md#L2027)）。これは B11.1 実機確認を反映した B12 R6 で追記され（[ksql_on_error_skip_isolation_spec.md:12](ksql_on_error_skip_isolation_spec.md#L12)）、親仕様の制約一覧にも同じ境界が残る（[ksql_on_error_skip_isolation_spec.md:351](ksql_on_error_skip_isolation_spec.md#L351)-[355](ksql_on_error_skip_isolation_spec.md#L355)）。B44 の言語仕様も、全体再検証のためテーブル内の既存違反がトップレベルだけの UPDATE を失敗させると記録する（[ksql_language_reference.md:2300](../ksql_language_reference.md#L2300)-[2302](../ksql_language_reference.md#L2302)）。

B43 の目的は、プレーン DML の事前検証を「送信 payload の列検証」から「対象レコードの post-image 検証」へ拡張し、次を実現することである。

1. `VALIDATE ONLY` が、取得スナップショット上で kintone に PUT できない既存違反を合格と誤報告しない。
2. `ON ERROR SKIP` が該当親レコードを PUT 対象から外し、既存違反1件による100件 PUT チャンク全体の失敗を防ぐ。
3. B42（監査）→ B43（事前検証・隔離）→ B44（同時修復）を一つの運用フローとして接続する。B44 自身もこの三段連携を記載している（[ksql_apply_block_spec.md:9](ksql_apply_block_spec.md#L9)-[17](ksql_apply_block_spec.md#L17)）。

## 2. 原因と現行経路の裏取り

### 2.1 事前検証は payload にある列だけを見る

`validateDmlCandidates` は、対象列を列挙しても `candidate.payload.has(code)` が false なら検証を skip し、検証済みの書き込み値だけを `candidate.record` へ格納する（[dmlValidationCandidates.ts:42](../../src/core/dmlValidationCandidates.ts#L42)-[60](../../src/core/dmlValidationCandidates.ts#L60)）。

```ts
// Existing DML contract: only fields present in each write payload are validated here.
// B44 APPLY must validate the complete post-image via validatePostImage instead.
for (const code of targetFields) {
  if (!candidate.payload.has(code)) continue;
  const result = validateAndNormalizeDmlValue(
    candidate.payload.get(code), infoByCode.get(code)!, numberPrecision
  );
  // ...
}
```

INSERT の未指定列検査でも `info.inSubtable` は明示的に skip される（[dmlValidationCandidates.ts:63](../../src/core/dmlValidationCandidates.ts#L63)-[81](../../src/core/dmlValidationCandidates.ts#L81)）。

```ts
if (validateMissingCreateFields && candidate.mode === "create") {
  for (const info of fieldInfos) {
    if (info.inSubtable) continue;
    if (candidate.payload.has(info.code)) continue;
    // ...
  }
}
```

UPDATE 候補の `record` も、`updateToPutBatches*` が生成した SET 列だけのスパース payload である。候補化時に既存スナップショットとのマージは行われない（[execute.ts:5063](../../src/execute.ts#L5063)-[5073](../../src/execute.ts#L5073)）。

### 2.2 UPDATE / UPDATE FROM / UPSERT の現行取得範囲

プレーン UPDATE の取得は経路で異なる。

- 定数 SET で CHECK なしの通常経路は、対象の `$id` だけを取得する（[execute.ts:5048](../../src/execute.ts#L5048)-[5061](../../src/execute.ts#L5061)）。通常実行にも「`$id` のみ取得」と明記されている（[execute.ts:6049](../../src/execute.ts#L6049)-[6061](../../src/execute.ts#L6061)）。
- 行依存 SET は `$id` と式の参照列、CHECK 参照列を取得するが、レコード全体ではない（[execute.ts:5040](../../src/execute.ts#L5040)-[5047](../../src/execute.ts#L5047)）。
- `UPDATE ... FROM` はターゲット照合と SET / CHECK 評価に必要な `targetFields` だけを取得する（[execute.ts:5186](../../src/execute.ts#L5186)-[5203](../../src/execute.ts#L5203)）。
- UPSERT の既存判定は `$id` と key fields を取得して索引を作る（[execute.ts:3786](../../src/execute.ts#L3786)-[3803](../../src/execute.ts#L3803)）。事前検証候補には見つけた `targetId` を設定するだけで、対象レコード本体を取得しない（[execute.ts:4975](../../src/execute.ts#L4975)-[4987](../../src/execute.ts#L4987)）。

実コード上の通常 UPDATE と UPSERT 照合の field set は次のとおりである。

```ts
// UPDATE 通常経路
const resolved = await resolveDmlTargetIds(
  client.getRecords, getParams.app, getParams.query, {
    maxRecords: options.maxRecords ?? 10_000, parallel: options.fetchParallel ?? 1,
  }
);

// UPSERT 照合経路
const fields = ["$id", ...keyFields];
for (const chunk of splitChunks([...batchFirstKeys], UPSERT_IN_CHUNK_SIZE)) {
  const query = `${keyFields[0]} in (${chunk.map(sqlQuote).join(",")})`;
  const records = await fetchAll(client.getRecords, appId, query, fields, { maxRecords, parallel });
  // ...
}
```

したがって、「UPDATE は常に追加 GET が必要」ではない。既存 GET の field set を広げられる経路と、UPSERT-update のように照合後の snapshot GET が新たに必要な経路を分ける必要がある。

### 2.3 B44 post-image エンジンは B43 と同型

現在の package version は 3.8.0 で（[package.json:3](../../package.json#L3)）、台帳は B44 の post-image 検証を v3.8.0 の出荷済み機能と記録する（[ksql_issue_tracker.md:53](../ksql_issue_tracker.md#L53)）。B44 が新設した `validatePostImage` は、自身を「APPLY AST independent complete-record validator shared with the future B43 path」と明記する（[postImageValidation.ts:76](../../src/core/postImageValidation.ts#L76)-[84](../../src/core/postImageValidation.ts#L84)）。この validator はトップレベル全対象を走査し（[postImageValidation.ts:115](../../src/core/postImageValidation.ts#L115)-[120](../../src/core/postImageValidation.ts#L120)）、全サブテーブル行の子セルを走査して行ロケータを付与する（[postImageValidation.ts:121](../../src/core/postImageValidation.ts#L121)-[140](../../src/core/postImageValidation.ts#L140)）。

```ts
for (const field of fieldIndex.topLevel) {
  const raw = record[field.code]?.value;
  const result = validateAndNormalizeDmlValue(raw, field, numberPrecision);
  if (!result.ok) appendError(field, raw, result);
}
for (const [tableCode, children] of fieldIndex.subtables) {
  const sourceRows = record[tableCode]?.value;
  if (!Array.isArray(sourceRows)) continue;
  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex++) {
    const sourceRow = sourceRows[rowIndex] as { id?: string | number; value?: Record<string, { value?: unknown }> };
    for (const field of children) {
      const raw = sourceRow.value?.[field.code]?.value;
      const result = validateAndNormalizeDmlValue(raw, field, numberPrecision);
      if (!result.ok) appendError(field, raw, result, buildValidationCellLocator(tableCode, rowIndex, sourceRow));
    }
  }
}
```

B44 UPDATE APPLY は、`collectApplySnapshotFields` で `$id` / `$revision` と FILE を除くトップレベルコード（SUBTABLE コードを含む）を取得対象にする（[applyPatchPlanner.ts:218](../../src/core/applyPatchPlanner.ts#L218)-[236](../../src/core/applyPatchPlanner.ts#L236)）。取得後は SET / APPLY を合成した `plan.postImage` を `validatePostImage` へ渡す（[execute.ts:6090](../../src/execute.ts#L6090)-[6118](../../src/execute.ts#L6118)）。複数親でも同じ field set で対象を一括取得する（[execute.ts:6229](../../src/execute.ts#L6229)-[6245](../../src/execute.ts#L6245)）。

```ts
const plan = buildApplyPatchPlan({ statement: stmt, snapshot: response.records[0], fieldInfos, metadata });
const fieldIndex = buildPostImageFieldIndex(
  fieldInfos,
  stmt.assignments.map((assignment) => assignment.field)
);
const validation = validatePostImage(plan.postImage, fieldIndex, numberPrecision, statementNumber);
```

よって B43 は、新たなセル検証器を作るのではなく、B44 の次の境界を再利用する。

```text
complete snapshot
  + plain DML SET 適用
  = validation-only post-image
  -> validatePostImage
  -> parent-level invalid set
```

ただし B43 では、検証用 post-image と実 PUT payload を分離する。現行 UPDATE converter は SET 列だけを含む sparse record を100件ごとに PUT する（[dmlToKintone.ts:160](../../src/converter/dmlToKintone.ts#L160)-[173](../../src/converter/dmlToKintone.ts#L173)）。B43 はこの書き込み材料を全レコード payload へ変えない。

### 2.4 B42 の子フィールド検証とロケータは再利用済み

B42 は子セル生値と子 `KintoneFieldInfo` を `validateAndNormalizeDmlValue` へ渡し、必須、型、数値範囲、文字列長、選択肢、B29 整数部桁数を検査する（[execute.ts:1093](../../src/execute.ts#L1093)-[1119](../../src/execute.ts#L1119)）。B42/B44 共通 metadata index は子の所有テーブルを保持し（[existingRecordValidation.ts:23](../../src/core/existingRecordValidation.ts#L23)-[39](../../src/core/existingRecordValidation.ts#L39)）、共通 locator は取得順の1-based行番号と永続行 `id` を生成する（[existingRecordValidation.ts:55](../../src/core/existingRecordValidation.ts#L55)-[62](../../src/core/existingRecordValidation.ts#L62)）。

```ts
for (let i = 0; i < tableRows.length; i++) {
  const tableRow = tableRows[i] as { id?: string | number; value?: Record<string, { value?: unknown }> };
  for (const target of childTargets) {
    const raw = tableRow.value?.[target.field.code]?.value;
    const validation = validateAndNormalizeDmlValue(raw, target.field, numberPrecision);
    if (!validation.ok) {
      const locator = buildValidationCellLocator(tableCode, i, tableRow);
      appendError({
        id: row.id, field: target.field.code, code: validation.code,
        message: validation.message, value: renderExistingValidationValue(raw, target.field.fieldType),
        ...locator,
      });
    }
  }
}
```

B44 `postImageValidation.ts` はこれらと `validateAndNormalizeDmlValue` を既に import し（[postImageValidation.ts:1](../../src/core/postImageValidation.ts#L1)-[11](../../src/core/postImageValidation.ts#L11)）、B29 用 number precision の要否をトップレベルと子 NUMBER の両方から判定する（[postImageValidation.ts:59](../../src/core/postImageValidation.ts#L59)-[73](../../src/core/postImageValidation.ts#L73)）。B43 で B42 ロジックを別実装する必要はない。

## 3. 設計

### 3.1 適用範囲

R1 の推奨契約は次とする。

| 文種 / branch | `VALIDATE ONLY` | `ON ERROR SKIP` | プレーン実行 |
|---|---:|---:|---:|
| `UPDATE` | post-image 検証 | post-image 検証→違反親隔離 | 変更しない |
| `UPDATE ... FROM` | post-image 検証 | post-image 検証→違反親隔離 | 変更しない |
| `UPSERT` / `UPSERT ... SELECT` update branch | post-image 検証 | post-image 検証→違反親隔離 | 変更しない |
| UPSERT create branch / INSERT | 現行 create 検証を維持 | 現行 create 検証を維持 | 変更しない |
| `APPLY` 付き DML | B44 経路を維持 | B43 で新規解禁しない | B44 経路を維持 |

理由は、B43 の一次情報が `VALIDATE ONLY` / `ON ERROR SKIP` の false pass と隔離不能を対象としているためである。プレーン実行にも全 snapshot GET を強制すると、事前診断を要求していない全 UPDATE / UPSERT の read cost を変える一方、API は引き続き最終判定を行う。

### 3.2 ① snapshot fetch と post-image 生成

対象親ごとに、検証用 snapshot と現行 sparse PUT record から次を作る。

```text
validationPostImage = clone(snapshot)
for each SET field:
  validationPostImage[field] = sparsePutRecord[field]

writeRecord = sparsePutRecord  // 現行のまま
```

snapshot の fetch fields は、`$id` と、FILE および検証対象外システムフィールドを除く post-image 検証対象のトップレベルコードとする。SUBTABLE は子コードではなく親テーブルコードを fields へ入れ、全存続行と子セルを取得する。B44 の `buildPostImageFieldIndex` も FILE と非監査システム型を除外し、テーブルごとの子フィールド索引を作る（[postImageValidation.ts:13](../../src/core/postImageValidation.ts#L13)-[56](../../src/core/postImageValidation.ts#L56)）。

経路別の fetch 契約は次とする。

1. **通常 UPDATE**: 現行の対象 ID fetch を complete snapshot fetch へ置き換える。親1件ごとの GET にしない。
2. **行依存 UPDATE**: 現行の評価用 GET の field set を complete snapshot へ広げ、同じ取得結果で SET 評価と post-image 生成を行う。
3. **`UPDATE ... FROM`**: 照合対象の現行一括 GET の field set を complete snapshot へ広げる。source 取得とキー照合、50キーごとの検索、100件 PUT chunk の契約は変えない。
4. **UPSERT-update**: 現行の key 照合は維持し、distinct target ID を決定した後、`$id in (...)` の100 ID chunk で complete snapshot を追加取得する。実装は UPSERT APPLY が既に行う「distinct update IDs → 100 ID ごとの `$id in (...)` snapshot GET」（[execute.ts:4451](../../src/execute.ts#L4451)-[4466](../../src/execute.ts#L4466)）と同型にする。

`maxRecords` / `onLimit=error` による完全入力の要件は維持する。snapshot 欠落、重複 `$id`、不正 `$id`、fetch 上限超過を「その親の検証エラー」へ格下げず、文全体を PUT 0 で fail-closed にする。

### 3.3 ② 検証スコープ

R1 の推奨は **サブテーブル限定ではなく、B44 と同じ complete post-image** とする。対象は次である。

- SET 適用後のトップレベル検証対象。
- SET 対象外のトップレベル検証対象。
- 全サブテーブルの全存続行と検証対象子セル。
- トップレベルおよび子 `NUMBER` の B29 整数部桁数。

理由は、kintone の境界が「サブテーブルだけ」ではなくレコード全体であり、B44 エンジンもその境界で実装済みだからである。サブテーブル限定にすると、トップレベルの同型 false pass を既知のまま残し、`validatePostImage` 用 field index の二重化も生じる。B41/B42 `VALIDATE` による回避策の存在は、事前検証自体の false pass を残す理由にはしない。

### 3.4 ③ エラー表現と `#err` schema

B43 は B44 の post-image エラー列をプレーン DML へ適用する。現行 B12 の6メタ列は名前と順序を維持し、後ろへ4列を加える。B44 の実装定義はこの10列を固定する（[postImageValidation.ts:34](../../src/core/postImageValidation.ts#L34)-[37](../../src/core/postImageValidation.ts#L37)）。

```text
<payload columns>
$err_statement
$err_operation
$err_row
$err_field
$err_code
$err_message
$err_value
$err_subtable
$err_subrow
$err_subrow_id
```

| 列 | トップレベル違反 | 子セル違反 |
|---|---|---|
| `$err_operation` | `UPDATE` / `UPSERT` | 同左 |
| `$err_row` | 現行候補の1-based序数 | 同じ親候補序数 |
| `$err_field` | トップレベルフィールドコード | 子フィールドコード |
| `$err_value` | post-image 上の違反値 | 子セルの違反値 |
| `$err_subtable` | `""` | 所有テーブルコード |
| `$err_subrow` | `""` | snapshot 内の1-based表示序数 |
| `$err_subrow_id` | `""` | 保存済み行 `id`（仮想テーブルの `_rid` と同値） |

`postImageValidation.ts` は現在も上記値を1セル違反につ1エラー行として生成する（[postImageValidation.ts:91](../../src/core/postImageValidation.ts#L91)-[112](../../src/core/postImageValidation.ts#L112)）。B42 の詳細監査は同一 message を集約してロケータをカンマ区切りリストにするが（[ksql_validate_subtable_audit_spec.md:117](ksql_validate_subtable_audit_spec.md#L117)-[127](ksql_validate_subtable_audit_spec.md#L127)）、B43 は B12/B44 と同じセル単位エラー行を採り、`errorCount` を実違反セル数とする。

`validatePostImage` の現行 `operation` 引数型は `"INSERT" | "UPDATE"` に限定される（[postImageValidation.ts:77](../../src/core/postImageValidation.ts#L77)-[84](../../src/core/postImageValidation.ts#L84)）。B43 の UPSERT-update では公開 `DmlValidationResult.operation` の既存契約 `"UPSERT"`（[execute.ts:415](../../src/execute.ts#L415)-[423](../../src/execute.ts#L423)）を維持するため、実装時に validator の operation 型を `ValidationOperation` 相当へ拡張するか、result merger で `$err_operation` を `UPSERT` に正規化する。R1 推奨は前者とする。

「`テーブル.子`」は診断上の field path 表記とし、例は `テーブル.文字列T2` とする。ただし `#err` の機械可読契約は B42/B44 に合わせ、`$err_subtable="テーブル"` と `$err_field="文字列T2"` に分離する。`$err_field` 自体を `テーブル.子` へ変えると B42/B44 と不整合になるため採らない。

schema の一貫性のため、R1 では INSERT / UPSERT-create とトップレベルのみのエラーにも追加4列を空文字で持たせ、プレーン DML の validation schema を上記10メタ列に統一する。現行 `appendValidationErrors` は列数、列順、型メタのいずれかが異なる同名 `#err` への append を拒否する（[execute.ts:1177](../../src/execute.ts#L1177)-[1198](../../src/execute.ts#L1198)）ため、文種ごとに古い6列と新しい10列を分けない。payload columns の相違による既存 schema mismatch 規則は変えない。

### 3.5 ④ 既定 ON と opt-in

R1 の推奨は **対象の `VALIDATE ONLY` / `ON ERROR SKIP` で常に ON** とし、新しい構文、CLI flag、MCP option、プラグイン設定を追加しない。

事前検証を明示的に要求する構文が、アプリの書き込み単位と異なる不完全な境界を既定にすることは避ける。また `ON ERROR SKIP` は実隔離のために完全候補集合を PUT 前に準備する既存経路であり、現行も invalid parent を除いた後に100件ごとに PUT する（[execute.ts:4845](../../src/execute.ts#L4845)-[4876](../../src/execute.ts#L4876)）。新たな opt-in は、同じ `ON ERROR SKIP` が設定次第で true isolation と false pass の両方になる二重意味を作る。

なお「既定 ON」は、すべてのプレーン UPDATE / UPSERT 実行に追加 GET を強制する意味ではない。本仕様の対象は §3.1 の事前検証モードに限定する。

### 3.6 ⑤ `ON ERROR SKIP` の隔離対象

post-image で組み込み違反を1件以上検出した親候補は、現行 `invalidRowNumbers` と同じ隔離集合へ入れる。結果契約は次とする。

- `validatedRows`: create / update を合わせて事前検証した全親候補数。
- `invalidRows`: payload 違反、CHECK 違反、post-image の既存違反のいずれかを1件以上持つ distinct 親候補数。
- `errorCount`: 上記のエラー行総数。post-image は1セルにつき最初の組み込み違反1行。
- `validRows`: `validatedRows - invalidRows`。
- `affectedRows`: `ON ERROR SKIP` で実際に PUT / POST 対象に残った親数。
- `skippedRows`: `invalidRows`。

`REJECT LIMIT` は post-image 違反を含む `invalidRows` に対して、最初の PUT より前に判定する。上限超過では従来どおり書き込み0件とする。

これにより、対象 snapshot に既に存在する組み込み違反については true isolation になる。ただし GET 後の競合変更、権限、revision/一意性競合、ユーザー実在性等の API-time error は引き続きチャンク単位 fail-fast である。現行言語契約も API 実行時エラーを隔離しない（[ksql_language_reference.md:2043](../ksql_language_reference.md#L2043)-[2046](../ksql_language_reference.md#L2046)）。

### 3.7 B42 による現行回避策

B42 v3.7.0 後の `VALIDATE` は、既定対象に制約付き子フィールドと全子 `NUMBER` を含める（[ksql_validate_subtable_audit_spec.md:82](ksql_validate_subtable_audit_spec.md#L82)-[91](ksql_validate_subtable_audit_spec.md#L91)）。実装は取得 fields に子の親テーブルコードを入れ（[execute.ts:986](../../src/execute.ts#L986)-[1004](../../src/execute.ts#L1004)）、全子行を検査する（[execute.ts:1102](../../src/execute.ts#L1102)-[1119](../../src/execute.ts#L1119)）。したがって B43 実装前の回避策は次とする。

1. `VALIDATE APP4221 WHERE $id = 7` または必要な対象を明示して事前監査する。
2. `$id` / `$err_subtable` / `$err_subrow_id` で違反レコードと子行を特定する。`$err_subrow_id` は `_rid` と同値である（[ksql_validate_subtable_audit_spec.md:171](ksql_validate_subtable_audit_spec.md#L171)-[189](ksql_validate_subtable_audit_spec.md#L189)）。
3. 修復しない場合は、検出した親 `$id` を DML の WHERE から除外する。修復する場合は B44 `APPLY` で親 SET と子 PATCH を同一 PUT へ合成する。

起票時の `VALIDATE APP4221 WHERE $id=7` が0行だったのは B42 前の契約である。台帳は B42 後にこの回避策が両領域で利用可能と明記する（[ksql_issue_tracker.md:37](../ksql_issue_tracker.md#L37)）。B43 受入時は同じ APP4221 `$id=7` で B42 `VALIDATE` と B43 DML 事前検証の違反セル数が一致することを再確認する。

## 4. 実装境界（将来実装用）

B43 実装は、現行 `prepareDmlValidation` の「候補生成→payload 検証」の間に、update-mode 候補用の snapshot/post-image 準備を入れる。現行はここで `validateDmlCandidates` だけを呼ぶ（[execute.ts:4745](../../src/execute.ts#L4745)-[4777](../../src/execute.ts#L4777)）。

責務は次のように分ける。

1. `materialize*ValidationCandidates`: 従来どおり sparse write candidate、`targetId`、CHECK 評価行を生成する。
2. B43 snapshot loader: update-mode の distinct target ID または既存対象 GET から complete snapshot を候補と結び付ける。
3. B43 post-image builder: snapshot clone に sparse write record を上書きする。サブテーブルはプレーン DML が非接触なため snapshot の行、ID、順序、子セルをそのまま保持する。
4. `validateDmlCandidates`: payload / CHECK / create-mode の現行契約を担当する。
5. `validatePostImage`: update-mode 候補の complete post-image を検証する。
6. result merger: 両 validator のエラーを候補順と各 validator の決定的走査順で結合し、distinct parent の invalid set を1つにする。

同じ SET 対象セルを payload validator と post-image validator の両方が報告する二重カウントは許さない。推奨は、update-mode の組み込みフィールド検証を `validatePostImage` のみに任せ、`validateDmlCandidates` には preErrors / CHECK の結合と sparse record 生成の責務だけを残す形である。実装フェーズでは、エラー順序と正規化済み sparse write value の維持を回帰テストで固定する。

## 5. SemVer

推奨は **minor（次候補 v3.9.0）** とする。

- 新構文はないが、同じ `VALIDATE ONLY` / `ON ERROR SKIP` で新しい既存違反が見え、`validRows` / `invalidRows` / `errorCount` / `affectedRows` / `skippedRows` が正しく変わる。
- validation `#err` のメタ列は6列から10列へ末尾加法拡張される。
- 変化は false pass と隔離欠落の修正であるが、観測結果と read cost を変える。台帳は B8 の `maxRecords` 意味論変更を v2.11.0 の minor で出荷し（[ksql_issue_tracker.md:70](../ksql_issue_tracker.md#L70)）、B9 の比較結果の正しい変化を minor としている（[ksql_issue_tracker.md:59](../ksql_issue_tracker.md#L59)）。B13 の新しい正しい観測結果も v2.14.0 の minor である（[ksql_issue_tracker.md:67](../ksql_issue_tracker.md#L67)）。

major は不要とする。エラー列の既存名・順序は変えず、末尾の診断列追加である。patch は read cost と観測結果の変化を過小評価するため採らない。

## 6. 受入条件・テスト観点

### 6.1 core 単位テスト

1. snapshot のトップレベルと全サブテーブル行を clone し、SET 対象だけを上書きした post-image を作る。元 snapshot と sparse write record を mutate しない。
2. 既存子の required / minLength / maxLength / minValue / maxValue / choice 違反を検出する。
3. 子 NUMBER の B29 整数部桁数超過を検出し、対象アプリ単位の number precision を再利用する。
4. 子違反に `$err_subtable` / 1-based `$err_subrow` / `_rid` と同値の `$err_subrow_id` を付与する。トップレベルは3列とも空文字。
5. 同じ子フィールドが2行で違反すると `errorCount=2`、`invalidRows=1`。
6. FILE、CALC、非監査システムフィールドは B44 と同じ除外契約を維持する。
7. SET 対象セルの違反を payload/post-image で二重計上しない。

### 6.2 UPDATE 統合テスト

1. 定数 SET `VALIDATE ONLY` は `$id` だけでなくテーブルを含む complete snapshot fields を取得し、PUT 0。
2. 行依存 SET は同一 GET 結果で式評価と post-image 検証を行い、対象ごとの追加 GET を行わない。
3. `UPDATE ... FROM` は business-key の exact rematch、50キー検索、`maxRecords`、ソース行対応を維持しつつ、matched 親の complete post-image を検証する。
4. 対象0件は従来どおり `validatedRows=0`、エラー0、PUT 0。
5. 取得順にかかわらず現行の `$id` 順候補と `$err_row` を維持する。

### 6.3 UPSERT 統合テスト

1. key 照合後、update branch の distinct IDs だけを一括 snapshot GET し、create branch には不要な GET を行わない。
2. create/update 混在時も source row の `$err_row` を維持する。
3. update branch の既存子違反は `$err_operation="UPSERT"` で返し、create branch の現行エラー表現を変えない。
4. `UPSERT ... SELECT` と IMPORT が生成する UPSERT の update branch も同じ契約に入れる。IMPORT 固有のサブテーブ置換経路は対象外。

### 6.4 `ON ERROR SKIP` / `#err`

1. APP4221 相当の親1件と正常親複数件を同じ100件未満の候補に入れ、違反親だけを `#err` へ隔離して正常親のみ PUT する。
2. 複数 PUT chunk で各 chunk に違反親が混入しないことを writer call で固定する。
3. post-image 違反を含む `invalidRows` が `REJECT LIMIT` を超えたら PUT/POST 0。
4. `#err` 上限または schema mismatch は既存値を変えず PUT 0。
5. 追加4列は空エラー結果でも schema に残り、`SELECT * FROM #err` から参照できる。
6. INSERT / UPDATE / UPSERT の各 validation result が10メタ列を共有し、同じ payload schema なら同名 `#err` の append が成功する。

### 6.5 実機受入

APP4221 `$id=7` の既存データを回復可能な状態で使い、次を証跡に残す。

1. B42 `VALIDATE APP4221 WHERE $id=7` が `テーブル.文字列T2` の2行違反を検出し、`$err_subrow_id` の各値が仮想テーブル `_rid` と一致する。
2. 起票 SQL の `VALIDATE ONLY` が `validatedRows=1` / `validRows=0` / `invalidRows=1` / `errorCount=2` を返し、PUT 0。
3. 同条件の `ON ERROR SKIP INTO #err` で `$id=7` を隔離し、同一候補の正常親は書き込める。
4. B44 APPLY で該当2子行を同時修復した post-image は合格し、実 PUT が成功する。
5. 事前 GET と PUT の API call 数、取得 field set、100件 chunk を記録し、N+1 GET がないことを確認する。

## 7. スコープ外

- kintone の全 validation 規則の完全エミュレーション。現行 `validateAndNormalizeDmlValue` が担当する Tier-0 組み込み制約に限る。
- 権限、競合、一意性、lookup、関連レコード、プロセス管理、ユーザー/組織/グループ実在性等の API-time error 隔離。
- GET 後 PUT 前の snapshot 競合を防ぐ revision ガードのプレーン DML 全般への導入。B44 の revision 契約は変えない。
- `VALIDATE` への新構文、B42 SUMMARY の DML `#err` への導入、DML エラー行の message 集約。
- プレーン UPDATE / UPSERT 実行（`VALIDATE ONLY` / `ON ERROR SKIP` なし）への complete snapshot GET 強制。
- プレーン DML によるサブテーブル修復。修復は B44 `APPLY` の責務とする。
- `APPLY` 付き DML の構文・検証・mutation capability 変更。

## 8. 決定点（R1 推奨と代替案）

| # | 決定点 | R1 推奨 | 代替案 / トレードオフ | 確定 gate |
|---|---|---|---|---|
| D1 | 追加 fetch | 既存 UPDATE GET は field set 拡張、UPSERT-update は distinct IDs の一括 snapshot GET。N+1禁止 | 全経路で照合後の共通2段 GET に統一すれば実装は単純だが UPDATE の通信回数が増える | 実装計画 / Claude |
| D2 | 検証範囲 | トップレベル + 全サブテーブルの complete post-image | サブテーブル限定は fetch 量と観測変更を抑えるが、全体再検証と不一致のまま | Claude / ユーザー |
| D3 | field path | `#err` は B42/B44 同様に `$err_subtable` + `$err_field` で分離、表示は `テーブル.子` | `$err_field="テーブル.子"` は単列で人が読みやすいが B42/B44 互換性を失う | Claude |
| D4 | validation schema | 全プレーン DML validation を10メタ列へ統一 | update-mode だけ拡張は差分が小さいが、同名 `#err` append の schema 差が増える | Claude / 実装計画 |
| D5 | 既定 ON | `VALIDATE ONLY` / `ON ERROR SKIP` で常に ON、opt-in なし | opt-in は高コスト環境で選択できるが、事前検証の意味が二重化する | ユーザー |
| D6 | プレーン実行 | B43 では変更しない | 全 UPDATE/UPSERT で ON にすれば API 前エラーは増えられるが、全実行の read cost と競合窓を変える | ユーザー |
| D7 | `ON ERROR SKIP` | post-image 違反親を invalid set へ入れて PUT から除外 | 報告のみで PUT 対象に残す案はチャンク全滅を残し B43 の目的を満たさない | R1 で確定推奨 |
| D8 | 二重検証 | update-mode の組み込みセル検証は post-image validator に一元化、preErrors/CHECK は現行 validator | 両方実行後 dedupe は改修が局所的だが、キー定義とエラー順序が複雑 | 実装計画 / Claude |
| D9 | snapshot 競合 | B43 で revision ガードを追加せず、API-time failure は fail-fast 維持 | B44 同様に revision 必須にすると安全だが、プレーン DML の競合意味論全体の変更になる | Claude / 別 issue 判定 |
| D10 | SemVer | minor / v3.9.0 | patch は観測結果・schema・read cost 変更を過小評価、major は末尾加法拡張に過大 | ユーザー |
