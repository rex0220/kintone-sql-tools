# B158 仕様 R1 レビュー（Claude）

- 実施: 2026-08-08
- 対象: [仕様 R1](ksql_b158_cross_join_spec_r1.md)（codex 作）
- 結論: **採用。ブロッカーなし・実装依頼への注記 3 件。**

## 確認内容

1. **「決まっていること」への適合**＝明示 `CROSS JOIN` 新設・`ON 1=1`/カンマ結合は不開放・
   出力行数ガード 10,000（`GENERATE_SERIES` と定数共有・カウンタ独立・行生成前判定）・
   EXPLAIN 生成行数表示・許可判定/行数算出の 1 実装（`planCrossJoinRows()`）——すべて満たす
2. **設計の要点が正しい**:
   - AST を discriminated union にし、`join.on` を読む既存 6 箇所（ファイル:行つき）へ
     **型で narrowing を強制**（`on?: ...` で黙って通さない）——B125 の「通るが処理が抜ける」教訓の適用
   - 物理入力の行数を **EXPLAIN が捏造しない**（exact は証明できる場合のみ・それ以外は
     runtime 算出式表示）——`maxRecords` は上限であって実件数ではない、の一線を守る
   - **JOIN キー prefilter の明示的非適用**（`on` 欠如を fallback として INNER 経路へ流さない）と
     **B155 共有 leaf policy による alias-local WHERE prefilter** の分離が明文
   - 完全入力 `CROSS_JOIN` 追加＋truncate 無効化＝「取得できた範囲の直積」を静かに返さない
   - 順序は内部安定順（回帰固定用）とし、**公開順序保証を新設しない**
3. **機能相互作用の網羅**＝GROUP BY/window の同一 SELECT 制約は不変（CTE で段を分ける）・
   metadata が CROSS を境界にしない・DML source でのガードは mutation API より前・
   B157 の複文 dry-run 表示一致まで受入に含む

## 実装依頼への注記（3 件・仕様本文の変更は不要）

1. **§14.4 の `npm run build` は codex 禁止事項と衝突**——build・plugin smoke は従来どおり
   Claude 側工程。実装依頼の禁止事項が優先
2. **`CROSS` の hard keyword 化は小さな破壊的変更**（未引用の `CROSS` フィールド/別名が
   要バッククォートに）。§18 Step 8 の文書同期に**予約語リスト（言語リファレンス）への追記**を
   含め、リリース時 CHANGELOG に明記（Claude 工程）
3. **§12 の R17 形 SQL は受入テストで逐語実行して固定**（B141 原則＝掲載 SQL は実行して
   から正とする。特に CTE 間 LEFT JOIN on 合成キー・`CASE WHEN ... = ''` 0 埋めの型伝播）

## Claude 実測（§16）は実装後に全項目実施

修正前 3 形の ParseError 逐語は起票時に記録済み（2026-08-08・v3.62.0）。
