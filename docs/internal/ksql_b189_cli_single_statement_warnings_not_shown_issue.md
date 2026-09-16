# B189 CLI のテキスト／csv／markdown 表示は単文 SELECT の `warnings` をどこにも出さない — JSON とバッチ表示（B188 後）だけが見える

- 状態: 🚧 **codex が案 A を実装・Claude レビュー済み（2026-09-16・`b188/dev`・コミット待ち・[報告](ksql_b189_codex_impl_report.md)）**。単文 SELECT の非 JSON 出力後に `warning=<文言>` を stderr へ（`--quiet` で抑止・json は `warnings` 配列のまま）。stdout は 4 スナップショットで不変を固定。実機で table / csv の stderr に RANGE 警告と B187 の未解決集計警告が出ることを確認。起票時の実測 v3.78.0 + B188（CLI 再ビルド版・dev profile・SFA パック）。改善（表示のみ・結果不変・規模 S）。v3.79.0

## 1. 現象

| 入力 | `--format` | エンジンの `warnings` | CLI の表示 |
| :--- | :--- | :--- | :--- |
| 単文 `SELECT … SUM(売上) OVER (ORDER BY 売上) AS 累計 …` | table（既定） | 既定フレーム（RANGE）警告 1 件 | **なし**（stdout・stderr とも） |
| 同上 | csv / markdown | 同上 | **なし** |
| 同上 | json | 同上 | `warnings: [...]` に載る |
| 単文 `… GROUP BY … HAVING SUM(売上) > …`（B187） | table | 「比較条件で参照した集計値を確認できません。…」 | **なし** |
| バッチ `SELECT …; SELECT 1` | table | 文 1 に同じ警告 | `[1] SELECT success rowCount=6 warning=…`（**B188 で出るようになった**） |

- CLI のテキスト経路（`src/cli/index.ts`）で `warnings` を参照しているのは JSON 出力（`:916`）とバッチ文サマリ（`:1190`・B188）だけ。単文の table / csv / markdown 出力は結果表だけを書く
- MCP（`ksql_query`）は応答の `warnings` にそのまま載るので AI には見える。プラグインは実行画面に警告表示がある。**CLI の人間向け表示だけが穴**

## 2. なぜ問題か

- 第 7 回（CLI 定期運用）の主経路は `ksql -f weekly.sql --quiet` のテキスト実行。RANGE 既定フレームや未解決集計の警告は、この経路の利用者に一度も届かない
- B188 でバッチ文には出るようになったため、「単文なら出ない・`;` を足すと出る」という新しい非対称ができた
- B187（HAVING の未掲載集計）を「警告も出ない」と誤って起票した直接の原因。表示の穴は診断の穴と同じ結果を生む

## 3. 対応案

**案 A（stderr に出す・純加法）**: 単文 SELECT（table / csv / markdown）の実行後、`warnings` を 1 行ずつ **stderr** に `warning: <文言>` で出す。stdout は結果表のままなので、csv / markdown をパイプやリダイレクトで使う既存運用を壊さない。`--quiet` は既存の意味（進捗・サマリ抑止）に合わせ、警告を抑止するかどうかは既存フラグの設計に従う（抑止しないのが推奨＝警告は `--quiet` でも見えるべき）。バッチ文サマリ（B188）の `warning=` は stdout のままで既存どおり
- 表示形式は B188 の `warning=` と揃えるか `warning:` にするかを 1 つに決める（新しい形式を 2 つ作らない）
- `--export-csv`（B179）の書き出し時も同じ stderr 出力

**案 B（table 出力の末尾に注記）**: stdout の表の後に空行 + `警告: …` を出す。csv / markdown では混入するので table 限定になり、形式ごとに違う扱いになる。採らない

## 4. 受入条件

- §1 の 4 形（table / csv / markdown / HAVING 未掲載集計）で警告文が stderr に出る。stdout は修正前と 1 バイトも変わらない（csv / markdown のスナップショット）
- JSON 出力は不変。バッチ表示（B188）は不変
- 警告の無い単文では stderr に何も増えない
- `--quiet` との組み合わせの挙動を 1 本固定
- 既存の CLI e2e（`src/cli/__tests__/`）が通る

## 5. 経緯

- 2026-09-16: B187 案 B の依頼書を書く前に JSON で再測定し、エンジンは警告を出していることを確認。CLI テキストで見えなかっただけと分かり、B187 を訂正して本件を分離。B188 のレビューで「CLI テキストはバッチの SELECT 警告をどこにも出していなかった」と気づいていたが、単文も同じだと確かめていなかった
- 関連: [B187](ksql_b187_having_aggregate_not_in_select_silent_empty_issue.md)、[B188](ksql_b188_temp_table_window_range_warning_not_surfaced_issue.md)、B140-C（RANGE 警告の文言）
