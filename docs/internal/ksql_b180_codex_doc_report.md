# B180 改訂報告（codex・2026-09-11）

> codex exec の最終メッセージをそのまま保存（絶対パスのリンクだけコード表記へ変更）。Claude のレビューと修正 1 件は [起票文書 §0](ksql_b180_join_key_prefilter_doc_gap_issue.md) を参照。

## 変更ファイル

- [docs/ksql_language_reference.md](../ksql_language_reference.md)（L1480〜）の §7 のみ
- `src/`、README、CHANGELOG、release、台帳、版数は変更していない
- 既存 SQL 例、目次、アンカーは変更していない

## 追記 5 点と実装根拠

| # | 反映内容 | 実装根拠 |
|---:|---|---|
| 1 | JOIN 先に押し下げ可能な述語がある場合は結合キー絞り込みを行わず、FROM 側と並列取得する条件を追記 | `src/execute.ts:6081-6083` の「`push-down あり → … ON 最適化スキップ…並列フェッチ`」、`6099-6118` の振り分け、`6128-6169` のメイン取得後の ON 最適化 |
| 2 | 空値を `in ("")` に載せられる 9 型と、それ以外では `JOIN_KEY_EMPTY_VALUE` により全件取得することを追記。RANGE の空値説明を範囲方式限定に修正 | `src/core/optimization/joinKeyPrefilter.ts:59-70` の `JOIN_KEY_EMPTY_IN_FIELD_TYPES`、`93-106` の IN 計画、`119-124` の RANGE フォールバック |
| 3 | 重複除去後 300 キー超で全件取得し、警告を返すことを追記 | `src/core/optimization/joinKeyPrefilter.ts:37,50-52` の 50 キーチャンク、`src/execute.ts:7813-7814` の 6 チャンク＝300 件、`7893-7898` の警告生成 |
| 4 | JOIN の `WHERE キー != ''` は空値フォールバック対策にならないことを追記 | `src/core/optimization/joinPredicatePushdown.ts:793-815` の `UNSAFE_RELATION` 判定、`src/execute.ts:7875-7882` の取得直後の行からのキー収集 |
| 5 | 単表 SELECT で空値を除外して一時テーブルへ実体化し、その一時テーブルから物理 APP へ INNER JOIN する対策を追記 | `src/execute.ts:7831-7855` の INNER JOIN・取得済み source 行の利用、`7864-7867` の実体化済みテーブルの列メタデータ利用、`7875-7890` のキー計画 |

実装との食い違いは見つからなかった。

## 改訂後の §7 該当節全文

#### 結合キーによる取得範囲の絞り込み

実体化済みの CTE・一時テーブル・先に取得した物理 APP から、alias 付き物理 APP へ
`INNER JOIN` する場合、kSQL は結合キーの実値を使って JOIN 先の取得候補を絞ります。
ただし、JOIN 先に押し下げ可能な単一 alias の述語がある場合、この絞り込みは行いません。
JOIN 先はその述語で独立に取得して FROM 側と並列に読みます。結合キーで絞るのは、JOIN 先に
押し下げる述語がなく、FROM 側の取得完了後に JOIN 先を取得する場合だけです。

JOIN 先フィールドが `in` を受ける型では、重複を除いたキーを `in (...)` に載せ、50キー単位・
最大300キーで取得します。`SINGLE_LINE_TEXT` / `LINK` / `NUMBER` / `CALC` / `DROP_DOWN` /
`RADIO_BUTTON` / `CHECK_BOX` / `MULTI_SELECT` / `STATUS` は `in ("")` を受けるため、FROM 側の
キーに空値があっても空値を含めて絞り込みを維持します。それ以外の型（レコード番号 `$id` を含む）
では、空値が1件でもあれば JOIN 先を全件取得し、`join key prefilter reason: JOIN_KEY_EMPTY_VALUE`
を表示します。

重複を除いたキーが300件を超える場合も、絞り込みを行わず JOIN 先を全件取得します。この場合は
`JOINキーが N 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 300 件）。`
という警告を返します。

`DATE` / `TIME` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` は `in` を受けないため、
すべてのキーが型に対応する正規形式なら最小値・最大値による範囲 prefilter を使います。

```text
日付 >= "2025-08-04" and 日付 <= "2025-08-06"
```

この範囲は候補を広めに取得する `relation: superset` です。範囲内に実際のキー集合にない値が
含まれても、既存の JOIN 後照合が最終結果から除外します。この範囲方式では、キーに空値または
正規形式でない値が1件でも含まれる場合、JOIN 先を全件取得します。対象フィールドが `in` と
範囲比較のどちらも受けない場合も、不適切な演算子を推測せず JOIN 先を全件取得します。
正規形式は `DATE` が `YYYY-MM-DD`、`TIME` が `HH:mm`、日時系が
`YYYY-MM-DDTHH:mm:ssZ` です。

JOIN の `WHERE` に `キー != ''` を加えても、空値による全件取得は防げません。JOIN 文脈では
この述語を records API へ押し下げず、`join pushdown not applied: UNSAFE_RELATION` を表示して
JOIN 後に評価します。一方、結合キーは FROM 側の取得直後の行から集めるため、この述語による
空値除外より先に取得方式が決まります。単表の `WHERE キー != ''` は records API へ押し下がり、
`fetch: EXACT` になります。空値を除いて絞り込みを維持するには、FROM 側をこの単表 SELECT で
一時テーブルへ実体化してから、その一時テーブルを FROM 側として物理 APP へ `INNER JOIN`
します。実体化済み一時テーブルから物理 APP への結合キーによる絞り込みは有効です。

方式選択は records API 呼び出し前に行います。選択済みの query に対して kintone が返した認証・
権限・値受理・検索打ち切り・通信エラーを、空 query や全件取得で silent retry はしません。
`EXPLAIN` では `join key prefilter: in`、`join key prefilter: range`、
`join key prefilter: not applied`、実行前には `join key prefilter: runtime candidate`、
適用時の `relation`、フォールバック時の `join key prefilter reason` を確認できます。
JOIN 先の述語を独立に押し下げて並列取得する場合は、結合キーによる絞り込みを試さないため
`join key prefilter` 行を表示しません。取得範囲は各 source の `fetch:` 行で確認します。

## §4 確認結果

1. 文言固定テスト・スクリプト

   指定された 3 文字列を `src/`・`scripts/` から検索した。§7 本文を固定するものはなかった。警告文は既知の `src/__tests__/b150JoinKeyRangePrefilter.test.ts:287` だけが逐語固定しており、文書を同じ文字列へ合わせた。テスト・スクリプトの更新はない。

2. 文書チェック

   `npm run docs:check` 成功。

   ```text
   [docs-check] ok（リンク 3894 件 / 台帳 12 行）
   ```

3. 事実 1〜5 と実装の食い違い

   なし。全 5 点を反映した。

4. §7 以外の同種の穴

   - 言語リファレンス §4 の「機構の全体像」L974〜L977 は、JOIN 先の安全葉が結合キー query に「合流する」と読める一方、JOIN 先に押し下げ述語がある場合に結合キー最適化を省略する条件を説明していない。
   - 言語リファレンス §24 は `EXPLAIN` の一般的制約だけで、`join key prefilter` 行の有無、`runtime candidate`、JOIN 先述語による並列取得との読み分けを説明していない。
   - `docs/ksql_batch_recipes.md` には結合キー prefilter の契約を直接説明する箇所がなく、今回修正した内容との矛盾は見つからなかった。
   - いずれも依頼範囲外のため変更していない。

## Claude が実機で確かめるべき残項目

今回 kSQL MCP は使用していないため、次を v3.77.0 実機で再確認する。

- JOIN 先に押し下げ述語がある向きでは `join key prefilter` 行がなく並列取得され、FROM/JOIN の反転後は `fetch: PREFILTERED (未確定)` と `join key prefilter: runtime candidate` が出ること
- 空値を受理する 9 型では `in ("")` を維持し、レコード番号 `$id` などでは `JOIN_KEY_EMPTY_VALUE` で全件取得すること
- 重複除去後 301 キーで、警告 `JOINキーが 301 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 300 件）。` が返ること
- JOIN の `WHERE キー != ''` が `join pushdown not applied: UNSAFE_RELATION` となる一方、単表では `fetch: EXACT` となること
- 依頼書記載の一時テーブル 2 文を `maxRecords: 10` で実行し、8 行実体化後の INNER JOIN が絞り込み取得で成功すること

