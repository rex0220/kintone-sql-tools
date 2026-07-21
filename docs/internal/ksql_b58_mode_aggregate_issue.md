# B58 — MODE 集約関数（最頻値・カテゴリデータ対応）

- 起票日: 2026-07-22
- ステータス: 📝 **起票（B56 実装完了後の後続候補・仕様前）**
- 種別: 改善（集計関数の拡充）
- 効果種別: 機能（カテゴリデータの分析・MCP 分析用途）
- 関連: **B56**（統計集約＝完全入力契約・空文字規約・`*` 拒否 helper・カタログ同期の型をそのまま再利用）／**B55**（MCP 全量関数カタログ同期）

## 1. 背景・課題

kintone のドロップダウン・ラジオボタン・STATUS はカテゴリデータの典型で、「最も多い値」を取りたい場面（部署ごとの最頻ステータス等）は分析の定番。現状の kSQL では GROUP BY＋COUNT＋自前の絞り込みが必要で、1 文では書きにくい。

B56 の統計 5 関数は数値限定のため、**文字列（カテゴリ）に効く集約が補完として欲しい**。

## 2. 前例調査（2026-07-22・Web 裏取り済）

| RDB | MODE 相当 | 構文 |
|---|---|---|
| MySQL | なし（自前集計） | — |
| SQL Server | なし（同上） | — |
| PostgreSQL（9.4+） | あり | `mode() WITHIN GROUP (ORDER BY x)`＝順序集合集約 |
| Oracle | あり（別名） | `STATS_MODE(x)` |
| Snowflake / Databricks / DuckDB | あり | 素の `MODE(x)` |

- ANSI SQL 標準に MODE 集約は**ない**（`WITHIN GROUP` の枠組みは標準だが `mode()` は PostgreSQL 拡張）。
- **タイ（同数）の扱いは Oracle も PostgreSQL も不定**（「どれか 1 つを返す」）＝決定性がない。
- 位置づけ: 伝統的 RDB では標準化されなかったが、分析系エンジンでは素の `MODE(x)` として定着しつつある。

## 3. 設計方針案（仕様 R1 で確定）

1. **構文は素の `MODE(x)`**（Snowflake/Databricks 型）。`WITHIN GROUP` は導入しない（B56 で PERCENTILE_CONT を見送ったのと同じ理由＝順序集合構文のコストが高い）。
2. **文字列でそのまま動く**: 数値変換なし・文字列単位の頻度カウント（B56 の数値ガード・ArgumentError は適用しない）。数値列にも文字列表現の頻度で動く（`"1"` と `"01"` は別値＝GROUP_CONCAT と同じ文字列意味論）。
3. **タイは決定的規則**: 同数タイのときは **canonical 比較順（v3 型付き比較）で最小の値**を返す。Oracle/PostgreSQL の「不定」は kSQL の決定性原則（コードポイント順・v3 ordering）に反するため採らない。
4. **空集合＝空文字**（B56 §4.3 の「定義できない統計量＝空文字」規約を踏襲）。
5. **完全入力必須**: 部分集合の最頻値は誤るため、B56 の `completeInputReasons` に乗せる（reason は STATISTICAL_AGGREGATE 共用か MODE 独立かを R1 で決定）。
6. **`MODE(*)` は ParseError**（B56 の `aggregateAcceptsWildcard` helper へ追加するだけ）。
7. **論点**: `DISTINCT` の扱い（全値が頻度 1 になり無意味→ParseError で拒否か、黙って受けるか）・型メタ（引数列の型を透過＝MIN/MAX の source meta 継承方式が候補）・予約語 `MODE` の衝突リスク（一般的な単語＝同名フィールドコードがあり得る。バッククォート注記必須・B19 前例）。

## 4. 実装コスト見込み

**小**（B56 の後追い）。頻度カウント Map＋タイ規則のみが新規で、完全入力契約・空文字規約・`*` 拒否・カタログ/drift guard/語数 guard 同期・型メタ経路は B56 実装の資産をそのまま再利用できる。

## 5. 同期箇所

B56 spec §7 のチェックリストと同一（AggregateFunc union・parser token map・evalAggregate・完全入力 walker・合成集計名 regex・CHECK regex・言語リファレンス・B55 カタログ＝aggregate +1・fixtures/drift guard・ksql_docs・smoke 代表語・CHANGELOG 予約語告知・desktop.js）。

## 6. 次アクション

- B56 実装完了・リリース後に仕様 R1（§3 の論点確定）→ codex レビュー → 実装。
