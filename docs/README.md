# Docs Index

`docs/` 直下は**利用者向けドキュメント**、`docs/internal/` は**開発側の作業文書**（仕様書・実装計画・課題文書・評価・実測証跡）です。新しい文書は、利用者が読むものだけを直下へ置きます。

## 課題・改善案・Issue の管理

- **[`ksql_issue_tracker.md`](ksql_issue_tracker.md)** — 課題・改善案・Issue の一括管理台帳（進捗 / 効果 / リリースバージョン）。個別文書のステータスをここに集約する。**internal 配下の仕様・課題文書はこの台帳から辿る。**

## 利用者向けドキュメント

- [`ksql_language_reference.md`](ksql_language_reference.md) — kSQL 言語リファレンス（構文・関数・制限）
- [`ksql_cli_tutorial.md`](ksql_cli_tutorial.md) — CLI チュートリアル
- [`ksql_batch_recipes.md`](ksql_batch_recipes.md) — バッチ設計レシピ集（リラン可能な差分更新・ON ERROR SKIP・KORDER 大量取得・正規化書き戻し 等）
- [`ksql_v3_migration_guide.md`](ksql_v3_migration_guide.md) — v3.0.0 移行ガイド（比較・ORDER BY・WHERE・取得上限・KORDER 予約語）
- [`ksql_v3_1_migration_guide.md`](ksql_v3_1_migration_guide.md) — v3.1.0 移行ガイド（KORDER BY 大規模窓の Cursor API）
- [`ksql_mcpb_claude_desktop_install.md`](ksql_mcpb_claude_desktop_install.md) — Claude Desktop への MCPB インストール手順

## 設定サンプル

- `examples/ksql.config.sample.json` — CLI 設定
- `examples/ksql.mcp.config.sample.json` — MCP 設定
- `examples/mcp-client.sample.json` / `examples/mcp-verification.env.sample`

## 公開記事ドラフト

- `qiita_kintone_sql_tools_intro.md` / `qiita_cli_ksql_intro.md` / `qiita_cli_ksql_mechanism.md` — 紹介・仕組み解説
- `qiita_kintone_string_sort.md` — kintone の文字列とソートの仕様まとめ（公式仕様＋実機検証）

## internal/（開発側の作業文書）

仕様書・実装計画・課題文書・評価・実測証跡（`internal/evidence/`）はすべて [`internal/`](internal/) 配下にあります。個別文書の位置づけと最新ステータスは[台帳](ksql_issue_tracker.md)を正とします。横断的な意味論は [`internal/ksql_string_semantics.md`](internal/ksql_string_semantics.md)（文字列の扱いの正）を参照してください。
