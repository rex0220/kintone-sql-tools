ksql 配布パッケージ (v3.47.0)

release 成果物:
- ksql-plugin-v3.47.0.zip
- ksql-mcp.mcpb (manifest version 3.47.0)
- ksql-mcp.js (MCP server version 3.47.0)

改善 (B126 選択系の = / != を自動で押し下げる) ★本リリースの要点:
- WHERE 区分 = '出庫' のような選択系フィールドの等値比較が、これまで kintone 側で
  絞り込まれず全件取得になっていました。kintone のクエリ構文が選択系に in / not in
  しか受け付けないためで、IN ('出庫') と書けば絞り込めましたが、エラーも警告も
  出ないので踏んでも気づけませんでした。
    修正前  WHERE 入出庫区分 = '出庫'  → fetch: ALL   (全件取得して JS で判定)
    修正後  WHERE 入出庫区分 = '出庫'  → fetch: EXACT (kintone 側で絞り込む)
- 書き換えは不要です。エンジンが = 'X' を IN ('X') へ、!= 'X' (<> 含む) を
  NOT IN ('X') へ正規化します。利用者が最初からそう書いた場合と同じ経路を通ります。
- 結果は変わりません。kSQL は押し下げ後も元の WHERE をローカルで再評価するため、
  押し下げは「どの候補を取りに行くか」だけを変えます。
- EXPLAIN に「pushdown normalized:」行が出ます。書いた SQL と kintone query の
  食い違いはこれで説明されます。
- 対象は単一値の選択系だけです (ラジオボタン・ドロップダウン・ステータス等)。
  チェックボックス・複数選択・ユーザー選択などの複数値フィールドは対象外です
  (IN が「いずれかを含む」判定になり、= と意味が変わるため)。
- 定義に無い選択肢値のときは正規化しません。= '存在しない値' は従来どおり 0 行です
  (IN ('存在しない値') と書くと kintone が GAIA_IQ10 を返すため)。

新機能 (B127 ウィンドウ関数の既定フレームを警告):
- 集計ウィンドウで ORDER BY を書き ROWS / RANGE を明示していないとき、既定は
  標準 SQL どおり RANGE で、ORDER BY の値が同じ行はすべて同じ値になります。
  同日取引のある台帳では「その日を締めた残高」が並び、取引ごとの残高を期待して
  書くとエラー無しで別の意味の値が返っていました。
- warnings に注意を出すようにしました。行ごとの値が必要なら
  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示するか、
  ORDER BY にレコード番号などのタイブレークキーを足してください。
- ORDER BY にレコード番号や $id を含み、単一アプリ・JOIN なし・サブテーブルなし・
  CTE / UNION を経ていないときは全順序が保証されるので警告を出しません。

修正 (B132 ksql_docs のセクションキー):
- window-functions だけ章番号が付いていませんでした。10-1-window-functions へ
  改めました。旧キーも引き続き解決できます (索引には出しません)。

新機能 (B124 集計算術式に GROUP BY キーの列と @変数) (v3.46.0):
- SUM(t.個数) * m.単価 のように、集計結果へ GROUP BY キーの列や @変数 を
  掛けられるようになりました。
- 集計関数から始まる形に限ります。GROUP BY に書いた表記と一致する列だけです。
- ROLLUP / CUBE / GROUPING SETS では書けません。
- SUM(a) * 単価 と SUM(a * 単価) は同じ値になるとは限りません。小数では丸めの
  位置が違い、非数値の列では前者が NaN、後者が 0 になります。

新機能 (B125 集計のウィンドウ関数) (v3.45.0):
- SUM / COUNT / AVG / MIN / MAX を OVER (...) で使えるようになりました。
    SELECT 製品名, 日付, 個数,
           SUM(個数) OVER (
             PARTITION BY 製品名 ORDER BY 日付, レコード番号
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS 累積在庫
    FROM APP100
- フレームは標準 SQL 準拠です。RANGE と ROWS は「同順の行」で結果が変わります。
- 取得上限に達した場合、onLimit=truncate でも部分結果を返さずエラーになります。
- 非対応: 引数の DISTINCT、GROUP_CONCAT / 統計集計の OVER、移動フレーム、
  LAG / LEAD、GROUP BY や通常集計との併用、ウィンドウ結果を式へ入れる形。

修正 (B123 GROUP BY だけの SELECT で EXPLAIN が落ちる) (v3.45.0):
- SELECT 分類, COUNT(*) FROM APPx GROUP BY 分類 の実行計画が取れませんでした。
  分かれ目は GROUP BY の有無ではなく「GROUP BY があり WHERE も ORDER BY も無い」こと
  でした。現在は集計クエリも EXPLAIN を通せます。

v3.44.0 以前の変更内容:
- CHANGELOG.md と GitHub Releases に版ごとの内容と移行案内があります。
  https://github.com/rex0220/kintone-sql-tools/releases

1. ksql-plugin-v3.47.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.47.0): B126 選択系の = / != を自動で押し下げ (改善)、
B127 ウィンドウ既定フレームの警告 (新機能)、B132 docs セクションキーの番号 (修正)。

- B126 / B127 / B132: 上の各節を参照してください。

前リリース (v3.46.0): B124 集計算術式に GROUP BY キーの列と @変数 (新機能)。

前リリース (v3.45.0): B125 集計のウィンドウ関数 (新機能)、B123 GROUP BY だけの
SELECT で EXPLAIN が落ちるのを修正。

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
