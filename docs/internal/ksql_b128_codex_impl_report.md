# B128 Phase 2a `LAG` / `LEAD` codex 実装報告（2026-08-06）

## 結果

**完了。** R2 の対象である `LAG(expr [, offset])` / `LEAD(expr [, offset])` を実装した。

- `npm test`: 成功
  - Jest: **228 suites / 5,462 tests passed**、22 snapshots passed
  - CLI E2E: **2 suites / 26 tests passed**
  - `version:check` / `docs:check` も成功（リンク 3,227 件、台帳 9 行）
- `npm run build`: 成功
  - plugin / CLI / MCP / MCPB / engine をすべて再生成
- フル回帰後の追加受入テスト: parser 43件、window execution 36件が成功
- kSQL MCP・実機確認: 依頼書の運用制約に従い未実施

最初の `npm test` では B65 の「`.groupBy` 直接参照位置」allowlist だけが、追加コードによる行番号移動で 1 件失敗した。実在行番号へ形式追従した後、全件成功した。

## 変更ファイルと内容

### 実装

- `src/types/ast.ts`
  - `ValueWindowColumn` / `ValueWindowFunc` と `windowKind: "VALUE"` を追加
  - ranking / aggregate / value の positive discriminator を追加
- `src/parser/parser.ts`
  - soft keyword の `LAG` / `LEAD` parser を追加
  - 値式とトップレベル offset を comma-aware に分離
  - offset の非負 safe integer 検証、第3引数拒否、`ORDER BY` 必須、`AS alias` 必須を実装
  - B129 scanner と VALUE parser 後続演算子の両方で nested window を診断
- `src/engine/process.ts`
  - `applyWindow` を ranking / aggregate / value の3分岐にし、未知 kind を fail-closed
  - `evaluateValueWindowArg` / `applyValueWindow` を集計窓の隣に追加
  - 引数はソート後の各行で1回だけ評価し、`aggregateRowValues()` は不使用
  - VALUE 出力の ORDER semantics を引数から継承
- `src/converter/selectToKintone.ts`
  - VALUE 引数も required-field walker の対象に追加
- `src/execute.ts`
  - scalar subquery、alias semantics、出力メタ、source metadata load gate、CTE・一時テーブル伝播を VALUE 対応
  - B127 の全順序判定を純粋 helper `canProveTotalWindowOrder` へ抽出し、VALUE 警告でも共有
  - VALUE の EXPLAIN 表示を追加
  - 警告を付けた `SelectResult` でも内部列メタの関連付けを保持するよう修正

### テスト

- `src/parser/__tests__/window.test.ts`
  - AST、CASE 内カンマ、offset/default 拒否、B129 3形、soft keyword、3種 window 混在、GROUP BY/集計拒否
- `src/__tests__/window.execute.test.ts`
  - 境界、offset 0/2/999、partition、空セル、required-field、数値/日付/文字列/選択肢メタ、MIN/MAX、完全入力理由、警告、CASE、soft keyword、混在/DISTINCT
- `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts`
  - 行番号だけを形式追従（既存の意味・期待件数は変更なし）

### 文書・生成物

- `docs/ksql_language_reference.md`: §10.1 に構文・意味論・3段の前月比例を追加
- `docs/ksql_batch_recipes.md`: R16「前月比を出す」を追加
- `src/mcp/docsResourceBuilder.cjs` と MCP 文書テスト: recipe count / key を 16 へ同期
- `CHANGELOG.md`: リリース済み v3.50.0 の前に `Unreleased` 節を追加
- `npm run build` により plugin / CLI / MCP / MCPB / engine の配布物を再生成

## R2 §4 受入結果

### §4.1 値

**確認済み。** `LAG` 先頭、`LEAD` 末尾、offset 0/2/999、partition 境界、参照先空セルを出力で固定した。負数・小数・変数・式・第3引数は ParseError。`LAG(CASE ... END, 2)` は parser と実行の両方で確認した。

### §4.2 型

**確認済み。** `LAG(NUMBER)` の次段 `ORDER BY` が数値順になり、次段 `MIN` / `MAX` も数値比較になることを出力で固定した。direct APP の `LAG(DROP_DOWN)` は次段で選択肢定義順になる。`LAG(DATE)` / `LAG(SINGLE_LINE_TEXT)` も次段 `ORDER BY` の出力で固定した。

### §4.3 収集漏れ

**確認済み。** `x` を LAG 引数だけに書いた SQL で API 取得 fields に `x` が含まれ、後続行が実値を返すことを固定した。

### §4.4 B129

**確認済み。** 関数で包む、算術へ混ぜる、CASE 条件へ入れる3形が、いずれも `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` の全文で失敗する。

### §4.5 併存・回帰

**確認済み。** ranking / aggregate / value を別々の `ORDER BY` で同一SELECTへ置く実行、`SELECT DISTINCT` 後段適用、GROUP BY/集計拒否、`WINDOW_ORDER` 完全入力理由、`LAG` / `LEAD` 同名フィールド参照を固定した。

### §4.6 実機

**未実施。** 依頼書の「kSQL MCP を叩かないこと」に従った。APP4228 の3段SQLと前月比の独立検算はレビュー側で行う。

## 仕様と違えた箇所

なし。

## 仕様が決まっていなかった箇所

R2 §6 の3件は次のように実装した。

1. VALUE window の全順序警告は**出す**。B127 と同じ証明基準を共有し、direct single APP で `$id` / `RECORD_NUMBER` を含むときだけ抑止する。JOIN / CTE / subtable 等では証明せず警告する。
2. `applyValueWindow` は `process.ts` の `applyAggregateWindow` 隣に置いた。
3. `LAG` / `LEAD` は lexer token を増やさず、`IDENT(LAG|LEAD) + LPAREN ... RPAREN + OVER` の lookahead で soft keyword とした。

## 既存テストへの影響 / 未実施

- 既存テストの意味論・期待値は変更していない。
- 形式追従として `b65GroupByConsumerAllowlist.test.ts` の3行番号だけを更新した。
- 実機、kSQL MCP、ブラウザ smoke は未実施。
- git 操作禁止を依頼書で読む前の初回確認に `git status --short` を含めてしまった。読み取りだけで変更はしておらず、以後は git 操作を一切行っていない。
