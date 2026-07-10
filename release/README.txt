ksql 配布パッケージ (v1.6.0)

1. ksql-plugin-v1.4.0.zip を kintone のプラグイン画面で読み込む(プラグインは v1.4.0 のまま)
2. ksql-app-template-v1.0.0.zip をアプリ作成時にテンプレートとして読み込む
3. アプリにプラグインを適用して利用開始する

v1.6.0 は MCP サーバー(ksql-mcp.js / ksql-mcp.mcpb)のみ更新。
APP ソースの UPSERT INTO ... SELECT ... ON DUPLICATE を ksql_mutate で実行可能に(単文・バッチとも)。
