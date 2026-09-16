# B189 実装報告（codex・2026-09-16）

- 依頼: [ksql_b189_codex_impl_request.md](ksql_b189_codex_impl_request.md)（案 A・stderr へ `warning=`・stdout 不変）
- 起票: [ksql_b189_cli_single_statement_warnings_not_shown_issue.md](ksql_b189_cli_single_statement_warnings_not_shown_issue.md)
- 作業ブランチ: `b188/dev`（B188・B186・B185 コミットの上）
- 末尾に Claude のレビュー節（実機確認）を追記

---

## 変更ファイル一覧

- `src/cli/index.ts:1204`
- `src/cli/__tests__/b189_single_select_warnings.e2e.test.ts:1`
- `src/cli/__tests__/__snapshots__/b189_single_select_warnings.e2e.test.ts.snap:1`
- `docs/ksql_cli_tutorial.md:263`

## 修正箇所 ↔ 根拠行の対応表

| 修正箇所 | 根拠 |
|---|---|
| 単文 SELECT の非 JSON 警告を `warning=<警告文>` で stderr へ1行ずつ出力 | `src/cli/index.ts:1204` |
| バッチの既存 `warning=` 形式を踏襲 | `src/cli/index.ts:1190` |
| `json` と `--quiet` は追加出力しない | `src/cli/index.ts:1209` |
| stdout／`--output` 書き込み後に警告を stderr へ分離 | `src/cli/index.ts:2847` |
| `--export-csv` より前に同じ警告処理を通す | `src/cli/index.ts:2854` |
| エンジン・JSON生成・バッチ表示は変更なし | `src/execute.ts` 以下、`buildOutput`、`writeBatchOutput` は未変更 |

## 追加・変更したテストと `npm test` の結果

新規子プロセス e2e 10件:

- table / csv / markdown の RANGE 警告
- HAVING 未掲載集計の `UNRESOLVED_AGGREGATE_COMPARISON_WARNING`
- JSON の stderr 非重複と `warnings` 配列維持
- `--quiet`
- 警告なし
- `--export-csv`
- `--output`
- jsonl 行ストリーム

stdout固定スナップショット:

- `table: ... table stdout unchanged 1`
- `csv: ... csv stdout unchanged 1`
- `markdown: ... markdown stdout unchanged 1`
- `--output ... --output csv unchanged 1`

最終 `npm test`:

- 通常 suite: `304 passed, 304 total`
- 通常 tests: `6554 passed, 6554 total`
- snapshots: `27 passed, 27 total`
- サブプロセス suite: `2 passed, 2 total`
- サブプロセス tests: `26 passed, 26 total`
- 失敗: `0`
- `docs:check`: `ok（リンク 3962 件 / 台帳 18 行）`

検証順序は対象 e2e、続いて全体 suite としました。禁止事項に従いビルドは実行していません。

## 文書の差分

> v3.79.0 以降、エンジンの警告は stderr に `warning=<警告文>` として出力され、`--quiet` で抑止できます。  
> `--format json` では stderr に重ねて出力せず、従来どおり `warnings` 配列に含めます。

## §4 の確認結果

1. 単文出力経路

   単文版の名前付き関数はなく、`src/cli/index.ts:2847` の SELECT 分岐が相当箇所です。`--output` は同じ分岐、`--export-csv` はその直後の `src/cli/index.ts:2855` を通ります。console も `src/cli/index.ts:1836`、`src/cli/index.ts:1944`、`src/cli/index.ts:2023` から `runWithArgvCapture` 経由で同じ単文分岐へ入ります。

2. `--quiet` の根拠

   help上の意味は `Suppress non-result logs`。既存でも行数サマリ、バッチサマリ、export receipt、mutation／validationサマリを抑止します。警告も結果本体ではない stderr ログなので同じ条件へ統合しました。

3. stdout不変の根拠

   `buildOutput` と stdout／ファイル書き込み処理は変更せず、その後にstderr専用関数を呼んでいます。table／csv／markdown／`--output` csv の4スナップショットで結果バイト列を固定し、jsonl は各stdout行が独立JSONであること、JSONは従来の `warnings` 配列を検証しています。

## Claude が実機で確かめるべき残項目

- CLIを再ビルド後、dev profileの実データで table / csv / markdown / jsonl の stderr と stdout を確認
- `--format json` の `warnings` 配列とstderr非重複
- `--quiet`、`--output`、`--export-csv`
- console実行時にも同じ `warning=` 行が表示されること
- stdout／出力ファイルを従来版とバイト比較

## 上限内に終わらなかった項目

なし。


---

## Claude レビュー（2026-09-16）

### 1. 判定

codex 版をそのまま採用（修正なし）。差分は `src/cli/index.ts` の関数 1 つ（`writeSingleSelectWarnings`・12 行）と呼び出し 1 か所、エンジン不変。形式はバッチ文サマリ（B188）と同じ `warning=<文言>`、`--quiet` と `--format json` では出さない（json は従来どおり `warnings` 配列）。stdout は table / csv / markdown / `--output` の 4 スナップショットで固定されている。

### 2. 実機（dev profile・SFA パック・`npm run build:cli` 後の CLI）

| 形式 | stderr | stdout |
| :--- | :--- | :--- |
| table（既定） | `rowCount=6` に続けて `warning=累計 は既定フレーム（RANGE）…` | 結果表のみ（不変） |
| csv | 同上 | `会社名,累計` の CSV のみ（不変） |
| json | 出ない（`warnings` 配列に載る） | JSON のみ |
| `--quiet` | 出ない | 結果表のみ |
| B187 の HAVING 未掲載集計 | `warning=比較条件で参照した集計値を確認できません。SELECT リストに同じ集計式を含めてください。` | 空の結果表 |

B187 で「静かに 0 行」と見えた形は、これで CLI テキストでも警告付きになる。

### 3. 結果

- `npm test`（Claude 実行・最終）: 304 suites / 6,554 tests passed、サブプロセス 2 suites / 26 passed、snapshots 27、`docs:check` 通過
