# B133 保存クエリ複文対応 仕様 R1 codex レビュー依頼

**レビュー依頼であり実装依頼ではない。コードは 1 行も変更しないこと。**
git 操作をしないこと。kSQL MCP を叩かないこと（headless で無言停止する）。`npm test` は不要。

## 依頼

**保存クエリの単文制約を解除する** Phase 1 仕様 R1 のレビュー。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.47.0）

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b133_saved_query_batch_spec.md` | **レビュー対象の R1** |
| `docs/internal/ksql_b133_saved_query_batch_issue.md` | 起票 |
| `src/mcp/tools.ts` | `requireSingleStatement` / `saveQuery` / `runSavedQuery` / `ValidationCommon` |
| `src/mcp/savedQueries.ts` | `assertSavedQuerySafety` / カタログ |
| `src/mcp/schemas.ts` | `saveQueryInputSchema` |
| `src/execute.ts` | バッチ実行（一時テーブル・変数のスコープ） |
| `src/core/batch.ts` | バッチ解析 |

**背景**: 直近の 4 件（B123/B124/B125、B126/B127）でも同じ形のレビューをしてもらい、
いずれも R1 の中核前提が覆った（合計 47 件を全件反映）。**同じ系統の穴が無いかを見てほしい。**

## 特に見てほしい点（コードで真偽が決まるもの）

### 1. 【最優先】`readOnly: true` で `containsDml === false` を条件にすれば十分か

R1 §2.2。**DML が読み取り経路（`query()`）へ漏れないこと**が最重要。

- `containsDml` は**バッチの全文**を見ているか。**見落とす文型が無いか**
  （`APPLY` を含む形・`VALIDATE ONLY` 付き DML・`ON ERROR SKIP` 付き DML・
  `INSERT ... SELECT` の source・サブクエリ内の DML など）
- `isReadOnlyBatch` と `containsDml` の**関係**。どちらを使うべきか
- `canRunWithQueryTool` / `requiresMutationTool` という既存フィールドが
  **そのまま使えないか**（R1 はこれらに触れていない）

### 2. 単文のとき `containsDml === isDml` は常に成り立つか

R1 §6-2。成り立たない形があると**単文保存クエリの挙動が変わる**（回帰）。

### 3. `requireSingleStatement` の他の利用者

R1 §6-1。`saveQuery` / `runSavedQuery` 以外から呼ばれているか。
呼ばれているなら**そのツールがバッチ未対応である理由**も確認してほしい
（同じガードを外してよいのか、外してはいけないのか）。

### 4. 既存カタログに複文が入り得るか（防御の位置）

R1 §6-4。`saveQuery` で弾けば十分か、`runSavedQuery` 側にも防御が要るか。
**カタログ JSON は手で編集できる**ので、保存時のチェックだけでは不十分かもしれない。
現在 `runSavedQuery` が保存済み SQL を**毎回 `validate` し直している**点も踏まえて。

### 5. 一時テーブル・変数のスコープ

R1 §0 は「`execute.ts:1531-1532` で実行ごとに `new Map()` なので同時実行しても衝突しない」
としている。**`runSavedQuery` が通る経路でも本当にそうか**（`query()` → `executeSql` →
バッチ実行の呼び出し関係を確認してほしい）。

### 6. `ksql_list_queries` / `ksql_get_query` の表示

複文 SQL をそのまま返せるか。整形・省略・1 行化が入っていないか。

### 7. 受入条件で検出できない穴

R1 §3。とくに「DML が読み取り経路へ漏れない」をどう機械的に固定するか。

## 出したい成果物

`docs/internal/ksql_b133_codex_review_1.md` に。

- 結論（実装着手可能 / 要修正・件数）
- 指摘（重要度 高/中/低・該当 §/file:line・内容・**コード引用による根拠**・提案）
- 上の 7 点への回答（コード引用つき）
- 仕様が正しかった点（R2 で消さないため）

重要度: 高 = そのまま実装すると誤る/既存を壊す（**とくに DML の漏れ**）、
中 = 実装が詰まる/受入の穴、低 = 表現。
**根拠のないコメントは書かないでほしい。** 確認できなかった項目は「未確認」と明記のこと。
