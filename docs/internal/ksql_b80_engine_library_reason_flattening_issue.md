# B80 engine ライブラリが具体的な reason を汎用 parse error へ平坦化する

- 起票: 2026-07-27（B76 Phase A Step 5 の 4面 parity テスト作成中に発見）
- ステータス: 🔧 **実装完了・未リリース（2026-07-27）**。[仕様 R1](ksql_b80_engine_library_reason_spec.md)（codex 起草・Claude 承認）の Step 1〜4 完了。`statementGuard.ts` が `KlikeValidationError` を class identity で allowlist し、`code = PARSE_ERROR` と `cause` の identity を維持したまま具体的な reason を返す。B76 §17 の parity 緩和も同一 merge で撤回済み。**v3.27.0（B79 と同一リリース）予定**。
- 関連: [B73 エラーの構造化・多言語](ksql_b73_error_structured_i18n_evaluation.md) / [B66 read-only ライブラリ](../ksql_issue_tracker.md) / [B76 spec §17](ksql_b76_join_pushdown_phase_a_spec.md)

## 1. 事象

engine ライブラリ（`runQuery` / `explainQuery`）だけ、**具体的な拒否理由が失われ、
「SQL statement could not be parsed」という誤導的なメッセージ**になる。

`src/engine-library/statementGuard.ts` の `parseSingleStatement()`:

```ts
try {
  return parseSqlStatement(sql, { import: true });
} catch (error) {
  const normalized = normalizeEngineError(error);
  if (normalized.code === "PARSE_ERROR") throw normalized;
  throw parseError("SQL statement could not be parsed", error);   // ← reason が潰れる
}
```

`parseSqlStatement()` は構文解析だけでなく **AST 後の静的検証**も行う。
そこで投げられる `KlikeValidationError`（`src/core/klikeValidation.ts`）は
`name = "ArgumentError"` なので `PARSE_ERROR` にならず、**汎用 parse error へ置き換えられる**。

## 2. 何が問題か

**構文としては正しく parse できている。** 意味的な制約（KLIKE は AND リーフ限定 等）で
拒否されているのに、利用者には「SQL が parse できない」と伝わる。

- 利用者は**構文エラーを探して時間を浪費**する。実際には SQL は正しい
- 同じクエリを plugin / CLI / MCP で実行すると**具体的な理由が出る**ため、
  **面によって原因究明の難易度が変わる**
- B76 の 4面 parity テストで「同じ拒否には同じ reason」を固定しようとして初めて露出した

### 2.1 具体例

```sql
SELECT a.$id FROM APP100 a JOIN APP200 t ON a.担当者 = t.担当者
WHERE a.件名 KLIKE 'urgent' OR a.担当者 = '佐藤'
```

| 面 | エラー |
|---|---|
| plugin / CLI / MCP | `ArgumentError: FULL_SCAN の KLIKE / NOT KLIKE は …`（具体的） |
| **engine ライブラリ** | **`SQL statement could not be parsed`**（誤導的） |

## 3. 影響範囲

起票時は「KLIKE 検証はその一例にすぎず、他の静的検証も平坦化されている可能性が高い」と
書いたが、**Step 0 の調査で `KlikeValidationError` が唯一の例外源**と判明した。

`src/core/sql.ts` が `parseSqlStatement()` から呼ぶ後段検証は `validateKlikeStatement()` のみで、
それ以外は parser 側が先に `ParseError`（＝`PARSE_ERROR`）として拒否する（Claude も独自確認）。
**実装は class identity（`instanceof KlikeValidationError`）による allowlist で過不足がない。**

網羅一覧は [B80 仕様 §5.1](ksql_b80_engine_library_reason_spec.md) の **11 条件**。

## 4. 論点

1. **`normalizeEngineError` が保持すべきエラー種別の範囲。** `ArgumentError` 系を通すか
2. **汎用化していた理由**の確認。内部エラーの漏洩防止か、単なる簡略化か
   （**意図的な防御なら、通す範囲を allowlist で明示する**設計が要る）
3. **ライブラリ利用者に見えるエラー出力の変更**になるため、非破壊で行えるかの判断
4. **「同じ拒否には同じ reason を返す」という4面の不変条件**を置けるか。
   置けるならテストで固定する
5. B73（構造化情報の公開）との順序。**B80 が先**であるべき
   （情報が失われている状態で構造化しても意味がない）

## 5. B73 との関係

B73 は「message 文字列に埋め込まれた情報を構造化して公開する」課題だが、
本課題は**そもそも面によっては情報が失われている**という、より手前の問題である。

> **構造化以前に、エラーの同一性が保たれていない。**

B73 に着手する前に本課題を片付けるほうが自然である。

## 6. 補足

B66（engine ライブラリ・v3.19.0）以来の既存挙動であり、B76 の変更が原因ではない。
B76 Phase A では 4面 parity 条件を一時緩和して回避したが、**本課題の実装と同一 merge で撤回済み**
（B76 spec §17）。現在は plugin / CLI / MCP / engine ライブラリの4面で
**同じ拒否には同じ reason** を固定している。
