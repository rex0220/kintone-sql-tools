ksql 配布パッケージ (v1.10.0)

1. ksql-plugin-v1.10.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.0.0.zip をアプリ作成時にテンプレートとして読み込む
3. アプリにプラグインを適用して利用開始する

v1.10.0: バッチ強化第1弾。
- ASSERT 文を追加(全ツール共通)。条件が成立しなければ AssertError で
  停止する実行時ゲートで、DML 前の件数ガードや CLI ヘルスチェック
  (exit code 監視)に使えます。バッチ内の ASSERT 失敗は continueOnError
  指定でも常に停止します(以降の文は skipped)。
- CLI: バッチ入力 + --format json で、MCP と同一のエンベロープ
  (ok / statements[] / results[])を単一 JSON で出力(破壊的変更 —
  従来の結果セット連結出力は廃止。詳細は CHANGELOG.md)。
- レート制御(同時リクエスト上限・GET リトライ回数・バックオフ)を
  CLI フラグ / ksql.config.json / 環境変数で調整可能に。書き込み系
  (POST/PUT/DELETE)は二重実行回避のためリトライしない仕様を明文化。
MCP サーバー(ksql-mcp.js / ksql-mcp.mcpb)は ksql_query が ASSERT を
実行できるようになりました(read-only 扱い)。
