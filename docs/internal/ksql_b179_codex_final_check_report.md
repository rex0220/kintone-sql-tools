# B179 codex 最終チェック報告（リリース前・2026-09-04）

- 対象: feature/b179-csv-export の PR 3（CLI）と PR 2 の配線（e4bb63f 時点）。最初の全範囲レビュー（12:46 起動）は結果を出さずに終了したため、範囲を絞って再実行
- 実行: `codex exec -s read-only`（Claude が依頼・原文のまま保存）。Claude の対応は [起票 §7](ksql_b179_csv_export_sink_issue.md) を参照

## 総評

**修正が必要。**

主要契約は概ね仕様どおりですが、`withBatchCompletionObserver` の例外が成功済み batch を reject へ変える問題があります。加えて atomic write に、ゼロ進捗 write と自分が作成していない一時 file の削除という防御上の穴があります。

対象コードは `e4bb63f` と一致しています。レビュー中の編集・git 書込みはしていません。

## 指摘一覧

| 重要度 | file:line | 問題 | 観測方法 | 提案 |
|---|---|---|---|---|
| **High** | `src/execute.ts:1853` | observer を無保護で同期呼出ししているため、observer が throw すると、完成済み `batchResult` が返らず `executeBatch()` 全体が reject する。`finally` は cache 解放しかしない。今回の CLI observer は `src/cli/index.ts:2713` の `new Map(tempTables)` なので通常は問題ないが、例外隔離という契約は満たさない。 | throwing observer を付け、成功 batch が resolve することを unit test。現状は reject するはず。 | `executeBatch` 側で observer 例外を隔離する。CLI が capture 失敗を検出する必要があるなら、observer 内で例外を保存し、batch 完了後に export のみを失敗させる。 |
| **Medium** | `src/cli/exportCsvFiles.ts:35`, `src/cli/exportCsvFiles.ts:48` | `openSync(temp, "wx")` が既存一時名との衝突で失敗しても、catch がその既存 file を `unlinkSync` する。この呼出しが作成していない file を削除し得る。 | `randomBytes` を固定し、同名 `.tmp` を先に作って実行。現状は既存 `.tmp` が削除される。 | `created` フラグを `openSync` 成功後に立て、自分が作成した場合だけ cleanup する。 |
| **Medium** | `src/cli/exportCsvFiles.ts:36` | short write はループしているが、`writeSync` が `0` を返すと永久ループする。fail-closed の error 終了にならない。 | `writeSync` の最初の戻り値を `0` にした unit test。 | `written <= 0` を `ExportSinkWriteError` にして cleanup へ進める。 |
| **Low／文書** | `src/cli/index.ts:106`, `README.md:191` | help と README は相互には一致するが、最初の `=`、無効左辺、drive letter、`--output` 衝突、`--dry-run` 禁止までは説明していない。実装は `src/cli/index.ts:992`–`src/cli/index.ts:1048` で正しい。 | `ksql --help` と README を仕様 §4.4 と比較。 | README に短い「引数規則」節を追加。help は現状の簡潔さでも許容可能。 |

## 適合確認

1. CLI fail-closed

- batch 失敗時は `writeBatchOutput()` の非ゼロを確認して export へ進まないため、serializer／export file write は実行されません。`src/cli/index.ts:2771`
- 複数 sink は `src/cli/index.ts:1101`–`src/cli/index.ts:1110` で全件 serialize し、その後 `src/cli/index.ts:1115` から書込みへ進みます。serializer が1件でも失敗すれば、どの file も作られません。
- file 書込みは `src/cli/index.ts:1077`–`src/cli/index.ts:1079` の逐次処理です。第2 target の write が失敗した場合、第1 target は既に置換済みになり得ます。これは仕様 §3.5 の「各完成 file 単位」「複数 target transaction は保証しない」と一致します。
- 個々の target は `wx → 全量write → fsync → close → rename` の順です。`src/cli/exportCsvFiles.ts:35`–`src/cli/exportCsvFiles.ts:43`

2. `exportSinkStatus`

4状態と優先順位は一致します。

- failure／timeout／assertion／依存失敗は `failed` set または非EXIT abort に入り、`"failed"`。`src/flow-library/exportSinks.ts:95`
- busy／未処理文ありは `"incomplete"`。`src/flow-library/exportSinks.ts:98`
- 完了後は temp table の有無で `"materialized"`／`"not-created"`。`src/flow-library/exportSinks.ts:99`
- EXIT後 skipped は failure set に追加されません。`src/execute.ts:2002`–`src/execute.ts:2009`
- timeout、assertion、通常失敗は failure set と abort に反映されます。`src/execute.ts:2093`–`src/execute.ts:2099`

3. 単文 SELECT の同一参照

問題ありません。

- `execute()` は最終結果を複製しますが、元の `SelectResult` から metadata を取得し、返却する `finalResult` に付け直しています。`src/execute.ts:930`–`src/execute.ts:935`
- `mergeSelectWarnings` も複製時に metadata を移送します。`src/execute.ts:3699`–`src/execute.ts:3704`
- CLI の `restoreSqlDiagnosticValue` は dry-run または明示的 EXPLAIN にしか適用されません。`src/cli/index.ts:2804`–`src/cli/index.ts:2808` 名前なし export は dry-run を事前拒否し、SELECT／UNION／WITH だけを受理するため、この clone 経路には入りません。
- `runSingleSelectCliExport` は最終返却 object をそのまま `getSelectColumnMeta` に渡しています。`src/cli/index.ts:1118`

4. 公開面

- observer key は private symbol で、`ExecuteOptions` には存在しません。`src/execute.ts:745`, `src/execute.ts:799`–`src/execute.ts:815`
- engine の公開 barrel も helper を再exportしていません。`src/core/index.ts:5`
- ただし前述のとおり、observer 例外隔離は不足しています。

5. 引数規則

最初の `=`、無効左辺の拒否、後続 `=` のpath保持、drive letter、重複path、`--output` 衝突、`--dry-run` 禁止はすべて実装されています。`src/cli/index.ts:992`–`src/cli/index.ts:1048`

6. Shift_JIS

実装方針は正しいです。

- `stringToCode → convert({to:"SJIS", from:"UNICODE"})` は bundled library の推奨形と一致。`src/cli/shiftJisEncoder.ts:40`
- `TextDecoder("shift_jis", {fatal:true})` を使用。`src/cli/shiftJisEncoder.ts:36`
- `decoded !== text` と `charCodeAt` により code unit 完全一致を検査。`src/cli/shiftJisEncoder.ts:26`–`src/cli/shiftJisEncoder.ts:31`, `src/cli/shiftJisEncoder.ts:49`
- `stringToCode` はUTF-16 code unit列を渡し、library側がサロゲートペアを処理する設計です。表現不能文字は round-trip 不一致で拒否されます。

## テストの穴

「修正前でも通る」または検出力が不足する箇所です。

- `src/flow-library/__tests__/exportSinkPublicApi.test.ts:213`–`src/flow-library/__tests__/exportSinkPublicApi.test.ts:223` は一般的な statement failure だけです。timeout、assertion、依存失敗、busy の判定が壊れても通ります。
- `src/flow-library/__tests__/exportSinkPublicApi.test.ts:252`–`src/flow-library/__tests__/exportSinkPublicApi.test.ts:270` の非回帰テストは定数SELECTでAPIが元々0回です。APP-backed SELECT に metadata 用の追加APIが発生する退行を検出できません。
- `src/cli/__tests__/exportCsv.e2e.test.ts:122`–`src/cli/__tests__/exportCsv.e2e.test.ts:130` はcodeとfileだけを確認し、`--output` 衝突／`--dry-run` でAPIが0回かを確認していません。
- `src/cli/__tests__/exportCsv.e2e.test.ts:71`–`src/cli/__tests__/exportCsv.e2e.test.ts:77` は通常の `execute()` 最終cloneを通しますが、search-abort warning／dialect warning のclone経路は未検証です。
- observer throw、`writeSync() === 0`、一時名衝突、emoji等のサロゲートペアを直接扱うテストはありません。

## Claude が実測すべき項目

- 上記2 test suiteを clean checkout で実行。こちらでは Jest が `.tmp/b110-release-baseline/package/package.json` との haste collision、および Jest cache書込みの `EPERM` で開始前に失敗しました。
- throwing observer が成功 batch を reject することと、修正後に batch 結果が維持されること。
- `writeSync=0`、short write、fsync／close／rename failure、一時名衝突の fault-injection。
- Windows Node 18/20/24で、別processが保持した既存fileに対する `EPERM`、旧file維持、一時file cleanup。
- status の timeout／assertion／依存失敗／実行中busy。
- Shift_JIS の emoji、ハングル、U+00A5、U+2212、U+2014、孤立サロゲート。すべて non-zero・既存file不変を確認。
- warning付与されるSELECTでも、返却された同一 `SelectResult` から metadataを取得できること。

