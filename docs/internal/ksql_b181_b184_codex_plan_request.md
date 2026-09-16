# B181〜B184 実装案の検討依頼（codex・調査のみ）

**4 件の起票（B181・B182・B183・B184）について、根本原因の特定・実装案・テスト計画・PR 分割案を報告する。この依頼では実装しない。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b180/dev`・v3.77.0 相当）
上限: 30 分。超えそうなら途中で止めて「どこまで調べたか」を報告する。

## 0. 禁止事項

- git 操作・`src/` の変更・ビルド・テスト実行・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）の変更・MEMORY.md
- kSQL MCP の tool call（headless では承認待ちで止まる）
- エラー本文・警告文の発明（引用は `src/` の文字列を逐語で）
- 起票文書の書き換え（指摘は報告に書く）

## 1. 読むもの

起票文書（事実は実測済み。再導出しない。食い違いがあれば行番号つきで指摘する）:

- [B181 別名の小文字正規化と参照解決の非対称](ksql_b181_alias_lowercase_reference_mismatch_issue.md)
- [B182 `COALESCE` / `ISNULL` で包んだ集計値が静かに間違う](ksql_b182_coalesce_aggregate_silent_wrong_issue.md)
- [B183 MCP の instructions に「kSQL の作り方」を入れる](ksql_b183_mcp_instructions_writing_rules_issue.md)
- [B184 ウィンドウ関数の同一 SELECT 内での集計併用と式内利用](ksql_b184_window_in_same_select_issue.md)

ソースの当たり（Claude が確認済みの起点。ここから追う）:

- B181: `src/parser/parser.ts:5070`（`alias: tok.value.toLowerCase()` と `display`）、`src/execute.ts:4163-4175`（`unknown field code(s)`）、`ORDER_KEY_UNRESOLVED` の発生箇所、CTE / 一時テーブルの列解決（`schema source: SELECT output of statement N` を作る経路）
- B182: `src/engine/evalFunc.ts:412-419`（`COALESCE` / `ISNULL` / `NULLIF` が文字列を返す）、ORDER BY・ウィンドウ ORDER BY の型決定（言語リファレンス §10「型を確定できない式・一時列も既定は文字列」に対応するコード）、算術式の中で関数に包まれた集計を評価する経路（B119〜B122 の修正箇所と `aggregateDependencyValidation.ts`）
- B183: `src/mcp/index.ts` の `KSQL_MCP_INSTRUCTIONS`（実測 5,722 文字）と `src/mcp/__tests__/statementSyntaxCatalog.test.ts`（カタログ文言をテストで固定している方式）
- B184: `src/parser/parser.ts:1355`（GROUP BY / 集計との併用を拒否）、`parser.ts:342` `WINDOW_RESULT_IN_EXPRESSION_MESSAGE`（式内ウィンドウの拒否）、`src/engine/process.ts` の `applyGroupBy` → `applyHaving` → `applyWindow`（1323〜）→ `applyDistinct` → `applyOrderBy` → `project` の順序、`resolveWindowField`

## 2. 各課題で報告すること

1. **根本原因**の行（引用つき）。起票文書の推定（B182 §2・B184 §1）が正しいか
2. **実装案**。最小で純加法のものを第一案に、代替案があれば併記。触るファイルと関数を列挙
3. **テスト計画**。既存テストで壊れるもの（ファイル名）、新規テスト（境界値は桁を変えて両方向。等値比較だけの受入は不可＝B119〜B122 の教訓）、「文書の助言をそのまま実行するテスト」を 1 本ずつ
4. **互換性リスク**。プラグインは EXPLAIN エンジンをバンドルするため文言変更が波及する。Dashboard は結果列名に依存する。CLI / MCP / `/flow` の出力契約（`columns`・`warnings`）に影響するか
5. **規模**（S / M / L と根拠）

## 3. 横断で報告すること

- B181 と B182 の相互作用: 別名の解決と式の型推定は同じ経路か。片方を直すと他方の挙動が変わるか
- B183 の「Writing rules」8 行のうち、B181・B182 を直したら不要になる行と、残す行。文言の修正案があれば
- B184 の脱糖が B182 の型推定に依存するか（隠しウィンドウ列の型）。B184 の A（集計併用）と B（式内利用）を分けて出せるか
- 起票文書に書かれていない副作用・見落とし

## 4. PR 分割の推奨

- 1 本にまとめる案と分ける案を比較し、**推奨と理由**を書く。観点: 変更ファイルの重なり、レビューのしやすさ、リリース単位（patch / minor）、失敗時の切り戻し
- 推奨する順序と、各 PR の受入ゲート（`npm test`・`npm run docs:check`・`npm run version:check`・Claude が実機で確かめる項目）
- 各 PR の見積り（S / M / L）

## 5. 報告の形

最終メッセージ＝報告のみ。Markdown で次の構成:

1. 結論（PR 分割の推奨・順序・規模を 5 行以内）
2. B181 / B182 / B183 / B184 の順に §2 の 5 項目
3. 横断（§3）
4. PR 分割の比較表と推奨（§4）
5. 起票文書との食い違い・見落とし（無ければ「なし」）
6. Claude が実機で確かめるべき残項目

ソースの引用は `ファイル:行` を付ける。推測は推測と書く。
