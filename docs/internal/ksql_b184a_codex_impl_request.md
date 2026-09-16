# B184-A 実装依頼（codex）— 集計と同じ SELECT でウィンドウ関数を使えるようにする

**`SELECT 会社名, SUM(売上) AS 売上合計, RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位 FROM APP4149 GROUP BY 会社名` のように、GROUP BY / 集計と同じ SELECT にウィンドウ関数を書ける形を通す。[起票文書](ksql_b184_window_in_same_select_issue.md) §3-A と [実装案の検討報告 §5「A. 集計との同一SELECT」](ksql_b181_b184_codex_plan_report.md) の第一案で実装する。B（ウィンドウ結果を式の中で使う・隠し列）は次の PR（B184-B）で、この PR では手を出さない。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b184/dev`・v3.80.0 の HEAD）
上限: 1 PR・3 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文・警告文を新たに発明しない（既存の文言を流用。新しい診断が要る場合は文言案を報告に書き、実装は既存文言で）。**既存の 3 段の書き方（CTE / 一時テーブルで段を分ける）の結果・警告・EXPLAIN の行を変えない。** 公開型（`SelectResult`・`columns`・行キー・`warnings` の形）を変えない。B184-B の範囲（式内ウィンドウ・隠し列・`SelectStatement.hiddenWindows`）に手を出さない。B182 の `src/core/expressionSemantics.ts` の規則を変えない。

## 1. 決まっていること（レビュー対象外）

### 1.1 現状（v3.80.0）

- パーサの門番 `src/parser/parser.ts:1352-1356`（`hasWindow && (groupBy.length > 0 || grouping !== undefined || hasAggregate)` → `ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません`）
- エンジンの評価順は「4. GROUP BY（`applyGroupBy` / `applyGroupingSets`）→ 5. HAVING → 6. ウィンドウ（`applyWindow`・`src/engine/process.ts`）→ 7. DISTINCT → 8. ORDER BY」で、標準 SQL と同じ。`applyWindow` は HAVING 後の行集合（= グループ行）に対して SELECT 列中の `WINDOW_COL` を評価する
- `parseOrderByKey()`（`parser.ts:3752-3762` 付近）は集計を解析後に位置を戻し、集計用の key を作らない。ウィンドウの `ORDER BY SUM(売上)`（集計式直書き）はこの解析で決まる
- 同一 SELECT の集計結果は `applyGroupBy` が `materializedSelectValues`（`byLookupKey`: 合成名 `aggregateSyntheticName()` と別名）に載せている（B182・B187 で一般化）。HAVING はこの `byLookupKey` を評価行へ写して参照する（`havingEvaluationRow`・`process.ts:197`）

### 1.2 直すこと（A の範囲）

- 門番を外し、**ウィンドウの引数・`PARTITION BY`・`ORDER BY` が参照できるものを次に限定**する:
  1. GROUP BY のキー（`PLAIN` grouping の各項目。式キー・関数キーは実体化キーで）
  2. 同一 SELECT の集計の**別名**（`SUM(売上) AS 売上合計` → `ORDER BY 売上合計`）
  3. 集計式そのもの（`ORDER BY SUM(売上) DESC`・`SUM(SUM(売上)) OVER ()` のような引数）。`aggregateSyntheticName()` へ正規化し、SELECT 列に無い集計は B187 と同じ `materializeAggregateDependencies` で**非表示の集計依存**として実体化する（出力列にしない）
  4. `GROUPING(field)`（B65・ROLLUP / GROUPING SETS 併用時）
- グループ化されていない生のフィールドをウィンドウから参照したら、既存の非グループ依存検証（`src/core/aggregateDependencyValidation.ts`・`NON_GROUPED_DEPENDENCY_REASON`）と同じ規則でエラー（文言は既存のものを流用）
- 評価順は現行のまま（GROUP BY → HAVING → ウィンドウ）。ウィンドウはグループ行に対して評価され、`applyWindow` の入力行から集計結果（`byLookupKey`）を読めるようにする（HAVING と同じ `havingEvaluationRow` 相当の評価行）
- 既定 `RANGE` フレームと ORDER BY 一意性の警告（B140-C・`execute.ts:3641-3648` 付近の CTE 経路）: **同一 SELECT のグループキーの組が ORDER BY に含まれるなら入力行を一意と扱う**（新しい規則。起票 §1.1 の訂正どおり、CTE 経路の「証明できない」文言とは別）。含まれなければ従来どおり警告
- 取得フィールド収集（`src/converter/selectToKintone.ts` の window phase）と完全入力判定（`src/core/dmlGuard.ts:181-195` の `completeInputReasons`）: 集計 + ウィンドウの文で `GROUP_BY` / `AGGREGATE` に `WINDOW_ORDER` / `AGGREGATE_WINDOW` が併記されること。取得列はウィンドウが参照する集計の引数（既に集計で取得）を超えて増えない
- EXPLAIN: 既存の行に「集計後にウィンドウを評価」を示す 1 行を**足す**（新しい行を出す形は Claude と相談の上で。まずは `complete input reason:` に `WINDOW_ORDER` / `AGGREGATE_WINDOW` が併記されることで可視化し、追加行は報告に案として書く）。**既存の 3 段の EXPLAIN 行は変えない**

### 1.3 変えないこと

- 既存の 3 段（CTE / 一時テーブル）の結果・警告・EXPLAIN
- 式内ウィンドウ（`ROUND(SUM(x) OVER (), 1)`・`件数 - LAG(件数) OVER (…)`）は従来どおり B129 の診断で拒否（B184-B で扱う）
- `WHERE` / `HAVING` / `JOIN ON` でのウィンドウ参照は従来どおり拒否
- 既存テストで書き換えが要るのは `src/parser/__tests__/window.test.ts` の GROUP BY 併用拒否（`205-211` 付近）だけの想定。B129 診断テスト（`115-143`）・nested VALUE window 拒否（`183-188`）は**そのまま通す**（B184-B の範囲）。ほかに変えざるを得ない既存テストがあれば「意味が変わるか」を報告に書き、意味が変わるなら止めて報告する

## 2. テスト（受入・境界値は桁を変えて両方向）

新規 `src/engine/__tests__/b184aWindowWithAggregate.test.ts`（パーサ側は `src/parser/__tests__/window.test.ts` に追加）に少なくとも次を入れる:

- **1 段版 = 2 段版**: `SELECT 会社名, SUM(売上) AS 売上合計, RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位, SUM(SUM(売上)) OVER () AS 総計, SUM(SUM(売上)) OVER (ORDER BY SUM(売上) DESC, 会社名 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS 累計 FROM APP100 GROUP BY 会社名 ORDER BY 売上合計 DESC, 会社名` が、`WITH base AS (SELECT 会社名, SUM(売上) AS 売上合計 … GROUP BY 会社名) SELECT …, RANK() OVER (ORDER BY 売上合計 DESC) …, SUM(売上合計) OVER () …, SUM(売上合計) OVER (ORDER BY 売上合計 DESC, 会社名 ROWS …) FROM base` と**同じ行・同じ値・同じ列順・同じ `warnings`**。値は `9 / 10`・`99 / 100`・`9,050,000 / 20,700,000` の組で ASC / DESC 両方向、同額 2 社（`RANK` の同順位）を含める
- 参照の 3 形: 集計の別名（`ORDER BY 売上合計`）・集計式直書き（`ORDER BY SUM(売上)`）・グループキー（`PARTITION BY 地域`）。SELECT に無い集計をウィンドウだけが使う形（`RANK() OVER (ORDER BY COUNT(*) DESC)` で SELECT に `COUNT(*)` が無い）
- HAVING 後の行集合でウィンドウが評価される（HAVING で落ちた行が `RANK` / 累計に入らない）
- 未グループ化フィールドの参照は既存の非グループ依存エラー（文言固定）。曖昧な別名も既存規則
- ROLLUP / GROUPING SETS（B65）併用: `GROUPING(field)` を `PARTITION BY` に使う形 1 本
- 既定 `RANGE` 警告: `ORDER BY 売上合計` だけ（グループキーを含まない）では警告あり、`ORDER BY 売上合計, 会社名`（グループキーを含む）では警告なし。同じ入力の 2 段版と警告の有無が一致（2 段版で証明できず警告が出る形は、1 段版でも警告を出す＝厳しくする方向には変えない。緩める方向だけ）
- `completeInputReasons()` に `GROUP_BY` / `AGGREGATE` と `WINDOW_ORDER` / `AGGREGATE_WINDOW` が併記される。取得列（mock の `getRecords` に渡る `fields`）が 2 段版の集計段と同じ
- `DISTINCT`・`LIMIT`・`ORDER BY`（ウィンドウ列の別名で並べる）との組み合わせ
- 式内ウィンドウ・`WHERE` / `HAVING` でのウィンドウは従来どおり拒否（B129 の文言不変）
- 文書の助言をそのまま実行するテスト 1 本（§3 で §10.1 に載せる例）
- `npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §10.1「ウィンドウ関数」の「集計と同じ SELECT では使えない」相当の記述を「v3.81.0 から、GROUP BY / 集計と同じ SELECT にウィンドウ関数を書ける。ウィンドウが参照できるのはグループキー・集計の別名・集計式・`GROUPING()`。評価は GROUP BY → HAVING → ウィンドウの順。ウィンドウの結果を同じ SELECT の式の中で使う形は未対応（段を分ける）」に改める。3 段の書き方は「段ごとに確かめたいときの書き方」として残す
- `docs/ksql_batch_recipes.md` R15（構成比・ABC）・R16（前月比）: 1 段で書ける部分があれば「v3.81.0 から」の注記を足す（式内ウィンドウが要る部分は B184-B まで据え置き）
- 文書の SQL 例は §2 のテストで通したものだけ
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. 門番を外した後、ウィンドウの参照解決をどこで行ったか（パーサ／`aggregateDependencyValidation`／エンジン）と、参照できるもの 4 種それぞれの解決経路（行番号）
2. SELECT に無い集計をウィンドウだけが使う形の実体化（B187 の経路を流用したか）と、出力列に漏れないことの根拠
3. 既定 `RANGE` 警告の新規則（グループキーの組で一意）の実装位置と、2 段版との差（緩める方向だけであること）
4. B184-B（式内ウィンドウ・隠し列）に向けて、今回の変更で B の設計（`hiddenWindows` の別配列・`applyWindow` で評価・`project` / `computeOutputKeys` / column meta / CSV / DISTINCT に渡さない）と衝突する点があるか
5. プラグイン（EXPLAIN エンジン同梱）・MCP・CLI・`/flow` で同じ結果になることの根拠。EXPLAIN の行を足したなら、その行が既存 snapshot に影響しないことの根拠

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記・改めた文を全文）／§4 の 5 項目／Claude が実機（SFA パック・第 3 回の 1 段版・MCP v3.80.0 との比較）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
