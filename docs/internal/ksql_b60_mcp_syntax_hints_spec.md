# B60 仕様 — MCP Statement syntax catalog（AI の構文発明を抑止する構文ヒント）

- ステータス: ✅ **v3.14.0 リリース済み（2026-07-22・release PR #214・tag/GitHub Release 公開・npm publish 待ち）。AI 行動検証 両面 PASS（Claude Code×2・Claude Desktop=発端環境・[検証証跡](evidence/b60_syntax_hints_smoke.md)）**
- 起票: [B60 issue](ksql_b60_mcp_syntax_hints_issue.md)
- 種別: 改善（MCP discoverability）／SemVer: **minor**（MCP instructions / tool description＋言語リファレンス §24 の drift 修正のみ・SQL 挙動・schema・resources 不変）
- 関連: **B55**（instructions 全量関数カタログ＝同型解決の前例）／B50
- R1→R2 の主な変更: **R1 自身に発明構文が 2 つあった**（UPDATE FROM の必須 alias 欠落・UPSERT「第1列=キー」は誤りで実際は `ON DUPLICATE (keys)` 必須＝本機構の必要性の生きた証明）。句順/併用規則の明文化（CHECKS→CONTROL・択一・INTO はバッチ専用・APPLY 併用規則）・**不足 family 追加**（SHOW APPS/DESCRIBE/DROP TEMP/サブテーブル DML/APPLY 3 形/REORDER ALL/FROM なし SELECT）・guard を「parse 成功のみ」から **family 全数（型レベル）＋analyzeBatch＋負例**へ強化・EXPLAIN allowlist 化・**言語リファレンス §24 の実 drift（VALIDATE/IMPORT 欠落）を同期修正対象に追加**・completeness 宣言を「family の網羅」へ限定・語数目安 ≤500

## 1. 目的

Claude Desktop 実測: AI が INSERT の `ON ERROR` 構文を知らず発明。機能名と意味論はあるが**文法骨格がどこにも無い**。B55 と同じ機構（常時可視の instructions に一覧＋発明禁止宣言）を文型に拡張する。

## 2. スコープ

1. instructions へ **Statement templates 段落**新設（関数カタログ段落の直前・5 段落構成へ）。
2. `ksql_mutate` / `ksql_query` description へ 1 行テンプレート追記。
3. 行動規範 1 文追記（初出文型は `ksql_docs` で確認・発明禁止）。
4. **言語リファレンス §24 の EXPLAIN 対応一覧へ VALIDATE / IMPORT を追記**（レビューで発見された実 drift の解消）。
5. スコープ外: ParseError への reactive 誘導・resources/prompts・input schema・上記以外の言語リファレンス変更。

## 3. カタログ内容（すべて言語リファレンス・parser と突合済み＝codex 裏取り）

### 3.1 共通記法（段落先頭で一度だけ定義・圧縮の要）

```text
CHECKS  := [CHECK WHEN cond THEN 'msg' [WHEN ...] ]...
CONTROL := [VALIDATE ONLY [INTO #err] | ON ERROR SKIP INTO #err [REJECT LIMIT n]]
```

### 3.2 文型 family（`STATEMENT_SYNTAX_CATALOG` に載せる全量）

| family | 骨格 |
|---|---|
| SELECT | `SELECT [DISTINCT] cols [FROM APPn\|APPn$tbl\|#t [alias] [INNER\|LEFT\|RIGHT JOIN t [alias] ON a.x = b.y]...] [WHERE] [GROUP BY] [HAVING] [ORDER BY\|KORDER BY] [LIMIT n [OFFSET m]]`（FROM 省略可） |
| WITH | `WITH name AS (SELECT\|SHOW APPS\|DESCRIBE ...) [, name2 AS (...)]... SELECT\|UNION ...` |
| UNION | `SELECT ... UNION [ALL] SELECT ...` |
| INSERT | `INSERT INTO APPn (cols) {VALUES (...), ... \| SELECT ...} CHECKS CONTROL` |
| UPDATE | `UPDATE APPn SET col = expr, ... WHERE ... CHECKS CONTROL` |
| UPDATE FROM | `UPDATE APPn SET col = s.col, ... FROM #t\|APPm [AS] s WHERE APPn.key = s.key [AND 対象条件] CHECKS CONTROL`（**ソース alias 必須・AS のみ省略可・結合はターゲット列=ソース列の単一等値をトップレベル AND に**） |
| UPSERT | `UPSERT INTO APPn (cols) {VALUES ... \| SELECT ...} ON DUPLICATE (key[, key]...) CHECKS CONTROL`（**`ON DUPLICATE` 必須・複合キー可**） |
| DELETE | `DELETE FROM APPn WHERE ...` |
| サブテーブル DML | `INSERT INTO APPn$tbl (_pid, cols) VALUES ...`・`UPDATE APPn$tbl SET ... WHERE _pid = ... [AND _rid = ...]`・`DELETE FROM APPn$tbl WHERE ...`（CHECK/CONTROL 非対応） |
| APPLY（3 形・骨格のみ） | `UPDATE ... WHERE ... APPLY tbl (ops) [APPLY ...] [VALIDATE ONLY]`・`INSERT ... VALUES ... APPLY tbl (ops) [VALIDATE ONLY]`・`UPSERT ... ON DUPLICATE (...) [ON INSERT APPLY tbl (ops)] [ON UPDATE APPLY tbl (ops)] [VALIDATE ONLY]`（詳細は ksql_docs 誘導・MCP は mutation 拒否＝validate/EXPLAIN/VALIDATE ONLY は可） |
| VALIDATE | `VALIDATE APPn [(fields)] [SUMMARY] [WHERE ...] CHECKS [INTO #err]` |
| IMPORT | `IMPORT [UPDATE] INTO APPn (cols\|tbl(children)) FROM CSV\|JSON name [options...]`（詳細は ksql_docs 誘導） |
| temp table | `CREATE TEMP TABLE #t AS (SELECT ... \| WITH ...)`・`DROP TEMP TABLE #t` |
| 変数 | `SET @x = scalar_expr \| (SELECT ...) \| ['a', ...]`・`DECLARE @x = default` |
| ASSERT | `ASSERT operand op operand \| ASSERT operand BETWEEN a AND b` |
| REORDER | `REORDER APPn$tbl BY ... WHERE ...`・`REORDER ALL APPn$tbl BY ...` |
| SHOW / DESCRIBE | `SHOW APPS`・`DESCRIBE\|DESC APPn` |
| EXPLAIN | `EXPLAIN (SELECT\|WITH\|INSERT\|UPSERT\|UPDATE\|DELETE\|REORDER\|VALIDATE\|IMPORT) ...`（**allowlist**・SHOW/DESCRIBE/temp/SET/DECLARE/ASSERT は不可） |

### 3.3 共通注記（カタログ末尾・固定文）

```text
CHECKS precedes CONTROL. VALIDATE ONLY and ON ERROR SKIP are mutually exclusive.
INTO #err requires a multi-statement batch (ON ERROR SKIP always; VALIDATE ONLY / VALIDATE only when INTO is used).
APPLY may precede VALIDATE ONLY but cannot combine with CHECK or ON ERROR SKIP.
Subtable DML does not accept CHECKS/CONTROL.
These are all supported top-level statement families. Bracketed clauses are schematic;
before first use, verify the referenced ksql_docs section. Do not invent other statement
families or clause orders.
```

（completeness 宣言は「**family の網羅**」に限定＝IMPORT/APPLY の完全文法は `ksql_docs` へ誘導する方針と両立・codex P2-1 採用）

## 4. 機械的 guard（R1 の「parse のみ」から強化）

`src/mcp/statementSyntaxCatalog.ts` を**専用 module** として新設（codex P2-2 採用・docs map とは責務が別）:

1. **family 全数保証（コンパイル時）**: `type StatementSyntaxId = "select" | "with" | ... `（§3.2 の全 family）を列挙し、`STATEMENT_SYNTAX_CATALOG` を `satisfies Record<StatementSyntaxId, Entry>` で定義。entry の削除は**型エラー**で検出（R1 の「削除してもテストが通る」穴を閉じる）。
2. **Entry 構造**: `{ template, examples, expectedTypes, capabilities?, batch? }`。
3. **契約テスト**:
   - 全 example を `parseSqlStatements` で受理（**IMPORT は `{ import: true }` capability 付き**）＋`expectedTypes` と AST type の一致 assertion。
   - `batch: true` の example（ON ERROR SKIP・`VALIDATE ONLY INTO`・`VALIDATE ... INTO`・SET/DECLARE/temp 連携）は **`analyzeBatch` まで通す**（Parser 単体は ON ERROR を受理し、バッチ専用性は analyzer 検査＝batch.ts:228。example は temp 定義を含む自己完結バッチにする＝`#source` 未定義エラー回避）。
   - **負例**: 単文 ON ERROR／単文 `VALIDATE ONLY INTO`／単文 `VALIDATE ... INTO`／APPLY×CHECK 併用／APPLY×ON ERROR 併用が**拒否される**ことを固定。
   - instructions 出力に catalog の各 template が**ちょうど 1 回・定義順**で現れる。
4. instructions 語数: **実装後の実測値へ exact 再固定＋上限 assertion（≤500 語目安・550 超は再圧縮）**。段落数 guard 4→5。
5. smoke: mcp-smoke / pack-smoke の代表語へ `Statement templates`・`ON ERROR SKIP INTO` 追加。**mcpb-verify の launcher 検証へ `getInstructions()` の代表語確認を追加**（現状 instructions を見ておらず stale MCPB を検出できない＝codex P3-1）。

## 5. tool description（codex P2-3 採用）

- `ksql_mutate`: 共通 DML tail テンプレート（`{VALUES|SELECT} CHECKS → [VALIDATE ONLY [INTO #err] | ON ERROR SKIP INTO #err [REJECT LIMIT n]]`・INTO はバッチ専用の一文つき）。
- `ksql_query`: **read-only 構文に限定**＝`VALIDATE ONLY [INTO #err]` と先頭文 `VALIDATE ... [INTO #err]` のみ（ON ERROR は載せない）。

## 6. 受入条件

1. §4 の契約テスト全 green（family 全数・parse＋expectedTypes・analyzeBatch・負例・instructions 出力一致）。
2. UPSERT example は必ず `ON DUPLICATE` を含む・UPDATE FROM example は alias とソース修飾列を含む・APPLY example は VALIDATE ONLY で通り CHECK/ON ERROR 併用で落ちる・IMPORT example は `{import:true}` で検査。
3. instructions: 5 段落・語数 exact＋上限・代表語。descriptions 追記。mcp-smoke / pack-smoke / **mcpb-verify（instructions 確認込み）** green。
4. 言語リファレンス §24 に VALIDATE / IMPORT 追記（EXPLAIN allowlist と一致）。
5. MCP stdio 実機: initialize 応答の instructions に Statement templates 段落（配線検証）。
6. 非回帰: 全テスト green・関数カタログ段落/既存 guard/`ksql_docs` 不変。
7. spec・issue・tracker の 3 箇所ステータス同期（各マイルストーンで）。
8. **リリース前の AI 行動検証（2 面・ビルド結果を使用）**:
   - **Claude Code（自動化可）**: headless `claude -p` を新ビルド `dist-mcp/ksql-mcp.js` 指定の MCP 設定で起動し、「不正行を隔離しながら INSERT するバッチ」を依頼→ `ON ERROR SKIP INTO #err [REJECT LIMIT n]` を**一発で正しく組み立てる**ことを確認（Claude Code は MCP server instructions をモデルへ提示するクライアント＝本セッションの system prompt で実証済み。**stale server 注意＝常駐サーバーでなく新ビルドを明示指定**）。
   - **Claude Desktop（ユーザー確認）**: 新ビルドの `ksql-mcp.mcpb`（または dist-mcp 指定）で同じ依頼を実施（B55 のデバイスブリッジ経路＝B60 の発端環境での最終確認）。
   - **両面の検証完了までリリース（版数確定・release アセット差し替え）をホールド**する。

## 7. 同期箇所

- `src/mcp/statementSyntaxCatalog.ts`（新設）・`src/mcp/index.ts`（instructions 生成・description 2 箇所）
- 契約テスト（新ファイル）・`metadataTools.test.ts`（語数 exact＋上限・段落数・代表語）
- `scripts/mcp-smoke.mjs` / `mcp-pack-smoke.mjs`（代表語）・`scripts/mcpb-verify.mjs`（getInstructions 検証追加）
- `docs/ksql_language_reference.md` **§24 のみ**（VALIDATE/IMPORT 追記）
- `CHANGELOG.md` 未リリース見出し・tracker / issue / spec ステータス行・実機 evidence

## 8. 解決済み論点

- R1-Q1: **専用 module `statementSyntaxCatalog.ts` から生成**（codex 推奨採用）。
- R1-Q2: **`ksql_query` は read-only 構文（VALIDATE ONLY / VALIDATE）のみ**（codex 推奨採用）。
- R1-Q3: template トークン⇔example の機械照合は v1 見送り。ただし **family 全数 guard（型レベル）と expectedTypes は v1 必須**（codex 指摘採用＝completeness 宣言の根拠）。


> **【2026-07-27 追記】本書が定めた「語数目安 ≤500・550 超は再圧縮」には根拠の記録が無い。**
> [B81 §7](ksql_b81_mcp_instructions_word_budget_issue.md) の調査で、MCP 仕様にも SDK にも
> instructions のサイズ規定が無いこと、実コストが毎セッション約 1,000 トークンで
> 無視できる水準であることを確認した。上限は**守るべき制約ではなく、変化を検知するトリガー**として扱う。
