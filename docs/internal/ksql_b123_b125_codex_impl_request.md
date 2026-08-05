# B123 / B125 codex 実装依頼（2026-08-05）

このファイルの §2 以降をそのまま codex へ渡す。
実装は codex、レビューは Claude。**仕様の詳細は各文書が正**。

- [B123](ksql_b123_explain_groupby_metadata_issue.md) `EXPLAIN` / `--dry-run` が通常の `GROUP BY` で落ちる
- [B125 仕様 R2](ksql_b125_aggregate_window_phase1_spec.md) 集計ウィンドウ関数 Phase 1

> **注意（headless で回す場合）**
> - `codex exec` は **MCP tool call の承認待ちで無言停止**する。**kSQL MCP を叩かないこと。**
>   実機確認はレビュー側（Claude）で行う。
> - **git 操作は一切しないこと。** コミットは Claude 側で行う。
> - `npm test` は実行してよい（というより必須）。

---

## 2. 依頼

kSQL に 2 件。**B123 → B125 の順で、この順序を守る**（両方が
`src/core/explainMetadata.ts` の同じ関数を触るため）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（現行 v3.44.0）

### 進め方

1. **B123 を先に完了させる**（純加法 1 条件・小さい）
2. `npm test` を通す
3. **その後 B125 に着手する**
4. 各修正で**失敗するテストを先に書く**（現行コードで落ちることを確認してから直す）
5. `npm test` を通す
6. 実装後、変更点と判断（とくに迷った箇所・仕様と違えた箇所）を報告する

### 守ってほしいこと

- **仕様に書かれていない意味論を自分で決めない。** 迷ったら実装を止めて、
  その箇所を報告に書く（「仕様のここが決まっていない」と明記する）
- **既存テストを書き換えない。** 落ちる既存テストがあれば、それは
  「意味が変わった」ということなので、**書き換えずに報告する**。
  （テストの意味が変わらない純粋な形式変更──AST の型変更に追従する等──は例外。
  その場合も報告に列挙する）
- **公開型に必須プロパティを足さない。** 追加は optional か、判別ユニオンの新メンバーとして行う

---

## 3. B123 `EXPLAIN` / `--dry-run` が通常の `GROUP BY` で落ちる

### 症状（実測 v3.44.0）

```
> SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類
Error: No-op client should not be called.        （MCP）
DryRunError: API call should not happen in dry-run.（CLI --dry-run）
```

**分かれ目は「`GROUP BY` があり、かつフィールドを参照する `WHERE` も `ORDER BY` も無い」こと。**
`HAVING` は判定に寄与しない。実測 6 形は issue 文書 §1 にある。

### 原因（特定済み）

`src/core/explainMetadata.ts` の `selectNeedsOwnMetadata` が
**通常の `GROUP BY`（`statement.groupBy`）を見ていない**。B65 の
`ROLLUP` / `GROUPING SETS` は入っているのに漏れている。

偽になると `src/mcp/tools.ts` で `noOpClient()` が渡り、`GROUP BY` の計画作成が
`getFields` を呼んでガードに弾かれる。CLI も同じ述語（`dryRunNeedsMetadata`）を使う。

### 修正

```ts
function selectNeedsOwnMetadata(statement: SelectStatement): boolean {
  return whereNeedsFieldMetadata(statement.where)
    || statement.groupBy.length > 0                                // ← 追加
    || normalizeGroupingSpec(statement).type === "GROUPING_SETS"
    || statement.orderBy.length > 0
    || statement.columns.some((c) => c.type === "WINDOW_COL" && c.orderBy.length > 0);
}
```

### 受入・回帰

issue 文書 §5 のとおり。要点だけ再掲する。

- 6 形すべてが `EXPLAIN` で計画を返す（`GROUP BY` のみ / 集計関数なし / `HAVING` 付き /
  JOIN + `GROUP BY` / CTE・サブクエリ内の `GROUP BY` / CLI `--dry-run` の同 5 形）
- **`EXPLAIN` がレコード API を呼ばないこと**（`getRecords` / `openCursor` が呼ばれない）。
  この修正はフォーム定義の取得を増やすだけで、この契約は変えない
- 既存の通る形が変わらないこと（`SELECT COUNT(*)` = `COUNT_TOTAL_COUNT` / 集計のみ /
  `WHERE` 付き / `ORDER BY` 付き / `ROLLUP` / `GROUPING SETS`）
- `ORDER BY` を足した形の**計画本文が変わらない**こと（修正前後で比較）
- `GROUP BY` の無い文でフォーム定義の取得回数が増えていないこと

---

## 4. B125 集計ウィンドウ関数 Phase 1

**仕様は [`docs/internal/ksql_b125_aggregate_window_phase1_spec.md`（R2）が正。**
ここには要点と注意だけ書く。**必ず R2 を通読してから着手すること。**

### 概要

`SUM` / `COUNT` / `AVG` / `MIN` / `MAX` の `OVER (...)` を SELECT のトップレベル単独列で使えるようにする。
フレームは既定（`ORDER BY` あり = `RANGE`、無し = パーティション全体）と
明示の `{ROWS|RANGE} BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`。

### 罠（R2 の §12 に至った経緯。ここで落ちやすい）

初版の仕様には 12 件の誤りがあり、レビューで直っている。**同じ穴に落ちないこと。**

1. **`SELECT DISTINCT` との併用は既存機能。壊さないこと**（R2 §0）。
   パーサの併用拒否条件に `distinct` は無く、`applyWindow` の後に `applyDistinct` が走る
2. **集計引数の物理フィールドを取得対象に足すこと**（R2 §7 の `selectToKintone.ts:771-773`）。
   現行は `partitionBy` / `orderBy` しか集めないため、足さないと
   `SELECT 製品名, SUM(金額) OVER (ORDER BY 日付) AS 累計` が**全行スキップで静かに 0** になる
3. **`WINDOW_COL` の型メタが一律 number になっている**（R2 §4.1）。
   `MIN` / `MAX` は通常集計と同じ `inferAggregateArgMeta` / `resolveAggregateArgSemantics` を通す。
   `execute.ts` に同形が 4 箇所ある
4. **`ORDER BY` 無しの集計ウィンドウも完全入力が要る**（R2 §3.5）。
   新 reason `AGGREGATE_WINDOW` を足す。FULL_SCAN は評価場所を決めるだけで部分入力を防がない
5. **`RANGE` は同順グループの「末尾」の値**（R2 §3.2・§6.3）。先頭値ではない
6. **`frame.source` で既定と明示を区別する**（R2 §4）。無いと `EXPLAIN` の `(既定)` が出せない
7. **パーサの `OVER` 先読みは `parseSelectColumn` のトップレベル集計分岐に限定する**（R2 §5.1）。
   `parseAggregateRef` に入れると `HAVING` や `CASE` 内まで窓構文を飲み込む
8. **「通常集計値と必ず一致」は成立しない**（R2 §3.4）。浮動小数の加算順序と
   `MIN`/`MAX` の canonical 同値時の raw 表記は契約から外してある

### `evalAggregate` の切り出し（最大のリスク）

R2 §6.2。`evalAggregate` は 12 集計すべてが通る共有コードなので、
切り出しを誤ると全集計に波及する。

- `COUNT(*)`（`WILDCARD`）は**ヘルパーを通さない**（現行どおり別分岐）
- 通常集計側は `filter(v => v !== null)` を**一度だけ**行い、その後の
  **Number 化 → 例外 → DISTINCT → 集計**の順序を現行どおり維持する
- **B119〜B122 の受入テストを全件再実行して、1 つも変わらないことを確認する**

### 受入・回帰

R2 §8 のとおり。とくに次を落とさないこと。

- §8.2: 同順グループの**全増減を含む期待値**を固定する（「同じ値」だけだと
  **先頭値を書き戻す誤実装が通ってしまう**）
- §8.3: **集計引数のフィールドを `SELECT` に書かない形**（罠 2 を直接突く）と、
  `onLimit=truncate` ＋ 上限到達で**部分結果を返さずエラー**になること
- §8.1: **小数を含む `SUM`/`AVG`** で相対誤差 1e-12 以内（整数だけのデータでは
  加算順序の欠陥を検出できない）
- §8.6: 12 集計の回帰・順位系 3 関数の不変・**`SELECT DISTINCT` ＋ ウィンドウ列**の回帰

### 文書

R2 §9 の 4 点（言語リファレンス §10.1 への追記・`ksql_docs` への
`window-functions` セクション追加・`MIN`/`MAX` の raw 表記が不定である旨・レシピ 1 本）も
実装に含めてよい。**時間が足りなければ文書は後回しでよいので、その旨を報告に書くこと。**

---

## 5. 報告してほしいこと

`docs/internal/ksql_b123_b125_codex_impl_report.md` に書いてほしい。

```markdown
# B123 / B125 実装報告

## 結果
（B123: 完了 / B125: 完了・部分完了 のどちらか。npm test の結果）

## B123
- 変更ファイルと変更内容
- 追加したテスト
- 受入の確認結果（6 形）

## B125
- 変更ファイルと変更内容
- 追加したテスト
- R2 §8 の受入それぞれの確認結果
- **仕様と違えた箇所**（あれば理由も）
- **仕様が決まっていなかった箇所**（自分で決めずに、ここに書く）

## 既存テストへの影響
- 落ちた既存テスト（あれば。書き換えずに報告する）
- 形式変更のみで追従した既存テスト（列挙）

## 未実施
（文書など、やり残したもの）
```
