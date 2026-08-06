# v3.57.0 リリース前 最終チェック依頼（codex）

**チェック依頼。コードもファイルも 1 行も変更しないこと。**
**git 操作をしないこと**（`git status` / `git diff` / `git log` すべて禁止）。
**kSQL MCP を叩かないこと。自分の MEMORY.md は読まないこと。**

**`npm test` / `npm run build` などの読み取り専用の検証コマンドは実行してよい**
（テスト実行前に `KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` /
`KINTONE_PASSWORD` / `KSQL_API_TOKEN` を unset すること。資格情報があると落ちる）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（**作業ツリーは v3.57.0・リリース直前**）

## 0. 依頼

**破壊的変更を含むリリースの直前チェック。**
**「出してよいか（go / no-go）」と、**止めるべき問題があればその根拠**を出してほしい。**

**これはあなたが書いた仕様（R3）を、あなたが実装したものへのチェック**である。
**その間に Claude がレビューして 2 か所直している**（§17・§8.4bis / §8.4ter）。
**自分の書いたものだからと甘く見ないこと。**

## 1. 何を出そうとしているか

**v3.57.0＝B148 集計されていない列参照を標準 SQL に合わせてエラーにする（挙動が変わる）。**

```
SELECT 製品名, 個数, SUM(個数) AS 合計 FROM APP100 GROUP BY 製品名
  旧 個数 は「そのグループの先頭レコードの値」。エラーも警告も無し
  新 ArgumentError（レコード取得前）
```

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b148_bare_column_group_by_spec_r3.md` | **仕様（正本）**。§8.4bis / §8.4ter は実装後に Claude が改訂 |
| `docs/internal/ksql_b148_codex_impl_report.md` | 実装報告＋**Claude レビュー**（末尾） |
| `src/core/aggregateDependencyValidation.ts` | 新設した共通層 |
| `src/core/groupingValidation.ts` / `src/core/optimization/plainGroupByPlan.ts` / `src/core/grouping.ts` / `src/execute.ts` | 変更箇所 |
| `src/__tests__/b148BareColumnGroupBy.test.ts` | 新設テスト |
| `docs/ksql_language_reference.md` | **§8 に「集計されていない列は書けません」を新設**・「レコード取得前にエラー」の一覧に追加 |
| `CHANGELOG.md` / `release/README.txt` / `docs/ksql_release_history.md` | リリース文書 |

## 2. 見てほしい点

### 2.1 実装が R3 と食い違っていないか

- **R3 §2〜§8・§11〜§12** の規則が、実装で満たされているか
- **Claude が後から入れた §8.4bis（完成 SQL の範囲）/ §8.4ter（違反箇所の呼び名）**と実装が一致しているか
- **仕様に書いたのに実装されていない項目**があれば挙げてほしい

### 2.2 壊してはいけないものを壊していないか

- **通るクエリの値・行順・`columns`・`rowCount`・`warnings` が変わらない**
- **ウィンドウ専用クエリが集計クエリになっていない**
- **拡張 grouping（B65）の既存挙動**＝`GROUPING()` membership・set/item 上限・
  wildcard・alias collision・JOIN 修飾名・first error・machine reason
- **素の `SELECT`（集計もグループ化も無い）に一切影響していない**

### 2.3 エラー文

- **内部語（`B65` / `Phase1`）が人間向け本文に残っていないか**——**全経路で**
- **示す移行 SQL が実行できない形になっていないか**
  （`GROUP BY CASE ... END` / 集計の別名を物理フィールド名と衝突させる形）
- **呼び名の優先順（列名→別名→関数名→式）が全経路で一貫しているか**

### 2.4 リリース文書

- **CHANGELOG / `release/README.txt` / 言語リファレンス §8 / リリース履歴**が
  **実装と食い違っていないか**（**掲載した SQL が実際に通る形か**も見てほしい）
- **移行案内が、破壊的変更を踏む利用者にとって十分か**
- **版数（3.57.0）が全箇所で揃っているか**

### 2.5 見落としやすい経路

- **CLI / MCP（`ksql_query` / `ksql_validate` / `ksql_explain` / `ksql_mutate`）/
  engine ライブラリ / プラグイン**で、**同じ診断が出るか**
- **保存クエリ（`ksql_run_saved_query`）**経由
- **DML の `SELECT` source**（`INSERT ... SELECT` / `UPSERT ... SELECT`）
- **バッチ・一時テーブル・CTE・`UNION`・サブクエリ**

### 2.6 リリース物

- `release/` の中身（zip / `ksql-mcp.mcpb` / `ksql-mcp.js` / `README.txt` / `VERSION.txt`）が
  **v3.57.0 として揃っているか**
- **`prod/js/desktop.js`（プラグイン bundle）に B148 の検査が入っているか**

## 3. 出力の形

1. **結論＝go / no-go**（no-go なら**止めるべき理由**を最初に）
2. **指摘**（重大度順。**ファイル:行 を根拠に**。各指摘に**対応案**）
3. **確認して問題が無かった項目**（何を見たか分かるように）
4. **リリース後に Claude が実測すべきこと**

**根拠の無い断定を書かないこと。**
**コードで確定できることと、実行しないと分からないことを区別すること。**

上記に従い、最終チェック結果を Markdown で出力してください。ファイルへの書き込みは不要です。
