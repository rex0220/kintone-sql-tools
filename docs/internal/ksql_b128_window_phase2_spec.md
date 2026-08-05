# B128 集計ウィンドウ Phase 2（移動フレーム / `LAG` / `LEAD`）仕様（R1）

- ステータス: 📋 **仕様 R1（レビュー前）**
- 前提: [B125 Phase 1 仕様](ksql_b125_aggregate_window_phase1_spec.md)（v3.45.0 出荷済み）の §10 で
  Phase 2 と明記したもの
- 出典: [ksql-analytics の依頼 ③](../../../ksql-analytics/docs/internal/kSQLエンジンへの依頼-20260805.md) /
  [triage](ksql_analytics_request_20260805_evaluation.md)

> **実需の裏づけ（依頼元の言葉）**
> B125 で累積が SQL に戻った結果、**明細を CSV へ落としてローカル計算する理由は 2 つだけ**になった。
> ①**移動平均**（7 日移動平均の在庫・出庫）②**前期比**（`LAG` / `LEAD`）。
> **フレームが固定境界のみのため CTE を重ねても書けず**、自己結合も `JOIN ... ON` が
> 等値 1 本なので「前月」を作れない。

---

## 0. 前提（B125 から引き継ぐ・変えない）

| 前提 | 根拠 |
|---|---|
| ウィンドウ列があれば FULL_SCAN 強制 | B125 §0 |
| `OVER (ORDER BY ...)` は `sortDecoratedRows` を共有（比較器を二重実装しない） | B125 §0 |
| ソートメタのゲート（`optionOrders` / `sortKinds` / `fieldSemantics`）を渡す | B125 §0 |
| **`GROUP BY` / 集計関数との併用は ParseError のまま** | `parser.ts:1176-1180` |
| `SELECT DISTINCT` 併用は可 | B125 §0 |
| 完全入力を要求（`AGGREGATE_WINDOW`） | B125 §3.5 |
| 空値・`MIN`/`MAX` の比較規則は通常集計と共有（`aggregateRowValues`） | B125 §6.2 |
| **既定フレームは `RANGE`。B127 の警告が出る** | v3.47.0 相当（実装済み・未リリース） |

---

## 1. スコープ

**2 段に分ける。** 性質が違い、片方だけでも実需の半分を満たす。

### Phase 2a: 移動フレーム（**先**）

| 区分 | 内容 |
|---|---|
| **対象** | `ROWS BETWEEN <start> AND <end>` の**行数指定** |
| **対象の境界** | `<n> PRECEDING` / `CURRENT ROW` / `<n> FOLLOWING` / `UNBOUNDED PRECEDING` / `UNBOUNDED FOLLOWING` |
| **対象関数** | Phase 1 と同じ `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` |
| **非対象** | **`RANGE` の値指定**（`RANGE BETWEEN INTERVAL ...`）。日付の「7 日間」は行数と別物で、別途評価 |

### Phase 2b: `LAG` / `LEAD`（**後**）

| 区分 | 内容 |
|---|---|
| **対象** | `LAG(expr [, offset [, default]])` / `LEAD(...)` `OVER (...)` |
| **非対象** | `FIRST_VALUE` / `LAST_VALUE` / `NTH_VALUE` / `NTILE`（実需が出てから） |

---

## 2. Phase 2a 構文

```
{SUM|COUNT|AVG|MIN|MAX}( 引数 ) OVER (
  [PARTITION BY ...]
  ORDER BY ...
  ROWS BETWEEN <start> AND <end>
) AS alias

<start> := UNBOUNDED PRECEDING | <n> PRECEDING | CURRENT ROW | <n> FOLLOWING
<end>   := <n> PRECEDING | CURRENT ROW | <n> FOLLOWING | UNBOUNDED FOLLOWING
```

```sql
-- 7 日移動平均（直近 7 行）
SELECT 日付, 出庫,
       ROUND(AVG(出庫) OVER (
         ORDER BY 日付
         ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ), 1) AS 移動平均7
FROM APP100
```

- `<n>` は**非負整数リテラル**。変数・式は非対象
- **`ORDER BY` 必須**（`ROWS` の意味が定まらないため）。B125 §3.3 と同じ規則
- `start` が `end` より後ろ（空フレーム）になる指定は**受理し、空フレームの値を返す**（§3.2）

---

## 3. Phase 2a 意味論

### 3.1 フレームの決まり方

行番号 `i`（パーティション内・ソート後・0 始まり）に対し、
`ROWS BETWEEN a PRECEDING AND b FOLLOWING` の対象は `[i-a, i+b]` を
パーティションの範囲でクリップした行。**`RANGE` と違い同順を考慮しない**（行数で数える）。

### 3.2 空フレームの値（**Phase 1 と揃える**）

フレームに 1 行も入らない、または全行がスキップ対象のとき、
**Phase 1 の「全行スキップ時の値」と同じ**にする（`SUM`/`COUNT`/`AVG` は `0`、
`MIN`/`MAX` は `best ?? 0` の既存挙動）。**新しい規則を作らない。**

> **要確認（§7-1）**: 標準 SQL は空フレームの `SUM` を NULL とするが、
> kSQL は空入力の `SUM` を `0` としている（Phase 1 で確認済み）。
> **kSQL の既存規則に合わせる**方針でよいかを R2 で確定する。

### 3.3 計算量（**設計の中心**）

Phase 1 は「先頭から積む」だけなので増分 O(N) で済んだ。**移動フレームは窓が縮むため
そのままでは使えない。**

| 関数 | 方式 | 計算量 |
|---|---|---|
| `SUM` / `COUNT` / `AVG` | **累積和の差分**（prefix sum）。`[l, r]` の和 = `P[r] - P[l-1]` | O(N) |
| `MIN` / `MAX` | **単調両端キュー**（sliding window minimum/maximum） | 償却 O(N) |

- `SUM` の prefix sum は**浮動小数の桁落ち**が起きる（大きな値の後に小さな値を引く）。
  **Phase 1 の「厳密一致を要求しない」契約（B125 §3.4）を Phase 2a にも引き継ぐ**
- `MIN`/`MAX` の比較は既存の `compareCanonicalValues` を使う（比較器を二重実装しない）

> **代替案**: 各行でフレームを切って `evalAggregate` を呼ぶと O(N×W)。
> W が小さければ実用上問題ないが、`UNBOUNDED` を含む形で O(N²) になる。**採らない。**

---

## 4. Phase 2b `LAG` / `LEAD`

### 4.1 構文と意味論

```
LAG( 引数 [, offset [, default]] ) OVER ( [PARTITION BY ...] ORDER BY ... ) AS alias
```

- `offset` は**非負整数リテラル**（既定 1）。`0` は自身
- `default` は**スカラーリテラル**（既定は空＝`""`）。**式・列参照は非対象**
- `ORDER BY` 必須
- **フレーム句は取らない**（標準どおり）。書いたら ParseError

### 4.2 Phase 1 との違い

`LAG` / `LEAD` は**集計ではなく値の参照**なので、`aggregateRowValues` の
空値スキップ規則を通さない。**そのままの raw 値**（無ければ `default`）を返す。

> **要確認（§7-2）**: 出力の型メタ。`MIN`/`MAX` と同じく**引数の意味型を引き継ぐ**べき
> （B125 §4.1 で `WINDOW_COL` が一律 number だった問題を直した経緯があるため、
> 同じ穴を開けない）。

---

## 5. AST

```ts
// B125 の WindowFrame を拡張（純加法）
export type WindowFrameBound =
  | { kind: "UNBOUNDED_PRECEDING" }
  | { kind: "UNBOUNDED_FOLLOWING" }
  | { kind: "CURRENT_ROW" }
  | { kind: "PRECEDING"; offset: number }
  | { kind: "FOLLOWING"; offset: number };

export interface WindowFrame {
  unit: WindowFrameUnit;          // 既存
  source: "DEFAULT" | "EXPLICIT"; // 既存
  start: WindowFrameBound;        // 追加（Phase 1 は UNBOUNDED_PRECEDING 固定だった）
  end: WindowFrameBound;          // 追加（Phase 1 は CURRENT_ROW 固定だった）
}

// Phase 2b
export interface ValueWindowColumn extends SelectAliasDisplay {
  type: "WINDOW_COL";
  windowKind: "VALUE";
  valueFunc: "LAG" | "LEAD";
  arg: AggregateArgExpr;
  offset: number;
  defaultValue: string | null;
  partitionBy: FieldRef[];
  orderBy: OrderByItem[];
  alias: string;
}
```

**`WindowColumn` は 3 メンバーのユニオンになる**（`RANKING` / `AGGREGATE` / `VALUE`）。
B125 で入れた `isRankingWindow` と同じ形の判別ヘルパーを足す。

> **B125 の教訓**: 型を広げると**コンパイルが壊れる箇所**と**通るが処理が抜ける箇所**が
> 出る（B125 では (c) が 8 箇所あった）。**R2 で全列挙する**（§7-3）。

---

## 6. 受入条件

### 6.1 Phase 2a（実データ・APP4228）

| SQL | 期待 |
|---|---|
| `AVG(個数) OVER (ORDER BY 日付, レコード番号 ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)` | 先頭 6 行は**フレームが短い**（クリップ）ことを期待値で固定 |
| `SUM(x) OVER (... ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` | **Phase 1 と完全一致**（回帰） |
| `SUM(x) OVER (... ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)` | 3 行窓。両端でクリップ |
| `SUM(x) OVER (... ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)` | 後方累積 |
| `MIN(x) / MAX(x)` の移動窓 | 単調キューの結果が**素朴実装（各行でフレームを切って `evalAggregate`）と一致** |
| 空フレームになる指定 | §3.2 の値 |
| `ORDER BY` 無しで `ROWS` | **ParseError**（B125 §3.3 と同じ） |
| `RANGE BETWEEN 1 PRECEDING ...`（値指定） | **ParseError**（Phase 2a 非対象） |

**外部検算**: 移動平均は**素朴実装との突き合わせ**で固定する（O(N×W) の参照実装を
テスト内に置き、勝ち負けではなく一致を見る）。

### 6.2 Phase 2b

| SQL | 期待 |
|---|---|
| `LAG(出庫) OVER (PARTITION BY 製品名 ORDER BY 日付, レコード番号)` | 各パーティションの先頭は `default`（既定は空） |
| `LAG(出庫, 2, '0')` | 2 行前。先頭 2 行は `'0'` |
| `LEAD(...)` | 末尾側が `default` |
| `LAG(x, 0)` | 自身の値 |
| **文字列列の `LAG`** | **raw 値が返る**（型メタが number に潰れない・§4.2） |
| フレーム句を書く | ParseError |

### 6.3 回帰（必須）

1. **Phase 1 の全受入**（B125 §8）が不変。とくに既定 `RANGE` と `ROWS` の固定境界
2. 順位系 3 関数の値と並びが不変
3. **`evalAggregate` / `aggregateRowValues` の挙動が不変**（12 集計の回帰）
4. B127 の警告が**移動フレーム明示時には出ない**こと（`frame.source === "EXPLICIT"`）
5. FULL_SCAN 強制・完全入力・`SELECT DISTINCT` 併用・`GROUP BY` 併用拒否

---

## 7. 未確定（R2 までに詰める）

1. **空フレームの値**（§3.2）。標準 SQL は NULL、kSQL の空入力集計は `0`。**kSQL 側に揃える**方針でよいか
2. **`LAG` / `LEAD` の出力型メタ**（§4.2）。引数の意味型を引き継ぐ設計でよいか
3. **`WindowColumn` を 3 メンバーにしたときの影響箇所の全列挙**（B125 の (a)/(b)/(c) 分類と同じ形で）
4. **`WindowFrame` に `start` / `end` を足すのは純加法か**。Phase 1 の AST を読む既存箇所が
   固定境界を前提にしていないか
5. Phase 2a と 2b を**同一リリースに入れるか分けるか**（依頼元の優先は移動フレーム）
