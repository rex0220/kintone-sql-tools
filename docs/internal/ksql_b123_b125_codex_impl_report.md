# B123 / B125 実装報告

## 結果

- B123: 完了
- B125: 完了（リポジトリ内で実施できる受入まで）。APP4228 と `ksql-analytics` を使う外部検算は未実施
- `npm test`: 成功
  - 通常スイート: 219 suites / 5,359 tests / 22 snapshots passed
  - CLI E2E: 2 suites / 26 tests passed
  - バージョン同期ガード: v3.44.0 の全 pin が同期済み
  - 呼出元シェルに設定されていた `KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` / `KINTONE_PASSWORD` が tokenMap の認証を上書きして CLI テスト 2 件を失敗させたため、最終実行ではこの `npm test` プロセスに限って当該 4 変数を解除した。恒久環境とリポジトリ設定は変更していない
- kSQL MCP ツールと git 操作は使用していない

## B123

### 変更ファイルと変更内容

- `src/core/explainMetadata.ts`
  - `selectNeedsOwnMetadata` に `statement.groupBy.length > 0` を追加した
  - 通常の `GROUP BY` がフォームメタデータを必要とすることを、MCP EXPLAIN と CLI dry-run が共有する述語へ反映した
- `src/core/__tests__/explainMetadata.test.ts`
  - 通常 GROUP BY、非集計 GROUP BY、HAVING、JOIN、CTE、サブクエリのメタデータ要否を追加した
- `src/__tests__/b123ExplainGroupByMetadata.test.ts`
  - EXPLAIN の実行経路で計画生成、フォーム取得、records/cursor API 非呼出しを固定した
- `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts`
  - 新しい `.groupBy` 参照を意図した AST 境界として allowlist に追加した。後続の B125 parser 追加による行番号移動にも追従した

### 追加したテスト

- 修正前に `explainNeedsAppMetadata` の B123 ケース 6 件が失敗することを確認してから実装した
- EXPLAIN の E2E では、各形で計画行が返ること、`getFields` が呼ばれること、`getRecords` / `openCursor` が呼ばれないことを確認した
- GROUP BY の無い `SELECT COUNT(*)` は `COUNT_TOTAL_COUNT` のままで、フォーム定義取得が増えないことを確認した

### 受入の確認結果（6 形）

1. `GROUP BY` のみ: 成功
2. 集計関数なしの `GROUP BY`: 成功
3. `HAVING` 付き: 成功
4. JOIN + `GROUP BY`: 成功
5. CTE / サブクエリ内の `GROUP BY`: 成功
6. CLI `--dry-run`: CLI と EXPLAIN が共有する `explainNeedsAppMetadata` の上記形を unit test で確認し、CLI を含む全 `npm test` が成功

全形でレコード API / Cursor API を呼ばず、フォーム定義の取得だけが増える契約を維持した。既存の GROUP BY なし、WHERE、ORDER BY、ROLLUP、GROUPING SETS の回帰も全スイートで成功した。

## B125

### 変更ファイルと変更内容

- `src/types/ast.ts`
  - 順位ウィンドウと集計ウィンドウの判別ユニオンを追加した
  - 既存公開型を壊さないため、順位側の `windowKind` は optional とし、判定を `isRankingWindow` に集約した
  - 集計関数、引数、`ROWS` / `RANGE`、既定 / 明示を保持する frame 型を追加した
- `src/parser/parser.ts`
  - `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` の `OVER (...)` を SELECT トップレベル単独列でのみ解析するようにした
  - `COUNT(*)`、PARTITION、ORDER、既定フレーム、明示 ROWS/RANGE を実装した
  - 非対象関数、引数 DISTINCT、不正フレーム、式内記述、HAVING / ORDER BY 直書き、alias 欠落の指定診断を追加した
- `src/engine/process.ts`
  - 通常集計の値抽出を `aggregateRowValues` へ切り出した。`COUNT(*)` は別分岐のまま維持した
  - null 除外を一度だけ行い、Number 化、例外、DISTINCT、集計の既存順序を維持した
  - 5 関数を増分 O(N) で評価し、ROWS、RANGE の peer 末尾書戻し、ORDER BY なしのパーティション全体を実装した
  - MIN/MAX は既存 canonical 比較を共有し、順位系の経路を分離した
- `src/converter/selectToKintone.ts`
  - 集計ウィンドウ引数の物理フィールドを取得対象へ追加した
- `src/core/dmlGuard.ts`, `src/execute.ts`
  - 完全入力 reason `AGGREGATE_WINDOW` を追加した
  - 集計ウィンドウの実行、ソートメタ、出力メタ、MIN/MAX の型・semantics、EXPLAIN の実効フレーム表示を実装した
- `docs/ksql_language_reference.md`
  - §10.1 に集計ウィンドウの構文、フレーム、制約、浮動小数、MIN/MAX raw 表記、例を追加した
- `docs/ksql_batch_recipes.md`
  - R14「累積残高（台帳）」を ROWS 明示とタイブレークキー付きで追加した
- `src/mcp/docsResourceBuilder.cjs`, `src/mcp/docsResources.ts`
  - `window-functions` を独立セクション化し、5 集計関数と R14 を catalog / hint に追加した

### 追加したテスト

- `src/parser/__tests__/window.test.ts`: AST、5 関数、COUNT(*)、既定・明示フレーム、全指定診断、SELECT DISTINCT
- `src/engine/__tests__/process.test.ts`: ROWS/RANGE、peer 末尾、明示 RANGE、全順序 RANGE、パーティション全体、COUNT、AVG、canonical MIN/MAX、桁差・相殺、複数集計ウィンドウ
- `src/converter/__tests__/selectToKintone.test.ts`: SELECT 投影に無い集計引数フィールドの取得
- `src/core/__tests__/b65CompleteInput.test.ts`: ORDER BY の有無にかかわらない `AGGREGATE_WINDOW`
- `src/__tests__/window.execute.test.ts`: 隠れた引数の取得、EXPLAIN、MIN の文字列メタ、一時テーブル、truncate fail-closed、SELECT DISTINCT、KORDER planner 拒否
- `src/mcp/__tests__/docsResources.test.ts`, `src/mcp/__tests__/docsTool.test.ts`, `src/mcp/__tests__/metadataTools.test.ts`: 独立 docs セクション、R14、catalog / budget

### R2 §8 の受入確認結果

- §8.1 一致条件
  - SUM、COUNT(*)、COUNT(field)、AVG、MIN、MAX のパーティション最終値 / 全体値を unit test で確認した
  - MIN/MAX は canonical 数値比較で桁違いの値を確認した
  - 小数および大きな正負値の相殺を含む SUM/AVG を相対精度相当 `toBeCloseTo(..., 12)` で確認した
- §8.2 フレーム意味論
  - 前残 60、同日 `+100, -30, -20` に対し ROWS=`160,130,110`、既定 RANGE=`110,110,110` を固定した
  - 明示 RANGE が既定 RANGE と同じで、EXPLAIN の `(既定)` の有無だけが違うことを確認した
  - `ORDER BY d, seq` の全順序 RANGE が行ごとに `160,130,110` となること、ORDER BY なしが全行パーティション合計となることを確認した
- §8.3 取得と完全入力
  - 集計引数を SELECT の通常列へ投影しない形でもフィールドを取得して正しく計算することを確認した
  - ORDER BY なしの truncate 上限到達が `AGGREGATE_WINDOW` で失敗する E2E を確認した
  - ORDER BY ありも complete-input reason に `AGGREGATE_WINDOW` を含むことを確認した
- §8.4 診断
  - §5.2 の非対応構文 6 形と §5.3 の式内記述を parser test で取得前に拒否することを確認した
  - KORDER 併用は parser を通り、records API 呼出し前に planner の `KORDER_QUERY_SHAPE_UNSUPPORTED` で止まることを確認した
- §8.5 外部検算
  - 未実施。APP4228 / `ksql-analytics/scripts/inv_v2_runstock.mjs` はこのリポジトリ内テストの範囲外であり、依頼どおり kSQL MCP を呼んでいない
- §8.6 回帰
  - B119〜B122 と統計集計を再実行し、9 suites / 80 tests が成功した
  - 順位 3 関数、SELECT DISTINCT + window、FULL_SCAN、GROUP BY / 通常集計との混在拒否、数値・選択肢ソートメタを含む全 `npm test` が成功した
  - 複数の集計ウィンドウ列を同一入力へ適用するケースを追加した

### 仕様と違えた箇所

- R2 §3.2 の表は「前日までの残高 60」に `+100 -30 -20` を加えた peer 末尾を **80** としているが、算術結果は **110** である。R2 本文の「同順グループ末尾を書き戻す」アルゴリズム、ROWS 最終値 110、§8.2 の先頭値誤実装検出を優先し、実装・テスト・公開言語リファレンスは RANGE=`110,110,110` とした。これは意味論の変更ではなく、R2 の数値例の算術誤記への訂正である

### 仕様が決まっていなかった箇所

- なし。上記の数値例は本文アルゴリズムから一意に決まるため、未決事項ではなく仕様内不整合として扱った

## 既存テストへの影響

- 意味論が変わって落ちた既存テスト: なし
- 形式変更のみで追従した既存テスト:
  - `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts`: B123 の意図した consumer 追加と parser 行番号移動
  - `src/mcp/__tests__/docsResources.test.ts`: language section 26→27、recipe 13→14、総 key 数の追従
  - `src/mcp/__tests__/docsTool.test.ts`: recipe hint の R14 追従
  - `src/mcp/__tests__/metadataTools.test.ts`: window catalog 5 関数追加分の formal budget 追従
- 認証環境変数を残した最初の `npm test` では `src/cli/__tests__/logicalExecution.test.ts` の tokenMap 認証 2 件だけが外部環境値の優先により失敗した。変数を当該プロセスで解除すると成功し、製品コード変更との因果はなかった
- 参考として `npx tsc --noEmit` は既存 UI の型エラー（`desktop.ts` の `dispatchEvent` / `HTMLElement.disabled` / `KintoneFieldValue.disabled`）で失敗した。B123/B125 の追加箇所に新規型エラーは出ていない。これは `npm test` の失敗ではない

## 未実施

- APP4228（1,000 件）を使う実機受入
- `ksql-analytics/scripts/inv_v2_runstock.mjs` との 8 製品の外部検算
- 実機確認は依頼書どおりレビュー側の範囲とし、kSQL MCP は呼んでいない

