# B73 — エンジンエラーの構造化情報公開 / 多言語対応（日英混在の統一を含む）

- 作成日: 2026-07-26
- ステータス: **📝 評価・起票**（2026-07-26）。**優先度: 中**（Pro 側も「Phase 1 では記録のみで急ぎではない」）。
- 報告元: kSQL Dashboard Pro（`kSQLエンジン報告-20260726.md` 報告2・Pro 側課題 K-2）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B73
- 関連: B66 engine ライブラリ（`KsqlEngineError`）

## 1. 要望（Pro）

Dashboard Pro は UI を日英中対応（`kintone.getLoginUser().language`）しており、ペインのエラー表示に `[CODE] メッセージ` 形式でエンジンの `message` をそのまま出す。このため **en / zh ユーザーにも日本語が表示される**。

1. エラーに**構造化情報**（`code` に加え `messageKey` / `params`: 位置・トークン・関数名・path 等）を公開し、呼び出し側が自前カタログで組み立てられるようにする、または
2. エンジン側に言語指定（`lang: "ja" | "en" | "zh"`）を追加して `message` を切り替える

## 2. 現状（実測 2026-07-26）

`KsqlEngineError`（`src/engine-library/errors.ts`）が公開するのは:

```ts
class KsqlEngineError extends Error {
  readonly code: "PARSE_ERROR" | "READ_ONLY_VIOLATION" | "SEARCH_ABORTED"
               | "FETCH_LIMIT_EXCEEDED" | "CLIENT_ERROR" | "EXECUTION_ERROR";
  readonly cause?: unknown;
}
```

- `code` は 6 種の**粗い分類**のみ。
- **位置・トークン・関数名・path は `message` 文字列に埋め込まれているだけ**で構造化されていない。
- **メッセージは日英混在**（Pro の「日本語のみ」という認識は不正確）:

| 種別 | 実測メッセージ |
|---|---|
| PARSE_ERROR | 日本語: `IN リストには文字列、数値、またはバッチ変数が必要です（位置 36、トークン: 「THIS_MONTH」）` |
| PARSE_ERROR | 日本語: `フィールド名またはテーブル名が必要です（位置 7、トークン: 「FROM」）` |
| EXECUTION_ERROR | **英語**: `THIS_MONTH: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN (reason=WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED) (path=statement)` |
| ArgumentError 系 | **英語**: `ArgumentError: unknown field code(s): 存在しない列 (APP100)` |

エンジン内部のエラーは大半が `throw new Error("...")` の**文字列ベース**で、パーサ由来は日本語、実行/検証由来は英語という混在状態。

## 3. 論点

1. **スコープの広さ**: 構造化（案1）も lang 切替（案2）も、内部の**全エラー生成箇所**（数百箇所規模）に触る必要があり中〜大規模。段階化が必須。
2. **メッセージは公開契約か**: 現状 message 文字列は多くのテストが部分一致で検証している（例: MCP smoke・受入テスト）。文言変更は広範囲のテスト更新を伴う。
3. **日英混在の統一だけでも価値**: 少なくとも「同一言語に揃える」or「英語 code ＋ 日本語説明の一定フォーマット」に寄せると consumer 側で扱いやすい。
4. **段階案**:
   - Phase A（小）: **既存の reason code を構造化フィールドとして公開**（例 `KsqlEngineError.details?: { reasonCodes?: string[]; position?: number; token?: string; path?: string }`）。パーサエラーは既に位置・トークンを持つため、生成箇所で拾って詰めるだけ。既存 `message` は不変（非破壊）。
   - Phase B（中）: `messageKey` 体系の導入とカタログ化。エンジンは key ＋ params を返し、`message` は既定言語での組み立て結果とする。
   - Phase C: `lang` オプションでの切替（カタログが揃って初めて可能）。

## 4. 次アクション

- Pro の実需（どの情報が実際に必要か: 位置・トークンだけで足りるか、全エラーの多言語化が要るか）を確認。
- Phase A だけでも Pro 側の「code に加えて位置・トークンを機械的に扱う」要件は満たせる可能性が高い → **Phase A 先行を推奨**。
- 方向確定後に Phase1 仕様 R1 を起草。
