# B125 集計ウィンドウ関数 Phase 1 仕様（R2）

- ステータス: ✅ **実装済み**（2026-08-05・`npm test` 5,359 件成功・実機で外部検算済み）→ [実装報告](ksql_b123_b125_codex_impl_report.md)。**§3.2 の数値例は実装レビューでさらに訂正**（80 → 110）。→ [レビュー結果](ksql_b125_codex_review_1.md)（高 6・中 5・低 1、**全件を反映**）
- **フレーム既定はオーナー判断で確定（2026-08-05）＝標準どおり `RANGE`**（§3.2）
- 前提: [ウィンドウ関数仕様](ksql_window_function_spec.md)（v1）の §8「スコープ外・後続」の実装
- 関連: [B125 起票](ksql_b125_aggregate_window_function_issue.md) / [B124](ksql_b124_aggregate_arithmetic_nonaggregate_operand_issue.md)（独立）/
  [B123](ksql_b123_explain_groupby_metadata_issue.md)（`explainMetadata` の同じ関数を触る・§7.3）

> **R1 からの主な訂正**（詳細は §12）
> - **`SELECT DISTINCT` 併用は v1 で実装済み**。R1 の「不可」は誤りで、**維持**する
> - **§3.2 の `RANGE` 値が誤っていた**（130 → **80**）。同順グループの**末尾**値である
> - **集計引数のフィールドが取得対象に入らない**（`selectToKintone`）— 追加が必須
> - **`ORDER BY` 無しの集計ウィンドウが完全入力を要求しない** — 新 reason を追加
> - **`WINDOW_COL` は一律「数値」と型メタ判定されている** — `MIN`/`MAX` で壊れる
> - **「通常集計値と必ず一致」は浮動小数と canonical 同値では成立しない** — 契約を弱める

---

## 0. 確定事項（v1 から引き継ぐ前提）

| 前提 | 内容 | 根拠 |
|---|---|---|
| FULL_SCAN 強制 | ウィンドウ列があれば必ず FULL_SCAN | `selectToKintone.ts:75-81`（`hasWindowColumns` → `FULL_SCAN`） |
| 比較器の共有 | `OVER (ORDER BY ...)` は `sortDecoratedRows` を使う | v1 §5.1。**comparator は ORDER BY キーのみを比較し安定化 index を含まない**（`process.ts:895-921`・レビューで確認済み）ため §6.3 に流用できる |
| ソートメタのゲート | `optionOrders` / `sortKinds` / `fieldSemantics` を渡す | v1 §2.3。落とすと数値が辞書順になり**静かに誤る** |
| `GROUP BY` / 集計関数との併用 | **ParseError のまま**（`parser.ts:1176-1180`） | v1 §4.8。月次の累計は CTE 2 段（§10） |
| alias 必須 | `AS alias` が無ければ ParseError | v1 §4.1 |
| **`SELECT DISTINCT` 併用** | **可（v1 で実装済み）。維持する** | パーサの拒否条件に `distinct` は無く、`applyWindow` の後に `applyDistinct` が走る。`buildDistinctTuple` はウィンドウ列の alias 値をキーに含める |
| `KORDER BY` 併用 | 結果として不可。ただし **ParseError ではなく planner が拒否**（`korderPlanner.ts:30-35` が `staticMode !== "SIMPLE"` を `KORDER_QUERY_SHAPE_UNSUPPORTED`） | 診断の文言と発生フェーズを受入で固定する（§8.4） |

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象関数** | `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` の `OVER`（`COUNT(*)` を含む） |
| **対象フレーム** | 既定（§3.2）＋ 明示の `{ROWS \| RANGE} BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` |
| **対象位置** | **SELECT のトップレベル単独列のみ**（§5.1） |
| **非対象（Phase 2）** | 移動フレーム・`RANGE` の値指定・`LAG` / `LEAD` / `NTILE` / `FIRST_VALUE` |
| **非対象（Phase 1）** | `DISTINCT` **引数**（`SUM(DISTINCT x) OVER`）・`GROUP_CONCAT` / 統計集計 6 種の `OVER`（§1.1）・**ウィンドウ結果を算術式や関数に入れる形**（§5.3） |
| **非対象（v1 踏襲）** | `GROUP BY` / 集計関数との併用・`KORDER BY` 併用・`QUALIFY` |

> **`SELECT DISTINCT` は非対象ではない。** 引数の `DISTINCT`（`SUM(DISTINCT x)`）だけが Phase 1 非対象。

### 1.1 対象関数を 5 つに絞る理由

`MEDIAN` / `MODE` / 分散系は**増分計算できず**フレームが伸びるたび全体を見直すため O(N²) になる。
`GROUP_CONCAT` は累積すると出力が O(N²) バイトになる。実需は 5 関数で満たせる。

---

## 2. 構文

```
<集計関数>( <引数> ) OVER ( [PARTITION BY <フィールド> [, …]]
                            [ORDER BY <キー> [ASC|DESC] [, …] [<フレーム>]] ) AS <alias>

<集計関数> := SUM | COUNT | AVG | MIN | MAX
<引数>     := * （COUNT のみ） | <既存の集計引数>（フィールド / 算術式 / 関数 / CASE / || / @var）
<フレーム> := { ROWS | RANGE } BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
```

- 引数の文法は**既存の集計関数と完全に同じ**（`AggregateArgExpr` をそのまま使う）
- `PARTITION BY` はフィールド参照のみ、`OVER (ORDER BY ...)` は `OrderByItem` 再利用（v1 と同じ）
- `AS alias` 必須
- フレーム句は `ORDER BY` の後ろにのみ書ける。`ORDER BY` 無しでフレーム句 → **ParseError**（§3.3）
- `ROWS` / `RANGE` / `UNBOUNDED` / `PRECEDING` / `CURRENT` / `ROW` は **soft keyword**（同名フィールドを壊さない）

### 2.1 例

```sql
-- 行ごとの残高（台帳）
SELECT 製品名, 日付, 個数_在庫計算用,
       SUM(個数_在庫計算用) OVER (
         PARTITION BY 製品名 ORDER BY 日付, レコード番号
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS 累積在庫
FROM APP4228

-- 製品ごとの取引件数を全行に載せる（ORDER BY 無し＝パーティション全体）
SELECT 製品名, 日付, COUNT(*) OVER (PARTITION BY 製品名) AS 製品の取引件数
FROM APP4228
```

---

## 3. 意味論

### 3.1 パーティションと順序

v1 と同じ。`PARTITION BY` 省略時は全行が 1 パーティション。

### 3.2 フレームの既定（確定・標準準拠）

| `ORDER BY` | 既定フレーム | 意味 |
|---|---|---|
| **あり** | `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | 先頭から**現在行と同順の行の末尾**まで |
| **なし** | パーティション全体 | 全行が同じ値（＝通常集計の総計） |

**`RANGE` と `ROWS` の違い（同順があるときだけ現れる）**

同日 3 件（前日までの残高 60）の例:

| 日付 | 増減 | `ROWS`（明示時） | `RANGE`（既定） |
|---|---:|---:|---:|
| 2026-03-18 | +100 | 160 | **110** |
| 2026-03-18 | −30 | 130 | **110** |
| 2026-03-18 | −20 | 110 | **110** |

> **この表は 2 回間違えている。** R1 は `RANGE` を 130 とし（同順グループの先頭寄りの値）、
> R2 初版は 80 とした（R1 の別の前提残高のまま残した算術誤り）。**正しくは 110**＝
> `ROWS` の最終値であり、同順グループの**末尾**の値。実装レビュー（codex）で検出。
> `RANGE` は「日次残高」、`ROWS` は「取引ごとの残高」。
>
> **教訓**: この表は「同順グループの末尾を書き戻す」というアルゴリズムから一意に決まる。
> **アルゴリズムと数値例を別々に書くと、数値例だけが腐る。**
> 受入（§8.2）で全増減を含む期待値を固定しているのは、まさにこれを検出するため。

**どちらも正しく、問いによって欲しいものが違う。** 緩和策は 3 点セット（`ROWS` の明示・
`EXPLAIN` の実効フレーム表示（§7.2）・言語リファレンスへの上表の転載（§9））。

### 3.3 フレーム句と `ORDER BY` の関係

- `ORDER BY` 無し ＋ フレーム句あり → **ParseError**（順序未定義のフレームは意味が定まらない。
  Phase 2 での緩和は純加法）
- `ORDER BY` あり ＋ フレーム句無し → §3.2 の既定（`RANGE`）
- `ORDER BY` あり ＋ フレーム句あり → 明示に従う

### 3.4 値の規則（既存の集計関数と共有）

空値・NaN のスキップ、`MIN` / `MAX` の比較規則、`COUNT(*)` と `COUNT(field)` の違いは
すべて既存の `evalAggregate` の規則をそのまま使う（§6.2）。

**ただし「通常集計値と必ず一致する」とは言えない。** 次の 2 つは例外として契約から外す。

| 例外 | 理由 | 契約 |
|---|---|---|
| **浮動小数の加算順序** | 通常集計は入力行順、ウィンドウは `ORDER BY` 後の順で加算する。binary64 の加算は順序依存（`[1e16, -1e16, 1]` と `[1e16, 1, -1e16]` は結果が違う） | **整数入力では完全一致を要求。小数を含む場合は相対誤差 1e-12 以内**（§8.1） |
| **`MIN`/`MAX` の canonical 同値時の raw 表記** | 既存実装は canonical 比較が同値なら**先に現れた raw** を保持する。走査順が違えば `"1"` と `"01"` のどちらが残るかが変わる | **raw 表記は契約に含めない。** 一致判定は canonical 比較で行う。言語リファレンスにも明記 |

### 3.5 完全入力（新規・重要）

**集計ウィンドウは、フレームにかかわらず完全入力を要求する。**

現行の完全入力判定は `column.type === "WINDOW_COL" && column.orderBy.length > 0` のときだけ
`WINDOW_ORDER` を立てる（`dmlGuard.ts:182`）。このままだと
`COUNT(*) OVER (PARTITION BY 製品名)` が `onLimit=truncate` で**切れた入力をパーティション全体として
集計し、もっともらしい誤値を全行に書く**。

→ **新しい reason `AGGREGATE_WINDOW` を追加**し、集計ウィンドウ列があれば
`orderBy` の有無に関係なく完全入力とする。FULL_SCAN は評価場所を決めるだけで、
部分入力を防がない点に注意（§0 の FULL_SCAN 強制とは別の保証）。

### 3.6 出力

既存のウィンドウ列と同じく**文字列で `row[alias]` に格納**する（v1 と同じ）。

---

## 4. AST

```ts
export type WindowFunc = "ROW_NUMBER" | "RANK" | "DENSE_RANK";           // 既存・不変
export type WindowAggFunc = "SUM" | "COUNT" | "AVG" | "MIN" | "MAX";     // 追加
export type WindowFrameUnit = "ROWS" | "RANGE";                          // 追加

/** Phase 1 は開始・終了が固定なので unit と由来だけを持つ。Phase 2 で境界を足す。 */
export interface WindowFrame {
  unit: WindowFrameUnit;
  source: "DEFAULT" | "EXPLICIT";   // EXPLAIN の (既定) 表示に必要（§7.2）
}

export interface RankingWindowColumn extends SelectAliasDisplay {
  type: "WINDOW_COL";
  windowKind?: "RANKING";           // 省略可＝既存 AST がそのまま通る
  func: WindowFunc;
  partitionBy: FieldRef[];
  orderBy: OrderByItem[];
  alias: string;
}

export interface AggregateWindowColumn extends SelectAliasDisplay {
  type: "WINDOW_COL";
  windowKind: "AGGREGATE";
  aggFunc: WindowAggFunc;
  arg: WildcardColumn | AggregateArgExpr;   // 既存の集計引数
  frame: WindowFrame | null;                // null = ORDER BY 無し（パーティション全体）
  partitionBy: FieldRef[];
  orderBy: OrderByItem[];
  alias: string;
}

export type WindowColumn = RankingWindowColumn | AggregateWindowColumn;

/** 既存 AST（windowKind 未設定）も順位系として絞れる。参照は必ずこれを通す。 */
export function isRankingWindow(c: WindowColumn): c is RankingWindowColumn {
  return c.windowKind !== "AGGREGATE";
}
```

**`windowKind === "RANKING"` を直接書かないこと。** 既存 AST の `undefined` を取りこぼす。
必ず `isRankingWindow` を経由する（レビュー指摘・重要度 低）。

### 4.1 型メタの契約（新規・重要）

現行コードは `WINDOW_COL` を**無条件に数値**として扱う。

```ts
// process.ts:1728-1734 / execute.ts に同形が複数
if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL" || column.type === "WINDOW_COL") {
  result.set(column.alias, syntheticSemantics("number"));
}
```

順位系だけなら正しいが、集計ウィンドウの `MIN` / `MAX` は**引数の意味型**（文字列・日時・選択肢定義順）
を引き継がなければならない。引き継がないと CTE / 一時テーブルへ実体化した後の比較・`ORDER BY`・
後段集計・スカラーサブクエリ判定が数値扱いになり、**文字列 `MIN`/`MAX` の結果が壊れる**。

| ウィンドウ列 | 型メタ |
|---|---|
| 順位系（`ROW_NUMBER`/`RANK`/`DENSE_RANK`） | number（現行どおり） |
| `SUM` / `COUNT` / `AVG` | number |
| **`MIN` / `MAX`** | **通常集計と同じ `inferAggregateArgMeta` / `resolveAggregateArgSemantics` を通す** |

---

## 5. パーサ

### 5.1 変更点は `parseSelectColumn` のトップレベル集計分岐 1 箇所

`parseAggregateRef` は集計算術式・スカラー式・`CASE` 内・`HAVING` からも呼ばれる。
**`parseAggregateRef` 自体に `OVER` 先読みを入れてはいけない**（戻り型が合わず、
許可していない位置まで窓構文を飲み込む）。

→ **`parseSelectColumn` が `parseAggregateRef` を呼んだ直後にだけ `OVER` を先読みする。**
`OVER (...)` 以降の読み取りは既存 `parseWindowColumn` と共有する。

### 5.2 診断

| 入力 | メッセージ |
|---|---|
| `MEDIAN(x) OVER (...)` 等の対象外関数 | `<関数> のウィンドウ集計は未対応です。対応は SUM / COUNT / AVG / MIN / MAX です` |
| `SUM(DISTINCT x) OVER (...)` | `ウィンドウ集計では引数の DISTINCT を使用できません` |
| `ORDER BY` 無しでフレーム句 | `フレーム句には OVER (ORDER BY ...) が必要です` |
| 移動フレーム | `対応するフレームは BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW だけです` |
| `HAVING` / `ORDER BY` に直接記述 | `ウィンドウ関数は SELECT 列にのみ記述できます` |
| alias 無し | 既存（`ウィンドウ関数には AS alias が必要です`） |

### 5.3 ウィンドウ結果を式に入れる形（Phase 1 非対応）

`SUM(a) OVER (...) * 2` / `ROUND(SUM(a) OVER (...), 0)` / `CASE` 内は **Phase 1 非対応**。
現状設計のままだと、窓パーサが `AS` を期待する位置で `*` に当たって拒否される（自然な落ち方）。
**この形のメッセージを受入に固定する**（診断が「AS が必要」だけだと理由が伝わらないため、
`ウィンドウ関数の結果を式に含めることはできません。CTE で一度実体化してください` を出す）。

### 5.4 併用チェック

`parser.ts:1176-1180` の既存チェックはそのまま効かせる。集計ウィンドウ列は `WINDOW_COL` なので
`selectColumnHasAggregate` には入らない（行を畳まないので正しい）。
したがって `GROUP BY` / 通常集計との併用は従来どおり ParseError。**`distinct` は拒否条件に無く、そのまま。**

---

## 6. 実行

### 6.1 既存ループへの追加

`applyWindow`（`process.ts:1022-1061`）の「パーティション分割 → ソート → 走査」に乗せる。
同順境界の検出（`sortedResult.compare(...) !== 0`）は `RANK` 用に既にあり、
**comparator が ORDER BY キーのみを比較する**ことはレビューで確認済み（§0）。

### 6.2 値の計算（O(N)・意味論は `evalAggregate` と共有）

`evalAggregate` の「行 → 値 / スキップ」部分を切り出して共有する。

```ts
function aggregateRowValues(
  func: AggregateFunc, arg: AggregateArgExpr, rows: ProcessRow[]
): (string | null)[]   // 長さ = rows.length。null = スキップ
```

**事後条件（明記が必要・レビュー指摘）**:

- **`COUNT(*)`（`WILDCARD`）はこのヘルパーを通さない。** 現行どおり別分岐で行数を数える
  （ウィンドウ側は「累積行数」として別に扱う）
- 返り値は**行数と同じ長さ**。既存 `evalAggregate` は
  `values.filter(v => v !== null)` を**一度だけ**行い、その後は現行どおり
  **Number 化 → 例外 → DISTINCT → 集計**の順序を維持する（順序を変えない）
- 実値としての `null` は `ProcessRow` では表現されず、`evalScalarValueExprNullable` の `null` は
  既にスキップ扱いなので、sentinel との衝突は無い（レビューで確認済み）

**累積**は 5 関数とも増分で行う（`SUM`/`COUNT` は加算、`AVG` は和と件数、
`MIN`/`MAX` は既存比較器で走査中の最良値を保持）。

### 6.3 `ROWS` → `RANGE` の変換

1. `ROWS` 意味論で行ごとの累積値を出す（増分・O(N)）
2. `RANGE` の場合、**同順グループの末尾の値をそのグループ全行へ書き戻す**

`frame === null`（`ORDER BY` 無し）はパーティション全体なので最終値を全行へ書く。

> **受入で「先頭値を書き戻す誤実装」を検出すること**（§8.2）。期待値を「同じ値」とだけ書くと
> 先頭値でも通ってしまう。

---

## 7. 既存箇所への影響（`WINDOW_COL` 参照 13 ファイル）

**プロダクション 11 + テスト 2。** 各参照を 3 分類する。

| 分類 | 意味 |
|---|---|
| **(a)** | 存在判定のままでよい |
| **(b)** | 順位系に絞る（`isRankingWindow`） |
| **(c)** | 集計系の引数・型メタ・完全入力を追加処理する |

| ファイル | 分類 | 内容 |
|---|---|---|
| `converter/selectToKintone.ts:771-773` | **(c)** | **必須**。現行は `partitionBy` / `orderBy` しか集めない。**集計引数の物理フィールドが取得されず、全行が `undefined` でスキップされる**。既存の集計引数と同じ walker で `FIELD_REF` / 算術式 / 関数 / `CASE` / `\|\|` / `@var` を再帰収集する |
| `converter/selectToKintone.ts:75-81` | (a) | FULL_SCAN 強制。不変 |
| `core/dmlGuard.ts:175-184` | **(c)** | `AGGREGATE_WINDOW` reason の追加（§3.5） |
| `engine/process.ts:1051-1055` | **(b)** | `window.func` を直接読む唯一のプロダクション箇所 |
| `engine/process.ts:1728-1734` | **(c)** | 型メタ。`MIN`/`MAX` を数値と決めつけない（§4.1） |
| `execute.ts:1686-1693, 2490-2510, 4287-4288, 5655-5675` | **(c)** | 同上（型メタが 4 箇所ある）。**必須レビュー対象** |
| `core/explainMetadata.ts:68-74` | (a) | `orderBy` 有無の判定は集計ウィンドウでも正しい（レビューで確認済み） |
| `core/optimization/canonicalOrderPlanner.ts:68-100` | (a) | window order keys を含める現行設計は集計窓にも適用できる |
| `core/optimization/plainGroupByPlan.ts` | (a) | `GROUP BY` 併用は拒否済みなので到達しない。**到達しないことを確認** |
| `core/groupingValidation.ts` / `core/applyPatchScope.ts` | (a)/(b) | 存在判定のみか確認し、`func` を読んでいれば (b) |
| `types/ast.ts` | — | §4 |
| `parser/parser.ts` | — | §5 |
| `core/optimization/__tests__/b71PlainGroupByPlan.test.ts` / `parser/__tests__/window.test.ts` | — | テスト。AST 変更に追従 |

### 7.2 `EXPLAIN` に実効フレームを出す（必須）

```
  window 累積在庫: SUM OVER (PARTITION BY 製品名 ORDER BY 日付)
    frame: RANGE UNBOUNDED PRECEDING AND CURRENT ROW (既定)
```

`(既定)` の有無は AST の `frame.source` で判定する（§4）。**既定と明示 `RANGE` の表示差を受入に入れる。**

### 7.3 実装順

**B123 → B125。** `explainMetadata.ts` の同じ関数を両方が触る。B123 は純加法 1 条件なので先に入れる。

---

## 8. 受入条件

APP4228（1,000 件・**同日取引がある製品を必ず含める**）で検証する。

### 8.1 一致条件（§3.4 の機械的検証）

**フレームがパーティション全体に一致する行では、ウィンドウ値 = 通常集計値。**
ただし §3.4 の 2 例外を織り込む。

| 検証 | 期待 |
|---|---|
| `SUM(個数_在庫計算用) OVER (PARTITION BY 製品名)` の各行 | `GROUP BY 製品名` の `SUM` と製品ごとに一致（**整数なので完全一致**） |
| `ORDER BY` 付きのパーティション最終行 | 同上 |
| `COUNT(*)` / `COUNT(field)` / `MIN` / `MAX` の同形 | 同上（`MIN`/`MAX` は **canonical 比較で一致**。raw 表記は問わない） |
| **小数を含むデータ**での `SUM` / `AVG` | **相対誤差 1e-12 以内**。**桁差・相殺を含むケースを必ず入れる**（整数だけの APP4228 では加算順序の欠陥を検出できない） |

### 8.2 フレームの意味論

前日までの残高がある製品で、**同日 3 件の全増減を含む期待値を固定する**（「同じ値」だけにしない）。

| SQL | 期待 |
|---|---|
| `SUM(x) OVER (PARTITION BY 製品名 ORDER BY 日付)` | 同順グループの全行が**末尾の値**。**先頭値を書き戻す誤実装が落ちること** |
| `… ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | 同日でも行ごとに増える |
| `… RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | 既定と同じ値。**`EXPLAIN` の `(既定)` 表示だけが違う** |
| `… ORDER BY 日付, レコード番号`（全順序） | `RANGE` でも行ごとに増える |
| `SUM(x) OVER (PARTITION BY 製品名)`（`ORDER BY` 無し） | 全行がパーティション合計 |

### 8.3 取得と完全入力

| 検証 | 期待 |
|---|---|
| **集計引数のフィールドを `SELECT` に書かない形**（`SELECT 製品名, SUM(金額) OVER (ORDER BY 日付) AS 累計`） | `金額` が取得され、正しい値が出る（**現行の欠陥を直接突く**） |
| `onLimit=truncate` ＋ 上限到達（`ORDER BY` **無し**の集計ウィンドウ） | **部分結果を返さずエラー**（`AGGREGATE_WINDOW`） |
| 同上（`ORDER BY` あり） | 同上 |

### 8.4 診断

§5.2 の 6 形と §5.3 の式内記述が、それぞれ指定のメッセージで**取得前に**止まること。
`KORDER BY` 併用は **planner の `KORDER_QUERY_SHAPE_UNSUPPORTED`** で止まること（ParseError ではない）。

### 8.5 外部検算

`ksql-analytics` の `scripts/inv_v2_runstock.mjs` の出力（8 製品 × 最小・平均・最大・最終）と一致すること。
**このスクリプトは行ごと累積なので `ROWS` ＋ `ORDER BY 日付, レコード番号` と突き合わせる。**

### 8.6 回帰（必須）

1. **`evalAggregate` の切り出しで 12 集計の挙動が不変**。B119〜B122 の受入を全再実行。
   とくに `MIN`/`MAX` が空文字を候補に残す分岐、統計集計の Number 化と例外、
   `DISTINCT` の適用単位（通常 6 は raw 文字列単位・統計は数値同値単位）と**その順序**
2. **`ROW_NUMBER` / `RANK` / `DENSE_RANK` の値と並びが 1 つも変わらない**
3. **`SELECT DISTINCT` ＋ ウィンドウ列が従来どおり動く**（v1 の受入をそのまま再実行）
4. FULL_SCAN 強制の維持
5. `GROUP BY` / 通常集計との併用が従来どおり ParseError
6. ソートメタのゲート（数値が辞書順にならない）— v1 §2.3 の受入を再実行
7. **比較は桁を変えた境界値で行う**（桁が揃うと文字列比較でも通り検出力が無い）
8. **複数の集計ウィンドウ列を含む形**を性能受入に入れる（列数 × N の CPU）

---

## 9. 文書（実装とセットで入れる）

1. **言語リファレンス §10.1** に集計ウィンドウの節を足し、**§3.2 の比較表を正しい数値で載せる**
2. **`ksql_docs` のセクションに `window-functions` を足す**。現在 §10.1 は独立節なのに
   セクション一覧（26 個）に無く `order-by` に畳まれており、**AI が「窓関数は無い」と
   誤判断した実例がある**
3. **`MIN`/`MAX` の canonical 同値時の raw 表記は不定**であることを明記（§3.4）
4. `ksql://recipes` に「累積残高（台帳）」を 1 本（`ROWS` 明示＋タイブレークキー付き）

---

## 10. スコープ外と回避策

| 要望 | Phase 1 での書き方 |
|---|---|
| 月次集計の累計 | CTE 2 段（`WITH 月次 AS (… GROUP BY 月) SELECT 月, SUM(合計) OVER (ORDER BY 月 …) FROM 月次`） |
| ウィンドウ結果を式に入れる | CTE で一度実体化してから式にする |
| 移動平均 | Phase 2（移動フレーム） |
| 前月比 | Phase 2（`LAG` / `LEAD`） |

---

## 11. 未確定（R3 までに詰める・レビュー反映後）

1. ~~`AVG` の丸め~~ → **§3.4 で確定**（整数は完全一致・小数は相対誤差 1e-12）。
   通常集計側を順序非依存な加算へ変える案は**別課題**として切り出す（全集計に波及するため）
2. ~~`canonicalOrderPlanner` の扱い~~ → **(a) 現行のままでよい**（レビューで確認済み）。
   必要なのは planner ではなく §3.5 の完全入力 guard
3. ~~規模の上限~~ → **設けない**（O(N) 時間・O(N) 追加値のため）。ただし §8.6-8 の性能受入を入れる
4. **残**: `groupingValidation.ts` / `applyPatchScope.ts` が `func` を読んでいるかの確認（§7 の (a)/(b) 判定）

---

## 12. レビュー反映履歴

[codex レビュー 1 回目](ksql_b125_codex_review_1.md)（高 6・中 5・低 1）。**全 12 件を反映。**

| # | 重要度 | 指摘 | 反映 |
|---|---|---|---|
| 1 | 高 | 集計引数の物理フィールドが取得されない | §7 に (c) として必須明記・§8.3 に受入追加 |
| 2 | 高 | `MIN`/`MAX` が一律「数値」と型メタ判定される | §4.1 を新設・§7 に `execute.ts` 4 箇所を追加 |
| 3 | 高 | `ORDER BY` 無し集計ウィンドウが完全入力を要求しない | §3.5 を新設（`AGGREGATE_WINDOW`）・§8.3 に受入追加 |
| 4 | 高 | 浮動小数では「通常集計と必ず一致」が成立しない | §3.4 の例外表・§8.1 に小数ケース追加・§11.1 を確定 |
| 5 | 高 | canonical 同値の `MIN`/`MAX` は raw 出力が変わる | §3.4 で raw 表記を契約から外す・§9.3 に文書化 |
| 6 | 高 | **`SELECT DISTINCT` 併用不可は既存契約と逆** | §0・§1 を訂正（**併用可・維持**）・§8.6-3 に回帰追加 |
| 7 | 中 | `RANGE` 比較表の値が末尾値になっていない | §3.2 の表を修正（130 → 80）・§8.2 で先頭値誤実装を検出 |
| 8 | 中 | AST から「既定か明示か」が失われる | §4 に `frame.source` を追加 |
| 9 | 中 | `aggregateRowValues` の契約が `COUNT(*)` と順序を固定できていない | §6.2 に事後条件を明記 |
| 10 | 中 | パーサ「1 箇所」はトップレベル単独列に限る | §5.1 を限定・§5.3 を新設 |
| 11 | 中 | 13 ファイルの内訳と §7 の列挙が不一致 | §7 を 11+2 で全列挙し (a)/(b)/(c) に分類 |
| 12 | 低 | `windowKind?: "RANKING"` は判別ユニオンとして非対称 | §4 に「必ず `isRankingWindow` を経由」と明記 |

**仕様が正しかった点**（R2 で消さないための記録）: FULL_SCAN 強制・comparator が
ORDER BY キーのみ（`RANGE` 流用の前提）・§6.3 のアルゴリズム・`evalAggregate` 共有の方向・
DISTINCT の適用単位の認識・`MIN`/`MAX` が空文字を候補に残す認識・`selectColumnHasAggregate` に
入らないこと・ユニオン化の方向・`explainMetadata` の存在判定・`canonicalOrderPlanner` の現行設計。
