# kSQL 共有最適化仕様（SELECT / UPDATE）

- 作成日: 2026-04-07
- 対象: JOIN を含む `SELECT` と `UPDATE` の共通最適化

## 1. 目的

`SELECT` と `UPDATE` で重複している「対象集合の抽出処理」を共通化し、以下を同時に満たす。

1. 実行速度向上
2. API 呼び出し回数削減
3. 実装の重複削減
4. 挙動の一貫性向上

## 2. 基本方針

1. 実行を `抽出` と `適用` に分離する
2. `抽出` は SELECT/UPDATE 共通で利用する
3. `適用` は SELECT と UPDATE で分離する

`抽出`:
- WHERE の kintone 化
- JOIN キー収集
- 半結合（2段階フェッチ）
- 必要列推定
- キャッシュ利用
- 件数メトリクス生成

`適用`:
- SELECT: 行投影して返却
- UPDATE: `$id` 集合に対して PUT 実行

## 3. 共通レイヤー仕様

## 3.1 QueryCandidatePlanner（新規）

入力:
1. AST（SELECT or UPDATE）
2. 実行オプション（maxRecords, fetchParallel 等）

出力:
1. `candidateRows`（結合前後の候補行）
2. `targetIds`（更新対象 `$id` 集合、UPDATE 時のみ）
3. `metrics`（scanRows, joinRows, filteredRows）

## 3.2 PredicatePushdown（既存拡張）

1. 単表で押し込める WHERE 条件は kintone query へ変換
2. 変換不能条件は後段 JS 評価へ残す
3. EXPLAIN で「kintone側 / JS側」を明示

## 3.3 JoinFetchStrategy（新規）

1. 片側から join key のみ先行取得
2. 相手側を `in (...)` 分割で取得
3. キー重複は `Set` で排除
4. `LIMIT` 到達見込み時は早期打ち切り
5. `IN` 最適化の上限を超える場合は全件取得へフォールバック
   - 1チャンクあたり: 50件
   - 最大チャンク数: 6
   - 適用上限キー数: 300件（超過時はフォールバック）

## 3.4 ProjectionMinimizer（既存拡張）

取得列は次の和集合:
1. JOIN キー列
2. WHERE 評価列
3. ORDER/GROUP/HAVING 評価列
4. SELECT 投影列（SELECT 時）
5. SET 参照列（UPDATE 算術式時）
6. `$id`（UPDATE 時）

## 3.5 FetchCache（新規）

キー:
`appId + query + fields + offset/limit`

方針:
1. 同一実行内のみ有効
2. メモリ上限を超えた場合は LRU 破棄

## 4. SELECT 適用仕様

1. 共通レイヤーの `candidateRows` を受け取る
2. 既存の project/order/limit を適用
3. 表示形式は現行仕様を維持

## 5. UPDATE 適用仕様

1. 共通レイヤーで `targetIds` を確定
2. `targetIds` で `dmlMaxRows` を判定
3. confirm（`--yes` なし時）を実行
4. PUT バッチ（100件単位）で更新

## 6. 安全ポリシー連携

1. `--allow-dml` 必須
2. `WHERE` なし UPDATE 拒否（既定）
3. `--dml-max-rows` 超過で拒否
4. 未知フィールドコードは実行前エラー

## 7. EXPLAIN 拡張

追加表示:
1. pushdownConditions
2. jsFilterConditions
3. scanRows / joinRows / filteredRows
4. targetIds（UPDATE 時）

## 8. 受け入れ条件

1. JOIN を含む SELECT で API 呼び出し数または総取得件数が現行比で改善
2. JOIN を含む UPDATE で対象 `$id` 抽出が共通レイヤー経由で動作
3. 既存 SELECT/UPDATE テストが回帰しない
4. 新規最適化ケースのテストを追加

## 9. 段階導入

Phase A:
1. 共通抽出レイヤーの骨組み導入
2. SELECT で先行適用

Phase B:
1. UPDATE に適用
2. 安全ガードと統合

Phase C:
1. EXPLAIN 拡張
2. メトリクスに基づく追加最適化

## 10. 非対象

1. トランザクション保証
2. 分散実行
3. 複雑なクエリプラン最適化（コストベース最適化）
