ksql 配布パッケージ (v3.76.0)

release 成果物:
- ksql-plugin-v3.76.0.zip
- ksql-mcp.mcpb (manifest version 3.76.0)
- ksql-mcp.js (MCP server version 3.76.0)

機能追加 (B178: /flow IMPORT source の materialize 通知・純加法・既定動作は不変):
- createExecutionContext に onImportSourceMaterialized callback を追加しました
  (kSQL-Flow Contract v1.1 の input_files[].rows を埋めるため)。IMPORT source の
  decode と raw materialize が成功した直後、projection・validation・mutation より前に
  1 回 await され、{ statementIndex, name, kind, rows, encoding } の 5 key だけを渡します。
- rows は CSV = header を除く RFC 4180 data record 数 (quoted cell 内改行は 1 行・
  subtable CSV は継続行を含む物理行)、JSON = top-level record 数。encoding は
  SQL ENCODING > loader metadata > UTF-8 の解決後の値です。
- maxRecords 超過・decode 失敗・source 境界エラーでは通知しません。callback の throw /
  reject は当該文 error になり、その文の mutation API は 0 回です。
- callback を指定しない既存利用者の結果・API 呼出し回数は v3.75.0 から変わりません。
  CLI / MCP / プラグインは不変です。

v3.75.0 の節は畳みました (B177 /flow named IMPORT source 公開 API = enableImport 既定 OFF・
  lazy Uint8Array loader・安定 error code。CLI/MCP/プラグインの IMPORT source エラー
  name/message は細分化)。
v3.74.0 の節は畳みました (B176 EXPLAIN の native UPSERT 適格性が常に UNKNOWN だった修正 =
  対象アプリのフォーム定義を 1 回取得して判定。native UPSERT 本体は不変)。
v3.73.0 の節は畳みました (B173 native UPSERT = /flow は既定 ON・CLI は --native-upsert /
  B175 KLIKE 索引ラグの文書化)。
  MCP、プラグイン、engine-library。いずれも従来の経路と結果のままです。
- CLI は --allow-dml --native-upsert を明示した実行だけが同じ経路を使います。
- EXPLAIN が native の適格性を表示します (MCP / プラグイン / CLI)。

v3.72.0 の節は畳みました (B171 ASSERT 大小比較の辞書順修正 = fail-open 解消 /
  B171 F-2 dialect 1 の INSERT VALUES で as-of 関数)。
v3.71.0 の節は畳みました (B170 E-2 previewStatement = dry-run 差分プレビュー)。
v3.70.0 の節は畳みました (B170 E-6/E-3/E-5/E-1 = /flow 純加法 4 件)。
v3.69.0 の節は畳みました (B168 Flow dialect 1 完成 = Stage 4-6・全面で実行可)。
v3.68.0 の節は畳みました (B168 Stage 1-3 = dialect 1 の解析基盤・エンジン内部のみ)。
v3.67.0 の節は畳みました (B169 CURRENT_DATE/CURRENT_TIMESTAMP を文単位の固定時刻へ =
結果が変わる形あり)。内容は CHANGELOG.md にあります。

v3.66.1 の節は畳みました (B167 バッチ EXPLAIN の一時テーブル JOIN 失敗の修正 =
EXPLAIN 面のみ・実行は不変)。内容は CHANGELOG.md にあります。

v3.66.0 の各節は畳みました (B53 WITH RECURSIVE / CYCLE = 再帰 CTE・新機能 /
B166 JOIN ON 逆順の修正 / B160 警告文言の一般化・B165 再帰診断とレシピ)。
内容は CHANGELOG.md にあります。

v3.65.0 の各節は畳みました (B164 @変数を含む集計の比較位置の誤り = 結果が変わる修正)。
内容は CHANGELOG.md にあります。

v3.64.0 の各節は畳みました (B162/B163 EXPLAIN だけが通らない 2 形の解消)。
内容は CHANGELOG.md にあります。

v3.63.0 の各節は畳みました (B158 CROSS JOIN = 直積・2 軸格子・CROSS が予約語に /
B159 GENERATE_SERIES month/year step = 月次 0 埋め・start は月初/年初限定 /
B157/B161 dry-run 修正)。内容は CHANGELOG.md にあります。

v3.62.0 の各節は畳みました (B155 WHERE 絞り込みを CTE・一時テーブル JOIN と単一表へ
拡大 = 結果不変・取得量削減 / B154 EXPLAIN 但し書き)。内容は CHANGELOG.md にあります。

v3.61.0 の各節は畳みました (B150 結合キー押し下げの型対応 = 日付キー JOIN の
GAIA_IQ03 解消 / B153 空キー JOIN 一致の欠落修正 = 結果が変わります)。
内容は CHANGELOG.md にあります。

v3.60.0 の各節は畳みました (B151/B152 JOIN の押し下げを kintone 演算子表へ全面整合 =
結果不変・取得量削減。不正値の kintone エラーは表面化)。内容は CHANGELOG.md にあります。

v3.59.0 の各節は畳みました (B149 GENERATE_SERIES 整数・日付系列の生成 = WITH の中で
系列を生成し、LEFT JOIN で「取引の無い日を 0 として並べる」が書けます)。
内容は CHANGELOG.md にあります。

v3.58.0 の各節は畳みました (B147 集計・ウィンドウの別名が入力フィールドを上書きしていた
= 挙動が変わります・CASE は分類が反転 / B140 無視してよい警告の条件を明記)。
内容は CHANGELOG.md にあります。

v3.57.0 の各節は畳みました (B148 集計されていない列はエラーに = 挙動が変わります /
エラー文の改善)。内容は CHANGELOG.md にあります。

v3.56.2 / v3.56.3 の各節は畳みました (B145 警告文が症状と合っていなかった /
HAVING は黙って 0 行になる / B101 常駐 MCP の版を ksql_docs で確かめられるように)。
内容は CHANGELOG.md にあります。

v3.56.0 / v3.56.1 の各節は畳みました (B145 DESCRIBE に サブテーブル 列を追加 =
SELECT * の列数が 7 → 8 / 親から明細項目を選ぶと警告 / 拡張 grouping で明細項目を
書くとエラーに / GROUP BY の案内を「別の表にある」へ / 句ごとの挙動を §19 に表で)。
いずれも挙動が変わる版です。内容は CHANGELOG.md にあります。

v3.55.0 の各節は畳みました (B144 サブテーブルの SELECT で親項目の条件を押し下げる /
サブテーブルの COUNT(*) は親を全件取得する)。内容は CHANGELOG.md にあります。

v3.54.0〜v3.54.4 の各節は畳みました (B142 値が無いときの MIN / MAX が 0 から空文字へ
= 挙動が変わります・DML では書き込む値が変わります / B141 除数ガードと文書の機械照合 /
B143 EXPLAIN は warnings を返さない)。内容は CHANGELOG.md にあります。

v3.50.0〜v3.53.0 の各節は畳みました (B128 LAG / LEAD = 前月比を SQL 側で /
B137 列数の違う UNION をエラーに / B140 実行できないタイブレーク助言を出さない /
レシピ R17 / B138 文書の構造検査 / B136 再発防止 / B139 CHANGELOG 検査)。
内容は CHANGELOG.md にあります。

v3.49.0 以前の各節は畳みました (B130 DESCRIBE の値の由来 / B129 ウィンドウ診断と
レシピ R15 / B136 文書の例の訂正 / B135 mcp:smoke の期待値 / B133 保存クエリの複文と
変数注入 / B126 選択系の押し下げ / B127 ウィンドウ既定フレームの警告 / B132 docs キー /
B124 集計算術式 / B125 集計のウィンドウ関数 / B123 GROUP BY だけの EXPLAIN)。
内容は CHANGELOG.md と GitHub Releases にあります。

- CHANGELOG.md と GitHub Releases に版ごとの内容と移行案内があります。
  https://github.com/rex0220/kintone-sql-tools/releases

1. ksql-plugin-v3.76.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.76.0): B178 /flow IMPORT source の materialize 通知 onImportSourceMaterialized (純加法)

前リリース (v3.75.0): B177 /flow named IMPORT source 公開 API (既定 OFF・純加法)

前リリース (v3.74.0): B176 EXPLAIN の native UPSERT 適格性が常に UNKNOWN だった修正

前リリース (v3.73.0): B173 UPSERT を kintone native UPSERT へ (/flow は既定 ON・
挙動が変わります・API 消費 1/3)、CLI の --native-upsert、EXPLAIN の適格性表示。

前リリース (v3.72.0): B171 ASSERT 大小比較の辞書順不具合を修正 (結果が変わります)、
B171 F-2 dialect 1 の INSERT VALUES で as-of 関数 (純加法)。

前リリース (v3.71.0): B170 E-2 previewStatement (dry-run 差分プレビュー・/flow 純加法)。

前リリース (v3.70.0): B170 ksql-flow 依頼対応 (/flow 純加法 = explain as-of・DML 結果型・metrics スナップショット・書込チャンク通知)。

前リリース (v3.69.0): B168 Flow dialect 1 完成 (Stage 4-6・全面で実行可・公式 API /flow)。

前リリース (v3.68.0): B168 Flow dialect 1 の解析基盤 (Stage 1-3・エンジン内部のみ・実験的)。

前リリース (v3.67.0): B169 CURRENT_DATE() / CURRENT_TIMESTAMP() を文単位の固定時刻評価へ修正 (結果が変わる形あり)。

前リリース (v3.66.0): B53 WITH RECURSIVE / CYCLE (再帰 CTE・新機能)。B166 JOIN ON 逆順の修正・B160/B165 同梱。

前リリース (v3.66.1 以前) の節は畳みました (B167 / B164 / B162・B163 ほか)。CHANGELOG.md と GitHub Releases を参照してください。
過去バージョンのプラグイン zip:
- 本ディレクトリには最新版だけを置いています。
- 過去版は GitHub Releases の各タグに添付しています。
  https://github.com/rex0220/kintone-sql-tools/releases

v3.44.0 以前の変更履歴:
- CHANGELOG.md は v3.45.0 以降だけを保持しています。
- それ以前は GitHub Releases の各タグを参照してください。
  https://github.com/rex0220/kintone-sql-tools/releases
- 古い版から一気に上げる場合は、間の版の破壊的変更に移行案内が付いています。
  各タグのリリースノートを版順に確認してください。
