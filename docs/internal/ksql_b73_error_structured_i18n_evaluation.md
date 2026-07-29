# B73 — エンジンエラーの構造化情報公開 / 多言語対応（日英混在の統一を含む）

- 作成日: 2026-07-26
- ステータス: ❌ **クローズ（実装しない・2026-07-29）**＝**要望元の Pro が対応不要と回答**（2026-07-27）。**他所からの実需も無い**。
  **【クローズしても残る契約】エラー `code` の値と意味を変えないこと**（§7）。**再起票時はこの評価が出発点**。
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


## 追記（2026-07-27）— engine ライブラリの reason 平坦化

B76 Phase A Step 5 の 4面 parity テスト作成時に、**engine ライブラリだけ具体的な reason を
失う**ことが判明した。B73 の具体的インスタンスとして記録する。

### 事象

`src/engine-library/statementGuard.ts` の `parseSingleStatement()` は、
`parseSqlStatement()` の例外を正規化し **`PARSE_ERROR` 以外を汎用 parse error へ置き換える**。

```ts
const normalized = normalizeEngineError(error);
if (normalized.code === "PARSE_ERROR") throw normalized;
throw parseError("SQL statement could not be parsed", error);
```

`KlikeValidationError`（`name = "ArgumentError"`）は `PARSE_ERROR` にならないため、
**「SQL statement could not be parsed」という誤導的メッセージ**になる。
実際には**構文としては正しく parse できており**、意味的な制約で拒否されている。

### なぜ B73 の課題か

B73 は「message 文字列に埋め込まれた情報の構造化」を主眼にしていたが、
**そもそも面によっては情報が失われている**という、より根本的な問題がここにある。
構造化以前に、**エラーの同一性が保たれていない**。

### 着手時の論点

- `normalizeEngineError` が保持すべきエラー種別の範囲（`ArgumentError` 系を通すか）
- 汎用化していた理由（内部エラーの漏洩防止か、単なる簡略化か）の確認
- ライブラリ利用者に見えるエラー出力の変更になるため、**非破壊で行えるか**の判断
- 4面で**同じ拒否には同じ reason** を返すという不変条件を置けるか

**【2026-07-27 解決済み】本件は B80 として独立起票のうえ実装済み。**
`statementGuard.ts` は `KlikeValidationError` を class identity で allowlist し、
`code = PARSE_ERROR` と `cause` の identity を維持したまま **具体的な reason を返す**ようになった。
B76 Phase A で一時緩和した 4面 parity 条件も撤回済み（B76 spec §17）。

**したがって B73 の前提は満たされた。** B73 は「message に埋め込まれた情報を
`details?` として構造化公開する」ことに集中できる。

**B73 着手時の追加論点**＝B80 は非破壊を優先して `code` を `PARSE_ERROR` のまま残したが、
KLIKE の配置制約は意味的には parse error ではない。**`code` を意味的に正確にするか**を
破壊的変更の是非として判断すること（B80 仕様の Claude レビュー §B）。


---

## 7. クローズ（2026-07-29）

**要望元の Pro が対応不要と回答したため、保留のまま置かずクローズする。**

### 7.1 Pro の回答（2026-07-27）

| | |
|---|---|
| **表示方針** | エンジンのメッセージを**翻訳せず `[CODE] メッセージ` でそのまま出す** |
| **日英混在** | **仕様として受容する** |
| **位置・トークン** | **不要** |
| `messageKey`＋`params` | **不要** |
| **多言語化** | **要望なし** |

### 7.2 **クローズしても残る契約**

**エラー `code` の値と意味を変えないこと。**

**Pro はエラー種別を、メッセージ本文ではなく `code` で判定している。**

```
PARSE_ERROR / READ_ONLY_VIOLATION        → 構文エラー表示
SEARCH_ABORTED / FETCH_LIMIT_EXCEEDED    → 取得上限表示
CLIENT_ERROR / EXECUTION_ERROR           → メッセージで細分化
```

**v3.27.0 の B80 で `code` を `PARSE_ERROR` のまま保った配慮が、実際に有効だった**と
Pro が明記している。**B68 でも `code` 維持を受入条件に入れて実装済み。**

> **この契約はこの課題のクローズとは独立に生き続ける。**
> **メッセージの文面を変える課題（[B100](ksql_b100_failclosed_message_order_issue.md)）でも、
> `code` は動かさないこと。**

### 7.3 再起票する条件

- **Pro 以外の利用者から多言語化の実需が出たとき**
- **engine ライブラリの利用者が `message` の文面を機械判定していると分かったとき**
  （現在は `code` で判定するよう文書化している）

**そのときは §1〜§6 の評価をそのまま出発点にできる。**
