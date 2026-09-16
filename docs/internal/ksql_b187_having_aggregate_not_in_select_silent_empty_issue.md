# B187 `HAVING` に SELECT 列に無い集計を書くと静かに 0 行になる — 契約どおりだがエラーも警告も出ない

- 状態: 📝 **起票（2026-09-16）**。未着手。実測 v3.78.0（CLI・dev profile・SFA パック）。B119〜B122・B182 と同じ「静かに間違う」系。改善（診断の追加。エラーにするか評価を足すかは方針判断）

## 1. 現象

```sql
SELECT 商談フェーズ, COUNT(*) AS n
FROM APP4149 GROUP BY 商談フェーズ
HAVING SUM(売上) > 1000000
```

| 書き方 | 結果 |
| :--- | :--- |
| 上の SQL（`SUM(売上)` が SELECT に無い） | **0 行**。エラーも `warnings` も無し。`EXPLAIN` の reason は `GROUP BY あり, 集計関数（COUNT / SUM 等）あり` で通常どおり |
| SELECT に `SUM(売上) AS s` を足す | 3 行（提案中 28,250,000 / 内示 12,750,000 / 受注 40,800,000） |

- 言語リファレンス §9「直接記述した集計関数は、同じ集計が SELECT 列にも存在する場合に限り評価できます。SELECT にない集計を HAVING 専用で追加計算はしません」のとおりの挙動。**契約には合っているが、契約違反の SQL を静かに 0 行にする**
- mock（`b181AliasReference.test.ts` の `mixedClient`）でも同じ（`HAVING SUM(Amount) > 950` が `[]`）

## 2. なぜ問題か

- 標準 SQL では通る形（HAVING に SELECT に無い集計）を AI も人間も自然に書く。第 9 回付録の依頼文でも「件数だけ出して売上で絞る」は普通の依頼
- 0 行は「該当なし」と区別が付かない。B182（`COALESCE` で包んだ集計）と同じく、結果を見ても気づけない
- 三層のどこでも捕まらない（`validate` ok・`explain` ok・実行 ok）

## 3. 対応案

**案 A（評価する・機能）**: HAVING 専用の集計を SELECT 列と同じ実体化経路（`materializeAggregateDependencies` / B182 で一般化した `resolveAggInArithNode`）で計算し、出力には載せない。標準 SQL と同じ意味になる。取得列は `collectRequiredFieldsByTable` の `having` phase が既に集計引数を拾っている（B181 レビューで確認）ので、追加の API は不要

**案 B（拒否する・診断）**: パース後の検証で「HAVING の集計 `SUM(売上)` は SELECT 列にありません。SELECT に追加するか別名で参照してください」を `ArgumentError` にする。`ksql_validate`（静的）でも出せる。挙動は変わらないが静かに 0 行にはならない

推奨は **A**（実需の形が通る）。A の規模が大きければ **B を先に**入れて静かな 0 行を止める。どちらも B65 の非グループ依存検証（`aggregateDependencyValidation`）と整合させる

## 4. 受入条件

- 案 A: §1 の SQL が 3 行を返し、`SUM(売上) AS s` を足した形と同じ行集合になる（列は `商談フェーズ, n` だけ）。HAVING の集計が複数・算術（`SUM(a) - SUM(b) > 0`）・`CASE` 引数（B120）でも同じ。GROUP BY なし（単一グループ）・0 行・CTE 経由・`/flow` で同じ
- 案 B: §1 の SQL が `ksql_validate` と実行の両方で同じ文言のエラーになる
- 既存テスト b119〜b122・b182 はそのまま通る。SELECT に同じ集計がある既存の形は結果・EXPLAIN 不変

## 5. 経緯

- 2026-09-16: B181 レビューで HAVING の集計引数を別名へ束縛しない保護を入れる際、テストの期待値が 0 行になり、ベースライン（B181 以前）でも同じであることを確認。言語リファレンス §9 の契約を確認して B181 の範囲外と判断（[B181 codex 報告](ksql_b181_codex_impl_report.md) Claude レビュー §3）。実 SFA でも再現。v3.78.0 リリース後の別課題候補 4 件の起票で B187 に採番
- 関連: [B182](ksql_b182_coalesce_aggregate_silent_wrong_issue.md)（集計の実体化経路を一般化済み）、B119〜B122（静かに間違う集計まわり）、B65（非グループ依存検証）
