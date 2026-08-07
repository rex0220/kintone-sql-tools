# B155 仕様 R1 レビュー（Claude）

- 実施: 2026-08-08
- 対象: [仕様 R1](ksql_b155_unified_leaf_policy_spec_r1.md)（codex 作・案 A）
- 結論: **指摘なしで採用。**

## 確認内容

1. **調査結果との全一致**＝旧抽出器の受理集合（`wherePredicatePushdown.ts:91-172`）・
   呼び出し元（`klikePushdownPlan`）・消費点（`execute.ts:5540-5542` ほか）はすべて
   起票調査（2026-08-08）で読んだ実コードと一致
2. **統一設計が正しい**＝偽 `JoinPushdownSource` 方式を理由付きで否定し、
   `classifySupportedLeaf` を ownership 非依存の共有 leaf policy として抽出。
   KLIKE・`$id`・B126 正規化・選択系実在検証の互換を明文で維持
3. **仕様自身が潜在穴を 2 つ先回りで特定**:
   - §2.5/§5＝**metadata 要否判定（`extractTypedPushdownCandidates`）の追随が必須**
     （分類器だけ差し替えると新型の型メタが取得されない＝B150 修正 2 と同族の穴）。
     候補 helper を分類器と同居させ parity test で複製を防ぐ設計
   - §9.1＝**実行は metadata 付き plan・EXPLAIN は metadata なし再構築という計画二重化**を検出し、
     同一 plan 共有を義務化
4. **B154 を §9.2 で同梱**（`not applied` 行への but書き）——統一の副次効果として自然な範囲
5. 受入は実測済みの形を逐語固定（§8.1 の合流 query 文字列・§8.2 の strict/inclusive 同等・
   §8.3 の単一表 LIKE 併用）。dry-run の API 0 回契約（§5.3）も B150 の教訓を反映

実装前実測は起票調査（`< 101` 合流 / `<= 100` 落ち・単一表 LIKE 併用の全件取得）で確保済み。
