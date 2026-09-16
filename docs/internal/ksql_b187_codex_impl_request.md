# B187 実装依頼（codex）

**`HAVING` に SELECT 列に無い集計を書いた形（`SELECT 商談フェーズ, COUNT(*) AS n … GROUP BY 商談フェーズ HAVING SUM(売上) > 1000000`）が 0 行 + 警告になるのを、標準 SQL と同じ意味で評価するように直す。[起票文書](ksql_b187_having_aggregate_not_in_select_silent_empty_issue.md) の案 A（HAVING 専用の集計を SELECT 列と同じ実体化経路で計算し、出力には載せない）で実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b187/dev`・v3.79.0 の HEAD）
上限: 1 PR・2 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文・警告文を新たに発明しない。**結果列名・行キー・`warnings` の形・EXPLAIN の行を変えない**（HAVING の集計は出力列にしない）。**kintone API の回数を増やさない**（HAVING の集計引数は既に `collectRequiredFieldsByTable` の `having` phase で取得列に入っている＝`src/converter/selectToKintone.ts:812`・B181 レビューで確認）。B184（ウィンドウ）・B186〜B189 の範囲には手を出さない。

## 1. 決まっていること（レビュー対象外）

### 1.1 現象と原因（実測 v3.79.0・dev profile・SFA パック）

- `SELECT 商談フェーズ, COUNT(*) AS n FROM APP4149 GROUP BY 商談フェーズ HAVING SUM(売上) > 1000000` → **0 行**。`warnings` に「比較条件で参照した集計値を確認できません。SELECT リストに同じ集計式を含めてください。」（`UNRESOLVED_AGGREGATE_COMPARISON_WARNING`・`src/engine/process.ts:99`）。SELECT に `SUM(売上) AS s` を足すと 3 行
- 原因: `applyGroupBy`（`process.ts:451-`）が `materializeAggregateColumns`（`613-692`）で **SELECT 列に含まれる集計だけ**を `materializedSelectValues` の `byLookupKey`（合成名 `aggregateSyntheticName`）へ実体化する。HAVING は `applyHaving`（`1018-1034`）→ `havingEvaluationRow`（`197`）で `byLookupKey` を評価行へ写してから `evalWhere` に渡すので、SELECT に無い集計は合成名が row に無く `evalWhere.ts:354` の `resolveFieldRef(row, 合成名)` が空文字を返し、比較が偽になる
- 言語リファレンス §9 の契約文「直接記述した集計関数は、同じ集計が SELECT 列にも存在する場合に限り評価できます。SELECT にない集計を HAVING 専用で追加計算はしません」がこの挙動を明文化している（v3.16.0 の記述）

### 1.2 直し方（案 A）

- `applyGroupBy` に HAVING 式（`WhereExpr | null`）を任意引数で渡し、各グループの `materializeAggregateColumns` の直後に **`materializeAggregateDependencies(outRow, groupRows, having, resolveAggSortKind, evaluationContext)`**（`713-736`・B182 で一般化済み）を呼ぶ。同関数は `collectAggregateRefs` で `AGG_REF` を集め、合成名が未実体化のものだけ `evalAggregate` して `byLookupKey` に入れるので、SELECT に同じ集計がある既存の形は何も変わらない（`getMaterializedLookupValue` の early continue）
- `applyGroupingSets`（`526-`・B65 ROLLUP / GROUPING SETS）も同じ扱い（各 grouping set 行の実体化直後）
- 呼び出し側 `process.ts:2355`（`runFullScan` の 4. GROUP BY）で `stmt.having` を渡す。`applyGroupBy` の既存の直接呼び出し（`src/engine/__tests__/statisticalAggregates.test.ts` など 3 引数）は任意引数なのでそのまま通る
- HAVING 内の集計の位置は `AGG_REF` 単体・`AGG_ARITH`（`SUM(a) - SUM(b) > 0`）・`CASE` 引数（B120）・文字列関数引数のすべて（`collectAggregateRefs` が再帰で拾う。拾えない位置があれば報告）
- `warnOnUnresolvedAggregateComparisons`（`170-194`）はそのまま残す。この形では合成名が row に載るので警告は出なくなる。残る形（本当に解決できないもの）があれば報告に列挙
- **GROUP BY なし・SELECT に集計が無い・HAVING だけに集計がある形**（`SELECT 'x' AS k FROM APP100 HAVING SUM(売上) > 0`）は、現状パーサ／`hasAggregateColumns` のゲート（`2354`）でどう扱われているかを確認し、通るなら単一グループとして同じ実体化に乗せ、拒否されるなら従来どおりの拒否のまま（挙動を変えない）。報告に書く
- B65 の非グループ依存検証（`src/core/aggregateDependencyValidation.ts:303-`・HAVING の `walkDependency`）と `groupingValidation.ts:206-212` は変更しない（HAVING の集計引数は既に許可されている前提。落ちる形があれば報告）

### 1.3 変えないこと

- 出力列・行キー・`warnings` の形・EXPLAIN の行（`reason:` を含む）・取得列
- SELECT に同じ集計がある既存の形の結果と実体化順序
- 既存テスト b119〜b122・b182・b65・statisticalAggregates はそのまま通す。変えざるを得ない場合は「意味が変わるか」を報告に書き、意味が変わるなら止めて報告する

## 2. テスト（受入・境界値は桁を変えて両方向）

新規 `src/engine/__tests__/b187HavingOnlyAggregate.test.ts` に少なくとも次を入れる（mock client・既存の b182 テストの流儀）:

- §1.1 の形が、SELECT に `SUM(x) AS s` を足した形と**同じ行集合**（列は `商談フェーズ, n` だけ）。閾値は `9 / 10`・`99 / 100`・`9,050,000 / 20,700,000` のように桁が変わる組で `>` と `<` の両方向
- HAVING の集計が複数（`HAVING SUM(a) > 1 AND COUNT(b) < 5`）・算術（`SUM(a) - SUM(b) > 0`）・`CASE` 引数・文字列関数引数
- GROUP BY なし（単一グループ）で SELECT に別の集計がある形（`SELECT COUNT(*) AS n FROM APP100 HAVING SUM(x) > 9`）
- 0 行入力・LEFT JOIN の不一致側（`SUM` が `''` になるグループ）・CTE 経由・一時テーブル経由・ROLLUP（B65）
- `UNRESOLVED_AGGREGATE_COMPARISON_WARNING` が §1.1 の形で出なくなる。SELECT に同じ集計がある既存の形は結果・`warnings` とも不変（回帰）
- 出力列に HAVING の集計が漏れない（`columns` と行キーが従来どおり）
- 取得列が増えない（mock の `getRecords` に渡る `fields` が従来と同じ）
- 文書の助言をそのまま実行するテスト 1 本（§3 で §9 に載せる例）
- `npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §9 の契約文を書き換える: 「HAVING に直接書いた集計は、SELECT 列に無くても評価されます（v3.80.0〜。以前は SELECT に同じ集計がある場合に限り評価され、無いと 0 行 + 警告になった）。HAVING の集計は出力列にはなりません」。実行済みの例を 1 つ載せる
- 同 §22「制限事項」に該当項目があれば整合。§9 の「v3.16.0 以降の `CASE` 式引数も同じ規則で…」は現行の規則に合わせて直す
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. `applyGroupBy` / `applyGroupingSets` 以外に集計を実体化する経路があるか（例: B182 の `ARITH_COL`・`CASE_COL`、DISTINCT 経路、`/flow` の `executeStatement`）と、HAVING がそれぞれ同じ実体化を通るか
2. `warnOnUnresolvedAggregateComparisons` が修正後も警告を出す形の一覧（あれば）
3. GROUP BY なし・SELECT 無集計・HAVING だけ集計の形の現状と修正後の扱い
4. EXPLAIN の `reason:` 行と取得列が不変であることの根拠（テスト名）
5. MCP・CLI・プラグイン・`/flow` で同じ結果になることの根拠

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（書き換えた文を全文）／§4 の 5 項目／Claude が実機（SFA パック・MCP v3.79.0 との比較）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
