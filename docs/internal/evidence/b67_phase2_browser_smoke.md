# B67 Phase2 A ブラウザ／実 kintone smoke（ユーザー実施）

- 対象: B67 Phase2 A（SUPERSET_PREFILTER）
- 版: v3.21.0 予定
- ステータス: **未実施（release gate・ユーザー実施待ち）**

## 手順（Node で代替しない）

境界跨ぎで結果が変わらない広い窓を用いる。既定候補（最終アプリ/フィールドは実環境で確定してよい）:

```sql
-- 正例（mixed prefilter＋残余）
SELECT 都道府県, 更新日時 FROM APP730
WHERE 更新日時 >= FROM_TODAY(-3650, DAYS) AND LENGTH(都道府県) > 0

-- 拒否例
INSERT INTO APP731 (都道府県) SELECT 都道府県 FROM APP730
WHERE 更新日時 >= YESTERDAY() AND LENGTH(都道府県) > 0        -- DML source → fail-closed
SELECT * FROM APP730 WHERE 更新日時 >= YESTERDAY() OR LENGTH(都道府県) > 0   -- OR relative → fail-closed
SELECT * FROM APP730 WHERE 更新日時 >= YESTERDAY() AND LENGTH(都道府県) > 0 KORDER BY 更新日時   -- KORDER → fail-closed
```

## 確認観点

- Firefox / Chrome プラグイン、ビルド済み CLI、デプロイ済み MCP で同一 SQL・同一 app metadata。
- 正例: 送信 query に `更新日時 >= FROM_TODAY(-3650, DAYS)` が載り、`LENGTH(...) > 0` は client 評価。`ksql_explain` が `where capability: SUPERSET_PREFILTER` / `server prefilter:` / `client residual:` / `relative date client evaluations: 0` を表示。browser clock / timezone 非参照。
- 拒否例: いずれも records / Cursor / mutation 発行前に `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で fail-closed。
- 既存 Phase1 pure-exact（`WHERE 作成日時 < FROM_TODAY(5, DAYS)`）が非回帰。

## 結果

（ユーザー実施後に追記）
