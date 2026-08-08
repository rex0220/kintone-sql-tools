# B158 修正依頼 1（codex）——最終チェック Major の修正

**[最終チェック報告](ksql_b158_codex_final_check_report.md)の Major 1 件を修正する。
対象ブランチ `b158/dev`。禁止事項は[実装依頼](ksql_b158_codex_impl_request.md) §0 と同じ。**

## 修正内容

**CTE 定義内の CROSS JOIN が CLI dry-run の静的経路（API 0 回）に入らない**
（`src/cli/index.ts` の `hasStaticTypedPushdownCandidate()` WITH 分岐が最終 `query` しか
見ておらず、`ctes` を再帰しない）。

1. CROSS JOIN 検出を **WITH の全 CTE 定義・最終 query・UNION・ネスト SELECT へ再帰**させる
2. 大規模な文単位リファクタは**しない**（最小修正。B157 のバッチ全体判定の意味論は不変）
3. 仕様 §12 の **R17 SQL そのもの（逐語）**で、単文・複文の CLI dry-run e2e を追加:
   - exit 0・`DryRunError` なし
   - **fields / status / process / settings / records の全 API 0 回**（種類別に計数）
   - 診断ブロックと計画本体の表示一致
4. **修正前 fail の確認**＝R17 形 dry-run が修正前は fields API へ到達することを固定してから直す

## 併せて（Low・文書）

台帳 B158 行・issue ステータス行の同期は Claude 工程（触らない）。

## 報告

最終メッセージ＝修正報告のみ（変更箇所・修正前 fail 実測・テスト結果・仕様との差分）。
`npm test` 全体（認証環境変数はプロセス内除外）。
