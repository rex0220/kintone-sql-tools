# B56 — 統計集約関数の拡充（STDDEV_POP/STDDEV_SAMP/VAR_POP/VAR_SAMP/MEDIAN）

- 起票日: 2026-07-22
- ステータス: 📝 **起票・codex レビュー反映済（2026-07-22・P1×1/P2×5/P3×1 全件コード裏取り一致→本文へ反映）。次＝仕様 R1**
- 種別: 改善（集計関数の拡充）
- 効果種別: 機能・性能（MCP クライアントのコンテキスト消費削減）
- 関連: **B55**（MCP instructions 全量関数カタログ＝追加時の同期必須）／**B14**（temp/CTE 列の型メタ伝播）／**B9**（厳密10進比較）
- 注記: 「STDDEV/VARIANCE」は機能群名。追加候補は明示形（`_POP`/`_SAMP`）のみが第一候補（§3-1）

## 1. 背景・課題

kSQL の集計関数は現状 `COUNT` / `SUM` / `AVG` / `MIN` / `MAX` / `GROUP_CONCAT` の 6 つのみで（`src/types/ast.ts` AggregateFunc union）、**ばらつき・分布の統計量（標準偏差・分散・中央値）が取れない**。

Claude Desktop 等の MCP クライアントで「このデータを分析して」という用途では、統計量が必要になると**生データ全件を MCP 経由で取得してクライアント（LLM）側で計算**するしかなく、レコード数が多いとコンテキスト（トークン）を大量消費する。エンジン側で集計できれば結果行のみ返せるため、MCP 利用での実益は関数拡充の中で最大級。

実際に B55 実機確認でも「STDDEV は存在しない」と即答させる導線を整備した経緯があり（[evidence](evidence/b55_claude_desktop_smoke.md)）、需要側（LLM が統計関数を試みる）は実測済み。

## 2. 追加候補

| 関数 | 内容 | 備考 |
|---|---|---|
| `STDDEV_POP` / `STDDEV_SAMP` | 母集団 / 標本 標準偏差 | ストリーミング計算可（Welford 等） |
| `VAR_POP` / `VAR_SAMP` | 母集団 / 標本 分散 | 同上 |
| `MEDIAN` | 中央値 | **全値保持が必要**（非ストリーミング）。偶数件は中間値の平均 |
| `PERCENTILE_CONT` | 連続パーセンタイル | **今回スコープ外を明確化するか、`WITHIN GROUP` 構文まで確定するかを R1 冒頭で決める**（中途半端な「余力で」を残さない） |

## 3. 論点（仕様 R1 で確定すべき点）

1. **無印 `STDDEV` / `VARIANCE` の既定**: MySQL は母集団、SQL Server（`STDEV`）は標本と方言差がある。誤解を避けるため **`_POP` / `_SAMP` の明示形のみ追加**し、無印は追加しない案を第一候補とする（追加するなら別名の canonical 対応を決める）。
2. **入力値の規約**: 現行集計の入力経路は三様（`src/engine/process.ts:329-372`）＝単純フィールド参照は**空のみスキップし非空の非数値文字列を保持**・算術式は **NaN スキップ**・最後に `eff.map(Number)` で binary64 化。統計集約で `"1"` と `"01"`、非数値テキスト、`NaN`/`Infinity`、文字列 CALC の結果が未定義になるため、**対象型を NUMBER/数値 CALC に限定するか・Number 変換可能文字列も許すか・非数値値はエラーか除外か**を確定する。Welford 終了時の微小負分散の 0 丸め条件も規定。
3. **`DISTINCT` の単位**: 現行 `DISTINCT` は Number 化より**前**の文字列単位（`"1"` と `"01"` は別値・`process.ts:347`）。統計集約でも文字列単位を踏襲するか数値同値単位にするか。式引数との組み合わせも受入条件に含める。
4. **構文**: 現行 parser は `GROUP_CONCAT` 以外の集計で `*` を受理（`parser.ts:1818`）→単純追加すると `MEDIAN(*)` 等が通る。**`STDDEV_*(*)`/`VAR_*(*)`/`MEDIAN(*)` は明示的に ParseError** とする。式引数（`STDDEV(金額*1.1)`＝SELECT 側は `parseArithAddSub` で受理可能）の可否を明記。**HAVING 内の集計引数は `parseIdentifier()` のみ**（`parser.ts:2163`）＝HAVING では alias 参照を推奨とするか構文拡張するか。
5. **完全入力の要否（truncate 契約）**: 現行の完全入力判定（`src/core/dmlGuard.ts:98`）に通常集計は含まれず、`onLimit=truncate` だと**部分集合の統計値**が返り得る。分析用途の正しさを守るため **fail-closed（統計集約は完全入力必須・truncate 禁止）を第一候補**とし、採らない場合は warning/EXPLAIN で部分集合であることを明示する。
6. **出力規約**: 戻り値の文字列表現と桁数・外部照合の許容誤差（絶対/相対）・`MEDIAN` 偶数件の binary64 平均・`VAR_POP` 1件時=0・`_SAMP` 系の 0/1 件時の値（未定義＝空文字 or エラー）・GROUP BY なし 0 件時（1 行返却=v1.12.0 準拠）の値。
7. **B9 厳密10進との関係**: 統計量は平方根・除算を含むため厳密10進では閉じない。**binary64 計算で許容**とする方針の明文化（比較・MIN/MAX の厳密性とは性質が異なる）。
8. **ウィンドウ・EXPLAIN**: `STDDEV(...) OVER (...)` は **ParseError で拒否**（現行 WindowFunc は順位3関数のみ＝`ast.ts:273`）。集約結果への順位付けは CTE 分離を案内。EXPLAIN の期待値（FULL_SCAN・ローカル集計・完全入力要否の表示）を固定する。

## 4. 実装スケッチ

- 集計・GROUP BY の**基本パイプライン（evalAggregate 経路）は再利用可**。ただし **型メタ推論は関数名の明示分岐が複数経路にあり、追加時は全経路の同期が必要**（codex レビューで確定）:
  - materialized 列メタ（`execute.ts:3109`＝COUNT/SUM/AVG を number 明示）
  - HAVING alias の型推論（`execute.ts:2143`）
  - ORDER BY 用型推論（`process.ts:1118`）
  - alias 型推論の別経路（`execute.ts:4195`＝「GROUP_CONCAT 以外は number」分岐）
- `MEDIAN`（と採用時の `PERCENTILE_CONT`）はグループ内全値保持が必要 → メモリは既存 `maxRecords` 境界内で完結（新上限は不要見込み）。
- 押し下げなし（統計集約は常にローカル計算・集計列は FULL_SCAN＝`selectToKintone.ts:74`）。

## 5. 同期箇所チェックリスト（追加時必須）

- `src/types/ast.ts`（`AggregateFunc` union）
- lexer / parser（予約語・token map・`PARSER_AGGREGATE_FUNCTION_TOKEN_MAP`）
- 集計評価エンジン（`process.ts` evalAggregate）
- **型メタ4経路**（§4 の execute.ts:3109 / 2143 / 4195・process.ts:1118）＋ temp→再集計・CTE→再集計の回帰テスト
- 言語リファレンス §集計関数表（予約語注記の前例＝B19 に従う）
- **B55 MCP instructions 全量関数カタログ**（aggregate 6→N。「This list is complete」と表明しているため**更新漏れ＝Claude Desktop に不存在と教える**。語数 guard 240–280＝`metadataTools.test.ts:101` の再実測）
- パーサ受理集合の frozen 定数 export＋catalog⇔parser⇔fixture 三者 drift guard（`functionCatalog.test.ts`・`ksqlFunctionCatalogFixtures.ts`）
- `ksql_docs` embed ドキュメント（`docsResources.ts` の関数カタログ）
- mcp-smoke / pack-smoke の instructions 代表語 assertion に新関数を追加（stale bundle 検出のため）
- `CHANGELOG.md`（新規予約語の告知＝B19 で確立した前例）・`release/README.txt`
- プラグイン `desktop.js` バンドル再ビルド（prod/plugin 両方・EXPLAIN エンジン同梱のため波及確認）

## 6. 受入条件（スケッチ）

- GROUP BY あり / なし・0 行・1 行（`_SAMP` 系）・HAVING / ORDER BY からの参照で正しい値。
- `DISTINCT`・式引数・`*`（ParseError）・`OVER`（ParseError）の各組み合わせ。
- `onLimit=truncate` との組み合わせが §3-5 の決定どおりに動く（fail-closed 採用なら FetchAllLimitError 系）。
- temp/CTE 経由の再集計・ORDER BY で数値型として扱われる（型メタ4経路）。
- 実機データで外部計算（JS / 表計算）と全件照合一致（§3-6 の許容誤差規約に基づく）。
- 既存 6 集計の非回帰（全テスト green）。

## 7. 次アクション

- 仕様 R1（§3 論点の確定）→ codex レビュー → 実装 → Claude コードレビュー → 実機照合。
