# v3.10.0 B7 + B47 フェーズ分割実装計画

- 作成日: 2026-07-21
- ステータス: **実装前・Claude レビュー依頼用ドラフト**
- 対象ブランチ: `feat/b7-b47-plugin-abort-parent-like`
- 対象リリース: **v3.10.0**
- 実装順: **B7 完了 → B47 着手**（逆転・並行着手しない）
- 正仕様: [B7 R2](ksql_search_abort_warning_issue.md)、[B47 R2](ksql_b47_apply_parent_where_like_spec.md)
- 本書の範囲: 実装・テスト・実機・ビルド・リリース準備の分割計画。**本書作成時点ではコード実装、version/CHANGELOG 更新、成果物生成、git commit を行わない。**

---

## 1. 目的と実装順ゲート

B7 は plugin の `getRecords` だけを raw Fetch に切り替え、既存の `KintoneGetResponse.searchAborted` へ `X-Cybozu-Warning` の検出結果を載せる。B47 はその完全性保証を前提に、APPLY 複数親 UPDATE の親 WHERE に LIKE / NOT LIKE と KLIKE / NOT KLIKE を解禁する。

実装順を次に固定する。

```text
B7-P1 shared leaf
  -> B7-P2 plugin raw fetch
  -> B7-P3 unit 完了 + 通常/guest 実機受入判定
  -> B47 着手可否 gate
  -> B47-P1 shared selection primitive
  -> B47-P2 LIKE residual route
  -> B47-P3 KLIKE + EXPLAIN/diagnostic
  -> B47-P4 全 surface/実機受入
```

B7 の実機受入が通れば B47 に predicate の surface gate を設けず、plugin / CLI と MCP の read-only な VALIDATE ONLY / EXPLAIN で同じ親 WHERE を受理する（MCP mutation 無効は維持する）。ブラウザーでヘッダーが露出しない、または B7 受入が未完了なら、B47-P3 の plugin KLIKE は API 呼び出し前に fail-closed とし、警告付き継続はしない（B7 仕様 `docs/internal/ksql_search_abort_warning_issue.md:113-119`、B47 仕様 `docs/internal/ksql_b47_apply_parent_where_like_spec.md:162-174`）。この依存判定を曖昧な「unit green」だけで通さない。

## 2. 現行コードで確認した事実

行番号は 2026-07-21 の `feat/b7-b47-plugin-abort-parent-like` working tree を基準とする。実装開始時と各レビュー時に `rg -n` で更新する。

### 2.1 B7 の既存伝播契約

- Node はファイルローカルの `SEARCH_ABORTED_HEADER_VALUE` を持ち、`X-Cybozu-Warning` に対して完全一致ではなく `includes` で判定する（`src/cli/nodeKintoneClient.ts:48-53,119-138`）。成功時だけ `searchAborted: true` を response body に合成する（`src/cli/nodeKintoneClient.ts:235-270`）。
- plugin の URL helper は既に `kintone.api.url(path, true)` を使うが、`getRecords` は `kintone.api()` の本文から `{ records }` だけを返す（`src/ui/kintoneClient.ts:26-27,80-105`）。cursor、write、metadata API も同じ `api()` helper を使うため、raw Fetch 化は `getRecords` に限定しなければならない（`src/ui/kintoneClient.ts:107-203`）。
- plugin の `toDetailedApiError` は `message`、kintone `code`、field-level `errors`、HTTP `status` を Error に保持する（`src/ui/kintoneClient.ts:36-77`）。raw Fetch の非 2xx でもこの利用者可視契約を維持する。
- `KintoneGetResponse` には既に `searchAborted?: boolean` があり、core interface の追加変更は不要である（`src/api/fetchAll.ts:26-40`）。
- execute wrapper は `searchAborted` を検出し、SELECT 系なら collector、非 SELECT なら `SearchAbortedError` にする（`src/execute.ts:213-218,665-688,801-817,851-862`）。既存結合テストは SELECT 警告、DML の confirm/PUT/DELETE 0回を固定している（`src/__tests__/searchAbort.execute.test.ts:51-85`）。
- 現行 plugin client test は「本文だけを返し `searchAborted` を推測しない」ことを明示しており、B7-P2 で意図的に反転するテストである（`src/ui/__tests__/kintoneClient.test.ts:6-22`）。Node のヘッダー positive / unrelated warning テストは既にある（`src/cli/__tests__/nodeKintoneClient.test.ts:59-94`）。

### 2.2 B47 の既存親選択と残余評価部品

- APPLY 複数親 UPDATE は、単一の正の `$id` でなければ `executeMultipleParentApplyPreflight` へ入る（`src/execute.ts:6292-6304`）。
- 現行 preflight は `updateToGetQuery(stmt).query` を使い、`dmlMaxRows + 1` を `maxRecords` と `stopAfter` の両方へ設定する（`src/execute.ts:6431-6458`）。これは WHERE が exact pushdown で返却 snapshot=target の現行前提にだけ成立する。
- `updateToGetQuery` は `assertDmlWhereIsSafe` を通すため LIKE / KLIKE を一律拒否する（`src/converter/dmlToKintone.ts:34-46,145-157`）。通常 UPDATE / DELETE の fail-closed はこの checker を維持する必要がある。
- APPLY scope は LIKE を許す一方、KLIKE、subquery、aggregate/window、非決定的 kintone function を拒否する（`src/core/applyPatchScope.ts:238-269,482-514`）。B47 の carve-out は KLIKE だけを専用 route で許可し、他の拒否条件を落としてはならない。現行 scope unit も LIKE 許可と KLIKE 拒否を固定している（`src/core/__tests__/applyPatchScope.test.ts:147-180`）。
- `buildKlikePushdownPlan` は main/join の safe leaves と、そこから収集した `appliedKlikes`、元 WHERE の `allKlikes` を同じ AST から作る（`src/core/optimization/klikePushdownPlan.ts:16-86`）。SELECT FULL_SCAN は同じ plan を validation、fetch、JS evaluation へ渡す（`src/execute.ts:3243-3262,3347-3361`）。
- `evalWhere` は KLIKE node を `appliedKlikes.has(expr)`、すなわち object identity でのみ適用済みと認め、集合外なら throw する（`src/engine/evalWhere.ts:76-110`）。既存 unit は applied/unapplied と fail-closed を固定している（`src/core/optimization/__tests__/klikePushdownPlan.test.ts:12-35`）。
- `flatten(record, null)` は kintone snapshot を evaluator 用 `ProcessRow` に変換する共有 primitive である（`src/engine/process.ts:78-91`）。field type/semantics は form metadata から解決する既存 machinery があり（`src/execute.ts:2025-2072,3154-3203`）、B47 用の文字列化・比較器を新設しない。
- `prepareApplyPatchWrite` は受け取った snapshots 全件を `buildApplyPatchPlans` に渡し、parent count、post-image validation、guard を作る（`src/core/applyPatchPrepare.ts:59-126`）。`buildApplyPatchPlans` も `snapshots.map(...)` で全件を plan 化する（`src/core/applyPatchPlanner.ts:260-276`）。したがって残余評価は prepare より前でなければならない。
- VALIDATE ONLY の件数・guard・diagnostic は prepared target 数から組み立てられる（`src/execute.ts:6460-6470,6528-6562`）。candidate を prepare へ渡さなければ既存出力契約を再利用できる。
- MCP は APPLY の VALIDATE ONLY / EXPLAIN を read-only で許す一方、mutation を拒否する（`src/mcp/index.ts:79-93,143-149`、`scripts/mcp-smoke.mjs:448-470`）。B47 はこの gate を緩和しない。

## 3. フェーズ境界とコミット方針

各フェーズは、単独でレビュー可能・単独で commit 可能・前フェーズまでの tree でテスト可能な最小単位とする。ただし本計画作成では commit しない。B7 と B47 を同じ commit に含めない。各フェーズの commit 候補には、そのフェーズの production change、対応 unit、必要最小限の内部文書だけを含める。

### B7-P1: 検索打ち切り定数/helper の共有 leaf 化

**目的**

Node と plugin が同じ文字列・同じ `includes` 規則を参照できる依存なし leaf を作る。Node の通信・エラー・retry 挙動は変えない。

**変更ファイル（予測位置）**

- 新規 `src/core/searchAbortWarning.ts:1-30`: 定数と pure helper。
- `src/core/index.ts` の export 群付近: 必要なら internal export。ただし UI/CLI が直接 leaf import できるなら public core barrel の拡大は避ける。
- `src/cli/nodeKintoneClient.ts:48,134-138`: ローカル定数と inline `includes` を shared import/helper 呼出しへ置換。
- 新規 `src/core/__tests__/searchAbortWarning.test.ts:1-80`。
- `src/cli/__tests__/nodeKintoneClient.test.ts:59-94`: shared helper 化後の Node 非回帰を維持し、複数警告を含む文字列も追加。

**新規/変更関数**

```ts
export const SEARCH_ABORTED_HEADER_VALUE =
  "Filter aborted because of too many search results";
export function isSearchAbortedWarning(value: string | null | undefined): boolean;
```

helper は `value?.includes(SEARCH_ABORTED_HEADER_VALUE) === true` 相当とし、trim、case-fold、完全一致への変更を行わない。

**不変条件**

- 定数の重複定義を残さない。
- leaf は DOM、Node、kintone、Fetch API に依存しない。
- Node の GET URL、auth、timeout、CB_IL02 retry、error body 契約、`searchAborted` が true の時だけプロパティを追加する挙動は不変（`src/cli/nodeKintoneClient.ts:69-150,235-270`）。
- plugin の挙動はこのフェーズでは変えない。

**修正前 fail → 修正後 pass**

- 前: shared module/export を import する新規 unit は存在せず compile fail。後: exact、複数警告中に既知文言あり、null/undefined/空/別警告の table test が pass。
- 前後 pass の characterization: `src/cli/__tests__/nodeKintoneClient.test.ts` の既知ヘッダー、retry 後ヘッダー、別警告を維持する。

**依存**: なし。

**スコープ外**: plugin raw Fetch、execute/fetchAll の変更、警告文変更、B47。

### B7-P2: plugin `getRecords` の raw Fetch 化と client-level unit

**目的**

`createKintoneClient().getRecords` だけを same-origin raw Fetch にし、成功 response のヘッダーを B7-P1 helper で判定する。その他 API は `kintone.api()` のままにする。

**変更ファイル（予測位置）**

- `src/ui/kintoneClient.ts:26-105`: URL/query、raw GET、success/error body の小さな private helper と `getRecords` の差替え。
- `src/ui/__tests__/kintoneClient.test.ts:1-120`: global `fetch`、`Response.headers`、`kintone.api.url` mock、error matrix。
- `src/__tests__/searchAbort.execute.test.ts:51-85` または同等の plugin-adapter 結合 fixture: plugin response → SELECT warning / DML fail-closed を固定。
- B7-P1 の `src/core/searchAbortWarning.ts` を import。

**新規/変更関数（仮称）**

- `buildRecordsGetUrl(baseUrl, params)` または `appendRecordsGetQuery(url, params)`。
- `readRawFetchError(response)`。JSON error shape を `{ code, id, message, errors, status }` に正規化して `toDetailedApiError` へ渡す。
- `createKintoneClient().getRecords`。

query は `URL` / `URLSearchParams` を使い、`app`、空でも意味を持つ `query`、各 `fields[]` を欠落なく直列化する。base URL は必ず `apiUrl("/k/v1/records.json")`、すなわち `kintone.api.url(path, true)` から得る。Fetch option は `method: "GET"`、`credentials: "include"`、`X-Requested-With: XMLHttpRequest` とする。

**不変条件**

- raw Fetch は `getRecords` のみ。cursor、POST/PUT/DELETE、apps/fields/settings/status は `api()` を継続する（`src/ui/kintoneClient.ts:107-203`）。
- `res.ok === false` は records response として返さず、ヘッダーがあっても `searchAborted` にしない。
- JSON error の `code` / `errors` / `status` を `toDetailedApiError` の既存形式へ渡す。非 JSON、空 body、network rejection も cause/status を可能な限り失わず明示 Error にする。
- success body に既知ヘッダーがある場合だけ `{ records, searchAborted: true }`。それ以外は property 自体を省略する。
- `KintoneGetResponse`、`KintoneClient`、execute wrapper の interface は変更しない。

**修正前 fail → 修正後 pass**

- 前: 現行 test は `getRecords` が `kintone.api()` を呼び、ヘッダー mockを観測できない（`src/ui/__tests__/kintoneClient.test.ts:6-22`）。後: `kintone.api()` 0回、`fetch` 1回、guest-aware URL、GET option、query/fields、既知ヘッダー→`searchAborted:true` が pass。
- fields 2件、fields空、queryの空白/引用符/日本語を table test。URL に既存 query がある場合も壊さない。
- 200 + headerなし／別警告→`{records}`、400 JSON (`code/message/errors`)・非JSON・空body・fetch reject の error contract を pass。
- cursor/write/metadata tests は `kintone.api()` 継続を確認する。
- plugin adapter が返した `searchAborted:true` を execute へ渡し、SELECT は既存 warning、DML は `SearchAbortedError`、confirm/PUT/POST/DELETE 0回を pass。

**依存**: B7-P1。

**スコープ外**: cursor header、write API raw Fetch、retry/分割検索、B47 selection。

### B7-P3: B7 自動回帰と実機受入ゲート

**目的**

B47 KLIKE を plugin へ解禁できるかを、通常 space / guest space のブラウザー挙動で判定する。実機は Claude/ユーザー側で実行する。

**変更ファイル（予測位置）**

- 原則 production code なし。
- 新規 `docs/internal/evidence/b7_plugin_search_abort_smoke.md:1-200`: 環境、URL、件数、query、header可視性、SELECT/DML結果、mutation call数、通常/guest差分を記録。
- 受入結果に応じて B7/B47 spec と `docs/ksql_issue_tracker.md:38-42` の status を後続 release phase で同期する（このフェーズの実機証跡 commit と混ぜるかはレビュー判断）。

**実機 matrix**

1. 通常 space、10万件以上に native `like` / `not like` が hit: SELECT は完了し既存 warningを1回表示。
2. 同条件の read-before-write DML: `SearchAbortedError`、confirm前、write 0件。
3. guest space: `kintone.api.url(path,true)` が guest URL を生成し、cookie認証、GET query、header露出、SELECT/DML結果が通常 space と一致。
4. 打ち切りなし: 従来どおり結果を返す。
5. 権限不足・不正 query: code/detail/status の回帰なし。

**修正前 fail → 修正後 pass**

- 前: plugin は response header を読めず SELECT warningなし／read-before-write DMLを止められない。後: 上記 1～3 が pass。
- 10万件アプリが無い場合: 同一 origin の検証 proxy/ブラウザー mock で header 注入し、準実機として SELECT warning / DML 0-write を pass。ただし「本番 kintone header露出確認済み」とは記録しない。
- 実機も proxy も無い場合: P2 の Fetch `Response` mock + execute integration を代替 gate とし、10万件応答、guest、ブラウザー header exposure が未検証と release note に明記する。この場合、plugin KLIKE 全面解禁は自動承認しない。

**依存**: B7-P2。

**スコープ外**: B47 実装、10万件制限の回避、再試行。

**B47 着手 gate**

- PASS: B47-P1 へ進む。surface gate は追加しない。
- FAIL/未確認: B47 KLIKE の plugin release を停止する。B47-P3 で明示的な plugin fail-closed capability を設計レビューし、Node/CLI側のみへ限定する。既存 `KintoneClient` を破壊的に変更せず、optional capability を追加する場合も「未指定を安全側」にする。実機結果なしに supported と推測しない。

### B47-P1: main-table KLIKE 抽出の共有 primitive 化

**目的**

`buildKlikePushdownPlan` の main-table 抽出と KLIKE node 収集を、SELECT と APPLY parent selection が共有できる primitive に分離する。実行 route はまだ変更しない。

**変更ファイル（予測位置）**

- `src/core/optimization/klikePushdownPlan.ts:16-110`: main-table primitive の抽出、既存 SELECT adapter の再配線。
- 新規候補 `src/core/optimization/applyParentSelectionPlan.ts:1-100`: `ApplyParentSelectionPlan` と単一物理 app 用 factory。循環や重複が生じるなら同じ `klikePushdownPlan.ts` に置く。
- `src/core/optimization/__tests__/klikePushdownPlan.test.ts:1-80`: SELECT 既存 plan の深い非回帰。
- 新規候補 `src/core/optimization/__tests__/applyParentSelectionPlan.test.ts:1-180`: prefilter/applied/unapplied/identity matrix。

**新規/変更関数（採用案）**

```ts
export interface ApplyParentSelectionPlan {
  readonly prefilter: WhereExpr | null;
  readonly appliedKlikes: ReadonlySet<KlikeExpr>;
  readonly unappliedKlikes: readonly KlikeExpr[];
}

export function buildApplyParentSelectionPlan(
  where: WhereExpr,
  metadata: SinglePhysicalTablePushdownMetadata
): ApplyParentSelectionPlan;
```

内部 primitive（仮称 `buildSingleTableKlikePushdownPlan`）が、`extractSafePushdownLeaves` と `collectKlikes` を一度だけ実行する。SELECT の `buildKlikePushdownPlan` は同 primitive を main table に使用し、join 処理と公開戻り値を維持する。APPLY は単一 app、非修飾 field、`allowUnqualifiedFields:true`、実 `fieldTypes` / `fieldOptions`、`allowKlike:true` を渡す。LIKE は `extractSafePushdownLeaves` の safe leaf に含めず残余へ残す（既存 extraction options は `src/core/optimization/wherePredicatePushdown.ts:8-18,88-138`）。

**不変条件**

- `prefilter` の leaf は元 `stmt.where` の node object を再利用する。clone、spreadによる node再生成、serialize/reparseは禁止。
- `appliedKlikes` は prefilter 内 KLIKE と同じ object、`unappliedKlikes` は元 WHERE KLIKE のうち集合外の同じ object。
- OR/NOT subtree の一部を抜かない。
- SELECT の `mainCondition`、`joinConditions`、`appliedKlikes`、`allKlikes` と validation behavior は不変。
- primitive は Fetch、execute、plugin surface に依存しない。

**修正前 fail → 修正後 pass**

- 前: `ApplyParentSelectionPlan` factory は存在せず新規 unit が compile fail。後: safe scalar + KLIKE の prefilter、LIKE-onlyのnull/safe-scalar prefilter、OR/NOT KLIKEのunapplied、複数KLIKE一部unappliedが pass。
- identity positive: `plan.appliedKlikes.has(originalKlikeNode) === true`、prefilter traversalで `=== originalKlikeNode`。
- identity negative: clone を Set に入れた場合 `evalWhere` が既存の押下げ済み集合エラーを throw。
- SELECT characterization: 既存 `src/core/optimization/__tests__/klikePushdownPlan.test.ts:12-57` と SELECT execute suite が前後 pass。

**依存**: B7-P3 PASS（B47 着手 gate）。

**スコープ外**: execute preflight 接続、scope緩和、DML converter変更、EXPLAIN。

### B47-P2: LIKE 親選択 route と candidate→target 完全性

**目的**

APPLY 複数親 UPDATE のうち親 WHERE に LIKE / NOT LIKE を含む route を、exact DML conversion から専用 selection preflight へ切り替える。KLIKE 実行解禁は次フェーズに残す。

**変更ファイル（予測位置）**

- `src/execute.ts:6292-6304,6431-6487`: B47 route 判定、metadata→selection plan→prefilter query→complete fetch→flatten/evalWhere→prepare。
- `src/converter/dmlToKintone.ts:34-46,145-157`: checker 自体は維持。専用 route が `updateToGetQuery` を呼ばないことをコメント/テストで固定し、古い KLIKE 理由文の改稿はP3へ送る。
- `src/core/applyPatchScope.ts:482-514`: LIKE は既に許可済み。専用 route 用の明示的 capability/carve-out 形を導入する場合も KLIKE はまだ許可しない。
- `src/__tests__/applyPatch.execute.test.ts:845-967` 付近: LIKE residual、limit、VALIDATE ONLY、0 target、通常 exact route 非回帰。
- 必要なら新規 `src/core/__tests__/applyParentSelection.test.ts`: flatten/resolver の狭い unit。

**新規/変更関数（仮称）**

- `usesApplyParentResidualSelection(stmt)`：APPLY複数親かつ親 WHERE に LIKE/KLIKE を含むことだけを判定。P2では LIKE route のみ有効。
- `selectApplyParentSnapshots(stmt, client, options, fieldInfos, cacheContext)`：candidate と target の責務を局所化。
- `buildApplyParentFieldResolvers(stmt.appId, fieldInfos)`：`$id` と非修飾親 field を既存 field type/semanticsへ結ぶ。独自 compare semantics は持たない。

**処理順**

```text
getFieldsCached / resolveApplyPatchMetadata / collectApplySnapshotFields
-> buildApplyParentSelectionPlan(original where, real metadata)
-> prefilter == null ? "" : whereToKintone(prefilter)
-> fetchAll(maxRecords=options.maxRecords ?? 10_000,
            onLimit="error", stopAfterなし)
-> candidate snapshots map(snapshot => { snapshot, row: flatten(snapshot, null) })
-> evalWhere(original where, row, fieldTypeResolver,
             appliedKlikes, fieldSemanticsResolver)
-> target snapshots only
-> target数にだけ dmlMaxRows
-> prepareApplyPatchWrite(targets)
-> validation/guards/confirm/write
```

**不変条件**

- LIKE を kintone native `like` として prefilter に入れない。prefilterはtargetの超集合でなければならない。
- candidate は `maxRecords` / `onLimit:error` / no `stopAfter` で短い最終ページまで完全取得する。truncate、`dmlMaxRows+1` 早期停止は禁止。
- `dmlMaxRows` は residual 後の target のみに適用。candidate 101 / target 1 / dmlMaxRows 1 は許可する。
- target だけを `prepareApplyPatchWrite` に渡す。candidate は post-image validation、guard、confirm、diagnostic、PUTへ流さない。
- LIKE/KLIKEを含まない APPLY複数親は現行 `updateToGetQuery` + `dmlMaxRows+1` routeを維持する（`src/execute.ts:6447-6455`）。単一 `$id` routeも維持する（`src/execute.ts:6305-6319`）。
- 通常 UPDATE/DELETE は `assertDmlWhereIsSafe` を継続し、LIKE/KLIKEをAPI 0回で拒否する。
- `flatten(snapshot, null)` と resolver は同じ snapshotを組で保持し、filter後に元 snapshotを返す。flatten後のrowからsnapshotを再構築しない。

**修正前 fail → 修正後 pass**

- 前: APPLY複数親 `タイトル LIKE 'B44%'` は `updateToGetQuery` で拒否。後: 全candidate取得後、一致targetだけprepare/PUT。
- `金額 > 0 AND タイトル LIKE 'B44%'`: 数値safe leafのみprefilter、LIKEはresidual。
- `LIKE OR 金額 > 0`、`NOT LIKE`: partial pushdownせず完全candidateをJS評価。
- contains（wildcardなし）、`%`、`_`、空文字、Unicode、NOT LIKEがSELECT evaluatorと同じ。
- candidate 101/target 1/dmlMaxRows 1はpass、candidate 101/target 2はconfirm/PUT 0回でfail。
- candidate > maxRecordsは`FetchAllLimitError`、confirm/PUT 0回。`onLimitReached:"truncate"`を渡してもB47 routeはerror。
- VALIDATE ONLY はGET/residualを行うがmutation 0回、`validatedRows` / `validRows` / `guards.parentRows` はtarget数。
- exact WHERE routeの既存 query `'... limit 101 offset 0'` fixture（`src/__tests__/applyPatch.execute.test.ts:918-947`）は前後pass。
- 通常 UPDATE/DELETE LIKE/KLIKE、INSERT/UPSERT APPLY、単一 `$id` APPLY、subtable DMLは前後pass。

**依存**: B47-P1。

**スコープ外**: KLIKE scope解禁、surface fallback、EXPLAIN詳細、streaming filter。

### B47-P3: KLIKE 全面接続、fail-closed、EXPLAIN/診断

**目的**

P2 routeへ KLIKE / NOT KLIKE を接続し、applied node証明、unapplied拒否、検索打ち切り、B7依存、静的説明を完成させる。

**変更ファイル（予測位置）**

- `src/core/applyPatchScope.ts:238-269,482-514`: APPLY複数親 B47 routeに限り親 KLIKE拒否をcarve-out。他の禁止nodeは維持。
- `src/execute.ts:6431-6487`: KLIKE route有効化、unapplied API 0拒否、B7 gate結果、search-abort前提、diagnosticへのselection情報伝播。
- `src/converter/dmlToKintone.ts:34-46`: 通常 DML rejection は維持しつつ、「全DMLで検索打ち切りを検出できない」という古い理由文だけ現行事実へ修正。専用 routeはcheckerを広域緩和せず迂回。
- `src/execute.ts:7721-7903,8052-8053,8594-8639`: EXPLAIN analysis / UPDATE APPLY planへ selection plan の静的情報を追加。
- `src/core/optimization/__tests__/applyParentSelectionPlan.test.ts`、`src/core/__tests__/applyPatchScope.test.ts:147-180`、`src/__tests__/applyPatch.execute.test.ts`。
- `src/mcp/index.ts:79-93,143-149` と `scripts/mcp-smoke.mjs:448-470`: mutation無効文言/guardの非回帰。B47で変更不要なら assertion追加だけに留める。

**新規/変更関数**

- P2 `usesApplyParentResidualSelection` を LIKE/KLIKE両方へ拡張。
- `assertApplyParentKlikesFullyApplied(plan)`：`unappliedKlikes.length > 0` を records API 前に専用 errorへ変換。
- `formatApplyParentSelectionPlan(...)` または static diagnostic fields：prefilter、residual、applied/unapplied件数、candidate/target limit、search-abort/B7依存。

**不変条件**

- KLIKE/NOT KLIKE は native `like`/`not like` として prefilterに必ず含まれ、その同じ node objectだけを `appliedKlikes`へ渡す。
- unappliedが1件でもあれば文全体をAPI 0回で拒否。一部だけ適用、warning継続は禁止。
- `evalWhere` は元 WHERE objectを受ける。parseし直さない。
- `searchAborted:true` は既存DML wrapperで `SearchAbortedError`、confirm/PUT 0回。execute wrapperの分岐を複製しない（`src/execute.ts:801-817`）。
- B7-P3 PASSなら surface gateなし。FAIL/未確認なら pluginだけKLIKEをAPI 0回で拒否する明示 capabilityを入れ、未指定を安全側にする。LIKE-onlyはB7に依存しないためP2 routeを維持する。
- EXPLAIN はrecords API 0回で、prefilter（なしを含む）、JS residual、applied/unapplied、`maxRecords/onLimit:error/no stopAfter`、residual後`dmlMaxRows`、B7依存を表示する。
- MCP APPLY mutation拒否は不変。`ksql_query` の VALIDATE ONLY / EXPLAINのみread-onlyで通る。

**修正前 fail → 修正後 pass**

- 前: scopeで親 KLIKEを拒否（`src/core/__tests__/applyPatchScope.test.ts:173-180`）。後: APPLY複数親 routeのみ通り、通常DMLは拒否。
- `説明 KLIKE '至急'` / `NOT KLIKE`: native query、同一node applied、target残余評価pass。
- safe scalar + KLIKE + LIKE: KLIKE/safe scalarでcandidate取得、LIKEでtarget化。
- OR/NOT配下KLIKE、対象親外修飾、未解決値、複数KLIKE一部unapplied: 専用error、records API 0回。
- clone node negative: `evalWhere` throw。identity contractを回帰として固定。
- `searchAborted:true`: `SearchAbortedError`、confirm/PUT 0回。plugin raw Fetch headerでも同じ。
- B7 fallback unit: gate不成立時はpluginだけAPI 0回、Node/CLI相当clientは許可。B7 PASS採用時は不要なruntime surface分岐を残さない。
- EXPLAIN snapshot test、MCP mutation rejection smoke、VALIDATE ONLY read-only smokeをpass。

**依存**: B47-P2、B7-P3の受入結果。

**スコープ外**: OR/NOT KLIKEの集合演算、LIKEとKLIKEの意味論統一、MCP mutation解禁、通常DML解禁。

### B47-P4: 全 surface 自動回帰と実機受入

**目的**

candidate完全性、target件数、VALIDATE ONLY、fail-closedを実環境で確認し、v3.10.0 release-ready判定の証跡を作る。実機はClaude/ユーザー側で実行する。

**変更ファイル（予測位置）**

- 原則 production codeなし。
- 新規 `docs/internal/evidence/b47_apply_parent_like_klike_smoke.md:1-250`。
- 受入後のrelease準備で `docs/ksql_issue_tracker.md:38-42`、README/言語reference、CHANGELOG、version/manifestを同期する。ただし本計画では実装しない。

**実機 matrix**

- LIKE-only: empty prefilter、safe scalar + LIKE、OR、NOT LIKE。SELECTで期待 `$id` を先に確定し、APPLY VALIDATE ONLY/実mutationのtargetと一致させる。
- KLIKE/NOT KLIKE: native queryと残余評価、通常space/guest、検索打ち切りなし/あり。
- candidate≠target: candidateを意図的に複数作り、target 1件だけがvalidation/confirm/PUT対象になることをrevisionと値で確認。
- limits: candidate > dmlMaxRowsだがtarget <= dmlMaxRowsは成功、target > dmlMaxRowsはwrite 0、candidate > maxRecordsはfail-closed。
- VALIDATE ONLY: GETあり、POST/PUT/DELETE 0、件数はtarget。
- unapplied KLIKE: API 0回。Search abort: confirm/write 0。
- Node/CLI/pluginで同じSQLの許可結果。MCPはEXPLAIN/VALIDATE ONLYのみ許可しmutation拒否を維持。

**修正前 fail → 修正後 pass**

- 前: LIKEはconverter、KLIKEはscopeで拒否。後:対象routeのみ期待targetへ適用。
- fail-closed fixtureは「エラーになった」だけでなく、confirm未呼出し、revision不変、mutation API 0回まで記録する。

**依存**: B47-P3。

**スコープ外**: version bump、CHANGELOG確定、release artifact配布、巨大candidate streaming、retry。

## 4. 横断チェックリスト

各フェーズレビューで次を全件確認する。

- [ ] B7完了前にB47へ着手していない。
- [ ] 通常 UPDATE / DELETE は `assertDmlWhereIsSafe` を通り続け、LIKE/KLIKEをAPI 0回で拒否する（`src/converter/dmlToKintone.ts:34-46,145-157,488-500`）。
- [ ] B47 carve-outは `UPDATE + applyBlocksあり + 複数親 + residual route` のみに閉じ、単一`$id`、APPLYなし、DELETE、INSERT/UPSERT、subtable DMLへ漏れない。
- [ ] `ApplyParentSelectionPlan.appliedKlikes` は `Set.has` object identity契約。node clone、spread copy、reparse、value-based再照合をしていない（`src/engine/evalWhere.ts:108-110`）。
- [ ] candidate数とtarget数を別変数・別diagnostic概念で保持。candidateをtarget count、confirm count、guard、validatedRows、PUT countに流していない。
- [ ] candidate fetchは`maxRecords/onLimit:error/no stopAfter`、target guardはresidual後の`dmlMaxRows`。
- [ ] targetだけを`prepareApplyPatchWrite`へ渡し、prepare後filterしていない。
- [ ] KLIKE unappliedは1件でもAPI 0回拒否。検索打ち切りはDML fail-closed。
- [ ] SELECTの`buildKlikePushdownPlan`、FULL_SCAN、LIKE evaluator、Node client、fetchAll、CLI、plugin以外のsurfaceに非回帰。
- [ ] plugin `getRecords`以外は`kintone.api()`のまま。core interfaceを破壊していない。
- [ ] MCP APPLY mutation無効を維持し、VALIDATE ONLY/EXPLAINだけread-onlyで使える。
- [ ] B7/B47ともplugin bundleへ波及するため`prod/js/desktop.js`を再build。B47は`execute.ts`/engine/coreを触るためCLI/MCP bundleも再build。
- [ ] 既知の`desktop.ts`単体tscエラーは本件へ混ぜず、esbuild/npm testの本件差分で判定する。
- [ ] `.claude/settings.json` / `.claude/settings.local.json`等の無関係なlocal差分をcommitへ含めない。

## 5. テスト戦略: unit と実機の分担

| 契約 | unit / mock（Codex側） | 実機（Claude/ユーザー側） | 実機困難時の代替 |
|---|---|---|---|
| B7 header helper | exact/includes/null/別警告 | 不要 | unitで完結 |
| B7 raw GET | fetch URL/options/query/fields/header/error mock | actual same-origin URL/cookie/CORS/header exposure | browser dev proxyで同一origin header注入 |
| B7 10万件 | `Response.headers` + execute integration | 通常/guestの10万件like/not like | mock代替可だが「本番header未確認」を明記しplugin KLIKE release gateを保留 |
| B7 fail-closed | SELECT warning、DML confirm/write 0 | 実mutation対象でrevision不変 | full adapter→execute mock |
| shared primitive | prefilter/applied/unapplied/identity | 不要 | unitで完結 |
| B47 residual | flatten + type/semantics resolver、LIKE matrix、candidate≠target | 実field metadataと実snapshot | form metadata fixture + multi-page fetch mock |
| B47 KLIKE | native query文字列、identity、unapplied API 0 | native検索とtarget一致 | mockはrouting保証のみ。native完全性はB7/実機証跡に依存 |
| limits | multi-page、maxRecords、no stopAfter、target dmlMaxRows | candidate≠targetの代表1件 | 101/1、101/2 fixture |
| VALIDATE ONLY/diagnostic | target件数、mutation 0 | UI表示とtarget件数 | execute result snapshot |
| MCP | unit + `scripts/mcp-smoke.mjs`でmutation拒否 | 必要なら実server smoke | bundled smoke |

unitは「pure primitive」「client adapter」「execute integration」を分ける。fetch mockだけでB7のブラウザーheader露出を証明したことにせず、実機だけでしか証明できない項目を証跡に明記する。

## 6. desktop.js / CLI / MCP ビルド計画

現行`npm run build`はplugin→CLI→MCP→MCPBの順に全bundleを作る（`package.json:25-29`）。plugin buildは`src/ui/desktop.ts`から`prod/js/desktop.js`を生成する（`build.mjs:68-90`）。CLIは`src/cli/index.ts`、MCPは`src/mcp/index.ts`をそれぞれbundleする（`build-cli.mjs:10-26`、`build-mcp.mjs:18-48`）。

| フェーズ | 必須build | 理由 |
|---|---|---|
| B7-P1 | `npm run build:plugin`、`build:cli`、`build:mcp` | shared leafをpluginとNode client（CLI/MCP）がimportするため |
| B7-P2 | `npm run build:plugin`（desktop.js必須）。B7完了時に`npm run build` | UI adapter変更。full buildでCLI/MCP非回帰も閉じる |
| B7-P3 | source変更なしなら再build不要。証跡対象はP2 artifact | 実機gate |
| B47-P1 | `build:plugin`、`build:cli`、`build:mcp` | SELECT共有plannerが全bundleへ入る |
| B47-P2 | `npm run build` | `execute.ts`/core route変更がplugin/CLI/MCPへ波及 |
| B47-P3 | `npm run build` + `npm run mcp:smoke` | execute/EXPLAIN/MCP説明・guardへ波及 |
| B47-P4 | source変更なしならP3 artifactを使用。release候補では再度`npm run build` | 実機/release gate |

`build:plugin`は`KSQL_PLUGIN_ID`または`pluginId.txt`を要求し（`build.mjs:13-23`）、packer/秘密鍵の環境条件もある（`build.mjs:45-60`）。Codex sandboxでplugin packagingや全buildが実行できない場合、可能なunitと個別bundleまでをCodex証跡に残し、`npm run build`、desktop.js生成、plugin pack、実機smokeはClaude/ユーザー側の必須gateとして引き渡す。「sandboxで不可」をbuild成功扱いにしない。

## 7. リスクと未確定事項

### 7.1 B7

1. **ブラウザーへのheader露出**: `Response.headers.get("X-Cybozu-Warning")`で実際に読めるかはrepoから証明不能。CORS exposed headers、same-origin挙動を通常/guest実機で確認する。
2. **認証とguest URL**: `kintone.api.url(path,true)`、`credentials:"include"`、`X-Requested-With`の組合せをunitで形は固定できるが、cookie/guest routingの成否は実機依存。
3. **error contract**: `kintone.api()` rejectとFetch responseはshapeが違う。JSON/非JSON/空/networkを別々に扱い、`toDetailedApiError`へ渡す前の正規化でstatus/causeを落とす危険がある。
4. **global fetch test汚染**: plugin unitでglobalを差し替えるため、afterEachで復元し並列testへ漏らさない。

### 7.2 B47

1. **SELECT非回帰**: main-table primitive抽出でalias/JOIN/CTE/LEFT/RIGHTの条件が変わる危険。既存planの構造とexecute結果をP1単独で固定してからAPPLY接続する。
2. **node identity**: AST cloneを便利な正規化として挟むと`Set.has`が失敗する。型だけで防げないため`===` unitを必須にする。
3. **flatten(snapshot)とresolver**: `flatten(snapshot,null)`は非修飾親rowを作るが、field type/semantics resolverが別appやsubtable childを誤解決しないことを確認する。B47は単一物理親appのみ、`$id`はbuiltin、親fieldは`fieldInfos`由来に限定する。親alias付き参照をparserが受理する場合は、正規化せず明示rejectまたは同一appへ証明可能に解決する。
4. **STATUS/選択肢 semantics**: status orderが必要な比較では`getProcessStatuses`を含む既存resolver相当が必要。form metadataだけで足りると仮定しない（既存 resolver はstatus設定を追加取得する `src/execute.ts:2066-2072`）。
5. **complete fetch**: `fetchAll`へ誤って`stopAfter`やtruncateを渡すとfalse negativeになる。options overrideを許さずB47 routeでerror固定にする。
6. **diagnostic drift**: candidate数を既存`parentRows`へ載せるとVALIDATE ONLY/confirmと不一致になる。必要ならcandidate countはselection専用diagnostic名にし、既存parentRowsはtargetのまま。
7. **B7 fallbackの表現**: B7 PASSならsurface gateを残さない。FAIL時だけoptional capabilityの形を別レビューし、custom `KintoneClient`で安全性が未証明の既定値をsupportedにしない。

## 8. スコープ外とリリース時の後続作業

本実装フェーズのスコープ外:

- APPLYなしの通常UPDATE/DELETEのLIKE/KLIKE解禁。
- INSERT/UPSERT APPLY、親DELETE APPLY、subtable DML、`UPDATE ... FROM`、CTE/temp selector拡張。
- OR/NOT配下KLIKEの集合演算、検索打ち切り回避/再試行、巨大candidate streaming。
- planner/prepare/writeの100件chunk、revision、partial-success、post-image validation契約変更。
- MCP APPLY mutation gate緩和。
- 既存`desktop.ts` tscエラー修正。

B47-P4承認後のrelease専用フェーズでのみ、`package.json` / lockfile、`prod/manifest.json`、README、`docs/ksql_language_reference.md`、必要なMCP description/schema、`CHANGELOG.md`、`docs/ksql_issue_tracker.md`、build成果物をv3.10.0へ同期する。現行versionは3.9.0（`package.json:1-3`）。これらをB7/B47の機能commitへ先行混入させない。

## 9. Claudeレビュー重点項目

1. B7-P2のraw Fetch error正規化が、現行`toDetailedApiError`のcode/errors/status/cause契約を落としていないか。
2. `kintone.api.url(path,true)` + credentials/headerが通常/guestで妥当か、および実機で`X-Cybozu-Warning`が露出するか。
3. shared primitiveが元AST nodeをそのまま返し、SELECTのmain/join/CTE planを変えていないか。
4. B47 routeのcarve-outがAPPLY複数親だけに閉じ、通常DMLの`assertDmlWhereIsSafe`を迂回していないか。
5. prefilterがtargetの超集合か。LIKEをnative pushdownしていないか、OR/NOTの片側を抜いていないか。
6. candidate完全取得後にだけresidualし、targetだけがprepare/dmlMaxRows/VALIDATE ONLY/confirm/diagnostic/PUTへ流れるか。
7. KLIKEのapplied/unappliedと`Set.has` identity、検索打ち切り、B7 fallbackが全surfaceでfail-closedか。
8. MCP mutation無効、desktop.js/CLI/MCP bundle、通常SELECTと既存exact APPLY routeの非回帰証跡が揃っているか。
