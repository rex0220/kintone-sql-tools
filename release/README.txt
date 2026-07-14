ksql 配布パッケージ (v2.0.0)

1. ksql-plugin-v2.0.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

v2.0.0: LIKE を JavaScript 評価のみに統一(Breaking)。
- LIKE / NOT LIKE はワイルドカードの有無にかかわらず kintone へ送らず、
  JavaScript で評価します。ワイルドカードなしは kSQL 独自の部分一致です。
- LIKE を含む SELECT は FULL_SCAN です。一致件数にかかわらず全走査件数が
  maxRecords に到達し得ます。既定は上限エラーで、truncate を選ぶと上限以降の
  一致行を欠落させる可能性があります。
- 通常の親 UPDATE / DELETE では全 LIKE を拒否します。上限エラーのない SELECT で
  対象レコード番号を確認し、IN / 完全一致で対象を指定してください。
  サブテーブル DML は従来どおり JavaScript で評価します。

v1.14.0: WHERE 右辺フィールド比較の誤結果と LIKE のモード依存を修正(挙動変更・安全上の制限)。
- WHERE 右辺のフィールド参照・文字列関数が数値化されて文字列比較が
  誤っていた問題を修正(例: 文字列 = 文字列 が一致しない、JOIN の
  != 突き合わせで完全一致行が残る)。右辺も文字列のまま比較します。
  数値フィールド同士・算術式(税込 = 金額 * 1.1)は従来どおりです。
- ワイルドカード(% / _)付き LIKE / NOT LIKE を kintone へ送らず
  JavaScript で言語仕様どおり(田% は「田で始まる」等)評価するよう
  統一。従来は実行モード(SIMPLE / FULL_SCAN)で同じ SQL の結果が
  食い違うことがありました。該当 SELECT は FULL_SCAN(全件取得)に
  なります。部分一致が必要な場合は %会社% のように明示してください。
- 安全上の制限: 通常の親レコードへの UPDATE / DELETE で
  ワイルドカード付き LIKE を拒否(誤更新・誤削除防止)。先に SELECT で
  対象レコード番号を確認し、IN / 完全一致で対象を指定してください。
  サブテーブル DML は JavaScript 評価のため従来どおり使用できます。
- これらの修正はプラグインにもバンドルされており、クライアント側の
  WHERE 評価・EXPLAIN に反映されます。
- 詳細は CHANGELOG.md と
  docs/internal/ksql_where_rhs_field_and_like_mode_divergence_issue.md を参照。

v1.13.2: CLI / MCP の表示修正(プラグインは EXPLAIN 表示のみ変更)。
- 単文 --dry-run(EXPLAIN)のプラン出力に内部 mapped アプリ表記が
  露出していた問題を修正。v1.13.1 ではバッチ dry-run のみ復元しており、
  単文では SELECT / DML とも内部 mapped ID を表示する場合がありました。
- DML の実行計画ヘッダを仕様 §9.2 準拠にし、書き込み先ラベルを app: から
  target: へ変更。CLI / MCP の論理参照は target: LAPP_ORDERS -> APP1234@prod
  のように論理名と物理 ID・profile を明示します(物理参照は target: APP1234@prod)。
- プラグインも EXPLAIN エンジンをバンドルするため、クライアント側 EXPLAIN の
  DML ヘッダが app: から target: へ変わります(プラグインは論理アプリ非対応の
  ため矢印形は出さず target: APP<id> (<id>) 表記。EXPLAIN 表示のみの変更で
  ルーティング等の挙動は変わりません)。
- 詳細は CHANGELOG.md を参照。

v1.13.1: CLI / MCP のバグ修正(プラグインの挙動変更なし)。
- CLI で LAPP_<NAME> を含む SQL が失敗した際、parser / 実行エラーの
  位置とテーブル表記を元 SQL へ復元するようにしました。v1.13.0 では
  CLI stderr が正規化後 SQL の位置や内部 mapped アプリ表記を表示する
  場合がありました(MCP は当初から復元済み)。
- 保存クエリの一部テストがリポジトリ直下の config へ暗黙依存していた
  問題を解消(利用者の挙動には影響しません)。
- プラグインの内容は v1.13.0 から変更ありません(バージョン番号のみ同期)。
- 詳細は CHANGELOG.md を参照。

v1.13.0: CLI / MCP に論理アプリ参照 LAPP_<NAME> を追加(プラグインの挙動変更なし)。
- 環境や配置先で物理アプリ ID が異なる同用途アプリに対し、
  FROM LAPP_ORDERS のような論理名で SQL / 保存クエリを再利用できます。
  論理名は profile ごとの config logicalApps で物理 ID へ解決されます
  (例: dev→APP899 / prod→APP1234)。
- 既存の APPxxx は常に物理 ID のままで、暗黙に論理解決されません。
  未定義論理名は API 呼び出し前にエラーとなり、誤 route しません。
- profile 単位で allowPhysicalAppRefs: false を指定すると、その profile の
  kSQL SQL 内で物理 APPxxx 直接参照を拒否できます(既定 true・後方互換)。
- validation / EXPLAIN が論理名・物理 ID・profile を表示します。
- 論理アプリ参照は CLI / MCP のみの機能で、プラグインの挙動は変わりません。
- 詳細は CHANGELOG.md と docs/ksql_language_reference.md を参照。

v1.12.1: CLI / MCP のトークン解決バグを修正(プラグインの挙動変更なし)。
- SQL コメント・文字列リテラル・バッククォート識別子の中に書いた
  APPxxxx を、トークン解決の対象から除外しました。
- 従来は生 SQL を素の正規表現で走査していたため、
  "-- 通知(APP4206)" のようなコメントや 'APP4206の件' のような
  文字列に現れたアプリ番号まで参照アプリとみなし、profile の
  tokenMap に無いと token is missing で実行不能になっていました。
- 本文の FROM APPxxxx(@profile / $subtable 付き含む)は
  従来どおり解決します。誤って要求していたトークンを要求しなく
  なる方向のみの変更で、後方互換です。
- 詳細は CHANGELOG.md と
  docs/internal/ksql_extract_app_ids_comment_string_issue.md を参照。

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
