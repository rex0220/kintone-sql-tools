# B183 実装報告（codex・2026-09-16）

- 依頼: [ksql_b183_codex_impl_request.md](ksql_b183_codex_impl_request.md)
- 起票: [ksql_b183_mcp_instructions_writing_rules_issue.md](ksql_b183_mcp_instructions_writing_rules_issue.md)
- 作業ブランチ: `b183/dev`（B181 コミット 0580bbc の上）
- 末尾に Claude のレビュー節（文言の修正 2 点・テストの修正 2 点・実測）を追記

---

## 変更ファイル一覧

- `src/mcp/index.ts:95` — `Key rules` 直後に Writing rules 8 行を追加
- `src/mcp/__tests__/b183WritingRules.test.ts:1` — B183 受入テストを新規追加
- `src/mcp/__tests__/metadataTools.test.ts:127` — instructions の実測値、文字数、上限、段落数を改定
- `docs/ksql_mcpb_claude_desktop_install.md:185` — Writing rules と正本を案内する 2 文を追加

## 追加した Writing rules の全文（codex 版）

```text
Writing rules (learned from real failures):
- Check field codes with ksql_describe_app first. "コピー元: YES" identifies lookup copy targets.
- INNER JOIN: put the side you filter with WHERE (or the smaller side) in FROM; the join-key prefilter flows only FROM -> JOIN target. LEFT/RIGHT JOIN disables it on both sides; materialize the filtered side into a temp table first.
- Date conditions: use relative-date functions or literal half-open ranges in WHERE; never wrap the column (DATE_FORMAT/YEAR) in WHERE. Relative-date functions are WHERE-only; use CURRENT_DATE() in SELECT.
- Empty cells are '' (there is no NULL). Zero-fill with CASE WHEN x = '' THEN 0 ELSE x END and guard a zero denominator with CASE WHEN total = 0. COALESCE/ISNULL keep numeric semantics only when every argument is numeric.
- Aggregates and window functions cannot share a SELECT, and a window result cannot be used in an expression of the same SELECT: split stages with WITH or temp tables. Running totals: ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW plus a tie-break on the key.
- Column aliases are lowercased in result names while physical field codes keep their case; later stages may reference an alias by either spelling. Do not alias a physical field to its own name when its original spelling must stay the output name.
- Output only the requested columns; do not add ORDER BY, LIMIT, or filters that were not asked for. Rank with RANK() unless told otherwise.
- After writing: ksql_validate, then ksql_explain; report the fetch summary and reason lines. State assumptions as assumptions.
```

## 裏づけ表（行 ↔ 節）

| 行 | 裏づけ |
|---|---|
| 1. フィールドコード／コピー元 | `docs/ksql_language_reference.md` §14「SHOW APPS / DESCRIBE」→「DESCRIBE / DESC — フィールド一覧取得」 |
| 2. JOIN の向き／prefilter | 同 §7「JOIN」→「INNER JOIN」→「結合キーによる取得範囲の絞り込み」 |
| 3. 日付条件 | 同 §6「WHERE 句」→「日時フィールドの境界」「相対日付関数」「WHERE の REST 押し下げ」、§5 の `CURRENT_DATE()` |
| 4. 空値／0埋め／数値意味型 | 同 §3「算術の精度と空セル」、§5「文字列・数値関数」の `COALESCE` / `ISNULL` / `NULLIF`、§10 の数値意味型、`docs/ksql_batch_recipes.md` R17 |
| 5. 集計・window の段分け／累計 | 同 §10.1「ウィンドウ関数」、`docs/ksql_batch_recipes.md` R14・R15・R16 |
| 6. 別名 | 同 §1「大文字・小文字」 |
| 7. 出力列／順位 | 同 §2「特定フィールド指定」、§6「WHERE」、§10「ORDER BY」、§11「LIMIT / OFFSET」、§10.1 の `RANK` |
| 8. validate → explain | 同 §24「EXPLAIN」→「出力の読み方」、`docs/ksql_batch_recipes.md` R2「確認手段の役割分担」 |

弱めた箇所:

- 第1行の元案 `JOIN keys are usually the record number and the lookup copy target` は削除。公開リファレンスは `コピー元: YES` の意味までは保証しますが、一般に「通常の JOIN キー」であることまでは規定していないためです。
- 第4行は `guard a denominator` を `guard a zero denominator` に限定。空文字の分母は `= 0` では捕捉できず、§5 が `= '' OR = 0` を要求しているためです。

## 予算テストの改定内容

| 項目 | 旧 | 新 |
|---|---:|---:|
| total 実測 | 663 | 922 |
| catalog 実測 | 347 | 347 |
| prose 実測 | 316 | 575 |
| instructions 文字数 | 5,722 | 7,304 |
| 段落数 | 6 | 7 |
| prose 上限 | 320 | 635 |
| catalog 上限 | 420 | 420 |
| total 上限 | 700 | 1,015 |

Writing rules による増加は259語、1,582文字です。上限は新しい実測値に約1割の余裕を置き、「次に妥当性を再検討するトリガー」としました。

コメントには起票時の根拠である、instructions 約5,722→約6,900文字・約20%増、13ツールのスキーマ31,054文字を含む固定コンテキスト全体では約3%増という測定も記載しました。

## 追加・変更したテストと結果

追加した `b183WritingRules.test.ts`:

- 見出しと8規則の識別句がそれぞれ1回だけ存在
- 裏づけとなる公開文書の見出しが実在
- Writing rules の各文が構文・関数カタログ本文と重複しない
- 0埋め、ゼロ除数ガード、`RANK()`、明示 `ROWS` を含むSQLをmock clientで実行
- NUMBER列の `2` と `10` が数値順になり、順位・比率・累計が期待値どおりになることを確認

変更した `metadataTools.test.ts`:

- exact語数、文字数、上限、段落数を更新
- B183の増加理由と固定コンテキストへの影響をコメント化

指定回帰テスト:

```text
Test Suites: 5 passed, 5 total
Tests:       53 passed, 53 total
Snapshots:   1 passed, 1 total
```

`npm run docs:check`:

```text
[docs-check] ok（リンク 3929 件 / 台帳 16 行）
```

`npm test`:

```text
Test Suites: 300 passed, 300 total
Tests:       6509 passed, 6509 total
Snapshots:   23 passed, 23 total

Test Suites: 2 passed, 2 total
Tests:       26 passed, 26 total
Snapshots:   0 total
```

合計: 302 suites、6,535 tests 通過、失敗0。

## 文書の差分

追記した全文:

```text
接続時の instructions には、実測で判明した失敗を避けるための Writing rules 8 行が含まれる。
全文の正本は `src/mcp/index.ts` の `KSQL_MCP_INSTRUCTIONS` とする。
```

## §4 の確認結果

1. 8行の裏づけ節
   上記「裏づけ表」のとおり。第1行と第4行のみ公開仕様の範囲へ弱めました。

2. 予算
   実測は `total=922 / catalog=347 / prose=575 / 7,304文字 / 7段落`。上限は `total≤1,015 / catalog≤420 / prose≤635` です。

3. Key rules との重複・矛盾
   同一文の重複はありません。「empty numeric cells become 0 in arithmetic」は算術評価時の変換、「Empty cells are ''」は元のセル値を表すため、両者は矛盾しません。

4. instructions の返却経路
   `KSQL_MCP_INSTRUCTIONS` は `McpServer` の生成オプションにだけ渡され、initialize 応答で返ります。resources と `ksql_docs` は言語リファレンス／レシピを返す別経路であり、Writing rules 全文は返しません。

## Claude が実機で確かめるべき残項目

- Claude Desktop + 新しいMCPで、第3回の依頼文を前置きなしで before/after 各3回実行
- 別名、`COALESCE`、`RANK`、総計0ガードの改善を比較
- 第1回・第2回の依頼文でも JOIN の向き、WHERE の日付、0埋めをbefore/after比較
- initialize 応答に新しい Writing rules が含まれることを実接続で確認

## 上限内に終わらなかった項目

実装・自動テスト・文書検査に未完了項目はありません。上記の実機確認のみ、禁止されたビルドおよびMCP tool callを必要とするためClaudeへの引継ぎです。

---

## Claude レビュー（2026-09-16）

### 1. 文言の修正 2 点（言語リファレンスの保証範囲に揃える）

| 行 | codex 版 | 修正後 | 理由 |
|:-:|---|---|---|
| 4 | `guard a zero denominator with CASE WHEN total = 0` | `guard a denominator with CASE WHEN total = '' OR total = 0 (LEFT JOIN misses and empty aggregates yield '')` | codex は「§5 が `= '' OR = 0` を要求している」と正しく指摘しながら、規則を `= 0` だけに**弱める**方向へ直していた。§5「除数の空文字」は `LEFT JOIN` の不一致側・0 件の `MIN` / `MAX`・`NULLIF` の結果が `''` になり `= 0` では `NaN` がすり抜けると明記している。番外編の ABC 分析（総計 0 のガード）も `LEFT JOIN` 起点なので、規則は §5 の推奨形そのものにした |
| 2 | `LEFT/RIGHT JOIN disables it on both sides; materialize the filtered side into a temp table first.` | `the join-key prefilter flows only FROM -> JOIN target and applies only to INNER JOIN. With LEFT/RIGHT JOIN, materialize the filtered side into a temp table first.` | §7「結合キーによる取得範囲の絞り込み」は **`INNER JOIN` の場合**に絞り込むとだけ書いており、「LEFT/RIGHT で両側とも無効」とは書いていない（KLIKE の節の `LEFT JOIN` 拒否は別件）。裏づけられる「INNER JOIN のみ」に弱め、対処（一時テーブルへ実体化）は残した |

弱めた第 1 行（「JOIN キーは通常レコード番号とコピー元」を削除）は妥当。第 3・5〜8 行は裏づけ節を確認して据え置き。

### 2. テストの修正 2 点

- `metadataTools.test.ts` の `expect(instructions).toHaveLength(7304)` を**削除**。語数の exact 固定が既にあり、文字数固定は版数文字列の桁や改行コードで壊れるだけで検知力を足さない（実測でも codex の 7,304 に対し bundle 経由の initialize 応答は 7,301 と一致しなかった）。語数の exact は文言修正後の実測 `{ total: 935, catalog: 347, prose: 588 }` に更新し、コメントに修正の経緯を追記。上限（prose ≤ 635・total ≤ 1,015・段落 7）は codex の根拠のまま
- `b183WritingRules.test.ts` の fixture を規則の最終文面に揃え、**分母が `''` の行**（`key: "D", total: ""`）を追加。`= 0` だけのガードでは捕まらないケースを規則どおりの SQL（`CASE WHEN total = '' OR total = 0`）が 0 にすることを固定

### 3. 実測（`npm run build:mcp` 後の bundle に initialize を送って採取）

| 項目 | v3.77.0 | 修正後 |
|---|---:|---:|
| instructions 文字数 | 5,722 | 7,369 |
| 概算トークン（/4） | 約 1,430 | 約 1,840（+29%） |
| Writing rules 段落 | — | 1,645 文字 |
| ツールスキーマ 13 本 | 31,054 | 31,054（不変） |
| MCP 固定コンテキスト合計 | 36,776 | 38,423（+4.5%） |

起票時の見積り（+20%・全体 +3%）より少し大きい。§5 の推奨形と INNER JOIN の限定句を足したぶんで、許容範囲と判断。

### 4. 結果

- `npm test`（Claude 実行・修正後の最終）: 300 suites / 6,509 tests passed、サブプロセス 2 suites / 26 passed、snapshots 23、`docs:check` 通過（文書更新後の再実行でリンク 3,933 件）
- 残項目（リリース後）: Claude Desktop + 新 MCP で第 3 回の依頼文を前置きなしで 3 回（番外編 §4 の before/after）。第 1 回・第 2 回の依頼文も同様
