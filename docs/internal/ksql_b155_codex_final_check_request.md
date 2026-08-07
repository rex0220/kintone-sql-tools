# B155 実装の最終チェック依頼（codex）

**チェックのみ。コード変更・ファイル書き込み・git・MCP・MEMORY.md 禁止。**

対象: `b155/dev` の B155 実装（[仕様 R1](ksql_b155_unified_leaf_policy_spec_r1.md)・B154 同梱）。
**自分の実装への検査。甘く見ないこと**（B149〜B152 とも本工程が出荷前に指摘を出した。
B150 では静的チェックが CLI dry-run の回帰を捕れず実機が捕った——今回は dry-run/EXPLAIN の
API 呼び出しを机上でも徹底的に追うこと）。

## 重点観点

1. **fail-open**＝共有 policy 経由で「型メタ未解決・所有権曖昧・RHS field・serializer 不能」の葉が
   prefilter に乗る経路が 1 つでもあれば Critical。単一表の非修飾 field と JOIN ownership の
   契約が混ざっていないか（仕様 §4.1 が禁じた形）
2. **規則の複製残存**＝`wherePredicatePushdown.ts` 側に型×演算子の本体が残っていないか。
   metadata 候補 helper と共有 policy の parity test が実際に複製を検出できる作りか
3. **plan 共有（§9.1）**＝実行と EXPLAIN が同一 plan を使うか。**dry-run / no-op client で
   metadata API・records API が 0 回**か（B150 の実機発見と同じ穴の再発防止）
4. **KLIKE identity**＝抽出後 AST の node identity で `appliedKlikes` が維持されるか
   （共有 policy 化で葉が再構成され identity が壊れると **fail-closed が誤発動**する——
   壊れていれば Critical）
5. **既存テスト変更の妥当性**＝explain.test / B114 群の期待更新が仕様の明示範囲内か
6. **受入の逐語照合**＝§8.1〜8.3 の query 文字列・relation・fetch scope

## 出力

検査報告のみ: 指摘（重大度・ファイル:行・根拠・修正案／無ければ「指摘なし」）／観点別結論／
Claude の実測が必要なもの。
