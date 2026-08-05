# B128 Phase 2a `LAG` / `LEAD` 仕様（R1）

- ステータス: 📝 **仕様 R1（レビュー前）**
- 前提: [B125 Phase 1 仕様](ksql_b125_aggregate_window_phase1_spec.md)（v3.45.0 出荷済み）§10
- 旧スコープ: [移動フレーム込みの R1](ksql_b128_window_phase2_spec.md)（⏸ 棚上げ）と
  [そのレビュー](ksql_b128_codex_review_1.md)（高 9・中 7）
- 出典: [依頼元の回答 §6](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-B129-20260805.md)

> **スコープを `LAG` / `LEAD` だけに絞った。移動フレームと値指定 `RANGE` は棚上げ。**
> **依頼元が実測で組み替えを求めた**（返信 §6）。
>
> - **日次集約＋`ROWS` では 7 日移動平均にならない**＝取引のあった日が稼働期間の半分以下で、
>   **7 行が相当する暦日が製品ごとに 15〜29 日と 2 倍の開き**がある。
>   同じ `PARTITION BY` の 1 本の中で窓幅が製品ごとに変わるため、**製品を横に並べる表に使えない**
> - **依頼元の言葉＝「依頼③で移動平均を先に挙げたのは当方の見立ての粗さで、
>   実際に効くのは前期比の方でした」**
> - **`LAG` 先行の根拠**＝月次集約なら歯抜けがほぼ起きない（履歴 13 か月すべてに行がある）／
>   短期の窓は `SUM(CASE WHEN 日付 >= @d90 ...)` の固定窓で足りており平滑化を必要としていない

> **旧レビューの 16 件のうち 8 件が本スコープに残る。** 移動フレーム固有の 8 件
> （代表 SQL・7 日 vs 7 行・`WindowFrame.start/end`・クリップ・prefix sum・単調キュー・
> oracle・受入）は棚上げ側へ置く。

---

## 0. 前提（B125 から引き継ぐ・変えない）

| 前提 | 根拠 |
|---|---|
| ウィンドウ列があれば FULL_SCAN 強制 | B125 §0 |
| `OVER (ORDER BY ...)` は `sortDecoratedRows` を共有（比較器を二重実装しない） | B125 §0 |
| **`GROUP BY` / 集計関数との併用は ParseError のまま** | `parser.ts:1176-1180` |
| **ウィンドウ結果を同じ SELECT の式に含めるのは不可**（B129 の診断が出る） | `parser.ts` の `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` |
| `SELECT DISTINCT` 併用は可 | B125 §0 |
| 完全入力を要求（`AGGREGATE_WINDOW`） | B125 §3.5 |
| **`AS alias` 必須** | B125 |

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | `LAG(expr [, offset])` / `LEAD(expr [, offset])` の `OVER (PARTITION BY ... ORDER BY ...)` |
| **非対象** | **第 3 引数 `default`**（→ §2.3。型の一貫性が壊れるため**本 Phase では取らない**） |
| **非対象** | 移動フレーム（`ROWS BETWEEN n PRECEDING`）・値指定 `RANGE` |
| **非対象** | `FIRST_VALUE` / `LAST_VALUE` / `NTH_VALUE` |
| **非対象** | ウィンドウ結果を式に含める形（B129 の契約どおり） |

### 1.1 代表的な形（**実行して確認すること**）

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
  FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 年月
)
SELECT 年月, 出庫数,
       LAG(出庫数) OVER (ORDER BY 年月) AS 前月
FROM 月次 ORDER BY 年月
```

**前月比そのものは次の段で計算する**（ウィンドウ結果を式に含められないため・B129）。
**この 2 段構成が実行できることを受入で固定する。**

---

## 2. 意味論

### 2.1 値の取り方

**`LAG(expr, n)` はソート後パーティション内で `index - n` の行の `expr` を返す。**
`LEAD` は `index + n`。**パーティションの外に出たら空文字**（kSQL の NULL 相当）。

**集計ではないので空値スキップを通さない。** 参照先の行の値をそのまま返す
（参照先が空セルなら空文字）。

### 2.2 `offset`

- 省略時は **1**
- **非負の safe integer リテラルのみ**（`Number.isSafeInteger` かつ `>= 0`）。
  変数・式・小数・負数は **ParseError**
- **`0` は自分自身**（標準 SQL と同じ）

### 2.3 第 3 引数 `default` は取らない（旧レビュー「高」を回避）

旧 R1 は任意のスカラーリテラルを許しつつ「出力メタは引数型を継ぐ」としていたが、
**`LAG(数値, 1, 'N/A')` は通常行が数値・先頭行が文字列**になり、
**列全体の型が一貫しない**（下流の CTE `ORDER BY` / `MIN` / `MAX` / 比較が number comparator で
`'N/A'` を扱う）。

**本 Phase では `default` を構文ごと取らない。** 既定値が要るなら**次の段で `CASE`** を書く。
これで「引数型をそのまま継ぐ」契約が素直に成立する。

### 2.4 非全順序 `ORDER BY` のときの決定性（旧レビュー「中」）

**`ORDER BY` が全順序でないとき、`LAG` の参照先は入力順に依存する。**
B127 の既定フレーム警告と**同じ性質**なので、**同じ扱いにする**
（→ §3.4 で警告を出すかを決める）。

---

## 3. 実装方針（旧レビューの「高」4 件を先に潰す）

### 3.1 `isRankingWindow` を positive discriminator にする

**現行は「`AGGREGATE` でなければ RANKING」という二者択一**なので、
`windowKind: "VALUE"` を足すと **`isRankingWindow(valueWindow)` が `true` になる**。

```ts
// 現行（src/types/ast.ts:318-323）
export function isRankingWindow(column: WindowColumn): column is RankingWindowColumn {
  return column.windowKind !== "AGGREGATE";
}
```

**legacy（`windowKind === undefined`）だけを順位系互換として扱う。**

```ts
isRankingWindow   = (c) => c.windowKind === undefined || c.windowKind === "RANKING";
isAggregateWindow = (c) => c.windowKind === "AGGREGATE";
isValueWindow     = (c) => c.windowKind === "VALUE";
```

**`applyWindow` は 3 分岐を明示し、未知 kind は fail-closed。**

### 3.2 引数フィールドを required-field 収集へ入れる

**現行 walker は集計系だけ `arg` を走査する**ため、
`VALUE` を足しただけでは **`LAG(出庫)` の `出庫` が kintone から取得されない**
（`selectToKintone.ts:778-784`）。**B125 の集計引数漏れと同じ静かな誤り。**

**`VALUE` でも `walkAggregateArg(col.arg, "select")` を通す。**
**受入 SQL は引数を `SELECT` / `PARTITION BY` / `ORDER BY` のどこにも重複させない**
（重複していると漏れていても気づけない）。

### 3.3 型メタを引数から継ぐ（同期すべき箇所を名指しする）

**現行には「`AGGREGATE` でなければ number」という二者択一が複数ある。**
`VALUE` は `inferAggregateArgMeta` / `resolveAggregateArgSemantics` を通す。

| # | 箇所 | 内容 |
|---|---|---|
| 1 | `execute.ts:1691-1699` | scalar-subquery / 変数の numeric 判定 |
| 2 | `execute.ts:2597-2610` | alias semantics |
| 3 | `execute.ts:4284-4295` | `inferWindowColumnMeta` |
| 4 | `execute.ts:4304-4314` | **source metadata のロードゲート**（集計窓の `MIN`/`MAX` だけが対象になっている） |
| 5 | `execute.ts:4445-4446,5860-5862` | helper 呼び出し先 |
| 6 | `process.ts:1835-1841` | 出力 ORDER semantics |

**4 を直さないと、direct APP の `LAG(文字列/日付/選択肢)` で resolver が元メタを持たない。**

CTE / 一時テーブルへの伝播経路は既にある（`execute.ts:4972-4979` / `:1820-1825`）ので、
**上記を直せば後段まで伝わる。**

### 3.4 未確定（→ §6）

`ORDER BY` が全順序でないときに警告を出すか。**B127 と同じ判定器を使えるか**を実装時に確認する。

---

## 4. 受入条件

### 4.1 値

| 入力 | 期待 |
|---|---|
| `LAG(x) OVER (ORDER BY d)` の先頭行 | **空文字** |
| `LEAD(x) OVER (ORDER BY d)` の末尾行 | **空文字** |
| `LAG(x, 0)` | **自分自身** |
| `LAG(x, 2)` | 2 つ前 |
| `PARTITION BY` 境界 | **またがない**（各パーティションの先頭は空文字） |
| 参照先が空セル | **空文字**（集計の空値スキップを通さない） |
| `offset` に負数・小数・変数・式 | **ParseError** |
| 第 3 引数 | **ParseError**（本 Phase 非対象・§2.3） |

### 4.2 型（旧レビュー「高」の中核）

| 入力 | 期待 |
|---|---|
| `LAG(数値列)` | 下流で**数値として**比較・ソートされる |
| `LAG(日付列)` / `LAG(選択肢列)` / `LAG(文字列列)` | **引数の型を継ぐ** |
| **direct APP（CTE 経由でない）で `LAG(選択肢列)`** | **メタのロードゲートを通る**（§3.3-4） |
| CTE / 一時テーブルを経由 | 型が伝播する |

### 4.3 収集漏れ（§3.2）

**引数にしか現れない物理フィールド**（`SELECT` にも `PARTITION BY` にも `ORDER BY` にも
出さない）で `LAG` が正しい値を返すこと。

### 4.4 併存

1. **順位系・集計窓・`LAG` を同じ SELECT に混在**させ、それぞれ別の `ORDER BY` を持てる
2. `SELECT DISTINCT` との併用
3. `GROUP BY` との併用は **ParseError のまま**
4. **ウィンドウ結果を式に含める形は B129 の診断のまま**

### 4.5 実機

**§1.1 の 2 段構成**（月次集約 → `LAG` → 次段で前月比）が実データで動くこと。
**依頼元の実需そのもの**なので、**数値を独立に検算する**。

---

## 5. 影響範囲

| ファイル | 内容 |
|---|---|
| `types/ast.ts:318-323` | discriminator を positive に（§3.1） |
| `parser/parser.ts` | `LAG` / `LEAD` の分岐・`offset` 検証・第 3 引数の拒否 |
| `engine/process.ts:1047-1078` | `applyWindow` の 3 分岐＋`applyValueWindow` |
| `engine/process.ts:1835-1841` | 出力 ORDER semantics |
| `converter/selectToKintone.ts:778-784` | 引数フィールドの収集（§3.2） |
| `execute.ts`（§3.3 の 6 箇所） | 型メタとロードゲート |
| `docs/ksql_language_reference.md` §10.1 | `LAG` / `LEAD` |
| `docs/ksql_batch_recipes.md` | **前月比のレシピを 1 本**（B129 の教訓＝レシピは書く前に読まれる） |

**エンジンの変更なので、リリース時はフルビルド必須。**

---

## 6. 未確定（実装時に決めて報告する）

1. **`LAG` / `LEAD` を soft keyword にするか**（既存フィールド名との衝突。`parser` の方針）
2. **非全順序 `ORDER BY` の警告**を出すか。**B127 の判定器を再利用できるか**
3. `offset` の上限（パーティション長を超える値を弾くか、空文字で返すか）
