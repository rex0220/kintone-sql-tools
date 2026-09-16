# B183 実装依頼（codex）

**MCP の instructions（`src/mcp/index.ts` の `KSQL_MCP_INSTRUCTIONS`）に「Writing rules」段落を追加し、依頼文に貼らなくても既知の落とし穴（JOIN の向き・WHERE の日付・0 埋め・段の分割・別名・依頼された列だけ・validate → explain）を避けさせる。[起票文書](ksql_b183_mcp_instructions_writing_rules_issue.md) §2・§2.1 と [実装案の検討報告 §4・§6](ksql_b181_b184_codex_plan_report.md) のとおり実装する。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（作業ブランチ `b183/dev`・B181・B182 修正済みの HEAD）
上限: 1 PR・1.5 時間。超えそうなら途中で止めて「どこまで実装したか・どのテストが未着手か」を報告する。

## 0. 禁止事項（従来どおり）

git 操作（コミットは Claude）・version・CHANGELOG・README・release/・台帳（`docs/ksql_issue_tracker.md`）・起票文書の変更・ビルド（`prod/js/desktop.js` に触れない）・kSQL MCP の tool call・MEMORY.md 禁止。
**エンジン（`src/execute.ts`・`src/engine/`・`src/parser/`・`src/core/`）に触れない。ツールの description・inputSchema・resources を変えない。** 既存の構文カタログ（`STATEMENT_SYNTAX_PARAGRAPH`）と関数カタログ（`FUNCTION_CATALOG_PARAGRAPH`）の本文を変えない。

## 1. 決まっていること（レビュー対象外）

### 1.1 入れるもの

- `KSQL_MCP_INSTRUCTIONS` の「Key rules」段落の**直後**に、独立した段落「Writing rules (learned from real failures):」を追加する。英語・1 規則 1 行・行頭 `- `。既存の Key rules 4 点（LIKE の JS 評価・JOIN ON 1 本・派生テーブル不可・空数値セルは算術で 0）はそのまま残す（Writing rules と重複させない。矛盾する言い回しにしない）
- 規則は次の 8 行を**出発点**にする（起票文書 §2 の候補を、B181・B182 修正後の仕様に合わせて §2.1 の codex 案で書き換えたもの）。**各行の主張を `docs/ksql_language_reference.md`（必要なら `docs/ksql_batch_recipes.md`）の該当節で裏づける**。裏づけられない主張は削るか、裏づけられる範囲に弱める。裏づけ節は報告に行ごとに書く

```text
Writing rules (learned from real failures):
- Check field codes with ksql_describe_app first. JOIN keys are usually the record number and the lookup copy target ("コピー元: YES").
- INNER JOIN: put the side you filter with WHERE (or the smaller side) in FROM; the join-key prefilter flows only FROM -> JOIN target. LEFT/RIGHT JOIN disables it on both sides; materialize the filtered side into a temp table first.
- Date conditions: use relative-date functions or literal half-open ranges in WHERE; never wrap the column (DATE_FORMAT/YEAR) in WHERE. Relative-date functions are WHERE-only; use CURRENT_DATE() in SELECT.
- Empty cells are '' (there is no NULL). Zero-fill with CASE WHEN x = '' THEN 0 ELSE x END and guard a denominator with CASE WHEN total = 0. COALESCE/ISNULL keep numeric semantics only when every argument is numeric.
- Aggregates and window functions cannot share a SELECT, and a window result cannot be used in an expression of the same SELECT: split stages with WITH or temp tables. Running totals: ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW plus a tie-break on the key.
- Column aliases are lowercased in result names while physical field codes keep their case; later stages may reference an alias by either spelling. Do not alias a physical field to its own name when its original spelling must stay the output name.
- Output only the requested columns; do not add ORDER BY, LIMIT, or filters that were not asked for. Rank with RANK() unless told otherwise.
- After writing: ksql_validate, then ksql_explain; report the fetch summary and reason lines. State assumptions as assumptions.
```

- 「別名」行と「COALESCE」行は **B181・B182 修正後の仕様を書く**（回避策「別名に英字を使わない」「集計を COALESCE で包まない」は書かない）。B181 の仕様は言語リファレンス §1「大文字・小文字」（混在 JOIN で物理フィールドと同名なら物理が勝つ、を含む）、B182 の仕様は §5 の `COALESCE` / `ISNULL` / `NULLIF` 行と §10 の 1 文
- 「段の分割」行は B184 完了まで残す（B184 の範囲には手を出さない）
- 日本語版は置かない（instructions は英語で統一）

### 1.2 予算テストの改定（`src/mcp/__tests__/metadataTools.test.ts:118-141`）

- exact 固定 `{ total: 663, catalog: 347, prose: 316 }` は**実測値に更新**し、コメントに「B183: Writing rules 8 行を追加（+N 語）」と経緯を足す（既存コメントの B62 → B76 → … の系列に続ける）
- 上限 `prose ≤ 320`・`total ≤ 700`・段落数 6 は**根拠つきで改定**する（機械的に上げない）。根拠は起票文書 §2 の実測: 現行 instructions 5,722 文字（約 1,430 トークン）、追加後 約 6,900 文字（約 1,730 トークン）で +約 20%。同じ接続で常時渡る 13 ツールのスキーマ 31,054 文字（約 7,800 トークン）を含む MCP 固定コンテキスト全体では +3% 程度。この数字をテスト内コメントに書き、新しい上限は「次に再検討するトリガー」として実測値 + 1 割程度に置く（`catalog ≤ 420` は据え置き）。段落数は 7
- テスト内コメントの「超えたら妥当性を再検討するトリガー」の思想（B81 §7）は残す

## 2. テスト（受入）

新規 `src/mcp/__tests__/b183WritingRules.test.ts`（または `metadataTools.test.ts` への追加）に少なくとも次を入れる:

- 8 規則それぞれの識別句（例: `Writing rules (learned from real failures):`・`ksql_describe_app first`・`join-key prefilter flows only FROM`・`Relative-date functions are WHERE-only`・`there is no NULL`・`cannot share a SELECT`・`lowercased in result names`・`Output only the requested columns`・`ksql_validate, then ksql_explain`）が instructions に **1 回ずつ**含まれる（`statementSyntaxCatalog.test.ts:77-79` と同じ「1 回だけ」の判定）
- 各規則が指す言語リファレンスの節見出し（§1 大文字・小文字、§5 の該当関数、§7 JOIN の prefilter、§10 型、相対日付の節、ウィンドウの節、レシピの 0 埋め R17 など。報告の裏づけ表と同じもの）が `docs/ksql_language_reference.md` / `docs/ksql_batch_recipes.md` に**実在**する（見出し文字列で検査）
- Writing rules の各行が構文カタログ・関数カタログの文と**重複しない**（カタログ本文に同じ文が無い）
- 文書の助言をそのまま使う fixture SQL を既存の mock client（`src/mcp/__tests__/` にある engine 直叩きの流儀でよい）で **1 本**: 0 埋めの `CASE WHEN x = '' THEN 0 ELSE x END`、除数ガードの `CASE WHEN total = 0`、`RANK() OVER (ORDER BY …)`、累計の `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` が、規則の文面どおりの SQL で実行でき、期待値（桁が変わる値で数値順）を返す。ここで通らない書き方は規則の文面から外す
- 既存の `b67RelativeDateDocs.test.ts`・`b101DocsIndexVersion.test.ts`・`statementSyntaxCatalog.test.ts`・`metadataTools.test.ts` が通ること
- `npm test` 全体が通ること（結果を報告に貼る）

## 3. 文書（この PR に含める）

- MCP の公開文書（`docs/ksql_mcpb_claude_desktop_install.md`。instructions に触れている節があればそこ。無ければ末尾の補足）に「instructions に Writing rules（実測に基づく 8 行）が含まれる」ことを 1〜2 文で追記し、全文は `src/mcp/index.ts` が正本であることを書く。適切な置き場所が無ければ追記せず報告に書く
- `npm run docs:check` が通ること

## 4. 確認してほしいこと（報告に書く）

1. 8 行それぞれの裏づけ節（ファイル名 + 見出し）。裏づけられず削った／弱めた行があれば、元の文と理由
2. 予算の実測値（total / catalog / prose・文字数・段落数）と、改定後の上限と根拠
3. 既存 Key rules との重複・矛盾が無いことの確認（特に「空数値セルは算術で 0」と「Empty cells are ''」の関係を 1 文で）
4. `initialize` 応答以外に instructions を返す経路（resources・docs ツール）があるか。あれば影響

## 5. 報告

最終メッセージ＝実装報告のみ。構成: 変更ファイル一覧／追加した Writing rules の全文（最終形）／裏づけ表（行 ↔ 節）／予算テストの改定内容（旧 → 新・根拠）／追加・変更したテストの一覧と `npm test` の結果（通過数・失敗数をそのまま）／文書の差分（追記した文を全文）／§4 の 4 項目／Claude が実機（Claude Desktop + MCP・第 3 回の依頼文の before/after 3 回）で確かめるべき残項目／上限内に終わらなかった項目（あれば）。
