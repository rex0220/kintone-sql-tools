# B60 — MCP 構文ヒント（Statement syntax catalog）: AI が kSQL 構文を発明せず正しく組み立てられるように

- 起票日: 2026-07-22
- ステータス: ✅ **v3.14.0 リリース済み（2026-07-22・release PR #214・tag/GitHub Release 公開・npm publish 待ち）。AI 行動検証 両面 PASS（Claude Code×2・Claude Desktop=発端環境・[検証証跡](evidence/b60_syntax_hints_smoke.md)）**
- 種別: 改善（MCP discoverability・B50/B55 の後続）
- 効果種別: 機能（AI クライアントの SQL 組み立て精度・リトライ削減）
- 関連: **B55**（instructions 全量関数カタログ＝同型の解決の前例・実機でプローブ行動消滅を実証）／**B50**（MCP discoverability）

## 1. 事象（2026-07-22・Claude Desktop 実測）

Claude Desktop（MCP 経由）が **INSERT の `ON ERROR` 構文を知らず**、正しい `ON ERROR SKIP INTO #err [REJECT LIMIT n]` を組み立てられなかった。

## 2. ギャップの構造（B55 と同型・調査済み）

| 層 | 現状 | 欠落 |
|---|---|---|
| instructions | `ON ERROR SKIP` を**機能名として列挙**（第1段落の能力索引） | 名前のみ・文法なし |
| `ksql_mutate` description | 意味論は散文で説明（「Tier-0 検証失敗を隔離し…」） | **文中のどこに置くかの構文骨格が無い** |
| `ksql_docs` | 言語リファレンス該当章に構文はある | 組み立て前に読む行動導線が弱い（現在は VALIDATE ONLY 誘導のみ） |

B55 前は「関数の存在を知らない→validate 総当たりで推定」。今回は「**機能の存在は知っているが文法を知らない→構文を発明**」＝同じ穴の構文版。B55 は instructions への全量カタログ掲載でプローブ行動が消えることを実機実証済み＝**ヒントは効く**。

## 3. 改善案（多層・優先順）

1. **instructions へ「Statement syntax catalog」段落**（本命）: 全文型の構文骨格を圧縮表記で掲載。Claude Desktop は resources 不可・tools 一択のため常時可視の instructions が唯一確実なチャネル。「complete」の明言で構文の発明を抑止。
2. **`ksql_query` / `ksql_mutate` description へ 1 行構文テンプレート**: 使う瞬間に見える的を絞ったヒント。
3. **行動規範の追記**: 「DML を組み立てる前に `ksql_docs` の該当章で構文を確認する」。
4. **（スコープ外・次段候補）** ParseError への `ksql_docs` section キー誘導（reactive）: エラー envelope バイト互換 guard との調整が必要なため別課題。

## 4. 設計上の要点

- **構文の発明禁止はこの課題自身にも適用**: カタログの各骨格は言語リファレンスから転記し、**対応する canonical SQL 例をパーサ受理テストで固定**（「カタログに載る構文は必ず parse が通る」）＝関数カタログの三者 drift guard に相当する機械的 guard。
- instructions 語数 guard（現 277 語 exact）の再設計・smoke 代表語（`ON ERROR SKIP` 等）追加。
- SQL 挙動・resources・schema は不変（MCP 文書面のみ）＝SemVer minor。

## 5. 次アクション

- 仕様 R1 → codex レビュー → 実装 → MCP stdio 実機（instructions 提示確認）→ Claude Desktop 実機（INSERT＋ON ERROR SKIP の一発組み立て＝ユーザー確認）。
