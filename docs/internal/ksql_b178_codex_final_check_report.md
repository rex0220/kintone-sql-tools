# B178 codex 最終チェック報告（v3.76.0 リリース後・2026-09-04）

- 対象: v3.75.0..v3.76.0（776c393 / 6801ab3 / eaeef36）
- 実行: `codex exec -s read-only`（Claude が依頼・原文のまま保存）。Claude の実測結果は [起票 §7](ksql_b178_flow_import_source_materialized_receipt_issue.md) を参照

## 総評

**patch が必要です。ただし engine 実装の修正ではなく、受入テストと実装報告の補強です。**

Critical／実装上の Major は見つかりませんでした。5経路の通知順序、private Symbol の隔離、rows／encoding、deadline 再検査、公開型・文書は仕様と整合しています。

一方、B178 の中心保証を十分に固定できていない受入テストがあります。「リリース済みのまま問題なし」と判定するには弱いため、テストのみの patch release を推奨します。

## 指摘一覧

### Major — projection 境界のテストが修正前でも通る

- 箇所: `src/flow-library/__tests__/importSourcePublicApi.test.ts:365`
- 問題: projection テストは raw 2行、projection 後も2行、mutation も2件です。`src/flow-library/__tests__/importSourcePublicApi.test.ts:371`–376。このため、receipt を誤って projection 後の `selected.rows.length` から生成しても通ります。
- 実装自体は正しく、raw materializer直後に通知し、その後でprojectionへ進みます。`src/execute.ts:10108`–119
- 再現・観測: `CAST` 失敗など、raw materializeは成功するがprojectionでerrorになるCSVを使い、文がerrorでもcallbackが1回済んでいることを確認する。
- 提案: 「projection失敗でもreceipt済み」の公開APIテストを追加する。現在の正常系テストは残す。

### Major — mutation 0 の失敗テストが5経路を固定していない

- 箇所: `src/flow-library/__tests__/importSourcePublicApi.test.ts:475`–490
- 問題: callback throw/rejectのmutation 0はflat INSERTだけです。record-number UPDATE、subtable CSV、subtable JSON、UPSERT、`VALIDATE ONLY`／`ON ERROR SKIP`への横断テストがありません。
- 静的には成立しています。subtableは通知後にprepare／writeへ進みます。`src/execute.ts:9707`–713。record-number UPDATEは通知後にlookup／PUTへ進みます。`src/execute.ts:9977`–991、`src/execute.ts:10072`–75。flat系は共通通知後に各経路へ分岐します。`src/execute.ts:10108`–119。
- 再現・観測: 各経路のcallbackをthrowさせ、`postRecords`／`putRecords`／`deleteRecords`／`upsertRecords`合計0、callback 1回、当該文errorを確認する。
- 提案: 5経路のparameterized testを追加する。実装変更は不要。

### Minor — timeoutテストがcallback未到達でも通り得る

- 箇所: `src/flow-library/__tests__/importSourcePublicApi.test.ts:516`–528
- 問題: `timeoutMs: 5`でcallbackの開始・完了をassertしていません。遅い環境でmetadata取得中に期限切れになっても、`TimeoutError`＋mutation 0という期待を満たします。
- deadline再検査自体は妥当です。callbackをawaitした後に期限を再検査し、期限後のdetached executionをmutationへ進ませません。`src/execute.ts:2040`–46。通常経路は期限前なら追加例外を投げません。
- 提案: callback開始をgateで確認してから期限を進め、callback解放後にもmutation 0を確認する。fake timerまたは制御した`Date.now`を使う。

### Minor — §6.2 matrixに未収録行がある

- 箇所: `src/flow-library/__tests__/importSourcePublicApi.test.ts:339`–580
- 未収録:

  - 依存temp失敗後のIMPORT skip
  - 異なる2 sourceの途中失敗
  - subtable CSVで「`maxRecords`は親数、receiptは継続行込み物理record数」の同時確認
  - SQL encodingとpayload metadataが食い違う場合の、receipt側の優先順位確認

- encodingについて、B178テストのSQL SJISケースはpayload metadataを指定していません。`src/flow-library/__tests__/importSourcePublicApi.test.ts:347`–350。既存のdecodeテストは優先順位を踏みますが、receipt値を観測していません。`src/flow-library/__tests__/importSourcePublicApi.test.ts:105`–114。
- 提案: matrixどおり追加し、実装報告の「matrix対応済み」という記述も実態に合わせる。

### Minor — 「v3.75.0と同一」のテストが同一版内比較に留まる

- 箇所: `src/flow-library/__tests__/importSourcePublicApi.test.ts:563`–579
- 問題: v3.76.0のcallbackあり／なしを比較しており、両方に共通して入った非回帰を検出できません。loader回数も比較対象に含まれていません。
- 静的差分上、callback省略時の新しい観測可能な結果変更は見つかりません。receiptは内部materialized valueにだけ追加され、公開結果は明示的に再構築されています。`src/import/types.ts:17`–28、`src/execute.ts:10148`–195。
- 提案: v3.75.0由来の固定goldenとして、結果、loader回数、全read／mutation API回数を期待値でassertする。

## 問題なしと確認した点

- private Symbolは非exportで、設定入口はmanaged `/flow`だけです。`src/execute.ts:796`–803、`src/execute.ts:2037`–48
- `/flow` adapterはcallbackをrest optionsから分離しています。`src/flow-library/index.ts:147`–168
- Symbol注入後の該当options複製はobject spreadであり、own enumerable Symbolを保持します。`src/execute.ts:2432`–60、`src/execute.ts:9834`–50
- rows／encodingは指定どおりです。flat CSVはdecoded rows、JSONはtop-level、subtable CSVはグループ化前です。`src/import/materializeDmlSource.ts:19`–26、`src/import/jsonMaterializer.ts:57`–77、`src/import/importRecordsMaterializer.ts:71`–125
- ローカル`dist-flow`のd.tsには公開型だけがあり、receipt型／private Symbolはなく、`dist-engine`にも漏れていません。
- README、言語リファレンス、CHANGELOGの契約記述は実装と一致しています。
- tag `v3.76.0`、HEAD、`origin/main`はいずれも`eaeef36`です。
- `version:check:release`と`flow:bundle-guard`はPASSしました。

## Claude が実測すべき項目

- 上記5経路それぞれのcallback throw/reject時mutation API 0。
- raw成功後にprojectionが失敗する場合でもcallbackが1回完了済みであること。
- subtable CSVで、親1＋継続複数、`maxRecords: 1`が成功し、receiptだけが1より大きくなること。
- SQL `ENCODING`とpayload metadataを逆にした双方で、decode結果とreceipt encodingがSQL優先になること。
- CLI／MCP／プラグインをv3.75.0と比較し、結果・エラー・API回数が同一であること。
- 公開済みregistry tarballのESM／CJS／d.ts。今回`npm view`はネットワークtimeoutとなり、registry実体は独立確認できませんでした。
- kSQL-Flow側で`statementIndex`が受理され、source metadataのdedupe対象から除外されること。
- 全suiteの再実行。今回のread-only環境ではJestがcacheを書けず`EPERM`になりました。既存の実装報告にある6,342 tests PASSを独立再現したわけではありません。

## 触るべきでない既存テスト

pre-B178の既存テストで、意味を変更すべきものはありません。既存期待値の緩和や削除は不要です。

必要なのはB178受入テストの追加・強化です。特にtimeoutテストは削除せず、callbackへ実際に到達したことを固定する形へ変更してください。