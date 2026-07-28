# 仕様: B89 `explainQuery` をバッチ対応にし、受理集合を `runBatch` と揃える

- 作成: 2026-07-29
- 対象課題: [B89](ksql_b89_library_explain_batch_issue.md)
- ステータス: 📋 **R1・実装待ち**
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
**複文の中に `EXPLAIN` を含む文があった場合の扱いを決めること**（§7）。

---

## 3. 振り分け

| 入力 | 経路 |
|---|---|
| **単文** | **従来どおり**（`execute("EXPLAIN ...")`）。**出力を変えない** |
| **複文** | [`buildBatchExplainPlans`](../../src/execute.ts#L9595) |

判定は**パース結果の文数**で行う（`;` の有無で判定しない。文字列リテラル中の `;` を誤検出する）。

`buildBatchExplainPlans` は **metadata API 以外の実行 API を呼ばない**（レコードを読まない）。

---

## 4. 戻り値＝案 A（Pro 回答で確定）

**公開型 `ExplainResult` を変えない。**`lines` に文番号付きで連結する。

### 4.1 単文は現状のまま

**既存利用者の `lines` を 1 文字も変えない。**文番号の接頭辞も付けない。

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

- **複文の中に `EXPLAIN` を含む文があった場合**をどうするか。
  **推奨＝拒否**（`EXPLAIN` の入れ子は意味が無く、`buildBatchExplainPlans` の想定外）。
  実装前に挙動を確認し、**仕様と違う場合は報告すること**
- **`;` の有無で単文・複文を判定しないこと**（文字列リテラル中の `;` を誤検出する）
- **単文経路の出力を変えないこと**（受入 2）。ここが変わると Pro 以外の利用者へ影響が出る
- **`buildBatchExplainPlans` の既定 `cacheContext` は `"batch-explain"` という固定文字列**である。
  ライブラリから呼ぶ際は**実行ごとの分離が効くこと**を確認すること
  （[B87](ksql_b87_metadata_cache_spec.md) で実行単位スコープ化済みだが、**引数の渡し方次第で
  プロファイル分離が壊れる**）
- **公開型を変えないこと**（受入 8）
