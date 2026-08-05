# B130 `DESCRIBE` フラグ追加 仕様 R1 codex レビュー依頼

**レビュー依頼であり実装依頼ではない。コードは 1 行も変更しないこと。**
git 操作をしないこと。kSQL MCP を叩かないこと（headless で無言停止する）。`npm test` は不要。

## 依頼

`DESCRIBE` の出力に「型だけでは分からない」フラグ 3 つを足す仕様 R1 のレビュー。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.48.0）

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b130_describe_flags_spec.md` | **レビュー対象の R1** |
| `docs/internal/ksql_b130_describe_flags_issue.md` | 起票（実測あり） |
| `src/execute.ts:9361-9374` | `executeDescribe`（列の定義箇所） |
| `src/core/formFieldInfo.ts` | 正規化。`unique` / `expression` を落としている |
| `src/execute.ts:291-313` | `KintoneFieldInfo` |
| `src/engine-library/resultMapping.ts` / `__tests__/acceptance.test.ts:163-178` | 列の型契約 |
| `src/mcp/tools.ts:946-955` | `ksql_describe_app` |

**背景**: 直近 6 件（B123/B124/B125、B126/B127、B133）でも同じ形のレビューをしてもらい、
**いずれも R1 の中核前提が覆った**（合計 56 件を全件反映）。**同じ系統の穴が無いかを見てほしい。**

## 特に見てほしい点（コードで真偽が決まるもの）

### 1. 【最優先】列の追加が既存の利用者を壊さないか

R1 §4.2。**`DESCRIBE` は行返し文で CTE に入れられる**（`WITH d AS (DESCRIBE APP1)`）。

- **`SELECT *` の展開**で列が増えることの影響。**同名列の衝突**が起き得る形は無いか
- CTE 下流の列解決（`execute.ts:3562-3574` の `validCodes`）以外に、
  **列数・列順に依存している箇所**が無いか
- `engine-library` の型契約（全列 string）を**本当に守れているか**。
  R1 は値を `"YES"` / `""` の文字列にしているが、**それで十分か**

### 2. `formFieldInfo` の拡張が波及しないか

R1 §3.1・§6-1。`KintoneFieldInfo` に必須 boolean 3 つを足す案。

- **`KintoneFieldInfo` の消費者を全部挙げてほしい。** 必須追加で壊れる箇所は無いか
- `FormFieldProperty` に `unique?` / `expression?` を足すことの影響
- **サブテーブル子フィールド**（`formFieldInfo.ts:76` のフラット化）で
  3 つの判定が正しく働くか。子に `lookup` / `unique` が付き得るか

### 3. 判定条件は正しいか（R1 §2.3）

実測で 2 つの落とし穴を確認している（→ 起票 §2）。**他にも無いか。**

- **ルックアップのフィールドには `unique` プロパティが無い**（`unique === true` で判定する根拠）
- **`expression` は素の SINGLE_LINE_TEXT にも空文字で存在する**
- **`CALC` 以外の型で `expression` が非空になる形**は実在するか
  （R1 は「あり得る」としているが、この環境に実例が無く**未確認**と書いている）
- `lookup` プロパティが**空オブジェクト**で来る形は無いか

### 4. `"YES"` / `""` という値の表現

R1 §2.2。`"true"` / `"false"` を避けた理由は「`"false"` が非空で真に見える」。

- **既存の kSQL 出力に真偽値を文字列で出している前例があるか。** あるならそれに揃えるべき
- `WHERE ルックアップ = 'YES'` が**CTE 下流で実際に書けるか**（文字列比較の意味論）

### 5. ツール説明文と smoke

R1 §3.3。`"field code" / "label" / "type"` の 3 語を smoke が固定している。

- 説明文を変えたとき**落ちる smoke / テストを全部挙げてほしい**
- `mcp-pack-smoke.mjs:175` と `mcp-smoke.mjs:216-219` の**両方**に対応が要るか

### 6. 文書の食い違い（B136 と重なる範囲）

`docs/ksql_language_reference.md:2163-2175` の列表は `fieldCode` / `label` / `type` で、
**実装（日本語 3 列）と食い違っている**。実行するとエラーになることは実測済み。

- **この文書を読み込んでいる経路**（`docs Resources`）で、他に実装と食い違う記述が無いか
- R1 は DESCRIBE 分だけ直し `SHOW APPS` 分を B136 へ回している。**この分割は妥当か**

### 7. 受入条件で検出できない穴

R1 §4。とくに「**3 つで打ち止め**」という設計判断が、
**近いうちに破れる**理由が無いか（すぐ 4 つ目が欲しくなる形が見えているか）。

## 出したい成果物

`docs/internal/ksql_b130_codex_review_1.md` に。

- 結論（実装着手可能 / 要修正・件数）
- 指摘（重要度 高/中/低・該当 §/file:line・内容・**コード引用による根拠**・提案）
- 上の 7 点への回答（コード引用つき）
- 仕様が正しかった点（R2 で消さないため）

重要度: 高 = そのまま実装すると誤る/既存を壊す、中 = 実装が詰まる/受入の穴、低 = 表現。
**根拠のないコメントは書かないでほしい。** 確認できなかった項目は「未確認」と明記のこと。
