# B128 Phase 2a `LAG` / `LEAD` 仕様（R2）

- ステータス: ✅ **v3.51.0 でリリース**（2026-08-06） → [レビュー2](ksql_b128_codex_review_2.md)（高 1・中 7・低 1 を**全件反映**）
- 前提: [B125 Phase 1 仕様](ksql_b125_aggregate_window_phase1_spec.md)（v3.45.0 出荷済み）§10
- 旧スコープ: [移動フレーム込みの R1](ksql_b128_window_phase2_spec.md)（⏸ 棚上げ）と
  [そのレビュー](ksql_b128_codex_review_1.md)（高 9・中 7）
- 出典: [依頼元の回答 §6](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-B129-20260805.md)

> **スコープは `LAG` / `LEAD` だけ。移動フレームと値指定 `RANGE` は棚上げ**（依頼元が実測で組み替えを要請）。
> **旧レビューの「高」4 件は本 R2 で方向として解消**（レビュー2 の評価）。

> **R1 の誤り（レビュー2）**
> 1. **`offset` 超過の規範が §2.1 と §6-3 で矛盾**していた（高）→ **空文字に確定**（§2.2）
> 2. **完全入力の理由名が誤り**（中）＝`AGGREGATE_WINDOW` ではなく **`WINDOW_ORDER`**（§0）
> 3. **B129 の nested 検出は `LAG`/`LEAD` を自動では拾わない**（中）→ **scanner への追加が要る**（§3.5）
> 4. **「2 段構成」は数え方と SQL が一致しない**（中）＝**3 段**（§1.1）
> 5. **B127 の判定器は独立 helper ではない**（中）＝RANGE 専用 warning 関数内の inline 判定（§3.6）
> 6. §4.2 / §4.3 が**内部実装を要求する文**になっていた（中）→ **観測可能な受入**へ（§4）

---

## 0. 前提（B125 から引き継ぐ・変えない）

| 前提 | 根拠 |
|---|---|
| ウィンドウ列があれば FULL_SCAN 強制 | B125 §0 |
| `OVER (ORDER BY ...)` は **`sortDecoratedRows` の比較器を共有する**（比較の実装を二重に持たない。**ソート結果そのものを使い回す意味ではない**） | B125 §0・レビュー2 低1 |
| **`GROUP BY` / 集計関数との併用は ParseError のまま** | `parser.ts:1176-1180` |
| **ウィンドウ結果を同じ SELECT の式に含めるのは不可**（B129 の診断） | `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` |
| `SELECT DISTINCT` 併用は可 | B125 §0 |
| **完全入力の理由は `WINDOW_ORDER`**（`ORDER BY` 必須のため。**`AGGREGATE_WINDOW` ではない**） | `core/dmlGuard.ts:183-187`・レビュー2 中1 |
| **`AS alias` 必須** | B125 |

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | `LAG(expr [, offset])` / `LEAD(expr [, offset])` の `OVER (PARTITION BY ... ORDER BY ...)` |
| **非対象** | **第 3 引数 `default`**（§2.3） |
| **非対象** | 移動フレーム（`ROWS BETWEEN n PRECEDING`）・値指定 `RANGE` |
| **非対象** | `FIRST_VALUE` / `LAST_VALUE` / `NTH_VALUE` |
| **非対象** | ウィンドウ結果を式に含める形（B129 の契約） |

### 1.1 代表的な形は **3 段**（R1 から訂正・レビュー2 中4）

**ウィンドウ結果を式に含められない**ので、前月比まで出すには段が 3 つ要る。

```sql
WITH 月次 AS (                                    -- 1) 集約
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
  FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 年月
), 前月付き AS (                                   -- 2) LAG を列として出すだけ
  SELECT 年月, 出庫数, LAG(出庫数) OVER (ORDER BY 年月) AS 前月
  FROM 月次
)
SELECT 年月, 出庫数, 前月,                          -- 3) ここで比を計算する
       CASE WHEN 前月 = '' THEN ''
            ELSE ROUND((出庫数 - 前月) * 100.0 / 前月, 1) END AS 前月比
FROM 前月付き ORDER BY 年月
```

> **1 段目と 3 段目の形は現行で動くことを実測済み**（2026-08-06）。
> `WITH 月次 AS (... GROUP BY 年月) SELECT ..., SUM(出庫数) OVER (ORDER BY 年月 ROWS ...) FROM 月次`
> が 13 行を返す。**`LAG` 以外の構造はすでに成立している。**
>
> **同じ実測で依頼元の前提も裏取りできた**＝**履歴 13 か月すべてに行があり歯抜けが無い**
> （2025-08 〜 2026-08）。**月次なら B134 の 0 埋め問題を踏まない**という
> `LAG` 先行の根拠がデータで確認できている。

**3 段目の `CASE WHEN 前月 = ''` は「先頭行に前月が無い」ことの扱い**で、
**これが `default` を取らない代わりになる**（§2.3）。

---

## 2. 意味論

### 2.1 値の取り方

**`LAG(expr, n)` はソート後パーティション内で `index - n` の行の `expr` を返す。**
`LEAD` は `index + n`。

**集計ではないので空値スキップを通さない。** 参照先の行の値をそのまま返す
（参照先が空セルなら空文字）。

### 2.2 `offset`（R1 の矛盾を解消・レビュー2 高1）

- 省略時は **1**
- **非負の safe integer リテラルのみ**（`Number.isSafeInteger` かつ `>= 0`）。
  変数・式・小数・負数は **ParseError**
- **`0` は自分自身**（標準 SQL と同じ）
- **パーティションの外に出たら空文字。** **上限で弾かない。**
  R1 は §2.1 で「空文字」・§6-3 で「弾くかを決める」と書いており矛盾していた。**空文字に確定する。**

### 2.3 第 3 引数 `default` は取らない

`LAG(数値, 1, 'N/A')` は通常行が数値・先頭行が文字列になり、**列全体の型が一貫しない**
（下流の `ORDER BY` / `MIN` / `MAX` / 比較が number comparator で `'N/A'` を扱う）。

**構文ごと取らない。** 既定値が要るなら**3 段目で `CASE`**（§1.1 に実例）。

### 2.4 引数の評価（レビュー2 中7）

**`evaluateValueWindowArg(arg, row): string` を別に置く。**

- `FIELD` は `row[field] ?? ""` をそのまま返す
- 算術・文字列関数・`CASE`・連結は**既存の scalar evaluator を共有**する
- `null` / `undefined` / 非数値結果は **kSQL の NULL 相当 `""` へ正規化**
- **ソート後の行ごとに 1 回だけ評価する**（パーティションごとではない）
- **`aggregateRowValues()` は呼ばない**（空値スキップに入ってしまう）

### 2.5 非全順序 `ORDER BY` のときの決定性

**`ORDER BY` が全順序でないとき、`LAG` の参照先は入力順に依存する。**
警告の方針は §3.6。

---

## 3. 実装方針

### 3.1 `isRankingWindow` を positive discriminator にする（旧レビュー「高」）

**現行は「`AGGREGATE` でなければ RANKING」の二者択一**なので、`VALUE` を足すと誤判定される。

```ts
isRankingWindow   = (c) => c.windowKind === undefined || c.windowKind === "RANKING";
isAggregateWindow = (c) => c.windowKind === "AGGREGATE";
isValueWindow     = (c) => c.windowKind === "VALUE";
```

**`applyWindow` は 3 分岐を明示し、未知 kind は fail-closed。**

### 3.2 引数フィールドを required-field 収集へ入れる（旧レビュー「高」）

**現行 walker は集計系だけ `arg` を走査する**（`selectToKintone.ts:778-784`）ため、
`VALUE` を足しただけでは **`LAG(出庫)` の `出庫` が取得されない**。
**B125 の集計引数漏れと同じ静かな誤り。**

**`VALUE` でも `walkAggregateArg(col.arg, "select")` を通す。**

### 3.3 型メタを引数から継ぐ（同期すべき 6 箇所・旧レビュー「高」）

| # | 箇所 | 内容 |
|---|---|---|
| 1 | `execute.ts:1691-1699` | scalar-subquery / 変数の numeric 判定 |
| 2 | `execute.ts:2597-2610` | alias semantics |
| 3 | `execute.ts:4284-4295` | `inferWindowColumnMeta` |
| 4 | `execute.ts:4304-4314` | **source metadata のロードゲート**（集計窓の `MIN`/`MAX` だけが対象） |
| 5 | `execute.ts:4445-4446,5860-5862` | helper 呼び出し先 |
| 6 | `process.ts:1835-1841` | 出力 ORDER semantics |

**4 を直さないと direct APP の `LAG(選択肢列)` で resolver が元メタを持たない。**

### 3.4 parser の引数終端は comma-aware にする（レビュー2 中2）

**`LAG(expr, offset)` の `expr` は式**なので、**括弧の深さを見ながらトップレベルのカンマで区切る**。
`LAG(CASE WHEN a = 1 THEN b ELSE c END, 2)` のような形で
**`CASE` 内のカンマや関数引数のカンマを終端と誤認しない**こと。

**`LAG` / `LEAD` は soft keyword**（同名フィールドがあり得る）。
**`IDENT(LAG|LEAD)` の直後が `LPAREN`**、かつ対応する `RPAREN` の次が `OVER` のときだけ
ウィンドウとして解釈する。

### 3.5 B129 の nested 検出に `LAG` / `LEAD` を足す（レビュー2 中3）

**現行 scanner は aggregate token map だけを見ている**ので、
**`ROUND(LAG(x) OVER (...), 1)` や `CASE ... LAG(...) ...` は B129 の診断へ行かない。**

- nested scanner に **`IDENT(LAG|LEAD) + LPAREN ... RPAREN + OVER`** を加える
- **VALUE parser 自身も後続の算術・連結を B129 へ送る**（集計窓が `parser.ts:1564-1568` で
  やっているのと同じ形）

**受入は「関数で包む・算術に混ぜる・`CASE` の中」の 3 形**に分け、
**`WINDOW_RESULT_IN_EXPRESSION_MESSAGE` の本文を固定する**（単なる ParseError では不十分）。

### 3.6 全順序判定は helper を抽出してから使う（レビュー2 中5）

**B127 の判定は独立 helper ではなく、RANGE 専用 warning 関数内の inline 判定**。
**そのままでは再利用できない。**

**`canProveTotalWindowOrder(orderBy, resolveField, context)` を純粋 helper として抽出**し、
**B127 と VALUE warning の両方から呼ぶ。**

- VALUE 用の文言は「**同順内の前後関係は未規定。レコード番号等を追加**」
- **暗黙の `$id` タイブレークを共有 comparator に足してはならない**（既存の並びが変わる）
- **direct single APP / JOIN / CTE の各 context を受入に入れる**

---

## 4. 受入条件（**観測可能な形で書く**・レビュー2 中6）

### 4.1 値

| 入力 | 期待 |
|---|---|
| `LAG(x) OVER (ORDER BY d)` の先頭行 | **空文字** |
| `LEAD(x) OVER (ORDER BY d)` の末尾行 | **空文字** |
| `LAG(x, 0)` | **自分自身** |
| `LAG(x, 2)` | 2 つ前 |
| **`LAG(x, 999)`（パーティション長超）** | **空文字**（エラーにしない・§2.2） |
| `PARTITION BY` 境界 | **またがない** |
| 参照先が空セル | **空文字** |
| `offset` に負数・小数・変数・式 | **ParseError** |
| 第 3 引数 | **ParseError** |
| **`LAG(CASE WHEN ... THEN a ELSE b END, 2)`** | 通る（§3.4 の comma-aware） |

### 4.2 型（**出力を観測して固定する**）

内部 helper を直接見ない。**下流の振る舞いで確かめる。**

| 観測方法 | 期待 |
|---|---|
| `LAG(数値列)` の結果を**次の段で `ORDER BY`** | **数値順**（文字列順にならない） |
| `LAG(数値列)` を**次の段で `MIN`/`MAX`** | 数値として比較される |
| **direct APP（CTE 経由でない）で `LAG(選択肢列)` を次の段で `ORDER BY`** | **選択肢の定義順**（§3.3-4 のロードゲートが直っていないと崩れる） |
| `LAG(日付列)` / `LAG(文字列列)` を次の段で `ORDER BY` | 引数の型の順序 |

### 4.3 収集漏れ（**漏れたら値が空になる形で検出する**）

**引数にしか現れない物理フィールド**で `LAG` を使う。
**`SELECT` にも `PARTITION BY` にも `ORDER BY` にも出さない。**

| 入力 | 期待 |
|---|---|
| `SELECT 年月, LAG(出庫数) OVER (ORDER BY 年月) AS 前月 FROM ...`（`出庫数` は他に出さない） | **前月が空文字にならない**（漏れていれば空になる） |

### 4.4 B129 の 3 形（§3.5・**メッセージ本文を固定**）

| 入力 | 期待 |
|---|---|
| `ROUND(LAG(x) OVER (ORDER BY d), 1)` | `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` |
| `LAG(x) OVER (ORDER BY d) * 2` | 同上 |
| `CASE WHEN LAG(x) OVER (ORDER BY d) = 1 THEN ...` | 同上 |

### 4.5 併存・回帰

1. **順位系・集計窓・`LAG` を同じ SELECT に混在**させ、それぞれ別の `ORDER BY` を持てる
2. `SELECT DISTINCT` との併用
3. `GROUP BY` との併用は **ParseError のまま**
4. **完全入力の理由が `WINDOW_ORDER`** であること（`AGGREGATE_WINDOW` ではない・§0）
5. **`LAG` / `LEAD` という名前のフィールド**が従来どおり参照できる（soft keyword・§3.4）

### 4.6 実機

**§1.1 の 3 段構成**が実データで動くこと。**依頼元の実需そのもの**なので、
**前月比の数値を独立に検算する**（月次 13 行は実測済み）。

---

## 5. 影響範囲

| ファイル | 内容 |
|---|---|
| `types/ast.ts:318-323` | discriminator を positive に（§3.1） |
| `parser/parser.ts` | `LAG`/`LEAD` の分岐・comma-aware 終端・`offset` 検証・第 3 引数の拒否・**nested scanner への追加**（§3.4・§3.5） |
| `engine/process.ts:1047-1078` | `applyWindow` の 3 分岐＋`applyValueWindow` |
| `engine/process.ts:1835-1841` | 出力 ORDER semantics |
| `converter/selectToKintone.ts:778-784` | 引数フィールドの収集（§3.2） |
| `execute.ts`（§3.3 の 6 箇所） | 型メタとロードゲート |
| **B127 の warning 関数** | `canProveTotalWindowOrder` を抽出（§3.6） |
| `docs/ksql_language_reference.md` §10.1 | `LAG` / `LEAD` |
| `docs/ksql_batch_recipes.md` | **前月比のレシピを 1 本**（B129 の教訓＝レシピは書く前に読まれる） |

**エンジンの変更なので、リリース時はフルビルド必須。**

---

## 6. 未確定（実装時に決めて報告する）

1. **VALUE window に全順序の警告を出すか**（§3.6 の helper 抽出は行う前提で、
   **出す/出さないの最終判断**。B127 と同じ基準にできるか）
2. `applyValueWindow` の置き場所（`process.ts` 内で `applyAggregateWindow` の隣でよいか）
3. **`LAG` / `LEAD` を soft keyword にする実装方式**（既存の soft keyword の前例があるか）
