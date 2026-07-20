# B44 v1 `APPLY PATCH` 実装計画

- ステータス: 実装計画 R1 **承認済み**（2026-07-20・codex 作成→Claude レビュー＝引用裏取り全一致・判断事項5件を §14 で裁定。Phase 1 から実装着手可）
- 対象ブランチ: `feat/b44-apply-patch`
- 正本仕様: [B44 APPLY ブロック仕様 R2](ksql_apply_block_spec.md)
- 対象版: **v3.8.0**（SemVer minor）
- 制約: 本計画では実装・版数更新・ビルド・リリース成果物更新を行わない。各 Phase は `実装 → 対象テスト → Claude review → 必要な修正` を完了条件とし、Phase 7 だけ実機 gate を追加する。

## 1. 結論と実装方針

B44 v1 は、既存のトップレベル UPDATE とサブテーブル仮想テーブル UPDATE を順番に呼ぶ機能にはしない。`UPDATE ... APPLY` 専用経路で、単一親の取得スナップショットから親 SET と子 PATCH を一つの post-image／PUT record へ合成する。

```text
parser/AST
  → v1 scope validator（単一親・1 APPLY・PATCH のみ）
  → form metadata と GET field-set の解決
  → 単一親 snapshot GET（$id・$revision・親参照列・全 post-image 検証対象）
  → 子 selector を snapshot 上で解決
  → 重複検出・親 SET／子 PATCH の post-image 合成
  → post-image 全体検証
  → dmlMaxRows／dmlMaxSubtableRows 判定
  → VALIDATE ONLY 結果、または確認後に revision 付き 1-record PUT
```

安全上の不変条件は次のとおりとする。

- v1 は親 `UPDATE`、`$id = <正の安全な整数>` の単一親、1文1サブテーブル、1 `APPLY`、`PATCH` のみを実行可能にする。
- `APPEND`、`REMOVE`、`EXPECT ROWS`、`_idx`、複数 `APPLY` は AST まで識別し、共通 v1 scope validator が `UnsupportedError: ... is not supported in APPLY v1` 形式で拒否する。構文を知らないために一般 ParseError になる状態にはしない。
- malformed な句順、空ブロック、空操作、`APPLY SUBTABLE ...` は構文エラーであるため `ParseError` とする。
- planner、post-image validator、guard は `src/execute.ts` の巨大関数へ埋め込まず、純粋関数中心の新規モジュールへ分離する。`execute.ts` は metadata／records API と mutation の orchestration に限定する。
- Phase 1～3 では `UPDATE ... APPLY` の実 mutation dispatch を閉じる。Phase 4 で revision、全件先行検証、二重ガードが揃ってから CLI／plugin 用 core mutation を開通する。MCP mutation は Phase 6 後も閉じたままにする。
- v1 は単一親なので PUT の100親チャンク処理を実装しない。planner の結果型を `ApplyParentPlan[]` とせず、まず単数 `ApplyPatchPlan` として固定し、将来の複数親 adapter が `readonly ApplyPatchPlan[]` をチャンク化できる境界を残す。

## 2. 現行コードの裏取りと再利用境界

### 2.1 そのまま再利用する資産

| 資産 | 現行コード | B44 での使い方 |
|---|---|---|
| soft keyword 判定 | `src/parser/parser.ts:2751-2753` の `isSoftKeyword`。`CHECK`／`VALIDATE ONLY` も `src/parser/parser.ts:2674-2750` で IDENT 文脈判定 | `APPLY`、`PATCH`、`APPEND`、`REMOVE`、`ROWS`、`EXPECT`、`AT`、`LEAST`、`MOST` を予約語へ追加せず同じ方式で読む |
| UPDATE AST／parser の挿入点 | `src/types/ast.ts:764-778` の `UpdateStatement`、`src/parser/parser.ts:2586-2671` の `parseUpdate` | 親 WHERE の後、CHECK／validation suffix の前へ apply block parser を置き、AST に `applyBlocks?` を加法追加する |
| 代入 parser | `src/parser/parser.ts:2896-2911` の `parseAssignments`、`src/parser/parser.ts:2912` 以降の `parseAssignmentValue` | 親 SET と PATCH SET で同じ assignment/value AST を使う。PATCH 側の許可式は v1 scope validation で絞る |
| ブロック内セミコロンの token | lexer は `src/lexer/lexer.ts:219` で `;` を `SEMICOLON` 化し、トップレベル分割は `src/parser/parser.ts:212-231` | apply block parser が括弧内 `SEMICOLON` を先に消費し、ブロック外だけを `parseStatements` に残す。lexer の文字列・コメント処理は維持する |
| 子行の仮想列展開 | `src/execute.ts:6001-6024` の `expandRowsForSubtableDml` が `_pid`、`_rid`、0-based `_idx`、親 `_p.*`、子セルを構築 | 実装を直接呼ぶのではなく、v1 が親 `_p.*` と `_idx` を拒否できるよう、行 flatten 部分を共有 helper へ抽出して selector 評価だけ再利用する |
| WHERE ローカル評価 | `src/engine/evalWhere.ts:76` の `evalWhere` | metadata で安全性を検査した後、取得済み全子行に対して selector を評価する。kintone query 押し下げを正集合にしない |
| 子フィールド型解決 | `src/execute.ts:5787` の `buildSubtableFieldTypeResolver` と `src/execute.ts:2467` の typed-IN 参照収集 | APPLY 対象テーブルの子 metadata だけを使う resolver へ抽出・再利用し、他テーブル／親参照を fail-closed にする |
| 子 assignment 評価 | `src/execute.ts:6110-6120` の `evalAssignmentValueForSubtable` | snapshot の `flat` 行を入力として PATCH 右辺を評価する。対応外 expression は既存同様に明示拒否し、将来拡張は一箇所に閉じる |
| revision 付きサブテーブル PUT | `src/execute.ts:5881-5931` は親取得後、`getRevision` と `buildSubtablePatchPutParams` で revision を PUT に含める。`getRevision` は `src/execute.ts:6033-6036` | revision の取得・REST shape を再利用する。ただし B44 は親 SET とテーブルを同一 `record` に入れる専用 builder を新設し、revision 省略を型上許さない |
| form metadata | `src/core/formFieldInfo.ts:22-38` の table→children index、`src/core/formFieldInfo.ts:44-76` の `subtableCode` 付き flatten | APPLY target が SUBTABLE か、子が対象テーブル所属か、書込み可否、post-image 全フィールドを解決する共通 index として使う |
| B42 子セル検証 | `src/execute.ts:756-815` が監査対象 metadata を解決し、`src/execute.ts:984-1005` がトップレベルと子セルを `validateAndNormalizeDmlValue` へ渡して1-based行番号／row idを付ける | metadata 導出、値の描画、子 locator の規則を共通 helper へ抽出する。B44 は変更セルだけでなく全 post-image を走査する |
| 検証 primitive | `src/core/dmlValidation.ts:37-106` の `validateAndNormalizeDmlValue` | required、range、length、choice、NUMBER precision の正とする。B44 独自のセル検証を複製しない |
| 既存候補検証 | `src/core/dmlValidationCandidates.ts:26-28` の既存6メタ列、`src/core/dmlValidationCandidates.ts:30` 以降の `validateDmlCandidates` | 既存6列の名前・順序と親単位の集計方法を再利用する。payload にある列しか検証しない現関数自体は post-image 検証には使わない |
| DML validation result | `src/execute.ts:348-361` の `DmlValidationResult`、`src/mcp/tools.ts:305-318`、`src/output/batchEnvelope.ts:125-145` | `apply`／`guards` を optional な加法フィールドとして追加し、MCP単文・batch envelope・plugin render を同時に伝播する |
| EXPLAIN | `src/execute.ts:6977` 以降の `executeExplain`、`src/core/explainMetadata.ts:48-67` の metadata 必要性判定 | APPLY target の SUBTABLE 確認には form metadata を許可するが、records/mutation API は呼ばない専用 plan formatter を追加する |

### 2.2 分離して新設する資産

- `src/core/applyPatchScope.ts`（新規）: v1 の静的 scope、親 `$id` 単一条件、句併用禁止、safe child predicate の AST walk、対象 field／assignment の重複を検査する。`analyzeBatch` と executor の双方から呼び、MCP `ksql_validate` でも API 前に拒否できるようにする。
- `src/core/applyPatchPlanner.ts`（新規）: API 非依存の snapshot→selector 解決→重複検出→post-image→PUT record draft を構築する。入力は AST、親 snapshot、解決済み metadata／field type、出力は immutable な plan とする。
- `src/core/postImageValidation.ts`（新規）: 1親の全トップレベル値・全サブテーブル・全存続子行を検証し、B44 locator 付き error rows と normalized post-image を返す。B43 が後からプレーン DML に接続できるよう APPLY AST に依存させない。
- `src/core/applyPatchTypes.ts`（新規候補）: `ApplyPatchPlan`、`ApplyValidationDetail`、`ApplyGuardDetail`、`ApplyConfirmDetail` を共有し、`execute.ts`／CLI／MCP／plugin の循環依存を避ける。型が小さければ `src/execute.ts` の公開型に置き、planner 内部型だけを新規ファイルに閉じてもよい。
- `src/converter/applyPatchToKintone.ts`（新規）: revision を必須引数とし、親 assignment とサブテーブル payload を1個の `records[]` 要素へ合成する。既存 `updateToPutBatches`（`src/converter/dmlToKintone.ts:164-173`）は revision とテーブルを扱わないため変更しない。

## 3. Phase 1 — lexer/parser/AST と v1 scope（M）

### 3.1 着地点と依存

- 依存: なし。
- 着地点: 正常な APPLY 文と将来構文を AST 化でき、v1外構文を API 0 回で明示拒否できる。executor はまだ `UnsupportedError: APPLY execution is not enabled in this phase` とし、書込みへ接続しない。
- 対応受入条件: 仕様 §11.1 全項目、§11.2 の `_idx` v1拒否、APPEND／REMOVE／EXPECT／複数ブロックの拒否部分。

### 3.2 作業項目

1. `src/types/ast.ts:764-778`
   - `UpdateStatement.applyBlocks?: ApplyBlock[]` を追加する。
   - `ApplyBlock { field, operations }`、`PatchOperation`、将来構文を保持する `AppendOperation`／`RemoveOperation`、`RowSelector`、`ExpectRowsGuard` を追加する。
   - v1外 node も捨てずに kind を保持する。`_idx` は通常の WHERE AST の field ref として保持する。
2. `src/parser/parser.ts:2586-2671`
   - 親 WHERE 解析後、`APPLY <IDENT> (` が続く場合だけ `parseApplyBlock()` を呼ぶ。
   - block 内 PATCH SET は `parseAssignments`（`src/parser/parser.ts:2896-2911`）を再利用し、`WHERE` または `ALL ROWS` を必須にする。
   - APPEND／REMOVE／EXPECT ROWS の全 grammar を §2.1 どおり認識する。v1範囲外判定は parser ではなく scope validator に委譲する。
   - APPLY 後に CHECK／ON ERROR SKIP、VALIDATE ONLY 後に APPLY、APPLY後の親WHEREを拒否する。UPDATE FROM＋APPLY は AST 化後 scope validator で明示拒否する。
   - `APPLY SUBTABLE テーブル` は `<field> (` の形でないため、専用の `ParseError: APPLY SUBTABLE noun is not supported; use APPLY <field> (...)` を返す。
3. `src/parser/parser.ts:212-231`、`src/lexer/lexer.ts:219`
   - `parseApplyBlock` が括弧内 `SEMICOLON` と任意の末尾セミコロンを消費する。
   - `)` 後の文終端はトップレベル parser に残す。文字列／line comment／block comment 内の `;` は lexer の現行 tokenization 非回帰テストで固定する。
4. `src/core/applyPatchScope.ts`（新規）、`src/core/batch.ts:360-404`
   - `assertApplyV1Scope` を追加し、親 UPDATE、1 block、PATCH only、`$id = positive safe integer` の完全一致、対象1テーブル、`_idx`／`_p.*`／subquery／aggregate／window／KLIKE 等の拒否、CHECK／FROM／ON ERROR SKIP／REJECT LIMIT 排他を検査する。
   - `APPEND`／`REMOVE`／`EXPECT ROWS`／複数 block は、repo の既存慣例に合わせ `new Error("UnsupportedError: ...")` とする（現行 IMPORT の例は `src/execute.ts:4975-4979`）。
   - `analyzeBatch` と `executeParsedStatement` の入口で同じ validator を呼び、MCP static validate と直接 `execute()` の判定を一致させる。
5. `src/core/dmlGuard.ts:53-64`、`src/core/explainMetadata.ts:48-67`
   - APPLY付き VALIDATE ONLY は read-only、通常 APPLY は mutation、いずれも complete input と分類する。
   - EXPLAIN が APPLY target metadata を必要とすることを判定する。

### 3.3 テスト

- 新規 `src/parser/__tests__/applyPatch.test.ts`: 正常 AST、soft keyword 同名 field／alias／logical app、句順、empty block／operation、block 内セミコロン、末尾セミコロン、文字列・コメント内 `;`、`APPLY SUBTABLE`。
- 新規 `src/core/__tests__/applyPatchScope.test.ts`: v1許可集合と、APPEND／REMOVE／EXPECT／`_idx`／複数 block／FROM／CHECK／ON ERROR SKIP／0・負数・非整数・複合親 WHERE の明示拒否。
- `src/parser/__tests__/parser_compat.test.ts`: AST snapshot を加法更新し、APPLY等を識別子として使う既存文を固定する。
- `src/core/__tests__/batch.test.ts`: batch analysis の `isDml`／`isReadOnly`／`requiresCompleteInput` と validate-all-first を固定する。

## 4. Phase 2 — snapshot 取得契約と合成 planner（L）

### 4.1 着地点と依存

- 依存: Phase 1 AST／scope。
- 着地点: metadata と単一親 snapshot を入力に、API write を伴わず決定的な `ApplyPatchPlan` を生成できる。GET adapter の統合テストでは `$id`、`$revision`、必要な親列、対象テーブル全体を要求することまで確認する。
- 対応受入条件: §11.2 の親子1 PUT合成、snapshot selector、重複検出、保持契約、GET field-set、revision入りPUT draft、1親1record。

### 4.2 作業項目

1. `src/execute.ts:5490-5590`
   - `executeUpdate` の最上流で `stmt.applyBlocks?.length` を判定し、通常 UPDATE／UPDATE FROM／仮想テーブル UPDATE から分離して `executeApplyPatchUpdate` へ dispatch する。
   - 現行の通常 UPDATE は定数代入なら `$id` のみ取得する（`src/execute.ts:5564-5576`）ため流用しない。
2. `src/core/formFieldInfo.ts:22-38`、`src/execute.ts:3808-3825`
   - cached form metadata から target table、全 children、全トップレベル検証対象を解決する。
   - target不存在、非SUBTABLE、childの別table所属、非writable／system assignment を最初の records API 前に拒否する。
3. `src/core/applyPatchPlanner.ts`（新規）
   - `collectApplySnapshotFields` を作り、`$id`、`$revision`、親 SET 右辺参照列、対象サブテーブル全体、post-image検証に必要なトップレベル／全サブテーブルを重複除去して返す。
   - post-image 全体検証のため、実装上は原則フォーム上の全トップレベル field code と全 SUBTABLE code を GET fields に含める。FILE は仕様対象外として metadata validation で明示拒否するか、GET対象から除外して post-image 完全性を損なわない根拠を別途示す。
   - 親 `$id` query は専用 `id = <n>` に変換し、結果0件／2件以上／返却 `$id` 不一致を `ArgumentError` にする。単一親のため `fetchAll` 全件走査は使わない。
   - `expandRowsForSubtableDml`（`src/execute.ts:6001-6024`）から snapshot row flatten helper を抽出し、`_rid` と子値だけを許可した `evalWhere`（`src/engine/evalWhere.ts:76`）で全行を評価する。
   - `_rid = value` の0行は error、一般述語0行と空tableの ALL ROWS は no-op。同一 `_rid` の snapshot 内重複、unknown／別親相当を拒否する。
   - 全 operation を更新前 snapshot に対して解決してから、`(rowId, childField)` key で同一セル多重PATCHを検出する。同一行の異なるセルは許可する。
   - 対象外行、未指定セル、row id、元の配列順を保持した post-image を作る。PATCH RHS も更新前 `flat` で評価し、先行PATCH結果を後続PATCHから見せない。
4. `src/converter/applyPatchToKintone.ts`（新規）
   - `{ app, records:[{ id, revision, record:{ ...parentValues, [table]:{value: rows} } }] }` を生成する。`revision` は required number とし、`0` fallback を許さない。
   - 現行 `getRevision`（`src/execute.ts:6033-6036`）は欠落を0にするため、B44用 `requireRevision` を新設し、欠落・非正整数を PUT 前に拒否する。
5. `src/execute.ts:6110-6120`
   - 子 assignment evaluator を planner から使える leaf module へ抽出するか、同等の pure helper を共通化する。親 SET は既存 `updateToPutBatchesArith` の行評価ロジック（`src/converter/dmlToKintone.ts:214-230`、`:323` 以降）を1親用に抽出し、親／子とも同じ snapshot から評価する。

### 4.3 テスト

- 新規 `src/core/__tests__/applyPatchPlanner.test.ts`: `_rid`／safe predicate／ALL ROWS、0件規則、snapshot評価、同一セル重複、同一行別セル、未知／重複rid、行順・id・未指定値保持、親SET合成。
- 新規 `src/converter/__tests__/applyPatchToKintone.test.ts`: 1 parent＝1 `records[]` element、revision必須、親とtableが同じrecord、row payload保持。
- 新規 `src/__tests__/applyPatch.execute.test.ts`: mock client の GET fields/query と API順を固定し、この Phase では putCalls=0 の planner-only hook または VALIDATE用内部入口で確認する。

## 5. Phase 3 — post-image 全体検証（L）

### 5.1 着地点と依存

- 依存: Phase 2 post-image。
- 着地点: B44/B43共用可能な validator が、変更有無を問わず1親の全 post-image を検証し、親／子 locator 付き診断と normalized post-image を返す。mutation はまだ閉じる。
- 対応受入条件: §11.2 の非更新親、対象外table、未変更子の既存違反検出、子／親 locator、PUT前全検証。

### 5.2 作業項目

1. `src/core/postImageValidation.ts`（新規）
   - `validatePostImage(record, fieldIndex, numberPrecision, statementNumber)` を作る。
   - top-level は SUBTABLE／FILE／非監査systemを除く全対象、subtable は全tableの全存続row・全childを走査する。
   - 各セルは `validateAndNormalizeDmlValue`（`src/core/dmlValidation.ts:37-106`）へ渡し、成功値は normalized post-image に反映する。
   - 親単位 invalid set、cell error count、fixed column order を返す。1セル1エラーの既存 primitive 契約を維持する。
2. `src/execute.ts:756-815`、`:984-1005`
   - B42 の metadata解決、value render、1-based `subrow` と `_rid` locator を shared helper へ抽出し、B42 outputを非回帰に保つ。
   - B44 error row は payload列の先頭 `$id` と親 SET target列を持ち、後ろへ既存6列＋`$err_value`、`$err_subtable`、`$err_subrow`、`$err_subrow_id` を固定順で付ける。`$id` をメタ列として重複させない。
3. `src/core/dmlValidationCandidates.ts:30` 以降
   - `validateDmlCandidates` は既存 DML の payload-only検証として残す。B44から呼ばないことをテスト／コメントで固定する。
4. `src/execute.ts:3816-3825`
   - NUMBERがpost-imageのどこかにある場合だけ number precision をcache経由で取得する。親／子で別ルールを持たない。

### 5.3 テスト

- 新規 `src/core/__tests__/postImageValidation.test.ts`: 非更新親、PATCH対象外table、未変更row、変更child、0行table、required／range／length／choice／B29 precision、normalize結果。
- `src/core/__tests__/dmlValidation.test.ts`: primitive再利用の境界と既存 payload-only経路の非回帰。
- `src/__tests__/applyPatch.execute.test.ts`: `$id`、`$err_subtable`、1-based `$err_subrow`、`$err_subrow_id`、トップレベル時の空locator3列、1件でもerrorならputCalls=0。
- `src/__tests__/existingRecordValidation.test.ts`: B42抽出後も詳細／SUMMARY列、grouping、row locatorが不変。

## 6. Phase 4 — revision・二重件数ガード・core mutation 開通（M）

### 6.1 着地点と依存

- 依存: Phase 2 planner、Phase 3 post-image validation。
- 着地点: CLI／pluginから利用可能な core mutation が、全 preflight後にだけ revision付き単一PUTを1回行う。MCP側の拒否はPhase 6で追加するまで、surface capability flag未指定時は coreで閉じる。
- 対応受入条件: §11.2 の revision、先行全検証、二重guard、101子行、重複排除count、revision conflict非retry。

### 6.2 作業項目

1. `src/execute.ts:424-451`
   - `ExecuteOptions` に APPLY専用の `dmlMaxRows?`、`dmlMaxSubtableRows?`（正整数、既定100）と `allowApplyMutation?: boolean` を追加する。
   - guardをconfirm callbackだけに委ねない。direct core caller、CLI、pluginで同じ二重guardを必ず通す。
2. `src/core/applyPatchPlanner.ts`
   - `changedSubtableRows` は同一 `(parentId, table, rowId)` の重複排除数とし、同一rowの複数cell変更を1件と数える。
   - v1のparentRowsは0または1。親selector0件は仕様の単一親契約上 `ArgumentError` とし、通常mutation／VALIDATE ONLYとも同じにする。
3. `src/execute.ts:5490-5590`
   - `executeApplyPatchUpdate` を接続する。順序は metadata/static checks → GET → plan全構築 → post-image全検証 → guard → confirm → PUT。
   - post-image error、duplicate、unknown rid、guard超過ではputCalls=0。mutationでは guard超過をerror、VALIDATE ONLYではPhase 5の `wouldExceed=true` 結果へ分岐する。
   - PUTは1親・1request・1record。revision conflictをcatchして再GET／再評価／retryしない。kintone errorを成功件数へ変換しない。
4. `src/execute.ts:411-422`
   - `DmlConfirmContext` に optional `applyDetail` を加え、親件数、変更子行合計、table別 PATCH件数、deletedRows=0、revisionRequired=true を渡す。
   - IMPORTの `importDetail` と排他的に扱い、既存confirm consumerを壊さない。
5. `src/core/dmlGuard.ts:53-64`
   - `allowApplyMutation` はsurface capabilityであり、VALIDATE ONLY／EXPLAINには不要とする。未指定の実mutationは fail-closed にする。

### 6.3 テスト

- `src/core/__tests__/applyPatchPlanner.test.ts`: 1row複数cell＝1、異なるrows＝N、一般述語0／ALL ROWS空＝0。
- `src/__tests__/applyPatch.execute.test.ts`: guard以内で1 PUT、親1＋子101で0 PUT、validation errorで0 PUT、confirm前に全preflight済み、confirm拒否、revision必須、conflict非retry。
- `src/__tests__/executeBatch.test.ts`: APPLYを含むbatchでも文単位fail-fast、未完了planが後続文を書かないこと。ただしv1で複数親／100件chunkの実行テストは作らない。

## 7. Phase 5 — `VALIDATE ONLY`／`EXPLAIN` と診断出力（M）

### 7.1 着地点と依存

- 依存: Phase 1～4。
- 着地点: CLI core API上で APPLYの `VALIDATE ONLY` と `EXPLAIN` が仕様どおり動き、実mutationと同じplan／validation／guardを使う。
- 対応受入条件: §11.2 のVALIDATE ONLY／EXPLAIN全項目、DmlValidationResultのapply／guards、records/mutation API 0規則。

### 7.2 作業項目

1. `src/execute.ts:348-361`
   - `DmlValidationResult` に optional `apply?: ApplyValidationDetail[]`、`guards?: ApplyGuardDetail` を追加する。
   - `validatedRows=1`、`validRows/invalidRows` は親単位、`errorCount` はセル単位とする。
2. `src/execute.ts:5490-5590`
   - VALIDATE ONLYは実snapshot GET、selector、duplicate、post-image、validation、guard集計まで通常mutationと同じ関数で行い、confirm／PUTを呼ばない。
   - guard超過だけは `wouldExceed=true` で成功診断を返す。selector error、duplicate、unknown rid、type解決、取得上限はthrowのままにする。
3. `src/execute.ts:6977` 以降
   - `UPDATE APPLY` 専用EXPLAIN formatterを追加し、仕様 §6.4 の最低項目を固定順で表示する。
   - `getFields` はtarget型／safe predicate型解決のため許可するが、`getRecords`／`putRecords` は0回。実件数、revision、違反件数は `unknown` とする。
4. `src/mcp/tools.ts:305-318`、`src/output/batchEnvelope.ts:19-33,125-145`、`src/ui/renderResult.ts:39-43`
   - `apply`／`guards` の欠落しない伝播と表示を追加する。APPLYなしの既存VALIDATION payloadは変更しない。
5. `VALIDATE ONLY INTO #err`
   - `src/core/batch.ts` の既存validation error table materializationへ、B44固定列と型metadataを接続する。単文INTO拒否、batch内materialize、後続SELECTの列順をテストする。

### 7.3 テスト

- `src/__tests__/applyPatch.execute.test.ts`: apply／guardsの全count、guard超過診断、mutation 0、error列順、INTO #err。
- `src/__tests__/explain.test.ts`: plan最低項目、metadata call可、records/getCalls=0、putCalls=0、実件数unknown。
- `src/output/__tests__/batchEnvelope.test.ts`（既存ファイルがなければ新規）と `src/mcp/__tests__/tools.test.ts`: optional field伝播。
- `src/ui/__tests__/renderResult.test.ts`: APPLY validation summary／guard警告のHTML escapingと既存validation非回帰。

## 8. Phase 6 — CLI・MCP・プラグイン面（L）

### 8.1 着地点と依存

- 依存: Phase 5の安定した型／出力。
- 着地点: CLIとpluginは確認付きmutation、MCPはEXPLAIN／VALIDATE ONLYだけを提供し、mutationを入力値に関係なくfail-closedにする。
- 対応受入条件: §11.2 のMCP拒否、CLI／plugin確認表示。§8の全surface契約。

### 8.2 CLI

1. `src/cli/index.ts:225-255,290-315,481-486`
   - argsへ `dmlMaxSubtableRows` を追加し、`--dml-max-subtable-rows <n>` を正整数だけ受理する。
   - helpの既存 `--dml-max-rows`（`src/cli/index.ts:128-132`）の隣へ既定100を記載する。
2. `src/cli/index.ts:1735-1747`
   - `args → KSQL_DML_MAX_SUBTABLE_ROWS → profile.dml?.maxSubtableRows → 100` の解決順を採る。profile schemaを広げる場合は `src/node/config.ts` と `src/node/__tests__/config.test.ts` を同期する。
   - 解決値を通常実行、dry-run、batchへ渡す。APPLY以外のDML意味論は変えない。
3. `src/cli/index.ts:2130-2152,2167-2209`
   - `applyDetail` があるconfirmで親件数、table別PATCH、変更子行合計、deleted=0、revision required、非retryを表示する。`--yes`でも二重guardは省略しない。
4. `src/cli/__tests__/help_sync.test.ts`、`src/cli/__tests__/index.test.ts`、新規 `src/cli/__tests__/apply_patch.e2e.test.ts`
   - help、引数境界、env/profile/default、`--yes`、親／子guard、dry-run API 0を固定する。

### 8.3 MCP

1. `src/mcp/schemas.ts:82-103`
   - `dmlMaxSubtableRows` を正整数・既定100の説明付きで schema化する。説明に「APPLY mutationはv1のksql_mutateでは常に拒否され、この値で解禁されない」と明記する。
   - `ksql_query` のVALIDATE ONLYで閾値を指定可能にするかは §13のレビュー判断。指定不可ならdefault 100を返す契約をschema説明に書く。
2. `src/mcp/tools.ts:479-510,615-706,809-873`
   - validate／query／explainはAPPLY ASTを許可する。
   - mutateは `allowDml=true`、`confirmText=yes`、十分な両上限でも、runtime生成／records APIより前に `UnsupportedError: APPLY mutation is disabled in MCP v1` を返す。SQL文字列検索ではなくAST／analysis flagを使う。
   - query VALIDATE ONLYへ `dmlMaxSubtableRows` を渡し、`toDmlValidationPayload`（`src/mcp/tools.ts:305-318`）でapply／guardsを返す。
3. `src/mcp/__tests__/tools.test.ts`、`scripts/mcp-smoke.mjs`
   - validate、explain、query validate-only、mutate拒否、schema keys／describe文字列を追加する。pack smokeのtool schema driftも確認する。

### 8.4 プラグイン

1. `src/ui/desktop.ts:2186-2226`
   - APPLY mutationを検出した実行だけ `allowApplyMutation=true` と既定の両guardを渡す。VALIDATE ONLY／EXPLAINは確認不要。
   - v1は単一親のため設定画面へ新しい永続設定を増やさず、まず既定100を使用する。将来複数親解禁時に設定UIを追加できるようoptions境界は維持する。
2. `src/ui/desktop.ts:1958-1975,2833-2882`
   - `applyDetail` 専用dialogを追加し、親1、変更子行、table別PATCH、deleted 0、revision必須、競合時非retry、不可逆を表示する。IMPORT detail dialogとは分離する。
3. `src/ui/renderResult.ts:39-43`
   - VALIDATE ONLY結果にPATCH件数とguardを表示する。guard超過は成功色だけで埋めず警告として視認可能にする。
4. `build.mjs:33-43,68-90`
   - pluginはcore全体をbrowser IIFEへbundleするため、planner／validatorはNode依存を持ち込まない。
   - `prod/js/desktop.js` のリリース前後byte数／gzip相当を記録し、B44追加分が想定外に膨らむ場合は共有validation helperの重複bundleを調査する。生成物はPhase中に手編集しない。

### 8.5 surfaceテスト

- CLI unit/e2e、MCP tools/schema/smoke、plugin render unitを各面で実施する。
- `src/ui/desktop.ts` は既存の型エラー10件基準がrepo文書に残る（`docs/internal/ksql_batch_temp_table_implementation_plan.md:30`）。`tsc --noEmit` はファイル除外ではなくエラー総数と内容をbaseline比較し、B44由来の増分0件をgateとする。
- pluginは `npm run build:plugin` 成功、生成 `prod/js/desktop.js` にASCII marker（例 `dmlMaxSubtableRows`）が含まれること、Firefox／Chromium双方の確認dialogを実機gateとする。

## 9. Phase 7 — 統合・実機・リリース準備（M）

### 9.1 着地点と依存

- 依存: Phase 1～6すべて。
- 着地点: v1受入条件、APP4221実機12手順、surface smoke、文書／release metadataの準備が完了し、v3.8.0 release作業へ渡せる。Phase 7実装中も版数は上げない。

### 9.2 統合テストと回帰

- 仕様 §11.1／§11.2 のv1項目を acceptance matrix で再実行し、各項目をテスト名／実機evidenceへリンクする。
- APPLYなしUPDATE、UPDATE FROM、CHECK、VALIDATE ONLY、ON ERROR SKIP、仮想テーブルUPDATE／DELETE、B42 VALIDATE、IMPORT subtableの非回帰を重点確認する。
- `npm test`、`npm run build:cli`、`npm run build:mcp`、`npm run build:mcpb`、`npm run build:plugin`、`npm run mcp:smoke`、`npm run mcp:pack-smoke` は実装完了時に実施する。本計画作成時は実行しない。
- `npx tsc --noEmit` は既存 `desktop.ts` 10件との件数・内容差分で判定し、新規error 0を要求する。
- 証跡を `docs/internal/evidence/b44_apply_patch_dev_smoke.md`（新規）へ保存する。

### 9.3 仕様 §11.3 の実機12手順

実機はAPP4221を使い、既存証拠fixture `$id=7` は一切更新しない。専用レコードは新しい一意キーで作成し、作成直後の `$id` を以後のSQLへ埋め込む。

1. APP4221へ「B44-YYYYMMDD-HHMMSS」等の一意な識別値を持つ専用レコードを作成する。GET結果から `$id`、`$revision`、トップレベル全値、`テーブル`の順序・全row id・全child値をJSON evidenceへ保存する。`$id != 7` をassertする。
2. 復元用にフォーム設定／制約の変更前値を保存する。専用レコードだけに、トップレベル `文字列MIN` と `テーブル.文字列T2` の既存違反が同居する状態を作る。既存fixtureへ波及する制約変更の場合は、変更対象と復元手順を先に記録する。
3. `UPDATE APP4221 SET 文字列MIN='ddd' WHERE $id=<専用ID>` を実行し、HTTP 400 `CB_VA01`、put成功0、親値不変を記録する。
4. `UPDATE APP4221$テーブル SET 文字列T2='NNN' WHERE _pid=<専用ID> AND _rid='<対象rid>'` を実行し、残る親違反により `CB_VA01`、子値不変を記録する。
5. B42 `VALIDATE APP4221 ... WHERE $id=<専用ID>` を実行し、親／子双方のerrorと、`$err_subrow_id` が手順1の対象row idに一致することを記録する。
6. B44文へ `VALIDATE ONLY` を付け、`validatedRows=1`、`validRows=1`、`invalidRows=0`、PATCH matched/changed件数、parentRows=1、両guard、`wouldExceed=false`、putCalls相当0をCLI JSONで保存する。
7. 同じB44 mutationをCLIの `--allow-dml --dml-max-rows 1 --dml-max-subtable-rows <安全値>` と確認付きで実行し、親と対象子cellが同じ操作で更新されたこと、updated parent count=1を確認する。
8. 手順1 snapshotと再GETを比較し、対象外row、対象rowの未指定 `数値T1`、全row id、row順が完全一致することを機械比較／表で記録する。
9. B42 VALIDATEを再実行し、対象の親／子違反が0になったことを確認する。
10. revision conflict専用に同等の専用レコードをもう1件作るか手順7前の状態を再現し、B44がGETしたrevisionの後に別clientで更新してから旧revision PUTを送る test hook／debug手順を使う。競合error、retry GET 0、成功報告なし、別client更新保持を記録する。
11. 同じSQLについて、CLIの件数表示、Firefox plugin dialog、Chromium plugin dialogを照合する。MCPではEXPLAINとquery VALIDATE ONLYが成功し、mutateは全approval入力を付けてもrecords/mutation API前にfail-closedとなることを記録する。
12. 変更したフォーム制約を保存済み値へ戻し、専用レコードだけを削除または元状態へ復元する。最後に `$id=7` をGETし、試験前証拠fixtureの値／revisionに意図しない変更がないことを記録する。

### 9.4 リリース準備

- 公開版は **v3.8.0**、SemVer **minor**。新しいsoft-keyword構文の加法追加であり、APPLYなしの既存SQL意味論を変えない。
- Phase中は `package.json`、`package-lock.json`、`prod/manifest.json`、`CHANGELOG.md`、`release/`、dist／zipを更新しない。
- release時の順序は、version bump（`package.json`／lock／`prod/manifest.json`）→ CHANGELOG／README／言語リファレンス／CLI tutorial／MCP説明／issue tracker B44同期 → 全成果物再ビルド → test/smoke/実機evidence確認 → version整合確認 → release artifact差替え、とする。
- 現行版は `package.json:3` と `prod/manifest.json:3` が3.7.0で一致している。v3.8.0 release gateでも、CLI `--version`、MCP bundle/package、plugin zip内manifest、releaseファイル名まで一致を確認する。

## 10. テスト責務と受入条件割付

| 受入領域 | unit | integration / surface | Phase |
|---|---|---|---:|
| grammar、soft keyword、句順、semicolon、将来構文識別 | parser AST／scope validator | batch parse、MCP static validate | 1 |
| selector、snapshot、重複、保持、1record合成 | pure planner／converter | mock GET field-set／PUT draft | 2 |
| post-image全体、normalization、locator | postImageValidation／B42 shared helper | APPLY VALIDATE error rows、B42非回帰 | 3 |
| revision、0行、二重guard、API順、conflict | planner guard | execute mock、batch fail-fast | 4 |
| VALIDATE ONLY counts／guards、EXPLAIN API 0 | result formatter | INTO #err、MCP payload、plugin render | 5 |
| CLI flag、MCP fail-closed、plugin confirm | 各surface unit | CLI e2e、MCP smoke、browser smoke | 6 |
| §11.1／§11.2全体、APP4221 12手順 | regression suite | 実kintone、release artifacts | 7 |

仕様 §11.2 にある次の項目はv1実行対象外なので、割付を明確に分ける。

- PATCH/REMOVE重複とAPPEND行の不可視性: Phase 1でREMOVE／APPEND ASTを保持し、v1 scopeの明示拒否をテストする。runtime semanticsの実装テストはv1.1／v1.2へ繰り越す。
- 将来の複数親100件chunkと後続chunk失敗: v1では親 `$id` 単一条件のため実装・実行テストをしない。converter／plannerの単一親境界と「将来adapterがchunk化する」設計メモだけを残す。
- 未知・別親 `_rid`: v1単一親snapshot内の未知ridは実行テストする。「別親」はそのridが対象親snapshotに存在しないため同じunknownとして拒否されることをテストし、複数親固有の分類はv2へ繰り越す。

## 11. リスクと対策

| リスク | 具体的な失敗 | 対策／gate |
|---|---|---|
| 既存DML経路との混線 | 親UPDATE後に子UPDATEして部分成功、revisionが片方だけ、既存UPDATEの意味変更 | `executeApplyPatchUpdate` を通常／FROM／仮想table経路より先に分岐し、専用planner＋1record converterだけを使う。APPLYなし回帰をPhase 7で固定 |
| snapshot意味論の破壊 | 先行PATCH結果を後続selector/RHSが読む、row順／idが変わる | operation解決用snapshotとpost-imageを別objectにし、全selector解決後にcopy-on-writeで合成。planner unitで順序と参照同一性を検査 |
| post-image検証漏れ | 変更列だけ検証してB43と同じfalse passを再現 | `validateDmlCandidates`をB44から呼ばず、全form metadata×全post-image走査を独立module化。対象外table／未変更row fixtureを必須にする |
| GET field-set過不足 | 親SET RHS、revision、対象外table既存違反を取得できない | field collectorをpure testし、mock getCallsのfieldsをexactにassert。完全post-imageを作れないfield typeは最初のrecords API前に明示拒否 |
| guardがsurface依存 | direct core/pluginで`dmlMaxSubtableRows`が抜ける、`--yes`で迂回 | APPLY guardをExecuteOptions＋core executorで強制し、surfaceは値解決と表示だけを担う。default 100もcoreに持つ |
| MCPの誤開通 | allowDml等を付けるとAPPLY mutationが通る | AST analysis flagでruntime生成前に拒否。文字列検索禁止、mutate拒否時API 0をspy test |
| plugin bundle肥大 | B42/B44 validator重複、Node module混入 | core leaf moduleを共有しbrowser-safeに保つ。build前後bytesを記録し、ASCII markerとbrowser buildをgateにする |
| `desktop.ts`既存tsc errorとの干渉 | 既存10件を理由に新規errorを見落とす | 除外filterでなくbaselineの件数・error code・行内容を保存し、増分0で判定。esbuild成功だけを型安全の代替にしない |
| revision欠落／0 fallback | `getRevision`の0補完でguardを形骸化 | B44専用`requireRevision`で存在・正整数を要求し、converterのrevisionをrequiredにする |
| 将来複数親への過剰設計 | v1なのにchunk／rollback分岐を作り複雑化 | v1は単数plan・1 PUTに固定。API-independent planとconverter境界だけを保ち、array/chunk adapterはv2で追加 |
| spec受入条件の将来項目混在 | v1でAPPEND/REMOVE/chunkまで実装してscope逸脱 | §10の割付どおり、v1は構文認識＋UnsupportedErrorまで。runtime semanticsは後続版へ明示繰越 |

## 12. Phase規模・依存関係・完了gate

| Phase | 内容 | 規模 | 依存 | 独立完了gate |
|---:|---|:---:|---|---|
| 1 | lexer/parser/AST＋v1 scope | M | なし | parser/scope/batch tests green、APPLY execution閉 |
| 2 | snapshot契約＋合成planner | L | 1 | pure planner/converter＋GET contract green、PUT 0 |
| 3 | post-image全体検証 | L | 2 | validator＋B42非回帰 green、PUT 0 |
| 4 | revision＋二重guard＋core mutation | M | 2,3 | guard/conflict/API順 integration green |
| 5 | VALIDATE ONLY／EXPLAIN／診断 | M | 4 | result/INTO/EXPLAIN API 0 tests green |
| 6 | CLI／MCP／plugin | L | 5 | surface tests、MCP smoke、plugin build／browser smoke準備 |
| 7 | 統合・実機・release準備 | M | 1～6 | 全回帰、APP4221 12手順、evidence、release checklist |

実装順は `1 → 2 → 3 → 4 → 5 → 6 → 7` とする。Phase 2のconverter単体とPhase 3のvalidator骨格は作業上並行可能だが、post-image shapeをPhase 2 reviewで確定してからPhase 3を完了させる。Phase 6のCLI/MCP/pluginは同じ公開型を消費するため分割releaseせず、一つのPhase gateで揃える。

## 13. 裏取りで判明した齟齬・レビュー判断事項

### 13.1 仕様内／現行実装との齟齬

1. 正本仕様の冒頭 `docs/internal/ksql_apply_block_spec.md:3` は「実装着手はユーザー承認待ち」のままだが、本依頼ではR2を「実装着手可」と明示している。本計画は依頼を正として進める。実装開始前にspec statusだけを「実装着手可」へ同期するかClaude判断が必要である。
2. 仕様 §11.2（`docs/internal/ksql_apply_block_spec.md:698-705`）には、v1対象外のREMOVE／APPEND／複数親chunkのruntime受入条件が含まれる。§9.1／§12を優先し、v1では構文認識・明示拒否または将来設計境界までとした。
3. 仕様 §4.3は最大100親chunkを一般契約として書く一方、v1 §9.1は単一親に固定する。v1にchunk codeは不要であり、実装すると未テストの複数親能力を暗黙に作るため採らない。
4. 現行 `getRevision`（`src/execute.ts:6033-6036`）は欠落／不正を0へ落とす。B44の「revision必須」には弱いため、そのまま再利用せずstrict helperが必要である。
5. 現行 `DmlConfirmContext`（`src/execute.ts:411-422`）と`DmlValidationResult`（`:348-361`）はIMPORT detailしか持たない。B44件数表示をsurfaceごとに再計算せず、共有detail型を加法追加する必要がある。
6. 現行CLIの`dmlMaxRows`はconfirm callback内で強制される（`src/cli/index.ts:2130-2133`）一方、pluginには同等の上限設定がない。B44の必須二重guardはcoreへ置かなければ全surfaceで保証できない。

### 13.2 Claude／実装レビューで判断してほしい点

1. **scope errorの層**: 本計画は将来構文をAST化し、`assertApplyV1Scope`を`analyzeBatch`／executorで呼んで`UnsupportedError`にする。parser自体でthrowする案より「構文として識別」の証明が強いが、公開`parseSqlStatement`単体がv1外ASTを返す点を許容するか。
2. **MCP query schema**: `VALIDATE ONLY`の`guards.wouldExceed`を利用者指定値で評価できるよう、`dmlMaxSubtableRows`をquery schemaにも出すか。出さない場合はdefault 100固定、mutate schemaには「解禁しない」説明だけを置く。
3. **plugin guard設定**: v1単一親では親guardは常に1、子guard default100で十分として設定UIを増やさない案でよいか。CLIだけ明示flag、pluginはcore default＋確認dialogとなる。
4. **GET fieldsとFILE**: post-image全体を検証するため全form field/tableを取得するが、FILEは仕様対象外である。APPLY対象レコードにFILEが存在するだけで拒否するのか、FILEを保存済みopaque値として未検証・payload非送信で許容するのかを確定する必要がある。後者が実用的だが「post-image全体検証」の例外をspecへ明記すべきである。
5. **親0件**: §5.3は子selectorの0件規則だけを明記する。v1の`$id=<n>`単一親が存在しない場合、本計画はfail-closed `ArgumentError` とした。通常UPDATEの0件successに合わせるか、revision修復操作の安全性を優先してerrorにするかを確定したい。

## 14. Claude レビュー（R1 承認・2026-07-20）

**裏取り**: 引用をサンプリング検証し全一致（`isSoftKeyword` parser.ts:2751・`getRevision` の 0 フォールバック execute.ts:6033＝齟齬13.1-4 は事実・CLI `dmlMaxRows` の confirm callback 依存 cli/index.ts:2130＝齟齬13.1-6 は事実・通常 UPDATE の `$id` のみ取得 execute.ts:5564・`desktop.ts` 既存 tsc 10件の件数比較運用は [batch_temp_table_implementation_plan.md:30](ksql_batch_temp_table_implementation_plan.md) に前例記録あり・spec §11.2 の v1 外項目混在も事実）。フェーズ分割・モジュール分離（planner/postImageValidation を execute.ts へ埋め込まない）・§10 の受入条件割付・§11 リスク表は妥当。**指摘なしで承認**。

**§13.2 判断事項の裁定**:

1. **scope error の層 = 計画案を承認**（AST 保持＋`assertApplyV1Scope` を analyzeBatch/executor で共有）。パーサのメタデータ非依存原則と「構文として識別した上で拒否」（spec §2.1）の証明が最も強い。公開 parse が v1 外 AST を返すことは内部 API のため許容。
2. **MCP query schema = v1 では `dmlMaxSubtableRows` を出さない**。`ksql_query` に DML 上限系パラメータを置かない現行契約（`dmlMaxRows` も mutate 側のみ）と一貫させる。VALIDATE ONLY の `guards` は既定100で評価し、schema 説明へ「既定100固定」を明記。利用実態を見て v1.1 で再考。
3. **plugin 設定 UI = 増やさない（既定100）を承認**。options 境界の維持のみ。
4. **FILE = 拒否せず「保存済み opaque 値として未検証・payload 非送信で保持」を採用**。根拠=①FILE は監査可能制約を持たず B42 監査も対象外（既定対象から自然に外れる）②サブテーブルの patch 形 payload（行 id＋変更セルのみ）は未送信セルを kintone が保持する＝既存 `buildSubtablePatchPutParams` と同じ保証で、FILE 行があっても post-image の完全性を損なわない。**実装時に spec §6.1 へ例外1行を追記すること**（Phase 3 の作業項目に含める）。
5. **親 `$id` 0件 = fail-closed `ArgumentError` を承認**。修復オペで明示した単一 `$id` の消失を沈黙させないのは §5.3 の `_rid` 0件規則と同型。APPLY 専用経路なので通常 UPDATE の 0件 success 契約とは独立で、混同は生じない。

**齟齬13.1 の処理**: ①spec ステータス行は本コミットで「実装着手中」へ同期（済）②③v1 スコープ（spec §9.1）優先の整理を承認＝§11.2/§4.3 の一般契約項目は §10 の割付どおり将来版へ明示繰越④⑤⑥は計画の新設方針（`requireRevision`・共有 detail 型・core 強制ガード）で解消される。

