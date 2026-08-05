# B125 集計のウィンドウ関数（`SUM(x) OVER (...)`）— 累計・移動集計

- 起票: 2026-08-05
- ステータス: 🚧 **実装済み・リリース待ち**（2026-08-05・**実機で外部検算済み**）→ [仕様 R2](ksql_b125_aggregate_window_phase1_spec.md) / [レビュー](ksql_b125_codex_review_1.md) / [実装報告](ksql_b123_b125_codex_impl_report.md)。**外部検算＝APP4228 の 8 製品の最小在庫が `ksql-analytics` の独立実装（40 行スクリプト）と完全一致**（26/34/37/74/21/29/61/42・件数合計 1,000）。同日 3 件で `RANGE`=444/444/444（末尾値）・`ROWS`=530/496/444 を実機確認。
  **着手条件だったフレーム既定値はオーナー判断で確定（2026-08-05）＝標準どおり `RANGE`**。
  可視化（`EXPLAIN` に実効フレームを出す）と `ROWS` 明示を Phase 1 にセットで入れることで、
  同順の取り違えを緩和する。**ウィンドウ機構は既にあり、拡張は素直**（`applyWindow` の
  パーティション分割・ソート・**同順検出**がそのまま使える）。実需は確認済み（在庫の累積推移）
- 出典: `ksql-analytics` の在庫分析 v2。累積在庫を出すのに窓関数が必要になり、
  **SQL を諦めて CSV + ローカル 40 行のスクリプト**で計算した（2026-08-05）
- 関連: [ウィンドウ関数仕様](ksql_window_function_spec.md)（**§3 で「非対象（v2）」、§8 で後続と明記済み**）/
  [B65 Phase2](ksql_b65_phase2_evaluation.md)（「累計 `SUM() OVER()` は B65 でなく window 側の別テーマ」）/
  [B124](ksql_b124_aggregate_arithmetic_nonaggregate_operand_issue.md)（集計算術式）

## 1. 症状（実測 2026-08-05・v3.44.0・MCP `ksql_validate`）

```
> SELECT 製品名, SUM(仕入価格) OVER (ORDER BY 製品名) AS 累計 FROM APP4229
ParseError: 文の区切りには ; が必要です（位置 22、トークン: 「OVER」）
```

**診断が不親切**です。集計関数のあとに `OVER` が来ることをパーサが想定していないため、
「文が終わった」と解釈して区切り記号を要求しています。**「集計のウィンドウ関数は未対応」とは伝わりません。**

現在の対応関数は `ROW_NUMBER` / `RANK` / `DENSE_RANK` の 3 つ（順位付けのみ）。

### 出典での回避（実際にやったこと）

```powershell
# 1,000 行を CSV へ
node scripts/q.mjs -f sql/inventory_v2_04_ledger.sql --format csv --output data/ledger.csv --max-records 100000
# 累積して製品別 8 行の要約に畳む
node scripts/inv_v2_runstock.mjs data/ledger.csv
```

**回避策は機能した**（ファイル経由なのでコンテキストも汚さない）。ただし**利用者ごとに
スクリプトを書くことになる**ため、累計は SQL 側で解けるほうが望ましい。

## 2. 実現可能性: 機構は既にある

`applyWindow` は「パーティション分割 → ソート → 順に走査」で、**集計ウィンドウに必要な骨格が揃っています**。

```ts
// src/engine/process.ts — 現在の実装（抜粋）
for (const partition of partitions.values()) {
  const sortedResult = sortDecoratedRows(partition, window.orderBy, optionOrders, sortKinds, fieldSemantics);
  const sorted = sortedResult.rows;
  for (let index = 0; index < sorted.length; index++) {
    if (index > 0 && sortedResult.compare(sorted[index - 1], sorted[index]) !== 0) {
      rank = index + 1; denseRank++;          // ← 同順（peer）の境界検出が既にある
    }
    ...
  }
}
```

**`sortedResult.compare` による同順境界の検出が既にあります。** これは標準 SQL の
`RANGE` フレーム（同順の行は同じ値になる）にそのまま必要なものです。`RANK` を正しく実装するために
作った仕組みが、累計にもそのまま効きます。

要るのは、パーティションごとの**アキュムレータ**と、既存のループへの値の書き込みだけです。
FULL_SCAN 強制・比較器共有・ソートメタのゲートは**ウィンドウ関数の設計としてすでに確立済み**
（仕様 §0.3 / §2.3 / §5.1）で、新たに決めることはありません。

## 3. 最大の論点: フレームの既定値と同順の扱い

**ここを誤ると「静かに間違う」帯域に入ります。** 標準 SQL の既定フレームは、
`ORDER BY` があるとき `RANGE UNBOUNDED PRECEDING AND CURRENT ROW` です。
つまり**同順の行はすべて同じ値**になります。

出典の在庫台帳がまさにこの形でした。

同日 3 件（前日までの残高 60）の例。

| 日付 | 増減 | `RANGE` 既定（標準） | `ROWS`（行ごと） |
|---|---:|---:|---:|
| 2026-03-18 | +100 | **110** | 160 |
| 2026-03-18 | −30 | **110** | 130 |
| 2026-03-18 | −20 | **110** | 110 |

> **【訂正 2026-08-05】この表は 2 回間違えた。** 起票時は `RANGE` を 130、仕様 R2 初版では 80 とした。
> **正しくは 110**＝`ROWS` の最終値であり、同順グループの**末尾**の値。実装レビュー（codex）で検出。
> **「`RANGE` は日次残高」という説明はこの数値でこそ正しい。**

**同日取引がある台帳で `RANGE` 既定は「その日の終わりの残高」を返します。**
一方、出典が欲しかったのは**取引ごとの残高**（最小在庫を出すため）で、これは `ROWS` です。
出典では `レコード番号` をタイブレークキーに足して全順序を作ることで回避していました。

**どちらも正しい答えで、どちらが欲しいかは問いによって違います。**
既定だけ実装して `ROWS` を出さないと、**利用者は行ごとの累計を書いたつもりで
日次残高を受け取り、エラーも出ません。**

## 4. 対応案

### 案 A（推奨）: Phase 1 = 5 関数 ＋ 既定フレーム ＋ `ROWS` の全開区間

| 区分 | 内容 |
|---|---|
| **対象関数** | `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` の `OVER` |
| **対象フレーム** | 既定（`ORDER BY` あり = `RANGE UNBOUNDED PRECEDING AND CURRENT ROW` / `ORDER BY` なし = パーティション全体）＋ **明示の `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`** |
| **非対象** | 移動フレーム（`ROWS BETWEEN n PRECEDING`）・`RANGE` の値指定・`LAG` / `LEAD` / `NTILE` / `FIRST_VALUE` |
| **非対象（v1 踏襲）** | `GROUP BY` / 集計関数との併用・`SELECT DISTINCT` 併用・`KORDER BY` 併用 |

`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` を Phase 1 に入れる理由は §3 です。
実装としては**同順境界の判定を外して 1 行ずつ加算するだけ**で、既定側より簡単です。
**移動フレームだけが本当に高い**ので、そこを切れば Phase 1 は小さく収まります。

- `MIN` / `MAX` の比較規則は既存の集計関数の規則（数値順 / コードポイント順 / 選択肢定義順）に従う
- 空セル・NULL の扱いは既存の集計関数の規約をそのまま使う（`SUM` は空をスキップ等）
- ウィンドウ列は FULL_SCAN 強制（既存と同じ）。API コストは増えない

### 案 B: 診断だけ直す（案 A を採らない場合の最低限）

`SELECT ... SUM(x) OVER` を「文の区切りが無い」ではなく
**「集計のウィンドウ関数は未対応です。対応は `ROW_NUMBER` / `RANK` / `DENSE_RANK` です」**と返す。
現状の診断は**未対応であることすら伝えていない**ので、案 A を採らないとしてもこれは要る。

**見立て**: **案 A の Phase 1 を推す。** 機構が既にあり、実需（累計）が確認でき、
新しい設計判断はフレーム既定値の 1 点だけ。ただし**§3 の同順の扱いを受入条件で固定しない限り着手しない**。

## 5. 受入条件（案 A）

APP4228（1,000 件・同日取引あり）で検証する。**同日取引がある製品を必ず含めること**（§3）。

| SQL | 期待 |
|---|---|
| `SUM(個数_在庫計算用) OVER (PARTITION BY 製品名 ORDER BY 日付)` | 同日取引は**同じ値**（`RANGE` 既定） |
| `SUM(個数_在庫計算用) OVER (PARTITION BY 製品名 ORDER BY 日付, レコード番号)` | 全順序なので**行ごとに増える** |
| `... ORDER BY 日付 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | 同日でも**行ごとに増える** |
| `SUM(個数_在庫計算用) OVER (PARTITION BY 製品名)`（`ORDER BY` なし） | 全行が**パーティション合計**（＝ `SUM` の総計） |
| `COUNT(*) OVER (PARTITION BY 製品名)` | 製品ごとの取引件数が全行に載る |
| `AVG` / `MIN` / `MAX` の同形 | 既存の集計関数と同じ空値・比較規則 |

**外部検算（必須）**: 最終行の累計 = `SELECT SUM(個数_在庫計算用) ... GROUP BY 製品名` と一致すること。
出典のローカルスクリプト（`inv_v2_runstock.mjs`）の出力（8 製品の最小・平均・最大・最終）とも突き合わせる。
**これは既に手元にある実測値なので、そのまま受入データに使える。**

**回帰**:

1. `ROW_NUMBER` / `RANK` / `DENSE_RANK` の既存の値・並びが**1 つも変わらない**こと
   （同じ `applyWindow` のループを触るため）
2. FULL_SCAN 強制が維持されること（ウィンドウ列があるのに押し下げられていないこと）
3. `SELECT DISTINCT` / `KORDER BY` / `GROUP BY` との併用が**従来どおり拒否**されること
4. ソートメタのゲート（数値が辞書順にならない）— 仕様 §2.3 の受入をそのまま再実行

## 6. スコープ外

- 移動フレーム（`ROWS BETWEEN 2 PRECEDING AND CURRENT ROW`）＝移動平均。Phase 2
- `RANGE` の値指定（`RANGE BETWEEN INTERVAL ...`）
- `LAG` / `LEAD`（前月比）・`NTILE` / `FIRST_VALUE` / `LAST_VALUE`
- `GROUP BY` との併用（ウィンドウ関数 v1 からの継続制限）
- `QUALIFY`（ウィンドウ結果での絞り込み専用句）
