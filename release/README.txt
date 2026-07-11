ksql 配布パッケージ (v1.12.0)

1. ksql-plugin-v1.12.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

v1.12.0: GROUP BY なし集計の 0 件時挙動を SQL 標準に準拠(挙動変更)。
- GROUP BY のない集計 SELECT は対象 0 件でも常に 1 行を返します
  (COUNT は 0、SUM / AVG / MAX / MIN も 0。GROUP BY がある場合は
  従来どおり 0 行)。
- これにより健全性チェックの定番
  ASSERT (SELECT COUNT(*) FROM ... WHERE 異常条件) = 0
  が該当 0 件(健全時)に成立するようになりました(従来は
  「scalar subquery returned no rows」エラーで失敗)。
- 波及する挙動変更(いずれも標準準拠化):
  WHERE / SELECT 列 / UPDATE SET のスカラーサブクエリが 0 に解決、
  IN (SELECT COUNT(*)...) は {0} との照合、
  EXISTS (SELECT COUNT(*)...) は常に真、
  CREATE TEMP TABLE ... AS SELECT COUNT(*) は 0 件でも 1 行実体化、
  INSERT ... SELECT COUNT(*) は 0 件でも 1 行書き込み。
- 詳細は docs/ksql_language_reference.md §8「0 件時の挙動」と
  CHANGELOG.md を参照してください。
