# B148 実装依頼（codex）

**実装依頼。仕様 R3 に従って実装する。**
**git 操作をしないこと**（`git status` / `git diff` / commit / branch すべて禁止。**Claude が行う**）。
**kSQL MCP を叩かないこと**（実アプリへの接続は Claude が行う）。
**自分の MEMORY.md は読まないこと。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.56.3）

## 0. 仕様

**正本＝`docs/internal/ksql_b148_bare_column_group_by_spec_r3.md`（R3）**

**R3 はあなた自身が書き、Claude がレビューして §17.6 の 4 点を反映済み。**
**§17 は Claude のレビュー結果なので、実装対象ではなく背景として読むこと。**

**R1 / R2 は破棄済み。参照しないこと**（`..._spec.md` / `..._spec_r2.md`）。

補助資料（背景）:

- `docs/internal/ksql_b148_bare_column_group_by_issue.md` 起票と実測
- `docs/internal/ksql_b148_codex_review_1.md` §6 に**既存検査 B65 の到達範囲の実測**
- `docs/internal/ksql_b148_codex_review_2.md` 3 層分離が必要な理由

## 1. 実装の範囲

**R3 §2〜§8・§11〜§12 を実装する。**

**中心は R3 §3 の 3 層分離**＝
共通層（`SELECT`/`HAVING`/`ORDER BY` の依存収集・集計内部・サブクエリ境界・wildcard・first error）／
ordinary policy（plain plan から identity 構築）／
B65 policy（物理限定・`GROUPING()` membership・set/item 制限・alias collision）。

**拡張 grouping の既存挙動を変えないこと**（R3 §11 の回帰）。
**変わってよいのは人間向けエラー本文だけ**で、**machine reason `B65_NON_GROUPED_DEPENDENCY` は維持する**。

## 2. 必ず守ること

1. **通るクエリの値・行順・`columns`・`rowCount`・`warnings` を変えない**（R3 §16.8）
2. **ウィンドウ専用クエリを集計クエリにしない**（`SELECT SUM(x) OVER () FROM ...` は通る）
3. **集計とウィンドウの同一 SELECT 併用は従来どおり `ParseError`**（解禁しない）
4. **エラーはレコード API を呼ぶ前**（R3 §6 の検査時点）
5. **人間向け本文に `B65` / `Phase1` を出さない**
6. **エラー文が示す移行 SQL は、そのまま実行できる形**であること。
   **`GROUP BY CASE ... END` を案内しない**（parser が受理しない）。
   **集計の別名を物理フィールド名と衝突させない**（R3 §8.2 の禁止・B147 を踏む）
7. **公開型に必須プロパティを足さない**（BYO クライアントが壊れる）

## 3. テスト

**R3 §9 の受入をテストにする。** 既存の書き方に合わせること。

- **観測は公開結果**＝`SelectResult` / 送出される `ArgumentError` / **mock client の records API 呼び出し回数**
- **内部関数名を assert しない**
- **`src/__tests__/` に B148 のテストファイルを新設**し、既存テストの意味を変えない
- **既存テストを書き換える場合は「意味が変わるか」で線を引く**。
  意味が変わる書き換えが要るなら、**理由を報告書に書く**（勝手に通さない）

**`npm test` を通すこと。** ネットワークは要らない。
**環境変数に kintone の資格情報があるとテストが落ちる**ので、
`KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` / `KINTONE_PASSWORD` / `KSQL_API_TOKEN` を
unset してから実行すること。

**`npm run build` も通すこと**（プラグイン bundle に波及するため）。

## 4. 報告

**実装後、次を Markdown で報告してほしい**（ファイル書き込み不要・標準出力へ）。

1. **変更したファイルと、それぞれ何をしたか**
2. **3 層分離をどう実現したか**（R3 §3 の責務がどこに来たか）
3. **`npm test` の結果**（suites / tests の数、落ちたものがあれば内容）
4. **`npm run build` の結果**
5. **既存テストを書き換えたなら、その一覧と理由**
6. **R3 のうち実装しなかった部分と、その理由**
7. **R3 §16 のうち、あなたが確認できたもの / Claude の実測が要るもの**
8. **仕様の誤り・実装中に判明した前提の崩れ**（あれば。**黙って回避しないこと**）

**仕様どおりに書けない箇所があれば、勝手に解釈を変えずに報告で挙げること。**
**「動くようにする」より「仕様と実装の食い違いを可視化する」ことを優先する。**

上記に従って実装してください。
