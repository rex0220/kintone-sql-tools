# B207 `COUNT(*)` の近道を、スカラーサブクエリと `CREATE TEMP TABLE` の元にも効かせる

- 状態: 🚧 **実装済み（2026-11-09）。v3.93.0 に同梱（PR #422。マージ・タグ・公開待ち）**
- 種別: 正しさ（**計画と実行の食い違い**）＋ 性能。**結果は変わらない**（件数は同じ・読む量が減る）
- 優先: 中（依頼元は「読む前に件数で止める」案内をこれが入るまで使えない）
- 版: minor（v3.93.0）。**規模 S**
- 上流の依頼（正）: `kintone-plugin/work-link/kSQLエンジンへの依頼-20261109-KJ11-COUNTの近道と読み取りの上限.md`（KJ-11 の ①）。
  **回答が設計の正本**＝同じ場所の `kSQLエンジンからの回答-20261109-KJ11-COUNTの近道と読み取りの上限.md`
- 関連: [B94](ksql_b94_count_star_totalcount_issue.md)（近道を入れた）、
  [B105](ksql_b105_union_count_totalcount_issue.md)（UNION の枝に広げた）、
  [B197](ksql_b197_temp_table_max_rows_not_enforced_on_output_issue.md)（同じ依頼の ②）

## 1. 現象

`COUNT(*)` の近道（`getRecords({ query: "… limit 1", totalCount: true })` の 1 回）が、

- `ASSERT` / `EXIT SUCCESS IF` / `SET` のスカラーサブクエリ
- `CREATE TEMP TABLE … AS SELECT COUNT(*) …` の元の SELECT

で使われず、**全件を読んで** `maxRecords` に当たっていた。
**実行計画（`explainScript`）はどちらも `COUNT_TOTAL_COUNT` と表示する**ので、計画と実行が食い違っていた。

依頼元は「読む前に件数を数えて、業務の言葉で止める」ために
`ASSERT (SELECT COUNT(*) FROM LAPP_受注) <= 10000, @m_too_many;` を試し、
計画が近道と出たので安いと判断したが、実行は `FetchAllLimitError` になった（アプリ 4411・10,445 件）。

## 2. 原因

| 側 | 判定 |
|---|---|
| 実行 | `executeFullScanSelect` の冒頭が **`countTotalCountRootSelects.has(stmt)`**（WeakSet）を見る。印を付けていたのは **`executeStatement` の `case "SELECT"`** と **`executeUnion` が枝を実行する 2 か所**だけ |
| 計画 | `buildSelectPlan` の `allowTotalCountPlan` は**既定 `true`**。CTE・サブクエリ・`INSERT … SELECT` は明示に `false` を渡すが、**ASSERT / EXIT のサブクエリと `CREATE TEMP TABLE` の元は文と同じ `buildExplainPlan` を通る**ので `false` が渡らない |

B94 は「迷ったら従来経路へ落とす」方針で入れ子を対象外にし、B105 が UNION の枝を足した。
**B105 の理由は「枝は終端＝下流が元レコードを必要としない」**で、
スカラーサブクエリ（値 1 つ）と `CREATE TEMP TABLE` の集計（1 行）**にも同じ理由が当てはまる**。

## 3. 直したこと

**`markCountTotalCountRoot` を 2 か所で通した**（適用の判定は 1 行も変えていない）。

| 場所 | 中身 |
|---|---|
| `evaluateScalarSubquery` | スカラーサブクエリを実行する**唯一の口**。`ASSERT` / `EXIT SUCCESS IF` / `SET` が通る |
| `executeBatchStatement` の `CREATE_TEMP_TABLE` | 元が素の `SELECT` のときだけ印を付ける（`UNION` の枝は `executeUnion` が付ける・`WITH` は対象外） |

判定は従来どおり `isCountStarTotalCountEligible` ＋ `EXACT_PUSHDOWN`
＝`COUNT(*)` だけ・`GROUP BY` / `HAVING` / `DISTINCT` / `JOIN` なし・`FROM` は物理アプリ・
`LIMIT` / `OFFSET` なし・`WHERE` が完全に押し下がる。1 つでも欠ければ従来どおり全件読む。

**計画の表示はそのままで、実行が計画に合う形になった**（食い違いの解消）。

## 4. 試験（`src/flow-library/__tests__/b207CountShortcutScope.test.ts` 10 件）

記録 12 件・`maxRecords: 10`＝近道が効かなければ必ず `FetchAllLimitError` になる形で固定した。

- `ASSERT` / `EXIT SUCCESS IF` / `SET` のスカラーサブクエリが **1 回の GET**（`limit 1` ＋ `totalCount`）
- `CREATE TEMP TABLE … AS SELECT COUNT(*)` も 1 回の GET（表には `n = 12` が入る）
- **依頼の形**（`ASSERT … <= 10` で止める）が `AssertError` で止まり、数えるために全件を読まない
- `WHERE` が押し下がる形も近道に入る
- 判定を外れる形は従来どおり全件（`GROUP BY` あり・`COUNT(列)`・一時テーブルを読む `COUNT(*)`）
- **計画（`COUNT_TOTAL_COUNT`）と実行が一致する**

**分かったこと**: `totalCount` を返さないクライアント（試験のモックなど）では近道が空振りして
全件取得へ落ちるので、**読取が 1 回増える**（`limit 1` の安い GET）。実機のクライアント 4 本は
B94 で `totalCount` を運ぶので 1 回で済む。`src/__tests__/executeBatch.test.ts` の
「SET スカラーサブクエリを 1 回だけ評価」はモックが `totalCount` を返さないため 2 回になる
（モックを賢くすると「絞り込む前の件数」を返して嘘の件数になるので、モックは正直なままにした）。

## 5. 検証

- `tsc` の新規エラー 0。`jest` の失敗は **v3.92.0 のベースラインと同数・同内容**（8 suites / 45 tests）。
- 近道の対象を広げただけで、**件数の値は変わらない**（`totalCount` は kintone が query を適用した件数）。
