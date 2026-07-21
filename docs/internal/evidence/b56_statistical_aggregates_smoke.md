# B56 統計集約関数 — CLI 実機照合（dev・APP4221）

- 実施日: 2026-07-22
- 環境: dev プロファイル・APP4221（`金額`=NUMBER・61 レコード中 空セル 2）
- 方法: `node dist-cli/ksql.js --profile dev -f <sql>`（全クエリ read-only・書き込みゼロ・復元不要）
- 判定基準: 仕様 R2.1 §4.2 の複合誤差基準 `abs(actual − expected) <= 1e-12 + 1e-9 * abs(expected)`

## 1. 統計 6 値の外部照合（n=59）

`SELECT $id, 金額 FROM APP4221` の生データ 59 値（空セル 2 件はスキップ）を node 独立実装（二乗和方式＝kSQL の Welford とは別アルゴリズム）で計算し、kSQL の結果と照合:

| 値 | kSQL | 外部計算 | 判定 |
|---|---|---|---|
| COUNT | 59 | 59 | 一致 |
| AVG | 1157.2033898305085 | 1157.2033898305085 | 一致 |
| VAR_POP | 568540.094225797 | 568540.0942257972 | 誤差基準内 |
| VAR_SAMP | 578342.5096434831 | 578342.5096434834 | 誤差基準内 |
| STDDEV_POP | 754.0159774340309 | 754.015977434031 | 誤差基準内 |
| STDDEV_SAMP | 760.4883362968054 | 760.4883362968058 | 誤差基準内 |
| MEDIAN | 1006 | 1006 | 完全一致 |

## 2. その他のケース

| # | ケース | 結果 | 判定 |
|---|---|---|---|
| 2 | `MEDIAN(DISTINCT 金額)`（数値単位 DISTINCT） | `1004.5`（distinct 16 値の偶数件平均・手計算一致） | PASS |
| 3 | 空集合（`WHERE 金額 > 999999999`・GROUP BY なし 1 行） | `vp0/vs0/sp0/med0` すべて空文字 | PASS |
| 4 | `EXPLAIN SELECT STDDEV_POP(金額) …` | `complete input: required` / `complete input reason: STATISTICAL_AGGREGATE` / `onLimit=truncate: disabled` | PASS |
| 5 | `MEDIAN(*)` | ParseError「MEDIAN(*) は使用できません…」 | PASS |
| 6 | 無印 `STDDEV(金額)` | ParseError（未消費トークン＝非対応） | PASS |
| 7 | `STDDEV_POP(タイトル)`（テキスト列） | `ArgumentError: STDDEV_POP の引数に非数値または非有限の値があります: T NULL`（関数名・値つき） | PASS |
| 8 | 単一件（`WHERE $id = 5`・金額=1000） | `VAR_POP=0`・`VAR_SAMP=""`・`STDDEV_SAMP=""`・`MEDIAN=1000` | PASS（仕様 §4.3 どおり） |
| 9 | truncate fail-closed（`--max-records 10 --on-limit truncate`） | 「統計集約の正しい結果には完全な候補集合が必要です。complete input reason: STATISTICAL_AGGREGATE。onLimit=truncateは使用できません。取得件数が上限（10 件）を超えました。…」 | PASS |

## 3. 自動ゲート（同日）

- `npm test`: 111 suites / 2,744 ＋ subprocess 2 suites / 25 ＝ **2,769 green**（Claude 独立実行・codex 報告と一致）
- `npm run build:mcp` → `mcp:smoke` / `mcp:pack-smoke`: ok（instructions 272 語＝guard 240–280 内・代表語 STDDEV_POP/MEDIAN 含む）
- `npm run build:cli`: ok

## 4. 残確認

- プラグイン面（desktop.js）はリリース準備のバンドル再ビルド時にブラウザ確認（エンジン共有のため SQL 挙動は同一の見込み）。
- MCP live サーバは再起動後に新ビルドで確認（stale server 注意＝B50 実機の教訓）。
