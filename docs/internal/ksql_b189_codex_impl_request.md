# B189 実装依頼（codex）

**CLI のテキスト／csv／markdown 表示が単文 SELECT の `warnings` をどこにも出さない（JSON とバッチ表示だけが見える）穴を、stderr への出力で埋める。[起票文書](ksql_b189_cli_single_statement_warnings_not_shown_issue.md) の案 A（stderr・純加法・stdout 不変）で実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b188/dev`・B188・B186・B185 コミット済みの HEAD）
上限: 1 PR・1 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
警告文を変えない・新たに発明しない。**stdout の内容を 1 バイトも変えない**（csv / markdown / table / jsonl / json のすべて）。エンジン（`src/execute.ts` 以下）に触れない。

## 1. 決まっていること（レビュー対象外）

### 1.1 現象（実測 v3.78.0 + B188・CLI 再ビルド版・dev profile）

- 単文 `SELECT … SUM(売上) OVER (ORDER BY 売上) AS 累計 …` を `--format table` / `csv` / `markdown` で実行しても、エンジンの `warnings`（既定フレーム RANGE 警告）は stdout・stderr のどこにも出ない。`--format json` では `warnings: [...]` に載る
- B187 の `HAVING SUM(売上) > …`（SELECT に無い集計）も同じ。`warnings` に「比較条件で参照した集計値を確認できません。SELECT リストに同じ集計式を含めてください。」があるのに見えない
- バッチ（`;` 区切り）は B188 で文サマリに `warning=<文言>` が出る（stderr・`--quiet` で抑止＝`src/cli/index.ts:1237-1239`・`buildBatchStatementSummary` `:1190`）
- `src/cli/index.ts` で `warnings` を参照しているのは JSON 出力（`:916`）と上のバッチ文サマリだけ

### 1.2 直し方（案 A）

- 単文 SELECT（`--format` が json 以外）の実行後、`result.warnings` を 1 行ずつ **stderr** に出す。形式はバッチ文サマリと揃える（`warning=<文言>`。新しい形式を作らない）。stdout は結果表のまま
- `--quiet` の扱い: バッチ文サマリは `--quiet` で抑止される（`:1237`）。単文の警告も**同じ扱い**にする（`--quiet` で抑止）。理由: `--quiet` は「結果以外のログを抑止」（`--help` の `Suppress non-result logs`）で、警告も非結果ログ。運用で警告を拾いたいときは `--format json` か `--quiet` なしで受ける（§3 の文書に書く）
- `--export-csv`（B179・単文 SELECT のファイル書き出し `runSingleSelectCliExport` `:1118`）でも同じ stderr 出力
- `--output <path>` で stdout をファイルに向けている場合も stderr 出力は同じ（ファイルには混ぜない）
- jsonl は行ストリームの契約があるので stdout に混ぜない（stderr のみ・他と同じ）
- console モード（`--console`）は単文実行と同じ関数を通るなら同じ扱い。別経路なら報告だけ（今回はやらない）

### 1.3 変えないこと

- stdout（全形式）・JSON の内容・バッチ表示（B188）・終了コード・エンジン

## 2. テスト（受入）

`src/cli/__tests__/` の既存 e2e の流儀（子プロセスで CLI を起動し stdout / stderr を分けて取る）で、新規 `b189_single_select_warnings.e2e.test.ts` に少なくとも次を入れる:

- table / csv / markdown の 3 形式で、RANGE 警告のある単文 SELECT を実行すると stderr に `warning=<文言>` が 1 行出て、**stdout は修正前と同一**（csv / markdown はスナップショットで固定）
- HAVING 未掲載集計（B187 の形・mock で `UNRESOLVED_AGGREGATE_COMPARISON_WARNING`）でも stderr に出る
- `--format json` は不変（stderr に出さない・`warnings` 配列は従来どおり）
- `--quiet` で stderr に出ない
- 警告の無い単文では stderr が増えない
- `--export-csv <path>` の単文書き出しでも stderr に出る
- 既存の CLI e2e が通る。`npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_cli_tutorial.md`（または CLI の出力形式を説明している節）に「エンジンの警告は stderr に `warning=` で出る（v3.79.0〜。`--quiet` で抑止。JSON は `warnings` 配列）」を 1〜2 文で追記
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. 単文の出力関数（`writeBatchOutput` の単文版）の場所と、`--export-csv` / `--output` / console の各経路が同じ関数を通るか（行番号）
2. `--quiet` の既存の意味（どのログを抑止しているか）と、警告を同じ扱いにした根拠
3. stdout が不変であることの根拠（スナップショットの名前）

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 3 項目／Claude が実機で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
