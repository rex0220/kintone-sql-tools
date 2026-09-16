# B187 `HAVING` に SELECT 列に無い集計を書くと 0 行になる — 契約どおりで警告は出るが、標準 SQL の形が通らない

- 状態: 🚧 **codex が案 A を実装・Claude レビュー済み（2026-09-16・`b187/dev`・コミット待ち・[報告](ksql_b187_codex_impl_report.md)）**。`applyGroupBy` / `applyGroupingSets` で SELECT 集計の実体化直後に HAVING の集計依存も `materializeAggregateDependencies` で実体化（B182 の helper 再利用・出力列にはしない・取得列と EXPLAIN 不変）。旧契約を固定していた既存テスト 4 件（B164・B65-A04・B56・B189）を新契約へ。実機で起票 SQL が 3 行・警告なし、ROLLUP も評価。**結果が変わる修正**なので v3.80.0（minor）で出す。起票時の実測 v3.78.0（CLI・dev profile・SFA パック）。**訂正**: 起票時は「エラーも警告も出ない」と書いたが、エンジンは `warnings` に「比較条件で参照した集計値を確認できません。SELECT リストに同じ集計式を含めてください。」（B121 由来・`UNRESOLVED_AGGREGATE_COMPARISON_WARNING`）を出している。見えなかったのは CLI のテキスト表示が単文 SELECT の `warnings` を出さないため（表示の穴は [B189](ksql_b189_cli_single_statement_warnings_not_shown_issue.md) に分離）。本件は「標準 SQL の形を評価する」機能改善（案 A）に絞る。B184 の後

## 1. 現象

```sql
SELECT 商談フェーズ, COUNT(*) AS n
FROM APP4149 GROUP BY 商談フェーズ
HAVING SUM(売上) > 1000000
```

| 書き方 | 結果 |
| :--- | :--- |
| 上の SQL（`SUM(売上)` が SELECT に無い） | **0 行**。`warnings` に「比較条件で参照した集計値を確認できません。SELECT リストに同じ集計式を含めてください。」（JSON / MCP では見える。CLI のテキスト・csv・markdown では表示されない＝B189）。`EXPLAIN` の reason は `GROUP BY あり, 集計関数（COUNT / SUM 等）あり` で通常どおり |
| SELECT に `SUM(売上) AS s` を足す | 3 行（提案中 28,250,000 / 内示 12,750,000 / 受注 40,800,000） |

- 言語リファレンス §9「直接記述した集計関数は、同じ集計が SELECT 列にも存在する場合に限り評価できます。SELECT にない集計を HAVING 専用で追加計算はしません」のとおりの挙動。警告文の存在は §9 に書かれていない
- mock（`b181AliasReference.test.ts` の `mixedClient`）でも同じ（`HAVING SUM(Amount) > 950` が `[]`）

## 2. なぜ問題か

- 標準 SQL では通る形（HAVING に SELECT に無い集計）を AI も人間も自然に書く。第 9 回付録の依頼文でも「件数だけ出して売上で絞る」は普通の依頼
- 警告はあるが結果は 0 行のままで、「該当なし」と区別が付かない。MCP の AI は `warnings` を読めば直せるが、CLI のテキスト表示では気づけない（B189）
- `validate` と `explain` は通る（静的検査に無い）

## 3. 対応案

**案 A（評価する・機能）**: HAVING 専用の集計を SELECT 列と同じ実体化経路（`materializeAggregateDependencies` / B182 で一般化した `resolveAggInArithNode`）で計算し、出力には載せない。標準 SQL と同じ意味になる。取得列は `collectRequiredFieldsByTable` の `having` phase が既に集計引数を拾っている（B181 レビューで確認）ので、追加の API は不要。入れたら §9 の契約文と警告（不要になる）を更新する

~~案 B（拒否する・診断）~~: 起票時の案。既に警告があるので「警告 → エラー」への格上げになり、通っていた SQL を止める契約変更。採らない

推奨は **A**。B65 の非グループ依存検証（`aggregateDependencyValidation`）と整合させる。CLI で警告が見えない件は B189 で先に直す

## 4. 受入条件

- §1 の SQL が 3 行を返し、`SUM(売上) AS s` を足した形と同じ行集合になる（列は `商談フェーズ, n` だけ）。HAVING の集計が複数・算術（`SUM(a) - SUM(b) > 0`）・`CASE` 引数（B120）でも同じ。GROUP BY なし（単一グループ）・0 行・CTE 経由・`/flow` で同じ
- `UNRESOLVED_AGGREGATE_COMPARISON_WARNING` はこの形では出なくなる（本当に解決できない形＝サブクエリ内の集計など、残る形があれば列挙）
- 既存テスト b119〜b122・b182 はそのまま通る。SELECT に同じ集計がある既存の形は結果・EXPLAIN 不変

## 5. 経緯

- 2026-09-16: B181 レビューで HAVING の集計引数を別名へ束縛しない保護を入れる際、テストの期待値が 0 行になり、ベースライン（B181 以前）でも同じであることを確認。言語リファレンス §9 の契約を確認して B181 の範囲外と判断（[B181 codex 報告](ksql_b181_codex_impl_report.md) Claude レビュー §3）。実 SFA でも再現。v3.78.0 リリース後の別課題候補 4 件の起票で B187 に採番
- 2026-09-16（同日）: B187 案 B の依頼書を書く前の再測定で、JSON 出力の `warnings` に既存の警告があることを確認。「警告も出ない」は CLI テキスト表示の穴（B189）だった。案 B を取り下げ、案 A に絞る
- 関連: [B182](ksql_b182_coalesce_aggregate_silent_wrong_issue.md)（集計の実体化経路を一般化済み）、B119〜B122（静かに間違う集計まわり）、B65（非グループ依存検証）
