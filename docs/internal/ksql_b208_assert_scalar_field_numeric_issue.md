# B208 `ASSERT` / `EXIT` のスカラーサブクエリが、項目を 1 つ返す形で辞書順になる（fail-open）

- 状態: 🚧 **実装済み（2026-11-09）。v3.93.0 に同梱（PR #422。マージ・タグ・公開待ち）**
- 種別: 正しさ（**fail-open**＝通ってはいけない条件が通る）。**結果が変わる**
- 優先: 中〜高（**件数ゲートが素通りする**。依頼元が記事で勧める直前だった）
- 版: minor（v3.93.0）。**規模 S**
- 見つけ方: 依頼 KJ-11 の ③（`actual: 12` なのに `<= 100` が不成立）を調べる途中で、
  **一時テーブルの話ではなく項目の列すべて**だと分かった。回答 §5 に実測の表。
- 関連: [B171](https://github.com/rex0220/kintone-sql-tools/releases/tag/v3.72.0)（同じ種類を集計・算術・ウィンドウで直した）、
  B151（10 進の厳密比較）

## 1. 現象（v3.92.0 の実測）

| # | 式 | 値 | 数値で比べた答え | 実際 |
|---|---|---|---|---|
| A | `(SELECT 残数 FROM APP200 WHERE $id = 10) <= 100`（`残数` は NUMBER） | 9 | 真 | **偽** |
| B | `(SELECT 残数 FROM #r) <= 100`（NUMBER を写した一時テーブル） | 9 | 真 | **偽** |
| C | `(SELECT n FROM #c) <= 100`（`#c` は `COUNT(*)`） | 12 | 真 | **偽** |
| D | `(SELECT COUNT(*) FROM APP200) <= 100`（直の集計） | 12 | 真 | 真 |
| E | **`(SELECT n FROM #c) <= 2`** | 12 | **偽** | **真（fail-open）** |

**E が危険**。`ASSERT (SELECT 件数 FROM #cnt) <= 10000` のような件数ゲートが、
件数が上限を超えていても通る（桁が増えると辞書順で小さく見える）。

## 2. 原因

`evalAssertOperand` の `SCALAR_SUBQUERY` は数値かどうかを `scalarSubqueryHasNumericResult` で決める。
そこが数値と認めるのは**先頭の列が `AGGREGATE` / `ARITH` / 一部の `WINDOW`** のときだけで、
**ふつうの項目（`FIELD`）の列は、アプリのフォーム定義を見ずに文字列へ落ちていた**
（`MODE` とウィンドウの一部だけ `inferSelectColumnMeta` でフォーム定義を見ていた）。
両辺のどちらかが文字列なら `compareScalarValues` が辞書順で比べる。

**B171 は「型 provenance 方式（実値推測禁止）」でこの種類を直したが、
列の種類で分からない形（ふつうの項目）が残っていた。**

## 3. 直したこと

`scalarSubqueryHasNumericResult` で、**数値と分からなかったときは必ずフォーム定義のメタデータを見る**
（`inferSelectColumnMeta` の `semantics.compareMode === "number"` / `sortKind === "number"`）。

- **値は見ない**＝B171 の「実値推測禁止」はそのまま（見るのは**型**。`MODE` の分岐が元からそうしていた）。
- 一時テーブルの列は `columnMeta` から型を引き継ぐので、集計の結果（`COUNT(*)` を入れた列）も数値になる。
- 型が分からなければ**今までどおり文字列**（fail-closed 側）。
- `SET` のスカラーサブクエリも**同じヘルパー**を通るので同時に直る（B171 と同じ扱い）。

## 4. 試験（`src/flow-library/__tests__/b208AssertScalarFieldNumeric.test.ts` 11 件）

物理アプリの NUMBER・`$id`・一時テーブルに写した NUMBER・一時テーブルに入れた `COUNT(*)`・
`BETWEEN`・`ASSERT WARN`・`EXIT SUCCESS IF`・`SET` を固定し、
**`12 <= 2` が不成立になること（fail-open を閉じたこと）**を明示の試験にした。
**文字列の項目は文字列のまま**（`"9" <= 100` は偽）＝既存の規則を変えていない。

## 5. 影響（結果が変わる）

- 今まで**偽だった**比較（数値の項目で桁が違う形）が**真**になる。
- 今まで**真だった** fail-open の形が**偽**になる＝**止まるべきものが止まる**。
- 文字列の項目・等値・`STRING` 変数・リテラルの比較は不変。
