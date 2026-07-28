ksql 配布パッケージ (v3.32.0)

release 成果物:
- ksql-plugin-v3.32.0.zip
- ksql-mcp.mcpb (manifest version 3.32.0)
- ksql-mcp.js (MCP server version 3.32.0)

破壊的変更の移行案内 (B89 / B90):
- engine ライブラリの runBatch と explainQuery が EXPLAIN UPDATE / DELETE / INSERT /
  UPSERT を READ_ONLY_VIOLATION で拒否します。read-only ライブラリで DML の計画を出す
  用途は元から想定しておらず、explainQuery は従来も拒否していました。EXPLAIN は計画
  だけで書き込まないため、誤った結果を得ていた利用者はいません。EXPLAIN SELECT は
  従来どおり通ります。
- 算術式に非数値の変数を使うと ArgumentError で停止します。新しい直接算術だけでなく、
  従来から動いていた ROUND(算術式, ...) などの関数経路も対象です。従来はエラーも警告も
  なく NaN を返していました。数値変数の結果は変わりません。
    修正前: DECLARE @phase = '受注'; SELECT ROUND(売上 * 100 / @phase, 1) FROM APPn
    → NaN
    修正後: 同じ SQL が variable @phase is not numeric ... で停止

1. ksql-plugin-v3.32.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.32.0): B95 打ち切りの構造化／B94 COUNT(*) の単発取得／B93。

- B94: 単一アプリの SELECT COUNT(*) だけのクエリは、WHERE が完全に押し下がる場合、
  kintone REST の totalCount で 1 回の GET で件数を返します。従来は $id を全件取得して
  数えており、10 万件なら 200 回以上の往復が必要でした。
- B94: この経路では maxRecords / onLimitReached を適用しません。レコード本体を取得しない
  ためです。MCP の既定 maxRecords は 500 なので、500 件を超えるアプリの件数取得は従来
  FetchAllLimitError で失敗していましたが、正しい総件数を返すようになります。
- B94: 押し下げできない WHERE、JOIN、GROUP BY、COUNT(列) などは従来の全件取得のままです。
  BYO クライアントが totalCount を返さない場合も 0 と推測せず全件取得へ落とします。
  検索が 10 万件で打ち切られた場合は SearchAbortedError で停止します。
- B95: 取得上限で打ち切られたかどうかを QueryMetrics.limitReached で判別できます。
  従来は警告の文言を照合するしかなく、metrics.fetchedRows は全アプリの合算なので
  JOIN では合計が上限を超えても打ち切られていませんでした。
    if (result.metrics.limitReached) { ... }
  どのアプリかは limitReachedApps に重複なし・昇順で入ります。判定には limitReached を
  使ってください。両方とも任意プロパティなので、既存の利用者コードは変更不要です。
- B93: BYO クライアントの getFields() が未知の fieldType を返したときのエラーが、
  エンジンの不具合ではなくクライアント契約の違反として読める文面になります。
  原因のフィールドコードと期待する契約を含みます。fields.json のフィールドだけを返し、
  $id と $revision は足さないでください（エンジンが合成します）。

前リリース (v3.31.1): B92 v3.31.0 の回帰修正（EXPLAIN と変数の算術）。

- v3.31.0 では、変数を算術に使うバッチを EXPLAIN すると必ず失敗しました。従来から
  動いていた ROUND(算術式, ...) の形も対象でした。EXPLAIN は変数を評価しないため
  名前をプレースホルダーとして保持しますが、非数値チェックが文字列変数と誤認して
  いました。実行時に非数値の変数を算術へ使った場合は従来どおり停止します。

前リリース (v3.31.0): B89 explainQuery のバッチ対応／B90 変数の直接算術／B87／B88。

- B89: engine ライブラリの explainQuery が複文を受け付けます。受理する文の集合を
  runBatch と揃えたため、CREATE TEMP TABLE / SET / DECLARE / VALIDATE / SHOW APPS /
  DESCRIBE / ASSERT を含むバッチも検証できます。単文の VALIDATE APPn も通ります。
  複文の計画は lines に [n] TYPE の見出し付きで返し、単文の出力は変わりません。
- B89: バッチの静的検証エラーに statementIndex と statementType が載ります。
  runBatch と explainQuery の両方が対象です。従来はどの文が原因か分かりませんでした。
- B90: SELECT 列の算術式へ数値バッチ変数を直接書けます。
    SET @total = (SELECT SUM(売上) FROM #g);
    SELECT (売上 * 100) / @total AS 構成比 FROM #g
- B87: アプリ定義のキャッシュを実行単位にしました。kintone 側で項目を追加したり制約を
  変更したりした結果が、プロセスを再起動しなくても次の実行から反映されます。
  常駐プロセス (MCP サーバー・engine ライブラリ) では、1 実行 1 アプリあたり
  fields.json の取得が 1 回増えます。1 回の実行の中での重複排除は従来どおりです。
- B88: 0 行の SELECT * が列を失わなくなりました。一時テーブルや CTE へ伝播していたため、
  データがある日は動き 0 件の日だけ落ちるという壊れ方をしていました。サブテーブル
  仮想テーブルも対象です。v3.30.0 で残る限界としていた JOIN 入力のエラーも解消します。

前リリース (v3.30.0): B86 実体化ソースの不存在列を fail-closed 化／B83／B84／B85。

- 注意: B86 は破壊的変更です。CTE・一時テーブル・SHOW APPS / DESCRIBE の結果や
  サブテーブル・UNION 枝・混在 JOIN で、存在しない列を参照する SQL がエラーになります。
- 従来は不存在列を空文字として評価していました。LIKE では全件一致、= では 0 件、
  INSERT ... SELECT では空文字レコードの書き込みが起きていました。
  現在成功して見えるクエリは実際には誤った結果を返しているため、
  エラー化によって正しい結果が失われることはありません。
- 移行方法: 値のつもりで書いた裸の語は文字列リテラルとして引用してください。
  誤 WHERE アプリ名 LIKE 顧客  →  正 WHERE アプリ名 LIKE '顧客'
- 混在 JOIN では物理アプリ側の不存在列も同じ検査で拒否します。
  検査に失敗した場合、レコード取得も書き込みも行いません。

- B85: engine ライブラリの VALIDATE がどの制約を検証したかを開示します。
  ReadonlyFieldInfo に required / minLength / maxLength / minValue / maxValue を
  宣言し、validateStats.constraintMetadata に present / absent を返します。
  createReadonlyKintoneClient の利用者は変更不要です。
- B84: 押し下げ可否を言語リファレンスへ公開しました（実装から生成・照合）。
- B83: MCP の VALIDATE 診断列の説明を 9 列 / SUMMARY 5 列の 2 形明記へ修正しました。

過去バージョンのプラグイン zip:
- 本ディレクトリには最新版だけを置いています。
- 過去版は GitHub Releases の各タグに添付しています。
  https://github.com/rex0220/kintone-sql-tools/releases

v3.29.0 以前の変更履歴:
- CHANGELOG.md に全版を記載しています。
- GitHub Releases でも版ごとに参照できます。
  https://github.com/rex0220/kintone-sql-tools/releases
- 古い版から一気に上げる場合は、間の版の破壊的変更に移行案内が付いています。
  CHANGELOG.md を版順に確認してください。
