# B65 Phase1 Step 5 — grouping guard Node benchmark evidence

## 結論

2026-07-23 の Node 実測は candidate guard
`64 grouping sets / 16 grouping items / 50,000 generated rows` を支持した。
Node で成功した代表最大 shape はすべて 132 ms 未満で、観測した
`heapUsed` 最大値は 70 MiB 未満だった。50,000 行境界は成功し、
50,001 行目は `GROUPING_OUTPUT_LIMIT_EXCEEDED` で結果 0 行の
fail-closed になった。65 sets / 17 items も planning guard で失敗した。

したがって Step 5 の effective 値として **64 / 16 / 50,000 を維持する**
ことを推奨する。定数、仕様 §12.1、EXPLAIN、B65-G01 の値は変更しない。

この判断は Node 面に限定する。Firefox / Chrome plugin の実ブラウザ
benchmark はヘッドレス環境の本 Step では実施していない。リリース前の
手動 plugin smoke で同じ上限内 shape、UI 応答、ブラウザ heap、guard 時に
結果が表示されないことを確認する残作業がある。

## 環境と手法

- 実行日: 2026-07-23
- OS / runtime: Windows x64 / Node v24.14.0
- command: `npm run benchmark:b65`
- production entry: `applyGroupingSets`
- fixture: 10,000 rows。最大 16 grouping fields、256-byte payload、
  CASE 用 status/amount、DISTINCT 用値を持つ決定的な行を生成
- 時間: `performance.now()` で同期 group stage の wall time を測定
- heap: `--expose-gc` で stage 前に GC し、
  `process.memoryUsage().heapUsed` の stage 直前/直後差と大きい方を記録
- 通常 matrix は 5 回実行し median / max を記録。50,000 / 50,001 境界は
  fixture サイズのため各 1 回
- heap の「最大」は同期処理中をサンプリングする真の high-water mark ではなく、
  直前/直後 endpoint の最大近似である。ブラウザ値の代替とは扱わない
- runtime case は `B65_MAX_GENERATED_ROWS` を必ず渡す。guard error 時の
  `outputRows` は 0 とし、入力値や SQL 全文は error に含めない

MiB は bytes / 1,048,576、時間は ms。`guard` は 50,001 行目を作る前に
例外となり、呼出し側へ結果を返していないことを示す。

## grouping set 数 matrix

| sets | cardinality | status / rows | median ms | max ms | max heap delta MiB | max heapUsed MiB |
|---:|---|---:|---:|---:|---:|---:|
| 1 | low | ok / 4 | 2.28 | 4.61 | 2.1 | 11.0 |
| 1 | unique | ok / 10,000 | 14.89 | 18.45 | 15.6 | 24.6 |
| 8 | low | ok / 32 | 15.66 | 18.41 | 15.2 | 24.2 |
| 8 | unique | guard / 0 | 65.03 | 77.72 | 25.8 | 34.8 |
| 32 | low | ok / 128 | 63.96 | 65.64 | 60.7 | 69.8 |
| 32 | unique | guard / 0 | 55.14 | 67.07 | 19.1 | 28.1 |
| 64 | low | ok / 256 | 124.93 | 131.40 | 57.2 | 66.4 |
| 64 | unique | guard / 0 | 50.89 | 71.99 | 70.9 | 80.1 |

unique の 8 / 32 / 64 sets は生成行 guard に先に到達するため、64 sets
まで処理した成功時間ではない。これは上限の独立性と、
runtime guard が過大な set × cardinality を早期に閉じることの証拠である。

## grouping item 数 matrix

| items | cardinality | status / rows | median ms | max ms | max heap delta MiB | max heapUsed MiB |
|---:|---|---:|---:|---:|---:|---:|
| 1 | low | ok / 4 | 2.29 | 2.53 | 1.9 | 11.1 |
| 1 | unique | ok / 10,000 | 13.05 | 13.67 | 15.3 | 24.5 |
| 2 | low | ok / 4 | 1.70 | 4.89 | 2.3 | 11.7 |
| 2 | unique | ok / 10,000 | 12.63 | 17.41 | 18.5 | 27.9 |
| 4 | low | ok / 4 | 1.97 | 3.73 | 3.0 | 13.1 |
| 4 | unique | ok / 10,000 | 20.67 | 24.24 | 25.7 | 35.8 |
| 8 | low | ok / 4 | 5.88 | 10.55 | 4.6 | 15.8 |
| 8 | unique | ok / 10,000 | 32.21 | 39.49 | 42.2 | 53.4 |
| 16 | low | ok / 4 | 9.31 | 15.67 | 7.7 | 27.5 |
| 16 | unique | ok / 10,000 | 74.10 | 100.35 | 51.6 | 65.3 |

## aggregate shape matrix

10,000 rows、8 sets、4 items、low cardinality（32 generated rows）。

| shape | status / rows | median ms | max ms | max heap delta MiB | max heapUsed MiB |
|---|---:|---:|---:|---:|---:|
| B64 `SUM(CASE ...)` | ok / 32 | 22.81 | 36.18 | 34.5 | 44.8 |
| `COUNT(DISTINCT ...)` | ok / 32 | 25.49 | 36.86 | 29.6 | 39.9 |
| B56 STDDEV / VAR / MEDIAN / MODE | ok / 32 | 40.28 | 41.22 | 45.1 | 55.5 |
| B64 + DISTINCT + B56 combined | ok / 32 | 42.63 | 60.27 | 56.4 | 66.8 |

## guard 境界

| guard probe | result | elapsed ms | max heap delta MiB | max heapUsed MiB |
|---|---|---:|---:|---:|
| 64 sets | accepted by planning limit | — | — | — |
| 65 sets | `GROUPING_SET_LIMIT_EXCEEDED` | planning | — | — |
| 16 items | accepted by planning limit | — | — | — |
| 17 items | `GROUPING_ITEM_LIMIT_EXCEEDED` | planning | — | — |
| 50,000 generated rows | ok / 50,000 rows | 64.85 | 33.0 | 54.5 |
| 50,001st generated row | `GROUPING_OUTPUT_LIMIT_EXCEEDED`, output 0 | 13.30 | 25.7 | 47.1 |

65 / 17 は production planning guard
`enforceGroupingPlanningCandidateLimits` を直接実行した。生成行境界は
production `applyGroupingSets` を実行した。50,001 probe が 50,000 success
より短いのは、例外時に aggregate materialization と返却配列の完成を行わないためである。

## 推奨とリリース残作業

Node 実測では、candidate 内の最大 set/item/row shape は時間・heap とも
実用域で、各 +1 は部分結果なしに閉じた。このため effective guard は
**64 / 16 / 50,000 の維持**を推奨する。根拠なく値を広げず、ブラウザ測定で
Node より弱い制約が明確になった場合だけ、単一 source の3定数、仕様、
EXPLAIN、G01、計画を同時更新する。

リリース前に Firefox / Chrome plugin で次を手動確認する。

1. 看板 SQL、2列 ROLLUP、明示 GROUPING SETS の結果と応答時間。
2. 64 sets / 16 items の上限内代表 shape の UI 応答と browser heap。
3. 65 sets / 17 items / 50,001 generated rows で結果を表示せず fail-closed。
4. MCP / CLI の実 kintone 接続 smoke。built MCP の offline validate と
   mock-client core execute は Step 5 自動 gate で別途固定する。
