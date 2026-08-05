# B133 保存クエリの複文対応＋実行時変数注入 Phase 1 仕様（R2）

- ステータス: ✅ **v3.48.0 でリリース**（2026-08-05） → [実装報告](ksql_b133_codex_impl_report.md) / [レビュー](ksql_b133_codex_review_1.md)（高 1・中 5・低 2 を**全件反映**）
  - `npm test` 224 suites / 5,417 tests 全通、`mcp:verify` 3 種全通
  - **実機（APP4228）で §3 を全件確認**。とくに §3.1＝`variables` 無し 1147 → `d90='2026-07-20'` で **99**（トマト缶）へ変わり、**日付リテラル直書きの `ksql_query` と完全一致**
  - §5 の未確定 3 件は実装時に確定（→ 実装報告）
- 実需: [ksql-analytics の返信 §5](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-B129-20260805.md)
- 関連: [B4](ksql_saved_query_params_spec.md)（❌ クローズ。**そのクローズ判断の前提が一部崩れた**・§0.1）

> **R1 からの最大の訂正: 「複文を保存できる」だけでは実需に届かない。**
> R1 は受入に「実行時に `@d90` を上書き」と書きながら、**それを実現する変更を書いていなかった**。
> - **`variables`（`DECLARE` への外部注入）は `ksql_query` / `ksql_mutate` にはあるが、
>   `ksql_run_saved_query` には無い**（`schemas.ts:89,114` vs `:210-222`）
> - **注入対象は `DECLARE` 専用**。依頼元の実需の形は `SET` で、**`SET` は注入されない**
>
> つまり R1 のままでは「3 文を保存できる」だけで、**基準日はハードコードされたまま**になる。
> 実需は「**期間だけ変えて毎回回す**」なので、**`run_saved_query` への `variables` 追加が本体**。

---

## 0. 確定事項（コード確認・レビューで裏取り済み）

| 事実 | 根拠 |
|---|---|
| 制約は安全の条件ではない（「対応時にこのガードを外す」） | `mcp/tools.ts:162-173` |
| `requireSingleStatement` の**利用者は save / run の 2 箇所だけ。両方から外せば関数ごと削除できる** | `tools.ts:163,1016,1070` |
| **`canRunWithQueryTool` は `isReadOnlyBatch`、`requiresMutationTool` は `containsDml` の別名** | `tools.ts:567-576` |
| **`isReadOnlyBatch` = `!containsDml && every(isReadOnly)`＝`containsDml` 単独より fail-closed** | `core/batch.ts:494-505` |
| **`containsDml` は「DML 構文か」ではなく `writesKintone()`**。`VALIDATE ONLY` 付き DML は **`false`**（意図どおり・漏れではない） | `core/batch.ts:470-505` / `mcp/__tests__/tools.test.ts:316-339` |
| 通常 DML / `INSERT_SELECT` / `UPSERT_SELECT` / `ON ERROR SKIP` / APPLY mutation は捕捉される | `core/__tests__/batch.test.ts:121-131` ほか |
| **DML サブクエリは現行 grammar で作れない**（スカラーサブクエリは `query: SelectStatement`） | `types/ast.ts:384-388` / `parser.ts:519-539` |
| 単文では `containsDml === isDml`（同じ analysis の 1 要素） | `tools.ts:548-576,589-607` |
| **カタログ parser は `sql: string` としか検証しない**＝**手編集で複文が入り得る** | `savedQueries.ts:122-153` |
| `runSavedQuery` は**毎回 validate と safety check をやり直している** | `tools.ts:1065-1080` |
| **`ksql_list_queries` は SQL を返さない**（既存テストで固定）。`ksql_get_query` は全文を返す | `mcp/__tests__/tools.test.ts:1573-1578` / `tools.ts:1057-1062` |
| 一時テーブル・変数は **`executeBatch()` 呼出ごとに `new Map()`**＝並行呼出で衝突しない | `execute.ts:1530-1533` |
| カタログ JSON の往復は `sql` をそのまま保持（整形しない） | `savedQueries.ts:182-188,206-216` |

### 0.1 B4 クローズ判断の前提が一部崩れている

B4（保存クエリのパラメータ化）は「**中核価値の『外部から動的値を安全注入』は `@var` が既に提供済み**」
としてクローズされた。しかし**その `@var` 注入は `ksql_query` / `ksql_mutate` にしか無く、
`ksql_run_saved_query` には無い**。**保存クエリ経路では提供されていなかった。**

**本件（B133）でそこを埋める。** B4 の再実装ではなく、**既存の注入機構をもう 1 ツールへ配線する**だけ。

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象 A** | **`ksql_run_saved_query` に `variables` を足す**（`ksql_query` と同じ形・`DECLARE` への注入） |
| **対象 B** | **読み取り専用の保存クエリに限り複文を許可する** |
| **非対象** | DML を含むバッチの保存・実行（実需が出てから。緩和は純加法） |
| **非対象** | `SET` への外部注入（**注入は `DECLARE` 専用**という既存契約を変えない） |
| **非対象** | 単文保存クエリの挙動変更 |

> **A と B は一体で出す。** B だけでは実需（期間を変えて回す）に届かず、
> A だけでは複文（`DECLARE @x; SELECT ...`）を保存できない。

---

## 2. 変更内容

### 2.1 `runSavedQueryInputSchema` に `variables` を足す

```ts
variables: z.record(z.string(), z.string())
  .describe("Batch only: string values for variables declared with DECLARE. Keys omit @ and are case-insensitive.")
  .optional(),
```

**`ksql_query` の定義（`schemas.ts:89-90`）と同一にする。** 新しい規約を作らない。
`runSavedQuery` から `query()` / `mutate()` へそのまま渡す。

### 2.2 ガードを外す

`saveQuery` / `runSavedQuery` から `requireSingleStatement` の適用をやめ、
**利用者が居なくなるので関数ごと削除する**（レビュー 2.7）。

### 2.3 許可条件は `canRunWithQueryTool` を使う（R1 から変更）

R1 は `containsDml === false` としていたが、**`containsDml` は「実際に書く文を含むか」**であり
「DML 構文を含むか」ではない。**より fail-closed な `canRunWithQueryTool`（=`isReadOnlyBatch`）を使う。**

| `readOnly` | 条件 | 期待 |
|---|---|---|
| `true` | **`canRunWithQueryTool === true`** | 通す（単文・複文とも） |
| `false` | 単文 かつ `requiresMutationTool === true` | 従来どおり通す |
| `false` | **複文** | **拒否**（Phase 1 非対象） |

**`VALIDATE ONLY` 付き DML の扱いは既存 `ksql_query` と揃う**（`isReadOnlyBatch` が true なら
read-only 保存クエリとして受理される）。**これは現行 `ksql_query` の対応能力どおりで、
R1 の「1 文でも DML があれば拒否」という文言のほうが誤り**だった。

### 2.4 防御は save と run の両方に置く（R1 から追加）

**カタログは手編集できる**（parser は `sql: string` としか検証しない）。
`saveQuery` のチェックだけでは不十分。**`runSavedQuery` が毎回行っている再検証を維持し、
`readOnly: false` かつ複文の拒否も run 側で明示する。**

### 2.5 返却規約（R1 から訂正）

R1 は「最後に結果セットを返した文」と書いたが誤り。**複文は `ksql_query` と同じ
バッチエンベロープで返す**（レビュー 2.4）。**新しい規約を作らない。**

### 2.6 文言

- `schemas.ts:195` の `"kSQL text to save (single statement only)."` を改める
- **`ksql_list_queries` は SQL を返さない**ので変更不要（R1 §2.4 は誤り）。
  `ksql_get_query` は全文を返すので変更不要

### 2.7 一時テーブルを使う場合の制限（レビュー 2.8）

`runSavedQuery` は `tempTableMaxRows` などの**非公開 batch options を渡さない**ため、
**既定値が適用される**。仕様として明記し、必要になったら別途入力を足す。

---

## 3. 受入条件

### 3.1 実需の形（★最優先）

```sql
-- 保存する SQL（DECLARE を使う。SET ではない）
DECLARE @d90 = '2026-05-08';
DECLARE @d30 = '2026-07-06';
SELECT 製品名, SUM(CASE WHEN 日付 >= @d90 THEN 個数 ELSE 0 END) AS 出庫90
FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 製品名
```

| 操作 | 期待 |
|---|---|
| 上を `readOnly: true` で保存 | **できる** |
| `ksql_run_saved_query { name }` | 保存時の既定値で実行できる |
| **`ksql_run_saved_query { name, variables: { d90: '2026-06-01' } }`** | **上書きが効く**（★実需そのもの） |
| 未定義の変数名を渡す | **既存 `ksql_query` と同じ挙動**（新しい規約を作らない） |
| `SET` で書いた保存クエリに `variables` を渡す | **既存 `ksql_query` と同じ挙動**（注入されない。**文書に明記**） |

### 3.2 複文の許可・拒否

| 入力 | 期待 |
|---|---|
| `CREATE TEMP TABLE #a AS SELECT ...; SELECT ... FROM #a`（`readOnly: true`） | 保存・実行でき、**バッチエンベロープ**で返る |
| **`INSERT ... VALIDATE ONLY; SELECT ...`（`readOnly: true`）** | **通す**（`canRunWithQueryTool === true`。既存 `ksql_query` と同じ） |
| 実書き込み DML を含むバッチ（`readOnly: true`） | **拒否** |
| DML バッチ（`readOnly: false`） | **拒否**（Phase 1 非対象・理由を名指し） |
| **カタログを手編集して複文 DML を仕込む → `run`** | **run 側で拒否**（§2.4） |
| 単文 SELECT / 単文 DML | **従来と完全に同じ**（回帰） |
| 同じ保存クエリを**同時に 2 つ実行**（一時テーブルを使う形） | **衝突しない**（`executeBatch()` ごとに `new Map()`） |

### 3.3 カタログ往復

**複文・改行・コメントを含む SQL** を保存 → 読み出し → 実行して、**SQL が完全一致**すること
（既存の round-trip テストは単文だけ・`savedQueries.test.ts:138-160`）。

### 3.4 回帰（必須）

1. **既存の保存クエリ（単文）がすべて従来どおり動く**
2. **`ksql_list_queries` が SQL を返さないこと**（既存テスト `tools.test.ts:1573-1578` が緑のまま）
3. `ksql_get_query` / `ksql_delete_query` / `allowProfileOverride` / `allowDml` / `confirmText` が不変
4. **既存 smoke（`mcp:smoke` ほか）が破綻しないこと**（レビュー 2.6）。
   保存クエリのスキーマが変わるため**入力スキーマを照合している smoke を洗う**
5. **実書き込み DML が `query()` 経路へ漏れないこと**を単文・複文の両方で固定

---

## 4. 影響範囲

| ファイル | 内容 |
|---|---|
| `mcp/schemas.ts:195,210-222` | `sql` の description ／ `runSavedQueryInputSchema` に `variables` |
| `mcp/tools.ts:163,1016,1070` | `requireSingleStatement` の**削除**と呼出の除去 |
| `mcp/tools.ts:1082-1090` | `runSavedQuery` → `query()` へ `variables` を渡す |
| `mcp/savedQueries.ts:94-101` | `assertSavedQuerySafety` を `canRunWithQueryTool` ベースへ |
| smoke / スキーマ照合 | §3.4-4 |
| `docs/` | 保存クエリの節（複文可・`variables`・`DECLARE` 専用であること） |

---

## 5. 未確定（実装時に決めて報告する）

1. `assertSavedQuerySafety` のシグネチャ。`{ canRunWithQueryTool, requiresMutationTool, batch }` を
   受ける形でよいか（現在は `{ isDml, statementType }`）
2. `readOnly: false` かつ複文の拒否メッセージ（save / run で文面を揃えるか）
3. 既存 smoke のうち**保存クエリの入力スキーマを照合しているもの**の実数
