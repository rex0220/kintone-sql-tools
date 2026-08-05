ksql 配布パッケージ (v3.46.0)

release 成果物:
- ksql-plugin-v3.46.0.zip
- ksql-mcp.mcpb (manifest version 3.46.0)
- ksql-mcp.js (MCP server version 3.46.0)

新機能 (B124 集計算術式に GROUP BY キーの列と @変数) ★本リリースの要点:
- SUM(t.個数) * m.単価 のように、集計結果へ GROUP BY キーの列や @変数 を
  掛けられるようになりました。これまでは GROUP BY に含めている列でも
  ParseError になり、SUM(t.個数 * m.単価) と内側に書き換える必要がありました。
    SELECT m.製品番号, m.製品名, m.仕入価格,
           SUM(t.個数) * m.仕入価格 AS 在庫金額
    FROM APP1 m LEFT JOIN APP2 t ON m.製品名 = t.製品名
    GROUP BY m.製品番号, m.製品名, m.仕入価格
- SELECT 列と HAVING の両方で使えます。
- 集計関数から始まる形に限ります (単価 * SUM(a) は書けません)。
- GROUP BY に書いた表記と一致する列だけです。GROUP BY m.単価 に対して
  非修飾の 単価 は使えません。GROUP BY の式・関数・SELECT alias も不可です。
- ROLLUP / CUBE / GROUPING SETS では書けません (小計・総計行で値が定まらないため)。
- SUM(a) * 単価 と SUM(a * 単価) は同じ値になるとは限りません。小数では丸めの
  位置が違い、非数値の列では前者が NaN、後者が 0 になります。
- 既存の SQL の結果は変わりません。

新機能 (B125 集計のウィンドウ関数) (v3.45.0):
- SUM / COUNT / AVG / MIN / MAX を OVER (...) で使えるようになりました。
  従来は順位系 3 つ (ROW_NUMBER / RANK / DENSE_RANK) だけで、累積和が
  書けませんでした。在庫台帳の残高推移のような集計を SQL 内で書けます。
    SELECT 製品名, 日付, 個数,
           SUM(個数) OVER (
             PARTITION BY 製品名 ORDER BY 日付, レコード番号
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS 累積在庫
    FROM APP100
- フレームは標準 SQL 準拠です。ORDER BY があるときの既定は
  RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW、無いときは
  パーティション全体です。明示できるのは ROWS / RANGE の同じ固定境界だけです。
- RANGE と ROWS は「同順の行」で結果が変わります。同日 3 件の台帳なら
  RANGE は 3 行とも「その日を締めた残高」、ROWS は「取引ごとの残高」です。
  取引ごとが欲しい場合は ROWS を明示するか、ORDER BY にレコード番号などの
  タイブレークキーを足してください。EXPLAIN が実効フレームを表示します
  (既定のときだけ「(既定)」が付きます)。
- 取得上限に達した場合、onLimit=truncate でも部分結果を返さずエラーになります
  (complete input reason: AGGREGATE_WINDOW)。途中まで集めた入力で累計を出すと
  もっともらしい誤値になるためです。
- 非対応: 引数の DISTINCT、GROUP_CONCAT / 統計集計の OVER、移動フレーム
  (ROWS BETWEEN n PRECEDING)、LAG / LEAD、GROUP BY や通常集計との併用、
  ウィンドウ結果を同じ SELECT 内の式へ入れる形。いずれも専用の診断を出します。
  月次の累計は CTE を 2 段にして書いてください。
- SELECT DISTINCT との併用は従来どおり可能です。

修正 (B123 GROUP BY だけの SELECT で EXPLAIN が落ちる):
- SELECT 分類, COUNT(*) FROM APPx GROUP BY 分類 の実行計画を取ろうとすると
  エラーになっていました。ORDER BY を 1 つ足すと通るため、分かれ目は
  GROUP BY の有無ではなく「GROUP BY があり、WHERE も ORDER BY も無い」ことでした。
    修正前  No-op client should not be called. (MCP)
            DryRunError: API call should not happen in dry-run. (CLI)
    修正後  実行計画を返します。
- 誤った計画を返していたわけではありません (止まるべきでない所で止まっていました)。
  EXPLAIN がレコード API を呼ばない仕様は変わりません。
- 「JOIN や大量取得は EXPLAIN まで通す」という運用をしている場合、分析クエリは
  ほぼ全部 GROUP BY を含むため、これまで通せていなかったことになります。

修正と移行案内 (B119-B122) (v3.44.0):
- 集計まわりで「エラーを出さずに誤った値・行集合を返す」4 件を修正しました。
- B119 集計の引数に文字列関数を書くと 0 や空が返っていました。
    COUNT(DISTINCT UPPER(会社名)) → 0 (COUNT(DISTINCT 会社名) は 10)
- B120 CASE の中の集計が集計として扱われず、1 行のはずが 20 行返っていました。
- B121 HAVING に集計を直接書くと文字列比較になり、過大にも過小にも振れていました。
- B122 HAVING に集計を式でくるむと無言で 0 行になっていました。
- 移行案内: 該当する SQL の結果が変わります (今までが誤りです)。とくに HAVING で
  絞り込んでいた集計は対象の行集合そのものが変わります。該当しない SQL は不変です。

修正と移行案内 (B118) (v3.43.0):
- 関数の引数の数を検証するようになりました。これまでは黙認され、静かに誤った値を
  返していました。
    修正前  DATE_ADD(列, 1)     → 単位が無いのに DAY 扱いで通る
            ROUND(列, 1, 2)     → 余分な引数を黙って無視
    修正後  いずれも ArgumentError (ksql_validate でも実行前に検出)
- 移行案内: 引数の数が誤った呼び出しはエラーになります。とくに FORMAT(列) は
  FORMAT(列, パターン) が必要です。正しい呼び出しの結果は完全に不変です。
- 未知の関数名・誤った引数構文のメッセージが原因を名指しするようになりました。

v3.42.0 以前の変更内容:
- CHANGELOG.md と GitHub Releases に版ごとの内容と移行案内があります。
  https://github.com/rex0220/kintone-sql-tools/releases

1. ksql-plugin-v3.46.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.46.0): B124 集計算術式に GROUP BY キーの列と @変数 (新機能)。

- B124: 上の「新機能」を参照してください。

前リリース (v3.45.0): B125 集計のウィンドウ関数 (新機能)、B123 GROUP BY だけの
SELECT で EXPLAIN が落ちるのを修正。

前リリース (v3.44.0): B119-B122 集計まわりで静かに間違う 4 件を修正
(結果が変わります)。

前リリース (v3.43.0): B118 関数の引数の数を検証 (通っていた誤りがエラーになります)。

過去バージョンのプラグイン zip:
- 本ディレクトリには最新版だけを置いています。
- 過去版は GitHub Releases の各タグに添付しています。
  https://github.com/rex0220/kintone-sql-tools/releases

v3.31.0 以前の変更履歴:
- CHANGELOG.md に全版を記載しています。
- GitHub Releases でも版ごとに参照できます。
  https://github.com/rex0220/kintone-sql-tools/releases
- 古い版から一気に上げる場合は、間の版の破壊的変更に移行案内が付いています。
  CHANGELOG.md を版順に確認してください。
