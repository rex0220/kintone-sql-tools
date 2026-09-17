# B180 結合キー prefilter の仕様が言語リファレンス §7 に足りない — 空値の型依存・300 キー超・並列取得時のスキップ・JOIN 文脈の `!= ''`

- 状態: ✅ **v3.78.0 に同梱（2026-09-16・commit cb6c9335・文書のみ・エンジン不変）**。codex が §7 を改訂（2026-09-11・[依頼書](ksql_b180_codex_doc_request.md)）→ Claude レビュー済み。台帳の行が「コミット待ち」のまま残っていたのを v3.85.0 リリース時（2026-09-17）に訂正

## 0. Claude レビュー（2026-09-11・codex 改訂後）

- 差分は §7 のみで、依頼した 5 点が実装と一致していることを確認（`UNSAFE_RELATION` は `joinPredicatePushdown.ts:797/814/844`、他は依頼書の根拠行どおり）。`npm run docs:check` 通過
- **修正 1 件**: codex は「空値が 1 件でもあれば JOIN 先を全件取得し、`join key prefilter reason: JOIN_KEY_EMPTY_VALUE` を表示します」と書いたが、**この reason は物理アプリが FROM 側の場合には表示されない**。EXPLAIN はレコードを取らないので `joinKey` に実値が入らず（`execute.ts:14327-14374`・`runtime candidate` のまま）、実行時の EMPTY_VALUE フォールバックは `tryFetchJoinRecordsBySourceKeys` で `null` を返すだけで**警告を出さない**（`execute.ts:7892-7900`。警告を出すのは `JOIN_KEY_LIMIT_EXCEEDED` だけ）。→ 「事前には分からず、実行時にも警告は出ない（上限超過とは異なる）」に書き換えた。**codex の静的な主張は行番号つきで正しかったが、「表示される」は動的な主張で、出力経路まで追うと成り立たなかった**
- **別課題の候補（未起票）**: 空値フォールバックが無音なのは 300 超（警告あり）と非対称。利用者は「なぜ全件取ったのか」を知る手段が無い。`JOIN_KEY_EMPTY_VALUE` でも警告を出す純加法の改善は小さい（`execute.ts:7893-7898` の分岐に 1 節足す）。実需が出たら起票
- codex が挙げた §7 以外の穴（§6「機構の全体像」L974〜977 と §24 に並列取得時のスキップの説明が無い）は本課題の範囲外として据え置き。記事側は正本と一致している
- 種別: 改善（文書の穴。[B141](ksql_b141_doc_sql_unverified_issue.md) の系統＝実装が正しく文書が追いついていない）
- 優先: **中**（結果は誤らない。ただし**取得量が「成否」を分ける設計判断**（FROM に書く順・空値対策）を、利用者がリファレンスから導けない。記事に書く以上、正本に無い状態を放置しない）
- 影響版: v3.77.0 時点の [言語リファレンス §7](../ksql_language_reference.md#7-join)「結合キーによる取得範囲の絞り込み」
- 関連: [B150](ksql_b150_join_key_range_prefilter_spec_r1.md)（日付範囲 prefilter・この節の主要な書き手／[起票](ksql_b150_cte_join_date_pushdown_issue.md)）／[B156](ksql_b156_relation_exact_residual_note_issue.md)（EXPLAIN の読み方の新設）／[B141](ksql_b141_doc_sql_unverified_issue.md)（散文の穴の記録）／Qiita 実践 #1 [草稿](qiita/ksql-intro-series/01_アプリ横断集計.md)・[計画書 §10](qiita/ksql-intro-series/計画書.md)

## 1. 何が書かれていないか（4 点）

実装（`src/execute.ts` / `src/core/optimization/joinKeyPrefilter.ts`）と実測（v3.77.0 MCP・APP4148 顧客 215 件 × APP4149 案件 20 件）で確認した挙動のうち、§7 から読み取れないもの。

### 1.1 空値フォールバックは JOIN 先の型に依存する

§7 の現行文は日付の RANGE 方式の段落に「**キーに空値または正規形式でない値が 1 件でも含まれる場合**…JOIN 先を全件取得します」とあり、`in` 方式にも当てはまるのか読めない。

実装は `planJoinKeyPrefilter` で分岐する（`joinKeyPrefilter.ts:94-107`）:

- `in` を受ける型では、**JOIN 先のフィールド型が `JOIN_KEY_EMPTY_IN_FIELD_TYPES`（SINGLE_LINE_TEXT / LINK / NUMBER / CALC / DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / STATUS）に含まれれば、空値があっても `in ("")` に載せて最適化を維持**する
- 含まれない型（**レコード番号 `$id` / RECORD_NUMBER** など）では `JOIN_KEY_EMPTY_VALUE` で FALLBACK＝JOIN 先を全件取得
- RANGE 方式（日付・日時・時刻）は空値があれば常に FALLBACK

SFA パックの `案件.顧客No_`（NUMBER）→ `顧客.顧客No`（RECORD_NUMBER）は後者に該当する。**ルックアップ未設定の案件が 1 件あるだけで顧客側が全件取得に戻る**が、利用者はこの型依存を知りようがない。

### 1.2 300 キー超の挙動

§7 は「50 キー単位・最大 300 キーで取得します」とだけ書く。超過時の挙動が無い。

実装（`execute.ts:7813-7898`）: `JOIN_IN_MAX_CHUNKS = 6` × `JOIN_KEY_IN_CHUNK_SIZE = 50` = 300。重複除去後のキーが 300 を超えると `JOIN_KEY_LIMIT_EXCEEDED` で FALLBACK し、警告
`JOINキーが N 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 300 件）` を出す。

### 1.3 JOIN 先に押し下げ可能な WHERE があると結合キー最適化は試さない

§7 は「先に取得した物理 APP から alias 付き物理 APP へ INNER JOIN する場合、結合キーの実値で JOIN 先の取得候補を絞る」と書くが、**JOIN 先に押し下げ可能な単一 alias 述語があるときはこの経路に入らない**。

実装（`execute.ts:6081-6119`）: 「push-down あり → ON 最適化スキップ・メインと並列フェッチ」「push-down なし → メイン完了後に ON 最適化」。

実測: `FROM 顧客 INNER JOIN 案件 WHERE 案件.商談フェーズ IN ('受注')` は案件が `fetch: EXACT`、顧客が `fetch: ALL`（215 件）で、`join key prefilter` 行が出ない。FROM を案件にすると顧客が `PREFILTERED (未確定)`・`join key prefilter: runtime candidate` になり、上限 10 件でも成功する（顧客 FROM は 100 件で `FetchAllLimitError`）。**「FROM に書く順で取得量が変わる」という設計判断の根拠**だが、リファレンスからは導けない。

### 1.4 JOIN 文脈では `!= ''` が kintone クエリに載らない

単表の `WHERE 顧客No_ != ''` は `EXACT`（`顧客No_ != ""`）で押し下がる。同じ条件を INNER JOIN の WHERE に書くと `join pushdown not applied: UNSAFE_RELATION` で載らず、`client residual` として JOIN 後に評価される。

結合キーは取得直後の行から集める（`tryFetchJoinRecordsBySourceKeys` は `tables` の生行を走査）ため、**JOIN の WHERE に `!= ''` を足しても 1.1 のフォールバックは防げない**。防ぐには、案件を単独 SELECT で一時テーブルへ実体化（ここでは `!= ''` が押し下がる）し、そこから INNER JOIN する（実体化済み一時テーブル → 物理 APP の prefilter は §7 に記載済み・上限 10 件で実測）。

外部レビュー（ChatGPT）が「Dashboard 用 SQL にも `AND b.顧客No_ != ''` を」と提案し、検証して否定した経緯が [計画書 §10](qiita/ksql-intro-series/計画書.md) にある。**リファレンスにこの穴が無いと、同じ誤った防御を利用者も AI も書く**。

## 2. 提案する追記（§7「結合キーによる取得範囲の絞り込み」）

案文。事実は 1 節のとおりで、表現は codex に任せてよい。

1. 冒頭に適用条件を 1 行: 「JOIN 先に押し下げ可能な単一 alias 述語がある場合は、JOIN 先をその述語で独立に取得（メインと並列）し、結合キーによる絞り込みは行わない。`EXPLAIN` に `join key prefilter` 行が出るのは、JOIN 先に述語が無い場合」
2. `in` 方式の段落に型依存を明記: 「キーに空値が含まれる場合、JOIN 先のフィールド型が `in ("")` を受ける型（SINGLE_LINE_TEXT / LINK / NUMBER / CALC / DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / STATUS）なら空値も `in` に載せて最適化を維持する。レコード番号など受けない型では JOIN 先を全件取得する（`join key prefilter reason: JOIN_KEY_EMPTY_VALUE`）」
3. 上限超過: 「重複除去後のキーが 300 件を超える場合は最適化を行わず JOIN 先を全件取得し、警告『JOINキーが N 件のため…（上限 300 件）』を返す」
4. 空値対策の正しい形: 「JOIN の `WHERE` に `キー != ''` を書いても、この条件は JOIN 文脈では records API へ押し下げず（`UNSAFE_RELATION`）、キーは取得直後の行から集めるため、フォールバックは防げない。防ぐには FROM 側を単独 `SELECT … WHERE キー != ''` で一時テーブルへ実体化してから `INNER JOIN` する」
5. 既存の RANGE 段落の「空値または正規形式でない値」の文は RANGE 方式限定であることが分かる位置へ

あわせて [`ksql_batch_recipes.md`](../ksql_batch_recipes.md) か Pro のレシピ集 D10「JOIN での押し下げ」に、「絞れる側を FROM に書く」の 1 行を足すかは任意。

## 3. 受入条件

- §7 に 2 節の 1〜5 が入り、記述が `joinKeyPrefilter.ts` / `execute.ts` の分岐と一致する（codex に**ソース行を引用させて**書かせる。[B141](ksql_b141_doc_sql_unverified_issue.md) の教訓＝散文は実装から書く）
- Qiita 実践 #1 の「落とし穴」と矛盾しない
- `npm run docs:check` が通る
- 版数は据え置き（文書のみ）。次の機能リリースに同梱

## 4. 経緯

Qiita 実践 #1（アプリをまたいで集計する）の執筆で、顧客×案件 JOIN を上限 10 / 100 件で実測して 1.3 が判明。外部レビューの「`!= ''` を足せ」を検証して 1.4 が判明。空値フォールバックを落とし穴に書く際に §7 の文が `in` 方式に当てはまるか読めず、ソースを読んで 1.1 が判明。300 超は §7 にも CHANGELOG にも無く、ソースで 1.2 を確認。**記事の側は実装に合わせて書き終えており、正本だけが遅れている状態**。
