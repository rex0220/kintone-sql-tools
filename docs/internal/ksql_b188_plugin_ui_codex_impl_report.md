# B188 残務（プラグイン UI 表示）実装報告（codex・2026-09-16）

- 依頼: [ksql_b188_plugin_ui_codex_impl_request.md](ksql_b188_plugin_ui_codex_impl_request.md)（案 1・最終結果の警告欄に先行文の警告を集約）
- 起票: [ksql_b188_temp_table_window_range_warning_not_surfaced_issue.md](ksql_b188_temp_table_window_range_warning_not_surfaced_issue.md) §3「面ごとの表示」
- 作業ブランチ: `b188ui/dev`（v3.81.0 の HEAD）
- 末尾に Claude のレビュー節を追記

---

## 変更ファイル一覧

- `src/ui/renderResult.ts:79`
- `src/ui/desktop.ts:2027`
- `src/ui/__tests__/b188PluginBatchWarnings.test.ts:1`（新規）
- `docs/ksql_language_reference.md:3823`

## 修正箇所 ↔ 根拠行の対応表

| 修正内容 | 根拠行 |
|---|---|
| バッチ表示結果に任意の先行警告を前置 | `renderResult.ts:79-89` |
| (a) `statements[].warnings` を `[文番号]` 付きで収集 | `renderResult.ts:100-104` |
| (b) 表示対象外 SELECT の `result.warnings` を収集 | `renderResult.ts:106-111` |
| 表示対象自身の警告を重複判定へ登録 | `renderResult.ts:114-119` |
| (c) 未収集の `batch.warnings` を接頭辞なしで追加 | `renderResult.ts:121-123` |
| 最終結果セットを保ったまま警告一覧を生成 | `desktop.ts:2193-2209` |
| `result: null` のバッチでも警告一覧を生成 | `desktop.ts:2211-2217` |
| 結果あり・なし双方の描画へ警告を渡す | `desktop.ts:2272-2289` |

## 追加・変更したテストと `npm test` の結果

新規 `b188PluginBatchWarnings.test.ts` に以下の6件を追加しました。

- CREATE TEMP の警告と最終 SELECT 自身の警告の順序
- 途中 SELECT の文番号付与と最終結果警告の非重複
- dialect 1 のバッチ警告を接頭辞なしで表示
- 警告なしバッチの HTML 不変
- 単文 SELECT の HTML 不変
- `result: null` で note の後ろに警告を表示

`npm test`:

```text
Test Suites: 308 passed, 308 total
Tests:       6604 passed, 6604 total
Snapshots:   27 passed, 27 total

Test Suites: 2 passed, 2 total
Tests:       26 passed, 26 total
Snapshots:   0 total
```

失敗: 0

`npm run docs:check`:

```text
[docs-check] ok（リンク 3979 件 / 台帳 12 行）
```

## 文書の差分

追記全文:

> バッチでは、表示中の最終結果の警告欄に、先行文の警告が `[文番号]` 付きで表示されます（v3.82.0〜）。

## §4 の確認事項

1. 警告一覧は `collectPrecedingBatchWarnings`（`renderResult.ts:93-125`）で組み立てました。(a) は `100-104`、(b) は `106-111`、(c) は `121-123` です。呼び出しは `desktop.ts:2207` と `2215` です。
2. `result: null` でも警告を収集し、`renderBatchResult` が情報行・noteの後ろへ `.ksql-warn` として表示します（`desktop.ts:2211-2217`, `2289`、`renderResult.ts:85-89`）。
3. 既存表示は既定引数を空配列にしたため変更されません。根拠は「警告の無いバッチは従来と同じ HTML を返す」「単文 SELECT の描画はバッチ警告の集約に影響されない」および「CREATE TEMP の警告を文番号付きで最終 SELECT の警告より前に表示する」です。

## Claude が実機で確かめるべき残項目

- プラグインをビルドし、kintone 上で一時テーブルバッチを実行する。
- `[1]` 付き先行警告 → 最終結果自身の警告 → 件数・結果表の順を確認する。
- 結果セットなしのバッチで、note の後ろに警告が表示されることを確認する。
- `prod/js/desktop.js` は未生成・未変更のため、ビルド成果物へ反映して確認する。

## 上限内に終わらなかった項目

なし。禁止された git 操作、ビルド、MCP tool call、台帳・起票文書・エンジンの変更は実施していません。
---

## Claude レビュー（2026-09-16）

### 1. 判定

codex 版をそのまま採用（修正なし）。差分は `src/ui/renderResult.ts`（`collectPrecedingBatchWarnings` と `renderBatchResult` の任意引数 `precedingWarnings`）と `src/ui/desktop.ts`（`BatchRunOutcome.precedingWarnings` の配線）だけで、エンジン・公開型・「最終結果だけ表示する」契約は不変。既存表示は既定引数が空配列なので 1 バイトも変わらない（テストで固定）。

- (a) `statements[].warnings`（一時テーブル・SELECT-based DML）と (b) 表示対象外の SELECT の `result.warnings` は `[文番号]` 付き、(c) `batch.warnings` のうち未表示のもの（dialect 1）は接頭辞なし、の順で最終結果の警告欄の前に出る。表示結果自身の警告は従来どおり接頭辞なし・重複しない
- `result: null`（結果セットなし）のバッチでも note の後ろに同じ形式で出る

### 2. 確認

- `npm run build`（プラグイン含む full build）で `prod/js/desktop.js` を再生成し、新しい配線がバンドルに入っていることを確認（Claude 実行）
- `npm test`（Claude 実行・最終）: 308 suites / 6,604 tests passed、サブプロセス 2 suites / 26 passed、snapshots 27、`docs:check` 通過
- kintone 上のプラグイン画面での目視（一時テーブルバッチで `[1] 累計 は既定フレーム（RANGE）…` が最終結果の上に出ること）は、v3.82.0 のプラグイン zip を入れ替えたあとに user が確認する

### 3. 結果

- `npm test`: 308 suites / 6,604 + 26 passed（上記）
