# B186 実装報告（codex・2026-09-16）

- 依頼: [ksql_b186_codex_impl_request.md](ksql_b186_codex_impl_request.md)（案 A・EXPLAIN の解決規則を実行時に揃える）
- 起票: [ksql_b186_explain_mixed_join_unqualified_cte_column_issue.md](ksql_b186_explain_mixed_join_unqualified_cte_column_issue.md)
- 作業ブランチ: `b188/dev`（B188 コミット d58fc65 の上）
- 末尾に Claude のレビュー節（実機確認・据え置いた `fields:` 行）を追記

---

## 変更ファイル一覧

- `src/execute.ts:3605`
- `src/__tests__/b186ExplainMixedJoinCteColumn.test.ts:1`
- `src/__tests__/b181AliasReference.test.ts:223`
- `docs/ksql_language_reference.md:2566`

## 修正箇所 ↔ 根拠行の対応表

| 修正箇所 | 根拠 |
|---|---|
| 多表 JOIN の未修飾 CTE 列について、列の実在を `resolveMaterializedColumn` で確認し、`columnMeta` がなければ `syntheticSemantics("string")` を使用 | `src/execute.ts:3605` |
| EXPLAIN の WHERE 意味型解決へ、事前復元済みの `explainRelations` を渡す | `src/execute.ts:12615` |
| B181 の「混在 JOIN の WHERE は EXPLAIN できない」という制限コメントを削除し、未修飾 WHERE を復帰 | `src/__tests__/b181AliasReference.test.ts:223` |
| v3.79.0 以降の EXPLAIN 解決規則を言語リファレンスへ追記 | `docs/ksql_language_reference.md:2566` |

## 追加・変更したテストと結果

追加した B186 テスト:

- 集計 CTE × 物理 JOINの未修飾 WHERE と修飾済み WHEREの `[main]` 計画一致
- 非集計 CTEでも同じ計画一致
- 物理列と CTE 列の同名ケースで EXPLAIN が成功し、物理 `Amount` が `fields:` に載ること
- 不存在列が引き続き `WHERE_FIELD_UNRESOLVED` になること
- 同じ SQLについて EXPLAIN が成功し、実行でも期待行が返ること

変更した B181 テスト:

- 混在 JOIN の EXPLAIN SQLへ `WHERE amount > 9` を復帰

検証結果:

- 対象テスト: 23 passed / 0 failed
- `npm run docs:check`: 成功
- `npm test`:
  - 通常スイート: 6,521 passed / 0 failed
  - サブプロセススイート: 26 passed / 0 failed
  - 合計: 6,547 passed / 0 failed
  - Test Suites: 304 passed / 0 failed
  - Snapshots: 23 passed / 0 failed

ビルドは指示どおり実行していません。

## 文書の差分

追記全文:

> 実体化 CTE／一時テーブルの列を未修飾で `WHERE` に使った場合も、`EXPLAIN` は実行と同じ解決規則で計画を出します（v3.79.0〜。以前は `WHERE_FIELD_UNRESOLVED` になりました）。

## §4 の確認結果

1. §1.2 の原因確認

   当たりは核心部分で正しいです。ただし、追加原因として、EXPLAIN の事前処理で `explainRelations` を構築していたにもかかわらず、`normalizeSelectChoiceEquality` へ渡していませんでした。`src/execute.ts:12615`

   このため、多表分岐では実体化列の存在も確認できず、`columnMeta` 不在時のフォールバックもなく、0件一致から `WHERE_FIELD_UNRESOLVED` になっていました。両方を修正しています。

2. `fields:` 行の扱い

   今回は変更していません。非 source-aware の `collectRequiredFieldsByTable` が未修飾列を最初の物理表へ割り当てるため、CTE の `amount` / `custno` が物理 APP の `fields:` に残ります。

   ここを source-aware 化すると、今回新たに通る SQLだけでなく、既に成功している `B181: EXPLAIN は実行と同じ実体化 alias を解決する` の計画行も変わります。「既存 EXPLAIN 行を変えない」という制約に従い停止しました。該当する Jest snapshot は確認されませんでしたが、既存 B181 回帰テストの出力が影響対象です。全 snapshot 23件は無変更で通過しています。

3. `resolveMaterializedColumnMeta` の呼び出し元

   - `buildWhereFieldSemanticsResolver`
     - 修飾あり／単表: `columnMeta` 不在時も既存フォールバックあり
     - 多表未修飾: 今回、列実在確認＋フォールバックを追加
   - 集計意味型解決: 多表分岐に既存の列実在確認＋フォールバックあり
   - SELECT 出力列メタ推定、再帰 CTE、実行時 JOIN fetch: 実行時の実体化表を対象
   - ⚠ EXPLAIN JOIN-key prefilter `src/execute.ts:12652`: `explainRelations` に `columnMeta` がない場合は undefined。既存どおり runtime candidate／fallbackへ退避
   - ⚠ EXPLAIN の ORDER意味型 `src/execute.ts:12707`: `explainRelations` を渡していないため CTE列メタは undefinedになり得る。ただし未実体化 source では canonical order planを確定しない既存設計で、今回の WHERE失敗原因ではありません

4. CLI／MCP／プラグインで同じ結果になる根拠

   - CLI `--dry-run` は `execute("EXPLAIN ...")` を呼びます: `src/cli/index.ts:2782`
   - MCP `ksql_explain` も `executeSql("EXPLAIN ...")` を呼びます: `src/mcp/tools.ts:738`
   - プラグインの EXPLAIN ボタンは SQLへ `EXPLAIN` を付け、共通 `execute` へ渡します: `src/ui/desktop.ts:563`、`src/ui/desktop.ts:2321`
   - 最終的にいずれも `src/execute.ts` の同じ `executeExplain`／`buildExplainWhereAnalysis` を通るため、今回の修正が共通適用されます。

   MCP tool callは禁止に従い実行しておらず、上記はコード経路と全テスト通過による根拠です。

## Claude が実機で確かめるべき残項目

- SFA パックの実データで、§1.1 SQLの実行結果と EXPLAIN 成功を確認
- CLI再ビルド版の `--dry-run` で、修飾あり／なしの `[main]` 行一致を確認
- MCP v3.78.0 の失敗結果と、修正版 `ksql_explain` の成功結果を比較
- プラグイン同梱エンジンをビルド後、EXPLAIN画面で同じ計画が出ることを確認
- `fields:` に残る CTE列誤表示を、既存計画行の変更を許容する別対応として扱うか判断

## 上限内に終わらなかった項目

- `fields:` 行から未修飾 CTE列を除外する修正は、既存の成功済み EXPLAIN 計画行を変更するため未実装です。
- 実機、MCP、CLI再ビルド版、プラグイン同梱エンジンでの確認は、禁止事項に従い未実施です。


---

## Claude レビュー（2026-09-16）

### 1. 判定

codex 版をそのまま採用（修正なし）。原因は §1.2 の当たり（多表分岐の `columnMeta` 不在フォールバック欠落）に加えて、EXPLAIN が `normalizeSelectChoiceEquality` へ `explainRelations` を渡していなかった 2 点で、両方を直している。差分は `src/execute.ts` の 2 か所（+10 / -2）だけで、実行経路には触れていない。

### 2. 実機（dev profile・SFA パック・`npm run build:cli` 後の CLI）

- 起票文書 §1 の SQL（集計 CTE × 顧客管理 INNER JOIN・未修飾 `WHERE amount > 10000000`）: `--dry-run` が成功。WHERE を `s.amount` に修飾した形の EXPLAIN 出力と `diff` で**完全一致**。実行は 3 行（サイボウズ商事 20,700,000 ほか）
- v3.78.0 の MCP `ksql_explain` は同じ SQL で `WHERE_FIELD_UNRESOLVED`（起票時の実測）→ 非対称が解消

### 3. 据え置いたもの（B185 で扱う）

- EXPLAIN の `[main]` の `fields:` 行に未修飾の CTE 列（`amount`・`custno`）が物理 FROM（APP4148）の取得列として並ぶ表示は、修正前から同じで今回も変えていない（非 source-aware の `collectRequiredFieldsByTable` が未修飾名を最初の物理表に足すため）。実行時の取得列はこれと違い、CTE 列を物理へ要求しない。直すと既存の EXPLAIN 計画行が変わるので、B185（SELECT 列の存在検査＝同じ `fields:` の根拠を触る）の実装時に一緒に判断する
- 同じ行の `JOIN: APP0 (0)`（CTE の JOIN 先ラベル）も既存表示

### 4. 結果

- `npm test`（Claude 実行・最終）: 302 suites / 6,521 tests passed、サブプロセス 2 suites / 26 passed、snapshots 23、`docs:check` 通過
