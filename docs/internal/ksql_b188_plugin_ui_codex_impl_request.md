# B188 残務 実装依頼（codex）— プラグインの実行画面に、結果セットを持たない文の警告を出す

**v3.79.0 の B188 で `CREATE TEMP TABLE … AS SELECT` / `INSERT`・`UPSERT … SELECT` の実体化警告が文結果の `warnings` に載るようになったが、プラグインの実行画面はそれをどこにも出さない。表示中の最終結果の警告欄に、先行文の警告を文番号付きで集約する（[起票文書](ksql_b188_temp_table_window_range_warning_not_surfaced_issue.md) §3 の「面ごとの表示」・案 1）。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b188ui/dev`・v3.81.0 の HEAD）
上限: 1 PR・1 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・**ビルド（`prod/js/desktop.js` に触れない。ビルドは Claude）**・kSQL MCP の tool call・MEMORY.md 禁止。
**エンジン（`src/execute.ts` 以下・`src/engine/`・`src/core/`）に触れない。** 警告文を変えない・新たに発明しない（既存の文言をそのまま運び、接頭辞だけ付ける）。プラグインの結果表示の契約「最後に結果セットを返した文だけ表示する」（仕様 §8.4・`src/ui/desktop.ts:2188-2212`）を変えない。

## 1. 決まっていること（レビュー対象外）

### 1.1 現状（v3.81.0）

- 単文の SELECT / VALIDATION は `src/ui/renderResult.ts:176-190`（`renderSelect`）が `result.warnings` を `.ksql-warn` の div として結果表の上に出す
- バッチは `src/ui/desktop.ts:2188-2212` で「最後に結果セットを返した文」だけを `result` として返し、それが `renderSelect` で描画される。警告欄に出るのはその文自身の `warnings` だけ
- 先行文のサマリ行（`buildBatchStatementSummary`・`desktop.ts:2066-2092`）は `s.result` を持つ文だけを対象にし、DML の影響件数と `VALIDATE INTO` の統計だけを並べる。`CREATE TEMP TABLE` は `result` を持たないので行ごと除外される
- したがって、`CREATE TEMP TABLE #t AS SELECT … SUM(x) OVER (ORDER BY x) …; SELECT * FROM #t` をプラグインで実行すると、文 1 の RANGE 警告（`batch.statements[0].warnings`・B188）は画面のどこにも出ない。CLI は `warning=` で、MCP は `statements[].warnings` で出る（面ごとの非対称）

### 1.2 直し方（案 1・警告欄に集約）

- バッチ実行の結果組み立て（`desktop.ts:2188-2212` の `runBatchSql` 末尾）で、表示する最終結果とは別に**先行文の警告の一覧**を作り、描画時に最終結果の警告欄へ**文番号付き**で足す
  - 対象: (a) `batch.statements[i].warnings`（結果セットを持たない文＝CREATE TEMP TABLE・SELECT-based DML・IMPORT の B188 警告）(b) 表示対象**以外**の SELECT 文の `result.warnings`（途中の SELECT。表示されないので同じく埋もれている）(c) `batch.warnings` のうち (a)(b) に含まれない dialect 1 の警告（文番号なし）
  - 形式: `[1] <警告文>` のように既存の文番号表記（サマリ行と同じ `[n]`）を接頭辞にし、文言は変えない。表示中の最終結果自身の警告は従来どおり接頭辞なし
  - 順序: 文順。同じ文言でも文が違えば別行（重複除去しない。どの文かが情報）
- 描画は `renderSelect` の既存 `warnings` 配列に**前置**する（先行文 → 表示結果自身 → 件数の注記、の順）。`renderResult.ts` の公開関数の引数に任意の `precedingWarnings?: string[]` を足す形か、`desktop.ts` 側で `result` を複製して `warnings` を足す形のどちらでもよい（**`ExecuteResult` の公開型は変えない**。複製する場合は元の `result` オブジェクトを書き換えない）
- 最終結果が無いバッチ（結果セットなし・`result: null`）の場合は、`note` の後ろに同じ形式の警告行を出す（既存の note 表示に `.ksql-warn` を足す。表示の仕組みが無ければ報告に書き、実装は結果セットありの場合だけでよい）
- 単文実行・EXPLAIN・DML 確認ダイアログ・キャンセル時の表示は変えない

### 1.3 変えないこと

- 最終結果だけを表示する契約、サマリ行の内容、警告文の文言、エンジン、公開型
- 既存の `src/ui/__tests__/renderResult.test.ts`・`b170BatchExplain.test.ts` ほかがそのまま通ること。変えざるを得ない場合は「意味が変わるか」を報告に書き、意味が変わるなら止めて報告する

## 2. テスト（受入）

`src/ui/__tests__/` に新規 `b188PluginBatchWarnings.test.ts`（既存の `renderResult.test.ts` の流儀）で少なくとも次を入れる:

- `CREATE TEMP TABLE #t AS <RANGE 警告の出る SELECT>; SELECT * FROM #t` のバッチ結果（mock の `BatchExecuteResult`）を描画すると、警告欄に `[1] 累計 は既定フレーム（RANGE）…` が出て、文 2（表示結果）の警告は従来どおり接頭辞なし
- 途中の SELECT（表示されない文）の警告も `[n]` 付きで出る。表示結果自身の警告は重複しない
- dialect 1 の警告（`batch.warnings` にだけあるもの）が接頭辞なしで出る
- 警告の無いバッチでは警告欄が従来と同一（スナップショットか文字列比較）
- 単文の SELECT の描画が従来と同一
- `npm test` 全体が通ること（結果を報告に貼る）。ビルドはしない

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §23「UI 機能」（または プラグインの実行画面を説明している節）に「バッチでは、表示中の最終結果の警告欄に、先行文の警告が `[文番号]` 付きで出る（v3.82.0〜）」を 1〜2 文で追記
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. 警告一覧を組み立てた場所と、(a)(b)(c) それぞれの取り出し方（行番号）
2. `result: null`（結果セットなし）のバッチでの表示の扱い
3. 既存の警告表示（単文・最終結果）が 1 バイトも変わらないことの根拠（テスト名）

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 3 項目／Claude が実機（プラグインをビルドして kintone 上で一時テーブルバッチを実行）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
