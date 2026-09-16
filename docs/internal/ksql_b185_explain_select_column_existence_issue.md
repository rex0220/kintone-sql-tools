# B185 `EXPLAIN` が SELECT 列の存在を検査しない — 列名の誤りが `validate` と `explain` を通り抜けて実行で初めて止まる

- 状態: ✅ **v3.79.0 でリリース（2026-09-16）**。codex が案 A を実装・Claude レビュー済み（[報告](ksql_b185_codex_impl_report.md)）。EXPLAIN の preflight で実行側と同じ `validateB86SelectFieldCodes` を「キャッシュ済みのフォーム定義だけ」で呼ぶ（追加 API 0・出力行不変）。レビューで**取りこぼしを修正**＝検査が束縛直後だけだと型付き WHERE・ORDER BY・GROUP BY で初めて定義を読む文を通してしまうため、計画作成の最後にもう一度検査。実機で第 9 回 §4 の SQL と 3 文型が実行と同じ文言で失敗、定義を読まない文は従来どおり通ることを確認。起票時の実測 v3.77.0（MCP・dev profile・SFA パック）・v3.78.0 でも同じ。改善（診断の追加・実行結果は不変）

## 1. 現象

`SELECT` 句の列名を誤った集計 SQL（`売上` を `売上金額` と書いた）を三層に通した結果（Qiita「kSQL 実践」第 9 回 §4 の実測）:

```sql
SELECT 商談フェーズ, COUNT(*) AS 件数, SUM(売上金額) AS 売上合計
FROM APP4149 WHERE 受注予定日 = THIS_YEAR() GROUP BY 商談フェーズ
```

| 層 | ツール | 結果 |
| :-: | :--- | :--- |
| 1 | `ksql_validate` | `ok: true`（`validationScope: syntax-and-arguments-only`。フォーム定義を読まないので想定どおり） |
| 2 | `ksql_explain` | **`ok: true`**・`fetch summary: EXACT`・`fields: 商談フェーズ, 売上金額, 受注予定日`（存在しない `売上金額` をそのまま取得列に載せる） |
| 3 | `ksql_query` | `ArgumentError: unknown field code(s): 売上金額 (APP4149)` |

- WHERE 側の列は 2 層目で止まる（`WHERE ランク = 'A'` → `ksql_explain` が `WHERE_FIELD_UNRESOLVED`）。**SELECT・GROUP BY・集計引数の列だけ**が実行まで通り抜ける
- `EXPLAIN` はフォーム定義を既に取得している（`metadata API: form definition APP4149@dev` が出る）ので、突き合わせに追加の API は要らない

## 2. なぜ問題か

- 第 9 回で「三層」を説明の骨格にした。`EXPLAIN` は「フォーム定義と押し下げ」を見る層だが、**取得列の存在を見ない**ので、AI が書いた SQL の列名誤りは実行でしか捕まらない。第 9 回のレビュー観点 1 を「SELECT の列を `ksql_describe_app` と人間が突き合わせる」と書いたのはこのため
- B181（別名の参照解決）は「列が名前を変えている」ケースで、検出経路は同じだった（v3.78.0 で参照側を直したので B181 自体は解消）。列が「無い」ケースは残っている
- `EXPLAIN` の `fields:` 行に存在しない列名が出るのは、読む側に「取得できる」と誤解させる

## 3. 対応案

**案 A（EXPLAIN の診断・純加法）**: `EXPLAIN` の relation preflight（`preflightExplainRelations` → `bindProjectedNamesForSelect` の直後）で、物理 APP の SELECT 列・GROUP BY・集計引数・CASE・関数引数の参照を既に取得済みのフォーム定義（`getFieldsCached`）と突き合わせ、無ければ **実行時と同じ文言** `ArgumentError: unknown field code(s): 売上金額 (APP4149)` で失敗させる。実行側の `validateB86SelectFieldCodes` が使う `collectSelectFieldReferencesBySource` をそのまま `EXPLAIN` でも呼ぶのが最小。フォーム定義を取れない（権限・defs=[]）場合は従来どおり通す（fail-open のまま＝mock 互換）

**案 B（警告）**: エラーにせず `warnings` に「取得列 売上金額 はフォーム定義にありません」を足す。`EXPLAIN` が通ることに依存した既存の利用（ダッシュボードの計画表示など）を壊さない

推奨は **A**。実行が必ず失敗する SQL を `EXPLAIN` が `ok` と言う状態を残す理由が無い。ただし **プラグイン同梱エンジンの EXPLAIN 出力の snapshot に波及**するので、エラー文言は実行時と同一にし、新しい行を EXPLAIN 出力に足さない

## 4. 受入条件

- §1 の SQL で `EXPLAIN` が `ArgumentError: unknown field code(s): 売上金額 (APP4149)` を返し、`ksql_query` と同じ文言になる（EXPLAIN と実行の対称）
- 存在する列だけの SQL では `EXPLAIN` の出力行が 1 行も変わらない（既存 snapshot テスト通過）
- フォーム定義を取れない mock（`getFields` が `[]`）では従来どおり通る
- 位置の網羅: SELECT 列・別名付き列・集計引数・CASE・文字列関数の引数・GROUP BY・ORDER BY・ウィンドウの PARTITION BY / ORDER BY・JOIN の両側（alias 付き）。CTE・一時テーブルの列は B86 の既存検査のまま
- MCP `ksql_explain` と CLI `--dry-run`、プラグインの EXPLAIN で同じ結果

## 5. 経緯

- 2026-09-16: 第 9 回 §4 の三層実測で確認（計画書 §9.14 の「別課題候補・未起票」）。B181 の起票文書 §5 で関連として言及。v3.78.0 リリース後の別課題候補 4 件の起票で B185 に採番
- 関連: [B181](ksql_b181_alias_lowercase_reference_mismatch_issue.md)（別名の参照解決・v3.78.0 解消）、[B186](ksql_b186_explain_mixed_join_unqualified_cte_column_issue.md)（EXPLAIN だけが落ちる逆向きの非対称）
