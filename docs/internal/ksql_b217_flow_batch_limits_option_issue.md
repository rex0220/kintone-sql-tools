# B217 バッチの文の数（20）と一時テーブルの数（16）の上限を、公式 API `/flow` のオプションにする

- 起票: 2026-11-11（**kSQL アクションの依頼 KJ-13**。事例「受注の CSV を取り込む」が 21 文で上限に当たった）
- ステータス: 🚧 **実装済み（PR #425・リリース待ち）**。**B214 / B215 / B218 と同じ v3.96.0**（2026-11-11 Takashi「1 b / 2 v3.96.0 / 3 OK」）
- 種別: 機能（既定は変わらない）
- 関連: 設計メモ `ksql_b168_flow_dialect1_plan.md` の **Q8**（「20 のまま始め、実ジョブが 20 文を超えた例が出たら裁定」。この依頼がその例）／[B218](ksql_b218_validate_script_batch_analysis_issue.md)（同じ版）／B196（`tempTablesMaxTotalRows`）
- 依頼と回答: `kintone-plugin/work-link/kSQLエンジンへの依頼-20261111-KJ13-文の数と一時テーブルの数の上限.md`・同じ日付の `kSQLエンジンからの回答-…`

## 1. 背景

- 文の数は解析器（`MAX_BATCH_STATEMENTS = 20`）、一時テーブルの数は `analyzeBatch`（`MAX_TEMP_TABLES = 16`。同時に残っている数。
  `DROP TEMP TABLE` で減るが、DROP も 1 文）が数える。
- kSQL アクションは「仮置き → 検査 → 登録」を 1 回で行うため、検査を 1 つ足すとどちらかに当たる（今は 19 文・15 個）。
  SQL は設定する人が書いて保存するもので、メモリは合計の行数（`tempTablesMaxTotalRows`）で抑えている。
- 一方、MCP・CLI は既定で合計の上限が無く、16 個 × 1 個 10,000 行がメモリの事実上の上限。**既定は据え置く**。
- 既定ごと上げると ksql-flow の試験（20 文ちょうど成功・21 文は失敗）が壊れ、Dashboard Pro・kjob にも効く。

## 2. 入れたもの

- `src/core/batchLimits.ts`（新規。何も取り込まない）: 既定 20 / 16、天井 100 / 64、`resolveBatchLimits`（範囲外は `RangeError`）。
- 解析器: `ParserCapabilities.maxStatements`（既定 20。誤りの文は効いている数）。`parser.ts` の行の数は変えていない（行番号を固定した試験のため）。
- `analyzeBatch(statements, { maxTempTables })`（既定 16）。
- `/flow` の `ParseScriptOptions` に `maxBatchStatements` / `maxTempTables`（4 つの入口が引き継ぐ）:
  - `parseScript`: 文の数。
  - `validateScript`: 文の数と、B218 のバッチの検査で一時テーブルの数。
  - `explainScript`: 文の数と一時テーブルの数（`buildBatchExplainPlans` の新しい最後の引数）。
  - `createExecutionContext`: script を渡す形は解析で文の数、**statements を渡す形でも文の数を確かめる**（渡し忘れの食い違いを
    レコードを読む前に `batch exceeds 20 statements.`〈KSQL1202〉で止める）。一時テーブルの数は `createManagedStatementExecutionContext` の
    新しい最後の引数で `analyzeBatch` へ。**`maxTempTables` が 16 より大きいのに `tempTablesMaxTotalRows` が無ければ `ArgumentError`**。
- CLI・MCP・engine ライブラリ（`executeBatch` など）は何も変えていない（オプションを受けない）。

## 3. 受入条件と試験

`src/flow-library/__tests__/b217BatchLimits.test.ts`（20 件。B218 の 3 件を含む）:

1. 既定: 20 文・16 個はどの入口も通る、21 文は解析で止まる、17 個は検査・実行計画・実行の入口で止まりレコードを読まない。
2. 50 / 30 を渡す: 50 文・30 個がどの入口も通って最後まで流れる（statements の形も script の形も）、51 文・31 個は効いている数で止まる。
3. 16 より多いのに合計の上限が無ければ止まる（レコードを読まない）、16 ちょうどなら要らない。
4. 解析は 50 で実行の入口に渡し忘れたら、解析と同じ文で止まる（レコードを読まない）。
5. 範囲外（0・101・1.5・65・NaN）は `RangeError`、天井ちょうど（100 / 64）は受ける。

直す前の本体では 20 件中 16 件が落ちる（型の検査を外して確かめた）。全体: 337 スイート中 8 スイート 45 件が落ちるが、
Mac の環境の差（CLI の e2e と MCP の tools）で main と同じ件数。`flow:bundle-guard` も通る。

計測（`kintone-plugin/work-link/ksql-kj13-bench.mjs`。模擬の client）: 50 文・30 個で解析 0.4 ms・検査 0.4 ms・実行計画 3.5 ms。
文の数にほぼ比例し、時間の大半はレコードの取得（SQL の中身で決まる）。

## 4. 資料

言語リファレンス §25 冒頭・一時テーブルの表・変数の表・§27.9、レシピ（`ksql_batch_recipes.md`）。CHANGELOG はリリースのときに書く。
