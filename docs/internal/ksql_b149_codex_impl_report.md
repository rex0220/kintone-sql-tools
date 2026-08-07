# B149 実装報告（codex）

## 1. 変更・追加ファイル

- `src/types/ast.ts` — 生成系列 CTE の AST と optional 変数由来情報を追加
- `src/parser/parser.ts` — CTE 内構文、引数、alias、配置違反診断を実装
- `src/core/generateSeries.ts` — 整数・DATE 系列、事前件数計算、上限・型検証を実装
- `src/core/statementValidation.ts` — AST-only 静的検証へ系列検証を統合
- `src/core/dmlGuard.ts` — 生成 CTE の read-only・完全入力判定を統合
- `src/execute.ts` — 実体化、列メタ、警告抑止、EXPLAIN、API 0回経路を実装
- `src/__tests__/b149GenerateSeries.test.ts` — R2 §12 の受入テスト45件を追加
- `src/mcp/schemas.ts` — validate/query/explain/save schema 説明を同期
- `src/mcp/index.ts` — MCP tool description を同期
- `src/mcp/statementSyntaxCatalog.ts` — WITH 構文カタログへ追加
- `docs/ksql_language_reference.md` — 構文・制約・0埋め例・警告・保存クエリ契約を追記
- `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts` — parser 行番号 allowlist を機械的更新

## 2. 受入条件 ↔ テスト対応表

| 受入条件 | 対応テスト |
|---|---|
| §12.2 A1 | `A1: 既定 step、stop 包含、公開結果、API 0回` |
| A2〜A5、A7 | `%s: 整数境界` |
| A6 | `A6: start=stop は step の正負それぞれ1行` |
| §12.3 4象限 | `§12.3 方向の4象限`（4ケース） |
| §12.4 D1〜D6 | `%s: DATE 境界` |
| D7 | `D7: TODAY() の具体日付を DATE 終端に使う` |
| §12.5 M1〜M3 | `M1-M3: 既定列名、整数/DATE メタとソート` |
| M4〜M6 | `%s: 直接生成 CTE の警告抑止とメタ`。新しい生成 CTE 直接参照経路を drive し、`warnings=[]` と列メタを確認 |
| M7・M8 | `M7/M8: JOIN 後は既存警告全文を維持`。既存警告文を全文一致 |
| §12.6 C1〜C3 | `C1-C3: 後続 CTE、UNION、サブクエリ` |
| §12.7 | `§12.7 LEFT JOIN 0埋めと records API 1回` |
| §12.8 | `§12.8 一時テーブルは DATE メタを維持し API 0回` |
| §12.9 | `§12.9 公開エラー`（9ケース）および `FROM 直置きは修正例付き ParseError` |
| §12.10 X1〜X6 | `X1-X6: 上限と adversarial` |
| X7・X8 | `X7/X8: 変数解決後の空文字と上限` |
| §12.11 | `§12.11 EXPLAIN は系列計画を表示し全 API 0回` |
| §12.12 | `ksql_validate はリテラル違反を静的拒否し API を作らない`、`変数依存を保留` |
| §12.13 | `read-only 保存クエリを query 経路で実行し書込 API 0回` |
| §12.14 | `WITH/SHOW/DESCRIBE と識別子の回帰`＋全体テスト |
| §14 文書同期 | `言語リファレンスから生成する ksql_docs と MCP schema が同期する` |

## 3. `npm test`

認証環境変数をテストプロセス内だけ隔離して実行し、成功しました。

- version guard: pass
- docs check: pass（リンク3,453件／台帳10行）
- Jest: 238 suites passed
- Tests: 5,606 passed
- Snapshots: 22 passed
- Fail: 0
- 終了コード: 0

Jest worker の強制終了警告は1件出ましたが、全テストは成功しています。

## 4. 既存テストへの変更

- `b65GroupByConsumerAllowlist.test.ts`: parser への構文追加で移動した参照行を `788 → 796` に機械的更新
- 既存テストの期待挙動、成功値、警告・エラー契約の変更なし

## 5. 仕様との差分・発見事項

- R2 との差分なし
- CLI には独立した SQL schema/description がないため、共通言語リファレンスと `ksql_docs` を同期。README・CLI help は禁止事項に従い未変更
- 初回全体テストではホストの `KSQL_USERNAME` / `KSQL_PASSWORD` が論理アプリのtoken試験へ干渉。テストプロセス内だけ除外すると該当11件および全体が成功
- version、README、CHANGELOG、manifest、配布物は変更していません

## 6. Claude の実測が必要な項目

- CLI、実MCP、ライブラリ、Firefox、Chrome間の公開結果一致
- 実kintone APPを使った日付0埋め、JOIN後メタ、API呼び出し実測
- Firefox／Chromeプラグイン smoke
- 一時テーブル経由 `INSERT ... SELECT` の確認・書込上限・キャンセル契約
- 外部注入変数、DATE境界、複数生成 CTEを含む実surfaceの EXPLAIN
- 保存クエリの実サーバー運用と書込承認不要の確認



---

# 修正 1 報告（最終チェック指摘 2 件）

修正報告

- 変更ファイル:
  - `src/core/generateSeries.ts`
  - `src/__tests__/b149GenerateSeries.test.ts`
- 数値リテラルを `parseExactDecimal` で丸め前に解析し、正確な整数かつ安全整数範囲内の場合のみ受理するよう修正。
- `HH:mm` / `HH:mm:ss` をDATE判定前にTIMEとして分類し、所定の公開診断を返すよう修正。
- 指定4ケースの公開メッセージ全文固定テストと、指数表記許可例 `1e2 / 5e2` の回帰テストを追加。
- 修正前確認: 指定4件すべて失敗（数値3件は未拒否、TIMEは誤ったDATE診断）。
- 修正後対象テスト: 50件すべて成功。
- 全体テストランナー: 238 suites、5,611 tests、22 snapshots、すべて成功。
- `npm test`: 既存の `docs/internal/ksql_b149_codex_final_check_report.md` の行番号付きリンク切れ5件により、`docs:check` で停止。指定に従い文書は変更していません。
- 仕様との差分: なし。