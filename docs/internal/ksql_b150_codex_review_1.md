# B150 仕様 R1 レビュー（Claude・実測付き）

- 実施: 2026-08-07
- 対象: [仕様 R1](ksql_b150_join_key_range_prefilter_spec_r1.md)（codex 作・案 D＋案 A）
- 結論: **指摘なしで採用。**

## 確認内容

1. **実装箇所の特定が正確**＝`tryFetchJoinRecordsBySourceKeys()`（`in` 50×6 チャンク・
   300 上限・trim/重複除去・空キー除外の現行契約まで列挙）
2. **空値フォールバックの設計を実測が裏づけ**＝kSQL の JOIN ローカル評価器は
  **空=空を一致とみなす**（CTE 間 JOIN で実証）。範囲 prefilter は物理側の空セル行を
  落とすため、空値混在での全件フォールバック（`JOIN_KEY_EMPTY_VALUE`）は必須で正しい
3. **既存 `in` 経路の空キー取り漏らしは既存問題**として仕様がスコープ外を明示
  → **[B153](ksql_b153_join_key_empty_in_issue.md) に起票**（実害未観測・優先低）
4. 型選択の正を `nativeWhereOperatorsForType()` に一本化（複製禁止）・canonical 全数検査・
  min/max は共有比較器（`Date` 変換禁止）・`=`/`in` へ戻る経路を作らない・
  フォールバック reason code の逐語固定——いずれも本日の設計原則と整合
5. 「v3.60.0 の値エラー表面化原則」と「エンジンの演算子選択」のクラス区別を §6.2 が明文化

## 実測（v3.60.0）

- `WITH a/b（'' と 'x'）の CTE 間 JOIN` → `''` 同士が一致（空=空は一致）
- `APP4228 の 製品名 = ''` → 0 件（実データに空キー行なし＝B153 の実害なし）
