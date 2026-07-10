ksql 配布パッケージ (v1.8.0)

1. ksql-plugin-v1.7.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.0.0.zip をアプリ作成時にテンプレートとして読み込む
3. アプリにプラグインを適用して利用開始する

v1.8.0: MCP サーバー(ksql-mcp.js / ksql-mcp.mcpb)で SELECT-based DML の
ソース読み取り上限を dmlMaxRows から分離(読み取りは maxRecords 解決値・既定 500、
dmlMaxRows は影響行数ガード専用)。JOIN・集計ソースの INSERT/UPSERT ... SELECT が
小さい dmlMaxRows でも読み取り上限エラーにならなくなりました。
プラグイン・アプリテンプレートに変更はありません(zip は v1.7.0 のまま利用してください)。
