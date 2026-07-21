# B43 DML complete post-image 事前検証 実装計画 R1

- ステータス: **実装計画 R1・Claude レビュー待ち**（2026-07-21）
- 正本仕様: [ksql_b43_dml_prevalidation_subtable_spec.md](ksql_b43_dml_prevalidation_subtable_spec.md) R1（Claude Approved）
- 対象リリース: **v3.9.0 / minor**
- 制約: 本文書は計画のみであり、コード実装、version bump、成果物生成、commit、tag、GitHub Release 作成を行わない。
- gate: 各 Phase を `Codex 実装 -> 対象テスト（修正前 fail / 修正後 pass）-> Claude レビュー -> 指摘修正` の独立単位とし、前 Phase のレビュー完了後に次へ進む。
- 文書整合: 正本仕様のステータス行はまだ「Claude レビュー待ち」（[spec:3](ksql_b43_dml_prevalidation_subtable_spec.md#L3)）だが、台帳は Approved と記録済み（[issue tracker:37](../ksql_issue_tracker.md#L37)）。本計画は依頼と台帳を正として Approved 扱いにし、Phase 1 着手時にステータス表示だけを同期する。

## 1. 結論

B43 は、プレーン DML の `VALIDATE ONLY` / `ON ERROR SKIP` に限り、update-mode 候補を complete snapshot と sparse PUT record から complete post-image に組み立て、B44 の `validatePostImage` で full record 検証する。通常 UPDATE は既存 GET の field set を拡張し、UPSERT-update だけ照合後の distinct target ID を100件ずつ追加取得する。1親1 GET は導入しない。

処理境界は次に固定する。

```text
materialize*ValidationCandidates
  -> sparse candidate / targetId / CHECK evaluation row
  -> complete snapshot の候補への結合（update-mode のみ）
  -> snapshot clone + sparse record = validation post-image
  -> preErrors
  -> validatePostImage（update-mode の組み込みセル検証を一元化）
  -> CHECK
  -> candidate 単位 result merger / distinct invalidRowNumbers
  -> VALIDATE ONLY: write 0
     ON ERROR SKIP: invalid parent を除外 -> REJECT LIMIT -> 最大100件/chunkで write
```

実 PUT record は complete post-image にしない。現行 converter は SET 列だけの sparse record を100件ごとに PUT するため（[dmlToKintone.ts:160](../../src/converter/dmlToKintone.ts#L160)-[173](../../src/converter/dmlToKintone.ts#L173)）、検証用 post-image と書き込み用 sparse record を別オブジェクトとして維持する。

以下の仕様決定 D1～D10 は reopen しない。

- D1: UPDATE の既存 GET field 拡張、UPSERT-update のみ100 ID単位追加 GET、N+1禁止。
- D2: トップレベル＋全サブテーブルの full record。
- D3: 子セルは `$err_subtable` と `$err_field` を分離し、表示時だけ `テーブル.子`。
- D4: 全プレーン DML validation を10メタ列へ統一。
- D5/D6: `VALIDATE ONLY` / `ON ERROR SKIP` では常時 ON、処分節なしのプレーン実行は非変更。
- D7/D8: post-image 違反親を真に隔離し、update-mode 組み込み検証は `validatePostImage` のみで行う。
- D9/D10: revision guard は追加せず、v3.9.0 minor とする。

## 2. 現行コードの裏取りと挿入点

### 2.1 共通 orchestration の挿入点

正本仕様 §4 の挿入点は現行コードと一致する。`prepareDmlValidation` は writable field と number precision を解決した後、候補を生成して直ちに payload validator を呼んでいる（[execute.ts:4745](../../src/execute.ts#L4745)-[4777](../../src/execute.ts#L4777)）。snapshot/post-image 準備は `materializeValidationCandidates` の後、`validateDmlCandidates` の前へ置く。

```ts
const candidates = await materializeValidationCandidates(
  stmt, operation, client, options, cacheContext, tempTables, infoByCode
);
const { errors, invalidRows, invalidRowNumbers } = validateDmlCandidates(
  candidates, operation, payloadFields, targetFields, fieldInfos, statementNumber,
  numberPrecision, stmt.checkGroups ?? [], validateMissingCreateFields, includePreErrors
);
const columns = [...payloadFields, ...VALIDATION_META_COLUMNS];
```

変更対象:

- `src/execute.ts:4738-4811` `PreparedDmlValidation` / `prepareDmlValidation`: snapshot/post-image prepared data、candidate 単位 merger、10列 column/meta を組み込む。
- `src/execute.ts:4895-4988` `materializeValidationCandidates`: create/update branch と source row number は維持し、UPSERT target ID 決定後の snapshot loader へ必要情報を渡す。
- `src/core/dmlValidationCandidates.ts:11-24` `DmlValidationCandidate`: sparse write record と validation snapshot/post-image を混同しない型境界を追加する。
- `src/core/dmlValidationCandidates.ts:30-114` `validateDmlCandidates`: create-mode の現行組み込み検証を維持し、update-mode は preErrors / CHECK と sparse record 準備だけに限定する。

現行 validator は `payload.has(code)` の対象だけを検証・normalize し（[dmlValidationCandidates.ts:42](../../src/core/dmlValidationCandidates.ts#L42)-[60](../../src/core/dmlValidationCandidates.ts#L60)）、preErrors、組み込みエラー、CHECK を同じ `rowErrors` へ順に積む（[dmlValidationCandidates.ts:48](../../src/core/dmlValidationCandidates.ts#L48)-[110](../../src/core/dmlValidationCandidates.ts#L110)）。B43 では update-mode の順序を `preErrors -> post-image 組み込みエラー -> CHECK` として固定し、従来のカテゴリ順を保つ。候補順を外側の安定順とし、各候補内では post-image validator の決定的走査順を使う。

### 2.2 snapshot field set と post-image core

B44 の field index は FILE、CALC、非監査システム型を除き、トップレベルと所有テーブル別の子索引を作る（[postImageValidation.ts:13](../../src/core/postImageValidation.ts#L13)-[56](../../src/core/postImageValidation.ts#L56)）。B43 用 snapshot field collector はこの index から次だけを返す。

```text
["$id", ...検証対象トップレベル code, ...subtable 親 code]
```

子 code を GET `fields` へ直接入れず、親テーブル code で全存続行・行 ID・子セルを取得する。`$revision` は追加しない。B44 の `collectApplySnapshotFields` は `$id` / `$revision` と非 FILE のトップレベル code を収集する実例だが（[applyPatchPlanner.ts:218](../../src/core/applyPatchPlanner.ts#L218)-[236](../../src/core/applyPatchPlanner.ts#L236)）、B43 では D9 と検証対象限定 field set のため専用 collector を設ける。

core の候補挿入先は新規 `src/core/dmlPrevalidation.ts` とする（ファイル名だけは実装時に既存命名へ合わせて変更可）。責務は次の3つに限定する。

1. `collectDmlPrevalidationSnapshotFields(fieldIndex)`: 上記 GET field set を決定する。
2. `buildDmlValidationPostImage(snapshot, sparseRecord)`: deep clone した snapshot の sparse field だけを上書きし、入力を mutate しない。
3. `mergeDmlCandidateValidation(...)`: preErrors / post-image errors / CHECK を候補単位で結合し、distinct parent の invalid set と、post-image の正規化結果から SET field だけを射影した sparse write record を返す。

`validatePostImage` は clone 後、トップレベルと全テーブル行を検証し（[postImageValidation.ts:85](../../src/core/postImageValidation.ts#L85)-[140](../../src/core/postImageValidation.ts#L140)）、normalized complete record を返す（[postImageValidation.ts:141](../../src/core/postImageValidation.ts#L141)-[148](../../src/core/postImageValidation.ts#L148)）。B43 はこれを再利用し、別のセル validator を作らない。

### 2.3 operation 型と10メタ列

公開 result は既に `INSERT | UPDATE | UPSERT` を持つ（[execute.ts:415](../../src/execute.ts#L415)-[423](../../src/execute.ts#L423)）一方、`validatePostImage` の operation は `INSERT | UPDATE` に狭い（[postImageValidation.ts:77](../../src/core/postImageValidation.ts#L77)-[84](../../src/core/postImageValidation.ts#L84)）。`ValidationOperation` を共通型として参照できるよう依存を整理し、UPSERT-update の各エラーを最初から `$err_operation="UPSERT"` で生成する。

現行 plain validation のメタ列は6列だけである（[dmlValidationCandidates.ts:26](../../src/core/dmlValidationCandidates.ts#L26)-[28](../../src/core/dmlValidationCandidates.ts#L28)）。B44 suffix はその後ろに4列を加えた10列を既に定義している（[postImageValidation.ts:34](../../src/core/postImageValidation.ts#L34)-[37](../../src/core/postImageValidation.ts#L37)）。B43 では plain DML の唯一の定義を次に統一する。

```text
$err_statement, $err_operation, $err_row, $err_field, $err_code, $err_message,
$err_value, $err_subtable, $err_subrow, $err_subrow_id
```

D4 に従い、INSERT、UPSERT-create、preError、CHECK、トップレベルだけのエラーは追加4列（`$err_value`, `$err_subtable`, `$err_subrow`, `$err_subrow_id`）をすべて `""` にする。子セルエラーだけが違反値と3 locatorを持つ。`validatePostImage` 自体のB44出力契約は変えず、plain DMLのresult mergerでこのshapeへ正規化する。これは内部row shapeの統一であり、既存 error code/message の新契約ではない。

変更対象:

- `src/core/dmlValidationCandidates.ts:26-28`: plain validation も10列になる共通定義へ変更。
- `src/core/dmlValidationCandidates.ts:101-110`: すべての plain error row に追加4キーを必ず生成。
- `src/core/postImageValidation.ts:34-37`: 重複定義を共通定義へ寄せる。
- `src/execute.ts:4777-4810`: columns と追加4列の synthetic string metadata を生成。
- `src/execute.ts:6474-6498` `applyValidationColumnMeta`: B44 と plain の10列型が同じであることを回帰確認し、必要なら共通 helper に抽出。

同名 `#err` は列数、列順、型メタのいずれかが異なれば append 前に拒否し、既存行を変更しない（[execute.ts:1177](../../src/execute.ts#L1177)-[1198](../../src/execute.ts#L1198)）。したがって全 plain DML を同じ10メタ列へ一括移行し、6列と10列を混在させない。

### 2.4 UPDATE 各経路

通常 UPDATE validation 候補は3経路を持つ（[execute.ts:5026](../../src/execute.ts#L5026)-[5073](../../src/execute.ts#L5073)）。挿入点は次のとおり。

- 定数 SET / CHECKなし: `src/execute.ts:5048-5061` の `$id` 解決を、同じ query・上限・parallel の complete snapshot fetch へ置換する。candidate は現行どおり `$id` 昇順に sort する（`src/execute.ts:5063-5073`）。
- 定数 SET / CHECKあり: `src/execute.ts:5050-5055` の `[$id, ...checkTargetFields]` を complete snapshot fields へ拡張し、同じ record を CHECK evaluation と post-image に使う。
- 行依存 SET: `src/execute.ts:5040-5047` の `getParams.fields + checkTargetFields` を complete snapshot fields へ拡張し、同じ record を式評価、CHECK、post-image に使う。

通常実行の `executeUpdate` は別 dispatch であり、行依存は参照列 GET（[execute.ts:6019](../../src/execute.ts#L6019)-[6046](../../src/execute.ts#L6046)）、定数 SET は `$id` のみ GET（[execute.ts:6049](../../src/execute.ts#L6049)-[6061](../../src/execute.ts#L6061)）を続ける。B43 の field 拡張をこの通常実行側へ波及させないことを D6 の非回帰テストで固定する。

`UPDATE ... FROM` は source を materialize した後、50 keyずつ target を検索し、現在 `targetFields` だけを取得する（[execute.ts:5153](../../src/execute.ts#L5153)-[5203](../../src/execute.ts#L5203)）。`targetFields` を complete snapshot fields との和集合に広げるが、次は変えない。

- source key の正規化と重複拒否（`src/execute.ts:5170-5182`）。
- 50 key chunk、filter query、`maxRecords` / `onLimit:error`（`src/execute.ts:5184-5208`）。
- 64文字前方一致の過剰取得に対する target `$id` dedupe と後続 exact rematch（`src/execute.ts:5210` 以降）。
- `$id` 順 candidate と source row 対応（`src/execute.ts:5109-5131`）。

### 2.5 UPSERT-update snapshot

plain UPSERT validation は `$id` と key fields だけで照合索引を作り（[execute.ts:3786](../../src/execute.ts#L3786)-[3803](../../src/execute.ts#L3803)）、候補へ `mode` と `targetId` を設定するだけである（[execute.ts:4975](../../src/execute.ts#L4975)-[4988](../../src/execute.ts#L4988)）。この照合を変更せず、全候補の branch 決定後に update-mode の `targetId` を distinct 化して snapshot を追加取得する。

実装パターンは UPSERT APPLY の次の既存コードを流用する（[execute.ts:4451](../../src/execute.ts#L4451)-[4466](../../src/execute.ts#L4466)）。

```ts
const updateIds = [...new Set(targetIds.filter((id): id is number => id !== undefined))];
for (const ids of splitChunks(updateIds, 100)) {
  const response = await client.getRecords({
    app: stmt.appId,
    query: `$id in (${ids.join(",")}) limit 500`,
    fields: [...new Set(snapshotFields)],
  });
  // $id -> snapshot
}
```

B43 では `$revision` を `snapshotFields` に含めない。snapshot 欠落、重複 `$id`、不正 `$id` は candidate error へ格下げせず、write 0 の文全体エラーにする。create-mode 候補だけなら追加 snapshot GET は0回とする。`UPSERT ... SELECT` と IMPORT が生成する通常 UPSERT は `materializeValidationCandidates` の同じ branch 判定を通るため同じ loader に含めるが、IMPORT 固有のサブテーブル置換 / record-number update 経路は対象外とする。

### 2.6 隔離と REJECT LIMIT

`executeOnErrorSkip` は `#err` append 後に `invalidRows` で REJECT LIMIT を判定し（[execute.ts:4828](../../src/execute.ts#L4828)-[4843](../../src/execute.ts#L4843)）、`invalidRowNumbers` にない候補だけを選ぶ（[execute.ts:4845](../../src/execute.ts#L4845)-[4876](../../src/execute.ts#L4876)）。B43 result merger が post-image 違反親も同じ set に加えることで、writer の構造は維持したまま true isolation になる。

順序は `全 snapshot/post-image 準備 -> 全検証 -> #err schema/上限検査 -> REJECT LIMIT -> confirm -> POST/PUT` とし、どの前段失敗でも write 0 とする。API-time の権限、競合、一意性等はここへ変換せず、既存の chunk fail-fast を維持する。

## 3. Phase 分割

### Phase 1 — core primitive と10メタ列共通化（M）

着地点: DML 用 snapshot field collector、非破壊 post-image builder、normalized sparse projector、`validatePostImage` の UPSERT operation、plain DML 10メタ列を単体テスト可能にする。`prepareDmlValidation` への接続はまだ行わない。

変更候補:

- 新規 `src/core/dmlPrevalidation.ts` と `src/core/__tests__/dmlPrevalidation.test.ts`。
- `src/core/postImageValidation.ts:34-37,77-84`。
- `src/core/dmlValidationCandidates.ts:9,26-28,101-110`。
- `src/core/__tests__/postImageValidation.test.ts:46-83` の UPSERT / schema 回帰追加。

受入テスト（修正前 fail -> 修正後 pass）:

1. snapshot のトップレベルと複数サブテーブル全行を clone し、SET field だけを上書きする。snapshot / sparse record は不変、行 ID・順序・非接触子セルも不変。
2. collector は `$id`、全検証対象トップレベル、全テーブル親 code を含み、子 code、FILE、除外system、`$revision` を含まない。
3. post-image は子 required / minLength / maxLength / minValue / maxValue / choice と子 NUMBER 整数部桁数を検出し、同じ子の2行違反を `errorCount=2`, `invalidRows=1` とする。
4. 子は `$err_value` と table code / 1-based row / 永続 row IDを持ち、トップレベルだけのエラーは追加4列とも空文字。
5. `validatePostImage(..., operation="UPSERT")` が `$err_operation="UPSERT"` を返す。
6. INSERT/preError/CHECK を含む plain error row が空文字の追加4列を必ず持ち、空結果でも columns は10メタ列を保持する。

独立 gate: core 対象テスト green、既存 B44 `postImageValidation.test.ts` green、実行経路は未変更。

### Phase 2 — `prepareDmlValidation` orchestration と二重検証排除（M）

依存: Phase 1。

着地点: `prepareDmlValidation` の候補生成と validation の間へ prepared post-image / result merger を接続できる共通境界を作る。UPDATE/UPSERT loader は test seam とし、Phase 3～5 で実 GET を接続する。

変更候補:

- `src/execute.ts:4738-4811`。
- `src/core/dmlValidationCandidates.ts:30-114`。
- `src/__tests__/dmlCustomCheck.test.ts:40-154` の preError / built-in / CHECK 順序回帰。
- `src/__tests__/execute.test.ts:182-223` の INSERT/UPSERT-create 10列回帰。

受入テスト（修正前 fail -> 修正後 pass）:

1. update-mode は SET 対象の組み込み違反を `validateDmlCandidates` と `validatePostImage` で二重計上せず1件だけ返す。
2. 1候補内の順序を `preErrors -> full post-image built-in -> CHECK`、候補間の順序を `rowNumber` 順に固定する。
3. post-image により正規化された SET field だけを新しい sparse write record へ射影し、非 SET field / subtable を PUT record に混入させない。
4. create-mode の required/default/型/範囲/choice/precision と UPSERT key error の件数・code/message は不変で、追加4列だけ増える。
5. `columnMeta` は `$err_statement/$err_row` が number、他の `$err_*` が string となり、同 payload schema の INSERT/UPDATE/UPSERT append が成功する。

独立 gate: loader fixture で orchestration を証明し、records API call 数の変更はまだ公開しない。

### Phase 3 — 通常 UPDATE 統合（定数 SET / 行依存 SET）（L）

依存: Phase 2。

着地点: `materializeUpdateValidationCandidates` の3通常分岐で既存 GET field set を complete snapshot へ広げ、追加 GET なしで post-image 検証を行う。

変更候補:

- `src/execute.ts:5026-5073`。
- `src/__tests__/execute.test.ts:1047-1100` と新規 B43 integration cases。
- `src/__tests__/numberPrecision.execute.test.ts:136-166` の update validation precision 回帰。

受入テスト（修正前 fail -> 修正後 pass）:

1. APP4221相当: SET 非対象テーブルの同じ子 field 2行に minLength 違反がある定数 UPDATE `VALIDATE ONLY` は、修正前 `validRows=1/errorCount=0`、修正後 `validRows=0/invalidRows=1/errorCount=2`、PUT 0。
2. GET spy は `$id` と検証対象top-level/table codeを含み、1回の共有 fetch 系列だけを使う。対象親数を増やしても親ごとの GET が増えない。
3. 行依存 SET は同じ GET record で式評価と post-image 検証を行い、normalized sparse PUT projection を保持する。
4. CHECKあり定数 SET も同じ GET record を CHECK evaluation と post-image に共有する。
5. 対象0件は `validatedRows=validRows=invalidRows=errorCount=0`、write 0。
6. fetch 戻り順を逆転しても candidate / `$err_row` は現行どおり `$id` 昇順。
7. 処分節なしの定数 UPDATE は引き続き `$id` のみ、行依存 UPDATE は参照列だけを GET し、complete snapshot GET を行わない。

独立 gate: UPDATE / UPDATE CHECK / B21 行依存 SET 回帰 green。UPSERT と UPDATE FROM は未接続。

### Phase 4 — `UPDATE ... FROM` 統合（M）

依存: Phase 3。

着地点: target の既存一括 GET field set を complete snapshot へ拡張し、source matching と post-image 検証を同じ target record で行う。

変更候補:

- `src/execute.ts:5109-5131` `materializeUpdateFromValidationCandidates`。
- `src/execute.ts:5146-5220` `resolveUpdateFromMatchedRecords`。
- `src/__tests__/executeBatch.test.ts:561-620,685-710`。
- `src/__tests__/execute.test.ts:3833` 以降の APP source / business-key cases。

受入テスト（修正前 fail -> 修正後 pass）:

1. `$id` join と business-key join の matched 親で、SET 非対象の既存トップレベル/子違反を検出する。
2. source row、target candidate、`$err_row` の対応を維持する。
3. 50 key chunk、64文字共通prefixの過剰取得後 exact rematch、target重複、source key重複拒否を維持する。
4. `maxRecords` 超過、snapshot `$id` 不正/欠落は write 0 の文全体エラー。
5. GET call 数は現行 target chunk 数と同じで、matched 親ごとの追加 GET はない。
6. 処分節なし `UPDATE ... FROM` の field set / write 挙動は非変更。

独立 gate: UPDATE FROM の app source / temp source / CHECK / B22文字列回帰 green。

### Phase 5 — UPSERT-update 統合（L）

依存: Phase 2。実装順は Phase 4 後とする。

着地点: branch 照合後、update-mode の distinct target ID だけを100件ずつ complete snapshot GETし、create/update混在を共通 merger へ渡す。

変更候補:

- `src/execute.ts:4895-4988`。
- `src/execute.ts:4451-4466` の UPSERT APPLY pattern を共通 helper 化する場合は B44 回帰を同時実行。
- `src/__tests__/execute.test.ts:203-223,426-446`。
- `src/__tests__/executeBatch.test.ts:495-519`。
- `src/__tests__/numberPrecision.execute.test.ts:136-166`。

受入テスト（修正前 fail -> 修正後 pass）:

1. update IDs 0 / 1 / 100 / 101 と重複target IDを用い、snapshot GET が0 / 1 / 1 / 2回、各 query がdistinct IDのみ、最大100 IDである。
2. create-only は追加 snapshot GET 0。create/update混在でも元 source row の `$err_row` を維持する。
3. update branch の既存子違反は `$err_operation="UPSERT"`、create branch の code/message/row は不変で追加4列だけ空文字を持つ。
4. `UPSERT ... SELECT` と IMPORT生成UPSERTの update branchにも適用し、IMPORT固有サブテーブル置換経路には適用しない。
5. snapshot 欠落、duplicate、不正 `$id` は POST/PUT 0 の文全体エラー。
6. 処分節なし plain UPSERT / UPSERT SELECT の照合 GET と write API call 数は非変更。

独立 gate: UPSERT VALUES / SELECT / CHECK / number precision / APPLY UPSERT 非回帰 green。

### Phase 6 — `ON ERROR SKIP` true isolation / REJECT LIMIT / 全回帰（M）

依存: Phase 3～5。

着地点: post-image 違反親を共通 invalid set に統合し、全 writer と `#err` atomicity を end-to-end で固定する。

変更候補:

- `src/execute.ts:4814-4892` `executeOnErrorSkip`（構造維持、merged invalid set 接続）。
- `src/execute.ts:1177-1198` `appendValidationErrors`（仕様変更なし、回帰テスト追加）。
- `src/__tests__/executeBatch.test.ts:430-559` と新規 multi-chunk B43 cases。
- `src/mcp/__tests__/tools.test.ts:241-266,2196-2210` の result shape / guard 回帰。
- `src/cli/__tests__` と `src/ui/__tests__/renderResult.test.ts` の10列表示回帰。

受入テスト（修正前 fail -> 修正後 pass）:

1. 既存違反親1件＋正常親複数件を同じ100件未満の候補へ入れ、違反親だけ `#err`、正常親だけ PUT。
2. 201候補等の複数chunkで、writer の全 records から違反親が除かれ、chunk size <= 100。
3. post-image 違反を含む distinct `invalidRows` が `REJECT LIMIT` を超えると PUT/POST 0。
4. 同一親に payload/preError/CHECK/post-image の複数エラーがあっても `invalidRows=1`、`errorCount` はセル/エラー行総数。
5. `#err` schema mismatch / `tempTableMaxRows` 超過は既存行不変、write 0。
6. INSERT / UPDATE / UPSERT の同 payload schema・10メタ列 append は成功し、空 `#err` でも追加4列を `SELECT *` で参照できる。
7. `VALIDATE ONLY` と `ON ERROR SKIP` は同一入力で errors の内容・順序が一致する。
8. API-time error は candidate 隔離へ変換せず、従来どおり chunk fail-fast。
9. full `npm test` を実行し、既存 plain INSERT `#err` 6列固定 assertion / snapshot を10列へ意図的に更新したもの以外に差分がない。

独立 gate: 全自動テスト green、build/version/artifact はまだ変更しない。

### Phase 7 — 実機受入・文書・v3.9.0 release 準備（L）

依存: Phase 6 の Claude Approved。

Phase 7a（M）実機 gate:

1. APP4221 `$id=7` の対象データと復旧手順を先に記録する。
2. B42 `VALIDATE` が `テーブル.文字列T2` の2セルを検出し、各 `$err_subrow_id` と `_rid` が一致する。
3. 起票 UPDATE `VALIDATE ONLY` が `validatedRows=1 / validRows=0 / invalidRows=1 / errorCount=2`、PUT 0。
4. 同条件を正常親と混在させた `ON ERROR SKIP INTO #err` が `$id=7` だけを隔離し、正常親を書き込む。
5. B44 APPLY で2子行を修復した post-image が合格し、実 PUT が成功する。
6. UPDATE / UPSERT-update の GET call 数、fields、100 ID chunk を証跡化し、N+1がないことを確認する。
7. fixture を復旧し、復旧後の値を再読して証跡に残す。

Phase 7b（M）文書 gate:

- `docs/ksql_language_reference.md:1989-2046`: SET対象だけという既知制約を削除し、対象モードの complete post-image、10メタ列、true isolation、API-time非隔離、plain実行非変更を明記。
- `docs/ksql_issue_tracker.md:33-37`: B43 を v3.9.0 実装・実機結果へ更新し、B42 -> B43 -> B44 の運用導線を維持。
- `CHANGELOG.md:1` 付近: v3.9.0 の false pass 修正、read cost、`#err` 6->10列、互換性注意を記載。
- `README.md` と該当 tutorial/recipe: `VALIDATE ONLY` / `ON ERROR SKIP` の観測変更が公開説明に現れる箇所だけを同期する。新flag/option/settingは記載しない。
- 必要なら `docs/internal/evidence/b43_dml_prevalidation_smoke.md` を新設し、SQL、結果、call counts、復旧を保存する。

Phase 7c（L）release artifact gate:

1. `package.json:3`、`package-lock.json:3,9`、`prod/manifest.json:3` を3.9.0へ同期する。現在はいずれも3.8.0（[package.json:3](../../package.json#L3)、[manifest.json:3](../../prod/manifest.json#L3)）。
2. `npm test`、`npm run build`、`npm run mcp:smoke`、`npm run mcp:pack-smoke` を実行する。script入口は [package.json:22](../../package.json#L22)-[36](../../package.json#L36)。
3. build は package version を plugin zip名へ使い（[build.mjs:29](../../build.mjs#L29)-[31](../../build.mjs#L31)）、MCP server versionにも埋め込む（[build-mcp.mjs:11](../../build-mcp.mjs#L11)-[21](../../build-mcp.mjs#L21)）。生成物内の3.8.0残存を `rg` で監査する。
4. `release/VERSION.txt`、`release/README.txt`、`release/ksql-plugin-v3.9.0.zip`、`release/ksql-mcp.js`、`release/ksql-mcp.mcpb` を最終buildから更新する。旧version成果物の扱いは既存release運用に従い、計画段階で削除方針を追加しない。
5. Firefox / Chromium plugin smoke と CLI / MCP smoke を実行し、ユーザー提供または実機のbrowser結果をrelease gateとして保存する。
6. release差分の Claude 最終レビュー後にのみ commit / PR を作成する。PR green・承認後に merge -> `v3.9.0` tag -> GitHub Release（plugin zip / MCP JS / MCPB の3 asset）-> npm publish -> latest/version確認の順で行う。tag/Release/publish は本計画作成時には行わない。

## 4. 受入条件の Phase 割付

| 仕様 §6 | 観点 | Phase |
|---|---|---:|
| §6.1.1, 6.1.4, 6.1.6 | clone、locator、除外型 | 1 |
| §6.1.2, 6.1.3, 6.1.5 | 子制約、B29、2セル/1親 | 1 |
| §6.1.7 | SET対象の二重計上禁止 | 2 |
| §6.2.1, 6.2.2, 6.2.4, 6.2.5 | 定数/行依存/0件/$id順 | 3 |
| §6.2.3 | UPDATE FROM | 4 |
| §6.3.1～6.3.4 | UPSERT branch / 100 ID / operation / IMPORT | 5 |
| §6.4.1～6.4.6 | isolation、chunk、REJECT LIMIT、#err atomicity/schema | 6 |
| §6.5.1～6.5.5 | APP4221、B42/B44連携、API call evidence | 7a |

## 5. 既存 `#err` 6列 -> 10列化の影響範囲

これは payload columns を除くメタ列の末尾加法変更であり、plain INSERT / UPSERT-create も対象になる。主な監査範囲は次のとおり。

| 影響面 | 現行根拠 | 必須対応 |
|---|---|---|
| メタ列定義 | `src/core/dmlValidationCandidates.ts:26-28` は6列 | 10列の単一定義へ変更 |
| error row shape | `src/core/dmlValidationCandidates.ts:101-110` は6キーだけ生成 | 追加4キーを常時生成 |
| result columns/meta | `src/execute.ts:4777-4810` | 空結果を含め10列、型メタ追加 |
| `#err` append | `src/execute.ts:1177-1198` | schema一致/atomicityを維持 |
| INSERT validation | `src/__tests__/execute.test.ts:182-200` | columns、各rowの空4列を追加確認 |
| UPSERT validation | `src/__tests__/execute.test.ts:203-223` | create/update混在、operation、row順を確認 |
| batch append/isolation | `src/__tests__/executeBatch.test.ts:480-559` | 同schema append、上限、VALIDATE/SKIP同値を10列で確認 |
| B44 post-image | `src/core/__tests__/postImageValidation.test.ts:46-83` | 既存10列と共通定義化して非回帰 |
| APPLY integration | `src/__tests__/applyPatch.execute.test.ts:1060-1083,1485-1486` | 既存10列 assertion が変わらないことを確認 |
| CLI/UI/MCP | `src/ui/__tests__/renderResult.test.ts`, `src/mcp/__tests__/tools.test.ts` | JSON/table表示で列欠落・並べ替えがないことを確認 |
| docs/release bundle | 言語 reference §17.1/17.2、`release/ksql-mcp.js` | 公開契約と生成物を最終phaseで同期 |

特に「エラー0件なら追加列を省く」実装は禁止する。`appendValidationErrors` は rows ではなく columns と columnMeta も比較するため、空の最初の文が作った `#err` に後続文が append するケースでも10列 schemaが必要である。

## 6. リスクと非回帰 gate

| リスク | 症状 | gate |
|---|---|---|
| SETセル二重検証 | `errorCount` が2倍、REJECT LIMIT誤発火 | update-mode built-inはpost-imageのみ。Phase 2で1セル1行固定 |
| エラー順序 drift | CHECKや候補順が変わりsnapshot/UI差分 | `preErrors -> built-in -> CHECK`、候補row順、validator走査順をPhase 2/6で固定 |
| sparse payload汚染 | complete record/subtableをPUTし意図しない更新 | normalized post-imageから元sparse fieldだけ射影。PUT spyでexact equality |
| snapshot mutate | 後続候補やCHECKが書換後値を見る | cloneの参照非共有をPhase 1で検査 |
| N+1 GET | 対象件数に比例してAPI call増 | UPDATEは既存GET拡張、UPSERTは100 ID chunk。1/100/101件call数を固定 |
| snapshot不完全 | false pass、誤った親への結合 | 欠落/重複/不正ID/maxRecordsを文全体 fail-closed、write 0 |
| number precision取り漏れ | SET非対象の親/子NUMBER違反を見逃す | `postImageNeedsNumberPrecision` と同じfull index基準でapp設定を最大1回取得 |
| `#err` schema drift | INSERT後UPDATE append失敗、空結果で列消失 | 全plain DML同時10列化、columnMeta一致、空schemaテスト |
| B44回帰 | operation共通化やsuffix移動でAPPLY診断が変化 | B44 unit/integration全実行、既存columns/errors exact一致 |
| D6違反 | 通常UPDATE/UPSERTまでread cost増 | validation dispatch（`execute.ts:1513-1540`）だけへ接続し、通常execute spyをPhase 3/5で固定 |
| API-time意味論変更 | revision競合が新たに行隔離される | `$revision`取得/PUTを追加せず、API errorはchunk fail-fast試験 |
| IMPORT経路混線 | JSON subtable replacementの意味が変化 | 通常生成UPSERTだけ対象、IMPORT専用validation/write suiteを全回帰 |

### 実装時決定点（仕様を変更しない内部詳細）

以下だけを Claude にコードレビューで確認してもらう。いずれも D1～D10 を選び直す論点ではない。

1. `ValidationOperation` の配置を循環依存なしに共通型ファイルへ移すか、`postImageValidation.ts` が type-only import するか。
2. B43 core helper の最終ファイル名。責務3分割と公開範囲は本計画どおりとする。
3. B43内の post-image field走査順を、既存SETエラー順の維持のため「SQL target field順を先頭、その後metadata順」とするか、B44既存metadata順へ統一するか。どちらでも候補順とカテゴリ順は固定し、採用順をテストと文書で明示する。仕様上のエラー集合・件数・locatorは変えない。
4. UPSERT APPLY の100 ID loaderを共通 helperへ抽出するか、plain用に同型実装するか。call契約、fail-closed、B44回帰は同じ gate とする。

## 7. スコープ外

正本仕様 §7 をそのまま適用する。

- kintone の全 validation 規則の完全エミュレーション。現行 Tier-0 `validateAndNormalizeDmlValue` の範囲だけを扱う。
- 権限、競合、一意性、lookup、関連レコード、プロセス管理、ユーザー/組織/グループ実在性等の API-time error 隔離。
- revision guard の plain DML への導入、GET後PUT前競合の解消、API errorのretry。
- `VALIDATE` の新構文、B42 SUMMARY の plain DML `#err` への導入、message集約。
- 処分節なしの plain UPDATE / UPSERT への complete snapshot GET 強制。
- plain DMLによるサブテーブル修復。修復はB44 APPLYの責務。
- APPLY付きDMLの構文、validation、mutation capability変更。
- 新しい構文、CLI flag、MCP option、plugin設定。

## 8. Phase 一覧と完了 gate

| Phase | 内容 | 規模 | 依存 | 独立完了 gate |
|---:|---|:---:|---|---|
| 1 | core primitive + operation + 10メタ列 | M | なし | core/B44 unit green、runtime未接続 |
| 2 | prepare orchestration + result merger + 二重検証排除 | M | 1 | fixture統合、順序/正規化/sparse shape green |
| 3 | 通常UPDATE（定数/行依存/CHECK） | L | 2 | false pass修正、GET拡張、D6/N+1非回帰 |
| 4 | UPDATE FROM | M | 3 | match/chunk/maxRecords維持＋full post-image green |
| 5 | UPSERT-update 100 ID snapshot | L | 2（順序は4後） | 0/1/100/101、混在、UPSERT operation green |
| 6 | isolation / REJECT LIMIT / 全自動回帰 | M | 3～5 | invalid親除外、write 0 gate、`npm test` green |
| 7a | APP4221実機・復旧・API call evidence | M | 6 | B42/B43/B44三段の実機証跡 |
| 7b | language/tracker/CHANGELOG/README/evidence | M | 7a | 公開契約・台帳同期レビュー |
| 7c | v3.9.0 build/artifact/PR→tag→Release準備 | L | 7b | version/artifact/smoke整合、Claude最終Approved |

実装順は `1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7a -> 7b -> 7c` とする。version bump、CHANGELOG、release成果物は7cより前に変更しない。

## 9. Claude レビュー重点

1. `prepareDmlValidation` の挿入位置が候補生成後・payload検証前であり、通常実行dispatchへ漏れていないか。
2. update-modeの組み込み検証が `validatePostImage` だけで、SETセルの二重計上がないか。
3. normalized complete recordからsparse SET fieldsだけを戻し、subtable/非SET fieldをPUTしないか。
4. UPDATE 3経路と UPDATE FROM が既存 GET の field拡張だけで、N+1を作らないか。
5. UPSERT-updateが照合後distinct ID・100 ID chunk・create-only追加GET 0・`$err_operation="UPSERT"`を満たすか。
6. preErrors / built-in / CHECK、候補順、field走査順と、distinct parentのinvalid setが安定しているか。
7. plain INSERTを含む10メタ列・columnMeta・空schema・append atomicityが全面同期しているか。
8. post-image違反がREJECT LIMITより前に数えられ、全writerから除外される一方、API-time errorはfail-fastのままか。
9. `$revision`や新構文/flag/option/settingが混入せず、D1～D10とスコープ外を守っているか。
