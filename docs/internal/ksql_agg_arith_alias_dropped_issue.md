# 課題: 集計算術式の末尾オペランドが集計関数だと AS alias が静かに消える

- 作成日: 2026-07-11
- 更新履歴:
  - 2026-07-11 R1: 起票(v1.12.0 の 0 件集計対応 S1 のテスト作成中に発見。codex 実装後レビューでも起票推奨)
- ステータス: **未着手**(v1.12.0 のスコープ外・独立の既存バグ)
- 発見経緯: `docs/internal/ksql_ungrouped_aggregate_empty_result_spec.md` R3-②

## 事象

```sql
SELECT SUM(売上) - SUM(原価) AS diff FROM APP100
```

の `AS diff` が**エラーにも警告にもならず静かに無視され**、出力キーが合成名 `SUM(売上)-SUM(原価)` になる。

| 式 | alias | 理由 |
|---|---|---|
| `SUM(金額) * 1.1 AS x` | **効く** | 末尾オペランドが数値リテラル |
| `SUM(a) - SUM(b) AS x` | **消える** | 末尾オペランドが集計関数 |
| `SUM(a) / COUNT(*) AS x` | **消える** | 同上 |

## 原因(コード裏取り済み)

1. `parseAggPrimary`(`src/parser/parser.ts:762-788`)が集計算術式の右オペランドを `parseAggregateColumn` で読む
2. `parseAggregateColumn`(`:1130-1147`)は列パーサの流用のため、`)` の後に **`AS alias` まで消費**する(`:1144`)
3. 呼び出し側 `:785` は `func` / `distinct` / `arg` のみ使って `AggregateRef` に変換し、**consume 済みの alias を捨てる**
4. その後の `ARITH_AGG_COL` 生成(`:661`)で `consume(AS)` しても、AS は既に消費済みのため null

## 修正方針(案)

`parseAggPrimary` の集計関数分岐で `parseAggregateColumn` を使わず、alias を消費しない専用の読み取り(関数名 + `(` + [DISTINCT] + 引数 + `)`)に置き換える — もしくは `parseAggregateColumn` に「alias を読まない」モード引数を追加する。パース済み alias を`ARITH_AGG_COL` に持ち上げる案は、`SUM(a) AS x - SUM(b)` のような中間位置 alias を受理してしまうため不可。

## 影響・優先度

- 実害は「出力キーが意図した alias にならない」表示・参照名の問題(値は正しい)。HAVING / ORDER BY は合成名キーで解決されるため動作には影響しない
- 静かな無視は仕様違反的挙動(受理した構文の一部を捨てる)だが、発生条件が限定的で回避も容易(`FORMAT(SUM(a) - SUM(b), '#') AS x` や後段での列名参照)のため優先度は低〜中
