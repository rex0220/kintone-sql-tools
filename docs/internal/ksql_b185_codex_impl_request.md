# B185 実装依頼（codex）

**`EXPLAIN` が SELECT 列（SELECT・GROUP BY・集計引数・CASE・関数引数・ORDER BY・ウィンドウ）の存在を検査せず、列名の誤りが `validate` と `explain` を通り抜けて実行で初めて `unknown field code(s)` になる非対称を直す。[起票文書](ksql_b185_explain_select_column_existence_issue.md) の案 A（EXPLAIN の preflight で実行側と同じ検査・同じ文言・純加法）で実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b188/dev`・B188・B186 コミット済みの HEAD）
上限: 1 PR・2 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文を新たに発明しない（実行時と**同じ文言** `ArgumentError: unknown field code(s): <列> (<source label>)` を使う）。**実行経路を変えない。EXPLAIN の既存出力行を変えない・新しい行を足さない**（プラグイン同梱エンジンの snapshot に波及するため）。**EXPLAIN が呼ぶ kintone API の回数を増やさない**（B123 `src/__tests__/b123ExplainGroupByMetadata.test.ts`・B163 `src/cli/__tests__/b162_b163_dry_run.e2e.test.ts`・B176 `src/__tests__/b176NativeUpsertExplain.test.ts`・B107 `src/engine-library/__tests__/b107LogicalApps.test.ts`・B67 `src/__tests__/b67RelativeDateSurfaces.test.ts`・`src/mcp/__tests__/tools.test.ts` が回数を固定している。B181 のレビューで、無条件のフォーム定義取得がこの 6 スイートを落とした実績がある）。

## 1. 決まっていること（レビュー対象外）

### 1.1 現象（実測 v3.77.0〜・Qiita「kSQL 実践」第 9 回 §4）

```sql
SELECT 商談フェーズ, COUNT(*) AS 件数, SUM(売上金額) AS 売上合計
FROM APP4149 WHERE 受注予定日 = THIS_YEAR() GROUP BY 商談フェーズ
```

- `ksql_validate`: ok（静的・想定どおり）／`ksql_explain`: **ok**・`fields: 商談フェーズ, 売上金額, 受注予定日`（存在しない列を取得列に載せる）／`ksql_query`: `ArgumentError: unknown field code(s): 売上金額 (APP4149)`
- WHERE 側の列は EXPLAIN で止まる（`WHERE_FIELD_UNRESOLVED`）。穴は SELECT・GROUP BY・集計引数・CASE・関数引数・ORDER BY・ウィンドウの PARTITION / ORDER BY

### 1.2 直し方（案 A）

- 実行側は `preflightB86QueryWithCte`（`src/execute.ts:5121-5140`）→ `validateB86SelectFieldCodes`（`5012-5119`）で、`collectSelectFieldReferencesBySource`（`src/converter/selectToKintone.ts:376`）が集めた参照を、物理はフォーム定義（`getFieldsCached`）、実体化表は `columns` と突き合わせている。EXPLAIN の relation preflight（`preflightExplainRelations` の SELECT 分岐・`execute.ts:12448-` 付近。`bindProjectedNamesForSelectWithSchemas` の直後）で**同じ関数を呼ぶ**のが最小。`cteCache` には `explainRelations`（`Map<string, MaterializedTable>`）をそのまま渡す。EXPLAIN relation は `rows: []` で `columns` が推定済みなので、`schemaUnavailable`（rows 0 かつ columns 0）の既存規則で「推定できなかった CTE は検査しない」になる
- **API 回数の制約への対処**: `validateB86SelectFieldCodes` は物理 APP ごとに `getFieldsCached` を呼ぶ。EXPLAIN が既にフォーム定義を取得している文（WHERE の型付き述語・ORDER BY の意味型・GROUP BY 計画など）ではキャッシュ命中で回数は増えない。**取得していない文**（例: `SELECT COUNT(*) FROM APP100`・B123 の対象）で回数が増えるので、次のどちらかにする（codex が両方の影響を測って選び、報告に理由を書く）:
  - (a) **キャッシュ命中時だけ検査**する: `getScopedCacheValue(fieldInfoCache, cacheContext, appId)` が既にあれば突き合わせ、無ければその APP は検査しない（追加 API 0・出力行不変。検査範囲は「EXPLAIN がフォーム定義を読む文」に限る。§24 にその旨を書く）
  - (b) 常に取得して検査する: 6 スイートの固定値を根拠つきで改定し、EXPLAIN の `metadata API: form definition` 行が増える snapshot も更新する。**プラグイン同梱エンジンの snapshot を変えるので、原則 (a)**。(b) を選ぶなら止めて報告
- 文言は実行時と同一（`validateB86SelectFieldCodes` をそのまま使えば自動的に同一）。EXPLAIN 出力には何も足さない（失敗は例外で返る＝WHERE_FIELD_UNRESOLVED と同じ形）
- フォーム定義が取れない（`defs.length === 0`・mock 互換の escape hatch）は従来どおり通す（`authoritative: false` の既存規則）

### 1.3 変えないこと

- 存在する列だけの SQL では EXPLAIN の出力行が 1 行も変わらない（既存 snapshot テスト通過）
- 実行結果・実行時の文言
- B86 の CTE / 一時テーブル検査の規則（B181 で完全一致に戻した `b86FieldExists`）

## 2. テスト（受入）

新規 `src/__tests__/b185ExplainSelectColumnExistence.test.ts` に少なくとも次を入れる（mock client。`getFields` が実フィールドを返すもの）:

- §1.1 の形（WHERE に型付き述語あり＝フォーム定義取得あり）で `EXPLAIN` が `ArgumentError: unknown field code(s): 売上金額 (APP…)` を投げ、同じ SQL の `execute` と**同じ文言**（対称）
- 位置の網羅（それぞれ 1 本。すべて EXPLAIN がフォーム定義を読む形で）: SELECT 列・別名付き列・集計引数・CASE の条件と結果・文字列関数の引数・GROUP BY・ORDER BY・ウィンドウの PARTITION BY / ORDER BY・JOIN の両側（alias 修飾）
- 存在する列だけの SQL では EXPLAIN の出力行が修正前と同一（既存 snapshot テストで担保。足りなければ 1 本）
- (a) を選んだ場合: `SELECT COUNT(*) FROM APP100` のように EXPLAIN がフォーム定義を読まない文では、存在しない列でも従来どおり通り、`getFields` の呼び出しが増えない（B123 と同じ計測）
- mock で `getFields` が `[]`（非 authoritative）なら従来どおり通る
- CTE の列は既存の B86 検査のまま（`WITH t AS (SELECT 売上 AS Amount FROM APP100) SELECT Missing FROM t` の EXPLAIN が `unknown field code(s): Missing (t)`＝B181 のテストと同じ文言）
- 6 スイート（§0）が変更なしで通ること。`npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §24「EXPLAIN」に「EXPLAIN は SELECT・GROUP BY・集計引数などの列名もフォーム定義と突き合わせ、無い列は実行時と同じ `unknown field code(s)` で失敗する（v3.79.0〜）。(a) の場合: 対象は EXPLAIN がフォーム定義を読む文（WHERE の型付き述語・ORDER BY・GROUP BY など）。フォーム定義を読まない文では従来どおり実行時に検出する」を追記。§22「制限事項」に該当項目があれば整合
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. (a)/(b) の選択と、EXPLAIN がフォーム定義を読む文型／読まない文型の一覧（どこで読んでいるか行番号つき）
2. `validateB86SelectFieldCodes` を EXPLAIN から呼んだときに、EXPLAIN relation（`rows: []`・`columns` 推定）で誤って落ちる形が無いか（UNION・サブクエリ・`GENERATE_SERIES`・`SHOW APPS` / `DESCRIBE` を CTE にした形・0 行の一時テーブル）
3. B186 で直した多表分岐との相互作用（未修飾名が CTE 列に解決できるときに B86 検査が物理側で「無い」と言わないこと）
4. MCP `ksql_explain`・CLI `--dry-run`・プラグインの EXPLAIN・`/flow` の `explain` で同じ結果になることの根拠

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 4 項目／Claude が実機（SFA パック・MCP v3.78.0 との比較・第 9 回 §4 の SQL）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
