# B57 日付集計軸関数 — CLI 実機照合（dev・APP4221）

- 実施日: 2026-07-22
- 環境: dev プロファイル・APP4221（`日付`=DATE・日付あり 57 レコード）
- 方法: `node dist-cli/ksql.js --profile dev -f <sql>`（全クエリ read-only・書き込みゼロ・復元不要）

## 1. ISO 週境界（リテラル・node 検算表と完全一致）

| 入力 | WEEK | `%G-%v` | 判定 |
|---|---|---|---|
| `'2025-12-29'`（月・前年日付→翌年週） | 1 | `2026-01` | PASS |
| `'2026-01-01'`（木） | 1 | — | PASS |
| `'2027-01-01'`（金・翌年日付→前年週） | — | `2026-53` | PASS |
| `'2021-01-01'`（金・W53 年） | — | `2020-53` | PASS |

## 2. 不正日付・素通し

| ケース | 結果 | 判定 |
|---|---|---|
| `WEEK('2026-02-31')` | 空文字 | PASS |
| 混在 pattern `DATE_FORMAT('2026-02-31', '%Y|%w|%G-%v')` | `"2026||-"`（`%Y` は現行どおり・新指定子のみ空置換）＝仕様 §3.2 の受入条件そのもの | PASS |
| `'%%a'`（`%` 素通し＋`%a`） | `%水`（`%%Y` 型の現行互換素通しを実機確認） | PASS |

## 3. 実データ（5 行サンプル）

2026-07-15（水）→ `DAYOFWEEK=4`・`%w=3`・`%a=水`・`QUARTER=3`・`WEEK=29`・`%G-%v=2026-29`／2026-07-19（日）→ `1`/`0`/`日`。**全行で `DAYOFWEEK = %w + 1` 恒等成立**。

## 4. 集計・比較経路

| ケース | 結果 | 判定 |
|---|---|---|
| `GROUP BY QUARTER(日付)` | Q3: 57 件（日付あり全件＝7 月）| PASS |
| 曜日分布 `GROUP BY DAYOFWEEK(日付)` | 日=53・火=1・水=3 | PASS |
| `WHERE DAYOFWEEK(日付) >= 2 AND <= 6`（平日） | 4 件（=火1＋水3・分布と整合） | PASS |
| `ORDER BY DAYOFWEEK(日付)`（**関数直書き**） | 1, 3, 4 の数値昇順 | PASS |
| `WEEK()` / `QUARTER(日付, 1)` | `ArgumentError: WEEK/QUARTER expects 1 argument(s).` | PASS |

## 5. 実機で発見した既存バグ（B57 非起因・B59 起票）

`ORDER BY <alias>`（例: `DAYOFWEEK(日付) AS dw … ORDER BY dw`）が**黙って無視され元の行順のまま**になる。**既存の `LENGTH` でも同一再現**（`GROUP BY LENGTH(タイトル) ORDER BY len` → 出現順 6,3,4,2,9,10）・GROUP BY の有無に関係なし＝**B57 の回帰ではない既存の正しさバグ**。原因= `evalOrderKey` の FIELD_NAME 分岐（process.ts:694）が `row[key.name] ?? ""` で解決し、行に alias キーが無いと全行 `""`＝安定ソートで no-op。回避策=関数直書き `ORDER BY DAYOFWEEK(日付)`（正常動作）。→ **B59 として起票**。

## 6. 自動ゲート（同日）

- `npm test`: 113 suites / 2,786 ＋ subprocess 2 / 25 ＝ **2,811 green**（Claude 独立実行・codex 報告と一致）
- `build:mcp` → `mcp:smoke` / `mcp:pack-smoke`: ok（instructions 277 語 exact・代表語 DAYOFWEEK/WEEK 含む）
- `build:cli`: ok

## 7. 残確認

- プラグイン面はリリース準備のバンドル再ビルド時・MCP live は再起動後（B56/B58 と同じ）。
