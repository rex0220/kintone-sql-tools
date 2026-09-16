# B181 実装依頼（codex）

**SELECT 別名の小文字正規化と参照解決の非対称を直す。[起票文書](ksql_b181_alias_lowercase_reference_mismatch_issue.md) の案 A（参照解決を共通 helper に寄せる）を、[実装案の検討報告 §2](ksql_b181_b184_codex_plan_report.md) の第一案どおりに実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b181/dev`・B182 修正済みの HEAD）
上限: 1 PR・2 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
エラー本文・警告文を新たに発明しない。**公開契約（結果列名の小文字正規化・行キー・`warnings` の形・EXPLAIN の行）を変えない。** B182 で入れた `src/core/expressionSemantics.ts` の規則を変えない。B184 の範囲には手を出さない。

## 1. 決まっていること（レビュー対象外）

### 1.1 直すこと

- 別名は保存時に小文字化される（`src/parser/parser.ts:5056-5072`・`alias` と `display`）。参照側は完全一致なので、`AS 顧客No` / `AS Amount` / `AS ABC区分` を次の段や同じ文の `ORDER BY` から元の表記で参照すると解決できない
  - 実体化列の存在判定 `b86FieldExists`（`src/execute.ts:4804-4807`・CTE は `validCodes.has(field)`）
  - CTE・一時テーブルの列集合 `new Set(materialized.columns)`（`execute.ts:4886-4896`）と `unknown field code(s)` 診断（`4934-4953`）
  - 同一 SELECT の ORDER BY alias `evaluators.get(name)`（`src/engine/process.ts:1235-1245`・`1313-1315`）
  - canonical ORDER 計画 `semantics.get(item.key.name)`（`src/core/optimization/canonicalOrderPlanner.ts:50-58`）
- **結果列名は変えない**（小文字のまま。Dashboard の列設定・CSV・`/flow` の `columns` はそのまま）

### 1.2 直し方（案 A）

- 共通 helper `resolveProjectedName(requested, available)` を新規 `src/core/projectedNameResolution.ts` に置く。解決順は固定: **完全一致 → `requested.toLowerCase()` と実体化列・SELECT alias の正規名（小文字）との一致 → 不一致**
- 適用するのは次だけ:
  - 同一 SELECT の出力 alias（ORDER BY・HAVING の alias 参照）
  - CTE・一時テーブル・`SHOW APPS` / `DESCRIBE` の実体化列
  - UNION の左枝から決まる結果列
- **適用しないもの**: 物理 APP のフィールドコード、DML の対象列、JOIN 先の物理フィールド。`resolveFieldRef()` 自体を大文字小文字非依存にはしない（物理フィールドまで緩むため）
- 方式は「AST を実行直前に実体化スキーマへ束縛し、参照名を実在する小文字列名へ置換する」。EXPLAIN も同じ束縛を通す（EXPLAIN で解決できて実行で失敗する非対称を作らない）
- 大文字小文字だけ違う複数 alias は現状すでに同一出力名へ畳まれる（後勝ち）。helper で曖昧判定を足さず既存契約を維持する
- 波及先（すべて helper を通す）: SELECT のほか、CTE をソースにした `INSERT … SELECT` / `UPSERT … SELECT`、`UPDATE … FROM #t`、サブクエリ、UNION、`GROUP BY` / `JOIN` / required-field の実体化列解決。対象ファイルは `execute.ts`（`validateB86SelectFieldCodes`・materialized `columnMeta` resolver 群・GROUP BY / JOIN / required-field の実体化列解決）、`process.ts`（`buildOrderByAliasEvaluator`・ORDER BY の意味型 map 参照）、`canonicalOrderPlanner.ts`、`src/converter/selectToKintone.ts`（CTE 参照を物理取得列として扱わないことの回帰確認）

### 1.3 変えないこと

- `src/parser/__tests__/parser.test.ts:338-352` の小文字化契約はそのまま通す
- 案 B（validate / EXPLAIN の静的診断）は実装しない（案 A で解決するため）
- 既存テストで意図的に変えるものは無い想定。変えざるを得ないものがあれば「意味が変わるか」を報告に書き、意味が変わるなら止めて報告する

## 2. テスト（受入・等値比較だけの受入は不可）

新規（`src/engine/__tests__/orderByAlias.test.ts`・`src/__tests__/b86MaterializedUnknownColumn.test.ts` への追加、または `src/__tests__/b181AliasReference.test.ts`）に少なくとも次を入れる:

- 同一 SELECT: `SELECT 売上 AS Amount … ORDER BY Amount` と `ORDER BY amount` が同じ順序（値は `9/10`・`99/100`・`9050000/20700000` を ASC / DESC 両方向）。alias と同名の物理列がある場合も SELECT alias 優先を維持
- CTE: `WITH t AS (SELECT 売上 AS Amount …) SELECT Amount FROM t` と `SELECT amount FROM t` が同じ列名 `amount`・同じ行。`c.顧客No AS 顧客No` を `顧客No` / `顧客no` で参照。参照位置は SELECT 列・WHERE・CASE・集計引数・GROUP BY・HAVING・ウィンドウ ORDER BY・JOIN ON・サブクエリ・UNION
- 一時テーブル（バッチ）: `CREATE TEMP TABLE #t AS SELECT 売上 AS Amount …; SELECT Amount FROM #t`。0 行の一時テーブルでも同じ解決
- 本当に存在しない列は従来の `unknown field code(s)` のまま（文言不変）
- 物理 APP では `顧客No` と `顧客no` を別物として扱う負例（物理フィールドに緩和が及んでいないこと）
- CTE をソースにした `UPSERT … SELECT Amount FROM t` の `VALIDATE ONLY` と `UPDATE … FROM #t` のキー参照
- EXPLAIN が同じ SQL で失敗しない（実行と EXPLAIN の対称）
- 文書の助言をそのまま実行するテストを 1 本（言語リファレンス §1 に追記する例）
- `npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- `docs/ksql_language_reference.md` §1「大文字・小文字」に「別名の英字は結果列名で小文字に正規化される。次の段や `ORDER BY` から参照するときは元の表記でも小文字でも解決される（v3.7x〜）。物理フィールドコードは kintone の定義どおり区別する。物理フィールドと同名の別名を付けると列名が小文字化されるので、元の表記を出力名に残したいなら別名を付けない」を追記。§8 付近「名前の解決順」に相互参照
- 文書の SQL 例は §2 のテストで通したものだけ
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. helper を通した場所の一覧と、通していない場所（理由つき）。特に `UNION`・サブクエリ・`UPDATE … FROM`・`IMPORT … SELECT` の各経路
2. 物理フィールドに緩和が及ばないことの根拠（テスト名）
3. EXPLAIN と実行の対称（同じ束縛を通しているか）
4. B183 の文言（「別名に英字を使わない」を弱める案）に関係する挙動の要点（実装はしない）
5. `/flow`・MCP・CLI・プラグインで結果の形（`columns`・行キー・`warnings`）が変わらないことの根拠

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／修正箇所 ↔ 根拠行の対応表／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 5 項目／Claude が実機（SFA パック・MCP v3.77.0 との比較）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
