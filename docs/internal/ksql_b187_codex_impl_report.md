# B187 実装報告（codex・2026-09-16）

- 依頼: [ksql_b187_codex_impl_request.md](ksql_b187_codex_impl_request.md)（案 A・HAVING 専用の集計を実体化経路で評価）
- 起票: [ksql_b187_having_aggregate_not_in_select_silent_empty_issue.md](ksql_b187_having_aggregate_not_in_select_silent_empty_issue.md)
- 作業ブランチ: `b187/dev`（v3.79.0 の HEAD）
- 末尾に Claude のレビュー節（実機確認・既存テストの契約変更の扱い）を追記

---

## 変更ファイル一覧

- `src/engine/process.ts:451`
- `src/engine/__tests__/b187HavingOnlyAggregate.test.ts:74`（新規）
- `src/__tests__/b164VariableAggregateComparison.test.ts:146`
- `src/__tests__/b65AggregateInteraction.test.ts:142`
- `src/__tests__/execute.test.ts:1999`
- `src/cli/__tests__/b189_single_select_warnings.e2e.test.ts:132`
- `docs/ksql_language_reference.md:1931`

## 修正箇所 ↔ 根拠行の対応表

| 修正箇所 | 根拠 |
|---|---|
| `applyGroupBy` に任意の `having` を追加 | `src/engine/process.ts:451` |
| SELECT 集計の実体化直後に HAVING 集計依存を実体化 | `src/engine/process.ts:511` |
| `applyGroupingSets` にも同じ処理を追加 | `src/engine/process.ts:534`、`src/engine/process.ts:607` |
| `runFullScan` から通常 GROUP BY／GROUPING SETS の両方へ `stmt.having` を渡す | `src/engine/process.ts:2365`、`src/engine/process.ts:2380` |
| B164 の非掲出集計・サブクエリ警告を新契約へ更新 | `src/__tests__/b164VariableAggregateComparison.test.ts:146` |
| B65 ROLLUP の非掲出統計集約を新契約へ更新 | `src/__tests__/b65AggregateInteraction.test.ts:142` |
| B56 統計集約の旧期待値を新契約へ更新 | `src/__tests__/execute.test.ts:1999` |
| CLI の旧未解決警告期待値を新契約へ更新 | `src/cli/__tests__/b189_single_select_warnings.e2e.test.ts:132` |

## 追加・変更したテストと結果

新規 B187 テストは以下を網羅しました。

- 桁違い境界 `9 / 10`、`99 / 100`、`9,050,000 / 20,700,000` の `>`／`<`
- 複数集計、集計算術、CASE 引数、文字列関数で包んだ集計
- 0 行入力
- LEFT JOIN 不一致側
- CTE、一時テーブル、ROLLUP
- 警告消滅、出力列・行キー非漏出
- records GET 回数・取得列不変
- EXPLAIN の `reason:`・`fields:` 不変
- 文書掲載例

LEFT JOIN 不一致側の `SUM` は現行実装では `''` ではなく `"0"` でした。SELECT 掲出形の `"0"` と HAVING 専用形が同じ判定になることを固定しています。

`npm test` 最終結果:

- 通常群: **6574 passed / 0 failed**
- 直列 E2E: **26 passed / 0 failed**
- 合計: **6600 passed / 0 failed**
- Test Suites: **307 passed / 0 failed**
- Snapshots: **27 passed / 0 failed**
- `docs:check`: **ok（リンク 3963 件 / 台帳 14 行）**

## 文書の差分

書き換えた契約文全文:

> HAVING に直接書いた集計は、SELECT 列に無くても評価されます（v3.80.0 以降。以前は SELECT に同じ集計がある場合に限り評価され、無いと 0 行 + 警告になりました）。HAVING の集計は出力列にはなりません。v3.16.0 以降の `CASE` 式引数も同じ規則で直接記述でき、SELECT で付けた alias から参照する書き方も有効です。

掲載・実行確認した例全文:

```sql
SELECT 商談フェーズ, COUNT(*) AS 件数
FROM APP100
GROUP BY 商談フェーズ
HAVING SUM(売上) > 1000000
```

§22 に該当する旧制限事項はありませんでした。

## §4 の確認結果

1. `applyGroupBy`／`applyGroupingSets` 以外の実体化経路  
   SELECT の `ARITH_AGG_COL`、集計を含む `ARITH_COL`／`STRFUNC_COL`／`SCALAR_VALUE_COL`／`CASE_COL` は、すべて既存の `materializeAggregateColumns` → `materializeAggregateDependencies` を使用します。HAVING はその直後に同じ helper で実体化します。DISTINCT・window・projection は HAVING より後段です。CTE・一時テーブル・`/flow` の `executeStatement` も最終的に共通の `runFullScan` を通ります。

2. 修正後も `warnOnUnresolvedAggregateComparisons` が警告を出す形  
   対応済みの構文範囲では確認されませんでした。関数自体は防御処理として残しています。0 行入力では評価対象グループがなく、警告もありません。

3. GROUP BY なし・SELECT 無集計・HAVING だけ集計  
   現行 parser は GROUP BY のない HAVING を `文の区切りには ; が必要です` で拒否します。SELECT に別集計がある場合も同じです。修正後も変更していません。

4. EXPLAIN と取得列  
   B187 テストで非掲出形と掲出形の `reason:`／`fields:` が一致することを確認しました。`reason:` は `GROUP BY あり, 集計関数（COUNT / SUM 等）あり` のままです。records GET は両形とも 1 回で、`fields` も一致します。取得列収集は既存の HAVING phase（`collectRequiredFieldsByTable`）を変更していません。

5. MCP・CLI・プラグイン・`/flow`  
   CLI、MCP、プラグインは共通の `execute`／`executeBatch`、`/flow` は `executeManagedStatement` から共通の `runFullScan` を使用するため、集計評価は同一です。CLI は B187 相当 SQL の E2E も通過しました。禁止事項に従い MCP tool call とプラグイン実機操作は行っていません。

## Claude が実機で確かめるべき残項目

- SFA パックで起票 SQLが期待どおり3行になり、`warnings` が空であること
- v3.79.0 との比較で、出力列が `商談フェーズ, n` のみで行キーも不変なこと
- MCP・プラグイン・CLI・`/flow` の実配布物で同じ結果になること
- 実データの LEFT JOIN 不一致側で `SUM` が `"0"` になる現行規約の確認

## 上限内に終わらなかった項目

なし。


---

## Claude レビュー（2026-09-16）

### 1. 判定

codex 版をそのまま採用（修正なし）。差分はエンジン側 `src/engine/process.ts` の 22 行（`applyGroupBy` / `applyGroupingSets` に任意引数 `having` を足し、SELECT 集計の実体化直後に `materializeAggregateDependencies(outRow, groupRows, having, …)` を呼ぶ・`runFullScan` の 2 呼び出しに `stmt.having` を渡す）だけ。B182 で一般化した実体化 helper の再利用で、SELECT に同じ集計がある既存形は `getMaterializedLookupValue` の early continue で何も変わらない。

### 2. 既存テストの契約変更 4 件（意図どおり・§9 の契約を変えたため）

B164（HAVING 非掲出 = 0 行 + 警告）・B65-A04（ROLLUP の未選択集計は追加計算しない）・B56（HAVING 直接統計集約は追加計算しない）・B189（HAVING 未掲載集計の警告が stderr に出る）は、いずれも**旧契約「SELECT に無い集計は HAVING で評価しない」を固定していたテスト**。B187 はその契約自体を「評価する」に変えるので、期待値の書き換えは意味の変更を伴うが、それが本件の目的。§9 の契約文も同時に書き換えた（v3.80.0〜）。

### 3. 実機（dev profile・SFA パック・`npm run build:cli` 後の CLI）

| SQL | v3.79.0 | 修正後 |
| :--- | :--- | :--- |
| `SELECT 商談フェーズ, COUNT(*) AS n … GROUP BY 商談フェーズ HAVING SUM(売上) > 1000000` | 0 行 + 警告 | **3 行**（提案中 6 / 内示 2 / 受注 8）・`warnings: []`・列は `商談フェーズ, n` のみ |
| 同 `HAVING SUM(売上) < 20000000` | 0 行 | 2 行（内示 2・空フェーズ 4） |
| `GROUP BY ROLLUP(商談フェーズ) HAVING SUM(売上) > 20000000` | 0 行 + 警告 | 3 行（提案中 6・受注 8・総計 20） |
| SELECT に `SUM(売上) AS s` を足した形 | 3 行 | 3 行（不変） |
| EXPLAIN の `reason:` / `fields:` | `GROUP BY あり, 集計関数（COUNT / SUM 等）あり` / `商談フェーズ, 売上` | 同じ（不変） |

### 4. 据え置き・注記

- GROUP BY も SELECT 集計も無い `HAVING` はパーサが拒否（`文の区切りには ; が必要です`）。従来どおり
- `UNRESOLVED_AGGREGATE_COMPARISON_WARNING` の生成関数は防御として残す（対応済み構文では出る形が無い）
- 結果が変わる修正（0 行 → 行が返る）なので、リリースは **minor（v3.80.0）** で CHANGELOG に「影響する形＝SELECT に無い集計を HAVING に直接書いた文」と「元から正しく変わらない形＝SELECT に同じ集計がある文・別名参照」を分けて書く

### 5. 結果

- `npm test`（Claude 実行・最終）: 305 suites / 6,574 tests passed、サブプロセス 2 suites / 26 passed、snapshots 27、`docs:check` 通過
