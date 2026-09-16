# B191 式の中のウィンドウ（隠しウィンドウ）の `PARTITION BY GROUPING(...)` が「internal error: GROUPING() reference was not resolved during B65 planning.」で落ちる

- 状態: ✅ **v3.84.0 でリリース（2026-09-16）**。Claude が直接修正・テスト追加（codex 未介在・小規模のため）。`src/core/groupingValidation.ts` の `validateGroupingStatic` / `validateGroupingPlanning` が `stmt.columns` だけを歩いていたのを `hiddenWindows` も含めるように変更（3 か所）。テスト 2 本を `b184bWindowInExpression.test.ts` に追加。起票時の実測 v3.83.0（MCP・dev profile・SFA パック APP4149）。バグ（B184-B の取りこぼし・内部エラーで落ちる・静かに間違わない・規模 S）

## 1. 現象

`GROUP BY ROLLUP` と同じ SELECT で、ウィンドウの `PARTITION BY` に `GROUPING(会社名)` を書く形。

| 形 | 結果 |
| :--- | :--- |
| `RANK() OVER (PARTITION BY GROUPING(会社名) ORDER BY SUM(売上) DESC) AS 順位`（列として出す） | 通る（v3.81.0〜） |
| `SUM(SUM(売上)) OVER (PARTITION BY GROUPING(会社名)) AS 総計`（列として出す） | 通る |
| `ROUND(SUM(売上) * 100.0 / SUM(SUM(売上)) OVER (PARTITION BY GROUPING(会社名)), 1) AS 構成比`（**式の中**） | **`internal error: GROUPING() reference was not resolved during B65 planning.`** |
| `ROUND(SUM(売上) * 100.0 / SUM(SUM(売上)) OVER (), 1)`（式の中・GROUPING なし） | 通る（ただし合計行も分母に入る＝仕様どおり） |

第 3 回「発展 — ROLLUP」で、明細＋合計行に順位と構成比を同時に付ける形がこれに当たる。

## 2. 原因

B65 の計画（`validateGroupingPlanning`）は SELECT 列・HAVING・ORDER BY の `GROUPING()` 参照を集めて `bindGroupingRefCanonicalId` で正規 ID に束縛し、実行時の評価（`groupingRowMeta.ts`）はその束縛だけを見る。B184-B の隠しウィンドウ列（`stmt.hiddenWindows`）は `stmt.columns` とは別の配列なので、その中の `GROUPING()` は集められず、評価時に未束縛で内部エラーになっていた。`validateGroupingStatic` の「ROLLUP なしで GROUPING() を書いた」検査と、集計引数内の `GROUPING()` 禁止検査も同様に隠しウィンドウを見ていなかった。

## 3. 対応

`validateGroupingStatic` と `validateGroupingPlanning` の収集対象を `[...stmt.columns, ...(stmt.hiddenWindows ?? [])]` に変更。あわせて `execute.ts` の `validateSelectGroupingPlanning` が B65 計画を起動する判定（`GROUPING_` ノードの有無）にも `hiddenWindows` を加えた＝これが無いと `ROLLUP` なしで式の中に `GROUPING()` を書いた形が計画を素通りし、評価時に「GROUPING() evaluation requires B65 grouping row membership」の内部エラーになる。純加法・結果と EXPLAIN 不変。

同型の検査を `stmt.columns` 単独で歩く箇所を棚卸しした（B190・B191 の型）。残り 2 件は **警告・表示の穴で [B192](ksql_b192_hidden_window_range_warning_issue.md) として起票**（2026-09-16・結果は正しい）:

- `collectDefaultRangeWindowWarnings`（`execute.ts` 3772 行付近）は出力列のウィンドウだけを見る。式の中の `SUM(x) OVER (ORDER BY y)`（フレーム省略＝既定 RANGE）には **RANGE 警告が出ない**。第 3 回の 1 段版は `ROWS` を明示しているので影響しないが、省略した書き手に合図が無い
- EXPLAIN の `window 別名: …` / `frame:` 行（`execute.ts` 14474 行付近）は出力列のウィンドウだけ。式の中のウィンドウはフレームが EXPLAIN に出ない（B184-B の「EXPLAIN 不変」は意図どおりだが、上の警告の穴と合わせると RANGE かどうかを事前に知る手段が無い）

テスト（`b184bWindowInExpression.test.ts`）:

- `ROLLUP(会社名)` + `RANK() OVER (PARTITION BY GROUPING(会社名) …)` + `ROUND(… / SUM(SUM(売上)) OVER (PARTITION BY GROUPING(会社名)), 1)` が通り、明細 5 行（順位 1〜5・構成比 53.4 / 23.3 / 23.3 / 0 / 0）+ 合計行（順位 1・構成比 100）。列として出す従来形と同じ分母
- `ROLLUP` なしで式の中のウィンドウに `GROUPING()` を書くと `GROUPING() requires GROUP BY ROLLUP or GROUPING SETS` で止まる

## 4. 受入条件

- §1 の 3 行目が通り、列として出す形と同じ値になる
- 既存の B65 / B184 テストが不変
- 実機（dev）で第 3 回の ROLLUP + 順位 + 構成比の 1 文が明細 10 行 + 合計 1 行（構成比 25.3 … 100）を返す

## 5. 経緯

- 2026-09-16: 第 3 回の「ROLLUP とウィンドウの併用は可（v3.81.0〜）」に kSQL 版の SQL を添えるために、順位だけでなく構成比まで 1 文に書いた形を dev に流して発見。B190 と同じ「B184-B の隠しウィンドウが、出力列だけを歩く既存の検査に入っていない」型（3 例目: 取得列収集＝B190、B65 計画＝B191）
- 関連: B184-B、B65（拡張 grouping）、B190
