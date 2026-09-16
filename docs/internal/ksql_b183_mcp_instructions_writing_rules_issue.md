# B183 MCP の instructions に「kSQL の作り方」を入れる — 依頼文に貼らなくても既知の落とし穴を避けさせる

- 状態: ✅ **v3.78.0 でリリース（2026-09-16）**。codex が実装・Claude レビュー済み（コミット c63a3ec・[報告](ksql_b183_codex_impl_report.md)）。Writing rules 8 行を追加（B181・B182 修正後の仕様で記述）。レビューで除数ガードを §5 の `= '' OR = 0` 形へ、JOIN の絞り込みを §7 の「INNER JOIN のみ」へ揃え、予算テストは語数 exact `{935, 347, 588}`・上限 prose ≤ 635 / total ≤ 1,015 / 段落 7。実測 initialize 応答 5,722 → 7,369 文字（+29%・固定コンテキスト全体 +4.5%）。効果（§3 の before/after 3 回）はリリース後に実測してから確定する。純加法（エンジン不変）

## 1. 背景（実測）

Qiita「kSQL 実践」第 3 回の依頼文（ABC 分析・3 段 CTE）を Claude Desktop + kSQL MCP v3.77.0 に渡した結果（番外編 `docs/internal/qiita/ksql-intro-series/03a_番外編_AIの回答を検証する.md`）:

| 巡 | 前置き | 結果 |
| :-: | :--- | :--- |
| 1 | なし | `validate`・`explain` は通り、実行で `unknown field code(s): 顧客No (agg)`（別名の小文字正規化＝B181） |
| 2 | 依頼文を改訂 | エラーなし。`COALESCE(SUM(x), 0)` で列が型を失い、順位・累計が文字列順（B182）。ABC 区分が全部ずれる |
| 3 | 依頼文は 1 と同じ + **作り方のルール 21 項目**を会話の先頭に貼る | **第 3 回の表と完全一致**。別名は日本語、`COALESCE` 無し、`RANK`、総計 0 のガード、依頼に無い列無し |

ルールの全文は `docs/internal/qiita/ksql-intro-series/kSQL作成ルール_試験用.md`。効いたと判定した項目は 10（0 埋めは `CASE`・集計値を `COALESCE` で包まない）、15（別名に英字を使わない）、16（依頼された列だけ・`RANK`・小数第 1 位）、21（根拠を示す・推測は推測と書く）。

現在の instructions（`src/mcp/index.ts` の `KSQL_MCP_INSTRUCTIONS`・実測 5,722 文字＝散文 1,140 + 構文カタログ 3,278 + 関数カタログ 1,294）には「Key rules」として LIKE の JS 評価・JOIN ON 1 本・派生テーブル不可・空セル 0 の 4 点しか無い。番外編で踏んだ 2 件はどちらも書かれていない。

## 2. 提案

`KSQL_MCP_INSTRUCTIONS` の「Key rules」段落を、実測に基づく「Writing rules」に拡張する（英語・簡潔・1 項目 1 行）。候補:

```text
Writing rules (learned from real failures):
- Check field codes with ksql_describe_app first; use lookup copy targets ("コピー元: YES") joined to the record number as JOIN keys.
- INNER JOIN: put the side you can filter with WHERE (or the smaller side) in FROM; the join-key prefilter only flows FROM -> JOIN target. LEFT/RIGHT JOIN disables pushdown on both sides; materialize the filtered side into a temp table first.
- Write date conditions with relative-date functions or literal half-open ranges in WHERE; never wrap the column (DATE_FORMAT/YEAR) in WHERE. Relative-date functions are WHERE-only; use CURRENT_DATE() in SELECT.
- Empty cells are '' (no NULL). Zero-fill with CASE WHEN x = '' THEN 0 ELSE x END. Do not wrap aggregates in COALESCE/ISNULL: the result loses its type (string ordering) and arithmetic on it yields 0.
- Aggregates and window functions cannot share a SELECT, and window results cannot be used in expressions of the same SELECT: split stages with WITH or temp tables. Running totals: explicit ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW plus a tie-break on the aggregation key. Guard division by a total with CASE WHEN total = 0.
- Do not use ASCII letters in column aliases: aliases are lowercased, and references from later stages must use the lowercased name. Never alias a physical field to its own name.
- Output only the requested columns; do not add ORDER BY/LIMIT/filters that were not asked for. Rank with RANK() unless told otherwise.
- After writing: ksql_validate, then ksql_explain; report the fetch summary and reason lines. State assumptions as assumptions.
```

- 長さの目安: 約 1,200 文字。**実測**（v3.77.0 の initialize 応答）: 現行 instructions は 5,722 文字（約 1,430 トークン。内訳: 概要 454・Key rules 269・手順 386・構文カタログ 3,278・関数カタログ 1,294）。追加後は約 6,900 文字（約 1,730 トークン）で **+約 20%**。同じ接続で常時渡る 13 ツールのスキーマは 31,054 文字（約 7,800 トークン）なので、MCP 由来の固定コンテキスト全体（約 9,200 → 9,500 トークン）では +3% 程度。構文カタログ（B-系で「載っている構文は必ず通る」をテストで保証）と同じく、**ルールの各文が言語リファレンスの該当節と一致する**ことをテストで固定する（文言テスト + 参照節の存在）
- 別名と `COALESCE` の 2 行は B181・B182 が解決されたら文言を弱める（「参照は小文字で」→ 不要、`COALESCE` の型 → 不要）。それまでは回避策として必要
- 日本語版は置かない（instructions は英語で統一されている。Claude は日本語の依頼にも英語 instructions を適用できることを 3 巡目の実測で確認済み＝ルールは日本語だったが、構文カタログは英語）

### 2.1 追記（codex 調査・2026-09-16・[報告](ksql_b181_b184_codex_plan_report.md) §4・§6）

- **予算テストが必ず変わる**: `src/mcp/__tests__/metadataTools.test.ts:118-141` が instructions の語数を `{ total: 663, catalog: 347, prose: 316 }` の exact で固定し、上限 `prose ≤ 320`・`catalog ≤ 420`・`total ≤ 700`・段落数 6 を置いている。Writing rules 8 行（約 200 語）を足すと prose が上限を大きく超える。テスト内コメントのとおり上限は「超えたら妥当性を再検討するトリガー」なので、**上限値と段落数を根拠つきで改定する**（機械的に圧縮しない）。§2 の「+20%・固定コンテキスト全体 +3%」を根拠に書く
- 新規テスト: 8 規則の識別句が 1 回ずつ含まれる／各規則が指す言語リファレンス節・レシピキーが存在する／構文カタログ・関数カタログと重複しない／文書の助言をそのまま使う fixture SQL を既存 mock client で 1 本
- **B181・B182 修正後の扱い**（codex 案）: 行 4「集計を COALESCE で包むな」は削除し、空文字と除数ガードは残す。行 6「別名に英字を使わない」は禁止を外し「結果列名は小文字化される契約」だけ残す。行 5「段の分割」は B184 完了まで残す。残り 5 行は据え置き。文例: `Empty cells are ''. Guard a denominator with x = '' OR x = 0; COALESCE/ISNULL preserve numeric semantics only when every argument is numeric.` / `Column aliases are lowercased in result names. Later-stage references resolve materialized aliases case-insensitively; omit redundant aliases when the original physical field spelling must remain the output name.`
- 順序: B181・B182 の後に実装し、回避策を恒久仕様として残さない

## 3. 測り方（受入）

1. 変更前の MCP（v3.77.0）で、第 3 回の依頼文を**前置きなし**で Claude Desktop に渡す → 番外編 1 巡目と同じ誤り（別名）が再現することを確認（ベースライン）
2. 変更後の MCP で、同じ依頼文を**前置きなし**で渡す → 実行して第 3 回の表と一致すること。別名は英字なし、`COALESCE` なし、`RANK`、総計 0 のガード
3. 第 1 回・第 2 回の依頼文でも同様に before/after（JOIN の向き、`DATE_FORMAT` を WHERE に書かない、0 埋めの `CASE`）
4. 既存の MCP テスト（`statementSyntaxCatalog.test.ts` など）が通り、instructions の各文が参照する節（§7・§10・§1 など）が言語リファレンスに存在することをテストで確認
5. 3 回試して 3 回とも一致すること（1 回の成功で完了としない＝「構文の教え方」記事の教訓 5）

## 4. 記事化

結果は Qiita「kSQL 実践」の番外編（`docs/internal/qiita/ksql-intro-series/03a_番外編_AIの回答を検証する.md`）の「4. 作り方を MCP に組み込む」節として書く（2026-09-16 の方針で番外編は 1 本に統合。第 3〜8 回の公開後、B181・B182・B183 の対応とリリース後に完成させ、第 9 回と合わせて公開）。構成: 前置きルールで直った（3 巡目）→ 毎回貼るのは不便 → instructions に入れる → before/after の実測 → 効いた項目と効かなかった項目 → 文書側（B181・B182）との分担。

## 5. 経緯

- 2026-09-16: 番外編 3 巡目の実測（ルール前置きで完全一致）を受け、user の「MCP の instructions に入れるかは別課題として起票。対応と結果も記事に」で起票
- 関連: B181（別名の参照解決）、B182（`COALESCE` の型）。両方が直れば本件のルール 2 行は不要になるが、残りの 6 行は文書に書いてあっても AI が読まない種類のもの（「静かに足りない」記事の教訓）なので instructions に置く価値がある
