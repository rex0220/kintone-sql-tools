# B180 文書改訂依頼（codex）

**[起票文書](ksql_b180_join_key_prefilter_doc_gap_issue.md) §2 の案文 5 点を、言語リファレンス §7 に反映する。文書のみ・エンジン不変・版数据え置き。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b180/dev`・v3.77.0 相当）
上限: 1 PR・2 時間。超えそうなら途中で止めて「どこまで書いたか」を報告する。

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）の変更・ビルド（`prod/js/desktop.js` に触れない）・
kSQL MCP・MEMORY.md 禁止。**`src/` を変更しない**（挙動を変える提案があれば報告に書く。この依頼では実装しない）。
エラー本文・警告文を新たに発明しない（引用するときは `src/` の文字列を逐語で）。

## 1. 決まっていること（レビュー対象外）

- 直すのは [言語リファレンス §7「結合キーによる取得範囲の絞り込み」](../ksql_language_reference.md#7-join)（現行 L1480〜L1503 付近）と、必要なら §7 末尾の注記ブロック（L1536〜）。他章は触らない
- **散文は実装から書く**（[B141](ksql_b141_doc_sql_unverified_issue.md) の教訓）。各追記の根拠となる `src/` の行を**報告に引用**する（本文にファイル名・行番号は書かない）
- 追記する事実は §2 の 5 点。**再導出しない**。実装と食い違うと判断したら、その箇所を書かずに報告で指摘する
- EXPLAIN の行名（`join key prefilter: …`・`join pushdown not applied: …`・`fetch: PREFILTERED (未確定)` 等）は `src/execute.ts` の出力文字列を逐語で使う
- 文体は §7 の既存段落に合わせる（である調・断定・箇条書き少なめ）。**利用者向け文書なので内部語（関数名・reason code の列挙）は出さない**。ただし EXPLAIN に実際に表示される reason（`JOIN_KEY_EMPTY_VALUE` 等）は利用者が目にするので可

## 2. 追記する事実（実測とソースで確定済み・そのまま使う）

| # | 事実 | 根拠 |
| :-: | :--- | :--- |
| 1 | **JOIN 先に押し下げ可能な単一 alias 述語があるときは、結合キーによる絞り込みを行わない。** JOIN 先をその述語で独立に取得し、FROM 側と並列に読む。結合キーで絞るのは、JOIN 先に述語が無く FROM 側の取得完了後に取りに行く場合だけ | `src/execute.ts` L6081〜6119（「push-down あり → ON 最適化スキップ・メインと並列フェッチ／なし → メイン完了後に ON 最適化」）。実測: `FROM 顧客 INNER JOIN 案件 WHERE 案件.商談フェーズ IN ('受注')` → 案件 `EXACT`・顧客 `ALL`・`join key prefilter` 行なし。FROM を案件にすると顧客 `PREFILTERED (未確定)`・`join key prefilter: runtime candidate`。上限 100 件で前者は `FetchAllLimitError`、後者は 10 件でも成功 |
| 2 | **空値の扱いは JOIN 先の型で変わる。** `in` を受ける型のうち `in ("")` を受理する型（SINGLE_LINE_TEXT / LINK / NUMBER / CALC / DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / STATUS）では、FROM 側キーに空値があっても `in` に載せて絞り込みを維持する。それ以外（レコード番号 `$id` を含む）は JOIN 先を全件取得する（`join key prefilter reason: JOIN_KEY_EMPTY_VALUE`） | `src/core/optimization/joinKeyPrefilter.ts` L59〜70（`JOIN_KEY_EMPTY_IN_FIELD_TYPES`）・L98〜100。**現行 §7 の「キーに空値または正規形式でない値が 1 件でも含まれる場合…全件取得」は RANGE 方式の段落にあり、`in` 方式にも当てはまるように読める＝ここを直す** |
| 3 | **重複除去後のキーが 300 件を超えると絞り込みを行わず JOIN 先を全件取得し、警告を返す。** 警告文は `JOINキーが N 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 300 件）` | `src/execute.ts` L7813〜7814（`JOIN_IN_MAX_CHUNKS = 6` × 50）・L7893〜7898 |
| 4 | **JOIN の `WHERE` に `キー != ''` を書いても、空値によるフォールバックは防げない。** JOIN 文脈ではこの述語は records API へ押し下げず（`join pushdown not applied: UNSAFE_RELATION`）残余として JOIN 後に評価され、結合キーは取得直後の行から集めるため。単表の `WHERE キー != ''` は押し下がる（`EXACT`） | 実測（v3.77.0 MCP）: 単表 `SELECT … FROM APP4149 WHERE 顧客No_ != ''` → `kintone query: 顧客No_ != ""`・`EXACT`。同条件を INNER JOIN の WHERE に足すと `client residual: (… AND b.顧客No_ != '')`・`join pushdown not applied: UNSAFE_RELATION`。キー収集は `src/execute.ts` L7875〜7882（`tables.get(sourceAlias)` の生行を走査） |
| 5 | **空値を除いて絞り込みを維持する形は、FROM 側を単独 `SELECT … WHERE キー != ''` で一時テーブルへ実体化してから `INNER JOIN` する。** 実体化済み一時テーブルから物理 APP への絞り込みは既存記述どおり効く | 実測: `CREATE TEMP TABLE #deals AS SELECT 顧客No_, 売上 FROM APP4149 WHERE 商談フェーズ IN ('受注') AND 顧客No_ != ''; SELECT … FROM #deals d INNER JOIN APP4148 a ON d.顧客No_ = a.顧客No GROUP BY …` を `maxRecords: 10` で実行 → 1 文目 8 行実体化・2 文目成功（顧客 215 件のうち絞り込み取得） |

補足（書く位置の判断材料）: 事実 1 は「結合キーによる取得範囲の絞り込み」の冒頭に適用条件として。事実 2・3 は `in` 方式の段落に。事実 4・5 は空値の話の直後に「対策」として。RANGE 段落の空値の文は、RANGE 限定であることが分かる位置・表現に直す。

## 3. 出力の形

- 差分は `docs/ksql_language_reference.md` のみ（§7 内）。目次・アンカーを壊さない
- §7 の既存例 SQL は変えない。新しい例 SQL を足す場合は **§2 の実測 SQL をそのまま使う**（発明しない。`APP4148` / `APP4149` は説明用の番号として可）
- 追記後の §7 該当節を報告に全文貼る

## 4. 確認してほしいこと（報告に書く）

1. §7 の文言を固定しているテスト・スクリプトの有無（`grep` で「結合キーによる取得範囲」「50キー単位」「上限 300 件」を `src/` `scripts/` から探す）。**Claude の事前確認では §7 本文を固定するテストは無く、警告文だけが `src/__tests__/b150JoinKeyRangePrefilter.test.ts:287` に逐語固定されている**（文書はこの文字列に合わせる）。ほかに見つけたら**何をどう更新したか**を列挙。**期待している挙動が変わる書き換えは止めて報告**（今回は文書のみなので原則発生しない）
2. `npm run docs:check` が通ること
3. 事実 1〜5 と実装が食い違う箇所があれば、書かずに指摘（行番号つき）
4. §7 以外に同じ穴がある場所（例: `docs/ksql_batch_recipes.md`・§24 EXPLAIN の読み方）があれば列挙だけする（この依頼では直さない）

## 5. 報告

最終メッセージ＝改訂報告のみ（変更ファイル・追記 5 点 ↔ 根拠行の対応表・§7 該当節の全文・§4 の 4 項目・Claude が実機で確かめるべき残項目）。
