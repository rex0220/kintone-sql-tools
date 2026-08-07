# B152 Phase 2+3 受入対応表

- 実装日: 2026-08-07
- 対象: B152 R1 のうち Phase 2 + Phase 3
- Phase 4: GAIA_IL26 実測により見送り。B54 後に再評価

| 受入条件 | 自動テスト | 残る実機確認 |
|---|---|---|
| §11.1 3経路一致 | `b152DateTextPushdownAcceptance.test.ts` の全 table-driven case | 実機（Claude）で rows / warning / API error を再確認 |
| §11.2 Phase 2 全演算子 | 5型 × 7 SQL 表記を JOIN exact / 強制 residual / 単一表で照合 | 実機（Claude） |
| §11.3 空セル方向 | 5型 × 7演算子の fixture に空セルを含めて3経路照合 | 実機（Claude）の DATE / TIME / DATETIME 結果はレビュー記録済み |
| §11.4 canonical 外 DATETIME | classifier unit と EXPLAIN で offset / 秒省略 / 小数秒 / 空白区切りを非適用化 | 実機（Claude）の入力受理挙動 |
| §11.5-6 TEXT scalar / list | `=`, `!=`, `<>`, `IN`, `NOT IN` を空セル込み3経路照合 | 実機（Claude）の逐語一致と空セルはレビュー記録済み |
| §11.7 TEXT escape | `A"B`, `A\B`, `A"\B` を保存 fixture、SQL、実 serializer query、local residual で照合 | 実機（Claude） |
| §11.8 TEXT normalization | classifier が値を変換しないことと実 serializer 形を unit 固定 | 実機（Claude）。大文字小文字・全半角はレビュー記録済み、NFC/NFD・カナ・空白は残る |
| §11.9 LINK | TEXT と同じ5演算子を空セル込み3経路照合 | 実機（Claude）の LINK 固有確認 |
| §11.10-13 Phase 4 | USER_SELECT を含む code list が `unsafe`、B84 全セル `✕` を unit/parity 固定 | 見送り確定。B54 後に再評価 |
| §11.14 prefilter parity | 全 table-driven case で columns / rows / rowCount を完全比較 | 実機（Claude） |
| §11.15 outer join | LEFT / RIGHT の EXPLAIN で B152 leaf 非適用を固定 | 既存 outer join suite と併せて確認 |
| §11.16 B84 parity | 分類器由来表との一致、DATE/TEXT の分類器側・文書側1セル破壊を固定 | なし |
| §11.17 B76/B151 回帰 | `joinPredicatePushdown`, B76 Step 2, B151 acceptance と全 `npm test` | なし |
| §11.18 全 surface | Node engine は自動テスト | CLI / MCP / Firefox / Chrome / engine library は実機（Claude）。今回 MCP・buildは禁止 |
