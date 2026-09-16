# B186 実装依頼（codex）

**物理 APP と CTE を混在させた JOIN の WHERE に未修飾の CTE 列を書くと `EXPLAIN` だけが `WHERE_FIELD_UNRESOLVED` で落ちる（実行は通る）非対称を直す。[起票文書](ksql_b186_explain_mixed_join_unqualified_cte_column_issue.md) の案 A（EXPLAIN の解決規則を実行時に揃える・EXPLAIN 面のみ・実行不変）で実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b188/dev`・B188 コミット済みの HEAD）
上限: 1 PR・1.5 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文・警告文を新たに発明しない。**実行経路（`executeSelect` / `executeQueryWithCte` / 取得列の決定）を変えない。** 既存の EXPLAIN snapshot（プラグイン同梱エンジンを含む）の行を変えない（今回通るようになる SQL の行が増えるのは可）。B185（SELECT 列の存在検査）の範囲には手を出さない。

## 1. 決まっていること（レビュー対象外）

### 1.1 現象と再現（実測 v3.78.0・CLI 再ビルド版・dev profile）

```sql
WITH s AS (SELECT 顧客No_ AS custno, SUM(売上) AS amount FROM APP4149 GROUP BY 顧客No_)
SELECT c.会社名, amount FROM APP4148 AS c INNER JOIN s ON c.顧客No = s.custno
WHERE amount > 10000000 ORDER BY amount DESC LIMIT 3
```

- 実行: 成功（3 行）。`EXPLAIN`（CLI `--dry-run`・MCP `ksql_explain`）: `ArgumentError: WHERE predicate is unsupported (field=amount, operator=>, reason=WHERE_FIELD_UNRESOLVED).`
- 集計の無い CTE（`SELECT 顧客No_ AS custno, 売上 AS amount FROM APP4149`）でも同じ → 列名の推定の問題ではない
- WHERE を `s.amount > …` に修飾すると `EXPLAIN` も通る。WHERE を外すと通る
- 同じ SQL の `EXPLAIN` は `[main]` の `fields:` 行に `会社名, amount, 顧客No, custno` と、**未修飾の CTE 列を物理 FROM（APP4148）の取得列として並べる**（実行は通っているので、実行側の取得列決定はこれと違う）

### 1.2 直接原因の当たり（Claude のソース確認。codex が確定させる）

- `buildWhereFieldSemanticsResolver`（`src/execute.ts:3506-3581`）の**多表**分岐（`3571-3580`）は、CTE 側を `resolveMaterializedColumnMeta(materializedTables?.get(table.cteName), field.field)?.semantics` で引く。実行時の実体化表には `columnMeta` があるので解決するが、**EXPLAIN の `explainRelations` は `{ rows: [], columns }` だけで `columnMeta` が無い**ため undefined → 一致 0 件 → `classifyLocalOnlyField`（`src/core/optimization/whereCapability.ts:502-508`）が `WHERE_FIELD_UNRESOLVED`
- 同じ関数の修飾あり分岐（`3559`）と単表分岐（`3566`）は `?? syntheticSemantics("string")` で `columnMeta` が無くても解決している。多表分岐だけフォールバックが無い
- 取得列の `fields:` 行に CTE 列が混ざるのは `collectRequiredFieldsByTable`（`src/converter/selectToKintone.ts:393-`）の非 sourceAware モードが未修飾名を `firstTargetTable` に足すため（`533-535`）。実行側は sourceAware で `unqualified` に分けている。EXPLAIN の表示だけの問題か、EXPLAIN が実行と別の経路で取得列を組んでいるかを確認する

### 1.3 直し方（案 A）

- 多表分岐で CTE 側を引くときは「列が存在する（`resolveMaterializedColumn` が定義される）なら、`columnMeta` が無くても `syntheticSemantics("string")` で解決」に揃える（`3559` / `3566` と同じ規則。`5629-5630` にも同じ形がある）。**未修飾名が物理フィールドと CTE 列の両方に一致する場合は従来どおり多重一致の扱い**（B181 のテスト `mixedClient` の `Amount` は物理が勝つ。実行時の規則と同じ）
- 解決できた CTE 列の述語は、既存の「実体化 source の述語は押し下げない」扱い（`join pushdown not applied: SOURCE_KIND` / JOIN 後にローカル評価）で計画に出す。新しい行を発明しない
- `fields:` 行に未修飾の CTE 列が混ざる件は、実行側と同じ振り分け（CTE 列は物理の取得列に載せない）にできるなら直す。EXPLAIN の他の snapshot が変わる場合は止めて報告（B185 と一緒に扱う判断を Claude がする）

### 1.4 変えないこと

- 実行結果・実行時の取得列・警告
- 本当に存在しない列は従来どおり `WHERE_FIELD_UNRESOLVED`
- 既存テスト `src/__tests__/execute.test.ts:3890` / `:4036` の `WHERE_FIELD_UNRESOLVED` 期待はそのまま通す

## 2. テスト（受入）

新規 `src/__tests__/b186ExplainMixedJoinCteColumn.test.ts` に少なくとも次を入れる（`b181AliasReference.test.ts` の `mixedClient` を流用してよい）:

- §1.1 の形（集計 CTE × 物理 JOIN・未修飾 WHERE）で `EXPLAIN` が成功し、`[main]` の行が「WHERE を `s.amount` に修飾した形」の行と同じ（差分なし）
- 集計の無い CTE でも同じ
- 未修飾名が物理と CTE の両方にある形（`mixedClient` の `Amount`）は物理側で解析される（実行と同じ）。EXPLAIN が通り、`fields:` に物理 `Amount` が載る
- 本当に存在しない列 `WHERE missing > 1` は従来どおり `WHERE_FIELD_UNRESOLVED`
- EXPLAIN と実行の対称: 同じ SQL を `execute` で実行して行が返る（既存の B181 テストの形）
- `src/__tests__/b181AliasReference.test.ts:229` 付近のコメント（「混在 JOIN の WHERE …は EXPLAIN が落ちる」）を、直った後の挙動に合わせて EXPLAIN に WHERE を戻す
- `npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §24「EXPLAIN」に「実体化 CTE / 一時テーブルの列を未修飾で WHERE に使った場合も EXPLAIN は実行と同じ解決規則で計画を出す（v3.79.0〜。以前は `WHERE_FIELD_UNRESOLVED` になった）」を 1〜2 文で追記
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. §1.2 の当たりが合っているか（違えば実際の原因と行番号）
2. `fields:` 行に CTE 列が混ざる件の扱い（直したか、snapshot に波及するので止めたか。止めた場合は影響する snapshot テスト名）
3. `buildWhereFieldSemanticsResolver` 以外に、EXPLAIN が `explainRelations`（`columnMeta` なし）を実行時の実体化表と同じ前提で引いている箇所があるか（`resolveMaterializedColumnMeta` の呼び出し元を一覧して、EXPLAIN 経路で undefined になり得るものに印）
4. MCP `ksql_explain`・CLI `--dry-run`・プラグインの EXPLAIN で同じ結果になることの根拠

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 4 項目／Claude が実機（SFA パック・MCP v3.78.0 との比較）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
