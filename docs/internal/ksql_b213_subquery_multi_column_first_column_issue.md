# B213 サブクエリが 2 列以上を返しても、先頭の列で黙って続く

- 状態: 📝 **保留（2026-11-10 Takashi「B213 として起票、対応は保留。ただしく1項目を指定している場合、問題ない」）**
- 種別: 正しさ（fail-open。**サブクエリに 1 項目を正しく指定していれば起きない**。列を 2 つ書いた・`SELECT *` で書いたときに止まらず、先頭の列を使う。`UPDATE … SET` では誤った値を書く）
- 優先: 低（正しく 1 項目を指定していれば問題ない＝Takashi。ただし **B212 の案 A を進めるなら、その前か同時に直す**。§4）
- 見つけ方: B212 の案 A の前の洗い出し（[B212](ksql_b212_wildcard_temp_table_field_reference_issue.md) §3.1）で、列一覧（`columns`）の位置で値を取る口を調べていて見つけた
- 関連: [B212](ksql_b212_wildcard_temp_table_field_reference_issue.md)

## 1. 現象（v3.95.0）

代役のアプリ `増減`（`品目` は文字列、`増減`・`番号` は NUMBER）に 2 行（`番号` 1 = `増減` 30・`$id` 11、`番号` 2 = `増減` -10・`$id` 12）。書き込み先 `先` の `a` は NUMBER。`$id` と `番号` を別の値にして、どの列で比べたかが結果に出るようにした。

| # | 置き場所 | SQL | 結果 |
|---|---|---|---|
| D17 | `IN` | `WHERE 増減 IN (SELECT 増減, 番号 FROM LAPP_増減 WHERE 番号 = 2)` | 止まらず、先頭の `増減` で比べる（番号 2 の行） |
| D18 | `WHERE` のスカラー | `WHERE 増減 = (SELECT 増減, 番号 FROM LAPP_増減 WHERE 番号 = 2)` | 止まらず、先頭の `増減` で比べる |
| D19 | `UPDATE … SET` のスカラー | `UPDATE LAPP_先 SET a = (SELECT 増減, 番号 FROM LAPP_増減 WHERE 番号 = 1) WHERE 番号 = 9` | 止まらず、`a` に先頭の `増減`（30）を書く |
| D20 | `SELECT` の列のスカラー | `SELECT 番号, (SELECT 増減, 番号 FROM LAPP_増減 WHERE 番号 = 1) AS s FROM LAPP_増減` | 止まらず、`s` = 30 |
| D21 | `ASSERT` のスカラー | `ASSERT (SELECT 増減, 番号 FROM LAPP_増減 WHERE 番号 = 1) = 30, 'NG'` | **構文で止まる**（`scalar subquery in ASSERT must return exactly 1 column.`） |
| D22 | `SET @変数` のスカラー | `SET @v = (SELECT 増減, 番号 FROM LAPP_増減 WHERE 番号 = 1)` | **構文で止まる**（`scalar subquery in SET must return exactly 1 column.`） |
| D23 | `IN` | `WHERE 番号 IN (SELECT * FROM LAPP_増減 WHERE 番号 = 2)` | 止まらず、先頭の列（代役では `$id` の 12）で比べて **0 行** |
| D24 | `WHERE` のスカラー | `WHERE 番号 = (SELECT * FROM LAPP_増減 WHERE 番号 = 2)` | 止まらず、`$id` で比べて **0 行** |
| D25 | `ASSERT` のスカラー | `ASSERT (SELECT * FROM LAPP_増減 WHERE 番号 = 1) = 11, 'NG'` | **実行時に止まる**（`AssertError: scalar subquery returned 5 columns (expected 1 column).`） |
| D26 | `SET @変数` のスカラー | `SET @v = (SELECT * FROM LAPP_増減 WHERE 番号 = 1)` | **実行時に止まる**（`ArgumentError: scalar subquery returned 5 columns (expected 1 column).`） |
| D27 | `UPDATE … SET` のスカラー | `UPDATE LAPP_先 SET a = (SELECT * FROM LAPP_増減 WHERE 番号 = 1) WHERE 番号 = 9` | 止まらず、**`a` に `$id`（11）を書く** |
| D28 | `SELECT` の列のスカラー | `SELECT 番号, (SELECT * FROM LAPP_増減 WHERE 番号 = 1) AS s FROM LAPP_増減` | 止まらず、`s` = 11（`$id`） |

- 1 項目だけを指定した形（`IN (SELECT 増減 …)`・`SET a = (SELECT 増減 …)` など）は列が 1 つなので、どの口でも指定した列を使う。影響を受けるのは、2 列以上を書いたときと `SELECT *` で書いたときだけ。
- 実機で `SELECT *` の先頭がどの項目になるかは、kintone が返す項目の並びで決まる（確かめていない。代役では `$id`）。
- エラーも警告も出ない。kSQL アクションの書き込み前の守り（`confirm`・`writeLimit`）は件数を見るので、D27 のような値の誤りは防げない。

再現のスクリプト（kintone-plugin の work-link）: `ksql-b212-wildcard-dml-probe.cjs` の D17〜D28（書き込みは代役が受けるだけ）。

## 2. 原因

- **止まる口**（`ASSERT`・`SET @変数`）: 構文の段階で、列を書き並べた 2 列以上を拒否する（`src/parser/parser.ts:1256` が ASSERT、`parser.ts:643` が SET @変数。`SELECT *` は列の数が分からないので通す）。実行時は共通の `evaluateScalarSubquery`（`src/execute.ts:4160`）が列を数えて止める（execute.ts:4175 の `result.columns.length !== 1`）。
- **止まらない口**: 行の数は確かめるが、列の数は確かめずに `result.columns[0]` を取る。
  - `IN (SELECT …)`: `collectSubqueryTasks`（execute.ts:13290。`right.column ?? result.columns[0]`）
  - `WHERE` の右辺のスカラー: 同じ関数（execute.ts:13299）
  - `UPDATE … SET` のスカラー: `resolveSetSubqueries`（execute.ts:13342）
  - `SELECT` の列のスカラー: `resolveScalarColumns`（execute.ts:13374）
- `HAVING` の右辺のスカラーは確かめていない。

## 3. 言語仕様との関係

- **スカラーのサブクエリ**（`WHERE` の右辺・`UPDATE … SET`・`SELECT` の列）: 言語仕様は「1 行 1 列を返す必要があります」「1 行 1 列のみ」と書いている（§ WHERE のスカラーサブクエリ、「SET でのスカラーサブクエリ」の制約の表、サブクエリの置き場所の表）。行の数しか確かめていないので、**仕様と実装の食い違い**。
- **`IN (SELECT …)`**: 言語仕様は「サブクエリは SELECT 1列目（または `SELECT フィールド名`）の値セットを返します」「1 列目の値セットを IN リストとして使用」と書いている。**仕様どおりの動き**。ただ `SELECT *` の 1 列目がどの項目かは利用者に分からない。
- MySQL・PostgreSQL では、この 4 つの置き場所で 2 列以上のサブクエリはどれもエラー。

## 4. 直し方の案（再開するとき）

- **スカラーの 3 つ**: `ASSERT` と同じ検査を入れる（列を書き並べた 2 列以上は構文で、`SELECT *` は実行時に列を数えて止める）。仕様のとおりにするだけ。
- **`IN`**: 仕様の変更になる。推奨は 1 列に揃える（少なくとも、`*` を含んで 2 列以上になるときは止める）。`IN (SELECT * FROM #t)` は `#t` が 1 列なら今までどおり通る。
- どちらも今通っている SQL が止まる側に変わるので、先に使っている所を洗う（B212 §3.1 と同じ範囲）。minor で CHANGELOG に書く。
- **B212 の案 A の前提**: 案 A で `*` の列が列一覧に載ると、今は正しく動いている `(SELECT *, 増減 …)` の形でも先頭が `*` の列に替わり、この穴に落ちる（B212 §3.1 の D10・D12〜D14）。B212 を進めるなら B213 を先か同時に直す。

## 5. 回避策

サブクエリには使う 1 項目を指定する（`IN (SELECT 顧客コード FROM …)`、`SET 単価 = (SELECT 実績単価 FROM …)`）。サブクエリに `SELECT *` や 2 列以上を書かない。
