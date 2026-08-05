# B128 集計ウィンドウ Phase 2 仕様 R1 codex レビュー依頼

**レビュー依頼であり実装依頼ではない。コードは 1 行も変更しないこと。**
git 操作をしないこと。kSQL MCP を叩かないこと（headless で無言停止する）。`npm test` は不要。

## 依頼

集計ウィンドウの **Phase 2（移動フレーム / `LAG` / `LEAD`）** の仕様 R1 をレビューしてほしい。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.46.0 ＋ 未リリースの B126/B127/B132）

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b128_window_phase2_spec.md` | **レビュー対象の R1** |
| `docs/internal/ksql_b125_aggregate_window_phase1_spec.md` | Phase 1 仕様（出荷済み・前提） |
| `docs/internal/ksql_b125_codex_review_1.md` | Phase 1 のレビュー（高6中5低1・全件反映済み） |
| `src/engine/process.ts` | `applyWindow` / `applyAggregateWindow` / `evalAggregate` / `aggregateRowValues` |
| `src/types/ast.ts` | `WindowColumn` / `WindowFrame` / `RankingWindowColumn` / `AggregateWindowColumn` |
| `src/parser/parser.ts` | ウィンドウのパース・併用チェック |
| `src/execute.ts` / `src/converter/selectToKintone.ts` | 型メタ・フィールド収集 |

**背景**: Phase 1（B125）のレビューでは高 6・中 5・低 1 の指摘があり、うち 3 件は
「そのまま実装すると静かに誤る」ものだった（集計引数のフィールドが取得されず全行スキップ／
`WINDOW_COL` の型メタが一律 number で `MIN`/`MAX` が壊れる／`ORDER BY` 無しで完全入力を
要求せず truncate が部分集計になる）。**同じ系統の穴が Phase 2 に残っていないかを見てほしい。**

## 特に見てほしい点（コードで真偽が決まるもの）

### 1. `WindowFrame` に `start` / `end` を足すのは純加法か

R1 §5。Phase 1 の `WindowFrame` は `{ unit, source }` だけで、
**開始 `UNBOUNDED PRECEDING` / 終了 `CURRENT ROW` が暗黙の固定**だった。
`start` / `end` を足したとき、**その固定を前提にしている既存箇所**が無いか。
`applyAggregateWindow` の `RANGE` 書き戻し・`frame === null` 判定・`EXPLAIN` の
フレーム表示・B127 の警告判定（`frame.source === "DEFAULT"`）を含めて確認してほしい。

### 2. `WindowColumn` を 3 メンバー（`RANKING` / `AGGREGATE` / `VALUE`）にする影響

Phase 1 のレビューでは 13 ファイルを (a) 影響なし / (b) 処理が要る /
(c) 型追加でコンパイルが壊れる、に分類してもらい、(c) が 8 箇所あった。
**今回も同じ形で全列挙してほしい。** とくに

- `isRankingWindow` を使っている箇所が、**新メンバー `VALUE` を順位系として誤って拾わないか**
- 型メタ（`execute.ts` の 4 箇所・`process.ts` の 1 箇所）で `VALUE` をどう扱うべきか
- `selectToKintone` のフィールド収集で `LAG` の引数フィールドが取得対象に入るか
  （Phase 1 で集計引数が漏れて全行スキップになった穴と同じ形）

### 3. 空フレームの値（R1 §3.2 / §7-1）

標準 SQL は空フレームの `SUM` を NULL とするが、**kSQL の空入力集計は `0`**（Phase 1 で確認）。
R1 は「kSQL 側に揃える」としている。
**現行の `evalAggregate` / `applyAggregateWindow` が空入力で実際に何を返すか**を確認し、
`MIN`/`MAX`（`best ?? 0`）・`AVG`（`count === 0` のとき）・`COUNT` を型ごとに示してほしい。
移動フレームで空になるのは**通常の使い方でも起きる**（`ROWS BETWEEN 3 FOLLOWING AND 5 FOLLOWING` の末尾など）ので、
Phase 1 より頻度が高い点も踏まえて意見がほしい。

### 4. 計算量の設計は成立するか（R1 §3.3）

- `SUM`/`COUNT`/`AVG` を **prefix sum の差分**で O(N) にする案。
  **桁落ちが Phase 1 の契約（厳密一致を要求しない）の範囲に収まるか**、
  それとも受入で別の許容誤差が要るか
- `MIN`/`MAX` を**単調両端キュー**で償却 O(N) にする案。
  既存の `compareCanonicalValues` と `resolveAggregateArgSemantics` を使う前提で成立するか
  （比較器を二重実装しないこと）
- **素朴実装（各行でフレームを切って `evalAggregate`）を参照実装としてテストに置く**設計が
  現実的か（`aggregateRowValues` を直接呼べるか等）

### 5. `LAG` / `LEAD` の出力型メタ（R1 §4.2 / §7-2）

Phase 1 では `WINDOW_COL` が一律 number 扱いで `MIN`/`MAX` が壊れる指摘があった。
**`LAG` は引数の意味型をそのまま引き継ぐべき**と R1 は書いている。
`inferAggregateArgMeta` / `resolveAggregateArgSemantics` をどう使えばよいか、
**CTE / 一時テーブルへ実体化した後まで型メタが伝わるか**を確認してほしい。

### 6. パース上の落とし穴

`ROWS BETWEEN 6 PRECEDING AND CURRENT ROW` の `PRECEDING` / `FOLLOWING` /
`UNBOUNDED` / `BETWEEN` は soft keyword で足りるか。
`LAG` / `LEAD` は**集計関数ではない**ので、Phase 1 で入れた
「集計関数の引数を読んだ直後に `OVER` を先読みする」経路には乗らない。
**どこで分岐すべきか**を示してほしい。

### 7. 受入条件で検出できない穴（R1 §6）

とくに「素朴実装と一致」を参照実装にする方式で、**両方が同じように間違う**ケースが無いか。

## 出したい成果物

`docs/internal/ksql_b128_codex_review_1.md` に。

- 結論（実装着手可能 / 要修正・件数）
- 指摘（重要度 高/中/低・該当 §/file:line・内容・**コード引用による根拠**・提案）
- 上の 7 点への回答（コード引用つき。2 は (a)/(b)/(c) 分類の完全な一覧）
- 仕様が正しかった点（R2 で消さないため）

重要度: 高 = そのまま実装すると誤る/既存を壊す、中 = 実装が詰まる/受入の穴、低 = 表現。
**根拠のないコメントは書かないでほしい。** 確認できなかった項目は「未確認」と明記のこと。
