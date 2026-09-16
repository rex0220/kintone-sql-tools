# B188 実装報告（codex・2026-09-16）

- 依頼: [ksql_b188_codex_impl_request.md](ksql_b188_codex_impl_request.md)（案 A・警告の伝播・純加法）
- 起票: [ksql_b188_temp_table_window_range_warning_not_surfaced_issue.md](ksql_b188_temp_table_window_range_warning_not_surfaced_issue.md)
- 作業ブランチ: `b188/dev`（v3.78.0 + 起票コミット 4cb06ab の上）
- 末尾に Claude のレビュー節（全体 warnings の範囲を絞った修正 1 点・実機確認）を追記

---

## 変更ファイル一覧

- `src/execute.ts:506`
- `src/output/batchEnvelope.ts:113`
- `src/cli/index.ts:1147`
- `src/__tests__/b188TempTableWarnings.test.ts:45`
- `docs/ksql_language_reference.md:4015`

## 修正箇所 ↔ 根拠行の対応表

| 修正箇所 | 根拠行 |
|---|---|
| `BatchStatementResult.warnings?: string[]` を任意追加 | `execute.ts:1656` |
| `CREATE TEMP TABLE` の実体化警告を文結果へ伝播。空ならプロパティ省略 | `execute.ts:2563` |
| SELECT-based DML の source 警告を公開 DML 型を変えず内部関連付け | `execute.ts:504`、`execute.ts:10401` |
| IMPORT projection の警告を外側 IMPORT 文へ転送 | `execute.ts:10135`、`execute.ts:10424` |
| バッチ全体の警告を文順・重複なしで集約 | `execute.ts:1883` |
| MCP／CLI JSON envelope の文別・全体警告 | `batchEnvelope.ts:131`、`batchEnvelope.ts:191` |
| CLI 文サマリへ既存警告文を表示 | `index.ts:1190` |

## 追加・変更したテストと結果

追加した6件:

- direct／CTE／CREATE TEMP の既定 RANGE 警告と、後段への非重複
- 警告なし CREATE TEMP の従来 shape 維持
- JOIN キー301件の全件取得警告
- INSERT SELECT source 警告
- UPSERT SELECT source 警告
- `warnings` が任意プロパティであること

`npm test`:

- 通過: 303 suites、6541 tests
  - 本体: 301 suites、6515 tests
  - subprocess: 2 suites、26 tests
- 失敗: 0 suites、0 tests
- snapshots: 23 passed
- `docs:check`: OK（リンク3945件／台帳17行）
- ビルド: 禁止事項に従い未実行

## 文書の差分

追記全文:

> `CREATE TEMP TABLE ... AS SELECT` の実行時警告（ウィンドウの既定フレームなど）は、その文の結果の `warnings` に載ります（v3.79.0〜）。後段で一時テーブルを参照する文には、この警告は重複して載りません。

## §4 の確認結果

1. `BatchExecuteResult.warnings`

   修正前は dialect 1 の server-time 警告だけを拾う経路でした（`execute.ts:1716`）。修正後は dialect 警告、各文の `warnings`、SELECT 結果の `warnings` を文順に集め、`Set` で重複除去します（`execute.ts:1883`）。

2. IMPORT／INSERT／UPSERT

   - INSERT SELECT、UPSERT SELECT は source の `SelectResult` から行・列・メタだけを取り、警告を捨てていました。現在は source 実体化時に警告を保存し、文の任意 `warnings` へ移します（`execute.ts:10401`、`execute.ts:2631`）。
   - IMPORT の生 source は CSV／JSON で、通常の SELECT 警告はありません。任意の SELECT projection が返す警告は以前捨てられていたため、外側 IMPORT 文へ転送するようにしました（`execute.ts:10135`、`execute.ts:10424`）。

3. 面ごとの到達

   - CLI: 文サマリに `warning=<既存警告文>` として到達。
   - MCP `ksql_query`: `statements[].warnings` と全体 `warnings` に到達。既存の SELECT 結果は引き続き `results[].warnings`。
   - `/flow`: `executeManagedStatement` が `statementOutcome` をそのまま返すため到達（`execute.ts:2036`、`execute.ts:2144`）。
   - プラグイン: `executeBatch` の内部結果までは到達。ただし現行 UI のサマリは `result` のない CREATE TEMP 文を除外するため表示されません（`desktop.ts:2066`）。依頼どおり新規表示面は追加していません。

4. 公開型

   必須プロパティの追加はありません。追加は `BatchStatementResult.warnings?: string[]` のみです。生成 `.d.ts` はビルド禁止のため変更していません。

## Claude が実機で確認すべき残項目

- SFA パックで CREATE TEMP 文の警告が期待する表示面に見えるか
- CLI の通常表示と JSON 表示
- MCP `ksql_query` の `statements[].warnings`／全体 `warnings`
- `/flow` の statement result
- プラグインは現行 UI で表示されないこと、および表示対応を別途行うかの判断

## 上限内に終わらなかった項目

- direct SELECT と CTE／CREATE TEMP の警告配列は、既存 B140-C の文脈別タイブレーク助言により末尾が逐語一致しません。CTE と CREATE TEMP は一致し、警告主文は3経路で同じです。既存警告文を変更しない制約を優先しました。
- IMPORT projection で実際にウィンドウ警告を生成する受入 fixture は、現行構文では作成できず未追加です。警告転送経路自体は実装済みです。
- git 操作、ビルド、MCP tool call、台帳・起票文書・version・CHANGELOG・README・release の変更は行っていません。

---

## Claude レビュー（2026-09-16）

### 1. 修正 1 点: バッチ全体 `warnings` の範囲を絞った

codex 版はバッチ全体の `warnings` に **SELECT 文の結果警告まで**集めていた（§4-1）。SELECT の警告は従来から `results[].warnings`（文ごと）に載っており、envelope の契約（バッチ仕様 §6.2「文ごとの警告は results[].warnings」・全体は dialect 1 の警告）を変えて二重に出すことになる。MCP を読む AI にとっては同じ警告文が 2 か所に出るノイズ。全体 `warnings` は **dialect 1 の警告 + 結果セットを持たない文（CREATE TEMP TABLE・SELECT-based DML）の実行時警告**だけに戻し、SELECT だけのバッチでは全体が従来どおり空（`undefined` / envelope は `[]`）であることをテストで固定した（`b188TempTableWarnings.test.ts` に 1 本追加・計 7 本）。

据え置いたもの:

- CLI のテキスト表示は、これまでバッチの SELECT 文の警告を**どこにも出していなかった**（JSON だけ）。codex は `CREATE TEMP TABLE` と同じ `warning=` を SELECT 文のサマリにも付けた。既存の穴が埋まる方向なので採用（サマリ行が長くなるのは許容）
- プラグイン UI は `result` の無い文をサマリから除外するため、一時テーブル文の警告は表示されない。表示対応は起票文書 §3 の「面ごとの表示」として残課題に記録（`prod/js/desktop.js` のビルドを伴うため別 PR）
- 3 経路の警告文の末尾差（B140-C の文脈別助言）は既存仕様

### 2. 実機（dev profile・SFA パック・`npm run build:cli` 後の CLI）

- `CREATE TEMP TABLE #t AS SELECT … SUM(売上) OVER (ORDER BY 売上) AS 累計 …; SELECT COUNT(*) FROM #t`
  - テキスト: `[1] CREATE_TEMP_TABLE success temp=#t rows=6 warning=累計 は既定フレーム（RANGE）で評価されます。…`（v3.78.0 では無し）
  - JSON: 全体 `warnings` 1 件・`statements[0].warnings` 1 件・`statements[1].warnings` なし・`results[0].warnings` は `[]`（後段へ重複しない）
- `npm test`（修正後の最終）: 本節末尾の数値を参照

### 3. 結果

- `npm test`: 301 suites / 6,516 tests passed、サブプロセス 2 suites / 26 passed、snapshots 23、`docs:check` 通過
