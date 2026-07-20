# B44 `APPLY` v1／v1.1／v1.2／v2 実装計画 R3

- ステータス: 実装計画 **R3・レビュー待ち**（Phase 1～9 の v1／v1.1／v1.2 は `017ebba` まで実装・実機確認・commit済み。2026-07-20 ユーザー決定により v2 の複数親、`_idx`、`EXPECT ROWS`、INSERT／UPSERT、多値 `ADD`／`REMOVE` も **v3.8.0 に同梱**する。§14／§15 の Claude 裁定は維持）
- 対象ブランチ: `feat/b44-apply-patch`
- 正本仕様: [B44 APPLY ブロック仕様 R2](ksql_apply_block_spec.md)
- 対象版: **v3.8.0**（SemVer minor）
- 制約: R3 改訂では実装・commit・`npm test`・版数更新・リリース成果物更新を行わない。Phase 1～9 の実装済み内容は変更せず、Phase 10 以降を `実装 → 対象テスト → Claude review → 必要な修正` の独立 gate とする。最終 Phase 17 で v2 を含む統合・実機・release 準備を行い、リリースは v3.8.0 の1回だけとする。

## 1. 結論と実装方針

B44 は、既存のトップレベル DML とサブテーブル仮想テーブル DML を順番に呼ぶ機能にはしない。Phase 1～9 で確立した「1対象親＝1 plan＝1 write record」の宣言的合成を保ち、Phase 10 で UPDATE の plan 結果を単数 `ApplyPatchPlan` から `readonly ApplyPatchPlan[]` へ広げる。以後 `_idx`、`EXPECT ROWS`、INSERT初期行、UPSERT分岐、多値集合操作を同じ preflight／post-image／guard 境界へ追加し、Phase 17 で一括統合する。

R1 の Phase 1～6、R2 の Phase 7～9、§14／§15 の裁定は変更しない。仕様 §9 の「v1／v1.1／v1.2／v2」および §5.1 の `_idx`「v2」は公開version名ではなく、すべて **v3.8.0 内の実装フェーズ／capability集合**と読み替える。途中version bump・途中公開はしない。新しい soft keyword と AST node の加法追加であり、APPLYなしの既存SQL意味論を変えないため SemVer は minor のままとする。

```text
parser/AST（UPDATE／INSERT／UPSERT）
  → phase-aware scope validator（文種・親数・許可操作を Phase ごとに拡張）
  → form metadata と GET field-set の解決
  → UPDATE/UPSERT-update は全対象親 snapshot GET（$id・$revision・親参照列・全 post-image 検証対象）
  → INSERT/UPSERT-insert は revision なしの create candidate を構築
  → 親ごとに子 selector／集合操作を snapshot 上で解決
  → 重複検出・親 SET／子 PATCH／APPEND／REMOVE の post-image 合成
  → テーブル単位の payload 形選択
  → 全親の post-image 全体検証・EXPECT ROWS・dmlMaxRows／dmlMaxSubtableRows 判定
  → 最初の write 前に全 plan を確定
  → VALIDATE ONLY 結果、または確認後に POST と revision 付き PUT（PUT は最大100親ずつ）
```

安全上の不変条件は次のとおりとする。

- Phase 1～6（v1）は親 `UPDATE`、`$id = <正の安全な整数>` の単一親、1文1サブテーブル、1 `APPLY`、`PATCH` のみを実行可能にする。
- Phase 7（v1.1）は単一親を維持したまま、複数 `APPLY`、**異なる**複数テーブル、`APPEND` を許可する。同一テーブルの複数ブロックは仕様 §4.2 どおり `ArgumentError` で拒否する（1テーブル1ブロック。複数操作は `;` で同一ブロック内に並べられるため表現力は失わない。§15 裁定3）。
- Phase 8（v1.2）は上記に `REMOVE WHERE ...`／`REMOVE ALL ROWS` を加える。
- Phase 10 は UPDATE の複数親、Phase 11 は `_idx`、Phase 12 は `EXPECT ROWS`、Phase 13 は INSERT 初期行、Phase 14 は UPSERT 分岐、Phase 15 は複数値fieldの `ADD`／`REMOVE` を順に解禁する。各 Phase 完了までは後続capabilityを対象フェーズ名付き `UnsupportedError` で閉じる。
- malformed な句順、空ブロック、空操作、`APPLY SUBTABLE ...` は構文エラーであるため `ParseError` とする。
- planner、post-image validator、guard は `src/execute.ts` の巨大関数へ埋め込まず、純粋関数中心の新規モジュールへ分離する。`execute.ts` は metadata／records API と mutation の orchestration に限定する。
- Phase 1～3 では `UPDATE ... APPLY` の実 mutation dispatch を閉じる。Phase 4 で revision、全件先行検証、二重ガードが揃ってから CLI／plugin 用 core mutation を開通する。MCP mutation は Phase 6 後も閉じたままにする。
- Phase 1～9 の単数 `ApplyPatchPlan` 境界（`src/core/applyPatchPlanner.ts:56-68`、`src/converter/applyPatchToKintone.ts:17-40`、`src/execute.ts:5649-5749`）は Phase 10 で `readonly ApplyPatchPlan[]` へ拡張する。全親の selector、revision、post-image validation、EXPECT／件数guardを最初の PUT 前に確定してから、1親1recordを最大100件ずつ送る。後続chunk失敗時に先行成功分は残り、rollback／retryはしない。

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

## 9. Phase 7～17 — v1.1／v1.2 実装済み基盤と v2 追加

### 9.1 Phase 7 — v1.1 複数合成＋`APPEND`（L）

- 依存: Phase 1～6。着地点は、単一親のまま複数 `APPLY`／複数tableと `APPEND` を同一snapshot・同一PUT recordへ合成できること。v1のPATCH経路とMCP fail-closedは維持する。
- scope validatorを `assertApplyScope("v1.1")` 相当へ拡張し、許可集合を `{親UPDATE, 単一$id親, PATCH, APPEND, 複数APPLY, 複数table}` とする。`REMOVE`、`EXPECT ROWS`、`_idx`、INSERT／UPSERT、複数親、複数値ADD/REMOVEはこのPhaseでも拒否する。Phase 1で確立したAST保持＋analyzeBatch/executor共有というClaude裁定は変えない。
- plannerは全blockのselector／RHSを更新前snapshotへ解決してからtable単位に合成する。同一tableの複数blockは §15 裁定3 により合成せず `ArgumentError`。同一cell多重PATCH、APPEND指定field重複をPUT前に拒否し、APPEND行は同文PATCHから不可視、追加順はSQL記述順で既存行末尾とする。
- APPEND rowは未採番なので `value` のみを持つ。指定値の型・選択肢・長さ・required・B29整数部桁数／number precisionを検証・normalizeし、未指定childは§15裁定2どおりフォームmetadata既定値を常に明示payload化する。Phase 9実機はこの決定的契約と保存後imageの一致を確認済みであり、v2のINSERT／UPSERT insertでも同じbuilderを再利用する。
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

### 9.3 Phase 9 — v1／v1.1／v1.2 統合・実機 baseline（完了・M）

- 依存: Phase 1～8すべて。`017ebba` までに v1／v1.1／v1.2 の受入条件、APP4221実機、複数table、200レコード規模試験まで完了した baseline。R3 はこの証跡を壊さず、release gateだけ Phase 17へ移す。
- 仕様 §11.1／§11.2 の全対象項目をacceptance matrixで再実行する。APPLYなしUPDATE、UPDATE FROM、CHECK、VALIDATE ONLY、ON ERROR SKIP、仮想table UPDATE／DELETE、B42 VALIDATE、IMPORT subtableの非回帰を重点確認する。
- `npm test`、`npm run build:cli`、`npm run build:mcp`、`npm run build:mcpb`、`npm run build:plugin`、`npm run mcp:smoke`、`npm run mcp:pack-smoke` は実装完了時に実施する。本計画作成時は実行しない。`npx tsc --noEmit` は既存 `desktop.ts` 10件との件数・内容差分で判定し、新規error 0を要求する。
- 証跡を `docs/internal/evidence/b44_apply_patch_dev_smoke.md`（新規）へ保存する。実機はAPP4221を使い、既存証拠fixture `$id=7` は更新しない。
- v1基礎12手順は仕様 §11.3を維持し、専用レコードのsnapshot保存、既存親子違反、従来UPDATEの`CB_VA01`、B42照合、B44 VALIDATE ONLY／mutation、未指定cell・id・行順保持、revision conflict、CLI／Firefox／Chromium／MCP、復元を行う。
- APPEND実機: 既定値付き・required既定値なし・NUMBER精度対象childを持つ専用table/recordで、未指定childを省いた追加payloadを送る対照試験を行い、kintoneがフォーム既定値を投入するか、空値にするか、拒否するかをGET結果とraw request/responseで記録する。結果に基づきplanner明示補完の要否を確定し、VALIDATE ONLYのpost-imageと実PUT後imageが一致することを再確認する。
- 複数合成実機: 2つ以上のAPPLY/tableでPATCH＋APPENDを同時実行し、1 record payload、各tableの既存id・順序保持、APPEND末尾順、table別件数を確認する。
- REMOVE実機: 先頭／中間行を削除し、REMOVE tableだけが全存続行形、非REMOVE tableはパッチ形であるraw payloadを保存する。PUT後に削除対象だけが消え、存続行の全値・row id・相対順とAPPEND末尾順が一致することを確認する。GET後PUT前の別更新でrevision conflictを起こし、削除0、retry GET 0、別client更新保持を記録する。
- CLI／Firefox／Chromiumの確認表示でPATCH／APPEND／REMOVE、総子行数、削除行数、削除対象親数が一致し、キャンセル時putCalls=0、MCP mutation fail-closedを確認する。最後に制約と専用recordを復元／削除し、`$id=7`非変更を記録する。

### 9.4 Phase 10 — 複数親 `UPDATE ... APPLY` と100件chunk（XL・最重要）

#### 着地点・依存・受入条件

- 依存: Phase 1～9。着地点は、一般の親 `WHERE` に一致した N 親を `readonly ApplyPatchPlan[]` として全件preflightし、1親1 PUT record、最大100親/chunkで実行できること。
- 対応受入条件: 仕様 §4.3、§5.3の親ごとの評価、§5.4、§7.1、§11.2の1親1record、100親chunk、後続chunk失敗、全件先行検証、revision conflict非retry。
- 親0件は通常UPDATE互換の `updatedCount=0` successをR3推奨とするが、§14裁定5の単一`$id`消失errorとの境界を§13.4で再裁定する。単一`$id` special selectorだけerrorを維持する案も併記する。

#### 作業項目（再利用／新設）

1. scope／取得（変更）: `src/core/applyPatchScope.ts:8-46,61-125` のversion capabilityへ `multipleParents` を追加し、`assertSinglePositiveRecordId`（`:99,133-140`）を安全な親WHEREへ広げる。通常UPDATEのWHERE capability／fetch経路は再利用するが、records queryの部分集合を正集合にしない。取得は `dmlMaxRows + 1` で超過検知し、truncateせずerror、上限内ならAPPLY snapshot field-setで全対象を取得する。
2. plan adapter（新設）: `src/core/applyPatchPlanner.ts:56-81,233-371` の1 snapshot→1 plan純粋関数は残し、`buildApplyPatchPlans(statement, snapshots, ...) : readonly ApplyPatchPlan[]` を追加する。各snapshotで `$id`／`$revision`、selector、重複、post-imageを独立確定し、parentId重複を拒否する。
3. executor（変更）: `src/execute.ts:5619-5750` の単一GET／単一validation／単一confirmを、全snapshot GET → 全plan構築 → 全parent validation → 全guard → 1回confirm → writeへ変更する。`dmlMaxRows` は `plans.length`、`dmlMaxSubtableRows` は全planのdistinct `(parentId,table,rowId|appendOrdinal)` 合計とし、guard・validation・revision欠落が1件でもあればputCalls=0。
4. converter（変更＋新設）: `src/converter/applyPatchToKintone.ts:17-40` は1 plan→1 record primitiveとして残し、`applyPatchPlansToKintoneBatches(plans)` を新設する。`records` を最大100件へchunk化し、空配列は0 batch、入力順と1親1recordを保持する。既存一般UPDATEの100件chunk前例は `src/converter/dmlToKintone.ts:109-120,164-173`。
5. 結果／文書（変更）: `ApplyConfirmDetail`（`src/execute.ts:449-465`）を複数親集計へ拡張し、成功済みchunk数／親数をエラーから隠さない。文全体は非トランザクション、後続chunk失敗時は先行分が残る、補償更新なし、revision conflictは当該chunk失敗・非retryをCLI/plugin確認と公開文書へ明記する。

#### テスト計画・リスク

- planner: 0／1／2／100／101／201親、親ごとのsnapshot不可視性・revision・post-image、同じ`_rid`が別親に存在してもparent keyで分離、別親 `_rid` 指定は各親内unknownとしてPUT前拒否。
- executor/converter: 100→1 call、101→2 calls、201→3 calls、全preflight後までPUT 0、2nd chunk conflict時に1st=100件成功済み・retry GET/PUT 0、出力が部分成功を明示すること。`dmlMaxRows=N-1` と子guard超過は最初のPUT前失敗。
- 最大リスクは先行chunkの部分成功と「validateしながらwrite」の混入。write loopへ入る前のimmutable `plans`／`batches` 完成を構造的gateとし、converterはplanning／validationを行わない。

### 9.5 Phase 11 — `_idx` 0-based セレクタ（M）

#### 着地点・依存・受入条件

- 依存: Phase 10。着地点は取得snapshot内の0-based位置で `PATCH`／`REMOVE` 行を指定でき、全既存親でrevisionを必須にすること。
- 対応受入条件: 仕様 §5.1、§5.3、§5.4、§11.2の `_idx` 0-based、単一0件error、対象消失を `EXPECT ROWS 0` で無効化不可。

#### 作業項目（再利用／新設）

1. scope（変更）: `src/core/applyPatchScope.ts:101-125` のsafe child predicate許可集合へ `_idx` を加える。代入先禁止は維持し、整数比較以外を許す場合も決定的ローカル評価だけに限定する。
2. selector（再利用＋変更）: `_idx` の値生成は `src/converter/subtableAdapter.ts:23-29` と `src/core/applyPatchPlanner.ts:221-230` の既存0-based文字列を正とする。type resolver（planner `:251-252`）へ `_idx: NUMBER` を追加し、単一指定形を検出して0件を `ArgumentError` にする。
3. guard（維持）: `requireRevision`（`src/converter/applyPatchToKintone.ts:8-15`）とper-parent revisionを全 `_idx` planに強制し、indexを再GETしてretryしない。

#### テスト計画・リスク

- 各親の先頭0／中間／末尾、範囲外、空table、複数親それぞれの `_idx=0`、`_rid`との混在、REMOVE後のindex再採番、`_idx` assignment拒否をunit/integrationで固定する。
- リスクは1-based表示列 `$err_subrow` との混同と配列変更後indexの再評価。selectorは更新前snapshotだけを読み、診断は `_idx+1` 表示・row id併記とする。

### 9.6 Phase 12 — `EXPECT ROWS` 実行（M）

#### 着地点・依存・受入条件

- 依存: Phase 10（Phase 11とは機能上独立だが、`_idx`消失規則の結合試験のため実装順は11後）。着地点は `n`／`BETWEEN a AND b`／`AT LEAST n`／`AT MOST n` を各親・各操作へ独立評価すること。
- 対応受入条件: 仕様 §3、§5.3、§5.5。全親合計では判定せず、不一致は `ArgumentError`、書込み0。

#### 作業項目（再利用／新設）

1. AST/parser（再利用）: `ExpectRowsGuard` は `src/types/ast.ts:789-818` に全4形があり、UPDATE parserも既に保持する。scope capability `expectRows`（`src/core/applyPatchScope.ts:10-45,109-115`）だけを解禁する。
2. evaluator（新設）: pure `assertExpectRows(guard, actual, parentId, table, operationIndex)` を追加し、plannerのselector解決直後（`src/core/applyPatchPlanner.ts:263-305`）に、post-image合成前に呼ぶ。`BETWEEN min>max` と負数はparser/static error、runtime mismatchはArgumentError。
3. precedence（変更）: `_rid`／`_idx`単一指定0件errorをEXPECT評価より先に確定し、`EXPECT ROWS 0`で消せない。一般述語0件はguardなしならno-op、guardありなら条件式で決まる。

#### テスト計画・リスク

- 4形の境界、0、等値、逆BETWEEN、各親別（1親pass・別親failでPUT 0）、各operation別（PATCH pass・REMOVE fail）、全親合計ならpassでも個別fail、VALIDATE ONLYでも不一致throwを固定する。
- リスクは全親集計への誤実装。operation planに `matchedRows` とguard結果を保持し、確認表示／診断でも parent/table/operation 単位を失わない。

### 9.7 Phase 13 — INSERT 初期サブテーブル行（L）

#### 着地点・依存・受入条件

- 依存: Phase 7のAPPEND既定値補完、Phase 3のpost-image validation、Phase 10の複数candidate preflight。着地点は `INSERT INTO ... VALUES ... APPLY <table> (APPEND ...)` をrevisionなしのPOST recordへ合成すること。
- 対応受入条件: 仕様 §3.2、§5.4の新規親revision例外、§9.4のINSERT初期行、§11のpost-image／guard／surface契約。

#### 作業項目（再利用／新設）

1. AST/parser（変更）: `InsertStatement`（`src/types/ast.ts:618-630`）へ `applyBlocks?` を加え、`parseInsert` のVALUES完了後・CHECK/validation前（`src/parser/parser.ts:2460-2477`）に共通 `parseApplyBlock` を接続する。INSERTではAPPENDだけを許可し、PATCH／subtable REMOVE／`_idx`／EXPECTをstatic拒否する。
2. create planner（新設＋再利用）: 親VALUESの各行をcreate candidateにし、Phase 7のAPPEND row builder／metadata既定値明示補完と `validatePostImage` を再利用する。新規親は `$id`／`$revision`／snapshot行を持たず、1 VALUES row＝1 POST record。既存 `insertToPostBatches` は100件分割する（`src/converter/dmlToKintone.ts:109-120`）がtable合成を扱わないため、B44 create converterを分離する。
3. guard／write（変更）: 全create candidatesを検証し、`dmlMaxRows`＝親数、`dmlMaxSubtableRows`＝APPEND初期行総数を最初のPOST前に判定する。POSTは最大100records/chunk。後続POST失敗の非トランザクション性も複数親PUTと同様に明示する。

#### テスト計画・リスク

- 1／複数VALUES、複数table、0行／複数APPEND、既定値・required・NUMBER precision・FILE拒否、親とtable同一POST record、100/101件chunk、validation/guard失敗POST 0を確認する。
- リスクは既存INSERTの未指定field/kintone既定挙動との不一致。サブテーブル子は§15裁定2どおりmetadata既定値を常に明示し、APPLYなしINSERT converterを変更しない。

### 9.8 Phase 14 — UPSERT `ON INSERT`／`ON UPDATE` 分岐（XL）

#### 着地点・依存・受入条件

- 依存: Phase 10～13。着地点はUPSERT照合結果を全件確定後、insert candidateへ初期APPEND、update candidateへ既存snapshot PATCH／APPEND／REMOVEを適用し、最初のPOST/PUT前に両分岐を一括preflightすること。
- 対応受入条件: 仕様 §9.4のUPSERT分岐、§4.1、§4.3、§5.4。補足裁定は comparison §7 P2-6（`docs/internal/ksql_b44_c1_c3_comparison.md:199`）を採用候補とし、§13.4で正本化をレビューする。

#### 作業項目（再利用／新設）

1. AST/parser（変更）: `UpsertStatement`（`src/types/ast.ts:644-657`）へ `onInsertApplyBlocks?`／`onUpdateApplyBlocks?` を加える。`parseUpsert`／`parseOnDuplicate`（`src/parser/parser.ts:2480-2531`）の `ON DUPLICATE(key)` 後に soft keyword `ON INSERT APPLY ...`／`ON UPDATE APPLY ...` を順不同・各1回で解析し、CHECK/validation suffixより前に固定する。`UPSERT_SELECT`への同時解禁はscope外とし明示拒否する。
2. 分岐planner（変更＋新設）: 既存UPSERT一括照合は候補をcreate/updateへ分ける（`src/execute.ts:4388-4435`、照合indexは`:3553-3665`）。照合後、createはPhase 13 planner、updateはPhase 10 plannerへ渡し、同じsource rowの親値とAPPLY分岐を1 recordへ合成する。
3. 分岐規則（static）: insert分岐はAPPENDのみでPATCH／REMOVE禁止。update分岐はPATCH／APPEND／REMOVE／`_idx`／EXPECT可。`ON INSERT`省略＝新規親tableはkintone既定、`ON UPDATE`省略＝既存table完全保持、両省略＝現行UPSERTと同一、を推奨する。
4. write順／結果（新設）: 全照合・snapshot・revision・post-image・EXPECT・二重guardを先に確定し、confirmにinsert/update親数とtable別内訳を出す。POST/PUTはそれぞれ100件chunk。API間トランザクションはないため、write順と部分成功表現を固定し、自動補償・revision retryはしない。

#### テスト計画・リスク

- insertのみ、updateのみ、混在、各分岐省略、insert側PATCH/REMOVE拒否、update側revision conflict、source key重複、複数親guard、全preflight前API 0、POST成功後PUT失敗の部分成功表示を固定する。APPLYなしUPSERTのpayload/result非回帰を必須にする。
- 最大リスクはPOSTとPUTの非原子的混在とparserの既存 `ON DUPLICATE`／`ON ERROR` 衝突。句順fixtureとAPI順を契約化し、結果に `insertedCount`／`updatedCount`／失敗stage／成功済みchunkを保持する。

### 9.9 Phase 15 — 多値field `ADD`／`REMOVE`（L）

#### 着地点・依存・受入条件

- 依存: Phase 10の複数親基盤、Phase 12のoperation guard共通化。着地点は `CHECK_BOX`／`MULTI_SELECT`／`USER_SELECT`／`ORGANIZATION_SELECT`／`GROUP_SELECT` をサブテーブルでない集合値としてsnapshotから追加・除去できること。
- 対応受入条件: 正本仕様 §9.4の集合型拡張と§8のsurface契約、詳細意味論は comparison §8。行IDなし、集合要素単位、選択肢検証、B46空値契約を満たす。

#### 作業項目（再利用／新設）

1. AST/parser（変更）: `ApplyOperation`（`src/types/ast.ts:782-818`）へ集合 `ADD`／`REMOVE_VALUE` nodeを追加する。`APPLY <field> (ADD <value>; REMOVE <value>)` を共通block parserで識別し、subtable `REMOVE WHERE/ALL ROWS` とは後続tokenで分岐する。`ADD`はsoft keywordのまま。
2. metadata/scope（変更）: `resolveApplyPatchMetadata`（`src/core/applyPatchPlanner.ts:98-125`）を「SUBTABLE target」と「top-level multi-value target」のtagged unionへ広げ、型×動詞整合をrecords API前に検査する。対象型集合は既存変換の `src/converter/dmlToKintone.ts:66-67,383-387` を再利用する。
3. 集合planner（新設）: snapshot配列を順序保持した集合として扱い、ADDは未存在要素を末尾追加、REMOVEは存在要素を除去する案を推奨する。重複ADD／不存在REMOVEのno-opまたはerror、同値の同文ADD+REMOVEの扱いは§13.4で裁定する。
4. validation（再利用＋拡張）: `optionOrder` は `src/core/formFieldInfo.ts:54-69`、choice検証とB46空値除外は `src/core/dmlValidation.ts:100-109` を再利用する。USER/ORG/GROUPはフォームoptionOrderを持たないため、文字列code形式だけをlocal検証し、存在確認APIを新設しない。空文字ADD/REMOVEはB46に合わせ「空（未選択）」として扱い、requiredは最終post-imageで判定する。

#### テスト計画・リスク

- 5型、順序保持、重複／不存在、全要素REMOVE、required、定義外choice、空値、複数親、subtable動詞とのparse曖昧性、親SETとの同一field重複をunit/integrationで固定する。
- リスクは「集合」なのに重複・順序契約が曖昧な点とUSER系の存在検証不能。payload契約を§13.4で確定し、post-imageはkintone配列形（選択肢string[]／主体`{code}[]`）へ正規化してからconverterへ渡す。

### 9.10 Phase 16 — CLI／plugin／MCP／診断の v2 統合（L）

#### 着地点・依存・受入条件

- 依存: Phase 10～15。着地点はCLIとpluginが複数親・INSERT/UPSERT分岐・多値操作を実行前に確認でき、MCPはすべてのAPPLY mutationを引き続きfail-closedとすること。
- 対応受入条件: 仕様 §7.2、§8、§11.2のsurface契約と§15裁定4。

#### 作業項目（再利用／新設）

1. shared detail（変更）: `ApplyConfirmDetail`（`src/execute.ts:449-465`）へstatement kind、insert/update親数、chunk数、table別PATCH/APPEND/REMOVE、多値field別ADD/REMOVE、partial-success注意を追加する。
2. CLI/plugin（変更）: CLI formatter `src/cli/index.ts:613-620` とplugin dialog `src/ui/desktop.ts:2858-2859` を同じdetailから描画し、親を全列挙せずfield/table別集計＋危険操作親数を表示する。`--yes`でもcore guardは迂回不可。
3. MCP（変更）: 現在UPDATEだけを検出する `src/mcp/tools.ts:499-503` をINSERT／UPSERT ASTにも広げ、validate/explain/query VALIDATE ONLYは許可、mutateはruntime／records API前に拒否する。SQL文字列検索は禁止し、§15裁定4を維持する。
4. EXPLAIN/VALIDATE（変更）: 文種、親件数unknown/実数、branch、selector/EXPECT、multi-value counts、chunk/非トランザクション注意を既存optional payloadへ加法追加する。

#### テスト計画・リスク

- CLI e2e、plugin render/browser、MCP schema/tools/smokeで全6capabilityをmatrix化する。MCP mutationは十分なguard／confirm指定でもAPI 0。HTML/shell escaping、100/101親表示、UPSERT混在内訳を固定する。
- リスクはsurface独自再集計によるdrift。件数はexecutorが確定したshared detailだけを表示し、CLI/pluginにplan解釈を持たせない。

### 9.11 Phase 17 — 全統合・v2実機・release準備（L）

#### 着地点・依存・受入条件

- 依存: Phase 1～16。着地点は仕様のv1～v2受入matrix、実kintone、CLI／Firefox／Chromium、MCP fail-closed、release metadata準備が完了し、v3.8.0を1回だけreleaseできる状態にすること。
- 対応受入条件: 仕様 §11全体に加え、§4.3の部分成功、§9.4の全項目、Phase 9 baseline非回帰。

#### 実機・回帰・リリース作業

1. 回帰: `npm test`、CLI/MCP/MCPB/plugin build、MCP smoke/pack-smoke、`tsc --noEmit` baseline差分、新旧browser smokeを実装完了時に実施する。本R3作成時は実行しない。
2. 複数親: 専用app/fixtureで0、2、100、101、200親を1文UPDATEし、raw requestが100件chunk、1親1record、各revision付き、親/子値正確であることを記録する。101件の第2chunkへ意図的conflict/validation failureを起こし、先行100件が残る・retryなし・結果/文書が部分成功を明示することを確認し、全fixtureを復元する。
3. `_idx`／EXPECT: 複数親ごとの `_idx=0`、範囲外、4種EXPECT、全親合計なら満たすが個別には不一致のcase、`EXPECT ROWS 0`で `_idx`消失を無効化できないcaseを確認する。
4. INSERT: 複数VALUES×複数tableで初期APPEND、metadata既定値明示補完、required/choice/precision、100/101 POST chunk、revision非送信をraw payloadとGET後imageで照合する。
5. UPSERT: insert/update混在、各分岐省略、insert APPEND、update PATCH/APPEND/REMOVE、既存親revision、POST/PUT部分失敗の結果表現を確認する。
6. 多値: 5型のADD/REMOVE、choice実在、空値、required、順序・重複裁定どおりのpayloadとGET後imageを確認する。
7. surface: CLI／Firefox／Chromiumで親数、branch、table/field別内訳、削除、revision、非トランザクション注意、cancel時API 0を確認する。MCPはEXPLAIN／VALIDATE ONLYのみ成功し全APPLY mutationがfail-closed。
8. evidenceは既存 `docs/internal/evidence/b44_apply_patch_dev_smoke.md` にv2節を追記し、APP4221 `$id=7` とPhase 9証跡を変更しない。

#### 最終リリース準備・リスク

- 公開版は **v3.8.0**、SemVer **minor**。Phase中はversion／CHANGELOG／release artifactを更新しない。全gate後に `package.json`／lock／`prod/manifest.json` → CHANGELOG／README／言語reference／CLI tutorial／MCP説明／issue tracker B44 → 全build → smoke/evidence → CLI/MCP/plugin/zip/release filenameのversion整合 → artifact差替えの順で行う。
- 最大リスクは実機部分成功試験の復旧漏れ。専用fixture、事前snapshot、chunkごとの成功ID、復旧SQL/API、復旧後diffを証跡化し、共有証拠fixtureを使わない。

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
| v1～v1.2統合・実機baseline | regression suite | 実kintone、browser smoke、規模試験 | 9（完了） |
| 複数親、全件preflight、100件chunk、部分成功 | plan array／batch converter | 101/201親、後続chunk失敗 | 10 |
| `_idx` 0-based／revision／0件 | selector/type resolver | 複数親位置指定、競合 | 11 |
| EXPECT 4形、親別・operation別評価 | guard evaluator | 個別failでwrite 0 | 12 |
| INSERT初期APPEND | create planner／POST converter | 100/101 records、既定値 | 13 |
| UPSERT insert/update分岐 | parser／branch planner | 混在・省略・POST/PUT部分成功 | 14 |
| 多値ADD/REMOVE | collection planner／validation | 5型・choice・B46空値 | 15 |
| v2 surface／MCP fail-closed | shared detail／formatter | CLI/plugin/MCP smoke | 16 |
| v1～v2統合・実機・release準備 | full regression | 実kintone、browser、artifacts | 17 |

仕様 §11.2 にある項目はv3.8.0内の実装フェーズへ次のように割り付ける。

- PATCH/REMOVE重複とAPPEND行の不可視性: Phase 1でAST保持とv1拒否、Phase 7でAPPEND不可視性、Phase 8でPATCH/REMOVE重複のruntime semanticsを実装・テストする。
- 複数親100件chunkと後続chunk失敗: Phase 10で単数plan primitiveをarray adapterへ広げ、全件preflight後だけwrite loopへ入る。Phase 17で実機部分成功を証跡化する。
- 未知・別親 `_rid`: Phase 10で `(parentId,table,rowId)` scopeを固定し、他親に実在しても当該親snapshotに無ければunknownとして最初のPUT前に文全体を拒否する。
- `_idx`／EXPECT／INSERT／UPSERT／多値ADD/REMOVE: Phase 11～15で一機能ずつ解禁し、各Phaseで後続capabilityの拒否matrixとAPPLYなしDML非回帰を再実行する。

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
| APPEND既定値のpayload drift | INSERT/UPSERT createだけ補完を省き、VALIDATE ONLY post-imageと保存値がずれる | §15裁定2のmetadata既定値明示payload builderをPhase 13/14でも共用。required/default/precisionは追加行全体をwrite前検証 |
| 削除guardの穴／過剰設定 | 削除だけ別capで総mutation量を迂回、または設定増でsurface drift | まず総和`dmlMaxSubtableRows`を推奨。独立hard capが必要との裁定時だけ`dmlMaxDeletedSubtableRows`をAND追加し、CLI/env/profile/MCP説明/smokeを同時同期 |
| 複数親のpreflight/write混在 | 先行親を書いた後に後続親のvalidation/guard/EXPECT違反が判明 | Phase 10で全plan arrayと全batchをimmutableに完成させてからwrite。validation、revision、guard、confirmの各失敗でputCalls=0をspy固定 |
| chunk部分成功の隠蔽 | 101件目のconflictを文全体0件のように返し、先行100件を利用者が見落とす | chunk index、成功済み親数、非トランザクション、非rollbackをerror/result/CLI/plugin/docsへ共通detailで露出。自動retry/補償禁止 |
| `_idx` の基数／再評価違い | 1-basedで誤更新、先行REMOVE後の位置を読む | snapshot flattenの既存0-based値だけを正とし、全selectorを変更前snapshotで解決。表示序数だけ+1 |
| EXPECTの集計単位違い | 全親合計が期待値を満たして個別逸脱を見逃す | `(parentId,table,operationIndex)` ごとのpure evaluator。全親合計pass・個別fail fixtureを必須化 |
| INSERT/UPSERTのrevision混線 | 新規親へrevisionを要求、既存親updateからrevisionを落とす | create/update planをtagged union化。createはPOST/revisionなし、updateはPUT/revision requiredをconverter型で分離 |
| UPSERTのPOST/PUT部分成功 | insertが成功しupdateがconflict、または逆順で不明瞭 | write順とstageを固定し、全preflight後に実行。成功済みbranch/chunkを結果へ保持し、補償・retryをしない |
| 多値payload型の混同 | choice string[] とUSER系 `{code}[]` を取り違える | fieldType別normalizerをpure化し、5型のraw payload fixtureをconverterテストで固定 |
| phase scopeの誤開放 | Phase 11でEXPECT、Phase 13でUPSERT、多値操作まで通る | version文字列比較でなく明示的capability集合をscope validatorへ渡し、各Phaseで許可・拒否matrixを全再実行する |

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
| 9 | v1～v1.2統合・実機baseline（完了） | M | 1～8 | commit `017ebba`、実機／規模evidence |
| 10a | 複数親: planner primitive の単一`$id`結合を解消＋`buildApplyPatchPlans`:`readonly ApplyPatchPlan[]`＋scope へ `multipleParents`＋**構文許可・実行閉の二軸 capability で公開 execute/batch を API 0 gate** | L | 1～9 | pure planner／scope green、公開経路 API 0 |
| 10b | 複数親: 複数レコード GET（`dmlMaxRows+1` 超過検知）＋全親 preflight/validation/guard＋prepared immutable batches（`prepare()`）。**mutation はまだ閉じる** | L | 10a | 全件 preflight green、write 0（prepare のみ） |
| 10c | 複数親: 100件chunk converter＋core write loop＋共通の**部分成功 result/error 型**。公開 execution capability は閉じたまま | L | 10b | internal executePrepared で100→1・101→2・201→3 call、2nd chunk conflictで成功済chunk/親数・失敗stage保持、非retry。公開経路API 0 |
| 10d | 複数親: `execute`／`executeBatch` 開通＋batch envelope／共有confirm detailへの部分成功伝播。CLI/plugin固有描画はPhase 16 | M | 10c | 明示capability時だけ公開開通、batch envelopeで成功済み件数を欠落させない、MCP API 0 |
| 11 | `_idx` selector | M | 10d | 0-based、0件、revision、複数親 green |
| 12 | `EXPECT ROWS` 4形 | M | 10d,11 | 親別・operation別guard、write 0 green |
| 13a | INSERT初期行: `InsertStatement.applyBlocks`＋parser/scope＋INSERT/UPSERTも拾う共通APPLY検出＋**実行閉/API 0 gate** | M | 7,10d,12 | parse/scope/拒否matrix、execute/batch/MCP mutation API 0、APPLYなしINSERT非回帰 |
| 13b | INSERT初期行: create planner＋post-image/既定値/二重guard＋prepared POST batches。**mutation は閉じたまま** | L | 13a | 複数VALUES×template、全candidate preflight、POST 0 |
| 13c | INSERT初期行: 100件POST converter/write＋Phase 10c部分成功型の再利用＋core明示capability開通 | M | 13b | 100/101 chunk、2nd POST失敗の成功済み件数、CLI/plugin/MCPは未開通 |
| 14a | UPSERT: parser/AST（`UpsertStatement` のみ・INSERT は 13a 済）＋ON INSERT/ON UPDATE＋scope＋**実行閉 capability で公開経路 fail-closed（API 0）**＋UPSERT SELECT 拒否＋省略規則の spec 正本化 | M | 10d～13c | parse／scope／句順／拒否 matrix green、公開経路 API 0 |
| 14b | UPSERT: create/update 分岐 planner＋混在 preflight（create=Phase13・update=Phase10 の再利用）。**mutation はまだ閉じる** | L | 14a | 分岐 planner／混在 preflight green、write 0 |
| 14c | UPSERT: internal POST→PUT write＋共通部分成功型（branch/chunk/stage）。**公開 execution capability は閉じたまま** | L | 14b | POST→PUT順、POST成功後PUT失敗を型で保持、公開経路API 0 |
| 14d | UPSERT: `execute`／`executeBatch` 開通＋共有confirm detailのinsert/update内訳＋二重guard＋APPLYなしUPSERT非回帰 | M | 14c | 明示capability時だけ開通、confirm前write 0、batch envelope伝播、MCP API 0 |
| 15a | 多値: `ADD`／値`REMOVE` AST/parser＋target tagged union/型×動詞scope。**execution は閉じる** | M | 10d,12,14d | parse曖昧性・5型metadata/scope・拒否matrix、公開write 0 |
| 15b | 多値: 2 payload形の集合planner/validation/converter＋core実行 | L | 15a | 5型payload、choice／空値／required／順序／conflict裁定、複数親preflight |
| 16a | v2 shared detail＋EXPLAIN／VALIDATE ONLY／batch診断契約 | M | 10d～15b | 文種/branch/table/field/chunk/非transaction情報のunit、mutation API 0 |
| 16b | CLI v2統合 | M | 16a | confirm/escaping/100・101/部分成功 e2e、core guard迂回不可 |
| 16c | plugin v2統合 | M | 16a,16b | render unit、plugin build、cancel API 0（実browserは17c） |
| 16d | MCP v2統合 | M | 16a～16c | INSERT/UPSERT含むvalidate/explain成功、全APPLY mutate API 0、schema/smoke green |
| 17a | 全自動回帰・build・smoke | M | 1～16d | npm test、CLI/MCP/MCPB/plugin build、MCP smoke/pack-smoke、tsc baseline |
| 17b | v2実機A: 複数親UPDATE／`_idx`／EXPECT／多値＋100超部分成功 | L | 17a | raw payload/chunk/部分成功/非retry/復旧evidence |
| 17c | v2実機B: INSERT／UPSERT＋CLI／Firefox／Chromium／MCP | L | 17b | POST/PUT分岐、surface表示/cancel、MCP fail-closed、復旧evidence |
| 17d | v3.8.0 release準備 | L | 17c | version/docs/tracker/artifact整合、全build後のrelease checklist |

実装済み順は `1 → … → 9`。§19 のL再検討後は `10a → 10b → 10c → 10d → 11 → 12 → 13a → 13b → 13c → 14a → 14b → 14c → 14d → 15a → 15b → 16a → 16b → 16c → 16d → 17a → 17b → 17c → 17d` とする。§18 の「planning/scope（execution閉）→preflight（mutation閉）→write・部分成功」という安全層は維持し、write と公開伝播が同居した 10c／14c だけを `core write（公開閉）→公開開通` に再分割する。INSERT／多値も同じ syntax→prepared/planner→write 境界へ揃え、surface は shared契約→CLI→plugin→MCP、最終gateは自動回帰→実機A→実機B→release準備の順に直列化する。version bump／release成果物更新は17dまで行わない。

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

### 13.4 R3で追加した齟齬とレビュー判断事項

正本仕様は §9.4 で v2 capabilityを列挙する一方、§12（`docs/internal/ksql_apply_block_spec.md:743-763`）ではそれらを「v3.8.0最終scopeでも対象外」としている。R3は今回のユーザー決定を新しい上位証拠として、§9.4と§5.1の「v2」をv3.8.0内Phase 10～15へ読み替える。実装開始時にspec §9／§11／§12のphase表記・受入条件・対象外を同期し、この計画だけが先行した状態を残さない。

1. **親WHERE 0件**: §14裁定5は明示した単一`$id`消失をfail-closed `ArgumentError` とした。一方、複数親一般WHEREは通常UPDATEの0件successと同型である。R3推奨は「構文的な単一`$id=<n>`は消失errorを維持、その他の一般WHERE 0件は `updatedCount=0` success」。selectorの形で挙動が分かれることを許容するか、APPLY全体を0件success／全体errorへ統一するか。
2. **多値ADD/REMOVEのpayloadと集合意味論**: CHECK_BOX/MULTI_SELECTは `string[]`、USER/ORG/GROUPは `{code:string}[]` を送る。既存順を保持し新規ADDを末尾、重複ADDと不存在REMOVEをno-op、同文同値ADD+REMOVEをconflict `ArgumentError` とする案を推奨する。あるいは冪等性を優先し同文競合もsnapshotから決定的なno-op/後勝ちにするか。後勝ちは§4.1に反するため非推奨。
3. **UPSERT省略時挙動の正本化**: 正本spec §9.4（`docs/internal/ksql_apply_block_spec.md:644-665`）は機能列挙だけで、省略規則はcomparison §7 P2-6（`docs/internal/ksql_b44_c1_c3_comparison.md:199`）にある。R3は `ON INSERT`省略＝新規tableはkintone既定、`ON UPDATE`省略＝既存table保持、両省略＝現行UPSERT同一を採る。実装前にspecへ移して正本化するか。
4. **UPSERT write順と部分成功結果**: 現行validation経路はinsert POST後にupdate PUTを行う（`src/execute.ts:4422-4435`）。R3もPOST→PUTを推奨するが、update修復を優先してPUT→POSTにする選択肢がある。どちらでも非原子的なので、順序、失敗stage、成功済みbranch/chunkを公開resultへ追加することを承認するか。
5. **UPSERT SELECT**: 現行ASTはVALUESの `UpsertStatement` と `UpsertSelectStatement` が別型（`src/types/ast.ts:644-675`）、parserも分岐する（`src/parser/parser.ts:2495-2517`）。R3 Phase 14は依頼のVALUES形だけを対象とし、`UPSERT ... SELECT ... ON INSERT/ON UPDATE APPLY` は明示拒否する案でよいか。
6. **INSERT構文と空APPEND**: INSERT分岐は `APPEND` のみを許可する。APPLY block自体は空禁止なので「テーブルに初期行を作らない」はblock省略で表す。親VALUESが複数行なら同じAPPLY初期行templateを各親へ適用する契約でよいか。
7. **MCP**: §15裁定4をv2にもそのまま適用し、UPDATE／INSERT／UPSERT／多値を含むすべてのAPPLY mutationをv3.8.0でfail-closedとする。別capabilityは今回追加しない。

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

## 16. Claude レビュー（R3 承認・2026-07-20）

**裏取り**: R3 の主要引用をサンプリング検証し全一致。①複数親100件チャンクの前例＝`src/converter/dmlToKintone.ts:117` `chunk(allRecords, 100)`（Phase 10 の converter 設計の土台が実在）②UPSERT の POST→PUT 順＝`src/execute.ts:4428-4433`（inserts を postRecords→updates を putRecords・Phase 14 の順序契約と一致）③`UpsertSelectStatement` は `UpsertStatement` と別型で parser も分岐（ast.ts:663・parser.ts:2496-2517）＝Phase 14 が VALUES 形のみ対象・UPSERT SELECT 明示拒否は妥当④planner が現状 `parentRows: 1` の単数 plan を返す（applyPatchPlanner.ts:366）＝`readonly ApplyPatchPlan[]` への拡張境界が Phase 2 で意図どおり残されている。Phase 10〜17 の分割・複数親の「全件 preflight→immutable plans/batches 完成を write loop の構造 gate」・XL/L/M の規模感は妥当。**指摘なしで承認**。

**§13.4 判断事項の裁定**:

1. **親 WHERE 0件 = 「構文的な単一 `$id=<n>` は消失 error 維持・その他の一般 WHERE 0件は `updatedCount=0` success」を承認**（selector の形で挙動が分かれることを許容）。根拠＝§14 裁定5（単一 `$id` 消失は修復オペの対象消失＝fail-closed）と、複数親一般 WHERE が通常 UPDATE の 0件 success と同型であることは両立する。判定は「WHERE が単一 `$id=<正整数>` の完全一致か否か」という**構文的**基準で分岐でき、実装が明快（scope validator が既にこの形を判別済み）。全体を success/error へ統一する案は、単一 `$id` 修復の安全性か複数親の自然さのどちらかを損なうため不採用。
2. **多値 ADD/REMOVE = 推奨案を承認**（CHECK_BOX/MULTI_SELECT=`string[]`・USER/ORG/GROUP=`{code}[]`・既存順保持で ADD は末尾・重複 ADD/不存在 REMOVE は no-op・**同文の同値 ADD+REMOVE は conflict `ArgumentError`**）。後勝ちは §4.1 スナップショット意味論（先行操作の結果を後続が見ない＝順序依存を排除）に反するため不採用。ADD の選択肢実在検証は P2a の optionOrder を流用・空値は B46 準拠（空を定義外扱いしない）。
3. **UPSERT 省略時挙動 = 推奨を承認し spec へ正本化**（`ON INSERT` 省略=新規 table は kintone 既定・`ON UPDATE` 省略=既存 table 保持・両省略=現行 UPSERT 同一）。comparison §7 P2-6 にしかない規則を Phase 14 実装時に **spec §9 へ移して正本化**する（作業項目に含める）。
4. **UPSERT write 順 = POST→PUT を承認**（既存 UPSERT 経路 execute.ts:4428-4433 と同順で一貫）。非トランザクションのため、**順序・失敗した stage・成功済み branch/chunk を公開 result へ明示**することを承認（部分成功を隠さない）。PUT→POST への変更は既存挙動との不一致を生むため不採用。
5. **UPSERT SELECT = Phase 14 では明示拒否を承認**（VALUES 形のみ対象）。`UPSERT … SELECT … ON INSERT/ON UPDATE APPLY` は AST が別型（UpsertSelectStatement）で source 行数が実行時可変＝初期行 template の親対応が非自明。scope validator で `UnsupportedError`（将来拡張）とし、SELECT 形との組合せは v2 の対象外として spec に明記。
6. **INSERT 構文 = 推奨を承認**（INSERT 分岐は `APPEND` のみ・空ブロック禁止のため「初期行なし」は block 省略で表現・親 VALUES 複数行には同じ APPLY 初期行 template を各親へ適用）。ただし**複数 VALUES 行×固定 template は「全新規親が同一初期テーブル」になる**点を制限として spec に明記（行ごとに異なる初期行が要るなら IMPORT を使う）。
7. **MCP = v2 でも全 APPLY mutation fail-closed 維持を承認**（裁定4 を UPDATE/INSERT/UPSERT/多値すべてへ適用・別 capability は追加しない）。

**spec 同期の必須化（§13.4 冒頭の齟齬）**: 現行 spec §12 が「v2 は v3.8.0 でも対象外」と明記しており本決定と衝突する。**Phase 10 着手前に spec §5.1（`_idx` の「v2」）・§9（段階リリース）・§11.2・§12（対象外）をユーザー決定へ同期**すること（計画だけ先行した状態を残さない）。SemVer は minor 維持で妥当（新規 soft keyword の加法・既存 SQL 意味論不変）。

**総括**: v2 を v3.8.0 へ同梱する Phase 10〜17 構成で**実装着手可**。ただし複数親（Phase 10）は本 B44 全体で最大の correctness surface（部分成功・non-transactional・全件 preflight gate）であり、Phase 10 を単独 gate として厳格にレビューする。実装順は Phase 10（複数親）→11（`_idx`）→12（EXPECT ROWS）→13（INSERT）→14（UPSERT）→15（多値）→16（面統合）→17（統合・実機・release）。Phase 10 の直前に spec 同期を行う。

## 17. XL フェーズ分割（Claude・2026-07-20・ユーザー指摘）→ §18 で 3 分割へ改訂

XL の Phase 10（複数親）・Phase 14（UPSERT）は codex 1ラウンド（実行10分上限）に収まりにくく diff が大きくレビュー粒度が粗くなるため分割する。**当初の 2 分割案は codex レビュー（§18）で不備が判明したため、§18 の 3 分割（10a/10b/10c・14a/14b/14c）を正とする**。以下 2 分割の記述は履歴として残す（正は §18）。

- **Phase 10a（planner array＋scope・L）**: §9.4 作業項目1（scope へ `multipleParents` 追加・`assertSinglePositiveRecordId` を安全な親WHEREへ拡張・取得は `dmlMaxRows+1` で超過検知）＋2（`buildApplyPatchPlans(statement, snapshots) : readonly ApplyPatchPlan[]`・単数 pure 関数は残す・parentId 重複拒否）。**execution・converter は未接続**＝pure planner と scope の unit テストのみ。executor は従来どおり単一親のみ実行し、複数親一致は Phase 10a では `UnsupportedError`（実行 gate は 10b で開通）。
- **Phase 10b（executor＋converter＋chunk・L）**: §9.4 作業項目3（executor を全snapshot GET→全plan→全validation→全guard→1 confirm→write へ）＋4（`applyPatchPlansToKintoneBatches` の100件chunk）＋5（`ApplyConfirmDetail` 複数親集計・非トランザクション/部分成功の result 明示）。**immutable な plans/batches 完成を write loop の構造 gate** とし、preflight 前 putCalls=0・部分成功・conflict 非retry を spy 固定。
- **Phase 14a（parser/AST＋scope・M）**: §9.8 作業項目のうち parser（applyBlocks を InsertStatement／UpsertStatement へ・`ON DUPLICATE` 後に分岐句・UPSERT SELECT は明示拒否）と scope validator（insert 分岐=APPEND のみ・PATCH/REMOVE 禁止／update 分岐=PATCH/APPEND/REMOVE）。**execution 未接続**＝parse・scope・句順・拒否 matrix の unit テストのみ。
- **Phase 14b（executor 分岐・L）**: §9.8 の分岐 planner／executor（create=Phase 13 planner の初期APPEND・update=Phase 10 planner の既存snapshot 操作・POST→PUT 順・部分成功 result）。混在 preflight 全件確定後に write。

依存: 10a→10b→11→12→13→14a→14b→15→16→17。この分割で v2 側も全フェーズが L 以下となり、各 gate を codex 1ラウンド＋Claude レビューで安全に回せる。

## 18. XL フェーズ 3 分割（codex レビュー反映・Claude 承認・2026-07-20）

§17 の 2 分割を codex がレビュー（read-only）し、P1×3 を裏取りで確認した。いずれも実コードの現実で、2 分割では「全フェーズ L 以下」「独立に安全な gate」が成立しない。**3 分割へ改訂する**。

### 裏取りした P1（すべて事実）

1. **10a は planner だけでは完結しない**: `buildApplyPatchPlan` は単一 snapshot 前提で、statement の単一 `$id` を取り出し snapshot ID 一致を強制する（[applyPatchPlanner.ts:87](../../src/core/applyPatchPlanner.ts#L87) `getApplyParentId`・snapshot 照合は executeApplyPatchUpdate execute.ts:5633-5636）。一般 WHERE では primitive 自体が失敗する。GET（`dmlMaxRows+1`）は executor の責務（execute.ts:5622）。→ **10a は「単一 `$id` 依存の解消＋plan array＋scope＋公開経路 API 0 gate」に限定し、GET・0件 selector 挙動は 10b へ移す**。
2. **14a には実行閉 capability gate が必須**: 現行 scope validator は UPDATE の APPLY しか検出しない（[applyPatchScope.ts:22-28](../../src/core/applyPatchScope.ts#L22) `updateWithApply`）。`UpsertStatement` に applyBlocks を足しても router はそのまま `executeUpsert`（[execute.ts:789](../../src/execute.ts#L789)）へ進み、**APPLY を無視して通常 UPSERT を実行する silent bug**になる。→ **14a に「UPSERT APPLY を scope が必ず認識し、公開 execute/batch/VALIDATE ONLY/EXPLAIN を API 0 で fail-close する実行閉 capability」を必須作業として入れる**。parse/scope の unit だけでは着地点にならない。
3. **部分成功は result 型の新設を要し 10b/14b は L を超える**: 現行 `UpdateResult` は `updatedCount` のみで成功済 chunk/失敗 stage を保持できず（[execute.ts:327-346](../../src/execute.ts#L327)）、PUT 失敗はそのまま throw（execute.ts:5749）・batch envelope も通常件数しか伝播しない。→ **write loop＋部分成功 result/error 型＋surface 伝播を 10c/14c へ分離**する。

### 3 分割の定義（各 L 以下）

- **10a（planner array＋scope＋API 0 gate・L）**: 単数 primitive を「snapshot 自身の `$id` を identity とする処理」と「単一 `$id` selector 照合」に分離。`buildApplyPatchPlans(statement, snapshots) : readonly ApplyPatchPlan[]`（pure）。scope へ `multipleParents`。**capability を二軸化**＝「構文/operation を許可する syntax capability」と「実 mutation routing を許可する execution capability」を分け、10a では syntax 許可・execution 閉。完了 gate＝pure planner の unit＋公開 `execute`/`executeBatch` が複数親 APPLY を **API 0 で拒否**するテスト。
- **10b（preflight 準備・mutation 閉・L）**: 複数レコード GET（`dmlMaxRows+1` 超過検知・truncate せず error）＋全親の selector/revision/post-image/guard を最初の write 前に確定し、immutable な prepared batches を返す `prepare()`。**write へは到達しない**構造（`prepare()` 完了前に writer を呼べない・`prepare()` 内で planning/validation を呼ばない、をテストで固定）。
- **10c（write・部分成功・L）**: `applyPatchPlansToKintoneBatches` の100件chunk＋write loop＋**具体的な部分成功 result/error 型**（成功済み chunk 数/親数・失敗 stage を保持）＋CLI/plugin/batch envelope への伝播。2nd chunk conflict で1st の100件が成功済み・retry GET/PUT 0・非トランザクションを spy 固定。
- **14a（UPSERT parser/AST＋scope＋実行閉 gate・M）**: `UpsertStatement` のみに分岐 APPLY を追加（INSERT の applyBlocks は Phase 13 で実施済み＝重複を除く）。`ON DUPLICATE` 後に `ON INSERT`/`ON UPDATE` 分岐句・insert 分岐=APPEND のみ/update 分岐=PATCH/APPEND/REMOVE。UPSERT SELECT は明示拒否。**実行閉 capability で公開経路を API 0 fail-closed**。§9.8 の**省略規則（ON INSERT/ON UPDATE 省略時）を spec §9 へ正本化**（Claude 裁定3）・APPLYなし UPSERT 非回帰もこのフェーズで固定。
- **14b（分岐 planner＋混在 preflight・mutation 閉・L）**: create=Phase 13 の初期 APPEND planner・update=Phase 10 の既存 snapshot planner を再利用し、照合後 candidate を1 record へ合成。混在 preflight を全件確定（write は閉）。
- **14c（POST→PUT 実行＋部分成功・L）**: POST（insert）→PUT（update）順（既存 UPSERT 経路 execute.ts:4428 と一致）・branch/chunk 部分成功・confirm の insert/update 内訳・二重guard。

### 横断設計（3 分割で必須化）

- **capability 二軸**: scope validator の version 集合を「syntax（構文/operation 許可）」と「execution（実 mutation routing 許可）」に分ける。a フェーズは syntax 許可・execution 閉＝解析テストのための解禁が write 経路へ漏れない／公開経路が新 scope を必ず通る、を両立（codex P2-5）。
- **prepared 構造 gate**: `readonly` 型注釈だけでは runtime immutability にならない（codex P3-6）。`prepare(): Promise<PreparedApplyWrite>` → `executePrepared(prepared)` の**関数境界**で「prepare 前は writer 到達不可・executePrepared 内は planning/validation 不可」を構造的に保証しテストする。
- **部分成功の型**: 「部分成功 result」を曖昧に残さず、API 例外時に成功済み件数（chunk/親）と失敗 stage を保持する result/error 型を 10c/14c で定義し、例外型・CLI/plugin 表示・batch envelope の伝播範囲まで明記する。

### Claude 承認

codex の P1×3 は裏取り一致。3 分割＋capability 二軸＋prepared 関数境界＋部分成功型の明示を**承認**。P2-4（14a の INSERT 重複除去・§9.8 の省略規則/guard/confirm/spec 同期/非回帰の明示配分）も反映済み。Phase 13/15 は分割不要（codex P3-9 と一致・L 上限内）。依存順は `10a→10b→10c→11→12→13→14a→14b→14c→15→16→17`。§12 表・実装順を本 §18 に同期済み。**この 3 分割を正とし、§16 の「Phase 10 を単独 gate」記述は §18 で 3 gate へ置換されたものとする**（codex P3-7 の時系列指摘に対応）。

## 19. L フェーズ再検討（codex・2026-07-20）

§18 までを判断履歴として維持した上で、現行 §12 の L フェーズを「独立にテスト可能」「codex 1ラウンド（実行10分・単一diff）」「安全契約をgate途中で開かない」の3条件で再評価した。結論は、**10a／10b／14bは据え置き、10c／13／14c／15／16／17は分割**である。実装済み7／8は現行基準ならL上限超過またはXL近似だったが、事後分割せず証跡だけを残す。

### 19.1 判定一覧と実コード根拠

| 旧Phase | 判定 | 規模・独立gateの根拠 |
|---:|---|---|
| 7 | 事後判定: XL近似（変更なし） | commit `822d978` は16 files、+558/-151。pure plannerだけでなく、scope（[applyPatchScope.ts:10](../../src/core/applyPatchScope.ts#L10)）、planner（[applyPatchPlanner.ts:98](../../src/core/applyPatchPlanner.ts#L98)）、converter（[applyPatchToKintone.ts:17](../../src/converter/applyPatchToKintone.ts#L17)）、executor（[execute.ts:5619](../../src/execute.ts#L5619)）、CLI（[cli/index.ts:613](../../src/cli/index.ts#L613)）まで横断した。単一commitでgreen/evidenceまで完了した事実は維持するが、今の10分基準なら syntax/planner と surface を分ける規模だった。 |
| 8 | 事後判定: L上限超過（変更なし） | commit `fb81257` は21 files、+478/-83。plannerのREMOVE競合（[applyPatchPlanner.ts:263](../../src/core/applyPatchPlanner.ts#L263)）、converterの `FULL_SURVIVORS` 完全性（[applyPatchToKintone.ts:77](../../src/converter/applyPatchToKintone.ts#L77)）、confirm detail（[execute.ts:449](../../src/execute.ts#L449)）、plugin表示（[desktop.ts:2841](../../src/ui/desktop.ts#L2841)）を同時変更した。独立gate自体は成立し実装済みなので変更しない。 |
| 10a | 据え置き L | 単一`$id`結合はscopeの [applyPatchScope.ts:99](../../src/core/applyPatchScope.ts#L99) とplannerのsnapshot照合 [applyPatchPlanner.ts:236](../../src/core/applyPatchPlanner.ts#L236) に局在する。pure array adapter＋二軸capability＋公開API 0でwriteを含まず、独立unit gateになる。 |
| 10b | 据え置き L | 現行単一GET→plan→validationは [execute.ts:5619](../../src/execute.ts#L5619) 以降にまとまる。これを `prepare()` へ抽出し、既存converter/write（[execute.ts:5715](../../src/execute.ts#L5715)）へ到達させないため、複数GET・全件guardを含んでもwrite 0の独立gateが成立する。 |
| 10c | **10c/10dへ分割** | 旧10cはconverter＋write loop＋部分成功型＋CLI/plugin/batch伝播を同居させていた。現行resultは `UpdateResult.updatedCount` だけ（[execute.ts:327](../../src/execute.ts#L327)）、batch envelopeも通常件数だけ（[batchEnvelope.ts:67](../../src/output/batchEnvelope.ts#L67)）、CLIも件数を直接読む（[cli/index.ts:628](../../src/cli/index.ts#L628)）。core write/error型と公開伝播を分けないと単一diffがXL近似になる。 |
| 13 | **13a/13b/13cへ分割** | AST（[ast.ts:618](../../src/types/ast.ts#L618)）＋parser（[parser.ts:2450](../../src/parser/parser.ts#L2450)）＋create planner新設＋100件converter（[dmlToKintone.ts:109](../../src/converter/dmlToKintone.ts#L109)）＋POST loop（[execute.ts:4950](../../src/execute.ts#L4950)）を一度に抱える。またMCP検出はUPDATEだけ（[mcp/tools.ts:499](../../src/mcp/tools.ts#L499)）で、通常INSERT VALUESはconfirm非経由（[execute.ts:472](../../src/execute.ts#L472)）。Phase 16までsurface対応を遅らせたままexecutionを開くgateは安全でない。 |
| 14b | 据え置き L | 既存UPSERTは照合後にcreate/update配列を作る（[execute.ts:5902](../../src/execute.ts#L5902)）。14bはPhase 13/10 plannerを再利用してprepared混在planを返すだけに限定し、POST/PUTを呼ばないため、分岐planner＋全件preflightの独立gateが成立する。 |
| 14c | **14c/14dへ分割** | 現行 `UpsertResult` はinsert/update通常件数だけ（[execute.ts:344](../../src/execute.ts#L344)）。旧14cはPOST→PUT loop、branch/chunk部分成功、confirm内訳、二重guard、公開非回帰を同居させるため、core writeと公開開通を分ける。14c完了時はexecution capabilityを閉じ、14dで初めて `execute`/batchを開ける。 |
| 15 | **15a/15bへ分割** | operation parserは現在PATCH/APPEND/行REMOVEの3分岐（[parser.ts:2727](../../src/parser/parser.ts#L2727)）で、metadata resolverはSUBTABLE限定（[applyPatchPlanner.ts:98](../../src/core/applyPatchPlanner.ts#L98)）。対象はchoice配列2型と主体object配列3型でpayload形が異なる（[dmlToKintone.ts:382](../../src/converter/dmlToKintone.ts#L382)）。AST/parser/型×動詞scopeと、5型の集合planner/validationを分ければ各gateがM/Lに収まる。 |
| 16 | **16a/16b/16c/16dへ分割** | shared detail（[execute.ts:449](../../src/execute.ts#L449)）、CLI formatter（[cli/index.ts:613](../../src/cli/index.ts#L613)）、plugin dialog（[desktop.ts:2841](../../src/ui/desktop.ts#L2841)）、MCP AST検出/fail-close（[mcp/tools.ts:499](../../src/mcp/tools.ts#L499)、[mcp/tools.ts:829](../../src/mcp/tools.ts#L829)）は別のadapter/test/build境界である。3面×全v2 capabilityを1diffにすると独立gateを失うため、shared診断→CLI→plugin→MCPへ分ける。 |
| 17 | **17a/17b/17c/17dへ分割** | automated gateだけでもtest＋4 build＋2 smokeがある（[package.json:22](../../package.json#L22)、[package.json:26](../../package.json#L26)）。さらに100超UPDATE部分成功、INSERT/UPSERT、多値、Firefox/Chromium、fixture復旧、version/manifest（[package.json:3](../../package.json#L3)、[manifest.json:3](../../prod/manifest.json#L3)）を同居させるのはXL。自動回帰、UPDATE系実機、create/upsert＋surface実機、release準備を独立gateにする。 |

### 19.2 新フェーズ定義

1. **10c core write（L）**: prepared batchesだけを入力に100件chunkでPUTし、成功済chunk/親数・失敗stageを持つ共通partial-success result/error型を定義する。公開execution capabilityは閉じたまま、internal testだけで2nd chunk conflictと非retryを固定する。
2. **10d 公開伝播（M）**: `execute`／`executeBatch` の明示capabilityを開き、共通型をbatch envelope／confirm detailへ欠落なく渡す。CLI/plugin固有表示は16b/16c、MCP mutationは閉じたままにする。
3. **13a INSERT syntax＋実行閉（M）**: `InsertStatement.applyBlocks`、APPEND-only parser/scope、APPLYなしINSERT非回帰を実装する。同時にUPDATE専用のMCP検出をstatement-kind共通helperへ置換し、INSERTと後続14aで追加するUPSERT APPLY mutationをASTでfail-closeできる土台を先に完成させる。公開execute/batch/MCPはAPI 0。
4. **13b create prepared（L）**: VALUES各行×固定APPEND templateをcreate candidateへ展開し、既定値、post-image、`dmlMaxRows`／`dmlMaxSubtableRows`を全件確定してprepared POST batchesを返す。POST 0をgateとする。
5. **13c POST write（M）**: 100件POST converter/writeを接続し、10cの共通partial-success型を再利用する。coreの明示capabilityだけ開き、CLI/pluginは16まで閉じる。
6. **14c UPSERT core write（L）**: 14b prepared planをPOST→PUT順で実行し、branch/chunk/stageと成功済み件数を共通型へ記録する。公開executionは閉じたままにする。
7. **14d UPSERT公開開通（M）**: `execute`／`executeBatch`、insert/update confirm内訳、二重guard、batch envelopeを接続し、APPLYなしUPSERT非回帰を固定する。MCPは13aの共通検出によりAPI 0を維持する。
8. **15a 多値syntax/scope（M）**: `ADD`／値`REMOVE` node、行REMOVEとのtoken分岐、SUBTABLE／multi-value target tagged union、5型×動詞拒否matrixを実装する。executionは閉じる。
9. **15b 多値planner/write（L）**: `string[]` 2型と`{code}[]` 3型を分けたpure集合planner、choice/空値/required/conflict検証、複数親prepared payloadを実装しcoreへ接続する。surface独自再集計は入れない。
10. **16a shared診断（M）**: statement kind、branch、table/field別件数、chunk、非transaction、partial-success注意をsingle source of truthとして定義し、EXPLAIN／VALIDATE ONLY／batchへ加法伝播する。
11. **16b CLI（M）**: shared detailだけをformatし、escaping、100/101、cancel、`--yes`でもguard必須をe2e固定する。
12. **16c plugin（M）**: shared detailだけをdialog/renderへ渡し、unit＋plugin build＋cancel API 0をgateとする。Firefox/Chromium実機は17cへ送る。
13. **16d MCP（M）**: 13aの共通AST検出をvalidate/explain/query/mutate/batch全経路でmatrix化し、全APPLY mutation API 0、schema、smokeを固定する。
14. **17a 自動統合（M）**: test/build/tsc baseline/MCP smokeを実行し、v1～v2 acceptance matrixの自動項目を閉じる。
15. **17b 実機A（L）**: 複数親UPDATE 0/2/100/101/200、2nd chunk失敗、`_idx`、EXPECT、多値を専用fixtureで検証し、raw payload・成功ID・復旧diffを証跡化する。
16. **17c 実機B（L）**: INSERT/UPSERT分岐・POST→PUT部分成功とCLI／Firefox／Chromium／MCP fail-closedを検証し、fixture復旧とv2 evidenceを完了する。
17. **17d release準備（L）**: v3.8.0のpackage/lock/manifest、CHANGELOG、README、reference、tutorial、MCP説明、tracker、全artifact/version整合を更新し、release可能状態だけを独立レビューする。

### 19.3 依存順と安全境界

正の実装順は §12 のとおり `10a→10b→10c→10d→11→12→13a→13b→13c→14a→14b→14c→14d→15a→15b→16a→16b→16c→16d→17a→17b→17c→17d`。安全境界は次を不変条件とする。

- syntaxを先に解禁するaフェーズは、公開 `execute`／`executeBatch`／MCP mutationを必ずAPI 0で閉じる。
- preparedフェーズはwriterを引数に取らず、planning/metadata/validation/guard完了後の値だけをwriteフェーズへ渡す。
- core writeフェーズ（10c/14c）はpartial-success型をinternal testできるが、公開execution capabilityは次フェーズまで閉じる。
- CLI/pluginは各surfaceがshared detailを表示できるPhase 16b/16cまで新capabilityを開かない。MCPは全期間fail-closed。
- 実機gateとrelease metadata/artifact更新を同一diffにしない。17b/17cの復旧・evidence完了後だけ17dへ進む。

### 19.4 レビュアー確認事項

1. 10c/14cを「internal core write・公開閉」、10d/14dを「公開開通」と分けることで、§18のcapability二軸とpartial-success型の意図を保てているか。
2. 13aでMCPのUPDATE専用検出をstatement-kind共通helperへ前倒しし、INSERT/UPSERT構文追加時のsilent mutationを防ぐ配分でよいか。
3. 13c/15bのcore capability開通後もCLI/pluginを16b/16cまで閉じる方針を、利用可能surfaceの段階差として許容するか。
4. 実機を17b（UPDATE系＋多値）／17c（INSERT/UPSERT＋surface）へ分け、release準備を17dへ完全分離する粒度で、各10分レビューgateの証跡量が妥当か。

### 19.5 Claude レビュー（§19 承認・2026-07-20）

**裏取り**: codex の主要根拠を検証し一致。特に**13a の安全前倒しは実在ギャップ**＝現行 MCP の APPLY 検出は UPDATE 専用（[mcp/tools.ts:499](../../src/mcp/tools.ts#L499) `statement.type === "UPDATE" && applyBlocks?.length > 0`）で、INSERT/UPSERT に applyBlocks を足す際に検出を statement-kind 共通 helper へ広げないと **MCP 経由で INSERT/UPSERT APPLY が silent mutation する**（§18 の executeUpsert 見落としと同クラス）。ほか、INSERT VALUES の confirm 非経由（execute.ts:472 コメント）・batchEnvelope が `updatedCount` のみ伝播（batchEnvelope.ts:67）＝部分成功型の新設と伝播分離（10d/14d）の必要性も確認。**23 フェーズは細粒度だが、削除・複数親部分成功・silent mutation という本機能の安全リスクに対し「under-split で 10 分予算超過/レビュー不能 diff」を避ける方が価値が高く、各 gate が file:line で独立に裏付けられているため承認**。

**codex の確認事項4件への裁定**:
1. **10c/14c=internal core write（公開閉）・10d/14d=公開開通の分離を承認**。§18 の capability 二軸（execution 閉→開）と partial-success 型の意図を保つ。最もリスクの高い「新 result 型＋chunk 失敗意味論」を core だけで internal テストし、公開 routing は次フェーズまで fail-closed に保てる。
2. **13a の MCP 検出前倒しを承認**（裏取り済＝必須）。INSERT/UPSERT 構文追加と同一フェーズで共通検出 helper を入れ、公開 execute/batch/MCP を API 0 に保つ。
3. **core 開通後も CLI/plugin を 16b/16c まで閉じる段階差を承認**。core 強制ガードは surface に依存しないため、リッチ表示・確認 UI の遅延は安全性を損なわない（17 の実機は 16 の後なので CLI 配線は実機前に完了）。
4. **実機 17b（UPDATE系＋_idx/EXPECT/多値）/17c（INSERT/UPSERT＋surface）と release 17d の完全分離を承認**。release を実機から隔離するのは §18 方針・v3.7.0 の運用実績と一致。

**総括**: L 再検討後のフェーズ構成（v2＝10a〜17d の23分割）で**実装着手可**。実装順 `10a→10b→10c→10d→11→12→13a→13b→13c→14a→14b→14c→14d→15a→15b→16a→16b→16c→16d→17a→17b→17c→17d`。着手前に spec §5.1/§9/§11.2/§12 をユーザー決定（v2 を v3.8.0 同梱）へ同期する（§16 の必須事項）。
