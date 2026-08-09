# B53 実装依頼（codex）——WITH RECURSIVE / CYCLE（Phase1・4 段階）

**[仕様 R4](ksql_b53_recursive_cte_cycle_phase1_spec_r3.md)（全決定済み・2026-08-09 確定）のとおり実装する。**
方向はオーナー判断（2026-08-09）＝実装着手決定。B160（§10）・B165（形 2 診断＋レシピ）を同梱。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b53/dev`・v3.65.0 相当）

前提資料:
- [仕様 R4](ksql_b53_recursive_cte_cycle_phase1_spec_r3.md)（正。§12 決着表 1〜16 行がすべての設計決定）
- [事前調査報告](ksql_b53_b160_codex_investigation_report.md)（接続点の file:line）
- [B165 起票](ksql_b165_recursive_cte_diagnostic_issue.md)（Stage 4 同梱・対象は形 2＋レシピに縮小済み）
- BOM fixture: `C:\Users\rex02\Projects\ksql-analytics\docs\internal\BOM\`（実機実測は Claude 側。
  単体テストの期待値として `bom_expected.csv` の代表値・多経路合流の形を mock で再現してよい）

## 0. 禁止事項（従来どおり）

git 操作・version・CHANGELOG・README・release/・台帳・リリース履歴の変更・ビルド
（`prod/js/desktop.js` に触れない）・kSQL MCP・MEMORY.md 禁止。
エラー本文に内部語（`RECURSIVE_CTE_MAX_*` 等の識別子）を出さない。
**公開型への必須プロパティ追加禁止**（`KsqlEngineError` の code union 変更禁止＝仕様 §5.1）。
既存テストの変更は不可（変更が必要と考えた場合は「仕様との差分」として報告し、手を入れない）。

## 1. 段階構成（Stage ごとに実装 → 報告 → Claude レビューで進む。先の Stage を先取りしない）

### Stage 1: パーサ・AST・静的検査（仕様 §2・§7）

- ソフトキーワード 4 語（§7.3 の 6 段階手順・`SET` ハードトークン不変）
- CTE 列名リスト・自己参照の仮登録と失敗時破棄（§7.2 の変更点 1〜7）
- `recursiveSpec` AST・§7.1 の静的拒否全数
- **この Stage では実行しない**＝`WITH RECURSIVE` が実行系へ到達した場合は
  planning error「再帰 CTE はこのビルドでは未実装です」で fail-closed（Stage 2 で差し替え）
- B165 形 2＝CTE 本体の自己参照（`RECURSIVE` なし）への専用診断
  「CTE の定義内から自分自身を参照しています。自己参照には `WITH RECURSIVE` が必要です」
  もこの Stage で実装（パーサ領域のため）。`code` は `PARSE_ERROR` 維持
- テスト: §7.3 の専用パーサテスト全数＋§9.3 の静的拒否分＋B165 受入 1〜4

### Stage 2: 静的型推論器・実行エンジン（仕様 §3・§4・§5.1・§6）

- seed／再帰項の静的型推論器（§3.4。fail-closed・未知型を string にしない）
- 戦略 B: source 完全実体化（§4.2 の押し下げ制約・§4.3）・frontier 反復・§4.4 の UNION 共有 helper 統一・§4.5 接続
- path スコープ CYCLE（§3.2・global visited 禁止）・3 境界カウンタ（§5.1 の計測点）
- 専用エラー `RecursiveCteLimitError`（構造化プロパティ・`EXECUTION_ERROR` 写像・§5.1）
- 空キー案 b の実行時警告（§4.6・両側空値到達の最初の反復で 1 件・重複抑止）
- テスト: §9.2 正例・§9.3 境界/負例の全数（BOM 多経路合流・diamond・A→B→C→A 循環を mock で）

### Stage 3: 設定配管・EXPLAIN・dry-run（仕様 §5.2・§8・§9.1・§9.4）

- 3 設定値の全面配管（§5.2 の全接続点＝`maxRecords` と同等）・positive safe integer 検証
- EXPLAIN 表示（§9.1・empty-key runtime check 行を含む）・8 経路（§9.4）・record API 0 回
- plugin UI 3 項目（localStorage 同名 camelCase）※ビルドは Claude 側
- テスト: §9.4 全経路＋§9.5 の面一致

### Stage 4: B160 文言・B165 レシピ・文書同期（仕様 §10・§13）

- B160: 免除文言の一般化（§10.2。**集約キー全含みを肯定例として明示**＝§15 付記 2・
  「無視できる条件」を第 1 文に＝§15 付記 1）・8 assertion site／10 ケース更新（§10.6）
- B165 案 B: 固定深さ自己 JOIN レシピ＋再帰 CTE レシピ（掲載 SQL は `ksql_validate` を通す）
- 文書同期: §13.1〜§13.8 のチェックリスト全数（言語リファレンス 2 箇所・MCP instructions・
  文型カタログ・tool schema・plugin spec・境界既定値の B136 型パリティテスト 1 本）
- テスト: §10.6 の追加受入・§13.8 パリティ

## 2. 各 Stage の報告形式（従来どおり）

最終メッセージ＝実装報告のみ: 変更ファイル・受入（仕様 §番号）↔テストの対応表・
`npm test` 全体の結果（認証環境変数はプロセス内除外）・既存テストとの差分（あれば理由つき・変更はしない）・
仕様との差分（実装できなかった/仕様どおりでない点）・次 Stage への申し送り・Claude 実機残項目。

## 3. Claude 側の工程（参考・codex は行わない)

Stage レビュー・`prod/js/desktop.js` ビルド・BOM fixture（APP4237/4238）実測・
`bom_expected.csv` 394 行との突合・版数/CHANGELOG/リリース・git。
