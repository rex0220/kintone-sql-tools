# B44 `APPLY` v1／v1.1／v1.2 実装計画 R2

- ステータス: 実装計画 **R2・レビュー待ち**（2026-07-20 ユーザー決定: v1 `PATCH`、v1.1 複数 `APPLY`／複数テーブル／`APPEND`、v1.2 `REMOVE` を **v3.8.0 に一括同梱**。R1 の Phase 1～6 と Claude 裁定5件は維持）
- 対象ブランチ: `feat/b44-apply-patch`
- 正本仕様: [B44 APPLY ブロック仕様 R2](ksql_apply_block_spec.md)
- 対象版: **v3.8.0**（SemVer minor）
- 制約: 本計画では実装・版数更新・ビルド・リリース成果物更新を行わない。各 Phase は `実装 → 対象テスト → Claude review → 必要な修正` を完了条件とし、最終 Phase 9 だけ実機 gate を追加する。実装フェーズは分けるがリリースは v3.8.0 の1回だけである。

## 1. 結論と実装方針

B44 v1～v1.2 は、既存のトップレベル UPDATE とサブテーブル仮想テーブル DML を順番に呼ぶ機能にはしない。`UPDATE ... APPLY` 専用経路で、単一親の取得スナップショットから親 SET と全 `PATCH`／`APPEND`／`REMOVE` を一つの post-image／PUT record へ合成する。Phase 1～6 で v1、Phase 7 で v1.1、Phase 8 で v1.2、Phase 9 で全体を統合し、途中版は公開しない。

R1のPhase 1～6の順序・完了gate・Claude裁定5件は変更しない。R2でPhase 2のplanner/converterへtable単位payload形を追記したのは、Phase 8のREMOVEを安全に接続する境界を先に型で固定し、全列挙形の列挙漏れをconverter単体で拒否するためである。Phase 1～6のv1許可集合やmutation開通時期は広げない。

```text
parser/AST
  → phase-aware scope validator（単一親固定、許可操作を Phase ごとに拡張）
  → form metadata と GET field-set の解決
  → 単一親 snapshot GET（$id・$revision・親参照列・全 post-image 検証対象）
  → 子 selector を snapshot 上で解決
  → 重複検出・親 SET／子 PATCH／APPEND／REMOVE の post-image 合成
  → テーブル単位の payload 形選択
  → post-image 全体検証
  → dmlMaxRows／dmlMaxSubtableRows 判定
  → VALIDATE ONLY 結果、または確認後に revision 付き 1-record PUT
```

安全上の不変条件は次のとおりとする。

- Phase 1～6（v1）は親 `UPDATE`、`$id = <正の安全な整数>` の単一親、1文1サブテーブル、1 `APPLY`、`PATCH` のみを実行可能にする。
- Phase 7（v1.1）は単一親を維持したまま、複数 `APPLY`、**異なる**複数テーブル、`APPEND` を許可する。同一テーブルの複数ブロックは仕様 §4.2 どおり `ArgumentError` で拒否する（1テーブル1ブロック。複数操作は `;` で同一ブロック内に並べられるため表現力は失わない。§15 裁定3）。
- Phase 8（v1.2）は上記に `REMOVE WHERE ...`／`REMOVE ALL ROWS` を加える。
- `EXPECT ROWS` 実行、`_idx` selector、INSERT／UPSERT、複数親、複数値 field の `ADD`／`REMOVE` は Phase 8 後も v2 対象外である。AST まで識別し、phase-aware scope validator が対象フェーズ名付き `UnsupportedError` で拒否する。
- malformed な句順、空ブロック、空操作、`APPLY SUBTABLE ...` は構文エラーであるため `ParseError` とする。
- planner、post-image validator、guard は `src/execute.ts` の巨大関数へ埋め込まず、純粋関数中心の新規モジュールへ分離する。`execute.ts` は metadata／records API と mutation の orchestration に限定する。
- Phase 1～3 では `UPDATE ... APPLY` の実 mutation dispatch を閉じる。Phase 4 で revision、全件先行検証、二重ガードが揃ってから CLI／plugin 用 core mutation を開通する。MCP mutation は Phase 6 後も閉じたままにする。
- v1.2 まで単一親なので PUT の100親チャンク処理を実装しない。planner の結果型を `ApplyParentPlan[]` とせず、まず単数 `ApplyPatchPlan` として固定し、将来の複数親 adapter が `readonly ApplyPatchPlan[]` をチャンク化できる境界を残す。

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
| revision 付きサブテーブル PUT | 現行 UPDATE は全既存行を `id`、変更行だけ `value` 付きで送る（`src/execute.ts:5920-5930`、builder は `:6061-6081`）。現行 DELETE は削除対象を除外した `nextRows` 全体を `buildSubtablePutParams` へ渡す（`:5978-5985`、builder は `:6038-6058`）。`getRevision` は `:6033-6036` | revision の取得・REST shapeを参照する。B44 は親 SET と各tableを同一 `record` に入れ、REMOVE有無でtable payload形を選ぶ専用builderを新設し、revision省略を型上許さない |
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
- `src/converter/applyPatchToKintone.ts`（新規）: revision を必須引数とし、親 assignment と複数サブテーブル payload を1個の `records[]` 要素へ合成する。planner がtableごとに決めた `PATCH_ONLY`／`FULL_SURVIVORS` shapeを型付き union で受け、converter側で暗黙に推測しない。既存 `updateToPutBatches`（`src/converter/dmlToKintone.ts:164-173`）は revision とテーブルを扱わないため変更しない。

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
   - table plan に `payloadShape: "PATCH_ONLY" | "FULL_SURVIVORS"` を必須化する。`PATCH`／`APPEND` だけのtableは、既存行を `id`、変更行だけ `value`、追加行を `value` で送るパッチ形を維持し、取得済み行IDが構造的に欠落しないことをassertする。
   - `REMOVE` を1操作でも含むtableだけ `FULL_SURVIVORS` とし、削除後post-imageの存続行を元順序どおり全列挙する。REMOVEのない別tableまで全列挙形へ波及させない。
   - `FULL_SURVIVORS` は列挙漏れ自体がkintone上の意図しない行削除になる高リスクshapeである。plannerは `snapshot row IDs = survivor IDs ∪ removed IDs`、各集合の重複なし・交差なしを証明し、converterはplan外でfilterしない。現行サブテーブルDELETEも `nextRows = rows.filter(...)` を全列挙builderへ渡す（`src/execute.ts:5978-5985`、`:6038-6058`）。
5. `src/execute.ts:6110-6120`
   - 子 assignment evaluator を planner から使える leaf module へ抽出するか、同等の pure helper を共通化する。親 SET は既存 `updateToPutBatchesArith` の行評価ロジック（`src/converter/dmlToKintone.ts:214-230`、`:323` 以降）を1親用に抽出し、親／子とも同じ snapshot から評価する。

### 4.3 テスト

- 新規 `src/core/__tests__/applyPatchPlanner.test.ts`: `_rid`／safe predicate／ALL ROWS、0件規則、snapshot評価、同一セル重複、同一行別セル、未知／重複rid、行順・id・未指定値保持、親SET合成。
- 新規 `src/converter/__tests__/applyPatchToKintone.test.ts`: 1 parent＝1 `records[]` element、revision必須、親とtableが同じrecord、row payload保持。
- converterテストにはtable単位shape混在（PATCH_ONLY table＋FULL_SURVIVORS table）を追加し、PATCH_ONLYの全snapshot id保持、FULL_SURVIVORSの全存続id・値・順序保持、1件でも存続行を落とした不正planの拒否を固定する。これは意図しない削除を防ぐ必須gateとする。
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

## 9. Phase 7～9 — v1.1、v1.2、統合・実機・リリース準備

### 9.1 Phase 7 — v1.1 複数合成＋`APPEND`（L）

- 依存: Phase 1～6。着地点は、単一親のまま複数 `APPLY`／複数tableと `APPEND` を同一snapshot・同一PUT recordへ合成できること。v1のPATCH経路とMCP fail-closedは維持する。
- scope validatorを `assertApplyScope("v1.1")` 相当へ拡張し、許可集合を `{親UPDATE, 単一$id親, PATCH, APPEND, 複数APPLY, 複数table}` とする。`REMOVE`、`EXPECT ROWS`、`_idx`、INSERT／UPSERT、複数親、複数値ADD/REMOVEはこのPhaseでも拒否する。Phase 1で確立したAST保持＋analyzeBatch/executor共有というClaude裁定は変えない。
- plannerは全blockのselector／RHSを更新前snapshotへ解決してからtable単位に合成する。同一tableの複数blockは §15 裁定3 により合成せず `ArgumentError`。同一cell多重PATCH、APPEND指定field重複をPUT前に拒否し、APPEND行は同文PATCHから不可視、追加順はSQL記述順で既存行末尾とする。
- APPEND rowは未採番なので `value` のみを持つ。指定値の型・選択肢・長さ・required・B29整数部桁数／number precisionを検証・normalizeし、未指定childはフォーム既定値をmetadataから補う方針を実装候補とする。ただしkintoneが「PUTによる追加行の未指定childへフォーム既定値を自動投入するか」は推測せず、Phase 9実機結果でpayload補完責務を確定する。自動投入されない、または環境差がある場合はplannerが既定値を明示payload化する。
- 既定値がなくrequiredな未指定childはPUT前error。既定値自体も通常値と同じprimitiveで検証し、NUMBERはappのprecision設定でnormalizeする。FILEは§14裁定どおり保存済みopaque値を未検証・payload非送信とし、APPENDでFILEを指定する機能は対象外とする。
- `dmlMaxSubtableRows` はtable横断で `distinct PATCH既存行 ∪ APPEND新規行` を数える。同一既存行を複数blockでPATCHしても1、APPENDは1行ずつ1とする。
- converterはPATCH／APPENDだけのtableを `PATCH_ONLY` に保ち、全snapshot row id＋変更cell＋新規rowだけを送る。APPEND追加のために既存rowの全childを列挙しない。
- CLI／pluginの共有detailと確認UIをtable別 `PATCH`／`APPEND`、追加合計へ拡張する。MCPは§9.2の別capability検討を設計・テストに留め、v3.8.0で実mutationを開けるかはレビュー裁定がない限りfail-closedを維持する。
- unit/integration gate: 複数block／table、snapshot不可視性、APPEND順序、required／default／precision、guard重複排除、PATCH_ONLY shapeの全既存id保持、1 parent＝1 record、PUT前全検証。

### 9.2 Phase 8 — v1.2 `REMOVE` と削除表示（L）

- 依存: Phase 7。着地点は、`REMOVE WHERE ...`／`REMOVE ALL ROWS` を同一snapshotへ解決し、削除tableだけ安全な全存続行payloadへ切り替え、CLI／確認UI付きpluginから削除内訳を確認して実行できること。MCP mutationは仕様 §9.3の安全条項どおりfail-closedを維持する。
- scope validatorの許可集合を `{v1.1集合 + REMOVE WHERE/ALL ROWS}` へ拡張する。`EXPECT ROWS`、`_idx`、INSERT／UPSERT、複数親、複数値fieldのADD/REMOVEは引き続きv2として拒否する。
- plannerは全PATCH／REMOVE selectorを更新前snapshotへ解決する。同一cell多重PATCH、PATCH対象行とREMOVE対象行の重複、同一行の複数REMOVEをPUT前に拒否し、APPEND行はREMOVEから不可視とする。削除後の存続行順とAPPEND順を確定したpost-imageを検証する。
- tableごとにpayload形を選ぶ。REMOVEなしtableは `PATCH_ONLY` のまま、REMOVEを1件でも含むtableだけ `FULL_SURVIVORS` とする。後者は全snapshot rowを `survivor ∪ removed` に過不足なく分割し、存続行のid・全child値・順序とAPPEND行を列挙する。現行DELETEの全列挙経路（`src/execute.ts:5978-5985`、`:6038-6058`）を参照するが、B44は親SET・他tableと同一recordへ合成する専用converterを使う。
- 必須テストとして、REMOVE tableの先頭／中間／末尾／複数削除、0件一般述語、空table ALL ROWS、PATCH_ONLYとのshape混在、全削除、削除＋APPEND、存続行順・全値保持、revision conflict非retryを固定する。snapshotの存続rowを1件でもplan/payloadから落とすfixtureはconverterが拒否し、putCalls=0となることを確認する。
- `ApplyConfirmDetail`／VALIDATE ONLY／CLI／pluginへtable別REMOVE件数、総削除行数、削除対象親数（単一親なので0/1）、revision必須、不可逆、非retryを追加する。確認UIの既存IMPORT内訳実装は `src/ui/desktop.ts:2841-2873` を表示設計の参照とし、IMPORT detailとは型を分離する。
- 削除ガードは新設せず、まず既存計画どおり `dmlMaxSubtableRows = distinct PATCH既存行 ∪ REMOVE既存行 ∪ APPEND新規行` の合計をcoreで強制する案を推奨する。同一文の子行mutation総量を一つの上限で制限でき、Phase 4のcore強制・CLI flag・default 100を再利用でき、別上限同士の組合せで「総変更量は巨大だが削除だけ閾値内」という穴を作らないためである。
- ただし削除は非可逆性が高いので、確認UIの削除内訳だけでは不足し「追加・変更とは独立したhard cap」が必要とレビュー判断された場合に限り `dmlMaxDeletedSubtableRows`（正整数、core必須、CLI/env/profile/schema/smoke同期）を追加する。その場合も `dmlMaxSubtableRows` を置換せず両方を満たすAND条件とする。

### 9.3 Phase 9 — 統合・実機・回帰（M）

- 依存: Phase 1～8すべて。着地点はv1／v1.1／v1.2受入条件、APP4221実機、surface smoke、文書／release metadata準備が完了し、v3.8.0 release作業へ渡せること。Phase 9中も版数は上げない。
- 仕様 §11.1／§11.2 の全対象項目をacceptance matrixで再実行する。APPLYなしUPDATE、UPDATE FROM、CHECK、VALIDATE ONLY、ON ERROR SKIP、仮想table UPDATE／DELETE、B42 VALIDATE、IMPORT subtableの非回帰を重点確認する。
- `npm test`、`npm run build:cli`、`npm run build:mcp`、`npm run build:mcpb`、`npm run build:plugin`、`npm run mcp:smoke`、`npm run mcp:pack-smoke` は実装完了時に実施する。本計画作成時は実行しない。`npx tsc --noEmit` は既存 `desktop.ts` 10件との件数・内容差分で判定し、新規error 0を要求する。
- 証跡を `docs/internal/evidence/b44_apply_patch_dev_smoke.md`（新規）へ保存する。実機はAPP4221を使い、既存証拠fixture `$id=7` は更新しない。
- v1基礎12手順は仕様 §11.3を維持し、専用レコードのsnapshot保存、既存親子違反、従来UPDATEの`CB_VA01`、B42照合、B44 VALIDATE ONLY／mutation、未指定cell・id・行順保持、revision conflict、CLI／Firefox／Chromium／MCP、復元を行う。
- APPEND実機: 既定値付き・required既定値なし・NUMBER精度対象childを持つ専用table/recordで、未指定childを省いた追加payloadを送る対照試験を行い、kintoneがフォーム既定値を投入するか、空値にするか、拒否するかをGET結果とraw request/responseで記録する。結果に基づきplanner明示補完の要否を確定し、VALIDATE ONLYのpost-imageと実PUT後imageが一致することを再確認する。
- 複数合成実機: 2つ以上のAPPLY/tableでPATCH＋APPENDを同時実行し、1 record payload、各tableの既存id・順序保持、APPEND末尾順、table別件数を確認する。
- REMOVE実機: 先頭／中間行を削除し、REMOVE tableだけが全存続行形、非REMOVE tableはパッチ形であるraw payloadを保存する。PUT後に削除対象だけが消え、存続行の全値・row id・相対順とAPPEND末尾順が一致することを確認する。GET後PUT前の別更新でrevision conflictを起こし、削除0、retry GET 0、別client更新保持を記録する。
- CLI／Firefox／Chromiumの確認表示でPATCH／APPEND／REMOVE、総子行数、削除行数、削除対象親数が一致し、キャンセル時putCalls=0、MCP mutation fail-closedを確認する。最後に制約と専用recordを復元／削除し、`$id=7`非変更を記録する。

### 9.4 最終リリース準備

- 公開版は **v3.8.0**、SemVer **minor**。新しいsoft-keyword構文の加法追加であり、APPLYなしの既存SQL意味論を変えない。
- Phase中は `package.json`、`package-lock.json`、`prod/manifest.json`、`CHANGELOG.md`、`release/`、dist／zipを更新しない。
- release時の順序は、Phase 1～9全gate完了 → version bump（`package.json`／lock／`prod/manifest.json`）→ CHANGELOG／README／言語リファレンス／CLI tutorial／MCP説明／issue tracker B44同期 → 全成果物再ビルド → test/smoke/実機evidence確認 → version整合確認 → release artifact差替え、とする。v1／v1.1／v1.2の途中release／途中version bumpは行わない。
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
| 複数APPLY／table、APPEND、追加行post-image | planner／validator／converter | core mutation、CLI/plugin内訳 | 7 |
| REMOVE、table単位payload shape、削除内訳 | planner集合証明／converter拒否 | core mutation、CLI/plugin削除確認 | 8 |
| §11.1／§11.2全体、APPEND既定値、REMOVE実機 | regression suite | 実kintone、browser smoke、release artifacts | 9 |

仕様 §11.2 にある項目はv3.8.0内の実装フェーズへ次のように割り付ける。

- PATCH/REMOVE重複とAPPEND行の不可視性: Phase 1でAST保持とv1拒否、Phase 7でAPPEND不可視性、Phase 8でPATCH/REMOVE重複のruntime semanticsを実装・テストする。
- 複数親100件chunkと後続chunk失敗: v1.2まで親 `$id` 単一条件のため実装・実行テストをしない。converter／plannerの単一親境界と「将来adapterがchunk化する」設計メモだけを残し、v2へ繰り越す。
- 未知・別親 `_rid`: v1単一親snapshot内の未知ridは実行テストする。「別親」はそのridが対象親snapshotに存在しないため同じunknownとして拒否されることをテストし、複数親固有の分類はv2へ繰り越す。
- `EXPECT ROWS`、`_idx`、INSERT／UPSERT、複数親、複数値ADD/REMOVEはPhase 1でAST認識後に拒否し、Phase 7／8でも許可集合へ加えない。対象外回帰テストを各scope拡張時に再実行する。

## 11. リスクと対策

| リスク | 具体的な失敗 | 対策／gate |
|---|---|---|
| 既存DML経路との混線 | 親UPDATE後に子UPDATEして部分成功、revisionが片方だけ、既存UPDATEの意味変更 | `executeApplyPatchUpdate` を通常／FROM／仮想table経路より先に分岐し、専用planner＋1record converterだけを使う。APPLYなし回帰をPhase 9で固定 |
| snapshot意味論の破壊 | 先行PATCH結果を後続selector/RHSが読む、row順／idが変わる | operation解決用snapshotとpost-imageを別objectにし、全selector解決後にcopy-on-writeで合成。planner unitで順序と参照同一性を検査 |
| post-image検証漏れ | 変更列だけ検証してB43と同じfalse passを再現 | `validateDmlCandidates`をB44から呼ばず、全form metadata×全post-image走査を独立module化。対象外table／未変更row fixtureを必須にする |
| GET field-set過不足 | 親SET RHS、revision、対象外table既存違反を取得できない | field collectorをpure testし、mock getCallsのfieldsをexactにassert。完全post-imageを作れないfield typeは最初のrecords API前に明示拒否 |
| guardがsurface依存 | direct core/pluginで`dmlMaxSubtableRows`が抜ける、`--yes`で迂回 | APPLY guardをExecuteOptions＋core executorで強制し、surfaceは値解決と表示だけを担う。default 100もcoreに持つ |
| MCPの誤開通 | allowDml等を付けるとAPPLY mutationが通る | AST analysis flagでruntime生成前に拒否。文字列検索禁止、mutate拒否時API 0をspy test |
| plugin bundle肥大 | B42/B44 validator重複、Node module混入 | core leaf moduleを共有しbrowser-safeに保つ。build前後bytesを記録し、ASCII markerとbrowser buildをgateにする |
| `desktop.ts`既存tsc errorとの干渉 | 既存10件を理由に新規errorを見落とす | 除外filterでなくbaselineの件数・error code・行内容を保存し、増分0で判定。esbuild成功だけを型安全の代替にしない |
| revision欠落／0 fallback | `getRevision`の0補完でguardを形骸化 | B44専用`requireRevision`で存在・正整数を要求し、converterのrevisionをrequiredにする |
| payload形の誤選択 | REMOVEなしtableを全列挙して意図せず削除、REMOVE tableの存続行列挙漏れ | plannerがtable単位でPATCH_ONLY/FULL_SURVIVORSを明示し、snapshot＝survivor∪removedをassert。shape混在・列挙漏れ拒否・putCalls=0をPhase 2/8の必須テストにする |
| APPEND既定値の推測違い | VALIDATE ONLY post-imageとkintone保存値がずれる | Phase 9で未指定childの実機対照試験を行い、結果が出るまでplanner明示補完の要否を確定扱いしない。required/default/precisionは追加行全体をPUT前検証 |
| 削除guardの穴／過剰設定 | 削除だけ別capで総mutation量を迂回、または設定増でsurface drift | まず総和`dmlMaxSubtableRows`を推奨。独立hard capが必要との裁定時だけ`dmlMaxDeletedSubtableRows`をAND追加し、CLI/env/profile/MCP説明/smokeを同時同期 |
| 将来複数親への過剰設計 | v1.2なのにchunk／rollback分岐を作り複雑化 | v1.2までは単数plan・1 PUTに固定。API-independent planとconverter境界だけを保ち、array/chunk adapterはv2で追加 |
| phase scopeの誤開放 | v1.1でREMOVE、v1.2でEXPECT/_idx/複数親まで通る | version文字列比較でなく明示的capability集合をscope validatorへ渡し、各Phaseで許可・拒否matrixを全再実行する |

## 12. Phase規模・依存関係・完了gate

| Phase | 内容 | 規模 | 依存 | 独立完了gate |
|---:|---|:---:|---|---|
| 1 | lexer/parser/AST＋v1 scope | M | なし | parser/scope/batch tests green、APPLY execution閉 |
| 2 | snapshot契約＋合成planner | L | 1 | pure planner/converter＋GET contract green、PUT 0 |
| 3 | post-image全体検証 | L | 2 | validator＋B42非回帰 green、PUT 0 |
| 4 | revision＋二重guard＋core mutation | M | 2,3 | guard/conflict/API順 integration green |
| 5 | VALIDATE ONLY／EXPLAIN／診断 | M | 4 | result/INTO/EXPLAIN API 0 tests green |
| 6 | CLI／MCP／plugin | L | 5 | surface tests、MCP smoke、plugin build／browser smoke準備 |
| 7 | v1.1: 複数APPLY／複数table＋APPEND | L | 1～6 | 合成／追加行検証／PATCH_ONLY shape／surface内訳 green |
| 8 | v1.2: REMOVE＋payload形切替＋削除表示 | L | 7 | survivor完全性、shape混在、削除guard／UI green |
| 9 | 統合・実機・release準備 | M | 1～8 | 全回帰、APPEND既定値／REMOVE実機、evidence、release checklist |

実装順は `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9` とする。Phase 2のconverter単体とPhase 3のvalidator骨格は作業上並行可能だが、post-image shapeをPhase 2 reviewで確定してからPhase 3を完了させる。Phase 7はPhase 6の公開型を複数table／APPENDへ拡張し、Phase 8はその合成結果へREMOVEとFULL_SURVIVORSを加える。Phase 9までversion bump／releaseせず、v3.8.0で一括公開する。

## 13. 裏取りで判明した齟齬・レビュー判断事項

### 13.1 R1時点の仕様内／現行実装との齟齬（§14で処理済み）

1. 正本仕様の冒頭 `docs/internal/ksql_apply_block_spec.md:3` は「実装着手はユーザー承認待ち」のままだが、本依頼ではR2を「実装着手可」と明示している。本計画は依頼を正として進める。実装開始前にspec statusだけを「実装着手可」へ同期するかClaude判断が必要である。
2. 仕様 §11.2（`docs/internal/ksql_apply_block_spec.md:698-705`）には、v1対象外のREMOVE／APPEND／複数親chunkのruntime受入条件が含まれる。§9.1／§12を優先し、v1では構文認識・明示拒否または将来設計境界までとした。
3. 仕様 §4.3は最大100親chunkを一般契約として書く一方、v1 §9.1は単一親に固定する。v1にchunk codeは不要であり、実装すると未テストの複数親能力を暗黙に作るため採らない。
4. 現行 `getRevision`（`src/execute.ts:6033-6036`）は欠落／不正を0へ落とす。B44の「revision必須」には弱いため、そのまま再利用せずstrict helperが必要である。
5. 現行 `DmlConfirmContext`（`src/execute.ts:411-422`）と`DmlValidationResult`（`:348-361`）はIMPORT detailしか持たない。B44件数表示をsurfaceごとに再計算せず、共有detail型を加法追加する必要がある。
6. 現行CLIの`dmlMaxRows`はconfirm callback内で強制される（`src/cli/index.ts:2130-2133`）一方、pluginには同等の上限設定がない。B44の必須二重guardはcoreへ置かなければ全surfaceで保証できない。

### 13.2 R1のレビュー判断事項（§14で5件とも裁定済み）

1. **scope errorの層**: 本計画は将来構文をAST化し、`assertApplyV1Scope`を`analyzeBatch`／executorで呼んで`UnsupportedError`にする。parser自体でthrowする案より「構文として識別」の証明が強いが、公開`parseSqlStatement`単体がv1外ASTを返す点を許容するか。
2. **MCP query schema**: `VALIDATE ONLY`の`guards.wouldExceed`を利用者指定値で評価できるよう、`dmlMaxSubtableRows`をquery schemaにも出すか。出さない場合はdefault 100固定、mutate schemaには「解禁しない」説明だけを置く。
3. **plugin guard設定**: v1単一親では親guardは常に1、子guard default100で十分として設定UIを増やさない案でよいか。CLIだけ明示flag、pluginはcore default＋確認dialogとなる。
4. **GET fieldsとFILE**: post-image全体を検証するため全form field/tableを取得するが、FILEは仕様対象外である。APPLY対象レコードにFILEが存在するだけで拒否するのか、FILEを保存済みopaque値として未検証・payload非送信で許容するのかを確定する必要がある。後者が実用的だが「post-image全体検証」の例外をspecへ明記すべきである。
5. **親0件**: §5.3は子selectorの0件規則だけを明記する。v1の`$id=<n>`単一親が存在しない場合、本計画はfail-closed `ArgumentError` とした。通常UPDATEの0件successに合わせるか、revision修復操作の安全性を優先してerrorにするかを確定したい。

### 13.3 R2で追加したレビュー判断事項

1. **削除guard**: `dmlMaxSubtableRows` をPATCH＋APPEND＋REMOVEのdistinct子行総和として維持し、専用 `dmlMaxDeletedSubtableRows` は追加しない推奨案でよいか。独立hard capを要求する場合は、総和guardを置換せずAND追加とする。
2. **APPENDの既定値責務**: Phase 9実機で「追加行の未指定childへkintoneが既定値を投入するか」を確認するまで、planner補完方針を確定保留とするか。リリース契約を決定的にするため、実機結果にかかわらず常にmetadata既定値を明示payload化する案も比較して裁定してほしい。
3. **同一tableの複数APPLY**: v1.1の「複数APPLYブロック」に同一tableの複数blockも含め、snapshot解決後に1 table planへ合成するか。それともR2では異なるtableだけ許可し、同一table重複は拒否するか。
4. **MCP別capability**: R1裁定はv1 query schemaのguard値を既定100固定とした。仕様 §9.2の安全条項を維持しつつ、v1.1時点で削除ゼロをplanで証明できるPATCH（APPENDなし）だけmutation capabilityを開く検討を実施するか、v3.8.0では全APPLY mutation fail-closedのままにするか。

## 14. Claude レビュー（R1 承認・2026-07-20）

**裏取り**: 引用をサンプリング検証し全一致（`isSoftKeyword` parser.ts:2751・`getRevision` の 0 フォールバック execute.ts:6033＝齟齬13.1-4 は事実・CLI `dmlMaxRows` の confirm callback 依存 cli/index.ts:2130＝齟齬13.1-6 は事実・通常 UPDATE の `$id` のみ取得 execute.ts:5564・`desktop.ts` 既存 tsc 10件の件数比較運用は [batch_temp_table_implementation_plan.md:30](ksql_batch_temp_table_implementation_plan.md) に前例記録あり・spec §11.2 の v1 外項目混在も事実）。フェーズ分割・モジュール分離（planner/postImageValidation を execute.ts へ埋め込まない）・§10 の受入条件割付・§11 リスク表は妥当。**指摘なしで承認**。

**§13.2 判断事項の裁定**:

1. **scope error の層 = 計画案を承認**（AST 保持＋`assertApplyV1Scope` を analyzeBatch/executor で共有）。パーサのメタデータ非依存原則と「構文として識別した上で拒否」（spec §2.1）の証明が最も強い。公開 parse が v1 外 AST を返すことは内部 API のため許容。
2. **MCP query schema = v1 では `dmlMaxSubtableRows` を出さない**。`ksql_query` に DML 上限系パラメータを置かない現行契約（`dmlMaxRows` も mutate 側のみ）と一貫させる。VALIDATE ONLY の `guards` は既定100で評価し、schema 説明へ「既定100固定」を明記。利用実態を見て v1.1 で再考。
3. **plugin 設定 UI = 増やさない（既定100）を承認**。options 境界の維持のみ。
4. **FILE = 拒否せず「保存済み opaque 値として未検証・payload 非送信で保持」を採用**。根拠=①FILE は監査可能制約を持たず B42 監査も対象外（既定対象から自然に外れる）②サブテーブルの patch 形 payload（行 id＋変更セルのみ）は未送信セルを kintone が保持する＝既存 `buildSubtablePatchPutParams` と同じ保証で、FILE 行があっても post-image の完全性を損なわない。**実装時に spec §6.1 へ例外1行を追記すること**（Phase 3 の作業項目に含める）。
5. **親 `$id` 0件 = fail-closed `ArgumentError` を承認**。修復オペで明示した単一 `$id` の消失を沈黙させないのは §5.3 の `_rid` 0件規則と同型。APPLY 専用経路なので通常 UPDATE の 0件 success 契約とは独立で、混同は生じない。

**齟齬13.1 の処理**: ①spec ステータス行は本コミットで「実装着手中」へ同期（済）②③v1 スコープ（spec §9.1）優先の整理を承認＝§11.2/§4.3 の一般契約項目は §10 の割付どおり将来版へ明示繰越④⑤⑥は計画の新設方針（`requireRevision`・共有 detail 型・core 強制ガード）で解消される。

## 15. Claude レビュー（R2 承認・2026-07-20）

**裏取り**: R2 の新規引用をサンプリング検証し全一致（現行サブテーブル DELETE の全存続行列挙 execute.ts:5978-5985・UPDATE のパッチ形 payload・仕様 §4.2 の「同一フィールドコードの APPLY ブロック複数=ArgumentError」spec:275）。Phase 7/8/9 の分割・`PATCH_ONLY`/`FULL_SURVIVORS` のテーブル単位 payload 形選択と `snapshot = survivors ∪ removed` 完全性 assert・§11 の追加リスク4行（payload 形誤選択・APPEND 既定値・削除ガード・phase scope 誤開放）は妥当。**§1/§9.1 の同一テーブル複数ブロックの記述を裁定3に合わせて修正の上、承認**。

**§13.3 判断事項の裁定**:

1. **削除ガード = 単一 `dmlMaxSubtableRows`（PATCH∪APPEND∪REMOVE の distinct 子行総和）を承認**。専用 `dmlMaxDeletedSubtableRows` は v3.8.0 では追加しない。総 mutation 量を1つの core 上限で制御でき、複数上限の組合せ穴を作らない codex の論拠を支持。削除固有の安全は①確認 UI での削除内訳の必須表示②`FULL_SURVIVORS` の完全性 assert（列挙漏れ=converter 拒否・putCalls=0）③revision 必須、で担保する。独立 hard cap は実運用要望が出た時点で AND 条件として加法追加。
2. **APPEND の既定値責務 = 「常に metadata 既定値を明示 payload 化」を採用**（実機結果に依らず契約を確定）。理由=①リリース契約が決定的になり、VALIDATE ONLY の post-image が送信値そのものと一致（kintone 挙動の予測が不要）②Phase 7 の実装が実機待ちでブロックしない。Phase 9 の実機対照試験は「明示補完値と kintone の自然挙動（未指定時）の一致確認」へ目的を変更し、kintone が明示補完 payload を拒否する等の齟齬が出た場合のみ再裁定する。既定値なしの required 未指定 child は計画どおり PUT 前 error。
3. **同一テーブルの複数 APPLY ブロック = 拒否**（v1.1 でも許可しない）。仕様 §4.2 が既に ArgumentError と規定しており（裏取り済）、複数操作は同一ブロック内の `;` 区切りで表現できるため合成の複雑さに見合う価値がない。計画 §1/§9.1 は本裁定に合わせ修正済み。
4. **MCP capability = v3.8.0 では全 APPLY mutation fail-closed のまま**。「削除ゼロを計画で証明できる PATCH のみ解禁」の検討は仕様 §9.2 の安全条項（10条件）を設計メモとして維持するに留める。理由=v3.8.0 のスコープ肥大回避と、MCP 解禁は承認 UI 不在下の安全論証そのものが独立の検証テーマであること。R1 裁定2（query schema へ `dmlMaxSubtableRows` を出さない・既定100固定）も維持。

**総括**: v1/v1.1/v1.2 の v3.8.0 一括同梱を前提とした Phase 1〜9 構成で**実装着手可**。Phase 1（parser/AST + scope validator）から開始する。
