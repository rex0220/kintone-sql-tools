# B150+B153 修正依頼 1（Critical 1＝実機発見・Major 1・Medium 1）

禁止事項は従来どおり（git・version・CHANGELOG・release/・台帳・ビルド・MCP・MEMORY.md）。

## 1. Critical — EXPLAIN / dry-run が CTE→APP JOIN でレコード API を呼ぶ（Claude 実機発見）

```
node dist-cli/ksql.js --dry-run -e "WITH s AS (SELECT '食パン' AS k)
  SELECT s.k FROM s INNER JOIN APP4228 AS t ON s.k = t.製品名"
→ DryRunError: API call should not happen in dry-run.
```

- **v3.60.0 は同じ形を正常表示していた**（`join pushdown not applied: SOURCE_KIND`・API 0 回）
  ＝**B150 の回帰**。範囲経路・in 経路の両形で再現
- 「**EXPLAIN はレコード API を呼ばない**」は B123/B76 以来の公開契約。B150 の EXPLAIN が
  結合キー実値（runtime candidate）を得ようとして fetch まで実行している経路を特定し、
  **EXPLAIN では fetch せず runtime candidate の旨を表示する**形へ戻す
- 回帰テスト＝dry-run / no-op client で **CTE→APP・一時テーブル→APP の JOIN EXPLAIN が
  records API 0 回**であることを固定（in 経路・範囲経路・フォールバックの 3 形）

## 2. Major — EXPLAIN が `in` の 50 件チャンク契約を再現しない（最終チェック指摘 1）

実行は 50 件ごとに複数 query、EXPLAIN は全値を単一 `in (...)`。51〜300 件で不一致。
**EXPLAIN も共有 helper でチャンク化し、実行順に複数 query を表示**。51 件・300 件の逐語テスト追加。
（※修正 1 と同時に設計すること＝EXPLAIN は fetch しないがチャンク表示は実行と同形にする）

## 3. Medium — 3 経路一致の受入を共通 fixture で（最終チェック指摘 2）

同一キー集合 `{2025-08-04, 2025-08-06}`＋gap 行を含む JOIN 先を共有し、
CTE / 一時テーブル / APP→APP の最終結果を**全件取得基準と比較**するパラメータ化テストへ。

## 4. 実行と報告

修正前 fail の確認（特に 1 は dry-run で DryRunError が出ることを固定してから直す）・
`npm test` 全体（環境変数除外可・EPERM 時は報告のみ）・最終メッセージ＝修正報告のみ。
