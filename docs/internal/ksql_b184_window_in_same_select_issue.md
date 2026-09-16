# B184 ウィンドウ関数の同一 SELECT 内での集計併用と式内利用 — 内部で 3 段へ脱糖して標準 SQL の形を通す

- 状態: 🚧 **A・B とも codex が実装・Claude レビュー済み（2026-09-16・`b184/dev`・A はコミット 32bcebc・B はコミット待ち・[A 報告](ksql_b184a_codex_impl_report.md)・[B 報告](ksql_b184b_codex_impl_report.md)）。v3.81.0（minor）候補**。B: `SelectStatement.hiddenWindows`（公開 `columns` と別配列）に式内ウィンドウを `__ksql_window_n` で切り出し、`applyWindow` で評価・`byLookupKey` にだけ保持。`project` / DISTINCT / CSV / column meta に出ない。実機で第 3 回の 1 段版（順位・構成比・累積構成比・区分）が 3 段版と完全一致、第 2 回の `LAG` 1 段版も同一。A: パーサの門番を外し、ウィンドウの引数・PARTITION BY・ORDER BY をグループキー・集計の別名・集計式・`GROUPING()` に限定（未グループ化の生フィールドは既存の非グループ依存エラー）。SELECT に無い集計は B187 の実体化経路で非表示に実体化。同一 SELECT で全グループキーが ORDER BY にあれば一意と判定（RANGE 警告を緩める方向だけ）。codex が停止条件どおり止めた旧契約テスト 7 件（B94・B148・B65 静的検証・B65 パーサ）は Claude が新契約へ書き換え。実機で 1 段版 = 2 段版（10 行・値・列順・警告）、HAVING 後の評価、SELECT に無い `COUNT(*)`、ROLLUP + `GROUPING()`、`LAG(COUNT(*))` の 1 段版 = 2 段版を確認。改善（構文の緩和・既存 SQL の挙動不変）

## 1. 現状（v3.77.0・ソース確認）

kSQL は次の 2 つを **パーサで**拒否する。エンジン側の制約ではない。

| # | 形 | 拒否箇所 | 診断 |
| :-: | :--- | :--- | :--- |
| A | `SELECT 会社名, SUM(売上) AS s, RANK() OVER (ORDER BY SUM(売上) DESC) FROM APP4149 GROUP BY 会社名` | `src/parser/parser.ts:1355`（`hasWindow && (groupBy || grouping || hasAggregate)`） | `ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません` |
| B | `SELECT ROUND(SUM(x) OVER (), 1) AS a FROM t`、`件数 - LAG(件数) OVER (…)` | `WINDOW_RESULT_IN_EXPRESSION_MESSAGE`（`parser.ts:342`・B129 の診断） | `ウィンドウ関数の結果は同じ SELECT の式では使えません。× … ○ WITH w AS (…)` |

エンジンのパイプライン（`src/engine/process.ts` の `runFullScan` 付近）は「4. GROUP BY → 5. HAVING → 6. ウィンドウ（`applyWindow`・HAVING 後の同じ行集合に対して評価）→ 7. DISTINCT → 8. ORDER BY」の順で、**標準 SQL と同じ評価順序を既に持つ**。`applyWindow` はウィンドウ列を行に足してから `project` へ渡すので、B も「隠し列として先に評価し、式からはその列を参照する」形にできる。

利用者は現在、次の 3 段に書き分けている（言語リファレンス §10.1・レシピ R15/R16・Qiita 第 2〜3 回）。

```sql
WITH base AS (SELECT … GROUP BY …),
     ranked AS (SELECT …, SUM(売上合計) OVER () AS 総計, … FROM base)
SELECT …, ROUND(売上合計 * 100.0 / 総計, 1) … FROM ranked
```

### 1.1 訂正（codex 調査・2026-09-16・[報告](ksql_b181_b184_codex_plan_report.md) §5）

「拒否はパーサのみ」は過大評価だった。評価順（GROUP BY → HAVING → ウィンドウ → DISTINCT → ORDER BY）は起票どおりだが、次がトップレベルの `WINDOW_COL` 前提で作られている。

- `SelectColumn` はウィンドウをトップレベル列としてしか表現できず、式 AST にウィンドウ node が無い（`src/types/ast.ts:273-287`・`336-380`）
- `applyWindow()` は SELECT 列中の `WINDOW_COL` だけを列挙し、値は列 index に紐づく（`process.ts:1322-1335`・`1374-1380`）。`project()` は全 `WINDOW_COL` を公開列に出す（`1677-1686`・`1822-1826`）
- 取得フィールド収集（`selectToKintone.ts:778-784`）と完全入力判定（`dmlGuard.ts:181-195`）もトップレベルのみ
- `ORDER BY SUM(売上)` をウィンドウの ORDER BY に書く形は、`parseOrderByKey()` が集計を解析後に位置を戻し集計用 key を作らないため（`parser.ts:3752-3762`）、1355 の門番より前で扱いが決まる。「集計別名」と「集計式直書き」は別受入にする
- 「CTE 経由の現行判定と同じ根拠で全順序を扱う」は不一致。現行の CTE 経路は集計キーを一意と証明せず、警告文で「証明できない」と明記している（`execute.ts:3641-3648`）。同一 SELECT のグループキーで一意を証明するのは**新しい規則**

規模は A・B とも **L**（起票時の「中」を訂正）。B は `SelectStatement` に公開 `columns` と別の内部 `hiddenWindows` を持たせ、`applyWindow` で評価・`project` / `computeOutputKeys` / column meta / CSV / DISTINCT に渡さない設計が安全（公開 `columns` に `hidden: true` を混ぜる案は列 index 契約と衝突）。A → B の順で別 PR、同一 minor でリリース。隠し列の型は B182 の共通 helper を使う（B182 先行）。

## 2. なぜ改善するか

- 標準 SQL の習慣で書く人と AI は、最初に必ず A・B の形を書く。Qiita 番外編（`docs/internal/qiita/ksql-intro-series/03a_番外編_AIの回答を検証する.md`）の 2 巡目で Claude Desktop は B を書いて ParseError を受け、エラー文の指示どおり 3 段へ直した。**1 往復で直るが、毎回 1 往復かかる**
- 第 0 回の差分早見表「集計とウィンドウは同じ SELECT に書けない。CTE で段を分ける」を消せる。差分が 1 つ減ることは AI に書かせる場面で最も効く
- 一方で、この制限は `ksql_validate` の段階で**音を立てて止まり**、診断文が正解を示す。B181（別名の小文字正規化）・B182（`COALESCE` の型）のように validate・explain を通り抜けて静かに間違うものではない。優先度をそれらより下に置く理由

## 3. 提案（内部で脱糖する）

**A. 集計と同じ SELECT のウィンドウ**

- `parser.ts:1355` の門番を外す
- ウィンドウの `PARTITION BY` / `ORDER BY` / 引数が参照できるものを「グループキー・集計の別名・集計式そのもの（`SUM(売上)`）」に限定する。集計式は `applyGroupBy` が行に載せる集計結果のキーへ解決する（`aggregateRef` の仕組みを流用）。グループ化されていない生のフィールドを参照したらエラー（標準 SQL と同じ）
- HAVING 後にウィンドウを評価する現行順序のまま
- EXPLAIN に「集計後にウィンドウを評価」の行を出し、`complete input reason` に `WINDOW_ORDER` / `AGGREGATE_WINDOW` を併記
- 既定 `RANGE` の警告（全順序の判定）は、グループキーの組を一意として扱う（CTE 経由の現行判定と同じ根拠）

**B. ウィンドウ結果を式に使う**

- パーサでネストしたウィンドウ式（関数の引数・算術・`CASE`）を検出したら、拒否せず**隠しウィンドウ列**に切り出す（生成別名は結果列名に出さない）。式の中はその隠し列への参照に置き換える
- `applyWindow` で隠し列を評価 → `project` で式を評価 → 隠し列を結果から除く。`DISTINCT`・`ORDER BY`・`LIMIT` は隠し列を含めない
- `WHERE` / `HAVING` でのウィンドウ参照は引き続き拒否（標準 SQL でも不可）
- EXPLAIN に隠し列を「暗黙のウィンドウ段」として表示する

**共通**

- 既存の 3 段の書き方は変えない（脱糖後の形と等価）。言語リファレンス §10.1 の「同じ SELECT では未対応」を「v3.7x から可」に改め、3 段は「段ごとに確かめたいときの書き方」として残す
- B129 の診断文は残す（`WHERE` / `HAVING` でのネストや未対応の組み合わせで使う）
- 版数: 純加法（既存 SQL の挙動不変）だが構文の意味が広がるので **minor**。プラグインは EXPLAIN エンジンをバンドルするため文言変更が波及する点に注意（memory: logical-app-id-mapping-spec のガッチャ）

## 4. 受入条件

- 第 3 回の「標準 SQL ならこう書く」の 1 段版（`RANK() OVER (ORDER BY total DESC)`、`ROUND(total * 100.0 / SUM(total) OVER (), 1)`、`ROUND(SUM(total) OVER (ORDER BY total DESC, name ROWS UNBOUNDED PRECEDING) * 100.0 / SUM(total) OVER (), 1)` を含む）を kSQL の名前に置き換えたものが、現行の 3 段版と**同じ 10 行・同じ値・同じ列順**を返す
- 第 2 回の `件数 - LAG(件数) OVER (ORDER BY 年月)` が 5 段版と同じ 9 行を返す
- 既定 `RANGE` の警告と `complete input` の判定が、3 段版と同じ条件で出る
- `WHERE` / `HAVING` でのウィンドウ参照は従来どおりエラー
- 隠し列が結果列・`DISTINCT`・CSV export・Dashboard の列に現れない
- 既存テスト（ウィンドウ 29 ファイル）が通り、3 段版と 1 段版を同じ入力で突き合わせるテストを両方向（桁違いの値）で追加
- 言語リファレンス §10.1・レシピ R15/R16・第 0 回の差分早見表相当の文書を更新し、助言をそのまま実行するテストを 1 本

## 5. 経緯

- 2026-09-16: user の「kSQL でも使えるようにすることは可能か。代替策（3 段を書かせる）と比較評価して」→ ソース確認で制限がパーサのみと判明。比較の結論は「実装価値あり・ただし静かに間違う B181/B182 より後」。起票
- 関連: B129（式内ウィンドウの診断文・v3.4x）、B181・B182（同じ番外編で発見）、Qiita 第 2・3 回の「段を分ける」記述（実装後は版注記が要る）
