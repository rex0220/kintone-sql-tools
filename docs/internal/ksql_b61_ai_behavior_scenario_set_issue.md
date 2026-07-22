# B61 — AI 行動検証シナリオセットの拡充（B60 の継続運用）

- 起票日: 2026-07-22
- ステータス: 📝 **起票＋シナリオ台帳の2 ラウンド実施済み（2026-07-22・Claude Code 面 計 11 シナリオ 11/11 PASS＝DML 系 5＋SELECT/JOIN・オプション組合せ 6・[証跡](evidence/b61_scenario_smoke_claude_code.md)。構文発明ゼロ。**Q6 で改善候補 2 件を観測＝@変数の使用可能位置の可視性**（算術オペランド不可・SET 右辺の変数参照不可が読み取れず各 1 回自己修正）。残=変数制約の注記強化検討・スクリプト半自動化・Desktop 面・失敗観測ループの運用化）**
- 種別: 改善（品質保証・MCP discoverability の継続運用）
- 効果種別: 機能（AI クライアントの SQL 組み立て精度の面的担保）
- 関連: **B60**（Statement syntax catalog＝検証対象・[evidence](evidence/b60_syntax_hints_smoke.md)）／B55（関数カタログ）

## 1. 背景・課題

B60 の AI 行動検証は **「INSERT＋ON ERROR SKIP」の 1 シナリオのみ**（Claude Code ×2＋Claude Desktop ×1＝回数であってシナリオは 1 つ）。カタログは 18 文型あるが、AI が正しく読めるかを行動レベルで確認したのは一部に留まる。

**保証の非対称**が本質:

- 機械 guard（parse 契約・satisfies・負例）が保証するのは「**カタログが正しい**」ことまで
- 「**AI がカタログを正しく読める**」ことは行動検証でしか分からない。実際、B60 検証中に `AS(SELECT...)` のグルーピング括弧をリテラルと誤読する摩擦が見つかり表記修正した＝**同種の摩擦は他の文型にも潜在している**と考えるべき（教訓「1 例が通っても組み合わせは網羅されない」）

## 2. 改善案

### 2.1 シナリオ台帳（文型×依頼パターン）

自然言語依頼→期待される構文要素、の組を検証セット化する。初期候補:

| シナリオ（依頼の趣旨） | 期待される構文要素 | 対象文型 |
|---|---|---|
| 重複キーは更新・新規は追加で取り込んで | `UPSERT ... ON DUPLICATE (key)`（**ON DUPLICATE を発明せず必須と知っているか**） | UPSERT |
| 別アプリ/一時テーブルの値で一括更新して | `UPDATE ... SET col = s.col FROM #t AS s WHERE 対象.key = s.key`（**ソース別名**） | UPDATE FROM |
| テーブル（サブテーブル）ごと検証だけして | `... APPLY tbl (ops) VALIDATE ONLY`（MCP では mutation 不可の理解込み） | APPLY |
| CSV を取り込んで（検証だけ） | `IMPORT INTO ... FROM CSV name ... VALIDATE ONLY`＋importSources の理解 | IMPORT |
| 既存レコードの制約違反を洗い出して #err に残して | `VALIDATE app ... INTO #err`（バッチ専用の理解） | VALIDATE |
| 不正行を隔離して INSERT（既存＝回帰用） | `ON ERROR SKIP INTO #err [REJECT LIMIT n]` | INSERT（B60 第 1 号） |

### 2.2 運用ループ

1. **headless 実行の半自動化**: B60 で確立した `claude -p ＋ 新ビルド明示 --mcp-config` をシナリオ台帳でループするスクリプト化（判定＝期待構文要素の出現＋ksql_validate ok。完全自動判定が難しい場合は出力保存＋人手確認でも可）
2. **失敗→シナリオ追加**: 実利用で構文ミスが観測されたら、その再現プロンプトを台帳へ追加（B60 の ON ERROR SKIP が第 1 号）
3. **リリースゲート**: カタログ・instructions・description を変えるリリースでは台帳を再実行

### 2.3 論点

- 判定の自動化度（構文要素の grep で足りるか・LLM 出力の揺れへの頑健性）
- 実行コスト（シナリオ数×headless 実行時間）と頻度（毎リリース vs instructions 変更時のみ）
- モデル依存性（Claude Code の既定モデルと Desktop のモデル差・弱いモデルでの成立が強い保証になる）

## 3. 次アクション

- 実需・優先度の確認 → 仕様 R1（シナリオ台帳の初期セットとスクリプト設計）→ 実装。B60 同様、失敗観測が起点になった時点で優先度を上げる。
