# B47 — APPLY 複数親 UPDATE の親 WHERE LIKE / KLIKE 仕様 R2

- 作成日: 2026-07-21
- 改稿日: 2026-07-21
- ステータス: **R2（実装着手可・未実装）**
- 対象リリース: **v3.10.0**
- 対象: B47「APPLY 複数親 UPDATE の WHERE で `LIKE` / `KLIKE` が使えない」
- 必須先行: [B7 プラグイン検索打ち切り検出仕様 R2](ksql_search_abort_warning_issue.md)
- 関連仕様: [B44 APPLY block spec](ksql_apply_block_spec.md)、[LIKE predicate pushdown spec](ksql_like_predicate_pushdown_spec.md)、[B45 subtable system column WHERE plan](ksql_b45_subtable_system_column_where_plan.md)

## 1. 目的と決定

B44 の APPLY 複数親 UPDATE に限り、親 `WHERE` の `LIKE` / `NOT LIKE` と `KLIKE` / `NOT KLIKE` を解禁する。

```sql
UPDATE APP4223
SET 金額 = 1
WHERE 金額 > 0
  AND タイトル LIKE 'B44%'
  AND 説明 KLIKE '至急'
APPLY テーブル (...);
```

R2 の決定は次のとおりである。

1. LIKE と KLIKE を同時対応する。
2. 親候補を安全な prefilter で取得し、元の親 WHERE 全体を `evalWhere` で残余評価する。
3. KLIKE は native `like` / `not like` として必ず prefilter へ適用し、その同一 AST ノードだけを `appliedKlikes` として `evalWhere` へ渡す。
4. 安全に押し下げられない KLIKE が1つでもあれば、文全体を API 呼び出し前に拒否する。
5. candidate は `maxRecords` まで最後まで取得し、残余評価後の target にだけ `dmlMaxRows`、confirm、guard、diagnostic を適用する。
6. B7 完了を v3.10.0 の先行ゲートとし、完了後は CLI / MCP / plugin の面ゲートを設けない。
7. APPLY なしの通常 UPDATE / DELETE の fail-closed は変更しない。

B47 は parser や LIKE evaluator を新設する課題ではない。既存 SELECT の safe pushdown、KLIKE applied-node 証明、JS WHERE 評価を、B44 の「snapshot 取得」と「全 snapshot の plan 化」の間へ接続する課題である。

## 2. 現行コードによる原因確定

### 2.1 converter は親 DML の LIKE / KLIKE を一律拒否する

`assertDmlWhereIsSafe` は KLIKE を先に、LIKE を次に拒否する（[src/converter/dmlToKintone.ts:34-46](../../src/converter/dmlToKintone.ts#L34)）。通常 UPDATE の `updateToGetQuery` はこの checker を通してから親 WHERE 全体を `whereToKintone` へ渡す（[src/converter/dmlToKintone.ts:145-158](../../src/converter/dmlToKintone.ts#L145)）。DELETE も同じ構造である（[src/converter/dmlToKintone.ts:488-500](../../src/converter/dmlToKintone.ts#L488)）。

したがって、LIKE / KLIKE を parser が受理しても通常親 DML には到達しない。現行 KLIKE エラーの「検索打ち切りを検出できないため、全 DML で拒否」という説明は、Node 系の fail-closed 実装後の事実とは一致せず、B47 のカーブアウトと併せて更新対象とする。

### 2.2 B44 複数親は WHERE 全体を push-down し、返った全 snapshot を対象化する

単一の正の `$id` selector でない APPLY UPDATE は `executeMultipleParentApplyPreflight` に分岐する（[src/execute.ts:6292-6304](../../src/execute.ts#L6292)）。現行 preflight は `updateToGetQuery(stmt).query` をそのまま `baseQuery` にし、`dmlMaxRows + 1` 件で早期停止する（[src/execute.ts:6431-6458](../../src/execute.ts#L6431)）。

```text
original parent WHERE
  -> assertDmlWhereIsSafe
  -> whereToKintone(WHERE 全体)
  -> fetchAll(exact target snapshots, stopAfter=dmlMaxRows+1)
  -> prepareApplyPatchWrite
```

`prepareApplyPatchWrite` は入力 snapshot を `buildApplyPatchPlans` へ渡し、その全 plan に post-image validation と guard を適用する（[src/core/applyPatchPrepare.ts:59-77](../../src/core/applyPatchPrepare.ts#L59)、[src/core/applyPatchPrepare.ts:91-126](../../src/core/applyPatchPrepare.ts#L91)）。`buildApplyPatchPlans` 自身も `snapshots.map(...)` で全 snapshot を無条件に plan 化し、親 WHERE を評価しない（[src/core/applyPatchPlanner.ts:260-276](../../src/core/applyPatchPlanner.ts#L260)）。

B47 はこの planner / prepare 契約を変更しない。必ずその手前で target snapshot だけへ絞る。

## 3. 流用する既存評価機構

### 3.1 LIKE は `evalWhere` の既存意味論を使う

`evalWhere` は AST を再帰評価し、`LIKE` / `NOT LIKE` は既存 `matchLike` に到達する。`matchLike` は wildcard なしを contains、`%` と `_` を正規表現へ変換して評価する（[src/engine/evalWhere.ts:75-94](../../src/engine/evalWhere.ts#L75)、[src/engine/evalWhere.ts:410-445](../../src/engine/evalWhere.ts#L410)）。B47 で LIKE を native kintone `like` に読み替えない。SELECT と同じ JS evaluator を使う。

親 snapshot の平坦化には SELECT でも使う `flatten(record, alias)` が既にある（[src/engine/process.ts:78-91](../../src/engine/process.ts#L78)）。APPLY planner 内にも snapshot を `ProcessRow` へ変換する同等処理が存在する（[src/core/applyPatchPlanner.ts:627-633](../../src/core/applyPatchPlanner.ts#L627)）。B47 の親選択は共通 `flatten` と、field metadata に基づく既存 field type / semantics resolver を用い、文字列化や型判定を独自実装しない。

### 3.2 KLIKE は applied-node 証明付きで評価する

`buildKlikePushdownPlan` は safe prefilter 条件と `appliedKlikes` を同じ抽出結果から作り、元 WHERE に含まれる全 KLIKE も収集する（[src/core/optimization/klikePushdownPlan.ts:16-25](../../src/core/optimization/klikePushdownPlan.ts#L16)、[src/core/optimization/klikePushdownPlan.ts:27-82](../../src/core/optimization/klikePushdownPlan.ts#L27)）。`unappliedKlikes(plan)` は元 WHERE にあるが押し下げ済み集合にないノードを返す（[src/core/optimization/klikePushdownPlan.ts:85-86](../../src/core/optimization/klikePushdownPlan.ts#L85)）。

`evalWhere` は KLIKE / NOT KLIKE ノードをローカル検索しない。渡された `appliedKlikes` が同じ object identity のノードを含む場合だけ true とし、含まなければ throw する（[src/engine/evalWhere.ts:101-117](../../src/engine/evalWhere.ts#L101)）。SELECT 実行も同じ pushdown plan を fetch と残余評価へ共有している（[src/execute.ts:3243-3248](../../src/execute.ts#L3243)、[src/execute.ts:3355-3363](../../src/execute.ts#L3355)）。

この設計により、native query が既に KLIKE を満たした候補だけを返した事実を、残余評価で再利用できる。KLIKE の JS evaluator は追加しない。

### 3.3 safe leaf 抽出の境界

`extractSafePushdownLeaves` は AND の安全 leaf だけを抽出し、OR / NOT / NULL_CHECK / EXISTS を subtree ごと除外する（[src/core/optimization/wherePredicatePushdown.ts:27-39](../../src/core/optimization/wherePredicatePushdown.ts#L27)、[src/core/optimization/wherePredicatePushdown.ts:63-88](../../src/core/optimization/wherePredicatePushdown.ts#L63)）。KLIKE / NOT KLIKE は `allowKlike !== false`、対象 field、文字列値という条件で safe leaf になり得る（[src/core/optimization/wherePredicatePushdown.ts:91-112](../../src/core/optimization/wherePredicatePushdown.ts#L91)）。

B47 では単一親テーブル、非修飾親 field、実 field metadata を前提に `allowKlike: true` を明示する。LIKE は safe leaf に含めず JS 残余評価へ残す。

## 4. 対象範囲

対象は次の条件をすべて満たす文だけである。

```text
UPDATE <physical app>
SET ...
WHERE <parent predicate containing LIKE and/or KLIKE>
APPLY ...
```

- `stmt.type === "UPDATE"`
- `stmt.applyBlocks.length > 0`
- `isSinglePositiveRecordIdWhere(stmt.where) === false`
- B44 の `executeMultipleParentApplyPreflight` に入る

対象外は次のとおりである。

- APPLY なしの通常親 UPDATE / DELETE
- 単一 `$id` APPLY
- INSERT APPLY / UPSERT APPLY
- 親 DELETE APPLY
- サブテーブル DML の WHERE
- `UPDATE ... FROM`、相関更新、CTE / 一時表を親 selector にする拡張

## 5. 設計

### 5.1 専用 parent selection plan

APPLY 複数親 preflight に、元 WHERE から次を一度に作る専用 plan を導入する。

```ts
interface ApplyParentSelectionPlan {
  readonly prefilter: WhereExpr | null;
  readonly appliedKlikes: ReadonlySet<KlikeExpr>;
  readonly unappliedKlikes: readonly KlikeExpr[];
}
```

この plan は `buildKlikePushdownPlan` と同じ抽出処理を共有する。実装は、既存関数へ単一物理 app の SELECT-compatible view を渡すか、既存関数の main-table 部分を共通 primitive に抽出して SELECT と B47 の両方から呼ぶ。抽出ロジックや KLIKE 収集を B47 用に複製してはならない。

最重要不変条件は、`prefilter` に含めた KLIKE leaf と `appliedKlikes` の要素が、元 `stmt.where` 内の**同一 AST node object**であることである。leaf の clone、再parse、値だけを使ったノード再生成は禁止する。`evalWhere` の `Set.has(expr)` が object identity を検査するためである（[src/engine/evalWhere.ts:108-110](../../src/engine/evalWhere.ts#L108)）。

### 5.2 親選択の繋ぎ替え（LIKE / KLIKE 共通の本体）

現行の `updateToGetQuery(stmt).query -> fetchAll -> prepareApplyPatchWrite` を、APPLY 複数親の LIKE / KLIKE 経路だけ次へ置き換える。

```text
1. field metadata / semantics を解決
2. selectionPlan = shared KLIKE + safe-pushdown planner(original WHERE)
3. unappliedKlikes が非空なら文全体を拒否（records API 0回）
4. prefilter を whereToKintone で query 化（null なら空 query）
5. candidate snapshots を maxRecords / onLimit:error で最後まで取得
6. candidate を flatten(snapshot, null)
7. evalWhere(original WHERE, row, fieldTypeResolver,
             selectionPlan.appliedKlikes, fieldSemanticsResolver)
8. true の snapshot だけを targets とする
9. prepareApplyPatchWrite(snapshots=targets)
10. confirm -> PUT chunks
```

`buildApplyPatchPlans` の「渡された全 snapshot を無条件 plan 化する」性質は崩さない。残余評価は `prepareApplyPatchWrite` より必ず前に完了し、target だけを渡す。prepare 後に除外すると、post-image validation、guard、confirm、diagnostic、PUT records が false positive を含むため禁止する。

LIKE だけの WHERE でも同じ経路を使う。KLIKE がなければ `appliedKlikes` は空集合でよい。LIKE/KLIKE を含まない既存 APPLY 複数親文は、現行 exact pushdown と `dmlMaxRows + 1` 早期停止を維持し、性能回帰を避ける。

### 5.3 完全性、`maxRecords`、`dmlMaxRows`

現行 preflight は exact query の返却件数を対象件数として扱えるため、`dmlMaxRows + 1` を `maxRecords` と `stopAfter` に設定している（[src/execute.ts:6438-6458](../../src/execute.ts#L6438)）。B47 の prefilter は LIKE 等の false positive を含む超集合なので、この早期停止を使えない。

B47 経路の取得契約を次に固定する。

1. candidate は `options.maxRecords ?? 10_000` を上限にする。`fetchAll` 自体の default も 10,000 である（[src/api/fetchAll.ts:46-60](../../src/api/fetchAll.ts#L46)、[src/api/fetchAll.ts:79-92](../../src/api/fetchAll.ts#L79)）。
2. `onLimit: "error"` とし、`stopAfter` を設定せず、短い最終ページまで取得する。
3. candidate が上限を超える、または完全取得できない場合は confirm / PUT 前に fail-closed とする。truncate は禁止する。
4. 元 WHERE の JS 残余評価後に確定した `targets.length` にだけ `dmlMaxRows` を適用する。
5. confirm count、`guards.parentRows`、VALIDATE ONLY の `validatedRows` / `validRows`、diagnostic の親件数には target 数だけを流す。
6. candidate 数を対象数として扱わない。candidate 101件、target 1件、`dmlMaxRows=1` は許可される。

KLIKE は native query に適用されるため、返却 candidate が native 適用集合として完全であることが必要である。検索打ち切り時は既存 DML wrapper の `failClosed=true` により `SearchAbortedError` を throw し、書き込み0件で閉じる（[src/execute.ts:801-817](../../src/execute.ts#L801)。単文の文種別切替は [src/execute.ts:665-688](../../src/execute.ts#L665)、バッチは [src/execute.ts:1376-1390](../../src/execute.ts#L1376)）。

### 5.4 KLIKE 全面解禁と B7 依存

R2 は KLIKE / NOT KLIKE を対応対象とする。根拠は次の組合せである。

- `buildKlikePushdownPlan` が native query 条件と `appliedKlikes` を同じ抽出から生成する。
- `unappliedKlikes` が安全に押し下げられない KLIKE を列挙できる。
- `evalWhere` が applied-node identity を確認し、押し下げ済み KLIKE を true として残余 WHERE を評価する。
- DML の検索打ち切りは既に fail-closed である。
- B7 により plugin `getRecords` も `searchAborted` を返せる。

v3.10.0 の実装順は **B7 → B47** とし、B7 の受入完了後は CLI / MCP / plugin に面ゲートを設けない。同じ SQL を全 surface で受理する。

ただし依存のフォールバック条件を実装仕様として残す。B7 が未達、または plugin 実機で `X-Cybozu-Warning` が露出せず検索打ち切りを検出できない場合、plugin の KLIKE / NOT KLIKE を実行継続してはならない。その場合だけ plugin は API 呼び出し前に fail-closed で拒否し、B47 KLIKE は Node / CLI / MCP 限定とする。B7 完了を前提とする v3.10.0 正式リリースでは、この fallback は発火しないことが期待値である。

#### unapplied KLIKE の拒否

`selectionPlan.unappliedKlikes.length > 0` なら、文全体を records API 前に拒否する。代表例は OR / NOT 配下の KLIKE、対象親以外の修飾、未解決値などである。OR / NOT の片側だけを押し下げてはいけない。

エラーメッセージは blanket rejection ではなく、安全に押せない KLIKE に限定する。

```text
APPLY 複数親 UPDATE の親 WHERE に、安全に押し下げられない KLIKE / NOT KLIKE があります。
OR / NOT 配下など native query へ完全に適用できない KLIKE は使用できません。
WHERE を AND の安全な KLIKE 条件へ書き換えるか、SELECT で確認した $id IN (...) を使用してください。
```

### 5.5 scope checker / converter のカーブアウト

LIKE / KLIKE の許可は APPLY 複数親 preflight 専用である。

- 通常 `updateToGetQuery` / `deleteToGetQuery` は現行 `assertDmlWhereIsSafe` を通し、LIKE / KLIKE を拒否し続ける。
- APPLY 複数親 B47 経路は、通常 converter を一律緩和せず、専用 parent selection planner から prefilter query を作る。
- `assertSafeParentWhere` の KLIKE 拒否は、B47 専用経路で selection plan と `unappliedKlikes` 検査が成立した場合だけカーブアウトする。`assertSafeParentPredicateNode` の他の拒否条件は維持する（[src/core/applyPatchScope.ts:482-514](../../src/core/applyPatchScope.ts#L482)）。
- `dmlToKintone.ts` の LIKE / KLIKE 拒否も B47 専用経路だけ迂回し、通常 DML の checker 自体を削除・広域緩和しない。
- `prepareApplyPatchWrite` は選択責務を持たず、filter 済み snapshot だけを受け取る。

通常親 UPDATE / DELETE の「WHERE 全体を exact push-down できない文は拒否する」という fail-closed 契約は不変である。

## 6. 正しさの不変条件

### 6.1 LIKE は prefilter の超集合性で守る

元 WHERE を `W`、safe prefilter を `P` とすると、LIKE を含む親選択は次を満たさなければならない。

```text
{ snapshot | evalWhere(W) = true }
  subset-of
{ snapshot | kintone query(P) returns snapshot }
```

LIKE 自体を kintone native `like` として prefilter に使わない。kSQL LIKE と native KLIKE は別意味論であり、native LIKE を近似として使うと真の target を落とし得る。safe leaf がなければ `P = null`、すなわち空 query で全 candidate を取得する。

### 6.2 KLIKE は native 適用集合の完全性で守る

KLIKE ノード `K` は次の全条件を満たす場合だけ許可する。

1. `K` が safe prefilter に含まれる。
2. `K` と同一 object identity が `appliedKlikes` に含まれる。
3. native query の全ページを取得する。
4. `searchAborted` を全 surface で検出し、DML が fail-closed になる。
5. `unappliedKlikes` が空である。

`evalWhere` が `K` を true とするのは、candidate が native query により既に `K` を満たしたためである。`appliedKlikes` を field / pattern の値一致で再構築してはならない。

### 6.3 禁止事項

- LIKE を native `like` / `not like` として押し下げる。
- OR / NOT subtree の一部だけを抜き出す。
- `unappliedKlikes` を警告だけで無視して実行する。
- candidate を truncate し、その prefix だけを target 候補にする。
- `dmlMaxRows + 1` で candidate 取得を早期停止する。
- candidate 数を target 数として guard、confirm、VALIDATE ONLY、diagnostic へ流す。
- `prepareApplyPatchWrite` 後に残余評価する。
- KLIKE node を clone / reparse して `appliedKlikes` へ入れる。
- B7 未達の plugin で KLIKE を警告付き実行する。

### 6.4 preflight と write の順序

次を最初の PUT より前に完了する。

```text
complete candidate fetch
-> search-abort / maxRecords check
-> original WHERE residual evaluation
-> target dmlMaxRows check
-> all target post-image validation
-> all guards
-> confirm
-> PUT chunks
```

prepared records の100件 chunk、revision 指定、後続 chunk 失敗時の partial-success は既存契約を維持する。B47 は親選択までの preflight だけを変更する。

## 7. EXPLAIN / 診断 / エラー

EXPLAIN は records API を呼ばず、少なくとも次を表示できるようにする。

- parent selection: safe prefilter + JS residual evaluation
- kintone prefilter（なければ `(なし)`）
- applied KLIKE 件数
- unapplied KLIKE がある場合の unsupported 理由
- candidate limit: `maxRecords`, `onLimit=error`, no `stopAfter`
- target guard: residual evaluation 後に `dmlMaxRows`
- search abort: DML fail-closed、plugin は B7 依存

実行時の `FetchAllLimitError`、`SearchAbortedError`、post-image validation error、confirm cancel は最初の PUT 前に伝播する。KLIKE の blanket rejection 文は削除し、§5.4 の unapplied KLIKE 専用メッセージに置き換える。通常 DML の LIKE / KLIKE エラーは維持するが、検索打ち切りに関する古い事実説明は現行契約に合わせて改稿する。

## 8. テスト観点

### 8.1 route / boundary

- APPLY 複数親 LIKE / KLIKE は専用 parent selection preflight に入る。
- LIKE/KLIKE を含まない APPLY 複数親は現行 exact pushdown と `dmlMaxRows+1` 早期停止を維持する。
- 通常 UPDATE / DELETE の LIKE / KLIKE は従来どおり API 0回で拒否する。
- INSERT / UPSERT APPLY、単一 `$id` APPLY、subtable DML は非回帰。
- `assertSafeParentWhere` と `assertDmlWhereIsSafe` のカーブアウトが B47 route 外へ漏れない。

### 8.2 LIKE parent selection

- `タイトル LIKE 'B44%'`: 空 prefilter から全 candidate を取得し、一致 parent だけを prepare / PUT。
- `金額 > 0 AND タイトル LIKE 'B44%'`: safe 数値 leaf だけを押し下げ、元 WHERE 全体で残余評価。
- `タイトル LIKE 'B44%' OR 金額 > 0`: OR の片側を押し下げず、超集合を完全取得して評価。
- `NOT (タイトル LIKE 'B44%')`: NOT subtree を押し下げず正しく評価。
- wildcard なし contains、`%`、`_`、空文字、Unicode、NOT LIKE が SELECT と同じ結果。
- prefilter false positive が prepare、confirm、diagnostic、PUT records に混入しない。

### 8.3 KLIKE parent selection / node identity

- `説明 KLIKE '至急'`: native `like` query に入り、同一 node が `appliedKlikes` に含まれ、残余評価が成功する。
- `説明 NOT KLIKE '至急'`: native `not like` query と applied-node 証明が成立する。
- `金額 > 0 AND 説明 KLIKE '至急' AND タイトル LIKE 'B44%'`: native KLIKE + safe leaf の candidate を、LIKE 残余で target 化する。
- OR / NOT 配下 KLIKE は `unappliedKlikes` 非空となり、records API 0回で専用エラー。
- applied node を clone した負例で `evalWhere` が throw し、identity 契約を固定する。
- 複数 KLIKE の一部だけ applied なら文全体を拒否する。
- Node / CLI / MCP / plugin で同じ許可結果。B7 fallback 条件の unit test では plugin だけ API 0回で fail-closed。

### 8.4 limits / fail-closed

- candidate 101件、target 1件、`dmlMaxRows=1`: 許可し、confirm count は1。
- candidate 101件、target 2件、`dmlMaxRows=1`: PUT 0回で拒否。
- candidate が `maxRecords` を超える: `FetchAllLimitError`、confirm / PUT 0回。
- KLIKE response が `searchAborted:true`: `SearchAbortedError`、confirm / PUT 0回。
- plugin raw Fetch の警告ヘッダーでも同じ DML fail-closed。
- candidate 数が VALIDATE ONLY / guard / diagnostic の対象件数へ流れない。

### 8.5 VALIDATE ONLY / EXPLAIN / write

- VALIDATE ONLY は candidate GET と残余評価を行うが mutation API は0回。
- `validatedRows`、`validRows`、`guards.parentRows` は target 数。
- EXPLAIN は API 0回で prefilter、residual、KLIKE applied/unapplied、limit policy、B7 依存を表示。
- target 0件は PUT 0回、confirm / diagnostic の親件数0。
- 101 target は100 + 1 chunk。後続失敗の既存 partial-success detail は不変。
- revision conflict で再取得・WHERE 再評価・自動 retry をしない。

## 9. SemVer / リリース

B47 は安全上拒否していた APPLY 複数親 UPDATE の受理範囲を広げる利用者可視の機能追加であり **minor** とする。B7 も plugin に新しい警告／fail-closed 契機を加える minor 改善であるため、両方を **v3.10.0** に同梱する。現行 package version は `3.9.0`（[package.json:1-3](../../package.json#L1)）。

リリース順序は次である。

1. B7 を実装し、plugin raw Fetch の unit と通常 / guest 実機ゲートを確認する。
2. B47 の LIKE / KLIKE parent selection を実装する。
3. 通常 DML fail-closed 非回帰、unapplied KLIKE 拒否、全 surface を検証する。
4. v3.10.0 として同梱する。

B7 が受入未完了なら、plugin KLIKE の全面解禁を release-ready と判定しない。

## 10. スコープ外

- APPLY なしの UPDATE / DELETE における LIKE / KLIKE 解禁。
- kSQL LIKE と kintone native KLIKE の意味論統一。
- LIKE / KLIKE evaluator 自体の意味論変更。
- OR / NOT 配下 KLIKE の分解・集合演算による高度な pushdown。
- INSERT / UPSERT APPLY のキー探索変更。
- 親 DELETE APPLY、`UPDATE ... FROM`、相関更新、CTE / 一時表 selector。
- `maxRecords` を超える巨大 candidate 集合の streaming filter / cursor 化。
- B44 の chunk、revision、partial-success、post-image validation 契約の変更。
- MCP APPLY mutation gate 自体の緩和。
