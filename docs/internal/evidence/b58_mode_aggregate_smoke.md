# B58 MODE 集約関数 — CLI 実機照合（dev・APP4221）

- 実施日: 2026-07-22
- 環境: dev プロファイル・APP4221（61 レコード）
- 方法: `node dist-cli/ksql.js --profile dev -f <sql>`（全クエリ read-only・書き込みゼロ・復元不要）

## 結果（全 10 ケース PASS）

| # | ケース | 結果 | 判定 |
|---|---|---|---|
| 1 | `MODE(ドロップダウン)` vs 外部集計（GROUP BY＋COUNT: d1=55/d2=2/空=4） | `d1`（空セル 4 件は候補外＝仕様 §4.1） | PASS |
| 2 | `MODE(ステータス)` vs 外部集計（未処理56/完了2/保留1/処理中2） | `未処理` | PASS |
| 3 | **タイ決定性（実データ）**: `MODE(金額)`＝最大頻度 5 のタイが 10 値（1001〜1010 各5回・次点 3000×4） | `1001`＝canonical 数値順最小 | PASS |
| 4 | 空集合（`WHERE 金額 > 999999999`） | 空文字 | PASS |
| 5 | 単一件（`WHERE $id = 5`） | `1000`（その値） | PASS |
| 6 | `SET @m = (SELECT MODE(金額) …)` → `WHERE 金額 = @m` | 5 件一致（=1001 の 5 行）＝**source meta による数値変数化が動作** | PASS |
| 7 | `EXPLAIN SELECT MODE(…)` | `complete input reason: STATISTICAL_AGGREGATE` の 3 行表示 | PASS |
| 8 | `MODE(DISTINCT 金額)` | ParseError「MODE では DISTINCT は使用できません」（位置=DISTINCT token） | PASS |
| 9 | `MODE(*)` | ParseError「MODE(*) は使用できません…」 | PASS |
| 10 | truncate fail-closed（`--max-records 10 --on-limit truncate`） | 「統計集約の正しい結果には完全な候補集合が必要です。complete input reason: STATISTICAL_AGGREGATE。…」 | PASS |

入力順シャッフルの決定性・`"1"`/`"01"` 同頻度の raw 二次比較・STATUS optionOrder は契約テスト（`modeAggregate.test.ts`）で固定済み。

## 自動ゲート（同日）

- `npm test`: 112 suites / 2,759 ＋ subprocess 2 / 25 ＝ **2,784 green**（Claude 独立実行・codex 報告と一致）
- `build:mcp` → `mcp:smoke` / `mcp:pack-smoke`: ok（instructions 274 語＝guard 240–280 内・代表語 MODE 含む・「Variance and standard-deviation aggregates …」文言差し替え済み）
- `build:cli`: ok

## 残確認

- プラグイン面はリリース準備のバンドル再ビルド時にブラウザ確認・MCP live は再起動後（B56 と同じ）。
