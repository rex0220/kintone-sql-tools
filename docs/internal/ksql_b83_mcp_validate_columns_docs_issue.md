# B83 MCP instructions の VALIDATE 診断列数が実態と違う

- 起票: 2026-07-27
- ステータス: ✅ **リリース済み（v3.30.0・2026-07-28）**。2形（9 列 / SUMMARY 5 列）明記へ修正。
- 出典: B68 の実需確認で `VALIDATE` の戻り値を実測した際に発見
- 関連: [B74 相対日付 docs 是正](ksql_b74_relative_date_docs_accuracy_issue.md) / [B68](ksql_b68_engine_library_readonly_extensions_evaluation.md) / [B81 語数予算](ksql_b81_mcp_instructions_word_budget_issue.md)

## 1. 事象

MCP instructions（`src/mcp/index.ts`）が `VALIDATE` の診断列を **5 列**と書いている。

```
Existing-record VALIDATE applies built-in form constraints plus optional CHECK groups
and can materialize its fixed five diagnostic columns with INTO #err in a batch.
```

**実際は 9 列**である（v3.28.0 CLI・実 kintone で実測）。

```
$id, $err_field, $err_code, $err_message, $err_value,
$err_subtable, $err_subrow, $err_subrow_id, $err_count
```

`VALIDATE APPn` 単体の戻り値・`INTO #err` で実体化した一時テーブル、**どちらも 9 列**。

## 2. 原因の推定

前半 5 列（`$id` / `$err_field` / `$err_code` / `$err_message` / `$err_value`）が当初の形で、
**サブテーブル診断の 4 列（`$err_subtable` / `$err_subrow` / `$err_subrow_id` / `$err_count`）が
後から追加された際に instructions が追随しなかった**と見られる。

`git log` で列追加の版を特定し、instructions の記述が据え置かれた経緯を確認すること。

## 3. 影響

**MCP instructions は AI クライアントにとっての正である。**

- 「5 列」と読んだ AI が、`SELECT $err_subtable FROM #err` のような**実在する列を使わない**、
  あるいは列数を前提にした誤ったクエリを書く可能性がある
- B62 が instructions に完全性を明示した目的（**存在しないものを捏造させない**）の裏返しで、
  **存在するものを隠している**状態である

実害の大きさは中程度だが、**docs が実態と違うこと自体が本プロジェクトで繰り返し問題になっている**
（B74 は相対日付、B80 はエラー理由、B76 Phase B は JOIN 制約）。

## 4. 対応

`five` → `nine` に直すだけで済む。**語数予算への影響はない**（どちらも 1 語・B81）。

ただし**同種の drift が他に無いか**を確認すること。instructions は
`ksql_docs` / 言語リファレンス / 実装の 3 者と整合している必要がある。

### 4.1 再発防止の検討

列名は `VALIDATE` の実装が持つ定数から生成できるはずである。
**instructions の該当箇所を実データから組み立てれば drift しない**
（B60 が statement templates と function catalog で既に採っている方式）。

「5」という数値を手書きしていること自体が原因なので、
**数を書かない**（`its diagnostic columns`）か、**カタログから生成する**かのどちらかが望ましい。
前者は 0 人日、後者は B81 の catalog 枠に少し乗る。

## 5. 規模

- 記述修正のみなら **0.1 人日**
- 生成方式にするなら **0.25〜0.5 人日**
- **公開挙動の変更なし**


## 6. 【2026-07-27 追記】同種の drift をもう1件検出＝`UPSERT_SELECT`

B68 Step 4 の parity テスト設計中に、codex が別の drift を検出した。

`Statement` AST には **`UPSERT_SELECT`** が存在する（`src/types/ast.ts`）が、
`STATEMENT_SYNTAX_CATALOG.upsert` の**例は VALUES 形だけ**で、
そこから導ける AST 型は `UPSERT` のみである。

つまり **カタログの例だけを根拠にすると AST 全文型を網羅できない**。

- instructions の statement template 自体は `{VALUES...|SELECT...}` と両形を書いている
- **不足しているのは「例」のほう**で、例から AST 型を導く用途では穴になる

§4.1 に書いた「**数を手書きしている／例が実装から導けない**」という同じ根に由来する。
本課題の再発防止（実データから生成する）を検討する際は、
**列数だけでなくカタログの例の網羅性も対象**にすること。

B68 Step 4 では型レベル網羅（`Record<Statement["type"], ...>`）で回避しており、
**parity の目的は達成できている**。カタログ例の不足はここで扱う。


## 7. 【2026-07-28 実装】診断が変わった＝「5 は誤り」ではなく「2形の取り違え」

起票時に「5 と書いてあるが実際は 9」と書いたが、**調べると 5 列の形も実在した**。

| 形 | 列数 | 列 |
|---|---:|---|
| `VALIDATE APPn INTO #err`（既定） | **9** | `$id` `$err_field` `$err_code` `$err_message` `$err_value` `$err_subtable` `$err_subrow` `$err_subrow_id` `$err_count` |
| **`VALIDATE APPn SUMMARY INTO #err`** | **5** | `$id` `$err_subtable` `$err_field` `$err_code` `$err_count` |

`src/core/batch.ts` が `stmt.summary` で列セットを切り替えている。**実機で両方を確認済み。**

### 7.1 したがって欠陥は「数が古い」ではない

**`SUMMARY` 形の列数を、あたかも唯一の形であるかのように書いていた。**

カタログの**テンプレートには `[SUMMARY]` があり、例も `SUMMARY` を使っている**。
つまり AI は `SUMMARY` を知り得るが、**既定形を書くと 9 列で説明と食い違う**。

### 7.2 言語リファレンスは元から正しかった

`docs/ksql_language_reference.md` は「**詳細出力は固定9列**」と正しく書いており、
`SUMMARY` の 5 列も別途記載されている。

**ずれていたのは MCP の tool description だけ**である。
起票時に「docs が実装と drift」と一般化したが、**実際は MCP 面に限定**されていた。

### 7.3 実装

```diff
- can materialize its fixed five diagnostic columns with INTO #err in a batch.
+ can materialize its diagnostic columns with INTO #err in a batch (nine columns, or five with SUMMARY).
```

**数を消さず両方書いた。**「数を書かない」案も検討したが、
**AI にとって列数は具体的なほうが有用**で、2形あることが分かれば取り違えない。

### 7.4 `UPSERT_SELECT` のカタログ例も追加した

`STATEMENT_SYNTAX_CATALOG.upsert` に `SELECT` 形の例と `expectedTypes` を追加した。

これにより **B68 の parity テストで追跡していた「カタログ例の穴」が閉じた**。
テストは `missingFromCatalog` の期待値を `["UPSERT_SELECT"]` から `[]` へ更新し、
**カタログが全 AST 文型を網羅する**というより強い不変条件になった。

> 穴を塞いだ結果、**それを追跡していたテストが落ちた**。
> 追跡アサーションが正しく働いた例である。

### 7.5 語数予算への影響なし

該当文は **instructions ではなく `ksql_query` の tool description** にあり、
B81 の語数予算の対象外だった。カタログ例も `template` ではないため予算に影響しない。
