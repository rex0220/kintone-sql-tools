# B143 `EXPLAIN` が `warnings` を返さない

- 状態: 📝 **起票のみ。v3.54.4 で文書化は済み、実装は未着手**（2026-08-06）
- 種別: 改善
- 優先: 低（依頼元の申告どおり。見落としても実害は 1 往復ぶん）
- 出典: [ksql-analytics の返信 §6.1](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-20260806-v3543.md)

## 1. 実測（v3.54.3・APP4228）

| | `ksql_explain` | `ksql_query` |
|---|---|---|
| CTE 上の `LAG` | `window 前月: LAG(offset=1) OVER (ORDER BY 年月 ASC)`・**`warnings: []`** | **全順序の警告が出る** |
| 既定フレームのウィンドウ | `frame: RANGE ...（既定）`・**`warnings: []`** | **B127 の警告が出る** |

**計画の行としては現れているのに、`warnings` は空**。

## 2. なぜ効くか

**依頼元の運用は「実行前に `ksql_explain` まで通す」**なので、
**「explain を通したから警告は無い」と読み違える。**

**素の状態で回した別セッションが「詰まった点」の 1 番目に挙げたのがこれ**だった
（explain は空だったのに、実行したら警告が出た）。

**警告疲れ（B140）とは逆向きの問題**＝警告が出ないことで、出るはずのものを見落とす。

## 3. 実装の見通し

**書いた SQL だけで決まる警告なので、計画段階で判定できるはず。**

- 生成器は `collectDefaultRangeWindowWarnings(stmt, resolveField, context)`
  （`src/execute.ts`）で、**B127（既定 RANGE）と B128（VALUE）の両方を出す**
- 必要なのは `stmt` と **フィールド意味論の resolver** と `context`
- **`EXPLAIN` は既にフォーム定義を読んでいる**（`metadata API: form definition ...`）ので、
  resolver を組み立てられる可能性は高い
- ただし **`EXPLAIN` は実行とは別経路**で、resolver がその経路で用意されているかは未確認

**着手前に確認すること**＝EXPLAIN 経路に `WhereFieldSemanticsResolver` 相当があるか。
無ければ `normalizeSelectChoiceEquality` 相当の呼び出しが要り、**metadata の追加取得**が
発生しないかを見る（`EXPLAIN` は「レコード API を呼ばない」契約なので、metadata だけなら問題ない）。

## 4. 案

- **案 A＝`EXPLAIN` でも `warnings` を返す**。依頼元の要望そのもの。
  **同じ警告文が計画と実行で一致する**利点もある
- **案 B＝文書化のみ**（v3.54.4 で実施済み）。
  「`EXPLAIN` は `warnings` を返しません。実行時の警告は実行しないと出ません」を
  [`EXPLAIN` の制約](../ksql_language_reference.md)へ追記した
- 案 C＝何もしない

**見立て＝案 B は入れた。案 A は実需が低いので、EXPLAIN 経路に resolver が既にあれば安い、
無ければ見送り。** 着手判断は §3 の確認から。

## 5. 関連

- 警告そのものの内容は [B140](ksql_b140_cte_groupby_total_order_issue.md)（全順序）と
  B127（既定フレーム）
- **B140 案 A が入れば、CTE 経路の全順序警告は出なくなる**ので、
  本件で `EXPLAIN` に出す価値も下がる。**順序としては B140 案 A が先**
