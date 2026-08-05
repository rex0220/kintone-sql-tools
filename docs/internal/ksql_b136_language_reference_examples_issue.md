# B136 言語リファレンスの `SHOW APPS` / `DESCRIBE` 例がそのまま実行できない

- 起票: 2026-08-05
- ステータス: ✅ **例の訂正は v3.49.0、再発防止（案 D）は v3.50.0 でリリース**（2026-08-06）
- 発見: [B130](ksql_b130_describe_flags_issue.md) の実装面調査中
- 同系: [B132](../ksql_issue_tracker.md)（`ksql_docs` のセクションキー）／[B135](../ksql_issue_tracker.md)（`mcp:smoke` の期待値）

---

## 1. 事実

`docs/ksql_language_reference.md` は **MCP リソース `ksql://language-reference` の原本**
（`src/mcp/docsResources.ts:10` が読み込む）。つまり**エージェントが読む説明そのもの**である。
その中の `SHOW APPS` / `DESCRIBE` の例が、**実装と違う列名を使っている**。

| | 文書 | 実装（`execute.ts:9348,9367`） |
|---|---|---|
| `SHOW APPS` | `name` | `アプリID` / `アプリ名` / `説明` |
| `DESCRIBE` | `fieldCode` / `label` / `type` | `フィールドコード` / `ラベル` / `タイプ` |

**実行して確認した**（v3.48.0・APP4228）:

```
WITH フィールド AS (DESC APP4228) SELECT * FROM フィールド WHERE type = 'NUMBER'
→ ArgumentError: unknown field code(s): type (フィールド)
```

**文書に載っている例が、そのままではエラーになる。**

### 該当箇所（6 行・`docs/ksql_language_reference.md`）

| 行 | 内容 |
|---|---|
| 2099 | `WHERE name LIKE '受注%'` |
| 2103-2104 | `SELECT * FROM フィールド WHERE type IN (...)` |
| 2108-2109 | `SELECT fieldCode, label FROM フィールド ORDER BY fieldCode ASC` |
| 2165 | 列表の `fieldCode` / `label` / `type` |
| 2172, 2175 | `WHERE name LIKE '受注%'` / `WHERE type = 'NUMBER'` |
| 3834 | `SELECT * FROM アプリ WHERE name LIKE '受注%'` |

---

## 2. なぜ重要か

**依頼元（`ksql-analytics`）が B129 の回答で実測を添えて言っている。**

> エージェントは文章より例を写します。**例のある制約は初回から守られ、文章だけの制約は破られます。**

**写す対象が壊れている。** エージェントは書いてあるとおりに写し、
`unknown field code(s): type` を踏んでから初めて気づく。
B129 で「例を出せば守られる」と判断して診断文に例を入れたばかりなので、**同じ理屈がここに跳ね返る**。

---

## 3. 根本原因＝言語リファレンスの SQL 例を検証している仕組みが無い

- `npm run engine:docs-smoke`（`scripts/engine-docs-examples-smoke.mjs`）は
  **言語リファレンスを参照していない**（`docs/` への参照が 0 件）
- `mcp:smoke` はセクションキーと本文の一部文字列しか見ていない
- `npm test` にも文書内 SQL を実行・検証する経路は無い

**B132・B135 と同じ「文書・生成物・期待値の二重管理」系列**である。
B135 では期待値を生成側から導出して二重管理をやめた。ここも同種の対処が要る。

---

## 4. 対応案

| 案 | 内容 | 見立て |
|---|---|---|
| **A** | 該当 6 行を実装に合わせて直す | **必須**。ただし再発する |
| **B** | A ＋ 言語リファレンスの SQL 例を抽出して `ksql_validate` に通す smoke | 列名の誤りは validate では**捕まらない**（実行時のマテリアライズ列検証で出る）ため不十分 |
| **C** | A ＋ **`SHOW APPS` / `DESCRIBE` の列名を定数から生成**し、文書側は生成物を貼る | 列名の食い違いは原理的に消えるが、文書生成の仕組みが増える |
| **D** | A ＋ **列名を出力する箇所を 1 か所に固定し、文書の列表をテストで突き合わせる** | 実装の定数（`execute.ts:9348,9367`）と文書の表を 1 本のテストで比較するだけ。安い |

**見立て＝A＋D。** 例文そのものの実行検証は重いが、
**列名の表と実装の定数が食い違わないことだけなら 1 テストで固定できる**。
例文の列名はその表から引く形にすれば、表が正しい限り例文も正しくなる。

> **B130 と一部重なる。** B130 は `DESCRIBE` に列を足す改善で、
> **その際に列表の訂正は不可避**。A の DESCRIBE 分は B130 に含め、
> 本件は `SHOW APPS` 分と再発防止（D）を担当するのが素直。
