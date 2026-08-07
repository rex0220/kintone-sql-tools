ksql 配布パッケージ (v3.59.0)

release 成果物:
- ksql-plugin-v3.59.0.zip
- ksql-mcp.mcpb (manifest version 3.59.0)
- ksql-mcp.js (MCP server version 3.59.0)

新機能 (B149 GENERATE_SERIES 整数・日付系列の生成) ★要点:
- WITH の中に GENERATE_SERIES(start, stop [, step]) を書くと、入力レコード無しで
  整数または日付 (DATE) の連続系列を生成します。
    WITH 日付系列 AS (
      GENERATE_SERIES('2026-08-01', '2026-08-04', '1 day') AS 日付
    ),
    日別 AS (SELECT 日付, SUM(金額) AS 合計 FROM APP100 GROUP BY 日付)
    SELECT s.日付, CASE WHEN d.合計 = '' THEN 0 ELSE d.合計 END AS 合計
    FROM 日付系列 AS s LEFT JOIN 日別 AS d ON s.日付 = d.日付
    ORDER BY s.日付
  取引の無い日が 0 で並びます (GROUP BY はデータのある日しか行を作りません)。
- 境界は PostgreSQL 準拠: stop ちょうどは含む / 超える値は含まない / 向きが逆なら
  0 行 / step 0 はエラー / 負 step 可。日付 step は '1 day' / '-14 days' 形式 (day のみ)。
- 生成上限 10,000 行 (WITH 文内の合計。LIMIT では回避できません)。
- 月・年単位 / 小数 / DATETIME / TIME / FROM 直置きは未対応です (専用の診断が出ます)。
- 生成列を直接読むウィンドウ (LAG の前日比など) では「全順序でない」警告が出ません。
  JOIN などで一意性が壊れ得る形では従来どおり警告が出ます。
- DECLARE @today = TODAY() を日付の終端に使えます。保存クエリ (read-only) でも使えます。
- レコード API は一切呼びません (EXPLAIN 含む)。

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

1. ksql-plugin-v3.59.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.59.0): B149 GENERATE_SERIES 整数・日付系列の生成 (新機能・
LEFT JOIN で「取引の無い日を 0 として並べる」が書けます)。

前リリース (v3.58.0): B147 集計・ウィンドウの別名が入力フィールドを上書きしていた
(挙動が変わります)、B140 無視してよい条件を書く (改善)。

前リリース (v3.57.0): B148 集計されていない列はエラーに (挙動が変わります)。

前リリース (v3.56.1): B145 拡張 grouping で明細項目を書くとエラーに
(挙動が変わります)、GROUP BY の案内を「別の表にある」へ。

前リリース (v3.56.0): B145 DESCRIBE に サブテーブル 列を追加
(挙動が変わります・SELECT * が 7→8 列)、親から明細項目を選んだら警告 (改善)。

前リリース (v3.54.0): B142 値が無いときの MIN / MAX が空文字に (挙動が変わります)。

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
