ksql 配布パッケージ (v1.7.0)

1. ksql-plugin-v1.7.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.0.0.zip をアプリ作成時にテンプレートとして読み込む
3. アプリにプラグインを適用して利用開始する

v1.7.0: MCP サーバー(ksql-mcp.js / ksql-mcp.mcpb)で SELECT-based DML のソース制限を最終解消
(INSERT/UPSERT INTO ... SELECT は APP・一時テーブル・混在 JOIN とも実行可能)。
プラグイン zip はエンジン共通コードの更新を含む再パッケージ
(プラグインから利用できる機能に変更はありません)。
