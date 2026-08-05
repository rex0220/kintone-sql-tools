# B133 保存クエリの単文制約を解除する（バッチ・一時テーブル・`DECLARE` を保存できるように）

- 起票: 2026-08-05
- ステータス: ✅ **v3.48.0 でリリース**（2026-08-05）→ [仕様 R2](ksql_b133_saved_query_batch_spec.md) / [実装報告](ksql_b133_codex_impl_report.md)。以下は起票時の分析（**R2 で覆った点は仕様側が正**）
  - **制約は安全の条件ではなく「バッチ未対応」の暫定ガード**であることをコードで確認済み。判定に必要な情報も既に揃っている
- 出典: [B129](ksql_analytics_inquiry_b129_20260805.md) の検討中にオーナーが指摘。
  「CTE の代わりに一時テーブルでもよいのでは？」→ **一時テーブルでも書けることを実測**→
  「保存クエリは単文制約があるので CTE 一択」と説明したところ、**「制約を解除してはどうか？」**
- 関連: **[B4 保存クエリのパラメータ化](ksql_saved_query_params_spec.md)（❌ クローズ済み）**。
  そのクローズ文に**この路線が「そのほうが安い」と明記されている**（§2）

---

## 1. 何が制約されているか（コードで確認）

`ksql_save_query` / `ksql_run_saved_query` の 2 箇所だけに掛かっている。

```ts
/** バッチ未対応のツールで単文入力を要求する（対応時にこのガードを外す） */
function requireSingleStatement(validation: ValidationResult, toolName: string): SingleValidationResult {
  if (validation.batch) {
    throw new Error(`ArgumentError: batch SQL (multiple statements) is not supported by ${toolName} yet.`);
  }
  return validation;
}
```

**コメントが「対応時にこのガードを外す」と明記している。** 安全のための境界ではなく、
**バッチ未対応だった時期の暫定ガード**である（`src/mcp/tools.ts:162-173`、
呼び出しは `:1016`（save）と `:1070`（run））。

### 安全側は別の仕組みが担っている

```ts
export function assertSavedQuerySafety(input: SaveQueryInput, safety: SavedQuerySafety): void {
  if (input.readOnly && safety.isDml) throw new Error(`ArgumentError: readOnly saved query cannot contain ${safety.statementType}.`);
  if (!input.readOnly && !safety.isDml) throw new Error("ArgumentError: readOnly: false is only allowed for DML saved queries.");
}
```

**「単文であること」は安全の条件になっていない。** DML の遮断は
`assertSavedQuerySafety` と `saved.readOnly` による振り分け（`query()` / `mutate()`）が担う。

---

## 2. B4 のクローズ文がこの路線を指している

[B4](ksql_saved_query_params_spec.md) を「実装しない」と決めた際（2026-07-29）の記録:

> 残る固有価値は「カタログ永続化＋保存クエリでの利用」だけで、それも
> **「保存クエリの単文制約を緩めて `DECLARE`+SELECT バッチ＋既存 `@var`」の軽量路線の方が安い**。
> …**実需が出たら再起票する。**

**当時すでに「制約を緩めるほうが安い」と判断されていた。** 再起票の条件は「実需」で、
今回 B129 の検討で**一時テーブルという具体的な実需**が出た。

---

## 3. 解除で何ができるようになるか

| 現在 | 解除後 |
|---|---|
| 保存クエリは 1 文。**多段は CTE でしか書けない** | **一時テーブルで多段**が書ける。中間結果の再利用・検算がしやすい |
| パラメータは実行時の `@var` 注入のみ | **`DECLARE @x = ...; SELECT ...` を保存クエリ自体に持てる**（B4 の中核価値がここで満たされる） |
| 長い CTE を 1 文に詰める | 段ごとに分けて可読性を保てる |

### 具体例（B129 の検討で実測した形）

```sql
-- 現在は保存できない。CTE 3 段に詰め替える必要がある
CREATE TEMP TABLE #base AS
  SELECT 製品名, SUM(個数) AS 出庫量 FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 製品名;
CREATE TEMP TABLE #ranked AS
  SELECT 製品名, 出庫量, SUM(出庫量) OVER () AS 総計 FROM #base;
SELECT 製品名, 出庫量, ROUND(出庫量 * 100.0 / 総計, 1) AS 構成比 FROM #ranked ORDER BY 出庫量 DESC
```

**この形は `ksql_query` では通る**（実測・構成比 牛乳 34.7% / 食パン 27.3% / トマト缶 12%）。
**保存クエリにできないだけ。**

---

## 4. 判定に必要な情報は既にある

`ValidationCommon`（`src/mcp/tools.ts:113-129`）が**バッチ全体の判定値**を持っている。

```ts
interface ValidationCommon {
  batch: boolean;
  statementCount: number;
  isReadOnlyBatch: boolean;      // ← これ
  containsDml: boolean;          // ← これ
  containsValidationOnly: boolean;
  tempTables: string[];          // ← 一時テーブル名も取れる
  canRunWithQueryTool: boolean;
  requiresMutationTool: boolean;
  statements: StatementValidation[];  // 文ごとの isDml / isReadOnly
  ...
}
```

一方 `BatchValidationResult` は `isDml?: undefined` としており（`:150-158`）、
**現在の `assertSavedQuerySafety` が受け取る `{ isDml, statementType }` は単文形**。
**バッチでは `containsDml` / `isReadOnlyBatch` を見る形へ広げる**必要がある。

---

## 5. 対応案

### 案 A（推奨）: ガードを外し、安全判定をバッチ全体へ広げる

1. `requireSingleStatement` の呼び出しを `saveQuery` / `runSavedQuery` から外す
2. `assertSavedQuerySafety` を**バッチ対応**にする
   - `readOnly: true` の保存クエリは **`containsDml === false`** を要求（1 文でも DML があれば拒否）
   - `readOnly: false` は **`containsDml === true`** を要求（現在の対称性を維持）
3. `runSavedQuery` は **`saved.readOnly` で `query()` / `mutate()` へ振り分ける既存の形を維持**
4. 返す結果は**最後に結果セットを返した文**（既存のバッチ挙動と揃える）

### 案 B: 読み取り専用の保存クエリだけバッチを許す

`readOnly: true` かつ `containsDml === false` のときだけバッチを受理し、
DML バッチの保存は引き続き拒否する。**より狭く、後から緩められる。**

**見立て**: **案 B から入るのが素直**。DML バッチの保存は
「保存された複数文の書き込みを名前一発で実行できる」ことになり、
**運用上の重みが読み取りとは別物**。実需が出てから広げればよい（緩和は純加法）。

---

## 6. 受入条件（案 B の場合）

| 入力 | 期待 |
|---|---|
| `CREATE TEMP TABLE #a AS SELECT ...; SELECT ... FROM #a`（`readOnly: true`） | **保存できる。実行して最終 SELECT の結果が返る** |
| `DECLARE @x = '2026-01-01'; SELECT ... WHERE 日付 >= @x`（`readOnly: true`） | 保存・実行できる |
| 同上で実行時に `@x` を上書き | **既存の `@var` 注入が効く**こと |
| **1 文でも DML を含むバッチ**（`readOnly: true`） | **拒否**（`containsDml` で判定） |
| DML バッチ（`readOnly: false`） | **案 B では拒否**（従来どおり単文 DML のみ） |
| 単文の保存クエリ | **従来と完全に同じ挙動**（回帰） |
| `ksql_run_saved_query` の `maxRecords` / `onLimit` / `profile` 上書き | バッチでも従来どおり効く |

**回帰（必須）**:

1. 既存の保存クエリ（単文）がすべて従来どおり動くこと
2. `assertProfileOverrideAllowed` / `readOnly` の振り分けが不変
3. **DML が読み取り経路へ漏れないこと**（`containsDml` の判定を単文・バッチ両方で固定）

---

## 7. 未確定

1. **保存クエリのカタログ（JSON）が複数文の SQL をそのまま保持できるか**（改行・`;` の扱い）
2. **一時テーブル名の衝突**。同名の保存クエリを並行実行したときのスコープ
   （バッチ内で閉じるはずだが要確認）
3. `ksql_list_queries` / `ksql_get_query` の表示（複数文をどう見せるか）
4. 案 B → 案 A へ広げる条件（DML バッチの実需）
