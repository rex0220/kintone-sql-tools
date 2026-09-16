# B188 実装依頼（codex）

**`CREATE TEMP TABLE … AS SELECT` で実体化した SELECT の `warnings` が捨てられ、ウィンドウの既定フレーム（RANGE）警告などが表面化しない問題を直す。[起票文書](ksql_b188_temp_table_window_range_warning_not_surfaced_issue.md) の案 A（警告の伝播・純加法・結果不変）で実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b188/dev`・v3.78.0 の HEAD + 起票コミット）
上限: 1 PR・1.5 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文・警告文を新たに発明しない（既存の警告文をそのまま運ぶ）。**結果行・列・EXPLAIN の行を変えない。** 公開型への**必須**プロパティ追加は破壊的変更なので禁止（任意プロパティの追加だけ可）。

## 1. 決まっていること（レビュー対象外）

### 1.1 直すこと

- `src/execute.ts` の `executeBatch` 内、`resolvedStmt.type === "CREATE_TEMP_TABLE"` 分岐（`execute.ts:2542-2557`）が `runSelectLike` の `SelectResult` から `rows` / `columns` / `columnMeta` だけを取り、`result.warnings` を捨てている。直接の `SELECT` と `WITH`（CTE）では同じ警告が最終結果の `warnings` に載る（実測 v3.78.0・起票文書 §1 の 3 経路）
- 対象になる警告は SELECT 実行で出るものすべて（ウィンドウの既定フレーム RANGE、ウィンドウ ORDER BY の一意性、JOIN キー 300 件超の全件取得、など）。警告文は変えない

### 1.2 直し方（案 A）

- `BatchStatementResult`（`execute.ts:1644-1657`）に任意プロパティ `warnings?: string[]` を追加し、`CREATE_TEMP_TABLE` の返り値 `{ tempTable, rowCount }` に実体化時の `result.warnings`（空なら付けない）を載せる
- `BatchExecuteResult.warnings`（スクリプト全体・重複なし）の集約経路に `CREATE_TEMP_TABLE` の警告も含める（現在の集約がどこで何を拾っているかを確認し、同じ規則＝重複除去で足す）
- 同じ SELECT を後段で `SELECT * FROM #t` と読んだときに、文 2 の `warnings` へ**重複して**出さない（文 2 は自分の実行で出た警告だけ）
- `IMPORT … SELECT` / `INSERT … SELECT` / `UPSERT … SELECT` の source SELECT が同じように警告を捨てていれば同じ扱いにする（捨てていなければ報告だけ）。EXPLAIN は対象外（B188 案 B・今回はやらない）
- 表示面: CLI のバッチ表示（`[1] CREATE_TEMP_TABLE success temp=#t rows=20` の行）に既存の SELECT 文と同じ流儀で警告を出す（CLI が文ごとの `warnings` をどう表示しているかを確認して合わせる。新しい表示形式を発明しない）。MCP の `ksql_query` バッチ envelope・`/flow`（`executeStatement` / statement result）・プラグインは、文ごとの `warnings` を既に運ぶ経路があればそれに乗る。無ければ「どの面が拾えないか」を報告に書く（面ごとの新規表示は今回やらない）

### 1.3 変えないこと

- 結果行・列・`rowCount`・`tempTable`・EXPLAIN の全行・警告文の文言
- 警告の無い SELECT を実体化したときの `BatchStatementResult` は従来と同一（`warnings` プロパティ自体を付けない）
- 既存テストで意図的に変えるものは無い想定。変えざるを得ない場合は「意味が変わるか」を報告に書き、意味が変わるなら止めて報告する

## 2. テスト（受入）

新規 `src/__tests__/b188TempTableWarnings.test.ts` に少なくとも次を入れる（mock client でよい。既存の一時テーブルテストの流儀に合わせる）:

- 3 経路の同値: `SELECT … SUM(x) OVER (ORDER BY x) AS 累計 FROM APP100` の `warnings` と、`WITH t AS (同) SELECT * FROM t` の `warnings` と、`CREATE TEMP TABLE #t AS 同; SELECT * FROM #t` の**文 1** の `warnings` が同じ文字列配列になる
- 文 2 の `SELECT * FROM #t` には文 1 の警告が**重複して載らない**
- `BatchExecuteResult.warnings`（全体）に 1 回だけ含まれる
- 警告の無い SELECT の実体化では `warnings` プロパティが無い（`toEqual({ tempTable, rowCount })` の従来形が通る）
- ウィンドウ以外の警告 1 種（JOIN キー 300 件超の全件取得警告など、mock で出せるもの）も同じ経路で伝わる
- `IMPORT … SELECT` / `INSERT … SELECT` を同じ扱いにした場合はそれぞれ 1 本
- `npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §25「バッチ実行と一時テーブル」に「`CREATE TEMP TABLE … AS SELECT` の実行時警告（ウィンドウの既定フレームなど）は、その文の結果の `warnings` に載る（v3.79.0〜）。後段の参照文には重複しない」を 1〜2 文で追記
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. `BatchExecuteResult.warnings` の集約が現在どの文種の警告を拾っているか（行番号）と、今回足した後の規則
2. `IMPORT … SELECT` / `INSERT … SELECT` / `UPSERT … SELECT` の source SELECT の警告が捨てられているかどうか（それぞれ行番号）と、今回の扱い
3. 面ごとの到達: CLI・MCP `ksql_query`（バッチ envelope）・`/flow` の statement result・プラグインの一時テーブル実行で、文ごとの `warnings` がどこまで届くか（届かない面があれば理由）
4. 公開型の変更が任意プロパティの追加だけであること（`d.ts` に必須プロパティが増えていない）

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 4 項目／Claude が実機（SFA パック・CLI と MCP・`/flow`）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
