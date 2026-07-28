# 仕様: B89 `explainQuery` をバッチ対応にし、受理集合を `runBatch` と揃える

- 作成: 2026-07-29
- 対象課題: [B89](ksql_b89_library_explain_batch_issue.md)
- ステータス: 📋 **R4・実装待ち**（R1 §7・R2 §3・R3 受入 3b の誤りを codex が実装前に指摘。いずれも Claude 側）
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor（純加法）**＝従来拒否していたものを通す方向のみ。公開型の変更なし

---

## 1. 目的

**`explainQuery` が `runBatch` と同じ文を受け付けるようにする。**

Pro の設定画面は SQL 入力を 0.6 秒デバウンスで `explainQuery` に通し「✓ 構文 OK」を表示する。
**`runBatch` を採用した結果、バッチを書いた瞬間に検証が効かなくなった。**

**複文対応だけでは足りない**（§2）。

---

## 2. 受理集合を `runBatch` と揃える

### 2.1 現状

| API | ガード | 受け付ける文 |
|---|---|---|
| `runBatch` | `assertRunBatchStatement` | read-only 全般（`CREATE TEMP TABLE` / `SET` / `DECLARE` / `VALIDATE` / `SHOW APPS` / `DESCRIBE`）。`IMPORT` / `APPLY` / DML `VALIDATE ONLY` を拒否 |
| **`explainQuery`** | `isExplainableReadOnlyStatement` | **`SELECT` / `WITH` / `UNION` のみ** |

**バッチには `CREATE TEMP TABLE` と `SET` が入る**ため、複文を通しても中身で弾かれる。

### 2.2 変更

[`guardExplainQuerySql`](../../src/engine-library/statementGuard.ts#L114) を
**バッチ対応にし、判定を `assertRunBatchStatement` へ寄せる。**

**単文も同じ集合になる。**`explainQuery("VALIDATE APPn")` が通るようになるが、
**従来拒否していたものを通す方向のみ**なので既存利用者に影響しない。

> Pro からも「単文の `VALIDATE APPn` が通るのは嬉しい副産物」との回答（品質チェックの
> ペインを設定画面で検証できるようになる）。

### 2.3 `EXPLAIN` 前置きの扱い

現行は `EXPLAIN SELECT ...` を渡されたらそのまま使い、無ければ `EXPLAIN` を前置きする。
**この挙動は単文で維持する。**

**複文では `EXPLAIN` を前置きしない**（`buildBatchExplainPlans` が SQL をそのまま解析するため）。

### 2.4 複文の中の `EXPLAIN` は**受理する**（R2 で修正）

**R1 §7 では「拒否を推奨」と書いたが、これは誤りだった。**
`runBatch` の既存契約を確認せずに書いたもので、次の 3 点と矛盾する。

1. [`assertRunBatchStatement`](../../src/engine-library/statementGuard.ts#L84) は
   `const target = classified.type === "EXPLAIN" ? classified.query : classified;` で
   **`EXPLAIN` を展開して受理している**
2. [b68Step4Parity.test.ts](../../src/engine-library/__tests__/b68Step4Parity.test.ts#L104) が
   **`EXPLAIN SELECT 1 AS one` を `runBatch` の受理対象として固定**している
3. [`buildBatchExplainPlans`](../../src/execute.ts#L9800) は既に
   `if (stmt.type === "EXPLAIN") return buildPlanForBatchQuery(stmt.query, ...)` を持つ

**拒否すると受入 4（受理集合の一致）に違反する。**
`runBatch` 側も拒否すれば集合は揃うが、**既存の受理範囲を狭める破壊的変更**になり
「純加法」という本仕様の前提に反する。

→ **受理する。実装・テストとも追加の対応は不要**（既存の処理がそのまま働く）。

---

## 3. 振り分け（R3 で修正）

### 3.1 R2 の誤り

**R2 §3 は「単文なら従来経路」と書いたが、これは §2.2 と両立しない。**

[`parseExplain`](../../src/parser/parser.ts#L608) が `EXPLAIN` の後に許すのは
**`SELECT` / `WITH` / `INSERT` / `UPSERT` / `UPDATE` / `DELETE` / `REORDER` /
`VALIDATE` / `IMPORT` だけ**である。

したがって `runBatch` が受理する次の単文は、**`EXPLAIN` を前置きすると parse error になる。**

`SHOW APPS` / `DESCRIBE APPn` / `CREATE TEMP TABLE` / `DROP TEMP TABLE` /
`SET` / `DECLARE` / `ASSERT`

```
explainQuery("SHOW APPS")  →  EXPLAIN SHOW APPS  →  parse error
```

**文数だけで振り分けてはならない。文型も見る。**

### 3.2 振り分け規則

**`EXPLAIN` を展開した実質の対象**（`EXPLAIN X` なら `X`）で判定する。

| 条件 | 経路 |
|---|---|
| **文数 1 かつ 対象が `SELECT` / `WITH` / `UNION`** | **従来どおり**（`execute("EXPLAIN ...")`）。**出力を変えない** |
| **それ以外**（複文、または上記以外の単文） | [`buildBatchExplainPlans`](../../src/execute.ts#L9595) |

**従来経路は「今日すでに通っている形」だけに限定する。**
こうすることで**受入 2（既存出力の不変）が構造的に保証される**
（新しく受理される単文には、そもそも比較対象の旧出力が無い）。

**文数の判定はパース結果で行う**（`;` の有無で判定しない。文字列リテラル中の `;` を誤検出する）。

### 3.3 単文として無意味な文は**拒否したまま**にする（R4 で修正）

**R3 の受入 3b は `CREATE TEMP TABLE` / `DROP TEMP TABLE` / `SET` / `DECLARE` の
単文成功を要求していたが、これは誤りだった。**

[`analyzeBatch`](../../src/core/batch.ts#L228) はこれらの単文を**意図的に拒否**している。

```
ArgumentError: SET variable requires a batch.
ArgumentError: CREATE TEMP TABLE requires a batch (temp tables are batch-scoped).
```

**単文の `DROP TEMP TABLE #t` は、先行する `CREATE` が無いため未定義参照としても拒否される。**

`buildBatchExplainPlans` も同じ `analyzeBatch` を通るため、
**explain だけ通そうとすると `explainQuery` が `runBatch` の上位集合になり、受入 4 に違反する。**
「構文 OK と出たのに実行できない」という、本課題が直そうとしているものと同じ形になる。

→ **拒否したままにし、`runBatch` と同じエラーになることを受入 3c で固定する。**

> `ASSERT` の単文は `analyzeBatch` の拒否対象ではなく、**実機で成功を確認済み**
> （`ASSERT (SELECT COUNT(*) FROM APP4147) > 0` → `ok: true`）。

`buildBatchExplainPlans` は **metadata API 以外の実行 API を呼ばない**（レコードを読まない）。

---

## 4. 戻り値＝案 A（Pro 回答で確定）

**公開型 `ExplainResult` を変えない。**`lines` に文番号付きで連結する。

### 4.1 接頭辞は**文数が 2 以上のときだけ**付ける

**単文なら、どちらの経路を通っても接頭辞を付けない。**
（`SHOW APPS` のように新しく受理される単文も、`buildBatchExplainPlans` 経由だが接頭辞なし）

**従来経路を通る単文の `lines` / `text` は 1 文字も変えない。**

### 4.2 複文の形

```
[1] CREATE_TEMP_TABLE
<plan 行>
<plan 行>
[2] SET_VARIABLE
<plan 行>
[3] SELECT
<plan 行>
```

- 見出しは `[<1 始まりの文番号>] <文の型>`
- `text` は従来どおり `lines.join("\n")`

> **Pro は計画の中身を表示に使っていない**（「構文が通るか」「どこが悪いか」の 2 点だけ）。
> **表現に凝る必要はない**が、将来 表示に使われる可能性は残るので**文の区切りが読める形**にする。

### 4.3 エラー時

**B68 が `statementIndex` / `statementType` をエラーへ載せている。**追加の対応は不要。
Pro はこれで「3 文目の SELECT で…」と提示できると回答している。

---

## 5. 変数（`DECLARE`）は注入口を足さない

**`RunQueryOptions` に `variables` は無い**（`RunBatchOptions` にはある）。
**追加しない。**理由は次のとおり。

**`DECLARE` は既定値が必須**である。
[parser.ts:463](../../src/parser/parser.ts#L463) が `this.expect(TokenKind.EQ)` で `=` を要求し、
既定値のない `DECLARE` は構文エラーになる。

したがって**変数を注入しなくても必ず解決でき、「実行は通るのに explain は落ちる」は起きない。**

`buildBatchExplainPlans` の `injectedVariables` には **`undefined` を渡す**（既定値が使われる）。

> 注入値によって計画の内容（押し下げの形など）は変わり得るが、
> **Pro は計画を表示に使っていない**ため実害が無い。
> 必要になったら別途 追加する（公開型が変わるため、実需が出てからでよい）。

---

## 6. 受入条件

1. **Pro の実例が通る** — `CREATE TEMP TABLE #g AS …; SET @total = (SELECT …); SELECT …` が
   `explainQuery` で成功し、`lines` に 3 文ぶんの見出しが出ること
2. **単文の出力が変わらない** — 既存の単文 explain の `lines` / `text` が**完全に不変**であること
   （既存テストが落ちないことに加え、明示的に固定する）
3. **単文 `VALIDATE APPn` が通る** — 従来 `readOnlyViolation` だったものが成功すること
3b. **`EXPLAIN` を前置きできない単文も通る** — **`SHOW APPS` / `DESCRIBE APPn` / `ASSERT`** の
   **単文**が `explainQuery` で成功し、**接頭辞が付かない**こと（§3.1 の parse error が起きないこと）
3c. **単文として無意味な文は `runBatch` と同じように拒否される** — `SET` / `DECLARE` /
   `CREATE TEMP TABLE` / `DROP TEMP TABLE` の**単文**が、**`runBatch` と同じエラー**で
   拒否されること（§3.3）。**explain 側だけ緩めない**
4. **受理集合が `runBatch` と一致する** — **これが本仕様の中核**。
   **型レベルで網羅**し、`runBatch` が受ける文型は `explainQuery` も受け、
   `runBatch` が拒否する文型は `explainQuery` も拒否することを固定する。
   **B68 の [b68Step4Parity.test.ts](../../src/engine-library/__tests__/b68Step4Parity.test.ts)
   と同じ考え方**で、`Statement["type"]` の網羅を `satisfies` で強制し、
   **新しい文型が増えたら落ちる**ようにすること
5. **レコードを読まない** — バッチ explain で `getRecords` が **0 回**であることを固定する
   （`CREATE TEMP TABLE` を含むバッチでも実体化しない）
6. **拒否がバッチでも効く** — `IMPORT` / `APPLY` / DML を含むバッチが
   **`readOnlyViolation` で拒否**され、**API 呼び出しが 0 回**であること
7. **エラーに文番号が載る** — 複文の 2 文目が壊れている場合、
   エラーから**その文を特定できる**ことを固定する
8. **公開型が変わらない** — `engine:declaration-smoke` の B66 snapshot が
   **6 values / 26 types / 12 ReadonlyFieldInfo properties のまま**であること
9. **既存テスト全 green・snapshot 22 不変**

---

## 7. 注意点・決めること

- **複文の中の `EXPLAIN` は受理する**（§2.4・R2 で確定）。R1 の「拒否を推奨」は撤回した
- **`;` の有無で判定しないこと**（文字列リテラル中の `;` を誤検出する）
- **文数だけで振り分けないこと**（§3.1）。`EXPLAIN` を前置きできない単文がある
- **explain 側だけ緩めないこと**（§3.3）。`explainQuery` が `runBatch` の上位集合になると、
  「構文 OK と出たのに実行できない」という本課題と同じ形の不整合を作る
- **単文経路の出力を変えないこと**（受入 2）。ここが変わると Pro 以外の利用者へ影響が出る
- **`cacheContext` は確認済み＝問題なし**（R2）。
  `buildBatchExplainPlans` は内部で `createInvocationCacheContext` を通すため、
  **固定文字列 `"batch-explain"` を渡しても呼び出しごとに一意な suffix が付き、実行間で共有されない**
  （[B87](ksql_b87_metadata_cache_spec.md) の実行単位スコープが効いている）。
  プロファイル分離は**呼び出し側が渡す client** が担う
- **公開型を変えないこと**（受入 8）
