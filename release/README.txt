ksql 配布パッケージ (v1.7.0)

1. ksql-plugin-v1.4.0.zip を kintone のプラグイン画面で読み込む(プラグインは v1.4.0 のまま)
2. ksql-app-template-v1.0.0.zip をアプリ作成時にテンプレートとして読み込む
3. アプリにプラグインを適用して利用開始する

v1.7.0 は MCP サーバー(ksql-mcp.js / ksql-mcp.mcpb)のみ更新。
INSERT/UPSERT INTO ... SELECT のソース制限を最終解消(APP・一時テーブル・混在 JOIN とも実行可能)。
