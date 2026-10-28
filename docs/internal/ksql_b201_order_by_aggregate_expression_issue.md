# B201 `ORDER BY SUM(x)`（集計式そのもののソート）が実行時に `ORDER_KEY_UNRESOLVED` で止まる

- 状態: ✅ **案 B で v3.88.0 でリリース（2026-10-28）**＝**書いた時点で構文エラー**にして実行時まで分からない状態をなくした。規模 S（パーサー 1 か所＋メッセージ定数）。テスト `src/parser/__tests__/b201OrderByAggregateKey.test.ts`（22 件）。案 A（planner が集計式を解決する）は**実需が出たら**
- 種別: 改善（書けると読めるのに実行できない）
- 優先: 低（回避策が 1 語で済む。別名を付けるのは SQL として自然な書き方）→ 案 B は規模 S だったため B200 と同じ版で出す
- 関連: [B200](ksql_b200_apply_append_values_issue.md) §2.6（発見の経緯）、[B184](ksql_b184_window_in_same_select_issue.md)（文レベル `ORDER BY SUM(x)` の拒否がパース時から実行時へ移った版）

## 1. 現象

`GROUP BY` の SELECT で、**集計式そのもの**を `ORDER BY` のキーに書くと、parse と validate は通るのに実行時に止まる。

```sql
-- 止まる: ArgumentError: ORDER BY key has no canonical comparison contract (reason=ORDER_KEY_UNRESOLVED).
INSERT INTO APP300 (担当者, 件数, 金額)
SELECT 担当者, COUNT(*), SUM(金額) FROM APP200 GROUP BY 担当者 ORDER BY SUM(金額) DESC;

-- 通る: 別名を付けてその名前で並べる
INSERT INTO APP300 (担当者, 件数, 金額)
SELECT 担当者, COUNT(*) AS 件数, SUM(金額) AS 金額 FROM APP200 GROUP BY 担当者 ORDER BY 金額 DESC;
```

実測（モックの client・2026-10-28・v3.87.0 + B200 の作業ブランチ）:

| 形 | 結果 |
|---|---|
| `ORDER BY SUM(金額) DESC` | **error** `ORDER_KEY_UNRESOLVED` |
| `ORDER BY <別名>` | success（SUM の降順で並ぶ） |
| `ORDER BY <列名>` | success |
| `ORDER BY` なし | success（入力順） |

**面を問わない**（`INSERT … SELECT` でも `APPEND … SELECT` でも素の `SELECT` でも同じ経路）。
`src/core/optimization/canonicalOrderPlanner.ts:90-100` が、ORDER BY のキーを SELECT の別名か入力行のフィールドとして解決できないと fail-closed にしている。

## 2. 影響

- 依頼元（kSQL アクション）の依頼書 KJ-6 §4.1 は「`ORDER BY SUM(金額) DESC` は通る」と書いていた（**parse は通る**が実行できない）。
  B200-2 の回答で「`ORDER BY` は APPEND の並びになる」と答えた形がそのままでは動かないため、kintone-plugin の work-link `kSQLエンジンからの実装報告-20261028-KJ6-APPEND_SELECT.md`で訂正と回避策を伝えた。
- 言語リファレンス §19.1 の「APPEND … SELECT」と §2 の ORDER BY の節に、**別名で書く**ことを明記した。

## 3. 入れたもの（案 B・2026-10-28）

**文の `ORDER BY` と `KORDER BY` のキーが集計式なら、パーサーが断る**（`src/parser/parser.ts` の `parseOrderByKey`）。
メッセージは `ORDER_BY_AGGREGATE_KEY_MESSAGE`（export 済み）で、×／○ の例と「別名を付けて並べる」ことを書いた。
スクリプト面では `KSQL1202`（構文エラー）として位置つきで出るので、**保存の時点で止まる**。

対象と対象外を測ってから線を引いた（実測・下の表）。

| 形 | v3.87.0 まで | v3.88.0（案 B） |
|---|---|---|
| 文の `ORDER BY SUM(x)`（別名の有無を問わず）・`COUNT(*)`・`MAX`・`AVG`・`DISTINCT` 集計・GROUP BY なし | parse ok → **実行時に `ORDER_KEY_UNRESOLVED`** | **構文エラー**（別名の付け方を示す） |
| `KORDER BY SUM(x)` | parse ok → 実行時に `KORDER_KEY_UNRESOLVED(field=SUM(金額))` | **構文エラー** |
| CTE の中・UNION の枝・`INSERT … SELECT` のソース・一時テーブルのソース・`APPEND … SELECT` のソース | 同上（実行時） | **構文エラー** |
| `ORDER BY <別名>` / `ORDER BY <列名>` | 通る | **変わらない** |
| **ウィンドウの `OVER (ORDER BY SUM(x) DESC)`** | **通る**（文の `ORDER BY` と併記しても通る） | **変わらない**（対象外） |
| `ORDER BY SUM(x) * 2` | 構文エラー（「フィールド名またはテーブル名が必要です」） | 変わらない |
| `REORDER … BY SUM(x)` | parse ok（モックでは no-op。本当の動きは未確認） | **変わらない**（測れていない形を変えない） |

**動いていた形は 1 つも落ちていない**（ウィンドウの ORDER BY に集計式を書く形は v3.81.0 の B184 で開いたもので、ここは触っていない）。
`REORDER` を含めなかったのは、プレーンな列のキーでもモックの client では no-op になり、**集計式のときの本当の動きを確かめられなかった**ため。
確かめられたら同じ扱いにする（純加法の方向）。

## 4. 残した案（案 A・未決定）

**案 A**: canonical order planner が、SELECT 列に同じ集計式があるときは**その列の意味型を使って**解決する（別名を書いたのと同じ扱いにする）。
集計式の同一性判定（`SUM(金額)` と `SUM( 金額 )` など）の正規化が要る。**実需が出たら**＝「別名を付けるのが面倒」という声が複数の面から出たとき。
案 B を入れたことで、書く側は**書いた時点で**直し方を知れるため、案 A の費用を先に払う理由は薄いままと見ている。

**判断の記録**: 警告ではなく**エラー**にした。この形は*必ず*実行時に失敗する（実測）ので、警告にして保存を通すと
「保存はできたが実行すると必ず失敗する設定」を作れてしまう。依頼元（kSQL アクション）は警告を保存の障害にしない方針なので、警告では止められない。
B184 で「文レベル `ORDER BY SUM(x)` の拒否がパース時から実行時へ移った」のは副作用の記録であり、意図した移動ではなかった（同 release history の記述）。
元の層へ戻し、メッセージだけ直し方を示す形に良くした。
