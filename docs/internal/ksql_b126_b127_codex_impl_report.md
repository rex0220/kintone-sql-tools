# B126 / B127 codex 実装報告

- 実施日: 2026-08-05
- 対象: v3.46.0
- 結果: **完了**
- 正本仕様: `docs/internal/ksql_b126_b127_warnings_phase1_spec.md` R4

## テスト結果

- 失敗先行テストを追加し、実装前に次を確認した。
  - B126: `normalizeChoiceEquality` が未実装のためコンパイル失敗
  - B127: 既定 `RANGE` 警告が空、`UNION` では `warnings` 自体が未運搬
- 最終 `npm test -- --runInBand`: **成功**
  - Test Suites: **226 passed / 226 total**
  - Tests: **5,438 passed / 5,438 total**
  - Snapshots: **22 passed / 22 total**
  - `KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` / `KINTONE_PASSWORD` はテストプロセス内だけ解除した。
- kSQL MCP ツールは呼んでいない。
- git 操作は行っていない。

## 変更ファイルと変更内容

### 実装

- `src/core/optimization/whereCapability.ts`
  - 純粋 API `normalizeChoiceEquality(where, resolveField)` を追加した。
  - 各 `BINARY` leaf を独立に走査し、R4 §2.1 の条件を満たす `=` / `!=` / `<>` だけを singleton `IN_LIST` の `IN` / `NOT_IN` AST へ変換する。
  - `optionOrder` に実在する非空値、`LOCAL_SCALAR_TYPES`、native `in` 対応、選択系 semantics をすべて要求する fail-closed 実装とした。
  - `classifyWhereCapability` 自体には正規化処理を入れていない。

- `src/execute.ts`
  - schema resolver 構築後に同じ正規化 API を適用し、capability、converter、JOIN planner、COUNT、KORDER、ローカル再評価、相対日付の事前計画、EXPLAIN が同じ正規化済み `stmt.where` を使うようにした。
  - STATUS の `optionOrder` は process status metadata が必要なため、非空文字列との `=` / `!=` / `<>` 候補でのみ status metadata を解決する。
  - EXPLAIN に `pushdown normalized:` 行を追加した。
  - B127 の既定 `RANGE` 警告を追加した。単一物理アプリ・JOIN なし・サブテーブルなし・CTE/UNION 経由なしで、`$id` または `RECORD_NUMBER` 型がウィンドウ `ORDER BY` に含まれる場合だけ抑止する。
  - `UNION` と実体化 CTE の子 `SELECT` の warnings を親結果へ集約するようにした。
  - 公開型への必須プロパティ追加はない。

### 追加テスト

- `src/core/optimization/__tests__/choiceEqualityNormalization.test.ts`
  - `=` / `!=` / `<>`、存在しない値、空文字、`optionOrder` 不明、複数値型、通常文字列、AND leaf 単位を検証した。

- `src/__tests__/b126ChoiceEqualityNormalization.test.ts`
  - 実行結果、REST query、未選択行、COUNT totalCount、STATUS metadata、EXPLAIN の IN/NOT IN 同一計画、JOIN、KORDER、UNSUPPORTED 回帰を検証した。

- `src/__tests__/window.execute.test.ts`
  - B127 の単一表警告、全順序抑止、JOIN / サブテーブル / CTE / UNION での非抑止、明示 ROWS/RANGE、ORDER BY なし、順位系を検証した。

### 既存テストの追従

- `src/__tests__/b94CountTotalCount.test.ts`
  - 旧仕様を固定していた「実在する DROP_DOWN の `=` は residual」を、B126 の最重要回帰である「存在しない選択肢の `=` は residual・0 件」へ変更した。
  - 実在値の COUNT totalCount 化は新規 B126 テストで固定した。
- `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts`
  - `src/execute.ts` への実装追加でずれた既存 `.groupBy` 参照の行番号だけを更新した。参照箇所と意味論は不変。

## R4 §4 受入結果

### §4.1 B126

| 項目 | 結果 |
|---|---|
| `= '存在しない値'` | **PASS**。正規化せず、REST query に値を出さず、0 行・正常終了 |
| 実在値の `=` | **PASS**。singleton `IN` と同じ REST query、行数・値を確認 |
| `IN` と EXPLAIN 計画一致 | **PASS**。正規化表示行を除く全 plan 行が一致 |
| `!=` / `NOT IN` | **PASS**。同じ計画・REST query |
| 未選択行を含む `!=` | **PASS**。未選択行を結果に含めることを確認 |
| `= ''` | **PASS**。正規化せずローカル評価 |
| AND の leaf 単位 | **PASS**。選択系 leaf だけ `IN` 化 |
| USER_SELECT | **PASS**。正規化なし |
| CHECK_BOX | **PASS**。従来どおり `WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE` |
| SINGLE_LINE_TEXT | **PASS**。正規化対象外。既存 native `=` 経路は全テスト成功 |
| `optionOrder` 不明 | **PASS**。純粋 API テストで正規化なし |
| JOIN | **PASS**。EXPLAIN が利用者記述 `IN` と一致 |
| COUNT(*) | **PASS**。`COUNT_TOTAL_COUNT` 相当の totalCount 経路を使用 |
| KORDER | **PASS**。EXPLAIN が利用者記述 `IN` と一致 |

### §4.2 B127

| 項目 | 結果 |
|---|---|
| 単一表、既定 RANGE | **PASS**。alias 入り警告 1 行 |
| 日付 + `$id` / RECORD_NUMBER | **PASS**。単一物理表では警告なし |
| JOIN | **PASS**。全順序に見えても警告あり |
| サブテーブル | **PASS**。警告あり |
| CTE | **PASS**。警告あり、親へ運搬 |
| UNION | **PASS**。警告あり、親へ運搬 |
| 明示 ROWS / RANGE | **PASS**。警告なし |
| ORDER BY なし | **PASS**。警告なし |
| 順位系 | **PASS**。警告なし |

### §4.3 非変更性

- 行数・各行の値・列名と順序: B126 の `=` / `!=` 実行テストと全回帰テストで確認した。
- EXPLAIN: 正規化対象は利用者が `IN` / `NOT IN` と書いた計画と一致し、追加差分は仕様どおり `pushdown normalized:` 行だけ。
- 既存警告（取得打ち切り・検索中断）: 既存テストを含む全 `npm test` 成功。
- `ksql_validate`: 実装経路を変更しておらず、existing record validation / MCP / CLI を含む全回帰テスト成功。

## 仕様と違えた箇所・仕様内の矛盾

- 実装上の仕様逸脱はない。
- R4 §1 の非対象表に「`!=` → `not in`」が残っているが、R4 冒頭の訂正、§2.1、§2.5、§4.1、および実装依頼書はすべて `!=` を対象としている。後者を優先し、`!=`（同義の `<>` を含む）を実装した。
- EXPLAIN の「IN/NOT IN と完全一致」と §2.6 の正規化表示は同時には byte-for-byte 一致しないため、受入テストでは `pushdown normalized:` 行だけを除外して残りの全 plan 行が一致することを固定した。

## R4 §6 の未確定事項に対する判断

1. B127 の JOIN / サブテーブル / CTE・UNION 判定元
   - `SelectStatement` の `joins`、`from.subtableCode`、`from.cteName` と、実行呼出しに渡す内部 `DIRECT` / `DERIVED` context から判定した。
   - 証明できない `DERIVED` は警告側へ倒した。
2. UNION / 実体化 CTE の警告集約
   - 子結果の `warnings` を親 `SelectResult` へ、初出順を保つ `Set` で集約した。
3. `pushdown normalized` 複数件の順序と escaping
   - WHERE AST の左から右への深さ優先順とした。
   - 元 SQL 側は単一引用符を二重化し、kintone query 側はバックスラッシュと二重引用符を escape する。
4. `IN ('')`
   - R4 の判断を維持し、`optionOrder` に空文字が存在しても正規化しない。

## 未実施

- 実機 kintone に対する確認は未実施。運用制約に従い kSQL MCP は呼んでいない。
- ブラウザ実機 smoke は今回の依頼範囲に無いため未実施。
