# v3.6.0 Phase 5 実装計画（B39 サブテーブル）

- 作成日: 2026-07-19
- 対象: `feat/b39-import-subtable` の未コミット基盤から Phase 5 完了まで
- 分担/cadence: **Codex=実装・テスト、Claude=各サブフェーズのコードレビュー、dev=実機 smoke**。各サブフェーズを `実装 → Claude review → 指摘修正 → dev smoke → main merge` の独立 gate とする
- 上位計画: [ksql_v3_6_0_implementation_plan.md](ksql_v3_6_0_implementation_plan.md)
- 確定仕様: [IMPORT v2 R1](ksql_import_v2_spec.md)・[cli-kintone 互換 R2](ksql_import_cli_kintone_compat_spec.md)
- 前提: Phase 1〜4 は main merge・cli-kintone round-trip 実証済み。本文は Phase 5 だけを分解し、実装中は版数を変更しない

## 1. 結論とサブフェーズ境界

現在の安全な基盤を **5A として先に main へ merge することを推奨する**。理由は、実行入口が subtable target を明示的に `UnsupportedError` へ落としており（[execute.ts:4779-4790](../../src/execute.ts#L4779)）、gate も `enableImport` の省略/falseで閉じる（[execute.ts:388](../../src/execute.ts#L388)）ため、既存挙動と既存 mutation を変えずに parser/materializer/index/payload の契約を短いレビュー単位で固定できるからである。長寿命ブランチ上で read-only 基盤と破壊的差分処理を混在させるリスクも避けられる。

ただし 5A merge の条件は、`.claude/settings.local.json` を除外し、subtable IMPORT が gate ON でも mutation/実データ validationへ到達しないことをテストで固定し、既存 Phase 1〜4 の IMPORT 非回帰を確認することとする。5A は「機能提供」ではなく fail-closed な内部基盤の merge であり、公開版数・CHANGELOGの完成扱い・gate既定値は変更しない。

| Subphase | 主成果 | 性質 | 依存 | 工数目安 |
|---|---|---|---|---:|
| 5A | AST/parser、二層 materialization、scoped index、型付き再帰 payload、mutation遮断 | read-only基盤 | Phase 1〜4 | 2〜4人日（現差分の整理・review修正込み） |
| 5B | child検証、実データ `VALIDATE ONLY`、4層 `#err`、親単位隔離、REJECT LIMIT、実行時EXPLAIN | read-only・非破壊 | 5A | 5〜8人日 |
| 5C | JSON nested INSERT/UPSERT、IDなし全置換PUT、IMPORT専用confirm detail | 書込みあり。UPSERTの `[]` は削除を含む | 5B | 5〜8人日 |
| 5D | CSV `*` 行ID差分、`REPLACE SUBTABLES`、削除監査・警告、全surface | **最も破壊的** | 5C | 7〜11人日 |

JSON と CSV は同じ「全置換」でも行ID意味論が異なる。JSON は `_rid` を拒否して全子行を新採番し、CSV は既存IDを更新、空/未知IDを追加、入力に欠落した既存IDを削除する。このため 5C と5Dを統合しない。read-only の5Bを先に完成させ、削除差分を扱う5Dを最後に隔離する。

## 2. 現ブランチのコード事実

### 完成している基盤

- AST は `ImportTarget` をトップレベル `FIELD` と `SUBTABLE` に分け、child列と任意 `rowIdSourceHeader`、文側に `replaceSubtables` を保持する（[ast.ts:715-750](../../src/types/ast.ts#L715)）。
- parser は subtable target、`ROW ID SOURCE`、`REPLACE SUBTABLES` を読み、JSONでのrow ID/REPLACE拒否、CSVでのROW IDとREPLACE必須、宣言外table拒否を構文時に行う（[parser.ts:480-516](../../src/parser/parser.ts#L480)・[parser.ts:600-628](../../src/parser/parser.ts#L600)）。
- `MaterializedImportRecords` は親の `top`、table別child rows、replacement table集合を二層で保持し、childには論理行番号・CSV物理source行・任意row IDを保持する（[types.ts:38-58](../../src/import/types.ts#L38)）。JSON nested array とCSV marker/継続行 grouping は別入口でこの形へ落ちる（[importRecordsMaterializer.ts:15-60](../../src/import/importRecordsMaterializer.ts#L15)・[importRecordsMaterializer.ts:65-110](../../src/import/importRecordsMaterializer.ts#L65)）。
- form index はraw propertiesの `SUBTABLE` を走査し、table codeからchild propertyへscopedに到達できる（[formFieldInfo.ts:28-43](../../src/core/formFieldInfo.ts#L28)）。既存のflattenされたtop-level writable判定へchildを誤投入しない土台である。
- payload builder は親フィールドと `{ table: { value: [{ id?, value: childRecord }] } }` を再帰型で作り、既存subtable DMLのcastを流用しない（[subtablePayload.ts:4-39](../../src/import/subtablePayload.ts#L4)）。
- EXPLAIN は静的なtarget/source/replacement policyを表示できるが、実データ差分はまだ計算しない（[execute.ts:6590-6654](../../src/execute.ts#L6590)）。

### 未完成であり5Aでは接続しないもの

- 実行入口はsubtable targetを専用preflight/confirm未実装として拒否する（[execute.ts:4786-4790](../../src/execute.ts#L4786)）。したがってchild型/必須/既定/NUMBER検証、`#err`、親隔離、REJECT LIMIT、実mutationはいずれも未接続である。
- 現行confirm契約は基本的に `(count, operation, context?)` であり（[execute.ts:350-378](../../src/execute.ts#L350)）、table別add/update/deleteや削除警告を表せない。CLIも一般DML確認経路（[cli/index.ts:1172](../../src/cli/index.ts#L1172)）、MCPも `confirmText: "yes"` と件数guard中心（[schemas.ts:88-89](../../src/mcp/schemas.ts#L88)・[tools.ts:763](../../src/mcp/tools.ts#L763)）である。
- 既存REJECT LIMITはflatな `invalidRows` を数える（[execute.ts:4167-4173](../../src/execute.ts#L4167)）。Phase 5ではinvalid child数ではなくinvalid親数へ定義を切り替える必要がある。

## 3. 共通設計規則

1. `MaterializedImportRecords` は既存flat `MaterializedTable` 経路へunionで流さず、Phase 5専用 preflight/validation/replacement planを通す。
2. error単位は親である。top-levelまたはいずれかのchildがinvalidなら、その親のtop/全table/削除をすべてmutation候補から外す。API batchで親recordを分割しない。
3. 位置情報は `$err_row`（親論理行）、`$err_field`、`$err_subtable`、`$err_subrow`、`$err_source_row` を持つ。後3列はPhase 5 IMPORTだけの拡張とし、既存DMLの固定schemaを変更しない。JSONではsource rowが表現できない場合null、CSVでは物理行番号を必ず入れる。
4. `REJECT LIMIT n` はinvalid親数を数える。同一親に複数child errorがあっても1件であり、超過時は親を一件も書かない。
5. 静的EXPLAINはsource/target/policy/capability、実行時EXPLAINまたはVALIDATEはparent/table別件数と監査を表示する。静的値を実データ確認済みのように見せない。
6. feature gateは全surfaceで既定OFF。各subphaseのmain merge後もgate OFFなら既存SQL・既存IMPORTの挙動を変えない。

## 4. Subphase 5A — fail-closed 基盤を先行merge

### Deliverable・依存・破壊性

- deliverable: 現差分のAST/parser、JSON/CSV二層materializer、scoped form index、型付きpayload builder、静的EXPLAIN、明示Unsupportedをレビュー可能な一組に整える。
- 依存: main上のPhase 1〜4。後続5B〜5Dすべての依存元。
- 破壊性: **なし**。POST/PUT/DELETEへ接続しない。
- 工数: 2〜4人日。既実装分の精査、テスト穴、命名/型修正、review対応を含む。

### 触るファイル/関数

- `src/types/ast.ts` `ImportTarget`/`ImportStatement`（[ast.ts:715-750](../../src/types/ast.ts#L715)）。
- `src/parser/parser.ts` `parseImport`（[parser.ts:480-648](../../src/parser/parser.ts#L480)）と `src/parser/__tests__/import.test.ts`。
- `src/import/types.ts`、`importRecordsMaterializer.ts`、`subtablePayload.ts` と各unit test。
- `src/core/formFieldInfo.ts` のscoped index（[formFieldInfo.ts:28-43](../../src/core/formFieldInfo.ts#L28)）とtest。
- `src/execute.ts` のsubtable Unsupported/静的EXPLAIN（[execute.ts:4779-4790](../../src/execute.ts#L4779)・[execute.ts:6590-6654](../../src/execute.ts#L6590)）。

### テスト・dev smoke

- parser: FIELD/SUBTABLE混在、複数table、重複child/table、ROW ID/REPLACEのJSON/CSV排他、従来flat IMPORT非回帰。
- materializer: JSON欠落対空配列、複数table、CSV marker/継続、同一物理行の複数table、空table、source行追跡。payloadはid有無と複数table型を固定する。
- execution: gate OFF、gate ON subtable mutation、VALIDATE ONLYのいずれもwrite API 0で明示Unsupported。静的EXPLAINだけ成功する。
- dev smoke: **書込みなし**。CLIでgate OFF拒否、開発gate ONの静的EXPLAIN、subtable IMPORT/VALIDATEがfail-closedでAPI 0を確認する。5Aは実データmutation smokeを行わない。

## 5. Subphase 5B — read-only実データpreflightと親単位validation

### Deliverable・依存・破壊性

- deliverable: childの型/必須/既定/NUMBER検証、destination所属/書込み可否、4層error、親単位隔離、親単位REJECT LIMIT、`VALIDATE ONLY`の実データpreflight、実行時EXPLAIN detail。
- 依存: 5A。Phase 1〜4のsource loader、JSON presence/number lexeme、CSV変換、form metadata、validation primitiveを再利用する。
- 破壊性: **なし**。VALIDATE ONLY/EXPLAINだけを開通し、通常mutationは引き続きUnsupported。
- 工数: 5〜8人日。

### 触るファイル/関数

- 新規候補 `src/import/importRecordValidation.ts`: scoped child propertyから型変換、必須、既定、NUMBER precision、unknown/所属違いを検証し、親ごとのcandidate/errorを返す。
- 新規候補 `src/import/importErrors.ts`: Phase 5専用error schemaと `$err_subtable/$err_subrow/$err_source_row` materialization。
- `src/execute.ts` `executeImport`（[execute.ts:4779](../../src/execute.ts#L4779)）からsubtable専用 `prepareImportRecords` を呼び、VALIDATE/EXPLAINだけ返す。既存flat validation preparation（[execute.ts:4145-4185](../../src/execute.ts#L4145)）のprimitiveは共有してもflat行数集計は流用しない。
- `src/core/batch.ts`: 拡張error tableのschema/依存。`src/output/batchEnvelope.ts`、CLI/MCP/plugin result rendererへread-only detailを追加。
- `src/core/dmlValidation.ts`、`src/core/formFieldInfo.ts`: primitive共有に必要な最小抽出だけを行う。

### テスト・dev smoke

- child型別: SINGLE_LINE_TEXT、NUMBER（精度/整数桁/元字句）、選択肢、複数値、USER系、null/欠落/空、必須、既定。所属違い・未知child・SUBTABLE内SUBTABLE/FILE等の非対応はwrite 0。
- 4層位置: JSONの親/child、CSV marker/物理継続行、同一親複数error。`#err` schemaはPhase 5だけ拡張し既存B12/B34を非回帰。
- 親隔離: 一つのchild errorで親topと全tableをinvalidにする。他親はVALIDATE結果上validだが5Bでは書かない。REJECT LIMIT 0/境界/超過をinvalid親数で検証。
- dev smoke: APP4221の既存recordは使わず、専用または新規親に対応するfixtureをread-onlyで投入する。正常/child必須/NUMBER/複数table/CSV物理行のVALIDATE ONLYと実行時EXPLAINを確認し、write API 0を証跡化する。

## 6. Subphase 5C — JSON nested INSERT/UPSERT

### Deliverable・依存・破壊性

- deliverable: JSON nested INSERT、業務キーUPSERTの既存親照合、subtable key存在時のIDなし全置換PUT、欠落table維持、`[]` 全削除、IMPORT専用confirm detail/result、各surfaceのJSON policy表示。
- 依存: 5Bのvalidated parent candidates/error/件数、既存UPSERT照合read、5A payload builder。
- 破壊性: **書込みあり**。INSERTは追加中心だが、UPSERTで明示 `[]` または置換配列が既存子行を削除し得るため、安全gateを適用する。CSV row ID差分は含めない。
- 工数: 5〜8人日。

### 触るファイル/関数

- 新規候補 `src/import/jsonSubtableWritePlan.ts`: `_rid`/`id`未知key拒否、親INSERT/UPDATE分類、table presence、既存/input/delete件数を計画する。
- `src/execute.ts` `executeImport` と `ExecuteOptions.confirm` context（[execute.ts:350-378](../../src/execute.ts#L350)）へ後方互換な `ImportConfirmDetail` を追加。親単位でPOST/PUT batchを作る。
- `src/import/subtablePayload.ts`: validated値だけを受け、JSONではchild `id` を絶対に出さない契約を型/testで固定する。
- CLI `confirmDmlInConsole`（[cli/index.ts:1172](../../src/cli/index.ts#L1172)）、MCP schema/tools、plugin `confirmDialog`（[desktop.ts:2805](../../src/ui/desktop.ts#L2805)）へparent/table別existing/input/add/deleteと「JSONは全行再採番」を表示する。

### 安全gate・テスト・dev smoke

- mutation完成条件は、事前に全親をvalidationし、confirmへ `parentsToWrite` とtable別 `existingRows/inputRows/addRows/deleteRows` を渡し、delete>0を最上位警告に出すこと。内訳を表示・承認できないsurfaceはJSON mutationをUnsupportedにし、VALIDATE ONLY/EXPLAINだけ許す。
- `_rid`拒否、欠落維持、空配列全削除、複数tableの一部だけ置換、INSERT新規採番、UPSERT親一致/不一致/source重複、親隔離、confirm拒否、dmlMaxRows、revision/API errorを検証する。
- dev smokeは**必ず新規親をINSERTしてから**実施する。nested INSERT → row数確認 → UPSERTで配列置換/欠落維持/`[]`削除 → 即時に新規親を削除して復元完了を確認する。APP4221の既存record、とくにminLength違反を抱えるrecordは使わない。

## 7. Subphase 5D — CSV `*` 行ID全置換と破壊的削除

### Deliverable・依存・破壊性

- deliverable: cli-kintone CSV marker grouping、親record-number照合、table別row ID照合、既存ID更新、空/未知ID追加、入力欠落ID削除、複数table差分、`REPLACE SUBTABLES`強制、rowId監査、専用confirm/EXPLAIN、CLI/MCP/plugin detail完成。
- 依存: 5Cで確定した親write/confirm surface、5B validation、Phase 4 record-number lookup。
- 破壊性: **最大**。既存子行IDの欠落を削除として扱う。Phase 5最後のsubphaseとする。
- 工数: 7〜11人日。

### 触るファイル/関数

- 新規候補 `src/import/subtableReplacementPlan.ts`: bulk親read、所有関係index、table別 `{update, add, delete}` と監査を作る。
- `src/import/importRecordsMaterializer.ts` CSV入口（[importRecordsMaterializer.ts:65-110](../../src/import/importRecordsMaterializer.ts#L65)）: grouping/schema errorとrow-level errorの境界を確定する。
- `src/import/recordNumberUpdate.ts`: Phase 4の親照合primitiveを共有。ただしCSV subtableをflat UPDATE経路へ委譲しない。
- `src/execute.ts`: 全親preflight後にconfirm、親単位PUT、REJECT LIMIT、result detail。CLI/MCP/plugin/engine各面は同一detail型を消費する。
- parserの `REPLACE SUBTABLES`/ROW ID必須契約（[parser.ts:617-628](../../src/parser/parser.ts#L617)）を実行preflightでも防御的に再確認する。

### 必須監査と安全gate

- `rowIdNotFound`: source IDが対象親・対象tableに存在しない。仕様どおりIDなし追加へ降格する場合も件数とsource位置を監査表示する。
- `rowIdOwnedElsewhere`: IDが別親または別tableに属する。黙って追加へ降格せず親errorとして隔離し、mutation対象外にする。
- source内の同一table row ID重複はglobal preflight errorとし、read後であってもwrite 0。親record-number重複も従来どおりglobal error。
- **`REPLACE SUBTABLES` 必須、confirmでtable別削除件数明示、内訳表示不能面fail-closed** を5D完成条件とする。警告最上位に「サブテーブル全置換・N行削除」を表示し、delete 0でも置換対象tableを表示する。

### テスト・dev smoke

- marker先頭/継続、複数table同一物理行、空table、親値継続行、row ID空/既存/未知/重複/別親/別table、未列挙table維持、入力欠落削除、全削除、複数親の一部invalidを網羅する。
- replacement planの件数と実PUT payload、confirm/result/EXPLAINの件数を同じfixtureで照合する。confirm非対応/拒否、REJECT LIMIT超過、revision conflictはPUT/POST 0または未実行親を明確に返す。
- dev smokeは**必ず新規親をINSERTして専用fixture化**し、既存ID更新→空ID追加→未知ID監査付き追加→欠落ID削除→空table全削除を順に確認する。各操作前にVALIDATE ONLYとconfirm内訳を保存し、操作後ただちに親record自体を削除して復元を確認する。既存APP4221 record（minLength違反を含む）は一切使わない。

## 8. 各subphase共通gate・非回帰・merge

各subphaseは次をすべて満たしてからmainへmergeする。

1. 対象unit/integration、既存全test、typecheck/buildを実装時にgreenにする。本計画作成時は実行しない。
2. gate OFF既定で、既存SQL、Phase 1〜4 IMPORT、CLI/MCP/plugin公開挙動が不変であることをテストする。
3. Claudeがcurrent patchをコード裏取りでreviewし、重大/中程度指摘を解消する。
4. dev smoke証跡にSQL、fixture、対象親ID、preflight/confirm/result、API後状態、復元結果を残す。
5. `.claude/settings.json` と `.claude/settings.local.json` をcommit/PRから除外する。
6. versionは3.5.0のまま、manifest/release artifactもbumpしない。feature gateはCLI/MCP/plugin/engineでOFF既定を維持する。

5A〜5Dを一つの長寿命branchに積まず、subphaseごとに前subphase merge済みmainから短命feature branchを作る。5A merge後に現在branchをそのまま5Bへ延命する必要はない。

## 9. Phase 5完了とv3.6.0リリース

Phase 5完了は5DのClaude review・dev smoke・main mergeまでであり、その後にだけv3.6.0 release作業へ移る。

- 全Phase 1〜5のfeature gateをリリース既定ONへ変更し、OFF時非回帰も残す。
- `package.json`、lock、`prod/manifest.json`、release filesを3.6.0へ揃える。
- CHANGELOGのPhase 1〜5を確定し、JSON新採番とCSV ID維持/欠落削除、REPLACE/confirm安全条件、添付非対応を明記する。
- 全test/build、CLI/MCP/plugin/browser smoke、artifact内manifest/version/hashを検証する。
- Phase 5途中の各main mergeでは版数bump、release artifact更新、公開gate ONを行わない。

## 10. 5B着手の具体手順

1. 5AのClaude review指摘を解消し、fail-closed/API 0、gate OFF、既存Phase 1〜4非回帰を確認してmainへmergeする。
2. mainから `feat/b39-import-subtable-validation` を作る。
3. `MaterializedImportRecords` から親単位の `PreparedImportParent` と位置付き `ImportValidationError` を返す型を先に定義する。
4. raw scoped form indexを使うchild所属/型/必須/既定/NUMBER検証を、JSON fixtureから実装する。次にCSVの物理source行を接続する。
5. invalid childを親全体のinvalidへ畳み、REJECT LIMITをinvalid親数で判定する。ここまでmutation関数は呼ばない。
6. Phase 5専用 `#err` schemaをbatchに接続し、既存error table schemaを非回帰testで固定する。
7. `VALIDATE ONLY` と実行時EXPLAINへparent/table/error detailを接続する。通常IMPORTは引き続きUnsupportedにする。
8. 対象test→全test→build/typecheck→Claude review→修正→dev read-only smoke→main mergeの順でgateを閉じる。

## 11. Claudeが計画でレビューすべき点

1. 5Aを単独main mergeしても、gate ON/OFF双方でsubtable mutationが絶対に到達不能か。
2. 5Bのerror schemaと親単位隔離がv2 R1/互換 R2に一致し、REJECT LIMITをchild error数で数えていないか。
3. JSONの「ID拒否・全子行再採番」とCSVの「ID維持・欠落削除」が5C/5Dで混線していないか。
4. 5Cの `[]` 削除を非破壊と誤分類せず、confirm detail/fail-closed完成条件を適用しているか。
5. 5Dで `REPLACE SUBTABLES`、削除件数、`rowIdNotFound`、`rowIdOwnedElsewhere`、別親所有、source重複がwrite前に確定するか。
6. CLI/MCP/pluginのいずれかが内訳を表示できないまま `--yes`/`confirmText: yes` だけで破壊的mutationを通さないか。
7. smokeが新規親だけを使い、APP4221の既存minLength違反recordを避け、操作直後の復元証跡まで完成条件にしているか。
8. 各subphaseのgate OFF、版数据え置き、main merge、最終v3.6.0 releaseの境界が曖昧でないか。
